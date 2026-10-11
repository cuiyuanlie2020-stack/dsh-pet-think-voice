# 交接简报 · dsh-pet-think-voice

> **用途**：在新对话 / 新会话里接手本项目时，**先读本文件**，然后按 §7 开工。
> ⚠️ 本文件是**进度交接简报**，不是权威设计。任何契约冲突，一律以 [`DESIGN.md`](./DESIGN.md) 为准。
>
> | 项 | 值 |
> |---|---|
> | 更新时间 | 2026-10-11 |
> | 工作区 / 仓库根 | `C:/Users/MSI/WorkBuddy/2026-10-11-06-15-07/`（**两者相同**，就地 `git init`） |
> | 阶段 | P0 ✅ · P1 ✅ · **P2 ← 现在在这里** |
> | HEAD | `210e6ac` · tag `v0.2-p1-scaffold-2026-10-11` |
> | 实现代码 | **0 行**（`p0/` 是探针与原型，`scripts/review/` 是验收脚本） |

---

## 0. 30 秒版

**做什么**：给 DSH（DeepSeek Harness）挂一只会说话的鲸鱼娘桌宠——实时抓模型的**思考内容（reasoning）**，挑出其中"有戏"的片段，用 Live2D 形象 + Edge 云语音念出来，让长时间 vibecoding 不无聊。

**差异化（立身之本）**：社区已有插件只覆盖两头——**读回复**（`dsh-plugin-tts` / `dsh-voice-mini` / `dsh-read-aloud`）和**展示思考**（`dsh-thinking-summary` / `dsh-think-expand`）。**「读思考 + 拟人化 + 发声」这个组合无人做。**

**到哪了**：地基全验完（P0），骨架全就位（P1，一条命令可回归资源红线）。**下一步是 P2 = 让思考流出到气泡里（先不出声）**。

---

## 1. 先读这几份（按需，别通读）

| 顺序 | 文件 | 读哪节 | 为什么 |
|---|---|---|---|
| 1 | `CODEBUDDY.md`（仓库根） | 全部 | 常驻规则：R1–R5 红线 / 四层边界 / 开发循环 / 永不入库清单。**新会话应自动注入**；没看到注入说明工作区开的不是这个目录 |
| 2 | `docs/DESIGN.md` | §2 §4 §5 §6 | 唯一权威设计；§6 是接口契约（**改契约必须同步 PLAN 与代码**） |
| 3 | `docs/PLAN.md` | §0 §4 §8 §9 | §0 切片定义与开工纪律；§4 = P2 任务书；§8 待定项；§9 当前状态 |
| 4 | `p0/P0-REPORT.md` | §1（V1 取数） | P2 取数实现要照的实测证据 |
| 5 | `lib/core/README.md` | 全部 | 领域层职责与禁止项（P2 主战场） |
| 6 | `docs/RESOURCE-BUDGET.md` | §7 §8 | 只在关心资源数字/复现命令时读 |

---

## 2. 当前状态快照

| 项 | 值 |
|---|---|
| 仓库 | 52 文件 / 363 KB；`.git` 约 300 KB；工作区总 110 MB（其余为不入库资产） |
| 提交 | `ba22367`（基线）→ `f13b52e` `31bde0e` `210e6ac`（P1 三个原子提交） |
| tag | `v0.1-baseline-2026-10-11`（P0 收口）· `v0.2-p1-scaffold-2026-10-11`（P1 骨架） |
| 验收 | `<python> scripts/review/run_all.py` → **33 PASS / 0 FAIL / 1 SKIP / 2 INFO**（约 1m48s） |
| 目录骨架 | `lib/core` `lib/infra` `lib/app`（各带职责 README）· `scripts/review/` · `experiments/` · `docs/` · `p0/` · `bench/` |
| 规则形态 | **仓库根级 `CODEBUDDY.md`**（不写 `paths`，覆盖整子树）——机制已由引擎代码核实 |
| 探针证据 | `p0/out/probe.log`（V1 运行时闭环，**已被 gitignore，不入库**，本机还在盘上） |
| P2 语料 | `~/.dsh/sessions/**/session.v4.jsonl.zstd`（**27 个**；其中就有本工作区的会话目录） |

