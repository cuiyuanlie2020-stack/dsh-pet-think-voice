/**
 * `p0/selfref-probe.mjs` — 「自指污染」判据的**阈值扫描**（P4-5）
 *
 * 背景：情绪桶逐词体检（`p0/word-audit.mjs`）发现 —— `i see` / `found it` / `messy` /
 * `weird` / `awkward` / `无语` 这些词的命中里**过半是"讨论我们自己的词表"的元文本**。
 * 那类文本天然会**列举词表里的词**，所以必然命中：
 *
 *     顿悟：interesting, understand, i see, found it（剔除…
 *     - 发现判定: interesting, understand, i see, found …
 *
 * 想加的判据：**同一片段里出现 ≥N 个不同的词表词 ⇒ 拒收**。
 *
 * ⚠️ 但它有**误杀风险**：正常思考也可能连用几个 —— `其实我需要再确认一下，或者算了`
 *    就是 3 个。所以**先扫**：每个 N 挡下多少、挡下的长什么样，再定阈值。
 *    （这就是项目 MEMORY 里那条"判『假』必须看大语料 DF + 抽样原文"的用法。）
 *
 * 用法：<node> p0/selfref-probe.mjs [--n 6] [--out p0/out/selfref-probe.md]
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, TRIGGER_LEXICON, scoreSync } from '../lib/core/interest-scorer.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CORPUS = flag('--corpus', 'p0/out/corpus-wb-zh.jsonl');
const OUT = flag('--out', 'p0/out/selfref-probe.md');
const SHOW = Number(flag('--n', '6'));

function shuffle(arr, seed = 20261011) {
  const out = arr.slice();
  let x = seed >>> 0 || 1;
  const rnd = () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

/** 全部词表词（去重）。**长词在前**，这样报告里能先看到更有信息量的命中。 */
const ALL_WORDS = [...new Set(
  Object.values(TRIGGER_LEXICON).flatMap((b) => b.words ?? []),
)].sort((a, b) => b.length - a.length);

const byCount = new Map();
let passed = 0;
/**
 * **高精度形态判据**：词表词紧跟着括号数字（如 `等等(10)` / `待实测(12)`）。
 *
 * 为什么放弃"≥N 个词表词"：抽样证明它**不可用** —— 正常思考天然会连用这些词
 * （`嗯，或者不 present，只在文字里说明路径。` 命中 3 个，却是一句很好的朗读素材；
 * `嗯，等等。如果 B 恢复了 20+，那说明…` 同理，N=3 的 6 条样本里 4 条是误杀）。
 *
 * 而「词 + 括号数字」是"**在数 DF**"的独有形态，正常思考里几乎不会出现。
 * ⚠️ 这里用 `[0-9]` 而不是 `\\d`，就为了少一层转义。
 */
const RE_WORD_PAREN_NUM = new RegExp(
  '(' + ALL_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[（(][0-9]+[)）]',
);
/** 形态二：**斜杠/顿号紧密列举** ≥4 个词表词（如 `不过/说明/或者/值得`）。 */
const RE_SLASH_LIST = new RegExp(
  '(?:(?:' + ALL_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[/、·]\\s*){3,}',
);
const formHits = [];
const slashHits = [];

const rl = createInterface({ input: createReadStream(CORPUS, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  const text = reasoningOf(line);
  if (text === null) continue;
  for (const fragment of splitFragments(text)) {
    if (scoreSync(fragment.text).score < DEFAULT_THRESHOLD) continue;
    passed += 1;
    const hit = ALL_WORDS.filter((w) => fragment.text.includes(w));
    if (RE_WORD_PAREN_NUM.test(fragment.text)) formHits.push({ text: fragment.text, hit });
    if (RE_SLASH_LIST.test(fragment.text)) slashHits.push({ text: fragment.text, hit });
    if (hit.length < 2) continue;
    if (!byCount.has(hit.length)) byCount.set(hit.length, []);
    byCount.get(hit.length).push({ text: fragment.text, hit });
  }
}

const counts = [...byCount.keys()].sort((a, b) => a - b);
const atLeast = (n) => counts.filter((c) => c >= n).reduce((s, c) => s + byCount.get(c).length, 0);

const lines = [];
lines.push('# 「自指污染」判据阈值扫描（P4-5）');
lines.push('');
lines.push(`语料 \`${CORPUS}\` · 过阈片段 **${passed}** 个 · 词表词 ${ALL_WORDS.length} 个`);
lines.push('');
lines.push('判据草案：**同一片段里出现 ≥N 个不同的词表词 ⇒ 拒收**。');
lines.push('');
lines.push('| N（≥ 几个词表词） | 会挡下多少条 | 占过阈片段 |');
lines.push('|---|---|---|');
for (const n of [2, 3, 4, 5, 6, 8]) {
  const c = atLeast(n);
  lines.push(`| ≥ ${n} | ${c} | ${(c / Math.max(1, passed) * 100).toFixed(2)}% |`);
}
lines.push('');
lines.push('> ⚠️ 判定要看的**不是挡下多少**，而是「**挡下的那些是不是真的自指**」+「**没挡的那些够不够干净**」。');
lines.push('');

lines.push('## 形态判据（候选，高精度）');
lines.push('');
lines.push('- **词 + 括号数字**（「等等(10)」这种数 DF 的形态）：命中 **'
  + formHits.length + '** 条（' + (formHits.length / Math.max(1, passed) * 100).toFixed(2) + '%）');
lines.push('- **斜杠/顿号紧密列举 ≥4 词**：命中 **'
  + slashHits.length + '** 条（' + (slashHits.length / Math.max(1, passed) * 100).toFixed(2) + '%）');
lines.push('');
lines.push('### 形态一「词 + 括号数字」的随机样本');
lines.push('');
for (const s of shuffle(formHits).slice(0, SHOW)) {
  lines.push(`- 命中 ${s.hit.length} 个：${s.hit.slice(0, 6).join(' · ')}`);
  lines.push(`  > ${s.text.slice(0, 110).replace(/\n/g, ' ')}`);
}
lines.push('');
lines.push('### 形态二「斜杠列举」的随机样本');
lines.push('');
for (const s of shuffle(slashHits).slice(0, SHOW)) {
  lines.push(`- 命中 ${s.hit.length} 个：${s.hit.slice(0, 6).join(' · ')}`);
  lines.push(`  > ${s.text.slice(0, 110).replace(/\n/g, ' ')}`);
}
lines.push('');

for (const n of [3, 4, 5]) {
  const pool = counts.filter((c) => c >= n).flatMap((c) => byCount.get(c));
  const sample = shuffle(pool).slice(0, SHOW);
  lines.push(`## 若取 N = ${n}（挡下 ${pool.length} 条），随机看 ${sample.length} 条`);
  lines.push('');
  for (const s of sample) {
    lines.push(`- **命中 ${s.hit.length} 个**：${s.hit.slice(0, 8).join(' · ')}`);
    lines.push(`  > ${s.text.slice(0, 110).replace(/\n/g, ' ')}`);
  }
  lines.push('');
}

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`过阈片段 ${passed} 个 → ${OUT}`);
for (const n of [2, 3, 4, 5, 6, 8]) {
  console.log(`  ≥${n} 个词表词：${atLeast(n)} 条（${(atLeast(n) / passed * 100).toFixed(2)}%）`);
}
