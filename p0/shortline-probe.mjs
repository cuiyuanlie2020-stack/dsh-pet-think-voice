/**
 * D14 探针：长度加分下界该不该从 12 放宽到 8？
 *
 * ── 为什么这件事可以**精确**算，而不是"改完看看" ─────────────────────────────
 * `interest-scorer` 的长度加分是一条**独立规则**：
 *
 *     if (len >= 12 && len <= 170) score += 0.05
 *
 * 它只依赖 `len`，与其它规则**零耦合**（`len < 8` 的那条扣分只作用于 8 以下，
 * 不在本次考察范围内）。所以对任何 `8 <= len <= 11` 的片段：
 *
 *     改后分数 = 改前分数 + 0.05
 *
 * 于是"放宽到 8 会新增哪些条目"= `{8<=len<=11 且 0.45 <= score < 0.50}`，
 * **不需要改一行生产代码就能算出来**（E2 精神：一次只动一个变量，先量后改）。
 *
 * ── 要量的三件事 ────────────────────────────────────────────────────────
 *   ① 净增多少（分"过阈"与"过拟人化"两层 —— 过阈了也可能被 D12 拒收）
 *   ② 新增里**中文**占多少（真机 `speech.language=zh`，英文思考不是生产条件）
 *   ③ 随机抽原文，人眼判"是不是好素材"（这一条工具替不了）
 *
 * 用法：
 *   node p0/shortline-probe.mjs                       # 默认语料
 *   node p0/shortline-probe.mjs --corpus p0/out/corpus-zh.jsonl --n 16
 *
 * 产出：`p0/out/shortline-probe.md`（含真实语料原文 ⇒ **永不入库**，已 git check-ignore）
 */

import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, scoreSync } from '../lib/core/interest-scorer.js';
import { polish } from '../lib/core/line-polisher.js';
import { detectLang } from '../lib/core/reasoning-language.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CORPUS = flag('--corpus', 'p0/out/corpus-wb-zh.jsonl');
const N = Number(flag('--n', '16'));
const SEED = Number(flag('--seed', '20261011'));
const OUT = flag('--out', 'p0/out/shortline-probe.md');

/** 待扫的下界档位（12 = 现状，不在此列）。 */
const CANDIDATES = [8, 9, 10, 11];
/** 长度加分本身（与 interest-scorer 保持一致；改了那里这里必须跟着改）。 */
const LEN_BONUS = 0.05;
/** 只有这一段会因"下界"而改变命运。 */
const LO = 8;
const HI = 11;

function makeRng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

