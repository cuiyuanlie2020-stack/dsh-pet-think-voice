/**
 * P2-1 真实语料回放核验：用**我们的 JS 实现**跑真实会话数据，复现 P0-1 的结论。
 *
 * 核验点（对应 PLAN §4 P2-1 的验收判据）：
 *   1. 能抽到思考的消息条数、长度分布（对比 P0-1：中位 1295 / 最长 14994）
 *   2. **两条通道抽出的文本是否 100% 一致**（P0-1 实测 181/181 一致）
 *   3. **空 reasoning 块是否被正确判为无思考**（返回 null，而不是空串）
 *   4. 只有单条通道有数据时能否兜底
 *
 * 入参语料由 dump_corpus.py 裁剪，只含 reasoning 文本与块类型（见该脚本注释）。
 */
import fs from 'node:fs';

import { extractFromMessageData, isMeaningfulReasoning } from
  '../lib/core/thinking-extractor.js';

const CORPUS = new URL('./out/corpus.jsonl', import.meta.url).pathname.replace(/^\//, '');

const lines = fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim() !== '');

let total = 0;
let withReasoning = 0;
let emptyReasoningBlock = 0;   // 有 reasoning 块但文本无效 → 应判 null
let onlyContent = 0;
let onlyStream = 0;
let both = 0;
let agree = 0;
let disagree = 0;
let whitespaceOnly = 0;        // 抽出的文本若是纯空白，就是 R-A 失效
const lens = [];
let longest = 0;

for (const line of lines) {
  const { data } = JSON.parse(line);
  total += 1;

  const blocks = data?.message?.content ?? [];
  const hasReasoningBlock = blocks.some((b) => b?.type === 'reasoning');
  const blockText = blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text ?? '').join('');

  const out = extractFromMessageData(data);

  if (!out) {
    if (hasReasoningBlock && !isMeaningfulReasoning(blockText)) emptyReasoningBlock += 1;
    continue;
  }

  withReasoning += 1;
  if (!isMeaningfulReasoning(out.text)) whitespaceOnly += 1;

  const len = out.text.length;
  lens.push(len);
  if (len > longest) longest = len;

  if (out.meta.bothChannelsPresent) {
    both += 1;
    if (out.meta.channelsAgree) agree += 1; else disagree += 1;
  } else if (out.meta.channel === 'content') {
    onlyContent += 1;
  } else {
    onlyStream += 1;
  }
}

lens.sort((a, b) => a - b);
const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;

console.log('===== P2-1 真实语料回放核验 =====');
console.log(`  assistant/message 载荷总数        : ${total}`);
console.log(`  成功抽出思考                      : ${withReasoning}`);
console.log(`  ├─ 两条通道都有                    : ${both}`);
console.log(`  │   ├─ 逐字一致 ✅                 : ${agree}`);
console.log(`  │   └─ 不一致 ❌                   : ${disagree}`);
console.log(`  ├─ 仅 content 块有（回落主路径）    : ${onlyContent}`);
console.log(`  └─ 仅 stream 记录有（兜底生效）     : ${onlyStream}`);
console.log(`  R-A 拦截的空 reasoning 块          : ${emptyReasoningBlock}`);
console.log(`  判为思考但实为纯空白（应为 0）      : ${whitespaceOnly}`);
console.log();
console.log(`  思考长度 最小 / 中位 / 最长        : ${lens[0] ?? 0} / ${median} / ${longest}`);

console.log();
console.log('===== 判定 =====');
const checks = [
  ['抽到思考（>0）', withReasoning > 0],
  ['两通道 0 处不一致', disagree === 0],
  ['无「纯空白被当思考」', whitespaceOnly === 0],
  ['长思考完整保留（>1000 字）', longest > 1000],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
  if (!pass) ok = false;
}
console.log();
console.log(ok ? '  ✅ P2-1 在真实语料上成立' : '  ❌ 存在未通过项，不得视为成立');
process.exit(ok ? 0 : 1);
