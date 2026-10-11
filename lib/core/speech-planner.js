/**
 * `lib/core/speech-planner.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：**节流 / 去重 / 排队** —— 决定"这一条到底念不念、什么时候念"。
 *
 * ⛔ 纯逻辑：不 import 任何 Node 内置 I/O、DSH API、网络库、pixi。
 * ⛔ **绝不内部读时钟**。所有时间都从参数 `now` 进来 —— 否则单测只能靠 sleep，
 *    既慢又飘（这正是本项目"领域层要能脱离环境单测"的用途）。
 *
 * ── 它在七步流水线里的位置（DESIGN §4.2 第 ⑤ 步）─────────────────────
 *
 *   ④ 拟人化 ──▶ ⑤ **节流**（本模块）──▶ ⑥ 合成 ──▶ ⑦ 下发
 *
 * 前面 ①~④ 都在回答"哪条**值得**念"，本模块回答"**现在能不能**念"。
 * 两道闸都在这里（DESIGN §7.3 的四道闸里，另两道是负载闸/静音闸，属 P3）：
 *
 *   1. **频率闸**：任意 `minIntervalMs` 内最多放行 1 句。
 *      ⚠️ 默认 **20 秒**，由 **D3 定稿**（2026-10-11）—— 原设计默认 30 秒已作废。
 *   2. **去重闸**：同一段思考里模型经常反复念叨同一句；念过的不再念。
 *      判重分两级：归一化后**逐字相同**，以及 **bigram 相似度**超过阈值。
 *
 * 还有一条不那么起眼但很关键的规则：**队列溢出时丢最差的，不是丢最新的**
 * （见 `submit` 的注释）。
 */

/** 频率闸默认间隔：**20s**（D3 定稿，2026-10-11）。改这里必须同步 DESIGN §7.3 与 PLAN P2-5 */
export const SPEECH_INTERVAL_MS = 20_000;

/**
 * 用户可调的间隔区间（P4-5）。
 *
 * 为什么要有一对**边界常量**、而不是让设置页与宿主各写各的数字：那会立刻长出
 * 一个双口径缺陷 —— 滑杆允许拖到 5s、宿主却把它夹到 10s，用户看到"设了没用"
 * （本项目在"两边对不上却谁都不报错"上栽过多次）。
 *
 * ⚠️ 浏览器半区（`lib/client.js`）不能 import 本文件，那边**照抄了一份**同名常量；
 *    改这里必须同步那边（它带同样的注释指向这里）。
 */
export const SPEECH_INTERVAL_MIN_MS = 10_000;
export const SPEECH_INTERVAL_MAX_MS = 120_000;

/**
 * **哪些表情算"情绪"** —— 朗读调度的"情绪优先"用它（P4-5）。
 *
 * 为什么不能只看 `emotion !== null`：`emotion` 字段对**所有**桶都有值，但其中
 * 「问号」「感叹号」来自**自我怀疑**桶（`其实` / `实际上` 这类"修正型推理"）、
 * 「呆呆眼」来自**犹豫权衡** —— 它们**演得出表情，内容却是在推理**。
 * 实测全量放行 29681 条：问号 **42.7%** + 感叹号 **22.7%** = **65.4% 来自同一个桶**，
 * 而真正情绪化的三个桶（吐槽 / 情绪外露 / 手滑·坦白）**合计只有 9.6%**。
 * 用户听完 20 条的原话正是：「**语气和情绪都到位，但文本内容不是情绪化的**」。
 *
 * ⇒ 判"是不是情绪"要按**桶的语义**筛，不能按字段有没有值。
 *    本表 = `line-polisher` 的 `BUCKET_EXPRESSION` 里**情绪桶**的规范表情：
 *    `情绪外露` → 调皮 / 吐舌 · `手滑·坦白` → 流汗 · `吐槽` → 生气 · `顿悟` → 星星眼。
 *
 * ⚠️ **「感叹号」不在表里**：它是 `其实` / `实际上` 被逐词纠偏后的产物，源头仍是自我怀疑桶。
 */
