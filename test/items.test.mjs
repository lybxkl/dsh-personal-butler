import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAlerts } from '../src/alerts.js';
import { createKinds } from '../src/kinds.js';
import { createPhotos, MAX_PHOTO_BYTES, sniffImageMime } from '../src/photos.js';
import { createService } from '../src/service.js';
import { Store } from '../src/store.js';

/** 1×1 的真 PNG（用来验证按字节嗅探，而不是信任声明）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-item-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { currency: 'CNY', pollSeconds: 0, advanceMinutes: 30, maxSnapshots: 10, reminderTarget: 'new_once' };
  const kinds = createKinds(store);
  kinds.ensureSeeded();

  const credentials = { backend: () => 'memory', getError: () => null, get: () => undefined, has: () => false, set: () => true };
  const reminders = {
    available: () => true,
    isSyncing: () => false,
    lastError: () => ({ at: null, message: null }),
    async syncItem() { return { status: 'created' }; },
    async removeAllFor() {},
    async syncAll() { return { status: 'ok', created: 0, unchanged: 0, skipped: 0, past: 0, error: 0 }; },
  };
  const quota = {
    state: () => ({ busy: false, lastTick: null, lastError: null, skipped: 0 }),
    isBusy: () => false,
    sources: () => [],
    resolveSource: (id) => ({ id: id || 'generic', credentialHint: '提示', needsCredential: true }),
    async tick() { return { status: 'ok', results: [] }; },
  };

  const alerts = createAlerts({ store, config });
  const photos = createPhotos({ dir, store });
  const service = createService({ store, config, kinds, credentials, quota, reminders, alerts, photos });
  return { dir, store, service, photos };
}

test('收纳：缺名称或缺位置都明确拒绝', async () => {
  const { service } = makeService();
  const noName = await service.upsertItem({ location: '书房' });
  assert.equal(noName.ok, false);
  assert.match(noName.error, /名字/);

  const noPlace = await service.upsertItem({ name: '充电器' });
  assert.equal(noPlace.ok, false);
  assert.match(noPlace.error, /位置/);
});

test('收纳：保存后带位置描述、数量文案与时间', async () => {
  const { service } = makeService();
  const saved = await service.upsertItem({
    name: '备用钥匙',
    location: '玄关',
    detail: '鞋柜第 2 层的小铁盒',
    quantity: 2,
    unit: '把',
    placedAt: '昨天',
    note: '小区门禁和信箱各一把',
    tags: '钥匙 门禁',
  });
  assert.equal(saved.ok, true);
  const item = saved.data.record;
  assert.equal(item.placeLabel, '玄关 · 鞋柜第 2 层的小铁盒');
  assert.equal(item.quantityLabel, '2 把');
  assert.ok(item.placedAt, 'placedAt 应该被解析成具体时间');
  assert.deepEqual(item.tags, ['钥匙', '门禁']);
});

test('收纳：换了位置是更新原记录，不新增', async () => {
  const { service, store } = makeService();
  const first = await service.upsertItem({ name: '充电宝', location: '客厅' });
  const again = await service.upsertItem({ id: first.data.record.id, name: '充电宝', location: '书房', detail: '抽屉' });
  assert.equal(again.ok, true);
  assert.equal(again.data.record.id, first.data.record.id);
  assert.equal(again.data.record.location, '书房');
  assert.equal(store.list('items').length, 1);
});

test('收纳：照片落盘、能挂到物品上、删物品时连照片一起删', async () => {
  const { service, store, photos, dir } = makeService();
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  const saved = await service.upsertItem({ name: '圣诞装饰', location: '阳台储物柜', photoIds: [photo.id] });
  assert.equal(saved.ok, true);
  const item = saved.data.record;

  assert.equal(item.photoCount, 1);
  assert.match(item.photos[0].url, /^\/butler\/api\/photo\/ph_/);
  assert.equal(store.find('photos', photo.id).itemId, item.id);
  assert.ok(existsSync(join(dir, 'photos', store.find('photos', photo.id).file)));

  const read = photos.read(photo.id);
  assert.equal(read.mime, 'image/png');
  assert.equal(read.buffer.length, PNG_BUFFER.length);

  const removed = await service.removeItem(item.id);
  assert.equal(removed.ok, true);
  assert.equal(store.find('photos', photo.id), null);
  assert.equal(photos.read(photo.id), null);
});

test('收纳：查东西能搜名称/位置/备注，名称命中排前面', async () => {
  const { service } = makeService();
  await service.upsertItem({ name: '维生素 C', location: '厨房', note: '饭后吃，一天一片' });
  await service.upsertItem({ name: '创可贴', location: '浴室柜', note: '和碘伏放一起；维生素那盒在旁边' });

  const byName = service.findItems({ q: '维生素' });
  assert.equal(byName.ok, true);
  assert.equal(byName.data.items[0].name, '维生素 C');

  const byNote = service.findItems({ q: '碘伏' });
  assert.equal(byNote.data.total, 1);
  assert.equal(byNote.data.items[0].name, '创可贴');

  const byPlace = service.findItems({ location: '浴室' });
  assert.equal(byPlace.data.total, 1);

  const missing = service.findItems({ q: '电钻' });
  assert.equal(missing.data.total, 0);
});

test('收纳：已属于别的物品的照片不能挪过来', async () => {
  const { service, store, photos } = makeService();
  const first = await service.upsertItem({ name: '第一件', location: '书房' });
  const second = await service.upsertItem({ name: '第二件', location: '书房' });
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  await service.attachPhotos(first.data.record.id, [photo.id]);

  const stolen = await service.upsertItem({
    id: second.data.record.id,
    name: '第二件',
    location: '书房',
    photoIds: [photo.id],
  });
  assert.equal(stolen.ok, true);
  assert.equal(stolen.data.record.photoCount, 0);
  assert.equal(store.find('photos', photo.id).itemId, first.data.record.id);
});

test('照片：只认真正的图片字节，dataURL 与大小都有边界', () => {
  const { photos } = makeService();
  // 声明成 png、实际不是图片 → 拒绝
  assert.throws(() => photos.saveBuffer({ data: Buffer.from('not an image at all'), mime: 'image/png' }), /不是能识别的图片/);
  assert.throws(() => photos.saveBuffer({ data: Buffer.alloc(0), mime: 'image/png' }), /空的/);
  assert.throws(() => photos.saveDataUrl('data:text/plain;base64,aGVsbG8='), /格式不对/);

  const fromDataUrl = photos.saveDataUrl(`data:image/png;base64,${PNG_BASE64}`);
  assert.equal(fromDataUrl.mime, 'image/png');
  assert.ok(fromDataUrl.byteSize > 0);

  assert.equal(sniffImageMime(PNG_BUFFER), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.alloc(20)), '');
});

test('照片：超过 8MB 被拒绝', () => {
  const { photos } = makeService();
  const big = Buffer.concat([PNG_BUFFER, Buffer.alloc(MAX_PHOTO_BYTES)]);
  assert.throws(() => photos.saveBuffer({ data: big, mime: 'image/png' }), /图片太大了/);
});

test('收纳：删照片只允许删没挂上的，挂着的会被拒绝', async () => {
  const { service, photos } = makeService();
  const photo = photos.saveDataUrl('data:image/png;base64,' + PNG_BASE64);
  const item = await service.upsertItem({ name: '备用钥匙', location: '玄关', photoIds: [photo.id] });
  assert.equal(item.ok, true);
  assert.equal(item.data.record.photoCount, 1);

  // 挂在物件上的照片不许直接删，否则记录上会留死链
  const blocked = await service.removePhoto(photo.id);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /还挂在/);

  // 没挂上的照片可以删，删完文件也不在了
  const other = photos.saveDataUrl('data:image/png;base64,' + PNG_BASE64);
  const dropped = await service.removePhoto(other.id);
  assert.equal(dropped.ok, true);
  assert.equal(photos.find(other.id), null);
  assert.ok(photos.find(photo.id));
});

test('照片对账：文件被删掉的记录清掉，归属物件不在的解除挂接', async () => {
  const { service, photos, store } = makeService();
  const alive = photos.saveDataUrl('data:image/png;base64,' + PNG_BASE64);
  const gone = photos.saveDataUrl('data:image/png;base64,' + PNG_BASE64);
  // 手动删掉其中一张的文件，模拟用户清理目录
  const { rmSync } = await import('node:fs');
  rmSync(join(photos.root, gone.file || gone.id + '.png'), { force: true });
  store.patch('photos', alive.id, { itemId: 'item_not_exist' });

  const report = photos.reconcile();
  assert.equal(report.dropped, 1);
  assert.equal(report.detached, 1);
  assert.equal(photos.find(gone.id), null);
  assert.equal(photos.find(alive.id).itemId, null);
  assert.equal(service.query('items', {}).ok, true);
});

test('照片：从物件上摘掉后就能删（不再被当成「还挂在物件上」）', async () => {
  const { service, photos } = makeService();
  const photo = photos.saveDataUrl('data:image/png;base64,' + PNG_BASE64);
  const created = await service.upsertItem({ name: '备用钥匙', location: '玄关', photoIds: [photo.id] });
  assert.equal(created.ok, true);
  const itemId = created.data.record.id;

  const detached = await service.upsertItem({ id: itemId, name: '备用钥匙', location: '玄关', photoIds: [] });
  assert.equal(detached.ok, true);
  assert.equal(detached.data.record.photoCount, 0);
  assert.equal(photos.find(photo.id).itemId, null);

  const dropped = await service.removePhoto(photo.id);
  assert.equal(dropped.ok, true);
  assert.equal(photos.find(photo.id), null);
});
