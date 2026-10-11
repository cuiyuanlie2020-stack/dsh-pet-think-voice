# -*- coding: utf-8 -*-
"""V1 闭环后回写：P0-REPORT / DESIGN / PLAN / probe README / INSTALL-PATH-FINDINGS"""
import io
import os
import sys

WS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DONE = 0


def rw(path):
    return io.open(path, encoding="utf-8").read()


def wr(path, s):
    io.open(path, "w", encoding="utf-8", newline="\n").write(s)


def replace(path, label, old, new):
    global DONE
    s = rw(path)
    if old not in s:
        print(f"  ✗ 未匹配: {label}")
        return
    if s.count(old) != 1:
        print(f"  ✗ 匹配 {s.count(old)} 次: {label}")
        return
    wr(path, s.replace(old, new, 1))
    back = rw(path)
    mark = new.strip()[:36]
    ok = mark in back
    print(f"  {'✓' if ok else '⚠'} {label}{'' if ok else '（回读校验失败）'}")
    DONE += 1


def splice(path, label, start_marker, end_marker, new_block):
    """用标记位整段替换（robust：不受中间内容变动影响）"""
    global DONE
    s = rw(path)
    a = s.find(start_marker)
    b = s.find(end_marker)
    if a < 0 or b < 0 or b <= a:
        print(f"  ✗ 定位失败: {label} (a={a}, b={b})")
        return
    wr(path, s[:a] + new_block + s[b:])
    back = rw(path)
    ok = new_block.strip()[:36] in back
    print(f"  {'✓' if ok else '⚠'} {label}{'' if ok else '（回读校验失败）'}")
    DONE += 1


P_P0 = os.path.join(WS, "p0", "P0-REPORT.md")
P_DESIGN = os.path.join(WS, "docs", "DESIGN.md")
P_PLAN = os.path.join(WS, "docs", "PLAN.md")
P_README = os.path.join(WS, "p0", "probe-plugin", "README.md")
P_FIND = os.path.join(WS, "p0", "INSTALL-PATH-FINDINGS.md")

# ─────────────────────────── P0-REPORT §1.6 ───────────────────────────
NEW_16 = """### 1.6 ✅ 运行时闭环（已实测，2026-10-11）

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
DSH_THINK_PROBE_LOG="<工作区>/p0/out/probe.log" \\
ELECTRON_RUN_AS_NODE=1 "<DSH>\\DeepSeek Harness.exe" --expose-internals \\
  "<DSH>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" \\
  --profile headless \\
  --patch "<工作区>/p0/probe-plugin/overlay-byfile.yml" \\
  "先读 p0/probe-plugin/package.json，然后用一句话回答：这个包声明自己是 bundle 吗？"
```

> 📌 **这条命令同时就是本项目 P2/P3 的开发循环**：改代码 → 重跑一次，不需安装/卸载。

---

"""
splice(P_P0, "P0-REPORT §1.6 改为已闭环",
       "### 1.6 ⚠️ 残留未闭环（唯一的一处）",
       "## 2. P0-2 · Node 侧能否出语音（V2）",
       NEW_16)

# ─────────────────────────── DESIGN §9.1 注 ───────────────────────────
replace(
    P_DESIGN,
    "DESIGN §9.1 未闭环注改为已闭环",
    "> ⚠️ V1 尚有一处**未闭环**：「探针插件装进 DSH 后实时订阅是否真的触发」需要一次实际安装验证（安装只能通过 DSH 的 `plugin_manager install_bundle`）。这是唯一残留项，不影响设计成立。",
    "> ✅ V1 已**运行时闭环**（2026-10-11 实测）：用 DSH 自带 CLI 的 `--patch` 叠加层加载探针并跑真实会话，两条通道均触发，`reasoningChars=149`、`pathsAgree=true`。证据：`p0/out/probe.log`、`p0/INSTALL-PATH-FINDINGS.md`。\n"
    "> ⚠️ 实测发现：**模型会产出空的 reasoning 块**（块类型为 `reasoning` 但 `text` 为空）→ 实现必须把空块视为无思考（见 P0-REPORT 1.6）。",
)

# ─────────────────────────── PLAN：删重复行 + 改状态 + 加开发循环 ───────────────────────────
replace(
    P_PLAN,
    "PLAN §9 探针行（上）改完成",
    "| 探针插件 | ⏸️ `p0/probe-plugin/` 已就绪，待装进 DSH 做最后一步实时闭环 |",
    "| 探针插件 | ✅ **已实测闭环 V1**（DSH 自带 CLI + `--patch` 叠加层，零配置改动） |",
)
replace(
    P_PLAN,
    "PLAN §9 删除重复探针行",
    "| 探针插件 | ⏸️ 已通过语法/清单检查，含安装说明 `p0/probe-plugin/README.md` 与判读器 `p0/probe-log-summary.py` |\n",
    "| 探针使用说明 | ✅ `p0/probe-plugin/README.md`；日志判读器 `p0/probe-log-summary.py`（退出码 0=闭环/2=无思考/3=通道没通） |\n",
)

