/**
 * `p0/emotion-sched-sim.mjs` — 量化「情绪优先」对**最终念出的内容**的影响（P4-5）
 *
 * 背景：全量放行池里"情绪句"只占 ~18.5%（问号 42.7% + 感叹号 22.7% + 呆呆眼 3.5% 都是
 * **推理**，不是情绪）。用户听完 20 条的原话是「语气和情绪都到位，**但文本内容不是
 * 情绪化的**」。改法是朗读调度里给情绪句加权（`speech-planner` 的 `emotionBonus`）。
 *
 * ⚠️ 但单测只证明"逻辑对"，**不证明改善幅度** —— 因为队列里未必有情绪句可挑
 * （20 秒频率闸 + 队列上限 3）。所以要跑这个模拟：同一份语料、同一套时间模型，
 * 只改 `emotionBonus`，看**念出去的句子里情绪占比**怎么变。
 *
 * 用法：
 *   <node> p0/emotion-sched-sim.mjs [--corpus p0/out/corpus-wb-zh.jsonl]
 *                                   [--think-ms 15000] [--show 3]
 *
 * ⚠️ 语料衍生物**不落盘**，只打印统计量（本机诊断用）。
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, scoreSync } from '../lib/core/interest-scorer.js';
import { polish } from '../lib/core/line-polisher.js';
import { detectLang } from '../lib/core/reasoning-language.js';
import { createSpeechPlanner, isEmotional } from '../lib/core/speech-planner.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CORPUS = flag('--corpus', 'p0/out/corpus-wb-zh.jsonl');
/** 一次"模型思考"耗时的假设。语料没有时间戳，所以只能给一个常量 —— 但**对照实验不受它影响**
 *  （两边用同一个值），它只决定"20s 闸到底卡不卡得住"。15s 是连续 vibecoding 的常见量级。 */
const THINK_MS = Number(flag('--think-ms', '15000'));
const SHOW = Number(flag('--show', '3'));

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

// ── ① 把语料变成"每一次思考产出的候选批" ─────────────────────────────
const batches = [];
const rl = createInterface({ input: createReadStream(CORPUS, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  const text = reasoningOf(line);
  if (text === null) continue;
  const batch = [];
  for (const fragment of splitFragments(text)) {
    const result = scoreSync(fragment.text);
    if (result.score < DEFAULT_THRESHOLD) continue;
    const { line: picked } = polish(fragment.text, {
      score: result.score, buckets: result.buckets, matches: result.matches,
    });
    if (!picked) continue;
    // 与 listen-kit 同一道语种过滤：真机 zh 策略下以中文思考，英文片段不代表生产
    const lang = detectLang(picked.text);
    if (lang !== 'zh' && lang !== 'mixed') continue;
    batch.push({ text: picked.text, score: picked.score, emotion: picked.emotion });
  }
  batches.push(batch);
}

const poolAll = batches.flat();
const poolEmo = poolAll.filter((x) => isEmotional(x.emotion));
console.log(`语料 ${CORPUS}`);
console.log(`思考批 ${batches.length} · 候选池 ${poolAll.length} · 其中情绪句 ${poolEmo.length}`
  + `（${(poolEmo.length / Math.max(1, poolAll.length) * 100).toFixed(1)}%）`);
console.log(`时间模型：每次思考 ${THINK_MS}ms；频率闸 20000ms；队列上限 3\n`);

// ── ② 同一份输入跑两种配置 ──────────────────────────────────────────
function runSim(emotionBonus) {
  const planner = createSpeechPlanner({ emotionBonus });
  let now = 0;
  const spoken = [];
  for (const batch of batches) {
    for (const item of batch) planner.submit(item, now);
    now += THINK_MS;
    // 宿主每 2s 问一次；这里每次思考后问一次，等价于"这段时间里能放几条就放几条"
    for (;;) {
      const task = planner.next(now);
      if (!task) break;
      spoken.push(task);
    }
  }
  const emo = spoken.filter((t) => isEmotional(t.emotion));
  return { spoken, emo };
}

const pct = (n, d) => (d === 0 ? '0.0' : (n / d * 100).toFixed(1));

console.log('=== 扫档（同一份语料、同一套时间模型，只改情绪加权）===');
console.log('| emotionBonus | 出句总数 | 其中情绪句 | 情绪占比 | 说明 |');
console.log('|---|---|---|---|---|');
console.log(`| —（参考） | ${poolAll.length} | ${poolEmo.length} | ${pct(poolEmo.length, poolAll.length)}% | 候选池自然占比 |`);
for (const bonus of [0, 0.1, 0.2, 0.3, 0.4, 0.6]) {
  const r = runSim(bonus);
  const note = bonus === 0 ? '**改动前**（只按分数）'
    : (bonus === 0.2 ? '**当前默认**' : (bonus >= 0.4 ? '⚠️ 开始压过"明显更高的分"' : ''));
  console.log(`| ${bonus.toFixed(1)} | ${r.spoken.length} | ${r.emo.length} | ${pct(r.emo.length, r.spoken.length)}% | ${note} |`);
}

const base = runSim(0);
const tuned = runSim(undefined);   // undefined ⇒ 用默认 EMOTION_BONUS

if (SHOW > 0) {
  // 只打印**新增**的情绪句（改动前没念、改动后念了的），这才是这次改动的净收益
  const before = new Set(base.spoken.map((t) => t.text));
  const gained = tuned.emo.filter((t) => !before.has(t.text));
  console.log(`\n=== 净新增的情绪句（改动后才被念到的）共 ${gained.length} 条，示 ${Math.min(SHOW, gained.length)} 条 ===`);
  for (const t of gained.slice(0, SHOW)) {
    console.log(`  [${t.emotion} ${t.score.toFixed(2)}] ${t.text.slice(0, 60)}`);
  }
}
