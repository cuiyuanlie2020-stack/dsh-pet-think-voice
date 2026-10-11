/**
 * P0-2 验证：零依赖 Edge TTS 在**真实思考片段**上的表现 + Node 侧资源画像
 *
 * 覆盖两件事：
 *   A. 可播放性：5 条真实场景台词（中英混读）+ 1 条连读长样本 → 音频文件
 *   B. 资源画像：冷启动/热态墙钟、CPU、RSS 增量、下行字节
 *      —— 这一项同时填补 docs/RESOURCE-BUDGET.md 第 6.1 节的未测项 #5
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, secMsGec } from './edge-tts-zerodep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const VOICE_OPTS = { voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz' };

const LINES = [
  'powersell又想咬我了',
  '哦——原来 param 是必填的，难怪一直报 undefined。',
  '等等，这个正则怎么写都不对，我是不是把方向搞反了？',
  '嗯……这个 bug 藏得真深，我绕了一大圈才找到。',
  '好，思路清晰了，let me 把这个 function 重写一下。',
];

const rssMb = () => process.memoryUsage().rss / 1048576;

const baseRss = rssMb();
const cpu0 = process.cpuUsage();
console.log(`[基线] 进程 RSS = ${baseRss.toFixed(1)} MB；GEC = ${secMsGec().slice(0, 12)}…\n`);
console.log('== A. 合成真实思考片段 ==');
console.log('   #  字数   墙钟     CPU     音频      段数');
const rows = [];
for (let i = 0; i < LINES.length; i++) {
  const c0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  const r = await synthesize(LINES[i], VOICE_OPTS);
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const c1 = process.cpuUsage();
  const cpuMs = ((c1.user - c0.user) + (c1.system - c0.system)) / 1000;
  const file = path.join(OUT, `zerodep_line${i + 1}.mp3`);
  fs.writeFileSync(file, r.audio);
  rows.push({ i: i + 1, chars: LINES[i].length, wall, cpuMs, bytes: r.audio.length, chunks: r.chunks, file });
  console.log(
    `  ${String(i + 1).padStart(2)}  ${String(LINES[i].length).padStart(3)}  ${wall.toFixed(0).padStart(6)}ms  ${cpuMs.toFixed(0).padStart(5)}ms  ${(r.audio.length / 1024).toFixed(1).padStart(6)}KB  ${String(r.chunks).padStart(4)}`,
  );
}

// 长样本：5 句连读
const longText = LINES.join('');
const t0 = process.hrtime.bigint();
const longR = await synthesize(longText, VOICE_OPTS);
const longWall = Number(process.hrtime.bigint() - t0) / 1e6;
fs.writeFileSync(path.join(OUT, 'zerodep_long.mp3'), longR.audio);
console.log(
  `  --- 连读 ${longText.length} 字：${longWall.toFixed(0)}ms，${(longR.audio.length / 1024).toFixed(1)}KB，${longR.chunks} 段`,
);

const endRss = rssMb();
const cpuTotal = process.cpuUsage(cpu0);
const cpuTotalMs = (cpuTotal.user + cpuTotal.system) / 1000;

console.log('\n== B. Node 侧资源画像 ==');
const hot = rows.slice(1);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`  墙钟      冷启动(第1条) ${rows[0].wall.toFixed(0)}ms  |  热态均值 ${avg(hot.map((r) => r.wall)).toFixed(0)}ms`);
console.log(`  CPU       逐条中位 ${[...rows].sort((a, b) => a.cpuMs - b.cpuMs)[2].cpuMs.toFixed(0)}ms  |  合计 ${cpuTotalMs.toFixed(0)}ms`);
console.log(`  音频体积  中位 ${(rows.map((r) => r.bytes).sort((a, b) => a - b)[2] / 1024).toFixed(1)}KB  |  连读 ${(longR.audio.length / 1024).toFixed(1)}KB`);
console.log(`  进程 RSS  ${baseRss.toFixed(1)} → ${endRss.toFixed(1)} MB （增量 ${(endRss - baseRss).toFixed(1)} MB）`);
console.log(`  吞吐      ${avg(rows.map((r) => r.chars / (r.wall / 1000))).toFixed(1)} 字/秒  |  ${avg(rows.map((r) => r.bytes / 1024 / (r.wall / 1000))).toFixed(1)} KB/秒`);

fs.writeFileSync(
  path.join(OUT, 'p02-report.json'),
  JSON.stringify({ voiceOpts: VOICE_OPTS, baseRss, endRss, cpuTotalMs, rows, long: { chars: longText.length, wall: longWall, bytes: longR.audio.length, chunks: longR.chunks } }, null, 2),
);
console.log('\n明细 → p0/out/p02-report.json');
