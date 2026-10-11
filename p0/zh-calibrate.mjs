/**
 * P4-1 专用：**中文语料**上的筛选口径诊断（D11 / D2）。
 *
 * 与 `calibrate-scorer.mjs` 的区别：
 *   - 那个看**全量**语料（英文 69%，中文只 5%）→ 结论天然偏英文；
 *   - 这个只看**中文主导/混合**语料（注入生效后的真实形态）。
 *
 * 回答四个问题：
 *   1. 中文片段切出来长什么样（长度分布 vs splitter 的 soft 110 / max 180）
 *   2. 现词表在**中文**上各桶命中多少（找出"英文词条撑场面、中文词条全 0"）
 *   3. 分数分位与通过率（对比英文语料的 7.6%）
 *   4. 未过阈的片段，是"没命中信号"还是"被噪声扣死"
 *
 * 用法：
 *   <bench-py> p0/dump-zh-corpus.py     # 先导中文语料 -> p0/out/corpus-zh.jsonl
 *   <node>     p0/zh-calibrate.mjs      # 跑本脚本
 *
 * ⚠️ 语料含真实思考文本，落在 `p0/out/`（已 gitignore，**永不入库**）。
 *    本脚本自身只输出**统计量**，不打印片段原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, TRIGGER_LEXICON, scoreSync } from '../lib/core/interest-scorer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = process.argv[2] ?? path.join(HERE, 'out', 'corpus-zh.jsonl');

if (!fs.existsSync(CORPUS)) {
  console.error('找不到语料：' + CORPUS);
  console.error('先跑：<bench-py> p0/dump-zh-corpus.py');
  process.exit(2);
}

const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
const latin = (s) => (s.match(/[A-Za-z]/g) ?? []).length;

const thoughts = [];
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const { data } = JSON.parse(line);
  const text = (data?.message?.content ?? [])
    .filter((b) => b?.type === 'reasoning')
    .map((b) => b.text ?? '')
    .join('');
  if (text.trim() !== '') thoughts.push(text);
}

const fragments = [];
for (const t of thoughts) fragments.push(...splitFragments(t).map((f) => f.text));

const pct = (xs, p) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
};

console.log(`中文/混合思考 ${thoughts.length} 条 → 片段 ${fragments.length} 个\n`);

const all = thoughts.join('');
console.log('=== 1. 语种与片段形态 ===');
console.log(`  整批：中文 ${(100 * cjk(all) / all.length).toFixed(1)}%   ASCII ${(100 * latin(all) / all.length).toFixed(1)}%`);
const scripts = {};
for (const f of fragments) scripts[scoreSync(f).script] = (scripts[scoreSync(f).script] ?? 0) + 1;
console.log('  片段分布：' + Object.entries(scripts).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v} (${(100 * v / fragments.length).toFixed(0)}%)`).join(' · '));
const lens = fragments.map((f) => f.length);
console.log(`  长度：p25=${pct(lens, 25)}  中位=${pct(lens, 50)}  p75=${pct(lens, 75)}  p95=${pct(lens, 95)}  max=${lens.reduce((a,b)=>a>b?a:b,0)}`);
const over = lens.filter((n) => n > 180).length;
console.log(`  超 splitter 硬上限(180) 的片段：${over} 个`);

// ── 2. 词表命中：分子逐词 ──────────────────────────────────────────
console.log('\n=== 2. 词表命中（逐词，找"僵尸词条"）===');
const hitsWord = (text, word) => {
  if (/^[a-z][a-z'\- ]*$/i.test(word)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`, 'i').test(text);
  }
  return text.includes(word);
};
for (const [name, { words }] of Object.entries(TRIGGER_LEXICON)) {
  const per = words.map((w) => [w, fragments.filter((f) => hitsWord(f, w)).length]);
  const total = fragments.filter((f) => words.some((w) => hitsWord(f, w))).length;
  console.log(`\n  【${name}】触发片段 ${total} (${(100 * total / fragments.length).toFixed(1)}%)`);
  const live = per.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const dead = per.filter(([, n]) => n === 0).map(([w]) => w);
  if (live.length) console.log('    有效：' + live.map(([w, n]) => `${w}×${n}`).join(' · '));
  if (dead.length) console.log('    ❌ 零命中：' + dead.join(' · '));
}

// ── 3. 分数分布与通过率 ─────────────────────────────────────────────
const scores = fragments.map((f) => scoreSync(f).score);
console.log('\n=== 3. 分数分位 ===');
console.log(`  p50=${pct(scores, 50)}  p75=${pct(scores, 75)}  p90=${pct(scores, 90)}`
  + `  p95=${pct(scores, 95)}  p99=${pct(scores, 99)}  max=${scores.reduce((a,b)=>a>b?a:b,0)}`);

console.log('\n=== 4. 各阈值通过率（对比英文语料 0.50→7.6%）===');
for (const t of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) {
  const pass = scores.filter((s) => s >= t).length;
  const mark = t === DEFAULT_THRESHOLD ? '   ← 当前默认' : '';
  console.log(`  >=${t.toFixed(2)} → ${String(pass).padStart(4)} = ${(100 * pass / fragments.length).toFixed(1)}%${mark}`);
}

// ── 5. 未过阈的归因：无信号 vs 被噪声扣死 ───────────────────────────
console.log('\n=== 5. 未过阈片段归因（这决定该加词还是该改罚则）===');
const fails = fragments.filter((f) => scoreSync(f).score < DEFAULT_THRESHOLD);
const noSignal = fails.filter((f) => scoreSync(f).hits.length === 0);
const hadSignalButLow = fails.filter((f) => scoreSync(f).hits.length > 0 && scoreSync(f).score < DEFAULT_THRESHOLD);
const noiseKilled = fails.filter((f) => scoreSync(f).noise.some((n) => /扣|占比|含/.test(n)));
console.log(`  未过阈总数 ${fails.length} (${(100 * fails.length / fragments.length).toFixed(0)}%)`);
console.log(`    ├ 完全没命中信号（基线 0.18 之上无加分）：${noSignal.length} (${(100 * noSignal.length / fragments.length).toFixed(0)}%)`);
console.log(`    ├ 命中但仍不够（阈值太高 / 权重太低）：${hadSignalButLow.length} (${(100 * hadSignalButLow.length / fragments.length).toFixed(0)}%)`);
console.log(`    └ 其中带噪声扣分标记的：${noiseKilled.length}`);

const noiseKinds = {};
for (const f of fragments) for (const n of scoreSync(f).noise) {
  if (!/^命中/.test(n)) noiseKinds[n.replace(/\(.*\)/, '')] = (noiseKinds[n.replace(/\(.*\)/, '')] ?? 0) + 1;
}
console.log('  噪声扣分种类分布（片段数）：');
for (const [k, v] of Object.entries(noiseKinds).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(26)} ${v}`);
}