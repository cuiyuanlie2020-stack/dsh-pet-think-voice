# `lib/core/` — 领域层

> 归属：`docs/DESIGN.md` §4.3 四层模型的**【③ 领域】**。**本项目最值钱的部分。**

## 职责：纯逻辑

能脱离 DSH、脱离浏览器**单独跑单测**——这是本项目唯一能沉淀成资产的层。

| 模块 | 文件 | 职责 | 输入 → 输出 | 状态 |
|---|---|---|---|---|
| `thinking-extractor` | `thinking-extractor.js` | 从会话事件提取 reasoning 原始文本 | `session event` → `string` | ✅ P2-1（26 例单测；真实语料 212/212 两通道一致） |
| `fragment-splitter` | `fragment-splitter.js` | 长思考切成语义完整、适合朗读的小片段 | `string` → `Fragment[]` | ✅ P2-3（21 例；真实语料 0 超限 / 0 丢字） |
| `interest-scorer` | `interest-scorer.js` | 片段"有趣度"打分（规则 + 可选小模型） | `Fragment` → `score 0..1` | ✅ P2-4 规则级（19 例）；P4-1 校词表 / P4-4 接小模型 |
| `reasoning-language` | `reasoning-language.js` | 思考语种：策略校验 / 注入文案 / 语种检测 / **音色解析（有状态）** | `policy` → resolver → `{voice, pitch, lang, reason}` | ✅ P3-0（21 例）。音色**由策略决定且会话内恒定** —— 绝不逐句切换（用户 2026-10-11 修正） |
| `line-polisher` | `line-polisher.js` | 拟人化：清洗 + 裁齐 + 产出 `emotion` 标签 | `Fragment` + 打分结果 → `Line \| null` | ✅ P4-2（30 例）。🔴 **只挑只裁不改字**，被"输出是输入的子序列"不变量守着（DESIGN §5.2） |
| `speech-planner` | `speech-planner.js` | 节流 / 去重 / 排队 / 频率闸 | `Line[]` → `SpeakTask[]` | ✅ P2-5（23 例） |
| `load-gate` | `load-gate.js` | 负载闸**判定**：超阈值**持续** N 秒 ⇒ 静默，回落持续 N 秒 ⇒ 恢复 | `sample, now` → `{silent, changed}` | ✅ P3-5（11 例）。**采样**在 `lib/infra/load-probe.js` |

⚠️ **切分是刚需，不是可选优化**：实测 181 条真实思考，长度**中位 1295 字、最长 14994 字**。
一条思考按朗读速度能读十几分钟，不切分就没法用。
`dt[]`（逐 token 毫秒增量）是模型**吐字**节奏，**不得**当朗读节奏用。

## ⛔ 禁止

- import pixi / Live2D / DSH API / 任何网络库 / 任何 Node 内置 I/O 模块
- 出现框架概念（`session`、SSE、`ParamMouthOpenY` 之类）
- 反向依赖 `lib/app/` 或 `lib/infra/`（**依赖只能单向向下**）

## ✅ 验收判据

把 `lib/core/` 单独拷到一个空目录，`node --test` 能全绿。
