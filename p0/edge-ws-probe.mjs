/**
 * P0-2 步骤 1：Node 内置 WebSocket 能否直连 Edge TTS 服务
 * 目的：确认「零依赖」路线是否可行（Node 24 有全局 WebSocket，但不支持自定义请求头）
 */
import crypto from 'node:crypto';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;

function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  const strToHash = `${(ticks * 1e7).toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

const connectId = () => crypto.randomUUID().replace(/-/g, '');

const url =
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
  `&ConnectionId=${connectId()}` +
  `&Sec-MS-GEC=${secMsGec()}` +
  `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

console.log('Node', process.version, '| globalWebSocket =', typeof WebSocket);
console.log('GEC token =', secMsGec());
console.log('URL =', url.slice(0, 120) + '…\n');

async function attempt(label, url, opts) {
  return new Promise((resolve) => {
    let ws;
    const t0 = Date.now();
    try {
      ws = opts ? new WebSocket(url, opts) : new WebSocket(url);
    } catch (e) {
      console.log(`[${label}] 构造失败: ${e.message}`);
      return resolve(false);
    }
    const timer = setTimeout(() => {
      console.log(`[${label}] 超时（8s）`);
      try {
        ws.close();
      } catch {}
      resolve(false);
    }, 8000);

    ws.addEventListener('open', () => {
      console.log(`[${label}] ✅ 已连接（${Date.now() - t0}ms）`);
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
    ws.addEventListener('error', (ev) => {
      console.log(`[${label}] ❌ 错误: ${ev?.message || ev?.error?.message || 'unknown'}`);
      clearTimeout(timer);
      resolve(false);
    });
    ws.addEventListener('close', (ev) => {
      if (ev.code !== 1000 && ev.code !== 1005) console.log(`[${label}] close code=${ev.code} reason=${ev.reason}`);
    });
  });
}

const ok = await attempt('无自定义头', url);
if (!ok) {
  console.log('\n→ 尝试带 headers 选项（undici 扩展，可能不被支持）');
  await attempt('带 Origin/UA', url, {
    headers: {
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent':
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`,
    },
  });
}
