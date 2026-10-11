/**
 * `lib/infra/tts/edge.js` — 基础设施层（DESIGN §4.3 的【④ 基础设施】）
 *
 * Edge 云的 TTS 实现。**零 npm 依赖**（DESIGN §6.3.1 锁定，理由见 `lib/infra/README.md`）。
 *
 * 本文件由 P0-2 的原型 `p0/edge-tts-zerodep.mjs` 移植而来 —— 那份原型已实测
 * **6/6 样本字节数与本机 Python 版 `edge-tts` 完全一致**，协议细节不是猜的。
 * 移植时做的四处增强，都是"从一次性脚本变成常驻服务"必须补的：
 *
 *   1. **可注入 WebSocket** → 单测能不打网络（原原型只能真连）；
 *   2. **在途连接登记 + `dispose()`** → 红线 R1：能随时停，不留悬挂 socket；
 *   3. **空音频要抛错** → 实测 `en-US-AnaNeural` 念中文会返回 **0 字节**，
 *      原型那版会心安理得地写出一个空 mp3；
 *   4. 返回 `Buffer` 而非裸 `ArrayBuffer` → 路由侧直接可 `write`，省一次包装
 *      （`Buffer` 是 `Uint8Array` 子类，对调用方仍是 ArrayBufferView）。
 *
 * ── 协议四点（每一条都是实测踩出来的，别删）──────────────────────────
 *
 *   1. **必须带 `Origin` + `User-Agent`**，否则服务端直接返回 non-101；
 *   2. `Sec-MS-GEC` 鉴权：
 *      `SHA256( str(floor((unix秒+11644473600)/300)*300*1e7) + TrustedClientToken ).hex().upper()`；
 *   3. 二进制帧前 **2 字节是 `uint16 BE` 的头长度**，跳过它和头文本才是音频负载；
 *   4. 结束标志是**文本帧**里的 `Path: turn.end`，不是"二进制收完"。
 */

import { createHash, randomUUID } from 'node:crypto'

/** 微软 Edge 朗读接口的公开客户端令牌（Python 版 `edge-tts` 同源） */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/** 与 `edge-tts` 7.2.8 保持一致；`Sec-MS-GEC-Version` 由它派生 */
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`

/** Windows FILETIME 纪元与 Unix 纪元的秒差 */
const WIN_EPOCH = 11644473600

const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

/** 输出格式（24kHz 单声道 48kbps mp3 —— 语音够用、体积小） */
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** 给 HTTP 路由用的 mime */
export const EDGE_MIME = 'audio/mpeg'

/** 默认音色。⚠️ 真正的选择权在 `lib/core/reasoning-language.js#resolveVoice`，
 *  这里只是"调用方没给 voice 时"的兜底（D10 主选）。 */
export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/** 声明式成本（DESIGN §6.3）：给负载哨兵做决策用，不含任何实测逻辑 */
export const EDGE_COST = Object.freeze({
  vramMb: 0,              // 纯云端，不占显存
  cpuCoreFraction: 0.01,  // 实测中位 16ms/句
  netBytesPerCall: 3e4,   // 约 30KB/句
})

/**
 * 计算 `Sec-MS-GEC` 鉴权串。
 *
 * 关键点是**先把时间戳截断到 300 秒窗口**再参与哈希 —— 服务端也按同一窗口校验，
 * 所以这个值每 5 分钟才变一次。少截断或多截断都会拿到 403。
 *
 * @param {number} [nowMs] 注入时钟（测试用固定值；默认 `Date.now()`）
 */
export function secMsGec(nowMs = Date.now()) {
  let ticks = Math.floor(nowMs / 1000) + WIN_EPOCH
  ticks -= ticks % 300
  const strToHash = `${(ticks * 1e7).toFixed(0)}${TRUSTED_CLIENT_TOKEN}`
  return createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase()
}

/** 连接/请求 id：服务端要求是无连字符的 UUID */
const connectId = () => randomUUID().replace(/-/g, '')

/**
 * JS 风格时间串，形如
 * `Mon Jan 01 2024 00:00:00 GMT+0000 (Coordinated Universal Time)`。
 * 服务端只做透传，但格式不对会拒（照抄 `edge-tts` Python 版的格式）。
 */