function reasoningOf(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const content = parsed?.data?.message?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((c) => c && c.type === 'reasoning' && typeof c.text === 'string')
    .map((c) => c.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

// ── ① 全量跑链路 ────────────────────────────────────────────────────────────
let reasonings = 0;
let fragments = 0;
let passedNow = 0;                       // 现状（下界 12）过阈
const lenHist = new Map();               // len(8..11) → 片段计数
const cands = [];                        // 加 0.05 才过阈的那些

const rl = createInterface({ input: createReadStream(CORPUS, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  const text = reasoningOf(line);
  if (text === null) continue;
  reasonings += 1;
  for (const fragment of splitFragments(text)) {
    fragments += 1;
    const raw = fragment.text;
    const score = scoreSync(raw).score;
    const len = raw.length;
    const overNow = score >= DEFAULT_THRESHOLD;
    if (overNow) passedNow += 1;
    if (len < LO || len > HI) continue;

    lenHist.set(len, (lenHist.get(len) ?? 0) + 1);
    // 只留"加了 0.05 才过阈"的那一段 —— 其余与下界无关
    if (overNow || score + LEN_BONUS < DEFAULT_THRESHOLD) continue;

    const { line: picked } = polish(raw, { score: score + LEN_BONUS });
    cands.push({
      len,
      score,
      raw,
      rawLang: detectLang(raw),
      kept: picked ? picked.text : null,
      emotion: picked ? picked.emotion : null,
      reject: picked ? null : '拟人化拒收',
    });
  }
}

// ── ② 汇总 ─────────────────────────────────────────────────────────────────
const pct = (n, d) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));
const byLang = (list, key) => {
  const m = new Map();
  for (const c of list) m.set(c[key], (m.get(c[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const lines = [];
lines.push('# D14 · 长度加分下界放宽的净增对照');
lines.push('');
lines.push('> 语料：`' + CORPUS + '` ｜ 阈值 `' + DEFAULT_THRESHOLD + '` ｜ 长度加分 `+' + LEN_BONUS + '`');
lines.push('');
lines.push('## 总量');
lines.push('');
lines.push('| 项 | 值 |');
lines.push('|---|---|');
lines.push('| 思考条数 | ' + reasonings + ' |');
lines.push('| 片段总数 | ' + fragments + ' |');
lines.push('| 现状过阈（下界 12） | ' + passedNow + ' |');
lines.push('| `8~11` 字片段总数 | ' + [...lenHist.values()].reduce((a, b) => a + b, 0) + ' |');
lines.push('');
lines.push('## 各档净增（过阈层面）');
lines.push('');
lines.push('| 下界 | 净增条数 | 占现状 | 其中中文 | 中文净增占现状 | 其中放行 |');
lines.push('|---|---|---|---|---|---|');
for (const L of CANDIDATES) {
  const sub = cands.filter((c) => c.len >= L);
  const zh = sub.filter((c) => c.rawLang === 'zh');
  const kept = sub.filter((c) => c.kept !== null);
  const keptZh = kept.filter((c) => c.rawLang === 'zh');
  lines.push('| **' + L + '** | ' + sub.length + ' | ' + pct(sub.length, passedNow) + '% | '
    + zh.length + ' | ' + pct(zh.length, passedNow) + '% | ' + kept.length
    + '（中文 ' + keptZh.length + '） |');
}
lines.push('');
lines.push('## 新增集合的长度分布');
lines.push('');
lines.push('| len | 片段总数（全语料） | 新增候选数 | 中文候选 |');
lines.push('|---|---|---|---|');
for (let L = LO; L <= HI; L += 1) {
  const sub = cands.filter((c) => c.len === L);
  lines.push('| ' + L + ' | ' + (lenHist.get(L) ?? 0) + ' | ' + sub.length + ' | '
    + sub.filter((c) => c.rawLang === 'zh').length + ' |');
}
lines.push('');
lines.push('## 新增候选的语种构成');
lines.push('');
lines.push('| 语种 | 条数 |');
lines.push('|---|---|');
for (const [k, v] of byLang(cands, 'rawLang')) lines.push('| ' + k + ' | ' + v + ' |');
lines.push('');
lines.push('## 抽查（随机 ' + N + ' 条，seed=' + SEED + '）');
lines.push('');
lines.push('判据：**这句她念出来像不像话**（不是"有没有信息"）。');
lines.push('');
lines.push('| # | len | score | 原文 | 放行后 | 语种 |');
lines.push('|---|---|---|---|---|---|');
const rng = makeRng(SEED);
const pool = cands.slice();
for (let i = pool.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rng() * (i + 1));
  const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
}
const shown = pool.slice(0, N);
shown.forEach((c, i) => {
  const n = String(i + 1).padStart(2, '0');
  const raw = c.raw.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
  const kept = c.kept === null
    ? '❌ ' + c.reject
    : c.kept.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
  lines.push('| ' + n + ' | ' + c.len + ' | ' + c.score.toFixed(3) + ' | ' + raw + ' | ' + kept + ' | ' + c.rawLang + ' |');
});
lines.push('');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log('思考 ' + reasonings + ' ｜ 片段 ' + fragments + ' ｜ 现状过阈 ' + passedNow);
console.log('');
console.log('| 下界 | 净增 | 其中中文 | 其中放行 |');
console.log('|---|---|---|---|');
for (const L of CANDIDATES) {
  const sub = cands.filter((c) => c.len >= L);
  console.log('| ' + L + ' | ' + sub.length + ' | ' + sub.filter((c) => c.rawLang === 'zh').length
    + ' | ' + sub.filter((c) => c.kept !== null).length + ' |');
}
console.log('');
console.log('语种构成：' + byLang(cands, 'rawLang').map(([k, v]) => k + '=' + v).join(' · '));
console.log('产出：' + OUT);
