# P0 技术风险验证报告

> 依据 [`PLAN.md`](../docs/PLAN.md) P0 阶段：**不写功能代码，只把"能不能"变成有证据的结论**。
>
> | 项 | 值 |
> |---|---|
> | 日期 | 2026-10-11 |
> | 环境 | DSH Desktop 0.2.0-rc.2（Electron 44 / **Node 24.18.1** / pnpm 11.7.0）· DSH_HOME=`C:\Users\MSI\.dsh` |
> | 结论 | **P0-1 ✅ / P0-2 ✅（超预期）/ P0-3 ✅ / P0-4 ⏸️ 待低配机** |
> | 是否写功能代码 | 否。产出为探针、验证脚本与实现原型 |

---

## 0. 一句话结论

**这个项目的地基是实的：思考原文拿得到、Node 侧能出语音（而且能零依赖实现）、形象运行时能加载。唯一未闭环的是"低配机资源复验"（需要一台 8G/16G 的机器），以及"探针装进 DSH 后实时订阅是否真的触发"（需要你在 DSH 里点一下安装）。**

| 编号 | 待验证项 | 结论 | 证据强度 |
|---|---|---|---|
| **V1** | host 半区能否拿到 reasoning 原文 | ✅ **成立** | 三级独立证据（真实会话数据 + 类型定义 + 官方文档/源码） |
| **V2** | Node 侧能否出语音 | ✅ **成立，且无需任何 npm 依赖** | 真机实测 + 与 Python 参考版逐样本字节数一致 |
| **V3** | Cubism Core 运行时分发 | ✅ **通过**（机制已核实 + 正常网络已实测） | 官方 CDN 200 + 真机加载渲染成功 + 上游源码机制 |
| **V4** | 低配机资源是否达标 | ⏸️ **未完成** | 本机（RTX 5070 Ti / 24 核）六项阈值全部达标；低配需借机器 |

---

## 1. P0-1 · host 能否拿到 reasoning 原文（V1）

### 1.1 结论：✅ 成立

三条**互相独立**的证据链，全部指向同一结论：

| # | 证据来源 | 说明 | 可信度 |
|---|---|---|---|
| 1 | **真实会话轨迹** | 从本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（zstd 多帧）解出 26 个会话、**1321 条 `assistant/message`、其中 181 条带 reasoning** | 最强——这是 DSH 自己写下的数据 |
| 2 | **API 类型目录** | `app.asar` 内 `dsh-tool-cordis/lib/types/api-catalog.js`（= `cordis_inspect_query` 的数据源）含完整类型声明 | 强——DSH 自己的契约 |
| 3 | **官方插件技能 + 自身源码** | DSH 内置 `cordis-plugin-development` 技能明确写了取数方式；多处 DSH 自研插件有真实订阅代码 | 强——用法而非规格 |

### 1.2 关键结论 1：思考有两条通道，**内容完全一致**

| 通道 | 事件 | 签名（来自 API 目录） | 用途 |
|---|---|---|---|
| **持久** | `session/event` | `(session, event): void`，摘要 "Post-commit, fire-and-forget append feed" | 拿**完整**思考（含逐 token 时序） |
| **实时** | `agent/assistant-stream` | `{ agent: Agent; frame: AssistantStreamFrame }` | 拿**流式增量**，可边出边挑 |

**实测互证（最重要的一条）**：把 181 条消息同时用两条路径抽取，**181/181 完全一致，0 处不一致**。
→ 意味着实现可以**任选一条**，或"实时挑、持久兜底"，不必担心内容对不上。

### 1.3 关键结论 2：数据结构（已逐字核对）

```ts
// 持久：assistant/message 的 data
{ turn, step, message: AssistantMessage, stream: AssistantStreamRecord[], usage?, interrupted? }

AssistantMessage.content : ContentBlock[]        // ContentBlockMap 的键 = 'text'|'reasoning'|'image'|'file'|'tool-call'|...
ReasoningBlock           = { type: 'reasoning', text: string }        // ★ 完整思考原文
AssistantStreamRecord    = { type: 'reasoning-chunks', time0, index, dt: number[], texts: string[] }  // ★ 逐 token + 每 token 毫秒增量

// 实时：agent/assistant-stream 的 frame
AssistantStreamFrame =
  | { type: 'start',  attemptId, revision, turn, step }
  | { type: 'chunk',  attemptId, revision, index, time, chunk: StreamChunk }
  | { type: 'end',    attemptId, revision, index, outcome: { kind:'committed', eventType:'assistant/message'|'assistant/attempt', seq } | { kind:'abandoned' } }

StreamChunk 含：
  { type: 'block-start', index, blockType }      // blockType='reasoning' 表示思考块开始
  { type: 'reasoning-delta', index, text }       // ★ 实时思考增量
  { type: 'text-delta', index, text }
  { type: 'block-end', index, block } | { type:'usage', ... } | { type:'finish', ... }
```