---

## 3. 硬约束速查（违反即返工）

| # | 红线 | 边界 |
|---|---|---|
| **R1** | 不与用户主力负载竞争 | 稳态增量须满足 DESIGN §7.4 阈值表；**任何环节不得在显存中长期驻留模型权重** |
| **R2** | **只读思考，不读正文** | 只消费 `reasoning`，不消费 `content`；可读工具名判相位，但**不得朗读工具产出** |
| **R3** | **零本地依赖** | 用户不装 Ollama / TTS 权重 / Python 时功能必须完整；降级**必须留痕**，不得静默 |
| **R4** | 许可物理隔离 | MIT 代码与 CC BY-NC-SA 美术**分目录**；Cubism Core **不可随包分发** |
| **R5** | 可一键停 | 随时静音 / 暂停 / 彻底关闭，无需卸载 |

**三条"P0 已定稿，不要重新发明"**：

1. **TTS 只用 Edge 云**：`voice=zh-CN-XiaoyiNeural` + `pitch=+30Hz`。**不做本地 TTS 后端**（DESIGN N7）。
2. **零 npm 依赖**：不得引入 `ws` / `axios` / `edge-tts`。DSH 的 Node 24.18.1 自带全局 `WebSocket`（undici，支持 `headers`）→ 协议自实现（原型 `p0/edge-tts-zerodep.mjs`）。
3. **思考切分是刚需**：实测 181 条真实思考，长度**中位 1295 字、最长 14994 字**。`dt[]` 是吐字节奏，**不得**当朗读节奏。

---

## 4. 关键契约（照这个写，别猜）

### 4.1 取数：两条通道，**签名不一样**

```js
// 持久通道（可回放）—— 两个位置参数
ctx.on('session/event', (session, event) => {
  if (event.type !== 'assistant/message') return;
  // 完整思考：event.data.message.content[].type === 'reasoning' → .text
  // 逐 token ：event.data.stream[].type === 'reasoning-chunks'    → .texts[]
}, { global: true });

// 实时通道（瞬态）—— 一个对象参数
ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') {
    /* frame.chunk.text */
  }
}, { global: true });
```

- 两者抽出的文本**实测 181/181 完全一致** → 可任选，或"实时挑、持久兜底"。
- 两者都需要 `{ global: true }`（它们是 Scoped 事件）。
- ⚠️ **空 reasoning 块 = 无思考**：实测模型会产出 `contentBlockTypes: ["reasoning","text"]` 但 **`reasoningChars: 0`** 的块。**不得**仅凭块类型是 `reasoning` 就当候选片段，否则朗读空气。

### 4.2 下游帧（只是形状，P2-6 才实现）

```jsonc
{ "type": "speak", "payload": { "text": "...", "audioUrl": "/api/.../audio/xxx.mp3", "emotion": null } }
// emotion 由 P4-3 引入；在此之前恒为 null，浏览器侧必须容忍缺省
```

### 4.3 四层落点（依赖只单向向下）

| 层 | 落点 | 禁止 |
|---|---|---|
| ① 入口 | host 路由 / 事件订阅；browser slots / EventSource | 写业务逻辑 |
| ② 应用 | `lib/app/` | 直连外部 API（须经 infra） |
| ③ 领域 | **`lib/core/`** | import pixi / DSH API / 网络 / Node I/O |
| ④ 基础设施 | `lib/infra/` | 含业务判断 |

⚠️ `lib/core/` 必须能**脱离 DSH、脱离浏览器单独跑单测**——这是本项目唯一能沉淀成资产的层。判据：把它单独拷到空目录，`node --test` 全绿。

---

## 5. 环境与命令（可直接复制）

```
<node>    = C:\Users\MSI\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
<python>  = C:\Users\MSI\.workbuddy\binaries\python\versions\3.13.12\python.exe   （入口脚本用这个，仅标准库）
<bench-py>= C:\Users\MSI\.workbuddy\binaries\python\envs\cosyvoice\Scripts\python.exe  （含 psutil / edge-tts）
<DSH>     = C:\Users\MSI\AppData\Local\Programs\DeepSeek Harness
```

**验收**（改完必跑）：

