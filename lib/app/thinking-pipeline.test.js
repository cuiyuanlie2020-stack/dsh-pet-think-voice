/**
 * `lib/app/thinking-pipeline.test.js` — P2-2 单测
 *
 * 这层是**编排**，所以测试的重点不是"算得对不对"，而是**串起来之后行为对不对**：
 * 事件进来 → 该不该产出、产出几次、产出的帧长什么样、两条通道会不会重复处理。
 *
 * 时钟注入（`now`），全程不 sleep。
 * ⚠️ 文本内容一律合成（真实对话属隐私，永不入库）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createThinkingPipeline } from './thinking-pipeline.js';

const T0 = 5_000_000;

/** 一段能过规则阈值的合成思考（命中 wait/wrong/reconsider 且长度合适） */
const HIT_REASONING = 'Wait, this looks wrong. I should reconsider the parameter order first.';
/** 一段平淡的合成思考（无任何信号词） */
const DULL_REASONING = 'Read the file then continue with the next item in the list.';

/** 造一个持久通道的 assistant/message 事件 */
function messageEvent(reasoning, { turnId = 'turn-1', withText = true } = {}) {
  const content = [];
  if (reasoning !== undefined) content.push({ type: 'reasoning', text: reasoning });
  if (withText) content.push({ type: 'text', text: '这是给用户看的正文，绝不能被朗读。' });
  return {
    type: 'assistant/message',
    data: { turn: { id: turnId }, message: { content }, stream: [] },
  };
}

/** 造一个实时通道 envelope */
function streamFrame(chunkType, text, agentId = 'agent-1') {
  return { agent: { id: agentId }, frame: { type: 'chunk', chunk: { type: chunkType, text } } };
}

function collect() {
  const frames = [];
  const logs = [];
  const pipeline = createThinkingPipeline({
    now: () => T0,
    onSpeak: (frame, meta) => frames.push({ frame, meta }),
    onLog: (entry) => logs.push(entry),
  });
  return { pipeline, frames, logs };
}

// ───────────────────── 持久通道（主来源）─────────────────────

test('持久通道：一条带思考的 assistant/message → 入队并可产出', () => {
  const { pipeline, frames } = collect();
  const res = pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.equal(res.kind, 'ok');
  assert.ok(res.accepted >= 1, `应至少入队 1 条，实际 ${res.accepted}`);

  const frame = pipeline.tick();
  assert.ok(frame, '到点应产出');
  assert.equal(frames.length, 1);
});

test('R2：正文（type:text）绝不进入朗读内容', () => {
  const { pipeline, frames } = collect();
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  const frame = pipeline.tick();
  assert.ok(frame);
  assert.ok(!frame.payload.text.includes('正文'), '正文块泄漏进了朗读内容');
  assert.ok(!frame.payload.text.includes('用户看的'), '正文块泄漏进了朗读内容');
});

test('R-A：空 reasoning 块不产出，也不排进队列', () => {
  const { pipeline, frames, logs } = collect();
  const res = pipeline.onSessionEvent(messageEvent(''));
  assert.equal(res.kind, 'empty');
  assert.equal(pipeline.tick(), null);
  assert.equal(frames.length, 0);
  assert.equal(pipeline.stats().emptyReasoning, 1);
  assert.ok(logs.length >= 0);
});

test('平淡片段过不了阈值 → 不产出（靠 observed 计数确认它真的被看过）', () => {
  const { pipeline, frames } = collect();
  const res = pipeline.onSessionEvent(messageEvent(DULL_REASONING));
  assert.equal(res.kind, 'ok');
  assert.equal(res.accepted, 0, '平淡内容不该入队');
  assert.ok(res.fragments > 0, '但它确实被切分并打分了');
  assert.equal(pipeline.tick(), null);
  assert.equal(frames.length, 0);
});

test('事件类型不对（非 assistant/message）→ 什么也不做', () => {
  const { pipeline } = collect();
  for (const bad of [
    { type: 'user/message', data: { message: { content: [{ type: 'reasoning', text: HIT_REASONING }] } } },
    null, undefined, {}, 42,
  ]) {
    assert.equal(pipeline.onSessionEvent(bad).kind, 'empty');
  }
});

// ───────────────────── 两条通道的去重 ─────────────────────