NEW_03 = """
### 0.3 开发循环（已实测，**零配置改动**）

P2/P3 要反复调试插件。**不要用"安装进 profile"的方式做开发循环**——太笨重（pnpm + build + 卸载）。
已实测可用的循环是 **DSH 自带 CLI + `--patch` 叠加层**：

```bash
DSH_THINK_PROBE_LOG="<工作区>/p0/out/probe.log" \\
ELECTRON_RUN_AS_NODE=1 "<DSH>\\DeepSeek Harness.exe" --expose-internals \\
  "<DSH>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" \\
  --profile headless \\
  --patch "<工作区>/<overlay>.yml" \\
  "<一个需要推理的短问题>"
```

| 特性 | 说明 |
|---|---|
| 叠加层引用方式 | **必须用 `file:///` 绝对路径**；用包名会 `Cannot find package`（实测） |
| 配置改动 | **无**——`--patch` 是启动期叠加，不落盘（已核验 profile 文件与 hooks 未被触碰） |
| 可重复 | ✅ 改代码 → 重跑，秒级 |
| 覆盖范围 | ⚠️ **仅 Host 半区**（不覆盖浏览器侧：气泡/口型）→ 浏览器侧需 `web` profile |
| 副作用 | 新增一条 session 日志；探针日志用 `DSH_THINK_PROBE_LOG` 指到工作区，不污染 `~/.dsh` |

⚠️ **P5 发布前必须另做一次"真实安装路径"验证**（GUI 插件页 或 `plugin_manager.install_bundle`），
否则"社区用户能装上"这件事从未被验证。详见 `p0/INSTALL-PATH-FINDINGS.md`。
"""
replace(
    P_PLAN,
    "PLAN 新增 §0.3 开发循环",
    "> ⚠️ **L4 的补充（P0 实测教训）**：本仓库出现过「Edit 报告成功但内容被并发写入/格式化回退」。\n> **改动后必须立即回读校验**；批量改动建议整篇一次写入，而不是多次 Edit。",
    "> ⚠️ **L4 的补充（P0 实测教训）**：本仓库出现过「Edit 报告成功但内容被并发写入/格式化回退」。\n> **改动后必须立即回读校验**；批量改动建议整篇一次写入，而不是多次 Edit。\n"
    + NEW_03,
)

# ─────────────────────────── probe README §3 重写 ───────────────────────────
NEW_SEC3 = """## 3. 怎么装（两种方式）

### 🟢 方式一（推荐 · 已实测）：不安装，用 `--patch` 叠加层直接加载

**零配置改动**：不改 profile、不碰 hooks、不切 Agent 预设、不跑 pnpm。改代码后重跑即可 → 也**正是开发循环**。

```bash
DSH_THINK_PROBE_LOG="<工作区>/p0/out/probe.log" \\
ELECTRON_RUN_AS_NODE=1 "<DSH>\\DeepSeek Harness.exe" --expose-internals \\
  "<DSH>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" \\
  --profile headless \\
  --patch "<工作区>/p0/probe-plugin/overlay-byfile.yml" \\
  "先读 p0/probe-plugin/package.json，然后用一句话回答：这个包声明自己是 bundle 吗？"
```

> `<DSH>` = `C:\\Users\\MSI\\AppData\\Local\\Programs\\DeepSeek Harness`
> ⚠️ 叠加层里**必须用 `file:///` 绝对路径**引用 `index.js`；用包名会报 `Cannot find package`（实测）。

**2026-10-11 已用此方式实测通过**（`probe-log-summary.py` 退出码 0，`reasoningChars=149`、`pathsAgree=true`）。

### 🔵 方式二：真正安装进 profile（P5 验证"社区能不能装上"时用）

⚠️ **不能手工装。** DSH 官方明确规定：不许手写 profile 的 `package.json` / `cordis.patch.yml`、
不许在 profile 目录里跑 pnpm。**必须走 DSH 自己的 `plugin_manager` 工具。**

在 DSH（桌面版）里新开一个会话，把下面这句发给它：

"""
splice(P_README, "probe README §3 重写",
       "## 3. 怎么装（只能由 DSH 自己装）",
       "## 4. 怎么产生思考",
       NEW_SEC3)

# ─────────────────────────── INSTALL-PATH-FINDINGS 补实测结论 ───────────────────────────
replace(
    P_FIND,
    "FINDINGS 顶部补实测结论",
    "> | 结论 | **推荐路径 = DSH 自带 CLI + `--patch` 叠加层**（零安装、零配置改动、可反复重跑） |",
    "> | 结论 | **推荐路径 = DSH 自带 CLI + `--patch` 叠加层**（零安装、零配置改动、可反复重跑） |\n"
    "> | 实测状态 | ✅ **2026-10-11 端到端跑通** —— V1 已闭环（`p0/out/probe.log`，判读器退出码 0） |",
)

print(f"\n合计修改 {DONE} 处")
if DONE < 7:
    print("⚠️ 有未应用的修改，请检查")
    sys.exit(1)
