/**
 * 情绪表达采集器 —— 为「情绪外露」新桶找**真实存在且真的带情绪**的短语。
 *
 * 为什么不能只看 DF：大语料实测证明 DF 会被内容词骗 ——
 *   `成功` 1902 / `干净` 1389 / `简洁` 731，抽样一看全是"登录成功""工作区干净""更干净的方案"，
 *   **一个情绪都没有**。所以本脚本要求候选词**必须先被抽样看过原文**。
 *
 * 两步用法：
 *   1) 筛词：<node> p0/emotion-probe.mjs --df "词1,词2,..."
 *   2) 验语义：<node> p0/emotion-probe.mjs --show 词      # 打印命中原文（本机诊断，不入库）
 *
 * 语料：<bench-py> p0/dump-workbuddy-corpus.py zh   → p0/out/corpus-wb-zh.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = process.argv.find((a) => a.includes('.jsonl')) ?? path.join(HERE, 'out', 'corpus-wb-zh.jsonl');

// ── 候选：按用户点名的三类，尽量收"短语/句式"而非单词 ──────────────────
const CANDIDATES = {
  '吐槽·受挫': [
    '又想', '又踩', '踩坑', '又崩', '又挂', '又坏', '又炸', '又出', '又来了', '又是',
    '咬我', '坑', '麻烦', '糟糕', '离谱', '完蛋', '崩了', '挂了', '坏了',
    '凑合', '不太行', '不行', '有问题', '出问题',
  ],
  '偷懒·降级': [
    '算了', '省事', '不跑', '不测', '先搞', '简要', '不必', '够用', '差不多', '就这样',
    '先这样', '够呛', '不划算', '不值得', '犯不上', '没必要', '简化', '粗略', '大致',
    '不求', '不完美', '不求完美',
  ],
  '阴阳怪气·自嘲': [
    '有点意思', '有意思', '有趣', '好家伙', '服了', '无语', '绝了', '厉害了',
    '可真', '倒是', '挺会', '可还行', '行吧', '好吧', '随便', '无所谓', '哈哈',
    '笑死', '尴尬', '典型', '经典', '无奈', '可惜', '想太多',
  ],
  '自我标榜（反向：确认可用后决定）': [
    '一次就', '搞定', '搞定', '搞定', '漂亮', '漂亮', '搞定',
  ],
};

const lines = fs.readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean);
const thoughts = [];
for (const l of lines) {
  const { data } = JSON.parse(l);
  const t = (data.message.content ?? []).filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('');
  if (t.trim() !== '') thoughts.push(t);
}
const seen = new Set();
const frags = [];
for (const t of thoughts) {
  for (const f of splitFragments(t)) {
    const cjk = (f.text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const lat = (f.text.match(/[A-Za-z]/g) ?? []).length;
    if (cjk === 0 || cjk / (cjk + lat) < 0.3) continue;
    const key = f.text.slice(0, 60) + f.text.slice(-30);
    if (seen.has(key)) continue;
    seen.add(key);
    frags.push(f.text.replace(/\s+/g, ' ').trim());
  }
}
console.log(`中文片段 ${frags.length} 个\n`);

const showIdx = process.argv.indexOf('--show');
if (showIdx !== -1) {
  const w = process.argv[showIdx + 1];
  const hits = frags.filter((f) => f.includes(w));
  console.log(`「${w}」${hits.length} 条，抽样 14：\n`);
  const step = Math.max(1, Math.floor(hits.length / 14));
  for (let i = 0; i < hits.length && i / step < 14; i += step) console.log('  · ' + hits[i].slice(0, 92));
  process.exit(0);
}

const dfIdx = process.argv.indexOf('--df');
if (dfIdx !== -1) {
  const words = String(process.argv[dfIdx + 1] ?? '').split(',').filter(Boolean);
  const rows = words.map((w) => [w, frags.filter((f) => f.includes(w)).length]);
  for (const [w, n] of rows.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${w}${n === 0 ? '  ❌' : ''}`);
  }
  process.exit(0);
}

for (const [bucket, words] of Object.entries(CANDIDATES)) {
  const uniq = [...new Set(words)];
  const rows = uniq.map((w) => [w, frags.filter((f) => f.includes(w)).length]).sort((a, b) => b[1] - a[1]);
  console.log(`\n【${bucket}】`);
  console.log('  ' + rows.map(([w, n]) => `${w}:${n}${n === 0 ? '❌' : ''}`).join('  '));
}