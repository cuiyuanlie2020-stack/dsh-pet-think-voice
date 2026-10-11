# -*- coding: utf-8 -*-
"""修补 P0-REPORT.md：① 修掉内部坏引用（一行里两个 § 导致歧义）② 把"需回写"改成"已回写"并标注结果"""
import io
import sys

P = "P0-REPORT.md"
s = io.open(P, encoding="utf-8").read()
orig = s
applied = []


def sub(name, old, new):
    global s
    if old not in s:
        print(f"  ✗ 未匹配: {name}")
        return
    if s.count(old) != 1:
        print(f"  ✗ 匹配 {s.count(old)} 次: {name}")
        return
    s = s.replace(old, new, 1)
    applied.append(name)
    print(f"  ✓ {name}")


sub(
    "标题：需回写 → 已回写",
    "## 5. 对设计文档的影响（需回写）",
    "## 5. 对设计文档的影响（✅ 已回写，见下表结果）",
)

OLD_TABLE = """| 文档 | 需改 | 内容 |
|---|---|---|
| `DESIGN.md` §9.1 | 状态更新 | V1 ✅ / V2 ✅（并注明"零依赖实现"）/ V3 ✅ / V4 ⏸️ |
| `DESIGN.md` §6.1 | 契约具体化 | `ThinkingSource` 的取数路径已确认，可去掉"待验证" |
| `DESIGN.md` §6.3 | **实现方式约束** | 明确"**不引入 npm 依赖，用 Node 内置 WebSocket 自实现**"，避免后来人又去引 `ws` |
| `DESIGN.md` §5 | 新增约束 | 思考**中位 1295 字**→ 切分与长度上限是刚需（`FragmentSplitter` 不再是"可选优化"） |
| `RESOURCE-BUDGET.md` §4.2 / §6.1 | 补数据 | Node 侧 Edge TTS 实测（+19.3MB RSS / 16ms CPU）；关闭未测项 #5 |
| `PLAN.md` P0 | 状态更新 | P0-1/P0-2/P0-3 ✅；P0-4 ⏸️ |"""

NEW_TABLE = """| 文档 | 改哪里 | 内容 | 状态 |
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
> 上述改动均以**整篇写入或单次原子脚本写入**完成，并已逐项回读校验。"""

sub("§5 表格整体替换", OLD_TABLE, NEW_TABLE)

if s != orig:
    io.open(P, "w", encoding="utf-8", newline="\n").write(s)
    print(f"\n已写入 {P}；应用 {len(applied)}/2 处")
else:
    print("\n无改动")
    sys.exit(1)