**订阅写法**（已在 DSH 自研插件源码中核实，非猜测）：

```js
ctx.on('session/event', (session, event) => {          // ⚠️ 两个位置参数
  if (event.type !== 'assistant/message') return;
  const reasoning = event.data.message.content
    .filter(b => b.type === 'reasoning').map(b => b.text).join('');
}, { global: true });

ctx.on('agent/assistant-stream', ({ agent, frame }) => {  // ⚠️ 一个对象参数
  if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') {
    frame.chunk.text;                                     // 增量思考
  }
}, { global: true });
```

### 1.4 关键结论 3：**数据形状对设计的影响**（新发现，需回写 DESIGN）

对 181 条真实思考做的统计：

| 指标 | 值 |
|---|---|
| 思考长度 | 最小 68 / **中位 1295** / 最大 **14994** 字符 |
| 逐 token 数 | 合计 103,884，中位 372/条 |
| 思考耗时（dt 之和） | 中位 **1629 ms** |

**含义（直接影响 P2 的 `FragmentSplitter` 与 `SpeechPlanner`）**：
- 思考**很长**（中位 1295 字），远超"30 秒读一句"的容量 → **切分是刚需，不是可选项**；
- 最长的 1.5 万字说明**必须设长度上限**，否则一条思考能读十分钟；
- `dt[]` 给的是**逐 token 的真实节奏**（哪里停顿、哪里快）→ 这是"拟人化"可用的额外素材，但**不要**把 `dt` 当朗读节奏（它是模型吐字的节奏，不是朗读节奏）。

真实样本（`p0/validate_extractor.py` 输出的原文，人工核对为真思考）：

> 「用户问"你现在是谁？"…用户级记忆里说"统一称「贝塔」"——这是我对用户的称呼？还是用户对我的称呼？
> 读原文：「## 称呼 / 统一称「贝塔」。」——**这有点歧义**。通常这类记忆是"称呼用户为贝塔"…
> 但用户现在问"你现在是谁？"——**可能是在测试身份混淆**。我应…」

> 「让我看 ~/.dsh/plugins 目录…**注意**：工作目录是 …default-workspace，但配置在 C:\Users\MSI\.dsh\。
> 文件策略是 workspace-write，可能无法写工作目录外的文件。**但读取应该可以？** read-only 沙箱限制写入。」

这正是本项目要的东西：**自我怀疑、权衡、吐槽**——都是可朗读的"有戏"片段。

### 1.5 交付物

| 文件 | 作用 |
|---|---|
| `p0/probe-plugin/` | **可安装的探针 bundle**（Host-only，无界面）。订阅两条通道，把结果写入 `p0/probe-plugin/probe.log`；不含任何 UI、不追加任何会话事件（遵守"不得新增事件 type"约束） |
| `p0/validate_extractor.py` | 用**真实会话日志**回放验证抽取逻辑（复刻插件逻辑 → 26 文件 / 181 条命中 / 两路径 100% 一致） |
| `p0/inspect_session.py`、`p0/probe_blocks.py` | 会话轨迹解码与结构探查 |
| `p0/asar.js` | asar 容器解析器（DSH 桌面版的代码都封在 121MB 的 `app.asar` 里，shell 读不了它） |
| `p0/extract/api-catalog.js`、`p0/extract/decls/`（936 个类型声明） | DSH API 契约快照，后续实现查这里而不是猜 |

### 1.6 ✅ 运行时闭环（已实测，2026-10-11）

**"我的插件订阅在真实会话里是否真的触发"——已验证：真的触发，两条通道都触发。**

方式：用 DSH 桌面版自带的**官方 CLI** + `--patch` 叠加层，把探针以 `file://` 方式挂进一个 headless 会话。
**不安装、不改任何 profile 文件、不碰 hooks、不切 Agent 预设。**（机制与副作用清单见 [`INSTALL-PATH-FINDINGS.md`](./INSTALL-PATH-FINDINGS.md)）

**实测结果**（`p0/out/probe.log`，判读器 `probe-log-summary.py` 退出码 **0**）：

