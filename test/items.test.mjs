import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAlerts } from '../src/alerts.js';
import { createKinds } from '../src/kinds.js';
import { createPhotos, MAX_PHOTO_BYTES, sniffImageMime, verifyPhotoSignature } from '../src/photos.js';
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

test('收纳：同一张图能被两个物件各自引用（第二个拿到副本，互不影响）', async () => {
  const { service, store, photos } = makeService();
  const first = await service.upsertItem({ name: '第一件', location: '书房' });
  const second = await service.upsertItem({ name: '第二件', location: '书房' });
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  await service.attachPhotos(first.data.record.id, [photo.id]);

  // 一张照片里有两个东西（桌上一个杯子 + 一瓶饮料）是常见情形：不能报错，也不能悄悄共享一条记录
  const shared = await service.upsertItem({
    id: second.data.record.id,
    name: '第二件',
    location: '书房',
    photoIds: [photo.id],
  });
  assert.equal(shared.ok, true);
  assert.equal(shared.data.record.photoCount, 1);
  const copyId = shared.data.record.photos[0].id;
  assert.notEqual(copyId, photo.id);

  // 原图仍归第一件；第二件拿的是自己的副本，删掉任一方都不影响另一方
  assert.equal(store.find('photos', photo.id).itemId, first.data.record.id);
  assert.equal(store.find('photos', copyId).itemId, second.data.record.id);
  assert.equal(store.list('photos').length, 2);
  assert.equal(service.findItems({ q: '第一件' }).data.items[0].photoCount, 1);
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

test('收纳：未来的「什么时候放的」被拒绝，说清怎么改', async () => {
  const { service } = makeService();
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const result = await service.upsertItem({ name: '备用钥匙', location: '玄关', placedAt: future });
  assert.equal(result.ok, false);
  assert.match(result.error, /将来时间/);
  // 今天/过去的时间照常
  const ok = await service.upsertItem({ name: '备用钥匙', location: '玄关', placedAt: '昨天 10:00' });
  assert.equal(ok.ok, true);
});

test('照片：缺 id 时说「缺少照片 id」，不要报 undefined', async () => {
  const { service } = makeService();
  const result = await service.removePhoto('');
  assert.equal(result.ok, false);
  assert.match(result.error, /缺少照片 id/);
});

/* ------------------------- 审查修复后的回归测试 ------------------------- */

test('照片：记录里的 file 被改成路径逃逸时，读/删都不碰目录外的文件', async () => {
  const { store, photos } = makeService();
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  const outside = join(store.filePath, '..', '..', 'escape.txt');
  store.patch('photos', photo.id, { file: '..\\..\\butler.json' });
  assert.equal(photos.read(photo.id), null);
  // 账本文件必须还在
  assert.equal(existsSync(store.filePath), true);
  assert.equal(existsSync(outside), false);
});

test('照片：content-type 只从扩展名推导，记录里的 mime 改不动响应头', () => {
  const { store, photos } = makeService();
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  store.patch('photos', photo.id, { mime: 'text/html' });
  const found = photos.read(photo.id);
  assert.equal(found.mime, 'image/png');
});

test('照片：对账会删掉没有记录的孤儿文件，并摘掉物品上的死链', () => {
  const { store, photos } = makeService();
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  const item = { id: 'item_g1', name: '钥匙', location: '玄关', detail: '', quantity: null, unit: '', category: '', note: '', tags: [], placedAt: null, photoIds: [photo.id, 'ph_ghost'], source: 'manual' };
  store.put('items', item);
  // 造一个没有记录的孤儿文件
  const orphan = join(photos.root, 'ph_orphan1.png');
  writeFileSync(orphan, PNG_BUFFER);
  store.remove('photos', photo.id);

  const result = photos.reconcile();
  assert.ok(result.orphans >= 1);
  assert.ok(result.unlinked >= 1);
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(store.find('items', 'item_g1').photoIds, []);
});

test('照片：配了 apiToken 时 URL 带签名，验签通过；签名被改就失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-sign-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const photos = createPhotos({ dir, store, secret: 'tok-123' });
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  const view = photos.view(photo);
  assert.match(view.url, /\?exp=\d+&sig=[\w-]+$/);
  const query = Object.fromEntries(new URL(view.url, 'http://x').searchParams.entries());
  assert.equal(verifyPhotoSignature(photo.id, query, 'tok-123'), true);
  assert.equal(verifyPhotoSignature(photo.id, { ...query, sig: query.sig.slice(0, -1) + 'A' }, 'tok-123'), false);
  assert.equal(verifyPhotoSignature(photo.id, { ...query, exp: '1' }, 'tok-123'), false);
});

test('收纳：搜索支持多词（「玄关 钥匙」也能命中）', async () => {
  const { service } = makeService();
  await service.upsertItem({ name: '钥匙', location: '玄关' });
  await service.upsertItem({ name: '充电器', location: '书房' });
  const hit = service.findItems({ q: '玄关 钥匙' });
  assert.equal(hit.data.total, 1);
  assert.equal(hit.data.items[0].name, '钥匙');
  assert.equal(service.findItems({ q: '玄关 充电器' }).data.total, 0);
});

test('收纳：改位置时传空 location 不会把原位置抹掉', async () => {
  const { service } = makeService();
  const created = await service.upsertItem({ name: '备用钥匙', location: '玄关', detail: '鞋柜' });
  const updated = await service.upsertItem({ id: created.data.record.id, name: '备用钥匙', location: '', detail: '抽屉' });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.record.location, '玄关');
  assert.equal(updated.data.record.placeLabel, '玄关 · 抽屉');
});

