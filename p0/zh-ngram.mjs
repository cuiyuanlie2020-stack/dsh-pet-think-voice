/**
 * P4-1 词表挖掘：从**中文片段**里找真实高频的"话语标记"。
 *
 * 为什么需要它：P2-4 那版中文词条（`搞错` / `恍然大悟` / `绕了一大圈`…）在实测里
 * **几乎全是零命中** —— 不是词表写得少，是**凭想象写的**。本脚本用
 * 「文档频率（DF）」代替词频：一个 n-gram 要在**很多条不同的思考**里出现，
 * 才算"通用话语标记"，而不是某次对话的内容词。
 *
 * 输出：按 DF 排序的候选 n-gram 表（2~4 字），供人工挑选进 `TRIGGER_LEXICON`。
 * ⚠️ 只打印**跨条高频的通用短语**（如"等等"/"其实"/"所以"），不导出上下文、不导出原文。
 *
 * 用法：
 *   <bench-py> p0/dump-zh-corpus.py
 *   <node>     p0/zh-ngram.mjs [最小DF，默认 5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = process.argv[2] ?? path.join(HERE, 'out', 'corpus-zh.jsonl');
const MIN_DF = Number(process.argv[3] ?? 5);

if (!fs.existsSync(CORPUS)) {
  console.error('找不到语料：' + CORPUS + '（先跑 <bench-py> p0/dump-zh-corpus.py）');
  process.exit(2);
}

const CJK_RE = /[\u4e00-\u9fff]+/g;
const isCjkOnly = (s) => /^[\u4e00-\u9fff]+$/.test(s);

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

// 只统计**中文主导**的片段（zh / mixed），排除 code
const zhFragments = [];
for (const t of thoughts) {
  for (const f of splitFragments(t)) {
    const cjk = (f.text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = (f.text.match(/[A-Za-z]/g) ?? []).length;
    if (cjk === 0) continue;
    if (cjk / (cjk + latin) < 0.3) continue;
    zhFragments.push(f.text);
  }
}

// n-gram → 文档频率（出现在多少**条不同片段**里）
const df = new Map();
for (const frag of zhFragments) {
  const seen = new Set();
  for (const run of frag.match(CJK_RE) ?? []) {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const g = run.slice(i, i + n);
        if (!isCjkOnly(g)) continue;
        seen.add(g);
      }
    }
  }
  for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1);
}

console.log(`中文主导片段 ${zhFragments.length} 个 · 候选 n-gram ${df.size} 个 · 最小 DF=${MIN_DF}\n`);

// 按 DF 降序；同 DF 优先长 n-gram（更可能是完整词而非碎片）
const rows = [...df.entries()]
  .filter(([, n]) => n >= MIN_DF)
  .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

console.log('DF  短语          （每行 8 个，按 DF 降序）');
console.log('─'.repeat(72));
let buf = [];
for (const [g, n] of rows) {
  buf.push(`${String(n).padStart(4)} ${g}`);
  if (buf.length === 4) { console.log('  ' + buf.join('   ')); buf = []; }
}
if (buf.length) console.log('  ' + buf.join('   '));

console.log(`\n合计 ${rows.length} 个短语 DF≥${MIN_DF}`);

// 只列 2 字与 3 字里 DF 最高的，方便直接挑词
for (const n of [2, 3]) {
  const sub = rows.filter(([g]) => g.length === n).slice(0, 40);
  console.log(`\n=== 最高频 ${n} 字短语（前 ${sub.length}）===`);
  console.log('  ' + sub.map(([g, c]) => `${g}:${c}`).join(' · '));
}