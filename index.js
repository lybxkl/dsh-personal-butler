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

function resolveDataDir(config, logger) {
  if (config.dataDir) return path.resolve(String(config.dataDir));
  const candidates = [process.env.DSH_HOME, process.env.DSH_PROFILE_DIR, path.join(os.homedir(), '.dsh')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return path.join(path.resolve(candidate), 'butler');
    } catch {
      /* 下一个 */
    }
  }
  logger?.warn?.('[butler] 无法确定 DSH_HOME，数据放在当前目录的 .butler 下');
  return path.resolve(process.cwd(), '.butler');
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
  const photos = createPhotos({ dir, store, logger });
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
