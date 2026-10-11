/**
 * 大样本候选词探测 —— 专攻**用户反馈里那三类**：吐槽 / 偷懒 / 阴阳怪气（含自我标榜）。
 *
 * 背景：用户 2026-10-11 反馈「模型思考往往会吐槽或者偷懒，还很会阴阳怪气，
 * 这点很折磨，也是很需要宠物表达的」。而 P4-1 那版词表里「吐槽」桶只有
 * `坑`(1833) / `weird` / `awkward` / `messy` —— 明显没覆盖这三类。
 *
 * 本脚本在 **37.9 万个真实中文片段**（WorkBuddy 全库，见 dump-workbuddy-corpus.py）
 * 上逐个测 DF，并**对每个命中的词抽样原文**（本机诊断），
 * 用来判断"这个词命中的是不是真的在吐槽，还是只是在讨论内容"。
 *
 * 用法：<node> p0/wb-marker-probe.mjs [语料] [--show 词]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = process.argv[2]?.startsWith('p0/') || process.argv[2]?.includes('.jsonl')
  ? process.argv[2]
  : path.join(HERE, 'out', 'corpus-wb-zh.jsonl');
const SHOW = process.argv.includes('--show')
  ? process.argv[process.argv.indexOf('--show') + 1]
  : null;

// ── 候选：按用户点名的三类 + 我补的"自我标榜/严谨标记" ────────────────
const CANDIDATES = {
  '吐槽·反感': [
    '坑', '麻烦', '讨厌', '烦人', '烦死', '又来了', '又是', '怎么又', '搞什么', '什么鬼',
    '见鬼', '糟糕', '糟了', '完蛋', '崩了', '挂了', '坏了', '离谱', '奇葩', '恶心',
  ],
  '吐槽·阴阳怪气': [
    '呵呵', '哈哈', '笑死', '服了', '麻了', '无语', '醉了', '绝了', '好家伙', '居然',
    '竟然', '可真', '倒是', '挺会', '真行', '厉害', '真棒', '有意思', '有趣', '行吧',
    '好吧', '算了', '随便', '无所谓',
  ],
  '偷懒·回避': [
    '懒得', '不想', '跳过', '略过', '先不管', '不用管', '不必', '不重要', '无所谓',
    '简化', '敷衍', '凑合', '差不多', '大概', '够了', '就这样', '先这样', '省事',
    '省点', '先不做',
  ],
  '自我标榜': [
    '搞定', '成功', '完美', '漂亮', '优秀', '高效', '优雅', '简洁', '干净', '很稳',
    '没问题', '轻松', '一次就', '总算',
  ],
  '严谨标记（中立）': [
    '置信度', '待实测', '未实测', '待确认', '待验证', '不确定', '我猜', '推测',
  ],
};

// ── 读语料并按片段去重（同一条思考会因 provider 重试重复出现）──────
const thoughts = [];
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const { data } = JSON.parse(line);
  const t = (data?.message?.content ?? [])
    .filter((b) => b?.type === 'reasoning')
    .map((b) => b.text ?? '')
    .join('');
  if (t.trim() !== '') thoughts.push(t);
}

const seenFrag = new Set();
const frags = [];
for (const t of thoughts) {
  for (const f of splitFragments(t)) {
    const cjk = (f.text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const lat = (f.text.match(/[A-Za-z]/g) ?? []).length;
    if (cjk === 0) continue;
    if (cjk / (cjk + lat) < 0.3) continue;
    const key = f.text.slice(0, 80) + f.text.slice(-40);
    if (seenFrag.has(key)) continue;
    seenFrag.add(key);
    frags.push(f.text.replace(/\s+/g, ' ').trim());
  }
}

console.log(`思考 ${thoughts.length} 条 → 去重后中文片段 ${frags.length} 个\n`);

if (SHOW) {
  const hits = frags.filter((f) => f.includes(SHOW));
  console.log(`「${SHOW}」命中 ${hits.length} 条，抽样 20（本机诊断，不入库）：\n`);
  const step = Math.max(1, Math.floor(hits.length / 20));
  for (let i = 0; i < hits.length && i / step < 20; i += step) {
    console.log('  · ' + hits[i].slice(0, 96));
  }
  process.exit(0);
}

// 只报 DF，不打印原文（批量筛词用；避免上面 --show 的 20 行长输出）
const dfArg = process.argv.indexOf('--df');
if (dfArg !== -1) {
  const words = String(process.argv[dfArg + 1] ?? '').split(',').filter(Boolean);
  console.log(`中文片段 ${frags.length} 个 · 批量 DF\n`);
  const rows = words.map((w) => [w, frags.filter((f) => f.includes(w)).length]);
  for (const [w, n] of rows.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${w}${n === 0 ? '  ❌' : n < 20 ? '  ·' : ''}`);
  }
  process.exit(0);
}

const rows = [];
for (const [bucket, words] of Object.entries(CANDIDATES)) {
  console.log(`\n【${bucket}】 DF≥20 才算"这个模型真的这么说"`);
  const sub = [];
  for (const w of words) {
    const n = frags.filter((f) => f.includes(w)).length;
    sub.push([w, n]);
  }
  sub.sort((a, b) => b[1] - a[1]);
  rows.push([bucket, sub]);
  console.log('  ' + sub.map(([w, n]) => `${w}:${n}${n >= 20 ? '' : n === 0 ? '❌' : '·'}`).join('  '));
}

console.log('\n' + '═'.repeat(70));
console.log('可用的新词条（DF≥20）：');
for (const [bucket, sub] of rows) {
  const ok = sub.filter(([, n]) => n >= 20).map(([w, n]) => `${w}(${n})`);
  console.log(`  ${bucket}：${ok.join(' · ') || '—— 无'}`);
}
console.log('\n查某个词的原文：<node> p0/wb-marker-probe.mjs <语料> --show 词');