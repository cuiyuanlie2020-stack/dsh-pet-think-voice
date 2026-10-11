# dsh-pet-think-voice · 开发规则（常驻）

> 本文件是**唯一常驻注入**的规则（仓库根级 `CODEBUDDY.md`，不写 `paths` ⇒ 自动覆盖整个子树）。
> ⚠️ **必须保持精简**——细则放 `docs/`，按需去读，不要往这里塞。
>
> | 想知道什么 | 读哪里 |
> |---|---|
> | 设计契约（**唯一权威**，冲突以它为准） | `docs/DESIGN.md` |
> | 怎么干 / 切片 / 验收判据 | `docs/PLAN.md` |
> | 资源实测与阈值来源 | `docs/RESOURCE-BUDGET.md` |
> | 目录职责 | `lib/core|infra|app/README.md` |

## 0. 一句话

给 DSH 挂一只会说话的鲸鱼娘桌宠：抓模型**思考（reasoning）** → 挑"有戏"的片段 → Live2D 形象 + 语音念出来。
**差异化 = 社区唯一「读思考 + 拟人化 + 发声」的组合**（别人只读回复，或只展示思考不说话）。

## 1. 五条硬红线（违反即返工）

| # | 红线 | 边界（别过度解读） |
|---|---|---|
| **R1** | 不与用户主力负载竞争 | 稳态增量须满足 DESIGN §7.4 阈值表；**任何环节不得在显存中长期驻留模型权重** |
| **R2** | **只读思考，不读正文** | 只消费 `reasoning`，不消费 `content`；可读工具名判相位，但**不得朗读工具产出** |
| **R3** | **零本地依赖** | 用户不装 Ollama / TTS 权重 / Python 时功能必须完整可用；降级**必须留痕**，不得静默 |
| **R4** | 许可物理隔离 | MIT 代码与 CC BY-NC-SA 美术**分目录**，不得混在同一份 LICENSE 下 |
| **R5** | 可一键停 | 能随时静音 / 暂停 / 彻底关闭，无需卸载 |

## 2. 四层边界（依赖单向向下，不得反向）

| 层 | 落点 | 可以 | 禁止 |
|---|---|---|---|
| ① 入口 | host 路由 / 事件订阅；browser slots / EventSource | 参数校验、事件转发 | 写业务逻辑 |
| ② 应用 | `lib/app/` | 编排七步流水线 | 直连外部 API（须经 infra） |
| ③ 领域 | `lib/core/` | 纯逻辑（切分 / 打分 / 改写 / 节流） | import pixi / DSH API / 网络 / Node I/O |
| ④ 基础设施 | `lib/infra/` | TTS provider、SSE、负载探针 | 含业务判断 |

## 3. 实现约束（P0 已定稿，不要重新发明）

- **TTS 只用 Edge 云**：`voice=zh-CN-XiaoyiNeural` + `pitch=+30Hz`。**不做本地 TTS 后端**（DESIGN N7）。
- **零 npm 依赖**：不得引入 `ws` / `axios` / `edge-tts`。DSH 的 Node 24.18.1 自带全局 `WebSocket`。
- **空 reasoning 块 = 无思考**：模型会产出 `type:'reasoning'` 但 `text:''` 的块，不得当候选片段（否则朗读空气）。
- **切分是刚需**：实测思考长度中位 **1295 字**；`dt[]` 是吐字节奏，**不得**当朗读节奏。

## 4. 开发循环（零配置改动，秒级重跑）

**不要**用"安装进 profile"做开发循环。用 DSH 自带 CLI + `--patch` 叠加层：

```bash
DSH_THINK_PROBE_LOG="<工作区>/p0/out/probe.log" \
ELECTRON_RUN_AS_NODE=1 "<DSH>\DeepSeek Harness.exe" --expose-internals \
  "<DSH>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" \
  --profile headless --patch "<工作区>/<overlay>.yml" "<一个需要推理的短问题>"
```

- 叠加层必须用 **`file:///` 绝对路径**（用包名 → `Cannot find package`，已实测）
- ⚠️ **只覆盖 Host 半区**；浏览器侧（气泡 / 口型）需 `web` profile
- ⚠️ **P5 发布前必须另做一次真实安装验证**（GUI 插件页 或 `install_bundle`）

## 5. 改动纪律

- **同一文件的多个改动必须串行**，一次一个 Edit；**改完立刻回读校验**
  （本仓库出现过「Edit 报成功但内容未落盘」）
- 动手前先 `Grep` 确认没有现成实现；>2 分钟的活先报「耗时 / 资源 / 产出 / 能否中断」
- **守卫只能从红变绿，不许把守卫改成不报**
- ⚠️ **根 `package.json` 是 `"type": "module"`** ⇒ 全树 `.js` 都按 ESM 解析。子目录里放 CJS 脚本（`bench/`、`p0/`）**必须**在同层加 `package.json` 写 `{"type":"commonjs"}`，否则 `require is not defined`
- ⚠️ **资源闸只在完整跑里执行**：`--fast` 跳过 R-A/R-B/R-C/R-D。搬动目录结构 / 新增脚本后必须跑一次完整 `run_all.py`

## 6. 改完必做

```bash
<python> scripts/review/run_all.py          # 全部检查（含资源闸，约 2 分钟）
<python> scripts/review/run_all.py --fast   # 只跑结构与静态检查（秒级）
```

## 7. 提交与永不入库

- 格式 `<type>(<scope>): <描述>`（`feat`/`fix`/`refactor`/`docs`/`test`/`chore`/`exp`）；**一个提交只做一件事**；正文写"为什么"
- 🔴 **永不入库**：`vendor/`（上游仓库，自带 `.git`）· `p0/sessions/`（**真实对话内容，隐私**）· `p0/out/` · `p0/extract/` · `bench/out/` · `tts-demo/bin/` 与样音 · `live2dcubismcore.min.js`（**专有，不可再分发**）· `.workbuddy/`
- 加新排除项后必须 `git check-ignore -v <路径>` 实测：**`.gitignore` 不支持行尾注释**，写了会整条静默失效
