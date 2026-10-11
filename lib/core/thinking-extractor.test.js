/**
 * `lib/core/thinking-extractor.test.js` — P2-1 单测
 *
 * ⚠️ **语料来源与隐私边界**：用例的**结构**逐字复刻 P0-1 验过的真实会话数据
 *    （字段名、通道形状、错例），但**文本内容一律为合成**。
 *    真实对话内容属隐私，`p0/sessions/` 与 `~/.dsh/sessions/**` 永不入库
 *    （见 CODEBUDDY.md §7）；真实语料的回放核验在本地跑，不写进版本库。
 *
 * ⚠️ 本文件必须能**脱离 DSH、脱离浏览器**单独跑：
 *    把 `lib/core/` 整个拷到空目录，`node --test` 应全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_CONTENT,
  CHANNEL_DELTA,
  CHANNEL_STREAM,
  MESSAGE_EVENT_TYPE,
  extractFromMessageData,
  extractFromMessageEvent,
  extractFromStreamFrame,
  extractReasoning,
  fromContentBlocks,
  fromStreamRecords,
  isMeaningfulReasoning,
  summarizeStreamPacing,
} from './thinking-extractor.js';

// ───────────────────────── 合成语料构造器 ─────────────────────────
// 形状对齐真实数据；内容是编的，避免把真实对话写进版本库。

/** 造一个持久通道的 `assistant/message` 事件 */
function messageEvent({ content = [], stream = [], turn } = {}) {
  return {
    type: MESSAGE_EVENT_TYPE,
    data: { turn, message: { content }, stream },
  };
}

/** 造一个 reasoning 内容块 */
const reasoningBlock = (text) => ({ type: 'reasoning', text });
/** 造一个正文块（必须被忽略 —— 红线 R2） */
const textBlock = (text) => ({ type: 'text', text });
/** 造一个工具调用块（必须被忽略） */
const toolCallBlock = (name) => ({ type: 'tool-call', name });

/** 造一条 `reasoning-chunks` 流式记录 */
function reasoningChunks(texts, dt) {
  const rec = { type: 'reasoning-chunks', texts };
  if (dt) rec.dt = dt;
  return rec;
}

/** 造一个实时通道的 `agent/assistant-stream` envelope */
function streamEnvelope(chunk, agent = { id: 'agent-1' }) {
  return { agent, frame: { type: 'chunk', chunk } };
}

// ───────────────────────── 基础判定 ─────────────────────────

test('isMeaningfulReasoning：空白不算思考（R-A 的唯一执行点）', () => {
  assert.equal(isMeaningfulReasoning('想了一下'), true);
  assert.equal(isMeaningfulReasoning('  字  '), true);
  assert.equal(isMeaningfulReasoning(''), false, '空串不算');
  assert.equal(isMeaningfulReasoning('   '), false, '纯空格不算');
  assert.equal(isMeaningfulReasoning('\n\t \r\n'), false, '纯换行/制表不算');
  assert.equal(isMeaningfulReasoning(null), false);
  assert.equal(isMeaningfulReasoning(undefined), false);
  assert.equal(isMeaningfulReasoning(123), false);
  assert.equal(isMeaningfulReasoning({}), false);
});

// ───────────────────────── 持久通道 ─────────────────────────

test('持久通道：从 content 块提取思考（主路径）', () => {
  const ev = messageEvent({ content: [reasoningBlock('先把输入归一化，再判断空块。')] });
  const out = extractFromMessageEvent(ev);
  assert.ok(out);
  assert.equal(out.text, '先把输入归一化，再判断空块。');
  assert.equal(out.meta.channel, CHANNEL_CONTENT);
  assert.equal(out.meta.length, out.text.length);
});

test('红线 R2：text / tool-call 块绝不能混进思考输出', () => {
  const ev = messageEvent({
    content: [
      reasoningBlock('我要读一下这个文件。'),
      textBlock('这是给用户看的正文，不许朗读。'),
      toolCallBlock('read_file'),
      reasoningBlock('读完再决定。'),
    ],
  });
  const out = extractFromMessageEvent(ev);
  assert.ok(out);
  assert.equal(out.text, '我要读一下这个文件。读完再决定。');
  assert.ok(!out.text.includes('正文'), '正文块不得泄漏');
  assert.ok(!out.text.includes('read_file'), '工具名不得泄漏');
});

test('多块 reasoning 按出现顺序拼接', () => {
  const ev = messageEvent({ content: [reasoningBlock('一'), reasoningBlock('二'), reasoningBlock('三')] });
  assert.equal(extractFromMessageEvent(ev).text, '一二三');
});

