/**
 * `lib/app/thinking-pipeline.js` — 应用层（DESIGN §4.3 的【② 应用】）
 *
 * 职责：把领域层的纯逻辑串成 DESIGN §4.2 的那条流水线。
 *
 * ```
 *   ① 采集（由宿主 lib/index.js 订阅后喂进来）
 *      ↓
 *   ② 提取 reasoning      lib/core/thinking-extractor
 *   ③ 切分                lib/core/fragment-splitter
 *   ④ 打分（规则级）        lib/core/interest-scorer
 *   ⑤ 节流 / 去重 / 排队    lib/core/speech-planner
 *      ↓
 *   ⑦ 下发 speak 帧（onSpeak 回调，宿主经既有 SSE 通道广播）
 * ```
 *
 * ⛔ 本层**不直接碰网络 / DSH 内部接口**（那要经 `lib/infra/`），也不写切分打分逻辑
 *    （那是 `lib/core/` 的）。它只做编排 + 持有状态。
 * ⛔ **不内部读时钟**：`now` 由构造参数注入，于是整条流水线可以脱离环境单测。
 * ⛔ 不 import DSH API —— 宿主把"事件对象"喂进来，本模块只认**纯数据**。
 *
 * ── 两个通道怎么用（DESIGN §6.1）──────────────────────────────────────
 *
 * P0-1 已证：`session/event`（持久）与 `agent/assistant-stream`（实时）
 * 抽出的文本**逐字相同**（212/212）。所以这里的分工是：
 *
 *   - **持久通道 = 主来源**。文本完整、一次一条、可回放。
 *   - **实时通道 = 提前量**。模型还在吐字时就把已经拿到的部分攒起来，
 *     推理一结束就冲刷 —— 好处是宠物能**早一点**开口，不必等整条消息落库。
 *   - **去重靠内容哈希**：既然两条通道同文，谁先到谁处理，后到的按哈希丢掉。
 *     这样两个来源天然互斥，不需要依赖可能缺失的 turnId 字段。
 *
 * ⚠️ 空 `reasoning` 块 = 无思考（R-A）：`thinking-extractor` 会返回 null，
 *    本层拿到 null 就当没发生，**绝不**把它当成"一条空的话"排进队列。
 *
 * ── 红线 ────────────────────────────────────────────────────────────
 *
 *   R2 只读 reasoning：喂进来的文本已经过 extractor，正文/工具产出不会到这层。
 *   R3 零本地依赖：本层不合成、不发声，`audioUrl` 恒为 null（P3 才接 TTS）；
 *                 浏览器侧必须容忍 `audioUrl:null` —— 那就是"只显示气泡文字"的降级形态。
 *   R1 不竞争：本层无定时器、无轮询，只做同步计算；唯一的周期动作（`tick`）由宿主驱动。
 */

import { extractFromMessageEvent, extractFromStreamFrame, isMeaningfulReasoning }
  from '../core/thinking-extractor.js';
import { splitFragments } from '../core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, scoreSync } from '../core/interest-scorer.js';
import { createSpeechPlanner } from '../core/speech-planner.js';

/** 实时通道缓冲区上限：超了就冲刷，避免某条消息的推理边界事件缺失时越攒越大 */
export const DEFAULT_MAX_DELTA_BUFFER = 8_000;

/** 记住最近多少条处理过的思考（按内容哈希去重） */
export const DEFAULT_PROCESSED_WINDOW = 64;

/**
 * FNV-1a 字符串哈希（带长度后缀，减少碰撞误伤）。
 * 用它而不是 `node:crypto` 的理由：本模块要保持**零 Node 依赖**，才能在浏览器/测试里同样加载。
 * 用途只是"同一段文本别处理两次"，不是安全场景。
 */
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

/**
 * 从实时通道的 envelope 里取 agent 标识（取不到就用 `'default'` 桶）。
 * 只认纯数据字段，不 import 任何 DSH 类型。
 */
function agentKeyOf(envelope) {
  const agent = envelope?.agent;
  if (agent !== null && typeof agent === 'object') {
    for (const k of ['id', 'agentId', 'name']) {
      const v = agent[k];
      if (typeof v === 'string' && v !== '') return v;
    }
  }
  return 'default';
}

/**
 * 造一条流水线。
 *
 * @param {object} [options]
 * @param {() => number} [options.now]        注入时钟（默认 Date.now；测试里给固定值）
 * @param {(frame:object, meta:object) => void} [options.onSpeak]
 *        产出一条待下发指令时回调。frame 形状即 DESIGN §6.4 的 `speak` 帧。
 * @param {(entry:{level:string, event:string, detail:string}) => void} [options.onLog]
 *        留痕（R3：降级/跳过必须说出来，不得静默）。
 * @param {number} [options.scoreThreshold]   规则级阈值
 * @param {object} [options.planner]          传入自定义 planner（默认 20s 频率闸，D3）
 * @param {object} [options.limits]           切分参数
 * @param {number} [options.maxDeltaBuffer]   实时通道缓冲上限
 */
