/**
 * `lib/index.test.js` — P2-2 / P2-6 入口层单测
 *
 * 入口层的职责只有"参数校验 + 事件转发"（DESIGN §4.3），所以这里守的也是这件事：
 * 订阅签名对不对、参数形状传对没有、异常会不会外泄。
 *
 * ⚠️ 这些用例**不启动 DSH**：用假 `ctx` 记录订阅，用假 pipeline 记录转发。
 *    真正的端到端验证另有其人（`p0/` 的真实语料回放 + 开发循环）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActivityHub, API, attachThinkingEvents, name } from './index.js';

// ───────────────────── 改名硬契约（HANDOFF §6.2）─────────────────────

test('改名硬契约：row id 与路由前缀必须是本项目自己的名字', () => {
  assert.equal(name, 'think-voice-pet');
  assert.equal(API, '/api/think-voice-pet');
});

// ───────────────────── 订阅签名与参数形状 ─────────────────────

/** 造一个记录订阅的假 ctx */
function fakeCtx({ globalThrows = false } = {}) {
  const subs = [];
  return {
    subs,
    on(event, handler, options) {
      if (options?.global === true && globalThrows) {
        throw new Error('this host does not accept the global option');
      }
      subs.push({ event, handler, options });
      return () => {};
    },
    find(event) {
      return subs.find((s) => s.event === event);
    },
  };
}

function fakePipeline() {
  const calls = [];
  return {
    calls,
    onSessionEvent(event) { calls.push(['session', event]); return { kind: 'ok' }; },
    onStreamFrame(payload) { calls.push(['stream', payload]); return { kind: 'ok' }; },
  };
}

test('两条通道都用 { global: true } 订阅（Scoped 事件不带它永不回调）', () => {
  const ctx = fakeCtx();
  const pipeline = fakePipeline();
  const res = attachThinkingEvents(ctx, pipeline);

  assert.deepEqual(res, { persistent: true, realtime: true });
  assert.equal(ctx.subs.length, 2);
  for (const s of ctx.subs) {
    assert.equal(s.options?.global, true, `${s.event} 必须带 { global: true }`);
  }
  assert.ok(ctx.find('session/event'), '必须订阅 session/event');
  assert.ok(ctx.find('agent/assistant-stream'), '必须订阅 agent/assistant-stream');
});

test('宿主不接受 global 选项时退回默认签名（不抛、不静默死掉）', () => {
  const ctx = fakeCtx({ globalThrows: true });
  const pipeline = fakePipeline();
  const res = attachThinkingEvents(ctx, pipeline);

  assert.deepEqual(res, { persistent: true, realtime: true });
  assert.equal(ctx.subs.length, 2);
  for (const s of ctx.subs) assert.equal(s.options, undefined, '退回后不应再带 options');
});

test('持久通道：两个**位置参数**，且只转发 assistant/message', () => {
  const ctx = fakeCtx();
  const pipeline = fakePipeline();
  attachThinkingEvents(ctx, pipeline);
  const handler = ctx.find('session/event').handler;

  handler({ id: 'sess-1' }, { type: 'assistant/message', data: { message: { content: [] } } });
  assert.equal(pipeline.calls.length, 1);
  assert.equal(pipeline.calls[0][0], 'session');
  assert.equal(pipeline.calls[0][1].type, 'assistant/message');

  // 别的事件类型不得转发 —— 否则整条事件流都会进流水线
  for (const t of ['user/message', 'turn/end', 'tool/call', undefined]) {
    handler({ id: 'sess-1' }, { type: t, data: {} });
  }
  assert.equal(pipeline.calls.length, 1, '非 assistant/message 不应转发');
});

test('实时通道：一个**对象参数**（{ agent, frame }）', () => {
  const ctx = fakeCtx();
  const pipeline = fakePipeline();
  attachThinkingEvents(ctx, pipeline);
  const handler = ctx.find('agent/assistant-stream').handler;

  const envelope = { agent: { id: 'a1' }, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'x' } } };
  handler(envelope);
  assert.equal(pipeline.calls.length, 1);
  assert.equal(pipeline.calls[0][0], 'stream');
  assert.equal(pipeline.calls[0][1], envelope, '应原样转发整个 envelope');
});

test('handler 抛异常绝不外泄到宿主事件流', () => {
  const ctx = fakeCtx();
  const boom = {
    onSessionEvent() { throw new Error('pipeline blew up'); },
    onStreamFrame() { throw new Error('pipeline blew up'); },
  };
  attachThinkingEvents(ctx, boom);

  for (const event of ['session/event', 'agent/assistant-stream']) {
    const handler = ctx.find(event).handler;
    assert.doesNotThrow(() => handler({}, { type: 'assistant/message' }),
      `${event} 的异常泄漏到了宿主`);
  }
});

test('宿主连事件都没有（旧版本）→ 报不可用，而不是崩', () => {
  const ctx = { on() { throw new Error('unknown event'); } };
  const res = attachThinkingEvents(ctx, fakePipeline());
  assert.deepEqual(res, { persistent: false, realtime: false });
});

// ───────────────────── SSE 广播（P2-6）─────────────────────

test('ActivityHub.broadcast：把 speak 帧送到所有订阅者', () => {
  const hub = new ActivityHub();
  const got = [];
  hub.subscribe((f) => got.push(f));

  hub.broadcast({ type: 'speak', payload: { text: '一句话', audioUrl: null, emotion: null } });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'speak');
  hub.dispose();
});

test('ActivityHub.broadcast：单个订阅者抛异常不影响其他订阅者', () => {
  const hub = new ActivityHub();
  const got = [];
  hub.subscribe(() => { throw new Error('this stream is dead'); });
  hub.subscribe((f) => got.push(f));

  assert.doesNotThrow(() => hub.broadcast({ type: 'speak', payload: { text: 'x' } }));
  assert.equal(got.length, 1, '活着的流必须照常收到');
  hub.dispose();
});

test('不改已有帧的形状：相位快照仍然没有 type 字段', () => {
  const hub = new ActivityHub();
  const snap = hub.snapshot();
  assert.ok('phase' in snap && 'detail' in snap && 'at' in snap);
  assert.equal('type' in snap, false, '相位快照不得被加上 type —— 否则浏览器分派规则会乱');
  hub.dispose();
});

test('broadcast 与 emit 互不干扰（相位帧不会带上 speak 的内容）', () => {
  const hub = new ActivityHub();
  const got = [];
  hub.subscribe((f) => got.push(f));
  hub.set('thinking', '');
  hub.broadcast({ type: 'speak', payload: { text: 'x', audioUrl: null, emotion: null } });
  assert.equal(got.length, 2);
  assert.equal('type' in got[0], false, '第一条是相位帧');
  assert.equal(got[1].type, 'speak', '第二条是朗读帧');
  hub.dispose();
});
