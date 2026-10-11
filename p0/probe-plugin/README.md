# 思考探针（P0）· 安装与验证说明

> 这是 [`../P0-REPORT.md`](../P0-REPORT.md) 里 **V1 最后一步**的验证工具。
> V1 的其余部分已用三级证据证明（真实会话数据 / DSH API 契约 / DSH 自身插件源码），
> **只差一件事：我自己写的插件订阅，在运行时到底会不会触发。**

---

## 1. 这是什么

一个 **DSH 插件包（bundle）**，只有一个作用：

**订阅 DSH 的两条思考通道，把看到的东西追加写进一个日志文件。**

- ❌ 没有界面
- ❌ 不改 DSH 任何现有行为
- ❌ 不追加任何会话事件（DSH 明确禁止插件新增事件类型）
- ✅ 只写一个日志文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单（`dsh.bundle.patch` 指向下面的 patch） |
| `cordis.patch.yml` | 往 profile 里插入一行插件 |
| `index.js` | 全部逻辑：订阅 + 写日志 |
| `locale/*.json` | 插件管理页显示的标题/描述 |

---

## 2. 为什么必须装它

见 [`../P0-REPORT.md`](../P0-REPORT.md) 第 1.6 节。一句话：

> **数据在、API 在、别人这么用** —— 这三件都已证明。
> 但 **"我的插件订阅在真实会话里是否真的触发"** 只有装上跑一次才知道
> （Cordis 的事件是 Scoped 的，作用域/权限有没有坑，静态读代码看不出来）。

---

## 3. 怎么装（两种方式）

### 🟢 方式一（推荐 · 已实测）：不安装，用 `--patch` 叠加层直接加载

**零配置改动**：不改 profile、不碰 hooks、不切 Agent 预设、不跑 pnpm。改代码后重跑即可 → 也**正是开发循环**。

```bash
DSH_THINK_PROBE_LOG="<工作区>/p0/out/probe.log" \
ELECTRON_RUN_AS_NODE=1 "<DSH>\DeepSeek Harness.exe" --expose-internals \
  "<DSH>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" \
  --profile headless \
  --patch "<工作区>/p0/probe-plugin/overlay-byfile.yml" \
  "先读 p0/probe-plugin/package.json，然后用一句话回答：这个包声明自己是 bundle 吗？"
```

> `<DSH>` = `C:\Users\MSI\AppData\Local\Programs\DeepSeek Harness`
> ⚠️ 叠加层里**必须用 `file:///` 绝对路径**引用 `index.js`；用包名会报 `Cannot find package`（实测）。

**2026-10-11 已用此方式实测通过**（`probe-log-summary.py` 退出码 0，`reasoningChars=149`、`pathsAgree=true`）。

### 🔵 方式二：真正安装进 profile（P5 验证"社区能不能装上"时用）

⚠️ **不能手工装。** DSH 官方明确规定：不许手写 profile 的 `package.json` / `cordis.patch.yml`、
不许在 profile 目录里跑 pnpm。**必须走 DSH 自己的 `plugin_manager` 工具。**

在 DSH（桌面版）里新开一个会话，把下面这句发给它：

## 4. 怎么产生思考

随便问它一个**需要推理**的问题即可，例如：

- 「读一下 `p0/edge-tts-zerodep.mjs`，指出它可能在哪里出错」
- 「把这份文档的第 3 节和第 5 节对比一下，看有没有矛盾」

⚠️ 纯闲聊或极短回答可能**不产生 reasoning**（模型可以不思考就回答）。

---

## 5. 怎么确认（看日志）

日志按以下优先级选址，**日志第一行会写明实际用的哪个路径**：

| 优先级 | 路径 | 说明 |
|---|---|---|
| 1 | `%DSH_THINK_PROBE_LOG%` | 环境变量显式指定 |
| 2 | **`%DSH_HOME%\think-probe.log`** | **默认落这里**（本机即 `C:\Users\MSI\.dsh\think-probe.log`） |
| 3 | `<插件目录>\probe.log` | 插件被就地引用时 |
| 4 | `%TEMP%\dsh-think-probe.log` | 兜底 |

> ⚠️ 为什么默认放 `DSH_HOME` 而不是插件目录：`install_bundle` 可能把包装进 profile 的 `node_modules`，
> 那时插件目录的绝对路径不是工作区里这个文件夹，日志会"找不到"。放 `DSH_HOME` 最稳。

### 判定标准

| 日志行 | 含义 |
|---|---|
| `{"ev":"plugin-activated", ...}` | ✅ 插件被激活了 |
| `{"ev":"subscribed","name":"session/event","mode":"global"}` | ✅ 订阅成功（若 `mode:"default"` 说明 global 选项不被支持，但仍是成功订阅） |
| `{"ev":"histogram", "sessionEvents":{...}}` | ✅ **通道是活的**（这是"没抓到思考"时区分原因的关键） |
| `{"ev":"durable:assistant/message", "reasoningChars":1234, "pathsAgree":true}` | ✅✅ **拿到思考原文了（V1 闭环）** |
| `{"ev":"live:start"/"live:end", "reasoningCharsSeenLive":...}` | ✅ 实时通道也通了 |
| `{"ev":"subscribe-failed", ...}` / `{"ev":"handler-error", ...}` | ❌ 订阅或回调出错，把这几行发我 |

**任何情况下都先看 `histogram` 行**：
- 有 `histogram` 且 `sessionEvents` 非空 ⇒ 订阅通道**是通的**，问题只在"这条消息有没有思考"
- **完全没有** `histogram` ⇒ 通道根本没触发，需要改走备选路径（拦 `llm/stream`）

一条命令出结论：

```bash
<python> ../probe-log-summary.py            # 自动找上面 4 个位置
```

---

## 6. 怎么卸

在 DSH 里说：

```
请用 plugin_manager 把 dsh-think-probe 这个 bundle 关掉 / 移除。
```

（`set_bundle` 关掉，或 `remove_bundle` 移除）

---

## 7. 安全性说明

| 项 | 情况 |
|---|---|
| 网络 | 不联网（本身不发任何请求） |
| 文件 | 只**追加写**一个日志文件；不删、不改任何其他文件 |
| DSH 配置 | 只通过官方 `install_bundle` 装一行插件；不手改 profile 文件 |
| 会话数据 | ❌ 不追加任何会话事件 |
| 隐私 | ⚠️ 日志里会包含你的**思考原文**（这正是要验证的东西）；验证完可直接删日志 |