function dateToString(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  return `${wd} ${mo} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
}

/** SSML 是 XML：这五个字符必须转义，否则 `a < b` 这类思考会让服务端解析失败 */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 拼 SSML（导出仅为可单测 —— 转义漏一个字符就是一个线上 bug） */
export function buildSsml({ voice, pitch = '+0Hz', rate = '+0%', volume = '+0%', text }) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    escapeXml(text) +
    '</prosody></voice></speak>'
  )
}

/** 解析文本帧顶部 `Key: Value` 头（用第一个空行分界） */
export function parseHeaders(text) {
  const end = text.indexOf('\r\n\r\n')
  const head = end >= 0 ? text.slice(0, end) : text
  const out = {}
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/**
 * 从二进制帧里剥出音频负载。
 *
 * ⚠️ 头 2 字节是 `uint16 BE` 的**头长度**，不是音频的一部分。
 * 少了这一步，出来的 mp3 每帧头部都会插进一段垃圾文本。
 *
 * @returns {Buffer|null} 音频负载；这帧不是音频时返回 null
 */
export function audioFromFrame(buffer) {
  if (buffer.length < 2) return null
  const headerLen = buffer.readUInt16BE(0)
  if (buffer.length < 2 + headerLen) return null
  const header = buffer.slice(2, 2 + headerLen).toString('utf8')
  if (!/Path:\s*audio/i.test(header)) return null
  return buffer.slice(2 + headerLen)
}

/**
 * 造一个 Edge TTS provider（形状即 DESIGN §6.3 的 `TtsProvider`）。
 *
 * @param {object} [options]
 * @param {typeof WebSocket} [options.WebSocket] 注入 WS 实现（默认取全局；
 *        DSH 的 Node 24 自带 undici 的 WebSocket 且支持 `headers`，
 *        这是"零依赖"能成立的前提）
 * @param {() => number} [options.now]      注入时钟（测试用）
 * @param {number} [options.timeoutMs]      单句合成超时（默认 20s）
 */
export function createEdgeProvider(options = {}) {
  const WS = options.WebSocket ?? globalThis.WebSocket
  const now = options.now ?? (() => Date.now())
  const defaultTimeout = options.timeoutMs ?? 20000

  /** 在途连接：`dispose()` 要能一次性全部掐断（红线 R1） */
  const inFlight = new Set()

  const available = () => typeof WS === 'function'

  async function synthesize(text, opt = {}) {
    if (!available()) {
      // 显式报错而不是静默返回空：调用方要能把它降级成"只显气泡"并留痕（R3）
      throw new Error('edge: 当前运行环境没有 WebSocket（需要 Node ≥ 22 或 DSH 的 Node 24）')
    }
    const value = typeof text === 'string' ? text : ''
    if (value.trim() === '') throw new Error('edge: 空文本不合成（会得到 0 字节音频）')

    const {
      voice = EDGE_DEFAULT_VOICE,
      pitch = '+0Hz',
      rate = '+0%',
      volume = '+0%',
      timeoutMs = defaultTimeout,
    } = opt

    const url =
      `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connectId()}` +
      `&Sec-MS-GEC=${secMsGec(now())}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

    return new Promise((resolve, reject) => {
      const ws = new WS(url, {
        headers: {
          // ① 没有这两个头，服务端直接 non-101（实测）
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
        },
      })
      ws.binaryType = 'arraybuffer'
      inFlight.add(ws)

      const parts = []
      const t0 = now()
      let settled = false

      const done = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inFlight.delete(ws)
        try {
          ws.close()
        } catch {
          /* 已经关了 */
        }
        fn(arg)
      }

      const timer = setTimeout(
        () => done(reject, new Error(`edge: 超时 ${timeoutMs}ms（已收到 ${parts.length} 段音频）`)),
        timeoutMs,
      )
      // 不让一次合成为进程续命（宿主退出就该退）。
      // ⚠️ 代价：单测里事件循环会先一步空掉，所以 `edge.test.js` 的"超时"用例
      //    自己挂了一个 keep-alive —— 那是测试的补丁，不是这里的 bug。
      timer.unref?.()

      ws.addEventListener('open', () => {
        const ts = dateToString()
        ws.send(
          `X-Timestamp:${ts}\r\n` +
            'Content-Type:application/json; charset=utf-8\r\n' +
            'Path:speech.config\r\n\r\n' +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
            '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"' +
            '},' +
            `"outputFormat":"${EDGE_OUTPUT_FORMAT}"` +
            '}}}}\r\n',
        )
        ws.send(
          `X-RequestId:${connectId()}\r\n` +
            'Content-Type:application/ssml+xml\r\n' +
            `X-Timestamp:${ts}Z\r\n` +
            'Path:ssml\r\n\r\n' +
            buildSsml({ voice, pitch, rate, volume, text: value }),
        )
      })

      ws.addEventListener('message', (event) => {
        const data = event.data
        if (typeof data === 'string') {
          // ④ 结束标志在**文本帧**里，不是"二进制收完"
          if (parseHeaders(data).Path === 'turn.end') {
            const audio = Buffer.concat(parts)
            if (audio.length === 0) {
              // ③ 实测有音色（如 AnaNeural 念中文）会返回 0 字节；
              //    静默写出一个空文件会让"没声音"变成最难查的那类故障
              done(reject, new Error(`edge: 合成得到 0 字节音频（voice=${voice}）`))
              return
            }
            done(resolve, audio)
          }
          return
        }
        const payload = audioFromFrame(Buffer.from(data))
        if (payload !== null) parts.push(payload)
      })

      ws.addEventListener('error', (event) =>
        done(reject, new Error('edge: ' + (event?.message || event?.error?.message || 'websocket error'))))

      ws.addEventListener('close', (event) => {
        if (!settled) {
          done(reject, new Error(`edge: 连接提前关闭 code=${event?.code} reason=${event?.reason || ''}`))
        }
      })
    })
  }

  return {
    id: 'edge',
    cost: EDGE_COST,
    available,
    synthesize,
    /** 红线 R1：随时停。掐断所有在途连接，在途 Promise 会各自以 close 事件 reject。 */
    async dispose() {
      for (const ws of [...inFlight]) {
        try {
          ws.close()
        } catch {
          /* 已经关了 */
        }
      }
      inFlight.clear()
    },
    /** 诊断用：当前在途连接数 */
    inFlightCount: () => inFlight.size,
  }
}