test('收纳：数量支持「1,000」，认不出的写法按未填处理', async () => {
  const { service } = makeService();
  const a = await service.upsertItem({ name: '螺丝', location: '工具箱', quantity: '1,000', unit: '个' });
  assert.equal(a.data.record.quantity, 1000);
  assert.equal(a.data.record.quantityLabel, '1000 个');
  const b = await service.upsertItem({ name: '电池', location: '抽屉', quantity: '两个' });
  assert.equal(b.data.record.quantity, null);
});

test('收纳：一件东西最多 12 张照片，超了明确失败而不是静默丢图', async () => {
  const { service, photos } = makeService();
  const created = await service.upsertItem({ name: '相册', location: '书架' });
  const id = created.data.record.id;
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' }).id);
  const first = await service.attachPhotos(id, ids);
  assert.equal(first.ok, true);
  assert.equal(first.data.record.photoCount, 12);
  const extra = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  const over = await service.attachPhotos(id, [extra.id]);
  assert.equal(over.ok, false);
  assert.match(over.error, /最多 12 张/);
  // 第 13 张没有被静默挂上
  assert.equal(service.findItems({ q: '相册' }).data.items[0].photoCount, 12);
});

test('收纳：photoIds 传成整个照片对象也能认（模型常整段回传）', async () => {
  const { service, photos } = makeService();
  const created = await service.upsertItem({ name: '路由器', location: '电视柜' });
  const photo = photos.saveBuffer({ data: PNG_BUFFER, mime: 'image/png' });
  const updated = await service.upsertItem({ id: created.data.record.id, name: '路由器', photoIds: [{ id: photo.id, url: '/x' }] });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.record.photoCount, 1);
  assert.equal(updated.data.record.photos[0].id, photo.id);
});

test('照片：QQ 机器人给的本地图片路径也能存下来，并按同一路径去重', () => {
  const { dir, photos, store } = makeService();
  const file = join(dir, 'qq-upload.png');
  writeFileSync(file, PNG_BUFFER);

  const first = photos.saveFile(file);
  assert.equal(first.refId, `file:${file}`);
  assert.equal(first.mime, 'image/png');
  assert.equal(existsSync(join(photos.root, first.file)), true);

  // 用户重说一遍、模型重复调用：同一张图只留一份，不重复占磁盘
  const second = photos.saveFile(file);
  assert.equal(second.id, first.id);
  assert.equal(store.list('photos').length, 1);

  // 不同路径但内容相同的图仍算两张（路径才是身份，别把用户两张相似的图合并）
  const other = join(dir, 'qq-upload-2.png');
  writeFileSync(other, PNG_BUFFER);
  assert.notEqual(photos.saveFile(other).id, first.id);
  assert.equal(store.list('photos').length, 2);
});

test('照片：路径不存在、不是图片、超大文件都要明确失败', () => {
  const { dir, photos } = makeService();
  assert.throws(() => photos.saveFile(join(dir, 'nope.jpg')), /文件不存在/);

  const text = join(dir, 'note.jpg');
  writeFileSync(text, 'not an image at all');
  assert.throws(() => photos.saveFile(text), /不是能识别的图片/);

  const huge = join(dir, 'huge.png');
  writeFileSync(huge, Buffer.alloc(MAX_PHOTO_BYTES + 1, 1));
  assert.throws(() => photos.saveFile(huge), /太大/);
});

test('照片：远程图片链接会先下载再按字节校验，并按链接去重', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-url-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  let hits = 0;
  const photos = createPhotos({
    dir,
    store,
    fetchImpl: async () => {
      hits += 1;
      return new Response(PNG_BUFFER, { status: 200, headers: { 'content-type': 'image/webp', 'content-length': String(PNG_BUFFER.length) } });
    },
  });
  const url = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=abc&spec=0';
  const first = await photos.saveUrl(url);
  assert.equal(first.mime, 'image/png'); // 声明是 webp，实际按字节认成 png
  assert.equal(first.byteSize, PNG_BUFFER.length);
  assert.equal(first.refId, `url:${url}`);
  const again = await photos.saveUrl(url);
  assert.equal(again.id, first.id);
  assert.equal(hits, 1); // 重复保存不再下载第二遍
});

test('照片：远程链接的异常都明确失败（协议 / 状态码 / 非图片 / 超大 / 跳转）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-url-bad-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const make = (impl) => createPhotos({ dir, store, fetchImpl: impl });

  await assert.rejects(() => make(async () => new Response('')).saveUrl('file:///etc/passwd'), /http\/https/);

  await assert.rejects(
    () => make(async () => new Response('nope', { status: 404 })).saveUrl('https://x.test/a.jpg'),
    /HTTP 404/,
  );

  await assert.rejects(
    () => make(async () => new Response('not an image')).saveUrl('https://x.test/b.jpg'),
    /不是能识别的图片/,
  );

  await assert.rejects(
    () => make(async () => new Response(PNG_BUFFER, { headers: { 'content-length': String(MAX_PHOTO_BYTES + 1) } })).saveUrl('https://x.test/c.png'),
    /太大/,
  );

  await assert.rejects(
    () => make(async () => new Response('', { status: 302, headers: { location: 'ftp://x.test/a.jpg' } })).saveUrl('https://x.test/d.jpg'),
    /不支持的协议/,
  );
});
