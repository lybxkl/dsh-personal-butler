import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECENT_LIMIT,
  lastUserMessagePaths,
  lastUserMessageRefs,
  takeImagePaths,
  takeImageRefs,
  takeImageUrls,
  userImageMentioned,
  userImagePaths,
  userImageUrls,
  userImageRefs,
} from '../src/image-refs.js';

const img = (id) => ({ type: 'image', attachment: { mediaType: 'image/png', id } });
const txt = (text) => ({ type: 'text', text });

test('图片引用：先发图、再回一句确认时，仍然找得到那张图', () => {
  const exec = {
    agent: {
      session: {
        deriveMessages: () => [
          { role: 'user', content: [txt('这是我家的柜子'), img('shot-1')] },
          { role: 'assistant', content: [txt('柜子在哪？')] },
          { role: 'user', content: [txt('阳台，记一下')] },
        ],
      },
    },
  };
  // 往回看几条用户消息，取最近一条带图的消息
  assert.deepEqual(lastUserMessageRefs(exec).map((r) => r.id), ['shot-1']);
  assert.deepEqual(userImageRefs(exec).map((r) => r.id), ['shot-1']);
});

test('图片引用：往回看有上限，太旧的截图不会被翻出来', () => {
  const messages = [{ role: 'user', content: [img('ancient')] }];
  for (let i = 0; i < RECENT_LIMIT; i += 1) messages.push({ role: 'user', content: [txt(`闲聊 ${i}`)] });
  const exec = { agent: { session: { deriveMessages: () => messages } } };
  assert.deepEqual(lastUserMessageRefs(exec), []);
});

test('图片引用：本轮投递的图优先，且能穿过 tool-result 嵌套', () => {
  const exec = {
    agent: {
      inbox: { nextTurn: [{ content: [img('new-1'), { type: 'tool-result', content: [img('nested')] }] }], nextStep: [] },
      session: { deriveMessages: () => [{ role: 'user', content: [img('old')] }] },
    },
  };
  const refs = userImageRefs(exec);
  assert.deepEqual(refs.map((r) => r.id), ['new-1', 'nested']);
});

test('图片路径：认 QQ 机器人那种「- Image: <本地路径>」的正文', () => {
  const content = [txt('- Image: C:/Users/x/.dsh-qqbot/media/F6A3194_1794329714038_d8dae029.jpg\n\n[图片]')];
  assert.deepEqual(takeImagePaths(content), ['C:/Users/x/.dsh-qqbot/media/F6A3194_1794329714038_d8dae029.jpg']);
  // 只有图片扩展名才收：正文里顺带提到的 .json / .txt 不能当图片读
  assert.deepEqual(takeImagePaths([txt('- Image: C:/tmp/report.json')]), []);
  assert.deepEqual(takeImagePaths([txt('随便一句话')]), []);
});

test('图片路径：同样支持「先发图、再确认」，且本轮优先', () => {
  const p = 'C:/tmp/a.png';
  const lookback = {
    agent: {
      session: {
        deriveMessages: () => [
          { role: 'user', content: [txt(`- Image: ${p}`)] },
          { role: 'user', content: [txt('放书房了')] },
        ],
      },
    },
  };
  assert.deepEqual(lastUserMessagePaths(lookback), [p]);
  assert.deepEqual(userImagePaths(lookback), [p]);

  const inbox = {
    agent: {
      inbox: { nextTurn: [{ content: [txt('- Image: C:/tmp/new.webp')] }], nextStep: [] },
      session: { deriveMessages: () => [{ role: 'user', content: [txt(`- Image: ${p}`)] }] },
    },
  };
  assert.deepEqual(userImagePaths(inbox), ['C:/tmp/new.webp']);
});

test('图片引用：没有会话也没有 inbox 时不抛错', () => {
  assert.deepEqual(userImageRefs({}), []);
  assert.deepEqual(userImageRefs(null), []);
  assert.deepEqual(takeImageRefs(null), []);
  assert.deepEqual(userImagePaths({}), []);
  assert.deepEqual(takeImagePaths(null), []);
});
test('图片地址：QQ 有时给 https 链接，单独认；且不会被当成本地路径去读', () => {
  const url = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=abc&rkey=xyz&spec=0';
  const content = [txt(`- Image: ${url}`)];
  assert.deepEqual(takeImageUrls(content), [url]);
  assert.deepEqual(takeImagePaths(content), []);

  const exec = {
    agent: {
      session: {
        deriveMessages: () => [
          { role: 'user', content: [txt(`- Image: ${url}`)] },
          { role: 'user', content: [txt('记住这两个东西在桌子上')] },
        ],
      },
    },
  };
  assert.deepEqual(userImageUrls(exec), [url]);
  assert.deepEqual(userImagePaths(exec), []);
  assert.equal(userImageUrls({}).length, 0);
});

