# -*- coding: utf-8 -*-
"""原子修补 RESOURCE-BUDGET.md：把 P0-2（Node 侧零依赖 TTS）的实测数据补进去"""
import io
import sys

P = "RESOURCE-BUDGET.md"
s = io.open(P, encoding="utf-8").read()
orig = s
applied = []


def sub(name, old, new):
    global s
    if old not in s:
        print(f"  ✗ 未匹配: {name}")
        return
    if s.count(old) != 1:
        print(f"  ✗ 匹配 {s.count(old)} 次（应为 1）: {name}")
        return
    s = s.replace(old, new, 1)
    applied.append(name)
    print(f"  ✓ {name}")


# --- 1) §4.2 之后插入 4.2b：Node 侧零依赖实现的实测 ---
NEW_42B = """
### 4.2b Node 侧零依赖实现（**插件实际采用的路径**，P0-2 实测）

> 背景：npm 上所有 Edge TTS 包（`edge-tts` / `msedge-tts` / `node-edge-tts` / `@andresaya/edge-tts` / `edge-tts-universal`）
> **全部依赖 `ws`**。而 DSH 的 Node 是 **24.18.1**，自带全局 `WebSocket`（undici，且支持 `headers` 选项）→ 协议可自实现，**插件零依赖**。
> 本节数据来自 `p0/p0-2-verify.mjs`；实现见 `p0/edge-tts-zerodep.mjs`。

| 指标 | 实测 |
|---|---|
| 冷启动（第 1 条） | **811 ms** |
| 热态墙钟均值 | **1261 ms** |
| **CPU / 次（中位）** | **16 ms** |
| CPU 合计（6 次） | 156 ms |
| 音频体积 | 中位 30.1 KB；130 字连读 118.8 KB |
| **进程 RSS 增量** | **+19.3 MB**（40.4 → 59.7） |
| 吞吐 | 22.2 字/秒 · 23.0 KB/秒 |
| npm 依赖 | **0 个** |

**与 Python 参考版的一致性（强交叉验证）**：

| 样本 | 零依赖 Node | Python `edge-tts` 参考版 |
|---|---|---|
| 「powersell 又想咬我了」 | 16,416 B | 16,416 B |
| 「哦——原来 param 是必填的…」 | 30,816 B | 30,816 B |
| 「等等，这个正则怎么写都不对…」 | 31,248 B | 31,248 B |
| 「嗯……这个 bug 藏得真深…」 | 27,360 B | 27,360 B |
| 「好，思路清晰了，let me…」 | 31,680 B | 31,680 B |
| 5 句连读（130 字） | 121,680 B | 121,680 B |

**6/6 字节数一致**（同格式 CBR 24kHz/48kbps，字节数一致 ⇒ 时长一致）。
补充：单样本解码后 PCM 比对 → 75.8% 采样点完全相同，最佳对齐 lag=0、**相关系数 0.99975**。

**两个"确定性"事实（避免误判验收判据）**：

1. **同一实现 → 逐字节可复现**：零依赖实现连跑两次 MD5 相同；Python 版连跑两次也相同。
2. **不同实现之间不是逐字节相同**（同为确定性但彼此不同），原因未完全定位，**无实际影响**。
   ⚠️ 因此**「与 Python 版逐字节相同」不是可用判据**；可用判据是「字节数/时长一致 + 解码后高相关 + ASR 可懂」，本次三项均满足。

> ⚠️ 与 4.2 的口径差异：RSS 增量 **+19.3MB（Node）** vs **+3.8MB（Python）**——Node 版多出的是 undici/WebSocket 机制开销。
> **但两者 CPU 都可忽略，"Edge TTS 是网络等待型负载"的结论不变。**
> 且插件里这段跑在 **DSH 自己的 Node 进程内**，属边际分配（大部分可 GC），不是独立进程常驻。
"""
sub(
    "4.2b 插入",
    "> ⚠️ 61.6MB 基线含 Python 解释器 + edge_tts 依赖；插件里这段跑在 Node 进程内，故应看**增量（+3.8MB）**，而非绝对值。",
    "> ⚠️ 61.6MB 基线含 Python 解释器 + edge_tts 依赖；插件里这段跑在 Node 进程内，故应看**增量（+3.8MB）**，而非绝对值。\n" + NEW_42B,
)

# --- 2) §6.1 未测项 #5 关闭 ---
sub(
    "6.1 未测项 #5 关闭",
    "| 5 | **Node 侧 Edge TTS 库的实际内存** | 属 P0-2 范围 | 由 4.2 的 +3.8MB 与 4.1 的 +2.5MB 夹逼，预计个位数 MB |",
    "| 5 | ~~Node 侧 Edge TTS 库的实际内存~~ | ✅ **已测**（P0-2，见 4.2b） | **+19.3 MB RSS / CPU 中位 16 ms**（零依赖自实现） |",
)

# --- 3) §8 末尾补 p0 测量入口 ---
sub(
    "8 补 p0 入口",
    "## 9. 待补测清单（随项目推进）",
    """### 8.1 P0 阶段的附加测量（脚本在 `p0/`）

| 脚本 | 测什么 |
|---|---|
| `p0/p0-2-verify.mjs` | 零依赖 Edge TTS 批量合成 + Node 侧资源画像（**4.2b 的数据来源**） |
| `p0/validate_extractor.py` | 用**真实会话日志**回放验证思考抽取（26 文件 / 181 条 / 两通道 100% 一致） |
| `p0/edge-tts-zerodep.mjs` | 零依赖实现本体（也可当独立 CLI：`node edge-tts-zerodep.mjs "文本" out.mp3`） |

```bash
cd p0
<node> p0-2-verify.mjs        # 约 10s，产出 6 个音频 + p0/out/p02-report.json
<python> validate_extractor.py  # 读 ~/.dsh/sessions，约 5s
```

---

## 9. 待补测清单（随项目推进）""",
)

# --- 4) §9 待补测：P0 行更新 ---
sub(
    "9 待补测 P0 行",
    "| P0 | Node 侧 Edge TTS 库的真实内存/CPU；低配机与 headful 复验 | V2 / V4 |",
    "| P0 | ~~Node 侧 TTS 真实内存/CPU~~ ✅ 已完成（见 4.2b）；**低配机与 headful 复验**仍待 | V2 ✅ / V4 ⏸️ |",
)

if s != orig:
    io.open(P, "w", encoding="utf-8", newline="\n").write(s)
    print(f"\n已写入 {P}；应用 {len(applied)}/4 处")
else:
    print("\n无改动")
    sys.exit(1)
