import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCredentials } from '../src/credentials.js';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'butler-cred-'));
}

test('凭证：写入后能读回，has 与清除都正确', () => {
  const dir = makeDir();
  const credentials = createCredentials({ dir });
  assert.equal(credentials.has('butler.quota.p1'), false);
  assert.equal(credentials.set('butler.quota.p1', 'sk-real-key-123456'), true);
  assert.equal(credentials.get('butler.quota.p1'), 'sk-real-key-123456');
  assert.equal(credentials.has('butler.quota.p1'), true);

  const raw = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'));
  assert.deepEqual(raw, { 'butler.quota.p1': 'sk-real-key-123456' });

  assert.equal(credentials.set('butler.quota.p1', ''), true);
  assert.equal(credentials.has('butler.quota.p1'), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')), {});
});

test('凭证：落盘是原子替换，不会留下临时文件或半截 JSON', () => {
  const dir = makeDir();
  const credentials = createCredentials({ dir });
  for (let i = 0; i < 5; i += 1) credentials.set(`butler.quota.p${i}`, `key-${i}`);
  const parsed = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'));
  assert.equal(Object.keys(parsed).length, 5);
  assert.equal(existsSync(join(dir, 'credentials.json.tmp-' + process.pid)), false);
  // 权限位（Windows 上 chmod 基本无效，只在 POSIX 断言）
  if (process.platform !== 'win32') {
    const mode = statSync(join(dir, 'credentials.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('凭证：文件损坏时备份重建，不静默丢数据', () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'credentials.json'), '{ 这不是 JSON', 'utf8');
  const credentials = createCredentials({ dir });
  assert.equal(credentials.get('butler.quota.p1'), undefined);
  assert.match(String(credentials.getError() || ''), /损坏/);
  assert.equal(existsSync(join(dir, 'credentials.json')), false, '损坏文件应该被搬走，而不是留着继续读失败');
  // 备份确实存在，用户还能自己去捞
  const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
});

test('凭证：旧版本留下的 marker 对象不会被当成密钥', () => {
  const dir = makeDir();
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ 'butler.quota.old': { storedIn: 'credentials' } }),
    'utf8',
  );
  const credentials = createCredentials({ dir });
  assert.equal(credentials.get('butler.quota.old'), undefined);
  assert.equal(credentials.has('butler.quota.old'), false);
  // 写入新值会顺手把 marker 挤掉
  credentials.set('butler.quota.old', 'sk-new');
  assert.equal(credentials.get('butler.quota.old'), 'sk-new');
});

test('凭证：宿主服务里残留的旧值会被搬迁到文件（异步一次）', async () => {
  const dir = makeDir();
  const records = { 'butler.quota.legacy': { value: 'sk-legacy-777777' } };
  const ctx = {
    get(name) {
      if (name !== 'credentials') return null;
      return {
        async readRecord(key) {
          return records[key];
        },
      };
    },
  };
  const credentials = createCredentials({ ctx, dir });
  assert.equal(credentials.backend(), 'file');
  assert.equal(credentials.get('butler.quota.legacy'), undefined);

  const moved = await credentials.migrate(['butler.quota.legacy', 'butler.quota.missing']);
  assert.equal(moved, 1);
  assert.equal(credentials.get('butler.quota.legacy'), 'sk-legacy-777777');

  // 已存在的不再重复搬；第二次调用直接返回 0
  assert.equal(credentials.set('butler.quota.legacy', 'sk-kept'), true);
  assert.equal(await credentials.migrate(['butler.quota.legacy']), 0);
  assert.equal(credentials.get('butler.quota.legacy'), 'sk-kept');
});