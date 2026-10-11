# -*- coding: utf-8 -*-
"""单独补 P0-REPORT.md 的两处更新（在 p0/ 目录下运行）"""
import io
import sys

P = "P0-REPORT.md"
s = io.open(P, encoding="utf-8").read()
orig = s
ok = 0

PAIRS = [
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
]

for name, old, new in PAIRS:
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
    io.open(P, "w", encoding="utf-8", newline="\n").write(s)
    print(f"  → 已写入（{ok}/{len(PAIRS)} 处）")
else:
    print("  → 无改动")
    sys.exit(1)

back = io.open(P, encoding="utf-8").read()
print(f"  回读：probe-log-summary={back.count('probe-log-summary')} / probe-plugin/README={back.count('probe-plugin/README')} / 项目名={back.count('dsh-pet-think-voice')}")
