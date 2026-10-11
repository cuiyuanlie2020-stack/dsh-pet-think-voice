/**
 * P2-4 / D2 校准工具：用**真实语料**核对筛选口径。
 *
 * 回答四个问题（D2「词表与阈值」的全部依据都出自这里）：
 *   1. 思考到底是什么语种？（书写系统占比）
 *   2. 词表各桶在真实数据上到底命中多少？（防"拍脑袋写出一份全 0 的词表"）
 *   3. 打分的分位分布长什么样？
 *   4. 各阈值下的通过率是多少？（挑"降噪 ~90%"那一档）
 *
 * 两步用法（与 `replay-extractor-*` 同一套语料）：
 *
 *     <bench-py> p0/replay-extractor-dump.py      # 先裁语料 -> p0/out/corpus.jsonl
 *     <node>     p0/calibrate-scorer.mjs          # 跑本脚本
 *
 * ⚠️ 语料含真实思考文本，落 `p0/out/`（已 gitignore，**永不入库**）。
 *
 * ⚠️ **校准阈值时必须同时看"目标正例能不能过闸"**，不能只看通过率 ——
 *    本项目就栽过一次：先取 0.62 时通过率看着合理，但实测
 *    `wait, I was wrong` 这类单个真实信号最高只有 ~0.51，于是"必须两类信号叠加才过"，
 *    把最典型的自我修正片段全滤掉了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, TRIGGER_LEXICON, scoreSync } from '../lib/core/interest-scorer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'out', 'corpus.jsonl');

if (!fs.existsSync(CORPUS)) {
  console.error('找不到语料：' + CORPUS);
  console.error('先跑：<bench-py> p0/replay-extractor-dump.py');
  process.exit(2);
}

const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
const latin = (s) => (s.match(/[A-Za-z]/g) ?? []).length;
const squash = (s) => s.replace(/\s+/g, '');

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

console.log(`思考 ${thoughts.length} 条 → 片段 ${fragments.length} 个\n`);

// ── 1. 语种 ──────────────────────────────────────────────────────────
const all = thoughts.join('');
console.log('=== 1. 书写系统 ===');
console.log(`  整批：中文 ${(100 * cjk(all) / all.length).toFixed(1)}%   ASCII ${(100 * latin(all) / all.length).toFixed(1)}%`);
const zhThoughts = thoughts.filter((t) => cjk(t) / t.length > 0.3).length;
const enThoughts = thoughts.filter((t) => cjk(t) / t.length <= 0.05).length;
console.log(`  按条：中文主导 ${zhThoughts} (${(100 * zhThoughts / thoughts.length).toFixed(0)}%)`
  + `  英文主导 ${enThoughts} (${(100 * enThoughts / thoughts.length).toFixed(0)}%)`);
const scripts = {};
for (const f of fragments) scripts[scoreSync(f).script] = (scripts[scoreSync(f).script] ?? 0) + 1;
console.log('  片段分布：' + Object.entries(scripts).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v} (${(100 * v / fragments.length).toFixed(0)}%)`).join(' · '));

// ── 2. 词表命中 ──────────────────────────────────────────────────────
console.log('\n=== 2. 词表命中（防"全 0 词表"）===');
const hitCounts = {};
for (const f of fragments) {
  for (const h of scoreSync(f).hits) hitCounts[h.rule] = (hitCounts[h.rule] ?? 0) + 1;
}
for (const name of Object.keys(TRIGGER_LEXICON)) {
  const key = `信号·${name}`;
  const n = hitCounts[key] ?? 0;
  // ⚠️ 0 命中不等于「无效」：本脚本语料为 DSH 派生的小样本，长尾桶
  //    （如「手滑·坦白」）在此天然为 0，判据请用 p0/polish-probe.mjs（WB 大语料）。
  const flag = n === 0 ? '  ⚠️ 本语料零命中（长尾桶在此为 0 属预期；用 polish-probe 看大语料）' : '';
  console.log(`  ${name.padEnd(6)} ${String(n).padStart(4)}  (${(100 * n / fragments.length).toFixed(1)}%)${flag}`);
}
for (const [rule, n] of Object.entries(hitCounts).sort((a, b) => b[1] - a[1])) {
  if (rule.startsWith('信号·')) continue;
  console.log(`  ${rule.padEnd(22)} ${String(n).padStart(4)}`);
}

// ── 3 & 4. 分数分布与通过率 ───────────────────────────────────────────
const scores = fragments.map((f) => scoreSync(f).score);
console.log('\n=== 3. 分数分位 ===');
console.log(`  p50=${pct(scores, 50)}  p75=${pct(scores, 75)}  p90=${pct(scores, 90)}`
  + `  p95=${pct(scores, 95)}  p99=${pct(scores, 99)}  max=${scores.reduce((a,b)=>a>b?a:b,0)}`);

console.log('\n=== 4. 各阈值通过率（DESIGN §5.1 目标：降噪 ~90% ⇒ 通过率 ≈10%）===');
for (const t of [0.45, 0.5, 0.55, 0.6, 0.62, 0.65, 0.7]) {
  const pass = scores.filter((s) => s >= t).length;
  const mark = t === DEFAULT_THRESHOLD ? '   ← 当前默认' : '';
  console.log(`  >=${t.toFixed(2)} → ${String(pass).padStart(4)} = ${(100 * pass / fragments.length).toFixed(1)}%${mark}`);
}

// ── 护栏：正例能不能过闸 ─────────────────────────────────────────────
console.log('\n=== 5. 护栏：典型正例能否过闸（比通过率更重要）===');

// 强信号 = 自我怀疑 / 顿悟 / 吐槽（权重 0.28~0.30）。**这些必须能过闸**，
// 否则就是"阈值苛刻到只能靠叠加两类信号"，把最典型的片段滤掉了。
// ⚠️ P4-1 起：正例里的信号词**必须是实测存在的**（旧版用了 `原来` / `哎` / `绕了一大圈`，
//    那些词在 4714 个真实片段上零命中，护栏建在空气上 → 已换）。
const STRONG = [
  'Wait, this looks wrong. I should reconsider the parameter order.',
  'Hmm, actually the regex is matching too much here.',
  'Interesting — turns out the cache was stale all along.',
  '等等，这个方向其实不对，我该重新看一遍再动手。',
  '结论：参数顺序反了，这说明之前的报错根本原因就在这里。',
  // ⚠️ 2026-10-11 新增「手滑·坦白」桶时补的正例（原文取自真实语料抽样）
  '对，我搞错了 —— 我以为它们不连续，其实中间那些行我也包含进去了。',
  '好，我错了。用户是对的。让我删掉这行——它是我笔误。',
];
// 弱信号 = 只剩"犹豫权衡"（权重 0.15，**刻意设低**）。
// 这类句子过不了闸是**设计意图**，不是缺陷 —— 只作信息展示，不计入失败。
const WEAK = [
  'Maybe I should check the config before rewriting this.',
  'Perhaps the order matters here, either way works.',
];

let strongFail = false;
for (const p of STRONG) {
  const { score, reason } = scoreSync(p);
  const ok = score >= DEFAULT_THRESHOLD;
  if (!ok) strongFail = true;
  console.log(`  ${ok ? '✅' : '❌'} ${score.toFixed(2)}  ${p.slice(0, 46)}`);
  if (!ok) console.log(`        （${reason}）`);
}
console.log('  ---- 以下只有弱信号，过不了闸属预期 ----');
for (const p of WEAK) {
  const { score } = scoreSync(p);
  const pass = score >= DEFAULT_THRESHOLD;
  console.log(`  ${pass ? '（意外通过）' : '（如预期被滤）'} ${score.toFixed(2)}  ${p.slice(0, 46)}`);
}

console.log(strongFail
  ? '\n  ❌ 有**强信号**正例过不了闸 —— 阈值对单信号太苛刻，应先降阈值再回头看通过率'
  : '\n  ✅ 全部强信号正例都能过闸（弱信号被滤是设计意图）');
process.exit(strongFail ? 1 : 0);