test('两条通道拿到同一段文本 → 只处理一次（按内容哈希去重）', () => {
  const { pipeline, frames } = collect();
  const a = pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.ok(a.accepted >= 1);

  // 实时通道攒出**同样的**文本（P0-1 已证两通道同文）
  pipeline.onStreamFrame(streamFrame('reasoning-delta', HIT_REASONING));
  const b = pipeline.flushDelta();
  assert.equal(b.kind, 'duplicate', '同文应被哈希去重');
  assert.equal(b.accepted, 0);

  assert.equal(pipeline.tick().payload.text.length > 0, true);
});

test('实时通道先到、持久通道后到 → 同样只处理一次', () => {
  const { pipeline } = collect();
  pipeline.onStreamFrame(streamFrame('reasoning-delta', HIT_REASONING));
  const first = pipeline.flushDelta();
  assert.equal(first.kind, 'ok');
  assert.ok(first.accepted >= 1);

  const second = pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.equal(second.kind, 'duplicate');
});

test('真正不同的两段思考各处理一次', () => {
  const { pipeline } = collect();
  const r1 = pipeline.onSessionEvent(messageEvent(HIT_REASONING, { turnId: 't1' }));
  const r2 = pipeline.onSessionEvent(
    messageEvent('Oh interesting — the regex was matching too much. Now I see it.', { turnId: 't2' }));
  assert.equal(r1.kind, 'ok');
  assert.equal(r2.kind, 'ok');
});

// ───────────────────── 实时通道的累积与冲刷 ─────────────────────

test('实时通道：增量累积，遇到非思考 chunk 才冲刷', () => {
  const { pipeline } = collect();
  // 逐段吐字
  for (const piece of ['Wait, ', 'this looks ', 'wrong. I should ', 'reconsider the parameter order first.']) {
    const r = pipeline.onStreamFrame(streamFrame('reasoning-delta', piece));
    assert.equal(r.kind, 'buffered');
  }
  // 还没冲刷 ⇒ 队列里啥也没有
  assert.equal(pipeline.tick(), null);

  // 正文增量到来 ⇒ 推理段结束 ⇒ 冲刷
  const flushed = pipeline.onStreamFrame(streamFrame('text-delta', '给用户看的正文'));
  assert.equal(flushed.kind, 'ok');
  assert.ok(flushed.accepted >= 1);

  assert.ok(pipeline.tick(), '冲刷后应能产出');
});

test('实时通道：空增量（心跳帧）既不推进也不丢弃', () => {
  const { pipeline } = collect();
  assert.equal(pipeline.onStreamFrame(streamFrame('reasoning-delta', '')).kind, 'idle');
  const r = pipeline.onStreamFrame(streamFrame('reasoning-delta', HIT_REASONING));
  assert.equal(r.kind, 'buffered');
  assert.ok(pipeline.flushDelta().accepted >= 1, '心跳不该把已攒的内容弄丢');
});

test('实时通道：缓冲超限自动冲刷（防御推理边界事件缺失）', () => {
  const { pipeline } = collect();
  // 用一段足够长、且含大量信号词的文本把缓冲顶过阈值
  const long = `${HIT_REASONING} `.repeat(120);
  pipeline.onStreamFrame(streamFrame('reasoning-delta', long.slice(0, 4000)));
  const r = pipeline.onStreamFrame(streamFrame('reasoning-delta', long.slice(4000, 9000)));
  assert.equal(r.kind, 'ok', '超限应自动冲刷');
});

test('实时通道：不同 agent 的缓冲互不串味', () => {
  const { pipeline } = collect();
  pipeline.onStreamFrame(streamFrame('reasoning-delta', 'Wait, this looks ', 'agent-A'));
  pipeline.onStreamFrame(streamFrame('reasoning-delta', 'wrong and I should ', 'agent-B'));
  pipeline.onStreamFrame(streamFrame('reasoning-delta', 'reconsider the parameter order now.', 'agent-A'));

  const a = pipeline.flushDelta('agent-A');
  assert.equal(a.kind, 'ok', 'agent-A 的内容应完整（两段拼上）');
  const b = pipeline.flushDelta('agent-B');
  assert.equal(b.kind, 'ok');
});

// ───────────────────── 下发帧形状（DESIGN §6.4）─────────────────────

