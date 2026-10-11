# dsh-pet-think-voice

给 [DSH（DeepSeek Harness）](https://www.deepseek.com/) 挂一只 Live2D 桌宠，**把模型的思考念出来**。

她不是聊天机器人 —— 她不回答你。她做的是：从模型**正在想**的内容里挑出"有戏"的片段，
用语音念给你听，并在念的时候换个表情。你继续干活，她在旁边把"模型刚才在想什么"念出来。

> 本项目基于 [`A8Chann/dsh-pet-live2d`](https://github.com/A8Chann/dsh-pet-live2d) **二次开发**
> （v3.3.1 快照、`33af354` 逐字复制为改造基线，无 git 历史继承），并改名
> `dsh-pet-think-voice`。上游提供"Live2D 桌宠在 DSH 页面里"的完整底座；本项目在此之上
> 重做了内容层（思考采集 → 筛选 → 拟人化 → 朗读 → 表情）。

## 它做什么

| 环节 | 说明 |
|---|---|
| 采集 | 只订阅模型的 **reasoning（思考）** 文本流 —— 不读正文、不读工具产出 |
| 筛选 | 切分片段 → 规则打分 → 过阈才入选；带噪声特征（代码块、表格、Markdown 标题、路径、残留半句…）的直接滤掉 |
| 拟人化 | 清洗 + 裁齐，**只挑只裁、绝不改字**（不插语气词、不补标点、不同义替换） |
| 朗读 | Edge TTS 合成音频；节奏可调（两条之间至少隔 10~120 秒，默认 20 秒） |
| 表演 | 20 个表情随朗读内容切换（朗读期间临时盖在"相位表情"上，念完自动回去） |
| 相位 | 8 种会话状态自动换装：正在思考 / 用工具 / 等你批准 / 等你回答 / 叫了帮手 / 消息排队 / 完成 / 出错 |
| 互动 | 摸头、摸尾巴、绕着她转圈都有反应；可拖动、可换装扮、右键出控制面板 |

## 安装

**前提**：DSH `>= 0.1.5-rc.1`（见 `package.json` 的 `dsh.engines`）。

### 1. 装插件

在 DSH 里打开**侧栏 → 插件 → 添加插件**，在「包名或地址」里填包名、GitHub 地址，
或者**本机仓库路径**。

**填本地路径时必须带 `file:` 前缀**，不带前缀装不上：

```
Windows        file:C:\Users\<你>\WorkBuddy\2026-10-11-06-15-07
macOS / Linux  file:/Users/<你>/path/to/dsh-pet-think-voice
```

> 为什么：不带前缀的裸路径会被 pnpm 当成 `link:` 依赖，而 pnpm **不会**为 `link:`
> 在 profile 的 `node_modules/` 里建条目 —— DSH 随后解析不到这个 bundle，安装以
> `cannot resolve profile bundle "…"` 告终。本项目实测：**裸路径失败、`file:` 成功**。

填好后点「安装」，DSH 会读出它指向什么（显示包名 / 描述 / 版本），装完在同一个对话框里点
「**立即启用**」—— 这一步才会把插件写进 profile 的 `dsh.profile.bundles`（**少了它插件不会加载**）。
然后**重启 DSH**，设置页与插件页就能看到她了。

装上的是**一份快照**（`file:` 依赖会被拷进 profile 的 `node_modules`）：改了仓库代码要
重新装一次才生效。开发时更省事的做法是用 `--patch` 叠加层（见下方「开发」）。

若习惯命令行，等价的一条（装完会自动登记 bundle）：

```bash
dsh plugin --profile <profile 名> add "file:<仓库绝对路径>"
```

（`dsh plugin` 是 pnpm 的转发；`<profile 名>` 一般是 `desktop`。）

### 2. Cubism Core（Live2D 运行时）

Live2D 官方的 `live2dcubismcore.min.js` 是**专有软件，本仓库不包含、也不代为分发**
（见 [`NOTICE.md`](NOTICE.md) 第 3 节）。插件会这样拿到它：

1. **本地优先**：`<DSH_HOME>/pets/.runtime/live2dcubismcore.min.js` 已经存在就直接用
2. **否则从官方 CDN 取一次并缓存**到同一位置（`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`）
3. 之后**离线可用**

如果网络不通（或你不想让它自动下载），**手动放一份**即可 —— 从
[Live2D Cubism SDK for Web](https://www.live2d.com/download/cubism-sdk/download-web/) 取得
`live2dcubismcore.min.js`，放到：

```
Windows   %DSH_HOME%\pets\.runtime\live2dcubismcore.min.js
macOS/Linux   $DSH_HOME/pets/.runtime/live2dcubismcore.min.js
```

（`DSH_HOME` 默认是 `~/.dsh`。）放好刷新页面即可，不需要重启。

取不到时**不会白屏**：页面里会给一条明确提示（含它找过的路径），宿主日志里也有对应记录。

### 3. 没有桌面壳了

上游还带一条"把宠物贴在 Windows 桌面上"的原生窗口路径。**本项目已移除它**（依赖上游二进制、
无源码可自建也改不了名）—— 宠物只活在 DSH 页面里。

## 使用

- **右键宠物**打开控制面板：换动作、换装扮、调大小、归位
- **设置 → 桌宠**（或**侧栏 → 插件 → think-voice-pet**）里改数值：注视范围、摸鱼节奏、音量、
  思考语言、朗读间隔、装扮、互动台词、气泡样式
- 想立刻听她开口：问模型一个**需要想一会儿**的问题。模型思考期间她会显示"让我想想…"，
  念出来的那一刻会换表情
- 模型思考可能超过一分钟，这段等待是正常的

## 隐私

- **只读思考，不读正文**：插件只消费 reasoning 文本流，不消费正文、不读工具产出内容、
  不读你的文件。（会用工具**调用名**判断相位，但那些内容不会被朗读。）
- **不发送思考文本到任何第三方**。唯一会把你的内容发出去的环节是语音合成：Edge TTS
  （微软的非官方接口）把**待朗读的那一句话**换成音频。除此之外没有任何上行。
  （另有一个不传数据的下载：首次启动时从 Live2D 官方 CDN 取 Cubism Core，见上一节。）
- 设置与存档都在本机：`<DSH_HOME>/pet-settings.json`（共享设置）、浏览器 `localStorage`（窗口状态）。
- **可一键停**：设置里的总开关随时关掉气泡 / 朗读 / 提示音，或整个禁用插件，不必卸载。

## 资源占用

- **不做本地推理**：没有 Ollama、没有本地模型权重、不需要 Python 环境
- 语音合成在云端完成，**不占显存**
- Live2D 渲染走 WebGL，实测显存增量在测量噪声范围内；CPU 增量约 0.1 核
- 唯一需要网络的是语音合成；不可用时降级为**只显示气泡文字**（并在日志里留痕）

> 尚未在 8GB / 16GB 显存的低配机器上实测，因此**不作出"低配流畅"的承诺**。

## 许可与署名

| 内容 | 许可 |
|---|---|
| 代码（本仓库自有部分） | **MIT** —— 沿用上游，保留 A8Chann 的版权声明 |
| 鲸鱼娘模型 / 贴图 / 表情 / 动作 | **CC BY-NC-SA 4.0** —— 署名 + **禁商用** + 相同方式共享 |
| Live2D Cubism Core | Live2D Inc. 专有，**不随包分发**，用户自行取得 |
| pixi.js / untitled-pixi-live2d-engine | MIT（已打包进 `lib/live2d-vendor.js`） |
| Edge TTS | 微软**非官方**接口，免费但不承诺稳定性；依赖网络 |

美术资源署名：**上善无形**（角色原作「溟月」）· **ZipZipPipe**（女仆鲸鱼娘二次设计）·
**氵六青**（Live2D 绑定/动作/表情）。

完整条款见根目录 [`LICENSE`](LICENSE) 与 [`NOTICE.md`](NOTICE.md)（均为上游原文）。
**若要商业使用，必须先替换该模型**，或分别取得三位作者授权。

## 已知限制

- **"念得出来" ≠ "念得好听"**：选材仍有已知的粗糙处 —— 部分片段是"模型在规划自己怎么回答"
  的流程性内容（"我认为不需要工具调用"这类），语法完整但不算有戏。这是当前最明确的改进方向。
- 语音合成依赖微软公开接口，可能随对方调整而失效；失效时自动退化为只显示气泡。
- 一个模型回合内只念有限条（队列上限 3），且两条之间至少隔一个朗读间隔。

## 开发

```bash
npm run build:vendor     # 重建 lib/live2d-vendor.js（pixi + live2d engine）
```

纯逻辑模块（`lib/core/`）有单测，可脱离 DSH 直接跑：

```bash
node --test lib/core/*.test.js lib/app/*.test.js lib/*.test.js
```

**改代码后不必重装**：用 `--patch` 叠加层直接指向本仓的 `lib/index.js` 起服务，
改完刷新页面即可。叠加层就是一个 yml：

```yaml
- insert:
    - id: think-voice-pet
      name: 'file:///绝对路径/lib/index.js'
```

```bash
dsh --patch <叠加层.yml> --profile web --port 8130
```

⚠️ 用 `web` profile 验（插件同时有宿主半区与浏览器半区）；Windows 上从 Git Bash 起
要加 `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`，并且 `--patch` 用**相对路径**。

架构与决策记录见 `docs/`：`DESIGN.md`（设计）· `PLAN.md`（计划）· `HANDOFF.md`（交接，换会话先读它）。
