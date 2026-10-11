/**
 * P4-1 词表候选实测：把手挑的**候选中文话语标记**逐个在真实中文片段上计数。
 *
 * 为什么不用 n-gram 自动挖：试过（`p0/zh-ngram.mjs`），挖出来的全是**内容词**
 * （插件 136 / 用户 133 / 安装 73…）—— 因为语料长期集中在开发主题上。
 * "有戏"判据要的是**话语标记**（等等 / 其实 / 有意思 / 不过），只能手挑候选 + 实测 DF。
 *
 * 判据：
 *   - DF ≥ 5  = 有效词条（真的存在于本模型的中文思考里）
 *   - DF = 0  = **僵尸词条**，写进词表也只是装样子
 *
 * 用法：<node> p0/zh-marker-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitFragments } from '../lib/core/fragment-splitter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = process.argv[2] ?? path.join(HERE, 'out', 'corpus-zh.jsonl');

// ── 候选：手挑，按"人类会想听的反应"分四类 ────────────────────────────
const CANDIDATES = {
  自我怀疑: [
    '等等', '等一下', '不过等一下', '不对', '其实不是', '好像不对', '反而',
    '问题在于', '但问题是', '疑点', '说不通', '存疑', '待实测', '不成立', '推翻', '站不住',
    '我之前', '我搞错', '弄错', '看错', '想错', '漏了', '忽略了',
  ],
  顿悟: [
    '有意思', '原来', '说明', '关键在于', '关键在', '果然', '这才', '真相', '答案',
    '正因', '那就是', '结论是', '找到了', '破案', '水落石出', '恍然大悟', '想通',
    '清楚了', '明白了', '有道理',
  ],
  吐槽: [
    '奇怪', '诡异', '离谱', '有点重', '太慢', '麻烦', '坑', '绕', '白折腾',
    ' cumbersome', '无语', 'emmm', 'emm', '呃', '哎',
  ],
  犹豫权衡: [
    '也许', '或者', '不过', '要不要', '值得', '权衡', '纠结', '也许可以',
    '可以考虑', '两种', '二选一', '取舍', '至少', '除非', '但是否',
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

console.log(`中文主导片段 ${frags.length} 个\n`);
console.log('DF   占比    词条              判定');
console.log('─'.repeat(56));
const result = {};
for (const [bucket, words] of Object.entries(CANDIDATES)) {
  console.log(`\n【${bucket}】`);
  const rows = [];
  for (const w of words) {
    const n = frags.filter((f) => f.includes(w)).length;
    rows.push([w, n]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  result[bucket] = rows;
  for (const [w, n] of rows) {
    const ver = n >= 5 ? '✅ 有效' : (n === 0 ? '❌ 零命中' : '△ 稀疏');
    console.log(`  ${String(n).padStart(4)} ${(100 * n / frags.length).toFixed(1).padStart(5)}%  ${w.padEnd(14)} ${ver}`);
  }
}

// ── 汇总：可直接进词表的（DF≥5） ─────────────────────────────────────
console.log('\n' + '═'.repeat(56));
console.log('可直接进词表的词条（DF≥5）：');
for (const [bucket, rows] of Object.entries(result)) {
  const ok = rows.filter(([, n]) => n >= 5).map(([w, n]) => `${w}(${n})`);
  console.log(`  ${bucket}：${ok.length ? ok.join(' · ') : '—— 无一有效'}`);
}