test('持久通道：content 为空时回落到 stream 记录', () => {
  const ev = messageEvent({
    content: [],
    stream: [reasoningChunks(['先看 ', '一眼 ', '再动手。'])],
  });
  const out = extractFromMessageEvent(ev);
  assert.ok(out);
  assert.equal(out.text, '先看 一眼 再动手。');
  assert.equal(out.meta.channel, CHANNEL_STREAM, '应标记为兜底路径');
});

test('持久通道：两条路径都在且一致 → 取 content，并标记 channelsAgree', () => {
  const text = '两条通道应该给出同一段文本。';
  const ev = messageEvent({
    content: [reasoningBlock(text)],
    stream: [reasoningChunks([text])],
  });
  const out = extractFromMessageEvent(ev);
  assert.equal(out.text, text);
  assert.equal(out.meta.channel, CHANNEL_CONTENT, 'content 优先');
  assert.equal(out.meta.channelsAgree, true);
  assert.equal(out.meta.bothChannelsPresent, true);
});

test('持久通道：两条路径不一致时不静默 —— channelsAgree 暴露出来', () => {
  const ev = messageEvent({
    content: [reasoningBlock('内容块版本')],
    stream: [reasoningChunks(['流式版本'])],
  });
  const out = extractFromMessageEvent(ev);
  assert.equal(out.text, '内容块版本');
  assert.equal(out.meta.channelsAgree, false, '不一致必须可被核验发现');
  assert.equal(out.meta.bothChannelsPresent, true);
});

// ───────────────────── 空 reasoning 块 = 无思考（R-A）─────────────────────

test('R-A：空 reasoning 块必须返回 null（否则就是朗读空气）', () => {
  const ev = messageEvent({ content: [reasoningBlock('')] });
  assert.equal(extractFromMessageEvent(ev), null);
});

test('R-A：纯空白的 reasoning 块也算无思考', () => {
  const ev = messageEvent({ content: [reasoningBlock('  \n\t ')] });
  assert.equal(extractFromMessageEvent(ev), null);
});

test('R-A：reasoning 块与 text 块并存但 reasoning 为空 → 仍然 null', () => {
  // 这正是实测里 `contentBlockTypes:["reasoning","text"]` + `reasoningChars:0` 的形态
  const ev = messageEvent({ content: [reasoningBlock(''), textBlock('正文很长很长，但与我无关。')] });
  assert.equal(extractFromMessageEvent(ev), null);
});

test('完全没有 reasoning 块 → null', () => {
  const ev = messageEvent({ content: [textBlock('只有正文'), toolCallBlock('grep')] });
  assert.equal(extractFromMessageEvent(ev), null);
});

test('空 stream 记录（texts 为空数组）→ null', () => {
  const ev = messageEvent({ content: [], stream: [reasoningChunks([])] });
  assert.equal(extractFromMessageEvent(ev), null);
});

test('事件类型不是 assistant/message → null（不误吞别的事件）', () => {
  const ev = { type: 'user/message', data: { message: { content: [reasoningBlock('不该被读到')] } } };
  assert.equal(extractFromMessageEvent(ev), null);
});

// ───────────────────────── 长思考（切分刚需的依据）─────────────────────────

test('长思考（≥1000 字）完整提取，长度不变 —— 切分是 P2-3 的事，本层不得截断', () => {
  const unit = '这是一段用于验证长度的合成思考，用来替代真实对话。';
  const long = unit.repeat(60); // 60 × 25 ≈ 1500 字
  assert.ok(long.length >= 1000, `构造的长文本应 ≥1000 字，实际 ${long.length}`);

  const ev = messageEvent({ content: [reasoningBlock(long)] });
  const out = extractFromMessageEvent(ev);
  assert.equal(out.text.length, long.length, '本层不得截断');
  assert.equal(out.text, long);
});

// ───────────────────── dt[] 只能当停顿线索（R-C）─────────────────────

test('R-C：dt[] 汇总进 meta，但绝不进入 text', () => {
  const ev = messageEvent({
    content: [reasoningBlock('正文')],
    stream: [reasoningChunks(['正', '文'], [120, 80])],
  });
  const out = extractFromMessageEvent(ev);
  assert.equal(out.text, '正文');
  assert.equal(out.meta.dtSum, 200, 'dt 之和应可读');
  assert.equal(out.meta.tokenCount, 2);
  assert.ok(!out.text.includes('120'), 'dt 数值不得混进文本');
});

