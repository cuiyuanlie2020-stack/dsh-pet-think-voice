/**
 * `p0/word-audit.mjs` — 情绪桶**逐词随机抽样**体检（P4-5 攻"桶内混合"用）
 *
 * 背景：调度层做完之后，抽出的 20 条里那 8 条"情绪句"**只有 1 条真像话**
 * （`记忆内容：- 1234 全部完成- 884 张卡` 被判成「吐槽」）。⇒ 桶 → 表情的映射
 * **本身在误判**，得回到词表层逐词查。
 *
 * 方法沿用 P4-1 那套（见项目 MEMORY「词表方法论五条铁律」）：
 *   ① **只看 DF 会误判** —— `成功`1902 / `干净`1389 全是内容词，一个情绪都没有；
 *   ② **必须随机抽样** —— 语料按会话顺序排列、同类用法连续扎堆，取前 N 条严重有偏
 *      （`顺手` DF 252 就是这么被误收又剔除的）；
 *   ③ **子串陷阱**比僵尸词更危险 —— `认了` 376 条全是「**确认**了」的子串。
 *
 * 用法：
 *   <node> p0/word-audit.mjs [--n 6] [--buckets 吐槽,情绪外露,顿悟,手滑·坦白]
 *                            [--corpus p0/out/corpus-wb-zh.jsonl] [--out p0/out/word-audit.md]
 *
 * ⚠️ 输出含真实语料原文 ⇒ 写进 `p0/out/`（**永不入库**）。
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
const OUT = flag('--out', 'p0/out/word-audit.md');
const N = Number(flag('--n', '6'));
const BUCKETS = flag('--buckets', '吐槽,情绪外露,顿悟,手滑·坦白').split(',');

/** 确定性洗牌（xorshift32）—— 抽样必须可复现，别用 Math.random。 */
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

const wordsOf = new Map();   // 词 -> 桶（一个词只属一个桶；取第一个命中的）
for (const bucket of BUCKETS) {
  for (const w of TRIGGER_LEXICON[bucket]?.words ?? []) {
    if (!wordsOf.has(w)) wordsOf.set(w, bucket);
  }
}

const hits = new Map();      // 词 -> [过阈片段...]
let scanned = 0;
const rl = createInterface({ input: createReadStream(CORPUS, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  const text = reasoningOf(line);
  if (text === null) continue;
  for (const fragment of splitFragments(text)) {
    scanned += 1;
    // 只统计**过阈**的片段 —— 没过阈的根本不会被念，查它们没有意义
    if (scoreSync(fragment.text).score < DEFAULT_THRESHOLD) continue;
    for (const [w] of wordsOf) {
      if (!fragment.text.includes(w)) continue;
      if (!hits.has(w)) hits.set(w, []);
      hits.get(w).push(fragment.text);
    }
  }
}

const lines = [];
lines.push('# 情绪桶逐词体检（P4-5 攻桶内混合）');
lines.push('');
lines.push(`语料 \`${CORPUS}\` · 扫描片段 ${scanned} 个（只统计**过阈**的）· 每词随机取 ${N} 条（seed 固定）`);
lines.push('');
lines.push('> ⚠️ 判定标准**不是"占比"**，而是"**命中的这些能不能当情绪念**"。');
lines.push('> ⚠️ 抽样是**随机**的 —— 语料按会话顺序排列，取前 N 条会因同类用法扎堆而严重有偏。');
lines.push('');

for (const bucket of BUCKETS) {
  const words = TRIGGER_LEXICON[bucket]?.words ?? [];
  lines.push(`## ${bucket}（weight ${TRIGGER_LEXICON[bucket]?.weight ?? '?'} · ${words.length} 词）`);
  lines.push('');
  lines.push('| 词 | DF（过阈片段数） | 随机抽样的实际长相 |');
  lines.push('|---|---|---|');
  for (const w of words) {
    const all = hits.get(w) ?? [];
    const sample = shuffle(all).slice(0, N);
    const cells = sample.map((s) => '`' + s.slice(0, 46).replace(/\|/g, '丨').replace(/\n/g, ' ') + '`');
    lines.push(`| \`${w}\` | ${all.length} | ${cells.length ? cells.join('<br>') : '（无命中）'} |`);
  }
  lines.push('');
}

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`扫描片段 ${scanned} 个 → ${OUT}`);
for (const bucket of BUCKETS) {
  const n = (TRIGGER_LEXICON[bucket]?.words ?? []).length;
  console.log(`  ${bucket}: ${n} 词`);
}
