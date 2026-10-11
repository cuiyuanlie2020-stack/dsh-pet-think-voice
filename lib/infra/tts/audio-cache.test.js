/**
 * `lib/infra/tts/audio-cache.test.js` — P3-2 音频缓存单测
 *
 * 守两件事：
 *   ① **LRU 语义**（条数/字节双上限、访问提升顺序）—— 超限不淘汰就是内存泄漏；
 *   ② **token 是访问控制**（不是"猜不到 id 就算安全"）—— 音频里是用户的思考内容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MAX_ENTRIES, createAudioCache } from './audio-cache.js';

const buf = (text) => Buffer.from(text, 'utf8');

test('放进去能按 id + token 取出来，内容与 mime 原样', () => {
  const cache = createAudioCache();
  const handle = cache.put(buf('MP3-A'));

  assert.match(handle.id, /^[a-f0-9]{16}$/);
  assert.equal(handle.cached, false);
  assert.equal(handle.bytes, 5);

  const got = cache.get(handle.id, handle.token);
  assert.equal(got?.buffer.toString(), 'MP3-A');
  assert.equal(got?.mime, 'audio/mpeg');
});

test('token 不对 / 缺失 / 空串一律取不到（这是访问控制，不是防呆）', () => {
  const cache = createAudioCache();
  const handle = cache.put(buf('secret-thought'));

  assert.equal(cache.get(handle.id, 'wrong-token'), null);
  assert.equal(cache.get(handle.id, undefined), null);
  assert.equal(cache.get(handle.id, ''), null);
  assert.equal(cache.get(handle.id, null), null);
  assert.ok(cache.get(handle.id, handle.token), '正确的 token 必须能取到');
});

test('id 只含哈希，不含原文（URL 会出现在浏览器侧，别把思考内容写进去）', () => {
  const cache = createAudioCache();
  const handle = cache.put(buf('这是用户的思考原文'));
  assert.match(handle.id, /^[a-f0-9]{16}$/);
  assert.equal(handle.id.includes('思考'), false);
});

test('同一内容重复放 → 同 id、同 token，且不新增条目（幂等）', () => {
  const cache = createAudioCache();
  const first = cache.put(buf('same-audio'));
  const second = cache.put(buf('same-audio'));

  assert.equal(second.id, first.id);
  assert.equal(second.token, first.token, 'token 必须复用，否则刚发出去的 URL 会失效');
  assert.equal(second.cached, true);
  assert.equal(cache.stats().entries, 1);
});

test('不同内容 → 不同 id', () => {
  const cache = createAudioCache();
  assert.notEqual(cache.put(buf('a')).id, cache.put(buf('b')).id);
  assert.equal(cache.stats().entries, 2);
});

test('超过条数上限 → 淘汰最旧的（否则就是内存泄漏）', () => {
  const cache = createAudioCache({ maxEntries: 3 });
  const handles = ['a', 'b', 'c', 'd'].map((t) => cache.put(buf(t)));

  assert.equal(cache.stats().entries, 3);
  assert.equal(cache.get(handles[0].id, handles[0].token), null, '最旧的 a 应被淘汰');
  for (const h of handles.slice(1)) {
    assert.ok(cache.get(h.id, h.token), `${h.id} 应仍在`);
  }
});

test('被访问过的条目会被提升，不会先被淘汰（LRU 而不是 FIFO）', () => {
  const cache = createAudioCache({ maxEntries: 3 });
  const [a, b, c] = ['a', 'b', 'c'].map((t) => cache.put(buf(t)));

  // 访问 a ⇒ a 变成最近使用，最旧的应轮 b
  assert.ok(cache.get(a.id, a.token));
  cache.put(buf('d'));

  assert.ok(cache.get(a.id, a.token), 'a 刚被访问过，不该被淘汰');
  assert.equal(cache.get(b.id, b.token), null, 'b 才是最旧的');
  assert.ok(cache.get(c.id, c.token));
});

test('字节上限也能兜底（单条很大时不能只靠条数）', () => {
  const cache = createAudioCache({ maxEntries: 100, maxBytes: 10 });
  cache.put(Buffer.alloc(8, 1));
  cache.put(Buffer.alloc(8, 2));   // 累计 16 > 10 ⇒ 淘汰最旧
  assert.equal(cache.stats().entries, 1);
  assert.ok(cache.stats().bytes <= 10);
});

test('上限是正的默认值；clear() 能一次清空', () => {
  assert.ok(DEFAULT_MAX_ENTRIES > 0);
  const cache = createAudioCache();
  const handle = cache.put(buf('x'));
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cache.get(handle.id, handle.token), null);
});

test('淘汰后同内容再放，会拿到**新** token（旧 URL 必须失效）', () => {
  const cache = createAudioCache({ maxEntries: 1 });
  const first = cache.put(buf('x'));
  cache.put(buf('y'));            // 挤掉 x
  const again = cache.put(buf('x'));
  assert.equal(again.id, first.id, 'id 是内容哈希，必然相同');
  assert.notEqual(again.token, first.token, 'token 必须换新，旧引用不得继续可用');
  assert.equal(cache.get(first.id, first.token), null, '旧 token 必须失效');
  assert.ok(cache.get(again.id, again.token));
});
