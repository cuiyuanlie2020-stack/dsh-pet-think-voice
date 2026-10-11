/**
 * `lib/infra/tts/index.js` — TTS provider 的选择面（DESIGN §6.3）
 *
 * **保留可插拔形状，但唯一随包提供的实现是 `edge`**（DESIGN 非目标 N7：
 * 不做本地 TTS 后端 —— Kokoro / CosyVoice / GPT-SoVITS 均已评估并放弃）。
 *
 * 保留这个"只有一项的注册表"不是为了好看，是为了**社区能自行接别的后端**：
 * 只要实现 `{ id, cost, synthesize, dispose }` 就能塞进来，`lib/app/` 不用改。
 *
 * `TtsProvider` 契约（改它必须同步 DESIGN §6.3）：
 *
 * ```ts
 * interface TtsProvider {
 *   readonly id: string
 *   readonly cost: { vramMb: number, cpuCoreFraction: number, netBytesPerCall: number }
 *   readonly available: () => boolean
 *   synthesize(text: string, opt: TtsOptions): Promise<Buffer>   // → mp3 字节
 *   dispose(): Promise<void>                                     // ⚠️ 必须实现（红线 R1）
 * }
 * ```
 *
 * ⚠️ 与 DESIGN §6.3 的一处**有意偏差**：契约写的是 `Promise<ArrayBuffer>`，
 *    这里回 `Promise<Buffer>`。理由是 Node 侧调用方（HTTP 路由）直接要写流，
 *    `Buffer` 省一次包装；而 `Buffer` 本身就是 `Uint8Array` 子类，
 *    对任何按 ArrayBufferView 处理的调用方仍然兼容。
 */

export {
  EDGE_COST,
  EDGE_DEFAULT_VOICE,
  EDGE_MIME,
  EDGE_OUTPUT_FORMAT,
  audioFromFrame,
  buildSsml,
  createEdgeProvider,
  escapeXml,
  parseHeaders,
  secMsGec,
} from './edge.js'

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, createAudioCache } from './audio-cache.js'

import { createEdgeProvider } from './edge.js'

/** 随包提供的 provider 名单 */
export const TTS_PROVIDERS = Object.freeze(['edge'])

/**
 * 按名字造 provider。
 *
 * @param {string} [kind] 默认 `'edge'`
 * @param {object} [options] 透传给具体实现（`WebSocket` / `now` / `timeoutMs`）
 * @throws 未实现的 kind —— **不静默退回 edge**：那会让"接了自己的后端但没生效"
 *         变成最难查的那类问题
 */
export function createTtsProvider(kind = 'edge', options = {}) {
  if (kind === 'edge') return createEdgeProvider(options)
  throw new Error(
    `tts: 未实现的 provider '${kind}'（本项目随包只提供：${TTS_PROVIDERS.join(' / ')}）`,
  )
}
