# -*- coding: utf-8 -*-
"""原子更新三份文档：D1 项目名定为 dsh-pet-think-voice + 探针使用指引"""
import io
import os
import sys

TOTAL = 0


def patch(path, pairs, label):
    global TOTAL
    s = io.open(path, encoding="utf-8").read()
    orig = s
    print(f"\n### {label}  ({path})")
    ok = 0
    for name, old, new in pairs:
        if old not in s:
            print(f"  ✗ 未匹配: {name}")
            continue
        if s.count(old) != 1:
            print(f"  ✗ 匹配 {s.count(old)} 次: {name}")
            continue
        s = s.replace(old, new, 1)
        ok += 1
        print(f"  ✓ {name}")
    if s != orig:
        io.open(path, "w", encoding="utf-8", newline="\n").write(s)
        print(f"  → 已写入（{ok}/{len(pairs)} 处）")
        TOTAL += ok
    else:
        print("  → 无改动")

    # 立即回读校验（本仓库出现过 Edit 被回退的情况）
    back = io.open(path, encoding="utf-8").read()
    for name, _old, new in pairs:
        key = new[:40]
        if key not in back:
            print(f"  ⚠️ 回读校验失败: {name}")
    return ok


DOCS = os.path.join("..", "docs")

# ---------------- DESIGN.md ----------------
patch(
    os.path.join(DOCS, "DESIGN.md"),
    [
        (
            "header 增加项目名",
            "> | 版本 | v0.3（**P0 技术风险验证完成**：V1/V2/V3 成立，V4 待低配机） |",
            "> | 版本 | v0.3（**P0 技术风险验证完成**：V1/V2/V3 成立，V4 待低配机） |\n> | 项目名 | **`dsh-pet-think-voice`**（已定，已核 npm 404 / GitHub 0 结果） |",
        ),
        (
            "D1 行标为已定",
            "| D1 | **项目/仓库名** | `dsh-pet-think-voice` / `dsh-thinking-pet` / `dsh-pet-murmur` | 仓库初始化、社区识别 |",
            "| D1 | **项目/仓库名** | ✅ **已定为 `dsh-pet-think-voice`**（P1-1 完成） | 已核验未占用：npm HTTP 404 / GitHub 0 结果 |",
        ),
    ],
    "DESIGN",
)

# ---------------- PLAN.md ----------------
patch(
    os.path.join(DOCS, "PLAN.md"),
    [
        (
            "header 相对 v0.2 追加 D1",
            "③ P2-1/P2-3 因\"思考中位 1295 字\"的实测结论而升级优先级 |",
            "③ P2-1/P2-3 因\"思考中位 1295 字\"的实测结论而升级优先级；④ **D1 项目名定为 `dsh-pet-think-voice`** |",
        ),
        (
            "header 当前阻塞",
            "> | 当前阻塞 | **D1 项目名需在 P1 开工前定**（其余无阻塞） |",
            "> | 当前阻塞 | **无**（D1 已定为 `dsh-pet-think-voice`） |",
        ),
        (
            "P1-1 标记完成",
            "| P1-1 | **定项目名**（D1，**当前唯一阻塞**） | —— | 名字确认，且与社区现有插件不重名 | —— | 15min |",
            "| P1-1 | ~~定项目名~~（D1）✅ **已完成** | —— | **`dsh-pet-think-voice`** | 已核 npm 404 / GitHub 0 结果，且不与社区已知插件重名 | —— |",
        ),
        (
            "§8 D1 行",
            "| D1 | **项目名/仓库名** | **P1** | **P1 开工前（当前唯一阻塞）** |",
            "| D1 | ~~项目名/仓库名~~ ✅ **已定 `dsh-pet-think-voice`** | P1 | 已解决（P1-1 完成） |",
        ),
        (
            "§9 状态补项目名与下一步",
            "| 下一步 | ▶️ **P1 建骨架**；开工前需定 **D1 项目名** |",
            "| 项目名（D1） | ✅ **`dsh-pet-think-voice`**（npm 404 / GitHub 0 结果） |\n| 探针插件 | ⏸️ 已通过语法/清单检查，含安装说明 `p0/probe-plugin/README.md` 与判读器 `p0/probe-log-summary.py` |\n| 下一步 | ▶️ **P1 建骨架**（P1-1 已完成，从 **P1-2 建 git 基线**起） |",
        ),
    ],
    "PLAN",
)

# ---------------- P0-REPORT.md ----------------
patch(
    "../../p0/P0-REPORT.md",
    [
        (
            "§1.6 补安装指引",
            "这一步**必须由你在 DSH 里操作**（官方技能明确：插件只能通过 `plugin_manager` 的 `install_bundle` 安装，不能手工写 profile 文件）。",
            """这一步**必须由你在 DSH 里操作**（官方技能明确：插件只能通过 `plugin_manager` 的 `install_bundle` 安装，不能手工写 profile 文件）。

**怎么做（详见 [`probe-plugin/README.md`](./probe-plugin/README.md)）**：

1. 在 DSH 里说：把 `C:\\Users\\MSI\\WorkBuddy\\2026-10-11-06-15-07\\p0\\probe-plugin` 作为 bundle 装到当前 profile（`install_bundle`，target 用绝对路径）；
2. 它会请你审批 → 允许；看返回的 `application` 字段是否为 `applied`（**以这个字段为准**）；
3. 问它一个需要推理的问题（纯闲聊可能不产生 reasoning）；
4. 日志默认落在 `%DSH_HOME%\\think-probe.log`（本机即 `C:\\Users\\MSI\\.dsh\\think-probe.log`），**日志第一行会写明实际路径**；
5. 一条命令出结论：`<python> p0/probe-log-summary.py`（退出码 0=闭环 / 2=通道通但无思考 / 3=通道没通）。

探针**只写一个日志文件**：无界面、不联网、不改 DSH 配置、不追加任何会话事件；验证完可用 `remove_bundle` 移除。""",
        ),
        (
            "§7 下一步细化",
            "1. **你花 1 分钟闭环 V1**：在 DSH 里让它把 `p0/probe-plugin/` 装上（`plugin_manager` → `install_bundle`，target = 该目录绝对路径），跑一轮带思考的提问，我读 `probe.log` 确认。\n2. 进 **P1 建骨架**（git 基线 / 目录 / `CODEBUDDY.md` / `run_all` / 资源可回归）。\n3. **P0-4 挂到 P5**，发布前借低配机复验。",
            """1. ✅ **项目名已定：`dsh-pet-think-voice`**（已核未占用）→ **D1 阻塞解除，P1 已解锁**。
2. **你花 1 分钟闭环 V1**：按 [`probe-plugin/README.md`](./probe-plugin/README.md) 把探针装进 DSH，跑一轮带思考的提问；完成后跑 `p0/probe-log-summary.py` 出结论（也可发我，我来判读）。
3. 进 **P1 建骨架**（git 基线 / 目录 / `CODEBUDDY.md` / `run_all` / 资源可回归）——P1-1 已完成，从 **P1-2** 起。
4. **P0-4 挂到 P5**，发布前借低配机复验。""",
        ),
    ],
    "P0-REPORT",
)

print(f"\n合计写入 {TOTAL} 处")
if TOTAL == 0:
    sys.exit(1)
