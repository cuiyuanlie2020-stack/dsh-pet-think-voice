# `lib/infra/` — 基础设施层

> 归属：`docs/DESIGN.md` §4.3 四层模型的**【④ 基础设施】**。

## 职责：外部世界的适配器

| 落点 | 职责 | 排期 |
|---|---|---|
| `infra/tts/` | `TtsProvider` 抽象 + **唯一的 edge 实现**（零 npm 依赖） | ✅ **P3-1 已落地**：`edge.js`（谁写 = 协议）+ `index.js`（选谁） |
| `infra/sse/` | SSE 广播（复用既有同源通道，新增 `speak` 帧） | ✅ P2-6（落在 `lib/index.js` 的 `ActivityHub`，未单独建目录） |
| `infra/load-watcher` | 负载探针（CPU/GPU），供负载闸判定 | P3-5 |
| `infra/fs` | 文件访问（设置持久化等） | ✅ P3-0b（复用上游的 `lib/settings.js`） |

## TTS 的两个文件怎么分工

| 文件 | 回答的问题 |
|---|---|
| `tts/edge.js` | **怎么把字变成声音** —— Edge 的 WebSocket 协议、SSML、帧解析、`Sec-MS-GEC` 鉴权 |
| `tts/index.js` | **用谁来变** —— provider 注册表（保留可插拔形状，随包只有 `edge`） |

⚠️ **音色不是在这里选的**。`synthesize(text, {voice, pitch})` 只是执行；
"这段文本该配哪个音色"是领域层的决策，见 `lib/core/reasoning-language.js#resolveVoice`。

✅ **真实实测**（2026-10-11，本机真连 Edge 云）：

| 音色 | 文本 | 结果 |
|---|---|---|
| `zh-CN-XiaoyiNeural` +30Hz | 中文 | 27,936 B / 1,060 ms |
| `en-US-AvaMultilingualNeural` +50Hz | 英文 | 14,400 B / 1,527 ms |
| `en-US-AvaMultilingualNeural` +50Hz | **中英混合** | 23,184 B / 1,545 ms |

三者帧头均为 `fff364`（合法 MP3 帧同步字）—— 这也实测确认了 D10 备用音色
**确实中英通吃**，混语兜底那条路成立。

## ⛔ 禁止

- **含业务判断**（"这段值不值得读"是领域层的事，不是基础设施的事）
- 被 `lib/core/` 引用（依赖只能单向向下：入口 → 应用 → 领域；基础设施由应用层调用）

## 🔒 硬约束（来自 DESIGN §6.3.1）

**不得引入任何 npm 依赖**（含 `ws` / `axios` / `edge-tts`）。
依据：DSH 的 Node 是 **24.18.1**，自带全局 `WebSocket`（undici，支持 `headers`）→ 协议可自实现。
bundle 一旦带依赖，`install_bundle` 就要走 pnpm 安装与 build-script 审批，社区用户多一层失败点。

### Edge TTS 自实现必须注意的四点（P0-2 实测踩出来的）

1. 必须带 `Origin` + `User-Agent` 请求头，否则服务端直接返回 non-101
2. `Sec-MS-GEC` 鉴权：`SHA256( str(floor((unix+11644473600)/300)*300*1e7) + TrustedClientToken ).hex().upper()`
3. 二进制帧前 **2 字节是 `uint16 BE` 的头长度**，跳过它和头文本才是音频负载
4. 结束标志是**文本帧**里的 `Path: turn.end`，不是"二进制收完"

### 默认参数（已定稿）

```
provider = edge        voice = zh-CN-XiaoyiNeural        pitch = +30Hz
```
