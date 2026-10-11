/**
 * `p0/listen-kit.mjs` — **P4-5 听感验收素材包**生成器
 *
 * P4-5 的出口判据是"**连续用 30 分钟不觉得吵**"、以及 DESIGN 里那句
 * "抽样 20 条，噪声片段不朗读" —— 这是**主观**判据，只能人听。
 * 这个脚本的任务就是把那个判据变成**几分钟就能给结论**的东西：
 *
 *   ① 用真实语料跑完整链路（切分 → 打分 → 拟人化），只留**过阈且放行**的片段；
 *   ② **随机抽 N 条**（⚠️ 必须随机 —— 语料按会话顺序排列，取前 N 条严重有偏，
 *      项目在 `顺手` 那个词上已经栽过一次）；
 *   ③ 按项目定稿音色**合成 mp3**（`zh-CN-XiaoyiNeural` + `+30Hz`，与真机一致）；
 *   ④ 生成一个自包含的播放页，逐条打勾（像话 / 不像话），底部一键导出结论。
 *
 * 用法：
 *   <node> p0/listen-kit.mjs [--corpus p0/out/corpus-wb-zh.jsonl] [--n 20]
 *                            [--seed 20261011] [--outdir p0/out/listen-kit]
 *
 * ⚠️ 脚本**入库**（可复现的验收工具）；它产出的 `p0/out/listen-kit/`（含 mp3）
 *    是**真实语料派生物**，与 `p0/sessions/` 同级，**永不入库**。
 */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { splitFragments } from '../lib/core/fragment-splitter.js';
import { DEFAULT_THRESHOLD, scoreSync } from '../lib/core/interest-scorer.js';
import { polish } from '../lib/core/line-polisher.js';
import { detectLang } from '../lib/core/reasoning-language.js';
import { createSpeechPlanner, isEmotional } from '../lib/core/speech-planner.js';
import { synthesize } from './edge-tts-zerodep.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CORPUS = flag('--corpus', 'p0/out/corpus-wb-zh.jsonl');
const N = Number(flag('--n', '20'));
const SEED = Number(flag('--seed', '20261011'));
/**
 * `sched` = 走**真实调度**（20s 频率闸 + 队列上限 3 + 情绪优先）之后，她**真正会念**的那些；
 * `pool`  = 直接从放行池随机抽（不经过调度）。
 * ⚠️ 验证「情绪优先」这类**调度层**改动必须用 `sched` —— 从池子里抽是看不出来的。
 */
const MODE = flag('--mode', 'sched');
/** `sched` 模式的时间模型：一次思考的耗时。语料没有时间戳，只能给常量 ——
 *  它只决定"20s 闸卡不卡得住"，不改变对照结论。 */
const THINK_MS = Number(flag('--think-ms', '15000'));
const OUTDIR = flag('--outdir', 'p0/out/listen-kit-' + (MODE === 'sched' ? 'sched' : 'pool'));

/**
 * 确定性伪随机（xorshift32）。
 *
 * ⚠️ 不用 `Math.random()`：抽样必须**可复现** —— 换个人跑、或者我明天重跑，
 *    必须抽出同一批样本，否则"我上次听的那 20 条"和"这次这 20 条"对不上。
 *    项目里所有抽样工具都遵守这条（见 `p0/out/candid-samples.mjs`）。
 */
function makeRng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 从一行语料里抽 reasoning 原文（结构：`data.message.content[].type==='reasoning'`） */
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

// ── ① 全量跑链路，收集"过阈且放行"的片段 ─────────────────────────────
const batches = [];
let reasonings = 0;
let fragments = 0;
let passed = 0;
let rejected = 0;
let skippedLang = 0;

