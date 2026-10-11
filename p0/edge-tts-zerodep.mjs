/**
 * Edge TTS 零依赖实现（P0-2 产物）
 *
 * 为什么不用 npm 包：npm 上的 edge-tts / msedge-tts / node-edge-tts 全都依赖 `ws`（+axios 等）。
 * 插件 bundle 若带依赖，安装时就要过 pnpm / build-script 审批，且给社区用户增加负担。
 * DSH 的 Node 是 24.x，已自带全局 WebSocket（undici），且支持 `headers` 选项 —— 可零依赖直连。
 *
 * 协议要点（逐条对齐本机 Python edge-tts 7.2.8 的实现，见 edge_tts/constants.py、drm.py、communicate.py）：
 *   1. Sec-MS-GEC：SHA256 十六进制大写，输入 = floor(ticks/300)*300*1e7 + TrustedClientToken
 *      ticks = unix秒 + WIN_EPOCH(11644473600)
 *   2. 必须带 Origin / User-Agent 头，否则服务端返回 non-101
 *   3. 先发 speech.config（JSON），再发 ssml 帧（X-RequestId/X-Timestamp/Path:ssml）
 *   4. 二进制帧：前 2 字节为「头长度」(uint16 BE)，随后是头文本，再之后是音频负载
 *   5. 文本帧出现 `Path:turn.end` 表示结束
 *
 * 用法: node edge-tts-zerodep.mjs "文本" out.mp3
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75'; // 与 edge-tts 7.2.8 保持一致
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;
const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export function secMsGec(nowMs = Date.now()) {
  let ticks = Math.floor(nowMs / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  const strToHash = `${(ticks * 1e7).toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

const connectId = () => crypto.randomUUID().replace(/-/g, '');

/** JS 风格时间串，形如 "Mon Jan 01 2024 00:00:00 GMT+0000 (Coordinated Universal Time)" */
function dateToString(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${mo} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function buildSsml({ voice, pitch = '+0Hz', rate = '+0%', volume = '+0%', text }) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    escapeXml(text) +
    '</prosody></voice></speak>'
  );
}

function parseHeaders(text) {
  const end = text.indexOf('\r\n\r\n');
  const head = end >= 0 ? text.slice(0, end) : text;
  const out = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * 合成语音。零依赖、无副作用，除网络外不触碰文件。
 * @returns {Promise<{audio: Buffer, chunks: number, ms: number, format: string}>}
 */
export function synthesize(text, options = {}) {
  const {
    voice = 'zh-CN-XiaoyiNeural',
    pitch = '+0Hz',
    rate = '+0%',
    volume = '+0%',
    timeoutMs = 20000,
  } = options;

  return new Promise((resolve, reject) => {
    const url =
      `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connectId()}` +
      `&Sec-MS-GEC=${secMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const ws = new WebSocket(url, {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
      },
    });
    ws.binaryType = 'arraybuffer';

    const parts = [];
    const t0 = Date.now();
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(arg);
    };

    const timer = setTimeout(
      () => done(reject, new Error(`超时 ${timeoutMs}ms（已收到 ${parts.length} 段音频）`)),
      timeoutMs,
    );

    ws.addEventListener('open', () => {
      const ts = dateToString();
      ws.send(
        `X-Timestamp:${ts}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
          '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"' +
          '},' +
          `"outputFormat":"${OUTPUT_FORMAT}"` +
          '}}}}\r\n',
      );
      ws.send(
        `X-RequestId:${connectId()}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${ts}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          buildSsml({ voice, pitch, rate, volume, text }),
      );
    });

    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        const h = parseHeaders(data);
        if (h.Path === 'turn.end') {
          done(resolve, {
            audio: Buffer.concat(parts),
            chunks: parts.length,
            ms: Date.now() - t0,
            format: OUTPUT_FORMAT,
          });
        }
        return;
      }
      const buf = Buffer.from(data);
      const headerLen = buf.readUInt16BE(0);
      const header = buf.slice(2, 2 + headerLen).toString('utf8');
      if (/Path:\s*audio/i.test(header)) {
        parts.push(buf.slice(2 + headerLen));
      }
    });

    ws.addEventListener('error', (ev) =>
      done(reject, new Error(ev?.message || ev?.error?.message || 'websocket error')),
    );
    ws.addEventListener('close', (ev) => {
      if (!settled) done(reject, new Error(`连接提前关闭 code=${ev.code} reason=${ev.reason || ''}`));
    });
  });
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('edge-tts-zerodep.mjs')) {
  const [text, outPath] = process.argv.slice(2);
  if (!text) {
    console.error('用法: node edge-tts-zerodep.mjs "文本" [out.mp3]');
    process.exit(2);
  }
  const r = await synthesize(text, { voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz' });
  if (outPath) {
    fs.writeFileSync(outPath, r.audio);
    console.log(`✅ 写出 ${outPath}：${r.audio.length} 字节 / ${r.chunks} 段 / 耗时 ${r.ms}ms / ${r.format}`);
  } else {
    console.log(JSON.stringify({ bytes: r.audio.length, chunks: r.chunks, ms: r.ms }));
  }
}
