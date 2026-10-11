/**
 * `lib/core/thinking-extractor.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：从一个 DSH 会话事件里提取模型的**思考原文（reasoning）**。
 * 契约：`docs/DESIGN.md` §6.1 —— 取数路径已由 P0-1 用 **181 条真实思考** 验证定稿。
 *
 * ⛔ 本模块是纯逻辑：不 import 任何 Node 内置 I/O、DSH API、网络库、pixi。
 *    入参是**纯数据**（事件对象），不是框架的活对象 —— 所以单测可以直接喂 JSON 字面量。
 *
 * ── 两条通道（DESIGN §6.1，实测 181/181 抽出的文本**完全一致**）────────────────
 *
 *   ① 持久通道 `session/event`（可回放）
 *        event.type === 'assistant/message'
 *        event.data.message.content[]  .type === 'reasoning' → .text      （完整思考）
 *        event.data.stream[]           .type === 'reasoning-chunks' → .texts[]
 *   ② 实时通道 `agent/assistant-stream`（瞬态）
 *        frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta' → .text
 *
 * ── 三条实测踩出来的硬规则（都不是猜测）─────────────────────────────────
 *
 *   R-A **空 reasoning 块 = 无思考**。模型会产出 `contentBlockTypes: ['reasoning','text']`
 *       但 `reasoningChars: 0` 的块。仅凭"块类型是 reasoning"就当候选 ⇒ **朗读空气**。
 *   R-B **只读 reasoning（红线 R2）**。`content[].type ∈ {reasoning, text, tool-call}`，
 *       后两者**绝不能**混进输出 —— 否则就是把模型正文/工具产出念出来了。
 *   R-C **`dt[]` 不得当朗读节奏**。它是模型逐 token 吐字的毫秒增量，只能作为
 *       "哪里停顿过"的线索。本模块只把它汇总成一个数字放进 meta，绝不参与切分。
 */

/** 持久通道 · content 块来源 */
export const CHANNEL_CONTENT = 'content';
/** 持久通道 · stream 记录来源（content 块不可用时的兜底） */
export const CHANNEL_STREAM = 'stream';
/** 实时通道 · 增量来源（调用方负责累积） */
export const CHANNEL_DELTA = 'delta';

/** 持久通道的事件类型判别符（DESIGN §6.1） */
export const MESSAGE_EVENT_TYPE = 'assistant/message';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asText = (v) => (typeof v === 'string' ? v : '');

/**
 * 判定「这段文本算不算真的思考」。
 *
 * 这是 R-A 的唯一执行点：**空白不算**。空 reasoning 块、纯空格、纯换行
 * 都必须判 false，否则下游会拿到一条"要朗读"的任务而念出空气。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isMeaningfulReasoning(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * 从 `message.content[]` 里拼出思考文本（持久通道主路径）。
 * 只取 `type === 'reasoning'` 的块 —— `text` / `tool-call` 一律跳过（规则 R-B）。
 *
 * @param {unknown} content  `event.data.message.content`
 * @returns {string}
 */
export function fromContentBlocks(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!isObj(block) || block.type !== 'reasoning') continue;
    out += asText(block.text);
  }
  return out;
}

/**
 * 从 `stream[]` 里拼出思考文本（持久通道兜底路径）。
 * `reasoning-chunks` 记录的 `texts[]` 是逐 token 文本，顺序拼接即为全文。
 *
 * @param {unknown} stream  `event.data.stream`
 * @returns {string}
 */
export function fromStreamRecords(stream) {
  if (!Array.isArray(stream)) return '';
  let out = '';
  for (const rec of stream) {
    if (!isObj(rec) || rec.type !== 'reasoning-chunks') continue;
    if (!Array.isArray(rec.texts)) continue;
    for (const t of rec.texts) out += asText(t);
  }
  return out;
}

/**
 * 汇总 `dt[]`（逐 token 毫秒增量）。
 *
 * ⚠️ 返回值**只作"哪里停顿过"的线索**，不得当作朗读节奏（规则 R-C）。
 *
 * @param {unknown} stream
 * @returns {{dtSum:number, tokenCount:number}}
 */
export function summarizeStreamPacing(stream) {
  let dtSum = 0;
  let tokenCount = 0;
  if (!Array.isArray(stream)) return { dtSum, tokenCount };
  for (const rec of stream) {
    if (!isObj(rec) || rec.type !== 'reasoning-chunks') continue;
    if (Array.isArray(rec.dt)) {
      for (const d of rec.dt) if (typeof d === 'number' && Number.isFinite(d)) dtSum += d;
    }
    if (Array.isArray(rec.texts)) tokenCount += rec.texts.length;
  }
  return { dtSum, tokenCount };
}