test('下发帧严格符合 DESIGN §6.4：type/payload/text/audioUrl/emotion', () => {
  const { pipeline } = collect();
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  const frame = pipeline.tick();

  assert.equal(frame.type, 'speak');
  assert.ok(frame.payload && typeof frame.payload === 'object');
  assert.equal(typeof frame.payload.text, 'string');
  assert.ok(frame.payload.text.length > 0);
  // P2 无声音、无表情 —— 且**必须是 null 而不是缺字段**，浏览器要能靠它走降级分支
  assert.equal(frame.payload.audioUrl, null);
  assert.equal(frame.payload.emotion, null);
  assert.ok('emotion' in frame.payload, 'emotion 字段必须存在且为 null，不能省略');
});

test('tick 到点才产出：20s 闸内只出一条', () => {
  const frames = [];
  let clock = T0;
  const pipeline = createThinkingPipeline({
    now: () => clock,
    onSpeak: (f) => frames.push(f),
  });
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  pipeline.onSessionEvent(messageEvent('Hmm, actually this is wrong — I should reconsider it.', { turnId: 't2' }));

  assert.ok(pipeline.tick(), '第一条应立即出');
  clock = T0 + 1_000;
  assert.equal(pipeline.tick(), null, '1s 后不得再出');
  clock = T0 + 19_999;
  assert.equal(pipeline.tick(), null, '差 1ms 也不行');
  clock = T0 + 20_000;
  assert.ok(pipeline.tick(), '满 20s 应再出一条');
  assert.equal(frames.length, 2);
});

test('R3 留痕：降级/跳过要能说出来，不静默', () => {
  const { pipeline, logs } = collect();
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  const ingested = logs.find((l) => l.event === 'ingested');
  assert.ok(ingested, '必须留下一条 ingested 记录');
  assert.match(ingested.detail, /channel=persistent/);

  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.ok(logs.some((l) => l.event === 'duplicate'), '去重也要留痕');
});

test('可观测性：未过阈 / 本轮无思考 都必须留 info 级日志', () => {
  // 这条来自真实踩坑：657 字的思考被正常处理，却因为一条都没过阈而只留了 debug 日志，
  // 宿主又把 debug 过滤掉 —— 结果「接上了但没选中」和「压根没接上」在日志里长得一样。
  const { pipeline, logs } = collect();

  pipeline.onSessionEvent(messageEvent(DULL_REASONING));
  const ing = logs.find((l) => l.event === 'ingested');
  assert.ok(ing, '未过阈也必须留痕');
  assert.equal(ing.level, 'info', '必须是 info —— debug 会被宿主过滤掉');
  assert.match(ing.detail, /最高分=/, '要带上最高分，否则看不出"差了多少"');
  assert.match(ing.detail, /阈值/, '阈值也要写出来，否则无法判断是"词表没中"还是"阈值太高"');

  pipeline.onSessionEvent(messageEvent(''));
  const empty = logs.find((l) => l.event === 'no-reasoning');
  assert.ok(empty, '本轮无思考也必须留痕');
  assert.equal(empty.level, 'info');
});

// ───────────────────── 一键停 / 生命周期 ─────────────────────

test('pause 丢队列但保留判重记忆（恢复后不重复念同一句）', () => {
  const { pipeline } = collect();
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.ok(pipeline.tick(), '先出一条');

  pipeline.pause();
  const again = pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.equal(again.kind, 'duplicate', 'pause 不该忘掉"念过什么"');
});

test('reset 连判重记忆一起清（换会话场景）', () => {
  const { pipeline } = collect();
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  pipeline.tick();
  pipeline.reset();
  assert.equal(pipeline.stats().pending, 0, 'reset 后队列应为空');

  const again = pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  assert.equal(again.kind, 'ok', 'reset 后同样的文本应可再处理');
  assert.ok(again.accepted >= 1);
});

test('stats 汇总流水线与调度器的计数', () => {
  const { pipeline } = collect();
  pipeline.onSessionEvent(messageEvent(HIT_REASONING));
  pipeline.tick();
  const s = pipeline.stats();
  assert.equal(s.inbound, 1);
  assert.ok(s.fragments > 0);
  assert.ok(s.accepted >= 1);
  assert.equal(s.spoken, 1);
  assert.ok('pending' in s && 'lastSpokenAt' in s, 'planner 的观测项也要透出');
});

test('产物是纯数据：不依赖 DSH / 时钟 / 随机（可脱离宿主重跑）', () => {
  const run = () => {
    const out = [];
    const p = createThinkingPipeline({ now: () => T0, onSpeak: (f) => out.push(f.payload.text) });
    p.onSessionEvent(messageEvent(HIT_REASONING));
    p.tick();
    return out;
  };
  assert.deepEqual(run(), run());
});
