/**
 * D10 样音生成：用**同一句话**对比不同音色，供人工试听定音色。
 *
 * 背景（实测，见 docs/DESIGN.md §6.3.1 与 §9.2 D10）：
 *   思考正文 **76% 由英文主导、中文只占 5.2%**；而 360 条可念片段里
 *   **中文主导只有 15 条（4.2%）**。所以"只念中文"等于让宠物几乎不说话，
 *   音色必须能念英文。
 *
 * 本脚本为两个语种各生成一批样音，重点验证**多语言音色**（Edge 实际提供 12 个，
 * 女声有 `en-US-AvaMultilingualNeural` / `en-US-EmmaMultilingualNeural`）
 * 是否能同时把中英都念好 —— 若可以，D10 就有一个"一个音色解决两种语言"的落点。
 *
 * 用法：
 *     <node> tts-demo/gen_d10_voices.mjs
 *
 * ⚠️ 产物是 `tts-demo/*.mp3`，按 .gitignore 约定**不入库**（体积/版权），
 *    但可随时用上面的命令重新生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesize } from '../p0/edge-tts-zerodep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ⚠️ 文本是**合成的**，不是真实会话内容（真实对话永不入库/不落到产物里）
const SAMPLES = {
  zh: '等等，这个方向好像反了，我先把参数顺序理一遍再动手。',
  en: 'Wait, this looks wrong. I should reconsider the parameter order before rewriting the whole thing.',
};

const VOICES = [
  { id: 'zh-xiaoyi-p30', voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz', note: '现行设计（中文音色 + 抬调）' },
  { id: 'multi-ava', voice: 'en-US-AvaMultilingualNeural', pitch: '+0Hz', note: '多语言女声' },
  { id: 'multi-emma', voice: 'en-US-EmmaMultilingualNeural', pitch: '+0Hz', note: '多语言女声' },
  { id: 'multi-ava-p30', voice: 'en-US-AvaMultilingualNeural', pitch: '+30Hz', note: '多语言女声 + 抬调（想保留少女感）' },
  { id: 'en-ana', voice: 'en-US-AnaNeural', pitch: '+0Hz', note: '英文童声（Edge 唯一的 child voice）' },
  { id: 'zh-xiaoxiao', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+0Hz', note: '另一中文女声（对照组）' },
];

const out = [];
for (const v of VOICES) {
  for (const [lang, text] of Object.entries(SAMPLES)) {
    const file = path.join(HERE, `d10_${v.id}_${lang}.mp3`);
    try {
      // 注意：synthesize 返回的是 { audio, chunks, ms, format }，不是裸 Buffer
      const { audio } = await synthesize(text, { voice: v.voice, pitch: v.pitch });
      fs.writeFileSync(file, audio);
      out.push({ ...v, lang, file: path.basename(file), bytes: audio.length });
      console.log(`✅ ${path.basename(file).padEnd(28)} ${String(audio.length).padStart(7)} B  ${v.voice} ${v.pitch}`);
    } catch (error) {
      console.log(`❌ ${v.id}/${lang} 失败：${String(error && error.message)}`);
    }
  }
}

console.log(`\n生成 ${out.length} 个样音 → tts-demo/*.mp3（已 gitignore）`);
console.log('试听：直接打开 tts-demo/d10-voice-compare.html');