```bash
<python> scripts/review/run_all.py --fast    # 秒级：结构 / 忽略清单 / 密钥 / 体积 / 单测
<python> scripts/review/run_all.py           # 完整：加 4 组资源探针（约 1m48s），超 DESIGN 7.4 阈值即 FAIL
```

**开发循环**（零安装、零配置改动、秒级重跑；**P2-2 起每次调试都用它**）：

```bash
DSH_THINK_PROBE_LOG="p0/out/probe.log" \
ELECTRON_RUN_AS_NODE=1 "<DSH>\DeepSeek Harness.exe" --expose-internals \
  "<DSH>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" \
  --profile headless --patch "<overlay>.yml" "<一个需要推理的短问题>"
```

- 叠加层必须用 **`file:///` 绝对路径**（用包名 → `Cannot find package`，已实测）
- ⚠️ **只覆盖 Host 半区**；浏览器侧（气泡 / 口型）需 `web` profile
- ⚠️ **P5 发布前必须另做一次真实安装验证**（GUI 插件页 或 `install_bundle`），否则"社区能装上"从未被验证

---

## 6. ⚠️ P2 开工前的**第一个待决项（D8，PLAN §8 已登记）**

**问题**：P2-2 要改 `lib/index.js`、P2-6 要改 `lib/client.js`，但**本仓目前没有这两个文件**——上游插件包还在 `vendor/dsh-pet-live2d/dsh-live2d-pet/`（整体不入库）。

| 方案 | 做法 | 代价 |
|---|---|---|
| **甲（推荐）** | 把上游 `dsh-live2d-pet/` 的插件文件复制到仓库根作为改造基线：`package.json` / `cordis.patch.yml` / `lib/`（含 `live2d-vendor.js`）/ `locale/` / `pets/` / `icon.png` / `src/`。上游 `LICENSE` + `NOTICE.md` **原样保留不可改写**；模型按 R4 **分目录** | 需一次搬运（含 `lib/` 1.4MB + `pets/` 4.2MB + vendor 783KB）；改动记录干净 |
| 乙 | 先做真正的 GitHub fork，`git remote add upstream` + `merge --allow-unrelated-histories` | 现在就要处理两个不相干历史的合并，而本仓已有 P0/P1 独立历史 |
| 丙 | 本仓只放改造层，上游代码构建期从 npm 拉 | 破坏离线开发；P5 打包复杂化 |

**开工前先确认走甲。** 另需注意：搬运后 `run_all.py --fast` 的 S4（入库体积 ≤10MB）会从 0.26MB 涨到约 7MB——仍达标，但需复核；`pets/` 与 Cubism Core 的许可边界要按 R4 明确落在 `.gitignore` 或分目录。

---

## 7. ▶️ 下一步：P2 最小闭环（无声音）

**目标：思考流出来。** 出口判据 —— **连续 vibecoding 10 分钟，气泡至少出现 3 条可读、不重复、不是废话的思考片段。**

| 编号 | 切片 | 改哪里 | ✅ 验收判据 | 回归判据 | 预估 |
|---|---|---|---|---|---|
| P2-1 | `ThinkingExtractor` | `lib/core/thinking-extractor.*` + 单测 | 单测：给定样本事件 → 提取出预期文本；**语料取自 `p0/` 验过的真实会话数据** | 单测全绿 | 2h |
| P2-2 | host 接入采集 | `lib/index.js` 订阅（§4.1 两条通道）+ 调 P2-1 | 真实会话中 host 日志出现思考片段 | **原有 8 相位仍正常** | 2h |
| P2-3 | `FragmentSplitter` | `lib/core/fragment-splitter.*` + 单测 | 单测：长思考（≥1000 字）→ 语义完整片段（不切碎句子）；含**长度上限** | 单测全绿 | 2h |
| P2-4 | `InterestScorer`（**仅规则级**） | `lib/core/interest-scorer.*` + 词表 + 单测 | 单测：命中词表片段得分高；噪声片段得分低 | 单测全绿 | 2h |
| P2-5 | `SpeechPlanner`（仅节流/去重） | `lib/core/speech-planner.*` + 单测 | 单测：30s 内最多出 1 句；重复片段被去重 | 单测全绿 | 1.5h |
| P2-6 | SSE 下发 + 气泡显示 | `lib/index.js`（`speak` 帧）+ `lib/client.js`（气泡） | 真实会话中**气泡出现思考片段文字** | 气泡原有功能（相位提示）不受影响 | 2h |

