/**
 * 词表词条的**双语料对照体检** —— P4-1 之后的新发现（2026-10-11）。
 *
 * 为什么要做：P4-1 的中文重校只用 `~/.dsh/sessions`（236 条思考 / 2111 中文片段）。
 * 用户 2026-10-11 指出 WorkBuddy 本地对话是更大的语料源 —— 实测有 **24852 条 reasoning**，
 * 中文主导 **10932 条**。在 37.9 万片段的大样本上重测，发现**上一轮加的词分两类**：
 *
 *   - 稳的：其实 1.2% / 实际上 1.4% / 等等 0.9% / 结论 / 说明 / 嗯 / 不过 —— 两个语料都够
 *   - **过拟合的**：待实测 / 未实测 / 疑点 / 根本原因 —— 在小语料上占 1.3%，
 *     在大语料上只有 0.02~0.05% ⇒ 它们是**那个开发会话的口头禅**，不是通用信号
 *
 * 用法（两个语料都要先导）：
 *   <bench-py> p0/dump-zh-corpus.py          # DSH 侧  → p0/out/corpus-zh.jsonl
 *   <bench-py> p0/dump-workbuddy-corpus.py   # WB 侧   → p0/out/corpus-wb-zh.jsonl
 *   <node>     p0/lexicon-pair-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { TRIGGER_LEXICON, scoreSync } from '../lib/core/interest-scorer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function load(p) {
  const out = [];
  const seen = new Set();
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const { data } = JSON.parse(line);
    const t = (data?.message?.content ?? []).filter((b) => b?.type === 'reasoning').map((b) => b.text ?? '').join('');
    for (const f of splitFragments(t)) {
      const cjk = (f.text.match(/[\u4e00-\u9fff]/g) ?? []).length;
      const lat = (f.text.match(/[A-Za-z]/g) ?? []).length;
      if (cjk === 0) continue;
      if (cjk / (cjk + lat) < 0.3) continue;
      const key = f.text.slice(0, 60) + f.text.slice(-30);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f.text);
    }
  }
  return out;
}

const DSH = load(path.join(HERE, 'out', 'corpus-zh.jsonl'));
const WB = load(path.join(HERE, 'out', 'corpus-wb-zh.jsonl'));

console.log(`DSH 侧中文片段 ${DSH.length} 个（236 条思考 · 上一轮的语料）`);
console.log(`WB  侧中文片段 ${WB.length} 个（24852 条 reasoning · 用户指出的大语料）\n`);

const hitsWord = (text, w) => text.includes(w);

console.log('词条            桶           DSH占比    WB占比    判定');
console.log('─'.repeat(74));
for (const [bucket, entry] of Object.entries(TRIGGER_LEXICON)) {
  for (const w of entry.words) {
    if (!/[\u4e00-\u9fff]/.test(w)) continue; // 只看中文词条
    const a = DSH.filter((f) => hitsWord(f, w)).length;
    const b = WB.filter((f) => hitsWord(f, w)).length;
    const ra = (100 * a / Math.max(1, DSH.length));
    const rb = (100 * b / Math.max(1, WB.length));
    // 判定：两个语料都 ≥0.3% 才算稳；DSH 高 WB 低 = 过拟合小样本
    const verdict = (ra >= 0.3 && rb >= 0.3) ? '✅ 稳'
      : (ra >= 0.3 && rb < 0.1) ? '⚠️ 过拟合小样本'
        : (rb >= 0.3) ? '✅ 大语料更支持'
          : '△ 偏稀';
    console.log(`${w.padEnd(12)} ${bucket.padEnd(10)} ${ra.toFixed(2).padStart(6)}%  ${rb.toFixed(2).padStart(6)}%   ${verdict}`);
  }
}

console.log('\n=== 阈值通过率对照 ===');
for (const [name, frags] of [['DSH', DSH], ['WB', WB]]) {
  const sc = frags.map((f) => scoreSync(f).score);
  const line = [0.45, 0.5, 0.55]
    .map((t) => `≥${t} → ${(100 * sc.filter((s) => s >= t).length / Math.max(1, sc.length)).toFixed(1)}%`)
    .join('  ');
  console.log(`  ${name.padEnd(4)}（${frags.length} 片段）  ${line}`);
}