| 关键行 | 值 |
|---|---|
| `plugin-activated` | ✅ 插件被加载（Node v24.18.1） |
| `subscribed` × 2 | ✅ `session/event` 与 `agent/assistant-stream` **均为 `mode: global`** |
| `durable:assistant/message` | ✅ **`reasoningChars: 149`、`streamTokens: 33`** |
| **`pathsAgree`** | ✅ **`true`** —— 持久块与流式记录抽出的文本一致 |
| `live:start` / `live:end` | ✅ 实时通道也触发，`committedAs: assistant/message` |
| `histogram` | ✅ 一次会话共 28 个 session 事件，类型分布完整 |

捕获到的思考原文（DSH 自己也把它打在了 stdout）：

> `The user asks to read p0/probe-plugin/package.json and answer in one sentence whether the package declares itself as a bundle.`
> `Let me read the file.`

**顺带发现一个对实现有影响的边界情况**：第 2 步出现了 `contentBlockTypes: ["reasoning","text"]` 但 **`reasoningChars: 0`**
—— 即**模型会产出"空的 reasoning 块"**。
⇒ 实现里**必须把空 reasoning 块视为"无思考"**，不能仅凭块类型是 `reasoning` 就当作候选片段，否则会朗读一段空气。

**如何自行复现**：

```bash
DSH_THINK_PROBE_LOG="<工作区>/p0/out/probe.log" \
ELECTRON_RUN_AS_NODE=1 "<DSH>\DeepSeek Harness.exe" --expose-internals \
  "<DSH>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" \
  --profile headless \
  --patch "<工作区>/p0/probe-plugin/overlay-byfile.yml" \
  "先读 p0/probe-plugin/package.json，然后用一句话回答：这个包声明自己是 bundle 吗？"
```

> 📌 **这条命令同时就是本项目 P2/P3 的开发循环**：改代码 → 重跑一次，不需安装/卸载。

---

## 2. P0-2 · Node 侧能否出语音（V2）

### 2.1 结论：✅ 成立，而且比预期好——**零依赖**

**关键突破**：npm 上所有 Edge TTS 包（`edge-tts` / `msedge-tts` / `node-edge-tts` / `@andresaya/edge-tts` / `edge-tts-universal`）**无一例外都依赖 `ws`**（部分还带 `axios`）。

而 **DSH 的 Node 是 24.18.1，自带全局 `WebSocket`（undici）**，且支持 `headers` 扩展选项 → **协议可以自己实现，插件不需要任何依赖**。

这直接消除了一个真实的工程摩擦：bundle 一旦带依赖，`install_bundle` 就要走 pnpm 安装与 build-script 审批，社区用户也会多一层失败点。

### 2.2 踩到的坑（写下来避免重走）

| 坑 | 现象 | 解法 |
|---|---|---|
| **必须带请求头** | 不带 `Origin`/`User-Agent` 直连 → `non-101 status code`，连接被拒 | 传第二个参数 `{ headers: { Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'User-Agent': '…Edg/143…' } }`（Node 内置 WebSocket 的 undici 扩展，Node 22/24 均实测可用） |
| **鉴权 token 有时效性算法** | 需要 `Sec-MS-GEC` | `ticks = unix秒 + 11644473600`，`ticks -= ticks % 300`，`ticks *= 1e7`，然后 `SHA256(str(ticks) + TrustedClientToken).hex().upper()` |
| **二进制帧有两个头的长度前缀** | 不能直接把整帧当音频 | 前 2 字节是 `uint16 BE` 的**头长度**，跳过它和头文本，剩下才是音频负载 |
| **结束标志在文本帧里** | 二进制收完不代表结束 | 收到文本帧且 `Path: turn.end` 才算完成 |

### 2.3 验证：与 Python 参考版**逐样本字节数完全一致**

| 样本 | 零依赖实现 | Python `edge-tts` 参考版 | 一致 |
|---|---|---|---|
| 「powersell 又想咬我了」 | 16,416 B | 16,416 B | ✅ |
| 「哦——原来 param 是必填的…」 | 30,816 B | 30,816 B | ✅ |
| 「等等，这个正则怎么写都不对…」 | 31,248 B | 31,248 B | ✅ |
| 「嗯……这个 bug 藏得真深…」 | 27,360 B | 27,360 B | ✅ |
| 「好，思路清晰了，let me…」 | 31,680 B | 31,680 B | ✅ |
| 5 句连读（130 字） | 121,680 B | 121,680 B | ✅ |