test('图片路径：空格、引号、全角冒号、项目符号、行尾 [图片] 都要认', () => {
  const cases = [
    '- Image: C:/Users/John Smith/.dsh-qqbot/media/a b.jpg',
    '* Image: C:/tmp/x.png',
    '• Image: C:/tmp/y.webp',
    '- Image：C:/tmp/fullwidth.gif',
    '- Image: "C:/tmp/quoted.jpg"',
    "- Image: 'C:/tmp/single.jpg'",
    '- Image: C:/tmp/trailing.jpg [图片]',
    '- Image: C:/tmp/a(1).jpg',
  ];
  for (const line of cases) {
    const got = takeImagePaths([txt(line)]);
    assert.equal(got.length, 1, line);
  }
  assert.deepEqual(takeImagePaths([txt('- Image: C:/Users/John Smith/a b.jpg')]), ['C:/Users/John Smith/a b.jpg']);
});

test('图片地址：&amp; 反转义、全角冒号、两个 Image 挤在一行也要拆开', () => {
  assert.deepEqual(
    takeImageUrls([txt('- Image: https://x.test/a.jpg?x=1&amp;rkey=abc')]),
    ['https://x.test/a.jpg?x=1&rkey=abc'],
  );
  assert.deepEqual(
    takeImageUrls([txt('- Image: https://x.test/a.jpg - Image: https://x.test/b.png')]),
    ['https://x.test/a.jpg', 'https://x.test/b.png'],
  );
  assert.deepEqual(takeImagePaths([txt('- Image: C:/a.jpg - Image: C:/b.png')]), ['C:/a.jpg', 'C:/b.png']);
});

test('图片选择：只从同一条消息里抽，不会把附件和路径凑成两张图', () => {
  const exec = {
    agent: {
      inbox: { nextTurn: [{ content: [txt('- Image: C:/tmp/new.png')] }], nextStep: [] },
      session: {
        deriveMessages: () => [
          { role: 'user', content: [img('old-attachment')] },
          { role: 'user', content: [txt('新的这张放哪？')] },
        ],
      },
    },
  };
  // 本轮有新图：三个来源都只应看本轮，不能把上一条的附件也算进来
  assert.deepEqual(userImageRefs(exec), []);
  assert.deepEqual(userImagePaths(exec), ['C:/tmp/new.png']);
  assert.deepEqual(userImageUrls(exec), []);
});

test('图片选择：往回看 3 条仍命中，定时提醒不占窗口', () => {
  const messages = [
    { role: 'user', content: [txt('- Image: C:/tmp/target.jpg')] },
    { role: 'user', content: [txt('这个放书房')] },
    { role: 'user', content: [txt('[SCHEDULE REMINDER]\n到点了')] },
    { role: 'user', content: [txt('1')] },
    { role: 'assistant', content: [txt('好')] },
  ];
  const exec = { agent: { session: { deriveMessages: () => messages } } };
  assert.deepEqual(userImagePaths(exec), ['C:/tmp/target.jpg']);
});

test('图片路径：tool-result 里的 Image 行不能当用户发的图', () => {
  const content = [{ type: 'tool-result', content: [txt('- Image: http://127.0.0.1:8080/a.png')] }];
  assert.deepEqual(takeImageUrls(content), []);
  assert.deepEqual(takeImagePaths(content), []);
});

test('图片解析失败但正文确实提到 Image 时，能提示「没认出来」', () => {
  const exec = {
    agent: {
      session: {
        deriveMessages: () => [
          { role: 'user', content: [txt('- Image:')] },
          { role: 'assistant', content: [txt('好的')] },
        ],
      },
    },
  };
  assert.equal(userImageMentioned(exec), true);
  const none = { agent: { session: { deriveMessages: () => [{ role: 'user', content: [txt('没有图')] }] } } };
  assert.equal(userImageMentioned(none), false);
});
