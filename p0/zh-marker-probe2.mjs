/**
 * P4-1 词表候选实测 · 第二轮。
 *
 * 第一轮（`p0/zh-marker-probe.mjs`）漏掉了一整类：中文思考的"有戏"形态不是
 * 情绪词，而是**自语式的判断与自我修正** —— 读完 940 个中文片段后手挑：
 *   「其实先别乱跑命令」·「不过等一下，还有一点值得确认」·「算了，为了准确」
 *   「置信度：中」·「我该确认…」·「反而是…」
 *
 * 复用第一轮语料，但候选来自**见过的原文**，不再凭想象写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = process.argv[2] ?? path.join(HERE, 'out', 'corpus-zh.jsonl');

const CANDIDATES = {
  // 自我修正 / 转折 —— 相当于英文那侧的 actually / wait / hmm（最强信号）
  自我怀疑: [
    '其实', '其实不', '实际上', '其实更', '其实先', '不过等一下', '等一下', '等等', '不对',
    '反而是', '反过', '退一步', '换个角度', '重新看', '重新考', '搞错', '弄错',
    '待实测', '未实测', '待确认', '待验证', '存疑', '疑点', '我不确定', '不确定',
    '站不住', '说不通', '讲不通', '不成立', '推翻了', '有问题', '问题在于', '这里有坑',
  ],
  // 结论 / 判定 —— "原来如此"的中文说法
  顿悟: [
    '说明', '这解释', '解释了', '意味着', '证实', '印证', '关键在于', '关键是',
    '结论', '答案是', '原因就是', '原因在于', '根本原因', '真相', '搞清楚了',
    '值得注意', '值得注意的是', '有一说一', '最重要的是', '要点是',
  ],
  // 吐槽 / 情绪 —— 中文侧天然稀薄，如实测
  吐槽: [
    '坑', '这坑', '麻烦', '有点重', '太重', '离谱', '无语', '奇怪', '诡异',
    '算了', '白折腾', '绕', '折中', '不太对', '不太行', '不太好',
  ],
  // 权衡 / 取舍 —— 中文思考里其实很常见（"要不要"/"值得"/"不过"/"或者"）
  犹豫权衡: [
    '不过', '或者', '值得', '除非', '要不要', '至少', '要么', '还是',
    '两种', '二选一', '取舍', '折中', '可以考', '不如', '也许', '或许', '嗯',
  ],
};

const lines = fs.readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean);
const frags = [];
for (const l of lines) {
  const { data } = JSON.parse(l);
  const t = (data.message.content ?? []).filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('');
  for (const f of splitFragments(t)) {
    const cjk = (f.text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const lat = (f.text.match(/[A-Za-z]/g) ?? []).length;
    if (cjk === 0) continue;
    if (cjk / (cjk + lat) < 0.3) continue;
    frags.push(f.text);
  }
}

console.log(`中文主导片段 ${frags.length} 个（第二轮候选）\n`);
const live = {};
for (const [bucket, words] of Object.entries(CANDIDATES)) {
  const rows = words.map((w) => [w, frags.filter((f) => f.includes(w)).length]).sort((a, b) => b[1] - a[1]);
  console.log(`\n【${bucket}】 DF≥5 才有效`);
  console.log('  ' + rows.map(([w, n]) => `${w}:${n}${n >= 5 ? '' : n === 0 ? '❌' : '△'}`).join(' · '));
  live[bucket] = rows.filter(([, n]) => n >= 5).map(([w]) => w);
}

console.log('\n' + '═'.repeat(60));
console.log('本轮有效词条（DF≥5）：');
for (const [b, ws] of Object.entries(live)) console.log(`  ${b}：${ws.join(' · ') || '—— 无'}`);