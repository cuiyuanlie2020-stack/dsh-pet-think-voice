// 设置存档（宿主半区）：**一份两端共享的设置**，落在 `%DSH_HOME%\pet-settings.json`。
//
// 为什么必须有它 —— 只把设置放进 `window.localStorage` 是不够的：
//
// ⚠️ 最早的理由是"桌面端页面与 DSH 页面不是同一个 origin"（`--attach` 模式下页面由壳转发
// 到它自己的随机端口）。**桌面壳已在 D5/P5-5 移除**，但这份存档依然必要，因为
// **DSH 自己的端口就是可配置的**（`dsh web --port N`）：
//
//   今天：http://127.0.0.1:3080        换个端口：http://127.0.0.1:8123
//
// 浏览器按 origin 隔离 localStorage，端口一换，之前存的东西**全看不见了** —— 不是
// "同步没做"，而是**没有跟着她的存储**。解法：把共享状态放到一个按路径定位的文件里，
// 端口怎么换、同时开几个标签页，读到的都是同一份。
//
// 四个键（与客户端的三/四类 shared 存档一一对应）：
//
//   tuning     ← `dsh-pet-think-voice.settings.v1`  可调项（手感、池子节奏…）
//   overrides  ← `dsh-pet-think-voice.settings.v2`  相位池子覆盖 + 开关 + 反应清空
//   outfit     ← `dsh-pet-think-voice:outfit`       装扮槽位的选择
//   speech     ← P3 新增：朗读相关（`{ language: 'zh' | 'en' | 'auto' }`，后续加静音等）
//
// **位置与大小不在里面**（`dsh-think-voice-pet.state.v1`）：那个本来就该按窗口存 ——
// 每个标签页怎么摆是她自己的事，共享了反而会打架。
//
// Rust 侧的对应实现见 `dsh-live2d-pet-desktop/src-tauri/src/host/settings.rs`：
// 独立模式下壳直接读写这个文件；挂载模式下页面读的仍是 DSH 的这条路由。
//
// ⚠️ **加新键时只改 `SETTINGS_KEYS` 一处**。读写两侧都从它派生（见下方 emptySettings /
//    writeSettings），因为"忘同步两处"这个坑是无声的 —— 加了键但没进 `next`，
//    表现是"设置页改了、重开就没了"，很难查。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 存档里的键（客户端与 Rust 侧都按这些名字读写）。**新增键只改这一处。** */
export const SETTINGS_KEYS = ['tuning', 'overrides', 'outfit', 'speech']

export function settingsPath(home) {
  return join(home, 'pet-settings.json')
}

/** 空存档：每个键都是 `null`（= "这一项用户没改过"），外加两个元字段。 */
function emptySettings() {
  const out = { rev: 0, at: 0 }
  for (const key of SETTINGS_KEYS) out[key] = null
  return out
}

/**
 * 读共享设置。
 *
 * 返回 `{ tuning, overrides, outfit, speech, rev, at }`；键缺失就是 `null`
 * （"这一项用户没改过"）。
 * `rev` 每次写入 +1 —— 页面用它判断"我这份是不是旧的"，也用它避免自己写自己读的回环。
 */
export function readSettings(home) {
  const empty = emptySettings()
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty
  const out = Object.assign({}, empty)
  for (const key of SETTINGS_KEYS) {
    const value = parsed[key]
    // 只接受对象：存档被人手改坏时不要把它传染给页面。
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out[key] = value
  }
  if (typeof parsed.rev === 'number' && parsed.rev >= 0) out.rev = parsed.rev
  if (typeof parsed.at === 'number' && parsed.at >= 0) out.at = parsed.at
  return out
}

/**
 * 两份存档值是否"一模一样"（按 JSON 比）。
 *
 * 为什么不用 `Object.is` / 浅比较：这里的值都是**小对象**（tuning 十几个数字、
 * overrides 是几层嵌套、speech 两三个字段）。浅比较会把"嵌套里改了一个字段"判成
 * 没变 —— 那是**丢数据**，比回环更糟。整份 JSON 比较的代价在这个体量下可以忽略
 * （每 3 秒最多一次、对象只有几十个键）。
 *
 * 键序不敏感这件事不需要处理：这些对象都由本项目自己的代码构造，键序稳定。
 */
function sameJson(a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 写共享设置（**合并写**：只动传进来的那几项，别把别的窗口写的擦掉）。
 *
 * 返回写好之后的那一份（含新的 `rev`）。写失败时返回 `null` —— 调用方要能区分
 * "没写成功"和"写成功了"，否则页面会以为同步好了。
 */
export function writeSettings(home, patch) {
  if (patch === null || typeof patch !== 'object') return null
  const current = readSettings(home)
  const next = { rev: current.rev + 1, at: Date.now() }
  // 从 SETTINGS_KEYS 派生：加键不必改这里（漏改的后果是无声丢数据，见文件头 ⚠️）
  for (const key of SETTINGS_KEYS) next[key] = current[key]
  let touched = false
  for (const key of SETTINGS_KEYS) {
    const value = patch[key]
    if (value === null) continue          // 没传 = 不动这一项
    if (value === undefined) continue
    if (typeof value !== 'object' || Array.isArray(value)) continue
    // ⚠️ **内容相同就不算一次写入**（D13 的根治，2026-10-11 真机实测）。
    //
    // 原先只看"这一项传了没传"，于是"把一模一样的值再写一遍"也会推进 `rev`。
    // 而前端每轮重渲染都会**无条件**落盘一次（`saveOutfit` 不管变没变都 POST），
    // 另一个窗口的 3 秒轮询一发现 `rev` 变了就 apply → 重渲染 → 再落盘 ⇒ **活锁**。
    //
    // 实测（web profile，页面开着 5 分钟）：内容一个字没变，`rev` 从 1008 涨到 1084，
    // 磁盘每 3~4 秒被写一次，宿主日志被 `朗读间隔 → …（与现值相同，未变）` 刷屏。
    // 这违反 R1（不与用户主力负载竞争）—— 一个"什么都不做"的插件不该持续写盘。
    if (sameJson(current[key], value)) continue
    next[key] = value
    touched = true
  }
  // **没有实际内容就不算一次写入**：不推进 `rev`、也不落盘。
  //
  // 这一条是防回环的：页面按 `rev` 判断"我这份是不是旧的"，如果"只带 rev 的空写"也推进
  // 版本号，另一个窗口就会以为有变化、于是回写一次 → 互相推着转。
  // （单元测试先红在这里，才有了这条注释。）
  if (!touched) return current
  try {
    mkdirSync(dirname(settingsPath(home)), { recursive: true })
    writeFileSync(settingsPath(home), JSON.stringify(next, null, 2) + '\n')
    return next
  } catch {
    return null
  }
}
