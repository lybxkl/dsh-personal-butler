/**
 * 记录种类注册表（扩展层级 L3）。
 *
 * 内置四种：subscription / token_plan / todo / debt。
 * 使用者可以注册新种类（面板新增表单、工具入参的 kind 校验都走这里），
 * 这样「自定义资产类型」不需要改插件代码——这是 L3 的落地点。
 */

import { normalizeKind } from './store.js';
import { safeText } from './util.js';

export const DEFAULT_KINDS = [
  {
    id: 'subscription',
    label: '订阅',
    hint: '有到期时间与金额的付费软件或服务',
    collection: 'assets',
    builtin: true,
  },
  {
    id: 'token_plan',
    label: 'Token 套餐',
    hint: '按 5 小时 / 周 / 月限额计费的 AI 套餐',
    collection: 'assets',
    builtin: true,
  },
  {
    id: 'todo',
    label: '待办',
    hint: '需要我做的事，或等待对方回应的事',
    collection: 'todos',
    builtin: true,
  },
  {
    id: 'debt',
    label: '借贷',
    hint: '我借出或我借入的钱',
    collection: 'debts',
    builtin: true,
  },
  {
    id: 'other',
    label: '其它资产',
    hint: '自定义资产类型（可用 butler_kind_register 扩展）',
    collection: 'assets',
    builtin: true,
  },
];

export function createKinds(store) {
  let seeded = false;

  function ensureSeeded() {
    if (seeded) return;
    seeded = true;
    const existing = new Set(store.list('kinds').map((k) => k.id));
    const missing = DEFAULT_KINDS.filter((k) => !existing.has(k.id));
    if (!missing.length) return;
    for (const kind of missing) {
      store.put('kinds', normalizeKind({ ...kind, createdAt: undefined }));
    }
  }

  return {
    ensureSeeded,
    list() {
      ensureSeeded();
      return store.list('kinds');
    },
    get(id) {
      ensureSeeded();
      return store.list('kinds').find((k) => k.id === id) || null;
    },
    has(id) {
      return Boolean(this.get(id));
    },
    /** 注册（或覆盖）一个种类。只接受安全字符，避免把 id 当路径/key 用。 */
    register(raw) {
      ensureSeeded();
      const id = safeText(raw?.id, 40).toLowerCase();
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)) {
        throw new Error('kind id 必须是 2-40 位小写字母/数字/下划线/连字符，且以字母开头');
      }
      const rec = normalizeKind({
        id,
        label: safeText(raw?.label || id, 40),
        hint: safeText(raw?.hint, 200),
        collection: raw?.collection,
        builtin: false,
      });
      const existing = store.find('kinds', id);
      if (existing) {
        return store.patch('kinds', id, { label: rec.label, hint: rec.hint, collection: rec.collection });
      }
      return store.put('kinds', rec);
    },
    /** 面板下拉用的轻量清单。 */
    view() {
      return this.list().map((k) => ({ id: k.id, label: k.label, hint: k.hint, collection: k.collection, builtin: k.builtin }));
    },
  };
}

/** collection → 该合集允许的 kind 清单 */
export function kindsForCollection(kinds, collection) {
  return kinds.list().filter((k) => k.collection === collection);
}