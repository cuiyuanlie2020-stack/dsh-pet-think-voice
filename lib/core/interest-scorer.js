/**
 * `lib/core/interest-scorer.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：判定一个片段"有多值得念出来"。**只有规则级（第 1 级）**。
 *
 * ⛔ 纯逻辑：不 import 任何 Node 内置 I/O、DSH API、网络库、pixi。
 *
 * ── 两级策略里的位置（DESIGN §5.1）────────────────────────────────────
 *
 *   第 1 级 规则 + 触发词表   ← **本模块**。0 显存 / 0 模型调用，目标降噪 ~90%
 *   第 2 级 本地小模型打分      P4-4，可选、默认关（红线 R3）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 本模块实测推翻了 DESIGN §5.1 的两条前提，必须知道再改代码
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【发现 1】思考正文**主要是英文**，不是中文。
 *     对 212 条真实思考实测：ASCII 字母占 **67.3%**，中文字符只占 **5.2%**。
 *     按条判定：**英文主导 76%**（162 条）、中文主导仅 **7%**（14 条）。
 *     ⇒ DESIGN §5.1 那份**纯中文**词表（`原来` / `懂了` / `哎` / `绕了一大圈`…）
 *       在真实数据上触发 **0 次** —— 不是词选得不好，是**语种选错了**。
 *     ⇒ 影响面超出本模块：**P3 的 TTS 音色 `zh-CN-XiaoyiNeural` 念英文会非常怪**
 *       （已登记 **D10**，P3 开工前必须拍）。
 *
 * 【发现 2】这个模型的思考是**"临床式"**的，情绪标记极其稀薄。
 *     对 4714 个片段统计各桶**实际命中数**：
 *       自我怀疑 539 (11.4%) · 犹豫权衡 216 (4.6%) · 顿悟 **31 (0.7%)** · 吐槽 **3 (0.06%)**
 *     其中英文侧 `actually` 241 / `hmm` 208 / `maybe` 173 / `wait` 84 次，
 *     而 `ugh` / `tricky` / `messy` 之类"吐槽"词几乎为 0；中文侧除 `等等`(11) / `还是`(8)
 *     外**全部为 0**。
 *     ⇒ 靠"情绪词"筛选，**可念的素材天然稀薄**，且几乎全压在"自我修正"一类。
 *     ⇒ 这正是 DESIGN §9.2 **D2** 要解决的事（原定 P4-1 人工判定校准）。
 *       本模块的词表是**第一版证据版**，不是终稿；命中率与词频数据见模块底部。
 *
 *    所以本实现的取舍是：**词表双语 + 只看四类可观测行为**，
 *    并大幅放宽噪声惩罚 —— 宁可放到 P2-5 的频率闸去挡，也不在这里误杀主体。
 *    （前一版曾把"中文占比低"当噪声扣分，实测会误杀 **84%** 的片段，已删除该规则。）
 *    ⚠️ 若"素材稀薄"最终被判定为不可接受，需要动的是**产品口径**而不是调权重：
 *       可选方向有 ① 改看结构信号（自我修正叙述、结论性断言）
 *       ② 承认戏份少、把频率闸放宽 ③ 启用 P4-4 的小模型打分（违背 R3 的默认路径）。
 *       这是设计决策，已登记待决，**不要在实现里偷偷放宽阈值来凑数量**。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 规则级默认阈值。
 *
 * 校准依据：在 212 条真实思考切出的 **4714 个片段**上跑分，取使通过率落在
 * DESIGN §5.1「降噪 ~90%」量级、且**单个真实信号仍能过闸**的档位（详见模块底部）。
 */
export const DEFAULT_THRESHOLD = 0.5;

/**
 * 四类可观测的"有戏"行为，**双语**。
 *
 * 权重按"这类信号有多像人类会想听的反应"给，不按词频给 ——
 * 词频只用来**验证这个词真的存在**（上一版就是因为没验证才全 0）。
 * ⚠️ 词表独立导出：D2 校准时只改数据，不动逻辑。
 */
export const TRIGGER_LEXICON = Object.freeze({
  自我怀疑: {
    weight: 0.28,
    words: [
      // 英文（实测高频：actually 241 / hmm 208 / wait 84）
      'actually', 'wait', 'hold on', 'hmm', 'wrong', 'reconsider', 'mistake', 'incorrect', 'scratch that',
      // 中文
      '等等', '不对', '我搞错', '搞错', '反了', '弄错', '看错',
    ],
  },
  顿悟: {
    weight: 0.3,
    words: [
      'interesting', 'i see', 'got it', 'makes sense', "that's the issue", 'turns out', 'found it', 'understand',
      '原来', '懂了', '想通', '明白了', '知道了', '恍然大悟',
    ],
  },
  吐槽: {
    weight: 0.3,
    words: [
      'tricky', 'messy', 'weird', 'strange', 'ugly', 'annoying', 'frustrating', 'ugh', 'awkward',
      '哎', '绕了一大圈', '白折腾', '这坑', '无语', '离谱', '居然', '竟然',
    ],
  },
  犹豫权衡: {
    weight: 0.15,
    words: [
      'maybe', 'perhaps', 'alternatively', 'either', 'not sure', 'unsure', 'trade-off',
      '还是', '要不', '要么', '权衡', '纠结', '嗯……', '嗯...',
    ],
  },
});

