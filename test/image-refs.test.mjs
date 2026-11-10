import assert from 'node:assert/strict';
import test from 'node:test';

import { lastUserMessageRefs, takeImageRefs, userImageRefs } from '../src/image-refs.js';

const img = (id) => ({ type: 'image', attachment: { mediaType: 'image/png', id } });
const txt = (text) => ({ type: 'text', text });

test('图片引用：只看最后一条用户消息，别把旧截图挂到新物件上', () => {
  const exec = {
    agent: {
      session: {
        deriveMessages: () => [
          { role: 'user', content: [txt('这是我家的柜子'), img('old')] },
          { role: 'assistant', content: [txt('好')] },
          { role: 'user', content: [txt('钥匙放玄关了')] },
        ],
      },
    },
  };
  assert.deepEqual(lastUserMessageRefs(exec), []);
  // 最后一条用户消息没有图：不能回退去拿更早的那张
  assert.deepEqual(userImageRefs(exec), []);
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

test('图片引用：没有会话也没有 inbox 时不抛错', () => {
  assert.deepEqual(userImageRefs({}), []);
  assert.deepEqual(userImageRefs(null), []);
  assert.deepEqual(takeImageRefs(null), []);
});