**优先级**：P2-1 与 P2-3 最高（不切分就没法用，因为思考中位 1295 字）。

**纪律**（PLAN §0.2）：L1 任何 >2 分钟的任务先报「耗时 / 资源 / 产出 / 能否中断」；L2 小样本能验的绝不跑全量；L4 **同一文件改动必须串行 + 改完回读校验**；L5 改完立刻跑验收。**开新分支**（`feat/p2-thinking-extractor` 等），别直接改 `main`。

---

## 8. 已知坑（都踩过，别重复）

| # | 坑 | 对策 |
|---|---|---|
| 1 | **`.gitignore` 不支持行尾注释** —— 写了整条规则静默失效 | 改排除清单后跑 `run_all.py --fast`（S2 逐条 `git check-ignore` 实测） |
| 2 | 判断"会不会入库"别有 `git ls-files`（只看已跟踪） | 用 `git ls-files -c -o --exclude-standard` |
| 3 | **编辑报成功但未落盘**（本仓库真实发生过） | 同文件改动串行；多处替换用**单次原子脚本 + 逐处计数校验**，改完回读 |
| 4 | `--patch` 叠加层用包名 → `Cannot find package` | 必须 `file:///` 绝对路径 |
| 5 | `bench/resource_probe.py` 把 JSON 写到 CWD | 用 `cwd=bench/out` 调起 |
| 6 | 会话日志 `session.v4.jsonl.zstd` 是**多帧** zstd | 必须 `zstandard` 的 `stream_reader(read_across_frames=True)`；`read_across_frames` 是 `stream_reader` 的参数，不是 `ZstdDecompressor()` 的 |
| 7 | Windows CPU 计时精度 **15.6ms** | "0ms" 读作 "<15.6ms"，不是绝对零 |
| 8 | 浏览器 CPU 别用跨进程求和（Edge 进程数会变，进程退出会丢已累计 CPU） | 用页面内 ticker 首尾插桩；两法互证 |
| 9 | 插件只能由 DSH 自己装：`plugin_manager.install_bundle` | **不许**手写 profile 的 `package.json` / `cordis.patch.yml`，**不许**在 profile 目录跑 pnpm |

---

## 9. 明确不做（防范围蔓延，DESIGN §3.2）

N1 不做"读回复全文" · N2 不做账号/云端同步 · N3 不训练/微调模型 · N4 不内置版权不清素材 · N5 不做移动端/非 DSH 适配 · N6 不追求"朗读 100% 覆盖思考" · **N7 不做本地 TTS 后端**（Kokoro / CosyVoice / GPT-SoVITS 全部已评估并放弃，理由见 DESIGN §8.3）。

## 10. 待定项

| # | 待定 | 最晚定于 |
|---|---|---|
| **D8** | **上游插件包如何进入本仓（§6）** | **P2 开工前（当前唯一阻塞）** |
| D3 | 朗读节奏参数（可先默认 30s/1 句） | P2-5 开工前 |
| D5 | Tauri 桌面壳是否保留 | P3 结束前 |
| D2 | 筛选词表与阈值 | P4-1（需真实数据校准） |
| D6 | 小模型打分是否默认开 | P4-4 |
| D7 | 负载哨兵阈值与检测周期 | P3-5 开工前 |

---

## 交接 checklist

- [ ] 确认工作区开的是 `C:/Users/MSI/WorkBuddy/2026-10-11-06-15-07/`（= 仓库根）
- [ ] 确认 `CODEBUDDY.md` 内容已注入（没注入就手动读一遍）
- [ ] 跑一次 `<python> scripts/review/run_all.py --fast` → 应为 22 PASS / 0 FAIL
- [ ] 读 DESIGN §2 §4 §6 + PLAN §4 → 复述一遍 P2 出口判据
- [ ] **拍板 D8（建议走甲）**，再开分支动工