export const EMOTIONAL_KEYS = Object.freeze(['调皮', '吐舌', '流汗', '生气', '星星眼']);

/**
 * 情绪片段在**同一次出句机会**里的加权（P4-5）。
 *
 * 为什么用**加权**而不是"情绪一律优先"：后者会让 0.51 分的情绪句压过 0.95 分的
 * 非情绪句 —— 读下来反而更差（那句更"有戏"，只是恰好不情绪化）。加权之后
 * "分数明显更高的非情绪句"仍然会赢，这符合"值得念"的本意。
 *
 * 0.2 的依据：过阈线 0.50，而实测各桶的分数**分布重叠很大**（多在 0.5~0.7），
 * 0.2 足以让"同为 0.6 分时情绪句胜出"，又不至于颠覆明显更高的分。
 */
export const EMOTION_BONUS = 0.2;

/** 这条的表情是不是"情绪"（见 `EMOTIONAL_KEYS`）。 */
export function isEmotional(emotion) {
  return typeof emotion === 'string' && EMOTIONAL_KEYS.includes(emotion);
}

/** 默认队列上限：待播最多 3 条，再多就按分数淘汰 */
export const DEFAULT_MAX_QUEUE = 3;

/** 默认判重记忆条数（记住最近念过的 N 条） */
export const DEFAULT_DEDUPE_WINDOW = 20;

/** 默认相似度阈值：≥ 此值视为重复 */
export const DEFAULT_SIMILARITY = 0.85;

/**
 * 判重的最短长度：低于此长度不做"包含"判定。
 *
 * 为什么需要"包含"这条额外规则：bigram Jaccard 对"原句 + 尾巴多几个字"不够敏感 ——
 * 实测 `这个参数顺序好像不太对，我再确认一下。` 与 `…我再确认一下试试。` 只差 2 个字，
 * Jaccard 却是 **0.889**，卡在 0.9 阈值下**漏判**。这类"前面一模一样、后面多一截"
 * 正是模型复读的典型形态，必须挡住。所以：归一化后一方包含另一方（且够长）即算重复。
 */
export const DEDUPE_MIN_CONTAINMENT = 8;

/**
 * 归一化用于判重：去掉空白与标点、统一小写。
 * 目的不是"语义归一"，而是让"带句号的"和"不带句号的"、"有空格"和"没空格"视为同一句。
 */
export function normalizeForDedupe(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：？！（）【】“”‘’《》…—·,.;:?!()[\]"'`~]/g, '');
}

