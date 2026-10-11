/**
 * `lib/core/fragment-splitter.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：把一条长思考切成**语义完整、适合朗读**的小片段。
 *
 * ⛔ 纯逻辑：不 import 任何 Node 内置 I/O、DSH API、网络库、pixi。入参出参都是纯数据。
 *
 * ── 为什么切分是刚需（不是可选优化）──────────────────────────────────────
 *
 * 对 **212 条真实思考**统计（`p0/replay-extractor-*` 那批语料）：
 *
 *   | 指标           | p50        | p75       | p90       | max        |
 *   |---------------|------------|-----------|-----------|------------|
 *   | 整条思考长度     | 1290 (58s) | 2472 (111s) | 4247 (191s) | 14994 (675s) |
 *   | 单句长度        | 48 (2.2s)  | 96 (4.3s) | 174 (7.8s) | 582 (26.2s) |
 *   | 段落长度        | 63 (2.8s)  | 143 (6.4s)| 256 (11.5s)| 1053 (47s)  |
 *
 *   （秒数按实测 TTS 吞吐 **22.2 字/秒** 折算；平均每条思考 25.1 句 / 17.4 段）
 *
 * 一条中位思考按朗读速度要念 **近一分钟** —— 不切分根本没法用。
 *
 * ── 在真实语料上的实际效果（212 条，用本模块实测）──────────────────────
 *
 *   | 指标                  | 结果                                   |
 *   |----------------------|----------------------------------------|
 *   | 片段总数 / 平均每条     | 4714 / 22.2 个                          |
 *   | 片段长度 p50/p90/max   | 84 (3.8s) / 134 (6.0s) / 180 (8.1s)    |
 *   | 超过硬上限的片段        | **0**                                  |
 *   | 「不丢字」失败的思考条数 | **0**                                  |
 *
 * ── 参数怎么来的（不是拍脑袋）────────────────────────────────────────
 *
 *   目标"一句" ≈ 3~8 秒（一口气念得完、不打断思路）⇒ **66~178 字**。
 *   - `softChars = 110`（≈5.0s）：贪心打包的目标长度。实测在此阈值下
 *     片段长度 p50=97 / 平均 16.3 个片段每条思考。
 *   - `maxChars = 180`（≈8.1s）：**硬上限**。实测句子 p90=174，
 *     取 180 时只有 **9.2%** 的句子超限（这些才需要再切）。
 *   - `minChars = 8`：低于此的片段"没有信息"，不单独产出（并入相邻片段）。
 *     注意是**并入而不是丢弃** —— 完整性由 §「不丢字」的不变量保证。
 *
 * ── 两条设计取舍 ────────────────────────────────────────────────────
 *
 *   ⚠️ **空行分隔的段落是强语义边界**：实测平均每段（按行算）只有 1.44 句、行长
 *      p50=63 字，说明思考里大量用换行分条。因此**空行处一律断开**；单换行只是
 *      断句点，仍可打包到 `softChars` 附近（否则会退化成一堆 2~3 秒的碎句）。
 *      唯一例外：当前片段凑不满 `minChars` 时允许跨段合并，避免产出"没有信息"的碎片。
 *   ⚠️ **不做内容过滤**（代码块、路径、纯符号都照切）。那是 `interest-scorer`
 *      的职责 —— 切分只保证"句子完整"，不判断"值不值得念"。
 */

/** 实测 TTS 吞吐（字/秒），来自 p0/P0-REPORT.md 与 docs/RESOURCE-BUDGET.md §4 */
export const SPEECH_CHARS_PER_SEC = 22.2;

/** 切分参数默认值 —— 依据见文件头注释（真实语料校准，不是拍脑袋） */
export const FRAGMENT_LIMITS = Object.freeze({
  /** 贪心打包目标长度（≈5.0s） */
  softChars: 110,
  /** 硬上限，任何片段都不得超过（≈8.1s） */
  maxChars: 180,
  /** 低于此长度的片段没有信息价值，不单独产出（并入相邻） */
  minChars: 8,
});

/**
 * 硬切：把超长串按 `maxChars` 切开，且**不从代理对中间切**。
 *
 * ⚠️ 切片步长必须用 `String.length`（UTF-16 码元）—— 因为 `maxChars` 是拿
 * `text.length` 量的。若按**码点**切，含 emoji 的片段会算出 180 码点却占
 * 360 码元，硬上限就名存实亡了。代价是 emoji 按 2 个字符计（偏保守，无妨）。
 *
 * @param {string} s
 * @param {number} maxChars
 * @returns {string[]}
 */