// ── 噪声特征（降噪用；命中即扣分）────────────────────────────────────────
// 判据是"这段**念出来**有没有意义"，不是"这段技术上是否重要"。

/** 代码/符号密度：反引号、箭头、比较运算、大括号、行尾分号、注释、列表符号 */
const CODE_SIGNAL = /```|`[^`\n]*`|=>|===|!==|\bfunction\b|\bconst\b|\breturn\b|[{}\[\]]|;\s*(?:\n|$)|\/\/|^\s*[-*+•]\s|\bhref\b/i;
/** 路径/文件名/扩展名 */
const PATH_SIGNAL = /(?:[A-Za-z]:\\|(?:\.{1,2}\/|\/)[\w.-]+\/|\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|json|ya?ml|md|sh|exe|png|jpg|jpeg|svg|css|html)\b)/i;
/** Markdown 表格 / 分隔线：朗读出来是一串横杠竖线 */
const TABLE_SIGNAL = /^\s*\||\|\s*$|-{3,}\|/m;
/** 中文字符 */
const CJK = /[\u4e00-\u9fff]/g;

const countMatches = (text, re) => (text.match(re) ?? []).length;

/**
 * 归一化入参：契约写的是 `score(fragment: string)`（DESIGN §6.2），
 * 但流水线里传进来的可能是片段对象，这里**容忍** `{text}` 形态，省得每个调用点都写 `.text`。
 */
function toText(fragment) {
  if (typeof fragment === 'string') return fragment;
  if (fragment !== null && typeof fragment === 'object' && typeof fragment.text === 'string') {
    return fragment.text;
  }
  return '';
}