/** 字符 bigram 集合；长度不足 2 时退化为单字集合 */
function bigrams(s) {
  if (s.length <= 1) return new Set(s === '' ? [] : [s]);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * bigram Jaccard 相似度（0..1）。选它的理由：无需依赖，且对"只差几个字"的
 * 重复句足够敏感 —— 判重只需要挡住明显重复，不需要语义理解。
 */
export function similarity(a, b) {
  const na = normalizeForDedupe(a);
  const nb = normalizeForDedupe(b);
  if (na === '' && nb === '') return 1;
  if (na === nb) return 1;
  if (na === '' || nb === '') return 0;

  const sa = bigrams(na);
  const sb = bigrams(nb);
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 判定两段文本是否"算同一句"。规则见 `DEDUPE_MIN_CONTAINMENT` 的注释。
 * @returns {boolean}
 */
export function isNearDuplicate(a, b, threshold = DEFAULT_SIMILARITY) {
  const na = normalizeForDedupe(a);
  const nb = normalizeForDedupe(b);
  if (na === '' || nb === '') return na === nb;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= DEDUPE_MIN_CONTAINMENT && long.includes(short)) return true;
  return similarity(na, nb) >= threshold;
}

/**
 * 造一个朗读调度器。
 *
 * @param {object} [options]
 * @param {number} [options.minIntervalMs]   频率闸间隔，默认 20000（D3）
 * @param {number} [options.maxQueue]        待播队列上限
 * @param {number} [options.dedupeWindow]    判重记忆条数
 * @param {number} [options.similarityThreshold] 判重相似度阈值（0~1）
 * @param {number} [options.emotionBonus]   情绪加权（P4-5）；传 `0` = 关掉情绪优先（对照用）
 */
export function createSpeechPlanner(options = {}) {
  let minIntervalMs = options.minIntervalMs ?? SPEECH_INTERVAL_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const dedupeWindow = options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW;
  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY;
  const emotionBonus = options.emotionBonus ?? EMOTION_BONUS;

  /**
   * 一条待播项的**调度优先级**：分数 + 情绪加权（P4-5）。
   *
   * ⚠️ 入队淘汰（`submit`）与出句选择（`next`）**必须用同一个函数** —— 一个按分数、
   * 一个按加权，就长出"淘汰时按分数、出句时按加权"的双口径（本项目最警惕的那类缺陷）。
   * 单测里有一条专门守这个（"入队淘汰用同一把尺子"）。
   *
   * 放在闭包里而不是模块级，是为了让 `emotionBonus` 可配 —— 关掉它（传 0）就是
   * 改动前的行为，对照实验与被引脚本都靠这个开关。
   */
  const rankOf = (item) => (Number.isFinite(item?.score) ? item.score : 0)
    + (isEmotional(item?.emotion) ? emotionBonus : 0);

  /** @type {{text:string, score:number, at:number, emotion:string|null}[]} 待播队列（按插入顺序） */
  const queue = [];
  /** @type {string[]} 已念过的文本（判重记忆，只留最近 dedupeWindow 条） */
  const spoken = [];
  let lastSpokenAt = Number.NEGATIVE_INFINITY;
  let dropped = 0;

  const isDuplicate = (text) => {
    for (const prev of spoken) if (isNearDuplicate(prev, text, similarityThreshold)) return '已念过';
    for (const item of queue) if (isNearDuplicate(item.text, text, similarityThreshold)) return '已在队列里';
    return null;
  };

  return {
    /**
     * 投递一条候选。
     *
     * ⚠️ **队列溢出时丢最差的，而不是丢最新的**。
     *    直觉写法（满了就丢弃新来的）有个隐蔽后果：模型在"绕路解释"阶段
     *    往往先吐平淡句、后吐真正有意思的那句 —— 丢最新的等于专挑好句丢。
     *    所以这里改成：新条目分数更高就挤掉队列里最低分的，否则拒绝新条目。
     *
     * @param {{text:string, score?:number, emotion?:string|null}} candidate
     *        ⚠️ `emotion`（P4-2 起）是**模型表情 key**，来自 `line-polisher`。
     *           本模块**只负责原样带过队列、不解读也不校验** —— 闸门的职责是
     *           "什么时候念"，不是"该演什么"。校验由产出方（领域层）与消费方
     *           （P4-3 的浏览器侧）各自负责，中间层不插手。
     * @param {number} now
     * @returns {{accepted:boolean, reason:string, position?:number}}
     */
    submit(candidate, now) {
      const text = candidate?.text;
      if (typeof text !== 'string' || text.trim() === '') {
        return { accepted: false, reason: '空文本' };
      }
      const score = Number.isFinite(candidate?.score) ? candidate.score : 0;
      const emotion = typeof candidate?.emotion === 'string' && candidate.emotion !== ''
        ? candidate.emotion
        : null;

      const dup = isDuplicate(text);
      if (dup) return { accepted: false, reason: dup };

      if (queue.length >= maxQueue) {
        // 找一个**优先级**比新条目低的待播项淘汰。
        // ⚠️ 用 `rankOf`（含情绪加权）而不是裸 `score` —— 与 `next()` 同一把尺子，
        //    否则会长出"淘汰按分数、出句按加权"的双口径。
        let worstIdx = -1;
        for (let i = 0; i < queue.length; i++) {
          if (worstIdx === -1 || rankOf(queue[i]) < rankOf(queue[worstIdx])) worstIdx = i;
        }
        if (rankOf(queue[worstIdx]) >= rankOf({ score, emotion })) {
          dropped += 1;
          return { accepted: false, reason: '队列已满且本条优先级不更高' };
        }
        queue.splice(worstIdx, 1);
        dropped += 1;
      }

      queue.push({ text, score, at: now, emotion });
      return { accepted: true, reason: '已入队', position: queue.length };
    },

    /**
     * 取一条该念的。**放不放出完全由 `now` 决定** —— 同一组输入同一串 now，结果必一致。
     *
     * 队列里有多条时取**优先级最高**的（= 分数 + 情绪加权，见 `rankOf`；同优先级取更早的）。
     * 这样在 20s 的频率闸下，先念的是这段时间里**又情绪化、又值得念**的那句（P4-5）。
     *
     * @param {number} now
     * @returns {{text:string, score:number, at:number, emotion:string|null}|null}
     */
    next(now) {
      if (queue.length === 0) return null;
      if (now - lastSpokenAt < minIntervalMs) return null;

      // **情绪优先**（P4-5）：同一次出句机会里先挑"有情绪可演"的那句 —— 但用**加权**
      // 而非"情绪一律优先"，所以分数明显更高的非情绪句仍然会赢（那是对的：它更"有戏"）。
      let bestIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (rankOf(queue[i]) > rankOf(queue[bestIdx])) bestIdx = i;
      }
      const [task] = queue.splice(bestIdx, 1);

      lastSpokenAt = now;
      spoken.push(task.text);
      if (spoken.length > dedupeWindow) spoken.splice(0, spoken.length - dedupeWindow);
      return task;
    },

    /** 距离下一次可放行还差多少毫秒（0 = 现在就能放）。 */
    cooldownRemaining(now) {
      if (!Number.isFinite(lastSpokenAt)) return 0;
      return Math.max(0, minIntervalMs - (now - lastSpokenAt));
    },

    /** 还要等多少毫秒才可能念到**某一条**（队列空则 null）。用于给界面做提示。 */
    etaForNext(now) {
      if (queue.length === 0) return null;
      return this.cooldownRemaining(now);
    },

    /** 清空队列与判重记忆（用户一键停 R5 / 换会话时用）。 */
    reset() {
      queue.length = 0;
      spoken.length = 0;
      lastSpokenAt = Number.NEGATIVE_INFINITY;
      dropped = 0;
    },

    /** 只清队列，保留"念过什么"的记忆（暂停后恢复不希望重复念）。 */
    clearQueue() {
      queue.length = 0;
    },

    /**
     * **无损换档**：改频率闸间隔，队列与判重记忆原样留着（P4-5）。
     *
     * 为什么需要它、而不是"改设置就重建 planner"：planner 持有**待播队列**与
     * **"念过什么"的记忆**。拖一下滑杆就重建 = 队列被清空、刚念过的句子会被再念一遍 ——
     * 表现是"调个节奏把宠物弄结巴了"。这里只换一个数，别的什么都不动。
     *
     * ⚠️ 换档**只改这一个数**，`lastSpokenAt` 不动，于是语义正好是用户拖滑杆时期望的：
     *    调大 ⇒ 下一句要等更久；调小 ⇒ 若距上次朗读已超过新间隔，下一句**立刻**可放。
     *    （队列长度仍由 `maxQueue` 兜着，换档不会让它变大、也不会炸出一串。）
     *
     * @param {number} ms 新的间隔（毫秒）；非正数/非有限值一律忽略
     * @returns {boolean} 是否真的变了 —— 没变返回 false，调用方据此决定要不要留痕
     */
    setMinInterval(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return false;
      const next = Math.round(ms);
      if (next === minIntervalMs) return false;
      minIntervalMs = next;
      return true;
    },

    /** 观测用快照（不参与调度决策）。 */
    stats() {
      return {
        pending: queue.length,
        spoken: spoken.length,
        dropped,
        lastSpokenAt: Number.isFinite(lastSpokenAt) ? lastSpokenAt : null,
      };
    },
  };
}
