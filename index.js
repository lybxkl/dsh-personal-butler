/**
 * @local/butler —— 桌面私人管家（Host 半片）
 *
 * 职责：
 *   1. 把用户丢进来的截图/文字变成结构化记录（资产、额度、待办、借贷）——靠系统提示剧本 + butler_* 工具；
 *   2. 把到期/额度/逾期做成提醒——靠宿主的 schedule 服务；
 *   3. 把记录暴露成一个面板——靠同源 HTTP 路由给 client.js；
 *   4. 按 pollSeconds 串行查询第三方额度，绝不并发。
 *
 * 设计文档：docs/butler-plugin-design.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, normalizeConfig } from './src/defaults.js';
import { Store } from './src/store.js';
import { createKinds } from './src/kinds.js';
import { createCredentials } from './src/credentials.js';
import { createQuotaEngine } from './src/quota.js';
import { createReminders } from './src/reminders.js';
import { createAlerts } from './src/alerts.js';
import { createPhotos } from './src/photos.js';
import { createService } from './src/service.js';
import { registerTools } from './src/tools.js';
import { registerRoutes } from './src/routes.js';
import { registerPrompt } from './src/prompt.js';
import { deepMerge } from './src/util.js';

export const name = 'butler';

/** tools 与 webServer 是硬依赖；schedule / systemPrompt / credentials / timer 都是可选，缺了就降级。 */
export const inject = ['tools', 'webServer'];

const ROUTE_BASE = '/butler';
const INITIAL_QUOTA_DELAY_MS = 4000;

/** 这个目录里的 butler.json 是否已经有真实记录（用来判断「用户的数据在这儿」）。 */
function hasButlerData(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return ['assets', 'plans', 'todos', 'debts', 'items', 'photos', 'sources', 'alerts']
      .reduce((total, key) => total + Object.keys(raw?.[key] || {}).length, 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 数据目录。宿主重启后环境变量可能变（例如这次 DSH_HOME 有了、DSH_PROFILE_DIR 没了），
 * 按顺序取第一个会换目录、让用户以为数据丢了。所以：**优先选已经有数据的那个目录**，
 * 都没有数据时才按 DSH_PROFILE_DIR → profiles/<profile> → DSH_HOME → ~/.dsh 的顺序。
 */
function resolveDataDir(config, logger) {
  if (config.dataDir) return path.resolve(String(config.dataDir));
  const homes = [];
  const push = (base) => {
    if (!base) return;
    try {
      const resolved = path.resolve(String(base));
      if (!homes.includes(resolved)) homes.push(resolved);
    } catch {
      /* 忽略非法路径 */
    }
  };
  push(process.env.DSH_PROFILE_DIR);
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) push(path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE));
  push(process.env.DSH_HOME);
  push(path.join(os.homedir(), '.dsh'));
  // 宿主的 profile 目录都扫一遍：数据常常落在 profiles/<name>/butler 下
  for (const home of [...homes]) {
    try {
      for (const name of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
        if (name.isDirectory()) push(path.join(home, 'profiles', name.name));
      }
    } catch {
      /* 没有 profiles 目录就算了 */
    }
  }
  const dirs = homes.map((base) => path.join(base, 'butler'));
  const existing = dirs.find((dir) => hasButlerData(path.join(dir, 'butler.json')));
  if (existing) {
    if (dirs[0] && existing !== dirs[0]) {
      logger?.info?.(`[butler] 数据目录按已有数据选定：${existing}（当前环境首选是 ${dirs[0]}）`);
    }
    return existing;
  }
  return dirs[0] || path.resolve(process.cwd(), '.butler');
}