export function createThinkingPipeline(options = {}) {
  const now = options.now ?? (() => Date.now());
  const onSpeak = options.onSpeak ?? (() => {});
  const onLog = options.onLog ?? (() => {});
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_THRESHOLD;
  const planner = options.planner ?? createSpeechPlanner();
  const limits = options.limits;
  const maxDeltaBuffer = options.maxDeltaBuffer ?? DEFAULT_MAX_DELTA_BUFFER;

  const processed = new Set();
  const processedOrder = [];
  const stats = {
    inbound: 0, emptyReasoning: 0, duplicates: 0,
    fragments: 0, scored: 0, accepted: 0, spoken: 0,
  };

  /** 实时通道按 agent 累积；键用 agentId，缺省用一个公共桶 */
  const deltaBuffers = new Map();

  const markProcessed = (hash) => {
    processed.add(hash);
    processedOrder.push(hash);
    while (processedOrder.length > DEFAULT_PROCESSED_WINDOW) {
      processed.delete(processedOrder.shift());
    }
  };

  /**
   * 流水线主体：一段**已提取**的思考文本 → 可能产出若干条待播。
   *
   * @param {string} text 已提取的 reasoning 原文
   * @param {{turnId?:unknown, channel:string}} meta
   * @returns {{kind:string, fragments:number, accepted:number}}
   */
  function ingest(text, meta) {
    // R-A：空 reasoning 块 = 无思考。extractor 已经拦了一层，这里再守一道 ——
    // 实时通道是拼接出来的，边界上仍可能出现空串。
    if (!isMeaningfulReasoning(text)) {
      stats.emptyReasoning += 1;
      return { kind: 'empty', fragments: 0, accepted: 0 };
    }

    const hash = hashText(text);
    if (processed.has(hash)) {
      stats.duplicates += 1;
      // 两条通道同文是**预期行为**，所以这里记 debug 不记 warn，免得刷日志
      onLog({ level: 'debug', event: 'duplicate', detail: `channel=${meta.channel} turn=${String(meta.turnId ?? '?')}` });
      return { kind: 'duplicate', fragments: 0, accepted: 0 };
    }
    markProcessed(hash);

    const fragments = splitFragments(text, limits);
    stats.fragments += fragments.length;

    let accepted = 0;
    let passed = 0;
    // ⚠️ 追踪**全体片段**（含没过阈的）的最高分，不只是过阈的。
    //    否则「接上了但都没选中」和「压根没接上」在日志里长得一模一样 ——
    //    这个坑真踩过：657 字的真实思考被处理了，却因为没过阈而只留了条
    //    debug 日志（宿主又把它过滤掉），看起来像"订阅没生效"。
    let best = 0;
    for (const fragment of fragments) {
      // 规则级打分本身是同步的，这里直接用同步版；
      // 到 P4-4 换异步小模型时，ingest 需要整体改成 async（调用点也要 await）。
      const { score } = scoreSync(fragment.text);
      if (score > best) best = score;
      if (score < scoreThreshold) continue;
      passed += 1;
      stats.scored += 1;
      const res = planner.submit({ text: fragment.text, score }, now());
      if (res.accepted) {
        accepted += 1;
        stats.accepted += 1;
      }
    }

    // 一律用 info：一次思考只出一行，不会刷屏；但没有它就无法诊断（R3 留痕）。
    onLog({
      level: 'info',
      event: 'ingested',
      detail: `channel=${meta.channel} 片段=${fragments.length} 过阈=${passed}`
        + ` 入队=${accepted} 最高分=${best.toFixed(2)}/阈值${scoreThreshold}`,
    });

    return { kind: 'ok', fragments: fragments.length, accepted };
  }

  /**
   * 冲刷某个 agent 的实时缓冲（`key` 省略时冲刷全部）。
   *
   * ⚠️ 刻意写成**局部函数**而不是对象方法（并在返回的对象里转发）：
   * 若用 `this.flushDelta(...)`，调用方一旦写成 `const { onStreamFrame } = pipeline`
   * 就会因为 `this` 丢失去崩。这类"解构即坏"的 API 迟早会被踩到。
   */
  function flushDelta(key) {
    const keys = key === undefined ? [...deltaBuffers.keys()] : [key];
    let last = { kind: 'idle', fragments: 0, accepted: 0 };
    for (const k of keys) {
      const buf = deltaBuffers.get(k) ?? '';
      deltaBuffers.set(k, '');
      if (!isMeaningfulReasoning(buf)) continue;
      last = ingest(buf, { turnId: undefined, channel: 'realtime' });
    }
    return last;
  }

  return {
    /**
     * 持久通道入口：`ctx.on('session/event', (session, event) => …)` 的 `event`。
     * 只认 `type === 'assistant/message'`（判别符在 extractor 里把关）。
     */
    /** 从 envelope 里取 agent 标识。**不依赖是否成功提取** —— 见 `onStreamFrame` 的注释。 */
    // (局部函数，见下方 flushDelta 处对 this 的说明)

    onSessionEvent(event) {
      stats.inbound += 1;
      const extracted = extractFromMessageEvent(event);
      if (!extracted) {
        // 抽不出东西 = 本轮没有可读的思考（含"空 reasoning 块"与"压根没有 reasoning"）。
        // ⚠️ 这里也必须留痕：否则"模型这轮没思考"在日志上与"订阅没生效"无法区分。
        stats.emptyReasoning += 1;
        onLog({
          level: 'info',
          event: 'no-reasoning',
          detail: `channel=persistent eventType=${String(event?.type ?? '?')}`,
        });
        return { kind: 'empty', fragments: 0, accepted: 0 };
      }
      return ingest(extracted.text, { turnId: extracted.meta.turnId, channel: 'persistent' });
    },

    /**
     * 实时通道入口：`ctx.on('agent/assistant-stream', ({ agent, frame }) => …)` 的 envelope。
     *
     * 累积 `reasoning-delta`；收到**非 reasoning 增量**的 chunk（说明推理段结束）
     * 或缓冲超限时冲刷。冲刷后按内容哈希去重 —— 若持久通道已经处理过同文，这里自然丢掉。
     */
    onStreamFrame(envelope) {
      stats.inbound += 1;
      // ⚠️ agentId 必须**直接从 envelope 取**，不能从提取结果取：
      //    触发冲刷的那一帧（正文增量）本来就提取不到 reasoning，
      //    若用它推 agentId 会退化成 'default'，于是去冲一个空的桶，
      //    真正攒着内容的那个 agent 永远不会被冲刷 —— 这是实测踩到的 bug。
      const key = agentKeyOf(envelope);
      const extracted = extractFromStreamFrame(envelope);

      if (!extracted) {
        // 非思考增量 ⇒ 推理段结束，把攒下的冲刷掉
        return flushDelta(key);
      }
      // 空增量是合法的心跳帧，不推进也不丢弃
      if (extracted.text === '') return { kind: 'idle', fragments: 0, accepted: 0 };

      const buf = (deltaBuffers.get(key) ?? '') + extracted.text;
      if (buf.length >= maxDeltaBuffer) {
        deltaBuffers.set(key, '');
        return ingest(buf, { turnId: undefined, channel: 'realtime' });
      }
      deltaBuffers.set(key, buf);
      return { kind: 'buffered', fragments: 0, accepted: 0 };
    },

    /** 冲刷某个 agent 的实时缓冲（`key` 省略时冲刷全部）。 */
    flushDelta,

    /**
     * 由宿主周期性调用（例如每 2s）：到点就取一条该念的并下发。
     *
     * ⚠️ 节流节奏完全由 `lib/core/speech-planner` 的 20s 频率闸决定，
     * 这里**只是"来问一声"**——调多勤都不影响出句频率（这正是把闸放在领域层的好处）。
     *
     * @returns {object|null} 下发的帧，或 null
     */
    tick() {
      const task = planner.next(now());
      if (!task) return null;
      stats.spoken += 1;
      const frame = {
        type: 'speak',
        payload: {
          text: task.text,
          // P2 无声音：TTS 在 P3 才接。浏览器必须容忍 null —— 那就是"只显示气泡文字"。
          audioUrl: null,
          // 表情映射在 P4-3 才引入；在此之前恒为 null，浏览器同样必须容忍。
          emotion: null,
        },
      };
      onSpeak(frame, { score: task.score, at: task.at, source: 'thinking' });
      return frame;
    },

    /** 观测快照（诊断/日志用）。 */
    stats() {
      return { ...stats, ...planner.stats() };
    },

    /** 一键停（R5）：丢队列但保留"念过什么"的记忆。 */
    pause() {
      planner.clearQueue();
      deltaBuffers.clear();
    },

    /** 彻底停：连判重记忆一起清掉（换会话等场景）。 */
    reset() {
      planner.reset();
      deltaBuffers.clear();
      processed.clear();
      processedOrder.length = 0;
    },
  };
}