**6/6 字节数一致**（同格式 CBR 24kHz/48kbps，字节数一致 ⇒ 时长一致）。

补充侧证：对其中一个样本做解码后 PCM 比对 → **75.8% 采样点完全相同，最佳对齐 lag=0、相关系数 0.99975**。

### 2.4 两个"确定性"事实（重要，避免误判）

1. **同一实现 → 逐字节可复现**：我的实现连跑两次 MD5 完全相同；Python 版连跑两次也完全相同。
2. **不同实现之间不是逐字节相同**（同为确定性但彼此不同）。原因在于请求元数据/连接路径的细微差别，**未完全定位**。

⚠️ 因此：**"与 Python 版逐字节相同"不是一个可用的验收判据**；可用判据是"**字节数/时长一致 + 解码后高相关 + ASR 可懂**"。本次三项均满足。

**可懂度（whisper 回译，长样本）**：中文主干完全可懂（"…是必填的，难怪一直报 undefined…这个正则怎么写都不对，我是不是把方向搞反了…这个 bug 藏得真深，我绕了一大圈才找到…"）；英文术语（param/undefined/powersell/function）出现误识，但**与 Python 参考版表现一致**，属 whisper-base 对"中文夹自定义英文术语"的固有弱点，与实现无关。

### 2.5 资源画像（Node 侧；同时填补 RESOURCE-BUDGET 6.1 的未测项 #5）

| 指标 | 实测 |
|---|---|
| 冷启动（第 1 条） | 811 ms |
| 热态墙钟均值 | 1261 ms |
| **CPU / 次（中位）** | **16 ms** |
| CPU 合计（6 次） | 156 ms |
| 进程 RSS 增量 | **+19.3 MB** |
| 吞吐 | 22.2 字/秒 · 23.0 KB/秒 |

> 对比 Python 版（+3.8MB / 中位 <15.6ms CPU）：Node 版的 RSS 增量更大（undici + WebSocket 机制），**但 CPU 同样可忽略**——结论"Edge TTS 是网络等待型负载"不变。
> ⚠️ 注意：插件运行时这段代码跑在 **DSH 自己的 Node 进程内**，属**边际分配**（大部分可 GC），不是独立进程常驻。

### 2.6 交付物

| 文件 | 作用 |
|---|---|
| `p0/edge-tts-zerodep.mjs` | **零依赖实现**（`synthesize(text, opts) → { audio: Buffer }`），可直接抄进 `lib/infra/tts/edge.js` |
| `p0/p0-2-verify.mjs` | 真实片段批量验证 + 资源画像 |
| `p0/zerodep-listen.html` | 可试听页面（6 个音频） |
| `p0/out/zerodep_*.mp3` | 6 个音频样本 |

---

## 3. P0-3 · Cubism Core 能否可靠加载（V3）

### 结论：✅ 通过

