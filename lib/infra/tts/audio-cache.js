/**
 * `lib/infra/tts/audio-cache.js` — 已合成音频的内存 LRU
 *
 * 为什么放内存而不是写盘：
 *   - 音频的寿命就是"播一次"；写盘还得处理清理，而清理代码是最容易留垃圾的那类；
 *   - 单条 20~40KB、上限 8 条 ⇒ 稳态几百 KB，对内存红线（DESIGN §7.4 的 80MB）毫无压力；
 *   - 不落盘也就没有路径穿越/残留的问题要防。
 *
 * **id = 内容哈希**，于是"同一段文本重复合成"天然命中，不必额外维护去重键。
 * ⚠️ 这同时是隐私设计的一部分：URL 里只有哈希，**不含任何原文**
 *    （思考片段是用户的对话内容，见 CODEBUDDY.md 的"永不入库"清单）。
 *
 * ⚠️ 但"猜不到 id"**不算**访问控制 —— 音频仍必须过两道门：
 *    ① 路由层的 `loopbackOnly`（只有本机能取）
 *    ② 本模块的 `token` 校验（同一台机器上的其它页面/程序也拿不到）
 */
import { createHash, randomUUID } from 'node:crypto'

/** 条数上限：20s 一条（D3 频率闸）⇒ 8 条约等于最近 2.7 分钟 */
export const DEFAULT_MAX_ENTRIES = 8

/** 字节上限（兜底）：单条最长片段约 180 字 ⇒ 约 80KB，4MB 给足余量 */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export function createAudioCache(options = {}) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  /** id → `{ buffer, mime, token, at }`。Map 的插入序**就是** LRU 序（最旧在前）。 */
  const entries = new Map()
  let bytes = 0

  const evict = () => {
    while (entries.size > maxEntries || bytes > maxBytes) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      bytes -= entries.get(oldest).buffer.length
      entries.delete(oldest)
    }
  }

  /** 触碰 = 提升为最近使用（Map 不重排，必须删了再塞） */
  const touch = (id, entry) => {
    entries.delete(id)
    entries.set(id, entry)
  }

  return {
    /**
     * 放入并返回可被 URL 引用的句柄。
     *
     * 同一内容重复放 ⇒ 复用旧句柄（含**原 token**）。若每次换 token，
     * 浏览器侧刚拿到的 URL 会在下一次合成同一句时失效。
     *
     * @returns {{id:string, token:string, bytes:number, cached:boolean}}
     */
    put(buffer, opts = {}) {
      const id = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
      const existing = entries.get(id)
      if (existing !== undefined) {
        touch(id, existing)
        return { id, token: existing.token, bytes: existing.buffer.length, cached: true }
      }
      const entry = {
        buffer,
        mime: opts.mime ?? 'audio/mpeg',
        token: randomUUID().replace(/-/g, ''),
        at: Date.now(),
      }
      entries.set(id, entry)
      bytes += buffer.length
      evict()
      return { id, token: entry.token, bytes: buffer.length, cached: false }
    },

    /**
     * 取音频。**token 不匹配一律当作不存在** —— 不要把"外部猜不到 id"
     * 当成访问控制，音频里是用户的思考内容。
     *
     * @returns {{buffer:Buffer, mime:string}|null}
     */
    get(id, token) {
      const entry = entries.get(id)
      if (entry === undefined) return null
      if (typeof token !== 'string' || token === '' || token !== entry.token) return null
      touch(id, entry)
      return { buffer: entry.buffer, mime: entry.mime }
    },

    /** 诊断用 */
    stats() {
      return { entries: entries.size, bytes }
    },

    clear() {
      entries.clear()
      bytes = 0
    },
  }
}
