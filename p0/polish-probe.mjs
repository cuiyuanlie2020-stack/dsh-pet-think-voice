/**
 * `p0/polish-probe.mjs` — P4-2 拟人化（`line-polisher`）效果体检 · **不入库**
 *
 * 用真实语料跑一遍完整链路（切分 → 打分 → 拟人化），回答四个问题：
 *   ① 拟人化**拦掉了多少**已过阈的片段、都是什么原因？
 *   ② 它**改动了多少**片段（清洗/裁齐），改动后的文本长什么样？
 *   ③ 表情标签的**分布**是否合理（会不会全都演同一个表情）？
 *   ④ 有没有"拦过头"——把本来能念的好句子也拦了？
 *
 * 用法：
 *   <node> p0/polish-probe.mjs [--corpus p0/out/corpus-wb-zh.jsonl] [--show 12] [--out p0/out/polish-report.md]
 *
 * ⚠️ 默认**只打印统计量**；`--show N` 才打印 N 条原文样例（本机诊断用，永不入库）。
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, scoreSync } from '../lib/core/interest-scorer.js';
import { polish } from '../lib/core/line-polisher.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CORPUS = flag('--corpus', 'p0/out/corpus-wb-zh.jsonl');
const SHOW = Number(flag('--show', '0'));
const OUT = flag('--out', 'p0/out/polish-report.md');

/** 从一行语料里抽 reasoning 原文（结构：data.message.content[].type==='reasoning'） */
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

const stats = {
  reasonings: 0, fragments: 0, passed: 0,
  accepted: 0, rejected: 0, changed: 0,
  rejectedReasons: new Map(),
  emotions: new Map(),
  changes: new Map(),
  lengths: [],
  rejectedLengths: [],
  emotionWords: new Map(),
  beforeAfter: [],
  rejectedSamples: [],
};