export function apply(ctx, rawConfig = {}) {
  // Cordis 里直接 ctx.xxx 访问未 inject 的服务会抛错；统一走 ctx.get（不追踪依赖，缺服务返回 undefined）
  const safeGet = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };
  const logger = safeGet('logger');
  const config = normalizeConfig({ ...DEFAULT_CONFIG, ...(rawConfig || {}) });
  const dir = resolveDataDir(config, logger);

  /* ------------------------------ 组件装配 ------------------------------ */

  const store = new Store({ filePath: path.join(dir, 'butler.json'), logger }).load();

  // 面板里改过的设置存在 butler.json 的 meta.settings，优先级高于 cordis.patch.yml（用户现场改的最准）
  const overrides = store.getMeta('settings', {}) || {};
  if (Object.keys(overrides).length) {
    const merged = normalizeConfig(deepMerge({ ...config }, overrides));
    for (const key of Object.keys(merged)) config[key] = merged[key];
  }

  const kinds = createKinds(store);
  kinds.ensureSeeded();

  const credentials = createCredentials({ ctx, dir, logger });

  let service = null;
  const notify = (reason) => {
    try {
      service?.notifyChanged(reason);
    } catch (error) {
      logger?.warn?.(`[butler] 变更通知失败：${error?.message || error}`);
    }
  };

  const getSchedule = () => safeGet('schedule');

  const quota = createQuotaEngine({
    store,
    config,
    credentials,
    logger,
    onChange: () => notify('quota'),
  });

  const reminders = createReminders({
    store,
    config,
    logger,
    getSchedule,
    onChange: () => notify('reminders'),
  });

  const alerts = createAlerts({ store, config, logger });

  // 物品照片：会话附件会随会话清理，所以复制到 <dataDir>/photos 自己保管
  // secret 用于给图片 URL 签名：<img src> 带不了 x-butler-token 请求头，配了 apiToken 时只能靠签名放行
  const photos = createPhotos({ dir, store, logger, secret: config.apiToken || '' });
  // 对账：文件被删掉的照片记录清掉；归属物件已不在的解除挂接（避免面板显示永远加载不出的图）
  try {
    photos.reconcile();
  } catch (error) {
    logger?.warn?.(`[butler] 照片对账失败：${error?.message || error}`);
  }

  let rearmPoll = () => {};

  service = createService({
    store,
    config,
    kinds,
    credentials,
    quota,
    reminders,
    alerts,
    photos,
    hooks: {
      onDataChanged: (reason) => {
        try {
          alerts.recompute();
        } catch (error) {
          logger?.warn?.(`[butler] 重算提醒失败：${error?.message || error}`);
        }
        void reason;
      },
      onPollIntervalChanged: () => rearmPoll(),
    },
  });

  /* ------------------------------ 面板 HTTP ------------------------------ */

  const disposeRoutes = registerRoutes(ctx, service, { config, logger, basePath: ROUTE_BASE, photos });

  /* ------------------------------ 模型工具 ------------------------------ */

  const disposeTools = registerTools(ctx, service, { logger, photos });

  /* ------------------------------ 意图剧本 ------------------------------ */

  const disposePrompt = registerPrompt(ctx, { logger });

  /* ------------------------------ 额度轮询 ------------------------------ */

  const timers = [];
  const armPoll = () => {
    for (const dispose of timers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
    const seconds = Number(config.pollSeconds) || 0;
    if (seconds <= 0) return; // 0 = 关闭自动轮询，只保留面板手动刷新
    const run = () => {
      void quota.tick({}).catch((error) => {
        logger?.warn?.(`[butler] 额度轮询失败：${error?.message || error}`);
      });
    };
    const timer = safeGet('timer');
    if (timer?.interval) {
      timers.push(timer.interval(run, seconds * 1000));
    } else {
      const handle = setInterval(run, seconds * 1000);
      if (typeof handle.unref === 'function') handle.unref();
      timers.push(() => clearInterval(handle));
    }
  };
  rearmPoll = armPoll;
  armPoll();

  /* ------------------------------ 启动任务 ------------------------------ */

  // 早期版本把凭证写在宿主的 credentials 服务里，读取接口是 async，
  // 所以只能在启动时异步搬迁一次（之后所有读取都走本地文件）。
  void (async () => {
    try {
      const refs = store.list('plans').map((plan) => plan.credentialRef).filter(Boolean);
      const moved = await credentials.migrate(refs);
      if (!moved) return;
      for (const plan of store.list('plans')) {
        if (!plan.credentialRef) continue;
        if (!credentials.has(plan.credentialRef)) continue;
        if (plan.hasCredential) continue;
        store.patch('plans', plan.id, { hasCredential: true, status: 'unknown', error: null });
      }
    } catch (error) {
      logger?.warn?.(`[butler] 搬迁宿主凭证失败：${error?.message || error}`);
    }
  })();

  const startupTimers = [];
  if (config.syncOnStart) {
    const kick = setTimeout(() => {
      void reminders.syncAll({}).catch((error) => {
        logger?.warn?.(`[butler] 启动时对齐提醒失败：${error?.message || error}`);
      });
      alerts.recompute();
    }, 1500);
    if (typeof kick.unref === 'function') kick.unref();
    startupTimers.push(kick);
  }

  if (Number(config.pollSeconds) > 0 && store.list('plans').length) {
    const kick = setTimeout(() => {
      void quota.tick({}).catch((error) => {
        logger?.warn?.(`[butler] 首次额度查询失败：${error?.message || error}`);
      });
    }, INITIAL_QUOTA_DELAY_MS);
    if (typeof kick.unref === 'function') kick.unref();
    startupTimers.push(kick);
  }

  if (store.loadError) {
    logger?.warn?.(`[butler] 数据文件有问题已重建：${store.loadError}`);
  }

  ctx.effect(() => () => {
    for (const dispose of timers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
    for (const timer of startupTimers.splice(0)) {
      try {
        clearTimeout(timer);
      } catch {
        /* ignore */
      }
    }
    try {
      disposePrompt?.();
    } catch {
      /* ignore */
    }
    try {
      disposeTools?.();
    } catch {
      /* ignore */
    }
    try {
      disposeRoutes?.();
    } catch {
      /* ignore */
    }
    try {
      store.flush?.();
    } catch {
      /* ignore */
    }
  }, 'butler: lifecycle');

  logger?.info?.(`[butler] 已启动，数据目录 ${dir}，额度轮询 ${config.pollSeconds > 0 ? `${config.pollSeconds}s（串行）` : '已关闭'}`);
}