/**
 * 从 `event.data`（持久通道的 payload）提取思考。
 *
 * 主路径取 content 块；只有在 content 块**不含有效思考**时才回落到 stream 记录。
 * 两条路径实测一致，所以"content 优先 + stream 兜底"不会引入差异，
 * 但能覆盖"只有其中一条有"的真实情况（实测存在这种消息）。
 *
 * @param {unknown} data  `event.data`
 * @returns {{text:string, meta:object}|null}  无有效思考时返回 `null`
 */
export function extractFromMessageData(data) {
  if (!isObj(data)) return null;

  const message = isObj(data.message) ? data.message : {};
  const viaContent = fromContentBlocks(message.content);
  const viaStream = fromStreamRecords(data.stream);

  const useContent = isMeaningfulReasoning(viaContent);
  const text = useContent ? viaContent : viaStream;

  // R-A：空 reasoning 块 = 无思考。这里必须返回 null，不能返回空串让下游自己判。
  if (!isMeaningfulReasoning(text)) return null;

  const { dtSum, tokenCount } = summarizeStreamPacing(data.stream);

  return {
    text,
    meta: {
      channel: useContent ? CHANNEL_CONTENT : CHANNEL_STREAM,
      turnId: extractTurnId(data),
      length: text.length,
      tokenCount,
      dtSum,
      // 两条通道都抽到了思考、且逐字相同 —— 用于回放核验（P0-1 实测恒为 true）
      channelsAgree:
        isMeaningfulReasoning(viaContent) &&
        isMeaningfulReasoning(viaStream) &&
        viaContent === viaStream,
      bothChannelsPresent: isMeaningfulReasoning(viaContent) && isMeaningfulReasoning(viaStream),
    },
  };
}

/**
 * 从持久通道 envelope 提取思考。
 * 判别符按契约严格要求 `type === 'assistant/message'`，避免把别的事件误当思考源。
 *
 * @param {unknown} event
 * @returns {{text:string, meta:object}|null}
 */
export function extractFromMessageEvent(event) {
  if (!isObj(event) || event.type !== MESSAGE_EVENT_TYPE) return null;
  return extractFromMessageData(event.data);
}

/**
 * 从实时通道 envelope 取出一段**增量**。
 *
 * ⚠️ 返回的是增量而不是全文 —— `reasoning-delta` 会分很多帧吐出来，累积是调用方的事。
 * 空增量（`text === ''`）是合法且常见的（心跳/空帧），这里**照常返回**，
 * 由调用方在累积完成后调用 `isMeaningfulReasoning` 判定，不要在这一层丢帧。
 *
 * @param {unknown} envelope  `{ agent, frame }`
 * @returns {{text:string, meta:object}|null}  非 reasoning 增量时返回 `null`
 */
export function extractFromStreamFrame(envelope) {
  if (!isObj(envelope)) return null;
  const frame = envelope.frame;
  if (!isObj(frame) || frame.type !== 'chunk') return null;
  const chunk = frame.chunk;
  if (!isObj(chunk) || chunk.type !== 'reasoning-delta') return null;

  return {
    text: asText(chunk.text),
    meta: {
      channel: CHANNEL_DELTA,
      isDelta: true,
      agentId: extractAgentId(envelope.agent),
    },
  };
}

/**
 * 统一入口：自动判别入参是持久通道还是实时通道。
 *
 * 判别顺序有意为之：先试实时帧（形状更严），再试持久事件（要 `type` 判别符）。
 * 两者都不匹配 ⇒ `null`，绝不抛错 —— 事件流里绝大多数事件都不是思考源。
 *
 * @param {unknown} input
 * @returns {{text:string, meta:object}|null}
 */
export function extractReasoning(input) {
  return extractFromStreamFrame(input) ?? extractFromMessageEvent(input);
}

/** 尽力取出 turnId（字段名在不同 DSH 版本里可能不同，取不到就留 undefined） */
function extractTurnId(data) {
  if (!isObj(data)) return undefined;
  const candidates = [data.turn, data.turnId, data.stepId];
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  const turn = data.turn;
  if (isObj(turn)) {
    for (const k of ['id', 'turnId', 'index']) {
      const v = turn[k];
      if (typeof v === 'string' || typeof v === 'number') return v;
    }
  }
  return undefined;
}

/** 尽力取出 agentId */
function extractAgentId(agent) {
  if (!isObj(agent)) return undefined;
  for (const k of ['id', 'agentId', 'name']) {
    const v = agent[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}