/** 拉丁词用词边界匹配，避免 `wait` 命中 `await`；CJK 用子串匹配 */
function hitsWord(text, word) {
  if (/^[a-z][a-z'\- ]*$/i.test(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  }
  return text.includes(word);
}

/**
 * 判定片段的主要书写系统。用于**报告与调试**，不参与打分方向
 * —— ⚠️ 绝不因为"不是中文"而扣分（实测那会误杀 84%）。
 */
export function detectScript(fragment) {
  const text = toText(fragment);
  if (text.trim() === '') return 'empty';
  const cjk = countMatches(text, CJK) / text.length;
  const latin = countMatches(text, /[A-Za-z]/g) / text.length;
  if (CODE_SIGNAL.test(text) || TABLE_SIGNAL.test(text)) return 'code';
  if (cjk >= 0.3) return 'zh';
  if (latin >= 0.3) return 'en';
  return 'mixed';
}

/**
 * 打分（纯同步实现）。
 *
 * 模型：从**很低**的基线出发，靠"有戏"信号加分、靠"噪声"信号扣分，最后夹到 0..1。
 * 基线故意压低（0.12 < 阈值）—— 光有基线过不了闸，必须真的命中证据。
 * 这就是"降噪 ~90%"的实现方式。
 *
 * @returns {{score:number, reason:string, hits:object[], noise:string[], script:string}}
 */
export function scoreSync(fragment) {
  const text = toText(fragment);
  const hits = [];
  const noise = [];
  const script = detectScript(text);

  if (text.trim() === '') {
    return { score: 0, reason: '空片段', hits, noise: ['空片段'], script: 'empty' };
  }

  let score = 0.18;

  // ① 行为信号命中（同一类多次出现只计一次 —— 否则"maybe…maybe…maybe"能刷分）
  const matched = [];
  for (const [name, { weight, words }] of Object.entries(TRIGGER_LEXICON)) {
    const found = words.filter((w) => hitsWord(text, w));
    if (found.length === 0) continue;
    matched.push(name);
    score += weight;
    hits.push({ rule: `信号·${name}`, delta: weight });
    noise.push(`命中「${found.slice(0, 3).join('/')}」`);
  }
  // 两类以上叠加（例如"自我修正 + 顿悟"）通常最好听
  if (matched.length >= 2) {
    score += 0.12;
    hits.push({ rule: '多类信号叠加', delta: 0.12 });
  }

  // ② 结构信号
  if (/[？！?]/.test(text)) {
    score += 0.06;
    hits.push({ rule: '带疑问/感叹', delta: 0.06 });
  }
  // 窗口与 fragment-splitter 对齐（那边 minChars=8 / maxChars=180）。
  // 下界取 12 而不是 20：19 字的"哎，绕了一大圈才找到"完全念得出口，
  // 曾经用 20 会让这类典型短句差 0.02 卡在阈值下 —— 阈值附近越少武断参数越好。
  const len = text.length;
  if (len >= 12 && len <= 170) {
    score += 0.05;
    hits.push({ rule: '长度适合朗读(12~170字)', delta: 0.05 });
  }
  if (/\bI\b|我/.test(text)) {
    score += 0.03;
    hits.push({ rule: '第一人称', delta: 0.03 });
  }

  // ③ 降噪（扣分）
  const cjk = countMatches(text, CJK);
  const latin = countMatches(text, /[A-Za-z]/g);
  const lettersRatio = (cjk + latin) / len;
  const symbolRatio = countMatches(
    text, /[^\u4e00-\u9fffA-Za-z0-9\s，。、；：？！（）【】“”‘’《》…—·]/g,
  ) / len;

  if (script === 'code' || CODE_SIGNAL.test(text)) {
    score -= 0.3;
    noise.push('含代码/符号特征');
  }
  if (TABLE_SIGNAL.test(text)) {
    score -= 0.15;
    noise.push('含表格/分隔线');
  }
  if (PATH_SIGNAL.test(text)) {
    score -= 0.2;
    noise.push('含路径/文件名');
  }
  // ⚠️ 曾经这里有一条"中文占比 <15% 就扣分"—— 实测会误杀 **84%** 的片段
  //   （因为思考主体本来就是英文）。改为只看"有没有成字的语言内容"。
  if (lettersRatio < 0.35) {
    score -= 0.3;
    noise.push(`字母/汉字占比过低(${lettersRatio.toFixed(2)})`);
  }
  if (symbolRatio > 0.25) {
    score -= 0.15;
    noise.push(`符号占比过高(${symbolRatio.toFixed(2)})`);
  }
  if (len < 8) {
    score -= 0.3;
    noise.push('太短(无信息)');
  }

  const rounded = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
  const reason = hits.length
    ? `${hits.map((h) => h.rule).join(' + ')}${noise.length ? `；${noise.join('；')}` : ''}`
    : (noise.length ? noise.join('；') : '无特征');

  return { score: rounded, reason, hits, noise, script };
}

/**
 * 打分（契约形态，DESIGN §6.2）。
 *
 * 之所以是 `Promise`：接口要预留 P4-4 换成本地小模型（那必然异步）。
 * 规则级实现本身是同步的，这里只是套一层 —— 将来换实现不必改调用点。
 *
 * @param {unknown} fragment
 * @returns {Promise<{score:number, reason:string, hits:object[], noise:string[], script:string}>}
 */
export async function score(fragment) {
  return scoreSync(fragment);
}

/**
 * 批量打分并按分数降序返回（方便上层取 top-N）。
 * @param {unknown[]} fragments
 */
export async function rank(fragments) {
  if (!Array.isArray(fragments)) return [];
  const scored = await Promise.all(
    fragments.map(async (fragment) => {
      const { score: s, reason, script } = await score(fragment);
      return { fragment, score: s, reason, script };
    }),
  );
  return scored.sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────
// 阈值怎么定的（可复现，2026-10-11 实测）
//
//   <bench-py> p0/replay-extractor-dump.py     # 先裁真实语料
//   <node>     p0/calibrate-scorer.mjs          # 跑校准：语种 / 词表命中 / 分位 / 通过率 / 正例护栏
//
//   4714 个片段上的分数分位：
//     p50=0.23  p75=0.23  p90=0.38  p95=0.51  p99=0.60  max=0.93
//   通过率：
//     ≥0.50 → 360 个 = **7.6%**   ← 取此档
//     ≥0.55 → 121 个 = 2.6%
//     ≥0.62 →  39 个 = 0.8%
//
//   取 **0.50** 的理由：
//     - 7.6% 通过 ⇒ 降噪 92.4%，与 DESIGN §5.1「降噪 ~90%」同量级。
//     - 更关键的是**单个真实信号要过得去**。曾经取 0.62，结果发现
//       "wait, I was wrong" 这类单片段的最高分只有 ~0.51 —— 阈值高到
//       **必须两类信号叠加才可能通过**，等于把最典型的自我修正全滤掉了。
//       校准阈值时必须同时看"目标片段能不能过"，不能只看通过率。
//
//   ⚠️ 通过率 ≠ 可用率。命中主要来自「自我怀疑」桶（539 个片段），而该桶含
//      `hmm` / `actually` 这类高频**弱**信号（实测 `actually` 241 次、
//      `hmm` 208 次）—— 它们算不算"值得念"，必须由人听（D2 / P4-1），
//      不能在 P2 阶段当成已定的精度。
//   ⚠️ 片段按书写系统分布：en 2794 (59%) · code 1463 (31%) · zh 398 (8%) · mixed 59。
//      `code` 那 31% 基本都被降噪扣到 0 分，不会再往下走。
// ─────────────────────────────────────────────────────────────────────