const seen = new Set();
const rl = createInterface({ input: createReadStream(CORPUS, { encoding: 'utf8' }), crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  const text = reasoningOf(line);
  if (!text) continue;
  // 去重（同一段思考在被截断的文件里可能出现两次）
  const key = `${text.length}:${text.slice(0, 64)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  stats.reasonings += 1;

  for (const fragment of splitFragments(text)) {
    stats.fragments += 1;
    const scored = scoreSync(fragment.text);
    if (scored.score < DEFAULT_THRESHOLD) continue;
    stats.passed += 1;

    const { line: out, reason, changes } = polish(fragment.text, {
      score: scored.score, buckets: scored.buckets, matches: scored.matches,
    });

    if (!out) {
      stats.rejected += 1;
      stats.rejectedReasons.set(reason, (stats.rejectedReasons.get(reason) ?? 0) + 1);
      stats.rejectedLengths.push(fragment.text.length);
      if (stats.rejectedSamples.length < 400) {
        stats.rejectedSamples.push({ reason, text: fragment.text, score: scored.score });
      }
      continue;
    }

    stats.accepted += 1;
    stats.emotions.set(out.emotion ?? '(无)', (stats.emotions.get(out.emotion ?? '(无)') ?? 0) + 1);
    // 逐词归因：这个表情是被哪个词推出来的？（用来发现"词与表情不搭"）
    for (const [bucket, words] of Object.entries(scored.matches ?? {})) {
      for (const w of words) {
        const key = `${out.emotion ?? '(无)'} ← ${bucket}:${w}`;
        stats.emotionWords.set(key, (stats.emotionWords.get(key) ?? 0) + 1);
      }
    }
    stats.lengths.push(out.text.length);
    for (const c of changes) stats.changes.set(c, (stats.changes.get(c) ?? 0) + 1);
    if (changes.length > 0) {
      stats.changed += 1;
      if (stats.beforeAfter.length < 4000) {
        stats.beforeAfter.push({
          before: fragment.text, after: out.text, emotion: out.emotion, changes, score: scored.score,
        });
      }
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const pct = (a, b) => (b === 0 ? '0.00' : ((a / b) * 100).toFixed(2));
const quantile = (arr, q) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const top = (map, n = 12) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const L = [];
L.push('# P4-2 拟人化（line-polisher）真实语料体检');
L.push('');
L.push(`> 语料：\`${CORPUS}\` · 阈值 ${DEFAULT_THRESHOLD} · 生成脚本 \`p0/polish-probe.mjs\``);
L.push('> ⚠️ 本文件与语料派生物**均不入库**（p0/out/ 已被 gitignore）。');
L.push('');
L.push('## 1. 总量');
L.push('');
L.push('| 指标 | 值 |');
L.push('|---|---|');
L.push(`| 去重后思考条数 | ${stats.reasonings} |`);
L.push(`| 切出片段数 | ${stats.fragments} |`);
L.push(`| 过阈（≥${DEFAULT_THRESHOLD}） | ${stats.passed}（${pct(stats.passed, stats.fragments)}%） |`);
L.push(`| 拟人化**放行** | ${stats.accepted}（占过阈 ${pct(stats.accepted, stats.passed)}%） |`);
L.push(`| 拟人化**拒收** | ${stats.rejected}（占过阈 ${pct(stats.rejected, stats.passed)}%） |`);
L.push(`| 其中文本**被改动**的 | ${stats.changed}（占放行 ${pct(stats.changed, stats.accepted)}%） |`);
L.push(`| 放行文本长度 | p50=${quantile(stats.lengths, 0.5)} · p90=${quantile(stats.lengths, 0.9)} · max=${stats.lengths.length ? Math.max(...stats.lengths) : 0} |`);
L.push('');
L.push('## 2. 拒收原因分布');
L.push('');
L.push('| 原因 | 条数 | 占拒收 |');
L.push('|---|---|---|');
for (const [reason, n] of top(stats.rejectedReasons, 20)) {
  L.push(`| ${reason} | ${n} | ${pct(n, stats.rejected)}% |`);
}
L.push('');
L.push('## 3. 改动动作分布');
L.push('');
L.push('| 动作 | 条数 |');
L.push('|---|---|');
for (const [c, n] of top(stats.changes, 20)) L.push(`| ${c} | ${n} |`);
L.push('');
L.push('## 4. 表情标签分布');
L.push('');
L.push('| 表情 | 条数 | 占放行 |');
L.push('|---|---|---|');
for (const [e, n] of top(stats.emotions, 25)) L.push(`| ${e} | ${n} | ${pct(n, stats.accepted)}% |`);
L.push('');
L.push('### 4.1 逐词归因：这个表情是被哪个词推出来的');
L.push('');
L.push('> 用来发现「**词与表情不搭**」—— 例如 `实际上` 是陈述性副词，推 `问号` 就是让宠物一脸疑惑地念平铺直叙。');
L.push('');
L.push('| 表情 ← 桶:词 | 条数 |');
L.push('|---|---|');
for (const [k, n] of top(stats.emotionWords, 25)) L.push(`| ${k} | ${n} |`);
L.push('');
L.push('### 4.2 拒收片段的长度分布（判断是不是切分器硬切留下的半句）');
L.push('');
L.push(`拒收样本长度：p50=${quantile(stats.rejectedLengths, 0.5)} · p90=${quantile(stats.rejectedLengths, 0.9)} · max=${stats.rejectedLengths.length ? Math.max(...stats.rejectedLengths) : 0} · 长度≥175 的占 ${pct(stats.rejectedLengths.filter((n) => n >= 175).length, stats.rejectedLengths.length)}%`);
L.push('');

if (SHOW > 0) {
  L.push(`## 5. 样例（前 ${SHOW} 条被改动的 before → after）`);
  L.push('');
  L.push('| # | 分数 | 原文（前） | 拟人化后（后） | 表情 | 动作 |');
  L.push('|---|---|---|---|---|---|');
  stats.beforeAfter.slice(0, SHOW).forEach((s, i) => {
    const clean = (t) => t.replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 70);
    L.push(`| ${i + 1} | ${s.score.toFixed(2)} | ${clean(s.before)} | ${clean(s.after)} | ${s.emotion ?? '—'} | ${s.changes.join('+')} |`);
  });
  L.push('');
  L.push(`## 6. 拒收样例（前 ${SHOW} 条）`);
  L.push('');
  L.push('| # | 分数 | 原因 | 原文 |');
  L.push('|---|---|---|---|');
  stats.rejectedSamples.slice(0, SHOW).forEach((s, i) => {
    const clean = (t) => t.replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 90);
    L.push(`| ${i + 1} | ${s.score.toFixed(2)} | ${s.reason} | ${clean(s.text)} |`);
  });
  L.push('');
}

writeFileSync(OUT, L.join('\n'), 'utf8');

console.log(`思考=${stats.reasonings} 片段=${stats.fragments} 过阈=${stats.passed}`);
console.log(`放行=${stats.accepted} 拒收=${stats.rejected} 改动=${stats.changed}`);
console.log('拒收原因：', JSON.stringify(Object.fromEntries(top(stats.rejectedReasons, 10))));
console.log('表情分布：', JSON.stringify(Object.fromEntries(top(stats.emotions))));
console.log(`报告 → ${OUT}`);

// 供追踪校验：把关键计数也打到 stdout 之外的文件，便于与人眼看到的数字对照
const summary = {
  reasonings: stats.reasonings, fragments: stats.fragments, passed: stats.passed,
  accepted: stats.accepted, rejected: stats.rejected, changed: stats.changed,
  rejectedReasons: Object.fromEntries(top(stats.rejectedReasons, 30)),
  emotions: Object.fromEntries(top(stats.emotions, 30)),
};
writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(summary, null, 2), 'utf8');