test('summarizeStreamPacing：忽略非数值与非 reasoning 记录', () => {
  const pacing = summarizeStreamPacing([
    reasoningChunks(['a', 'b'], [10, 20]),
    { type: 'text-chunks', texts: ['x'], dt: [9999] }, // 不是 reasoning，必须忽略
    { type: 'reasoning-chunks', texts: ['c'], dt: [5, 'NaN', null, Infinity] },
  ]);
  assert.equal(pacing.dtSum, 35, '只累加有限数值');
  assert.equal(pacing.tokenCount, 3);
});

test('summarizeStreamPacing：非数组输入不抛错', () => {
  assert.deepEqual(summarizeStreamPacing(null), { dtSum: 0, tokenCount: 0 });
  assert.deepEqual(summarizeStreamPacing('nope'), { dtSum: 0, tokenCount: 0 });
});

// ───────────────────────── 实时通道（增量）─────────────────────────

test('实时通道：reasoning-delta 返回增量文本', () => {
  const out = extractFromStreamFrame(streamEnvelope({ type: 'reasoning-delta', text: '嗯……' }));
  assert.ok(out);
  assert.equal(out.text, '嗯……');
  assert.equal(out.meta.channel, CHANNEL_DELTA);
  assert.equal(out.meta.isDelta, true, '必须标明这是增量，不是全文');
  assert.equal(out.meta.agentId, 'agent-1');
});

test('实时通道：空增量照常返回（丢帧是调用方累积完成后的判定）', () => {
  const out = extractFromStreamFrame(streamEnvelope({ type: 'reasoning-delta', text: '' }));
  assert.ok(out, '空增量是合法的常见帧，本层不得丢弃');
  assert.equal(out.text, '');
});

test('实时通道：非 reasoning 的 chunk → null', () => {
  assert.equal(extractFromStreamFrame(streamEnvelope({ type: 'text-delta', text: '正文' })), null);
  assert.equal(extractFromStreamFrame(streamEnvelope({ type: 'tool-call', name: 'grep' })), null);
});

test('实时通道：frame 不是 chunk → null', () => {
  assert.equal(extractFromStreamFrame({ frame: { type: 'done' } }), null);
  assert.equal(extractFromStreamFrame({ frame: {} }), null);
});

// ───────────────────────── 统一入口与健壮性 ─────────────────────────

test('extractReasoning：自动判别两种通道', () => {
  const persistent = messageEvent({ content: [reasoningBlock('持久')] });
  const realtime = streamEnvelope({ type: 'reasoning-delta', text: '实时' });
  assert.equal(extractReasoning(persistent).text, '持久');
  assert.equal(extractReasoning(realtime).text, '实时');
  assert.equal(extractReasoning(realtime).meta.isDelta, true);
});

test('extractReasoning：无关事件一律 null，且不抛错（事件流里绝大多数都不是思考源）', () => {
  const junk = [
    null,
    undefined,
    0,
    'string',
    [],
    {},
    { type: 'user/message', data: {} },
    { type: MESSAGE_EVENT_TYPE },
    { frame: null },
    { agent: {}, frame: { type: 'chunk' } },
    { agent: {}, frame: { type: 'chunk', chunk: null } },
  ];
  for (const input of junk) {
    assert.doesNotThrow(() => extractReasoning(input));
    assert.equal(extractReasoning(input), null, `应判为无关：${JSON.stringify(input)}`);
  }
});

test('extractFromMessageData：非法输入不抛错', () => {
  for (const input of [null, undefined, 0, 'x', [], true]) {
    assert.equal(extractFromMessageData(input), null);
  }
  assert.equal(extractFromMessageData({}), null, '空 payload 无思考');
  assert.equal(extractFromMessageData({ message: null, stream: null }), null);
});

test('fromContentBlocks / fromStreamRecords：非数组输入返回空串', () => {
  assert.equal(fromContentBlocks(null), '');
  assert.equal(fromContentBlocks({}), '');
  assert.equal(fromStreamRecords(undefined), '');
  assert.equal(fromStreamRecords('x'), '');
});

test('turnId：取得到就带出，取不到是 undefined 而不是报错', () => {
  const withTurn = messageEvent({ content: [reasoningBlock('x')], turn: { id: 'turn-7' } });
  assert.equal(extractFromMessageEvent(withTurn).meta.turnId, 'turn-7');

  const bare = messageEvent({ content: [reasoningBlock('x')] });
  assert.equal(extractFromMessageEvent(bare).meta.turnId, undefined);
});