| 场景 | 结论 | 依据 |
|---|---|---|
| 正常网络冷启动 | ✅ **已实测** | 官方 CDN 返回 200（207,155 B）；且已在 `bench/` 测试台用真 Edge（ANGLE/NVIDIA D3D11）成功加载并渲染模型 |
| 已缓存后离线 | ✅ 机制已核实 | 上游 host 侧 `GET /api/live2d-pet/runtime/live2dcubismcore.min.js`：**本地有就发本地的**，没有才去 CDN 取并缓存到 `%DSH_HOME%\pets\.runtime\` |
| 弱网/首次失败 | ✅ 有明确失败路径（非白屏） | host 侧两边都拿不到返回 **502**（带 `x-live2d-core-source: cdn` 标识）；浏览器侧有 `cubism-core-unavailable` 分支 |
| 手动放置 | ✅ 已有文档 | 上游 README 写明放置位置与来源（Live2D 官方 Cubism SDK for Web） |

⚠️ 唯一未做的是"实际缓存命中"的运行时复现（需插件跑起来），归入 P3。

---

## 4. P0-4 · 低配机资源复验（V4）

### 结论：⏸️ 未完成（本机条件不足）

本机（RTX 5070 Ti / 24 核 / 32G）下 DESIGN 7.4 六项阈值**全部达标**（见 `RESOURCE-BUDGET.md` 第 7 节）。但 P0-4 明确要求**在低配机与真实窗口下复验**，本机无法代替。

**这不是"没做"，是"做不了"**——需要一台 8G 显存 / 16G 内存的机器。三个选项：

| 选项 | 做法 |
|---|---|
| A（推荐） | 借到低配机后跑一遍 `bench/`（脚本已可复现，约 40 秒出结果） |
| B | 在本机用 `--maxFps 30` + 限核方式做**保守代理测量**，作为上界参考 |
| C | 接受风险，把 P0-4 顺延到 P5-4（发布前的干净低配环境验证） |

**我的建议是 C + A 组合**：现在不阻塞（因为低配达标的主要依据是"插件不驻留模型权重、显存占用 <100MB"这个结构性事实，与机器无关），但**发布前必须在真低配上跑一次**，否则不能对外宣称"8G/16G 可流畅运行"。

---

## 5. 对设计文档的影响（✅ 已回写，见下表结果）

| 文档 | 改哪里 | 内容 | 状态 |
|---|---|---|---|
| `DESIGN.md` | 第 9.1 节 | V1 ✅ / V2 ✅（注明"零依赖实现"）/ V3 ✅ / V4 ⏸️ | ✅ 已改 |
| `DESIGN.md` | 第 6.1 节 | `ThinkingSource` 取数路径定稿（含两条通道的订阅写法与实测一致性） | ✅ 已改 |
| `DESIGN.md` | 新增 6.3.1 小节 | **实现方式约束**：不引入 npm 依赖，用 Node 内置 WebSocket 自实现（附四个必踩点） | ✅ 已改 |
| `DESIGN.md` | 第 5 节 | 新增约束：思考**中位 1295 字** → 切分与长度上限是刚需 | ✅ 已改 |
| `DESIGN.md` | 第 7.3 节 | 长度闸补注"因实测中位 1295 字而必不可少" | ✅ 已改 |
| `RESOURCE-BUDGET.md` | 新增 4.2b 小节 | Node 侧零依赖 TTS 实测（+19.3MB RSS / 16ms CPU / 6-6 字节数一致） | ✅ 已改 |
| `RESOURCE-BUDGET.md` | 新增 8.1 小节 + 第 6.1 节 | 补 P0 测量入口；关闭未测项 #5 | ✅ 已改 |
| `PLAN.md` | 第 2 节与第 9 节 | P0-1/P0-2/P0-3 ✅；P0-4 ⏸️ 顺延 P5-4；下一步 = P1 | ✅ 已改 |

> ⚠️ 回写过程中发现本仓库存在「Edit 报告成功但内容被并发写入回退」的现象（已记入 `PLAN.md` L4 的补充纪律）。
> 上述改动均以**整篇写入或单次原子脚本写入**完成，并已逐项回读校验。

---

## 6. 本阶段全部交付物

| 路径 | 类别 |
|---|---|
| `p0/P0-REPORT.md` | 本报告 |
| `p0/probe-plugin/` | **探针 bundle**（待你装进 DSH 闭环 V1 最后一步） |
| `p0/edge-tts-zerodep.mjs` | **零依赖 Edge TTS 实现**（可直接进 `lib/infra/tts/`） |
| `p0/validate_extractor.py` | 真实数据回放验证 |
| `p0/parse` 工具组：`asar.js` / `catalog.js` / `decls.js` / `inspect_session.py` / `probe_blocks.py` | DSH 内部结构勘探工具（可复用） |
| `p0/extract/` | DSH API 契约快照（`api-catalog.js` + 936 个类型声明） |
| `p0/out/` | 音频样本、验证数据 |
| `p0/zerodep-listen.html` | 试听页 |

---

## 7. 下一步

**P0 出口判据是"V1/V2/V3/V4 全部有明确结论"——现在是 3 ✅ + 1 ⏸️（条件不足），按 PLAN 的出口表可以进 P1。**

建议的推进顺序：

1. ✅ **项目名已定：`dsh-pet-think-voice`**（已核未占用）→ **D1 阻塞解除，P1 已解锁**。
2. **你花 1 分钟闭环 V1**：按 [`probe-plugin/README.md`](./probe-plugin/README.md) 把探针装进 DSH，跑一轮带思考的提问；完成后跑 `p0/probe-log-summary.py` 出结论（也可发我，我来判读）。
3. 进 **P1 建骨架**（git 基线 / 目录 / `CODEBUDDY.md` / `run_all` / 资源可回归）——P1-1 已完成，从 **P1-2** 起。
4. **P0-4 挂到 P5**，发布前借低配机复验。

⚠️ 本轮**未写任何功能代码**；`p0/` 下全部是探针、验证脚本与实现原型。