function hardCut(s, maxChars) {
  if (s.length <= maxChars) return [s];

  // ⚠️ 先算块数再均分，而不是"每 maxChars 切一刀"。
  //    后者的问题是**尾巴可能只剩一两个字**：对真实语料实测，那种 1~2 字的尾巴
  //    真的出现了 18 次（`"r"` / `"ge"` / `"nly."`…几乎全是被切断的英文/代码残渣）。
  //    均分后每块长度 = ceil(L / 块数) ≤ maxChars，尾巴问题从根上消失。
  const chunks = Math.ceil(s.length / maxChars);
  const size = Math.ceil(s.length / chunks);

  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    const last = s.charCodeAt(end - 1);
    // end-1 落在高代理位上：退一格，宁可短一个字也不切坏字符
    if (last >= 0xd800 && last <= 0xdbff && end < s.length) end -= 1;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * 把过短的片段并进相邻片段（优先并入前一个）。
 *
 * 判定用「当前或前一个过短」双向条件 —— 只判当前的话，落在**队首**的短片段
 * 会因为没有前邻居而原样留下。
 *
 * ⚠️ 并入的前提是**不突破 maxChars**。若两侧都到顶了，就只好保留这个短片 ——
 * 硬上限的优先级高于"美观"。这类残片由下游 §7.3 的长度闸丢弃。
 */
function mergeShortFragments(list, { minChars, maxChars }) {
  const out = [];
  for (const p of list) {
    const prev = out[out.length - 1];
    const eitherShort = p.length < minChars || (prev !== undefined && prev.length < minChars);
    if (prev !== undefined && eitherShort && prev.length + p.length <= maxChars) {
      out[out.length - 1] = prev + p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * 把字符数折算成朗读毫秒数（用于下游做时长闸/排队）。
 * @param {number} charCount
 * @returns {number}
 */
export function estimateSpeechMs(charCount) {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.round((charCount / SPEECH_CHARS_PER_SEC) * 1000);
}

/**
 * 归一化思考文本：统一换行、折叠多余空行、去掉首尾空白。
 * 只动空白，不动任何实义字符 —— 这是「不丢字」不变量的前提。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    // 行首行尾的水平空白：朗读用不上（缩进/对齐），去掉可避免"读出一串空格"
    .replace(/^[ \t\u00a0]+|[ \t\u00a0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')       // 3 个以上换行折叠成 2 个（保留"段落"语义）
    .trim();
}

// 句末标点（中英）+ 省略号。切分后标点**归属前句**。
const SENT_END = /([。！？!?；;]+|…{2,}|\.{3,})/;
// 次级标点：句子太长时退而求其次的断点
const SUB_END = /([，,、：:）)】」』]+)/;

/**
 * 切成"语义单元"（句子）。保证每个单元 ≤ maxChars。
 * 超长单元的降级顺序：先按次级标点切 → 再按码点硬切。
 *
 * @param {string} block
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitIntoUnits(block, maxChars) {
  const units = [];
  for (const piece of block.split(SENT_END)) {
    if (piece === undefined || piece === '') continue;
    // 单独出现的标点：补到上一个单元尾巴上（标点归前句）
    if (SENT_END.test(piece) && piece.length <= 3 && units.length) {
      units[units.length - 1] += piece;
      continue;
    }
    units.push(...breakLong(piece, maxChars));
  }
  return units.filter((u) => u.trim() !== '');
}

/** 把单个超长单元降到 maxChars 以内 */
function breakLong(unit, maxChars) {
  if (unit.length <= maxChars) return [unit];
  const out = [];
  for (const part of unit.split(SUB_END)) {
    if (part === '') continue;
    if (part.length <= maxChars) { out.push(part); continue; }
    // 连次级标点都没有：只能硬切（宁可切粗，也不能超上限）
    out.push(...hardCut(part, maxChars));
  }
  // 次级标点切完后把尾标点粘回前块，并做一次合并，避免产生一堆碎块
  const merged = [];
  for (const p of out) {
    if (merged.length && SUB_END.test(p) === false && p.length < 6) {
      merged[merged.length - 1] += p;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/**
 * 把一条长思考切成片段。
 *
 * 不变量（有单测守着）：
 *   ① 每个片段 `≤ maxChars`
 *   ② **不丢字**：所有片段拼起来、去掉空白后 == 归一化原文去掉空白
 *   ③ 不切碎句子：优先在句末标点处断开（长句才退到次级标点）
 *
 * @param {unknown} text
 * @param {{softChars?:number, maxChars?:number, minChars?:number}} [options]
 * @returns {{index:number, text:string, charCount:number, estMs:number}[]}
 */
export function splitFragments(text, options = {}) {
  const { softChars, maxChars, minChars } = { ...FRAGMENT_LIMITS, ...options };
  const normalized = normalizeText(text);
  if (normalized === '') return [];

  // ① 按空行分块（块 = 段落，强边界）→ 块内按行 → 行内按句
  const blocks = normalized.split(/\n{2,}/);
  const units = [];
  blocks.forEach((block, blockId) => {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      for (const unit of splitIntoUnits(trimmed, maxChars)) units.push({ text: unit, blockId });
    }
  });

  // ② 贪心打包到 softChars 附近；**不跨段落**（除非当前片段凑不满 minChars）
  const packed = [];
  let cur = '';
  let curBlock = -1;
  for (const { text: unit, blockId } of units) {
    if (cur === '') { cur = unit; curBlock = blockId; continue; }
    const fitsSoftWithinBlock = blockId === curBlock && cur.length + unit.length <= softChars;
    // 凑不满 minChars 时允许跨段补齐，但**不得因此突破 maxChars**
    // （超标会落到 ④ 硬切，那才是真的切碎句子 —— 能避就避）
    const fillsMin = cur.length < minChars && cur.length + unit.length <= maxChars;
    if (fitsSoftWithinBlock || fillsMin) { cur += unit; continue; }
    packed.push(cur);
    cur = unit;
    curBlock = blockId;
  }
  if (cur !== '') packed.push(cur);

  // ③ 收尾修形：过短片段并入相邻（不丢弃 —— 完整性由「不丢字」不变量守着）
  const shaped = mergeShortFragments(packed, { minChars, maxChars });

  // ④ 兜底：做完合并后仍超上限的，硬拆（正常路径不该走到这里）
  const final = [];
  for (const p of shaped) {
    if (p.length <= maxChars) { final.push(p); continue; }
    final.push(...hardCut(p, maxChars));
  }

  return final
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t, index) => ({
      index,
      text: t,
      charCount: t.length,
      estMs: estimateSpeechMs(t.length),
    }));
}