const rl = createInterface({ input: createReadStream(CORPUS, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  const text = reasoningOf(line);
  if (text === null) continue;
  reasonings += 1;
  const batch = [];
  for (const fragment of splitFragments(text)) {
    fragments += 1;
    const result = scoreSync(fragment.text);
    if (result.score < DEFAULT_THRESHOLD) continue;
    passed += 1;
    const { line: picked } = polish(fragment.text, {
      score: result.score, buckets: result.buckets, matches: result.matches,
    });
    if (!picked) {
      rejected += 1;
      continue;
    }
    // ⚠️ **语种过滤（近似生产条件）**：真机上 `speech.language=zh` 会把系统提示改成
    //    "让思考用中文"，所以生产里几乎只出现中文片段。而这份历史语料是**注入生效之前**
    //    的，含大量英文思考 —— 第一次抽样 20 条里就有 7 条英文。用中文音色念它们会明显
    //    走音，听感结论会被整批带偏。所以只收 `zh` 与 `mixed`（模型夹几个英文词是常态）。
    const lang = detectLang(picked.text);
    if (lang !== 'zh' && lang !== 'mixed') {
      skippedLang += 1;
      continue;
    }
    batch.push({ text: picked.text, emotion: picked.emotion, score: picked.score, lang });
  }
  batches.push(batch);
}

console.log(`语料 ${CORPUS}`);
const poolAll = batches.flat();
let pool = poolAll;
let modeNote = '';
if (MODE === 'sched') {
  const planner = createSpeechPlanner();
  let now = 0;
  const spoken = [];
  for (const batch of batches) {
    for (const item of batch) planner.submit(item, now);
    now += THINK_MS;
    for (;;) {
      const task = planner.next(now);
      if (!task) break;
      spoken.push(task);
    }
  }
  pool = spoken;
  const emo = spoken.filter((t) => isEmotional(t.emotion));
  modeNote = `\n走调度后实际念出 ${spoken.length} 条，其中情绪句 ${emo.length}`
    + `（${(emo.length / Math.max(1, spoken.length) * 100).toFixed(1)}%）`;
}

console.log(`思考 ${reasonings} 条 → 片段 ${fragments} → 过阈 ${passed} → 拟人化拒 ${rejected}`
  + ` → 非中文剔除 ${skippedLang} → 放行池 ${poolAll.length}` + modeNote);
if (pool.length === 0) {
  console.error('放行池是空的，检查语料路径与阈值。');
  process.exit(1);
}

// ── ② 随机抽 N 条（可复现）───────────────────────────────────────────
const rng = makeRng(SEED);
const pickedIdx = new Set();
const wanted = Math.min(N, pool.length);
while (pickedIdx.size < wanted) pickedIdx.add(Math.floor(rng() * pool.length));
const samples = [...pickedIdx].sort((a, b) => a - b).map((i) => pool[i]);
console.log(`随机抽 ${samples.length} 条（seed=${SEED}，可复现）`);

// ── ③ 逐条合成（与真机同音色：Xiaoyi +30Hz）──────────────────────────
mkdirSync(OUTDIR, { recursive: true });
const items = [];
let synthesized = 0;
for (const [i, s] of samples.entries()) {
  const name = String(i + 1).padStart(2, '0') + '.mp3';
  try {
    const r = await synthesize(s.text, { voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz' });
    writeFileSync(join(OUTDIR, name), r.audio);
    synthesized += 1;
    items.push({ ...s, file: name, bytes: r.audio.length });
    process.stdout.write(`  ${name}  ${r.audio.length} 字节  ${s.emotion ?? '—'}  ${s.text.slice(0, 26)}…\n`);
  } catch (error) {
    items.push({ ...s, file: null, error: String(error && error.message) });
    process.stdout.write(`  ${name}  合成失败：${String(error && error.message)}\n`);
  }
}

// ── ④ 生成播放页（自包含：数据内联，勾选存 localStorage）──────────────
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rows = items.map((it, i) => [
  '<li class="row" data-i="' + i + '">',
  '  <div class="head">',
  '    <span class="no">' + String(i + 1).padStart(2, '0') + '</span>',
  '    <span class="emo">' + esc(it.emotion ?? '（不演表情）') + '</span>',
  '    <span class="score">' + it.score.toFixed(2) + '</span>',
  '    <span class="len">' + it.text.length + ' 字</span>',
  '    <span class="verdict">',
  '      <button data-v="ok">像话</button>',
  '      <button data-v="no">不像话</button>',
  '    </span>',
  '  </div>',
  it.file
    ? '  <audio controls preload="none" src="' + it.file + '"></audio>'
    : '  <div class="err">合成失败：' + esc(it.error) + '</div>',
  '  <p class="text">' + esc(it.text) + '</p>',
  '</li>',
].join('\n')).join('\n');

const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<title>桌宠听感验收 · ' + items.length + ' 条</title>',
  '<style>',
  ':root{color-scheme:light}',
  'body{margin:0;padding:22px 18px 80px;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1c2330}',
  '.wrap{max-width:820px;margin:0 auto}',
  'h1{font-size:17px;margin:0 0 4px}',
  '.sub{font-size:12px;opacity:.62;margin-bottom:16px}',
  'ul{list-style:none;margin:0;padding:0}',
  '.row{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:11px 13px;margin-bottom:9px}',
  '.row[data-v=ok]{border-color:#3fa66a;box-shadow:inset 3px 0 0 #3fa66a}',
  '.row[data-v=no]{border-color:#d06a6a;box-shadow:inset 3px 0 0 #d06a6a}',
  '.head{display:flex;align-items:center;gap:9px;font-size:12px;margin-bottom:7px;flex-wrap:wrap}',
  '.no{font-weight:700;opacity:.45;font-variant-numeric:tabular-nums}',
  '.emo{background:#eef2ff;color:#3b5bdb;border-radius:999px;padding:1px 9px}',
  '.score{opacity:.5;font-variant-numeric:tabular-nums}',
  '.len{opacity:.5}',
  '.verdict{margin-left:auto;display:flex;gap:5px}',
  '.verdict button{font:inherit;font-size:11px;padding:2px 10px;border-radius:999px;border:1px solid #ccd2dc;background:#fafbfc;cursor:pointer}',
  '.verdict button:hover{background:#eef2ff}',
  'audio{width:100%;height:32px;margin:2px 0 6px}',
  '.text{margin:0;white-space:pre-wrap;word-break:break-word}',
  '.err{color:#b03030;font-size:12px}',
  'footer{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #e3e6ec;padding:10px 18px;display:flex;gap:12px;align-items:center;justify-content:center;font-size:13px}',
  'footer b{font-variant-numeric:tabular-nums}',
  'footer button{font:inherit;padding:5px 14px;border-radius:8px;border:1px solid #ccd2dc;background:#fafbfc;cursor:pointer}',
  '</style></head><body><div class="wrap">',
  '<h1>桌宠听感验收</h1>',
  '<div class="sub">' + items.length + ' 条随机样本（'
    + (MODE === 'sched' ? '**走真实调度**后她真正会念的' : '直接从放行池抽的')
    + '）· 音色与真机一致（Xiaoyi +30Hz）',
  ' · 判据：<b>这句话她念出来，像不像话？</b>（不是"有没有信息"，是"听着自不自然"）</div>',
  '<ul>' + rows + '</ul>',
  '</div>',
  '<footer>',
  '  <span>像话 <b id="c-ok">0</b> / 不像话 <b id="c-no">0</b> / 共 <b>' + items.length + '</b></span>',
  '  <button id="dump">导出结论</button>',
  '  <button id="clear">清空</button>',
  '</footer>',
  '<script>',
  'var KEY="dsh-pet-listen-kit";',
  'var saved=JSON.parse(localStorage.getItem(KEY)||"{}");',
  'function paint(){',
  '  var ok=0,no=0;',
  '  document.querySelectorAll(".row").forEach(function(r){',
  '    var v=saved[r.dataset.i]||"";',
  '    if(v)r.setAttribute("data-v",v); else r.removeAttribute("data-v");',
  '    r.querySelectorAll("[data-v]").forEach(function(b){b.style.background=(b.dataset.v===v)?"#dfe7ff":"#fafbfc";});',
  '    if(v==="ok")ok++; if(v==="no")no++;',
  '  });',
  '  document.getElementById("c-ok").textContent=ok;',
  '  document.getElementById("c-no").textContent=no;',
  '}',
  'document.addEventListener("click",function(e){',
  '  var b=e.target.closest("[data-v]"); if(!b)return;',
  '  var i=b.closest(".row").dataset.i, v=b.dataset.v;',
  '  if(saved[i]===v)delete saved[i]; else saved[i]=v;',
  '  localStorage.setItem(KEY,JSON.stringify(saved)); paint();',
  '});',
  'document.getElementById("clear").onclick=function(){saved={};localStorage.removeItem(KEY);paint();};',
  'document.getElementById("dump").onclick=async function(){',
  '  var ok=[],no=[];',
  '  document.querySelectorAll(".row").forEach(function(r){',
  '    var v=saved[r.dataset.i]; if(!v)return;',
  '    var t=r.querySelector(".text").textContent;',
  '    (v==="ok"?ok:no).push("- "+(r.querySelector(".no").textContent)+". "+t);',
  '  });',
  '  var md="# 听感验收结论\\n\\n## 像话（"+ok.length+" 条）\\n"+(ok.join("\\n")||"（无）")',
  '    +"\\n\\n## 不像话（"+no.length+" 条）\\n"+(no.join("\\n")||"（无）")+"\\n";',
  '  try{await navigator.clipboard.writeText(md);alert("已复制到剪贴板，粘给我就行");}',
  '  catch(e){prompt("复制下面这段：",md);}',
  '};',
  'paint();',
  '</script></body></html>',
].join('\n');

const indexPath = join(OUTDIR, 'index.html');
writeFileSync(indexPath, html, 'utf8');

console.log(`\n合成 ${synthesized}/${items.length} 条`);
console.log(`✅ 播放页：${indexPath}`);
console.log('（勾完点「导出结论」会自动拼成 markdown 放进剪贴板）');
