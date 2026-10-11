# 注入探针 · 让模型用中文思考

> 一次性研究的固化产物。回答的问题是：**D10 选的"让思考变中文"，我们能不能自己做进插件里，
> 而不必让用户另外去装一个社区插件？** 答案是**能**，本目录是已验证的最小实现 + 完整实验记录。

## 为什么需要它

P2 实测（212 条真实思考）：**模型的思考正文默认是英文** ——

| 口径 | 英文主导 | 中文主导 |
|---|---|---|
| 按整条思考判定 | **76%** | 7% |
| 字符占比 | ASCII 67.3% | 中文 **5.2%** |

而 D10 定的朗读音色 `zh-CN-XiaoyiNeural` 是中文音色 → **念英文会明显走音**。
所以"让思考变中文"不是锦上添花，是让主功能成立的前置。

## 怎么用

```bash
# 1) 起一个带探针的 headless 会话（--patch 必须放在 --profile 之前）
DSH="C:/Users/MSI/AppData/Local/Programs/DeepSeek Harness"
CLI="$DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 "$DSH/DeepSeek Harness.exe" --expose-internals "$CLI" \
  --patch "$PWD/p0/inject-probe/overlay.yml" --profile headless "用一句话说明：为什么并发写入同一个文件会出错？"

# 2) 量效果（思考语种，不是回复语种）
<py> p0/reasoning-language.py 1
```

**判据**：思考的中文占比。基线 0.05~0.09；装了注入应 ≥0.5。

> ⚠️ 别拿"回复是不是中文"当判据 —— 用户用中文问时，回复本来就是中文。
> 实测见过 **思考 0.07 / 回复 0.60** 的组合，只看回复会误判"没问题"。

## 机制（读第一方源码得出，非猜测）

```js
ctx.systemPrompt.section({ name, order, text })
```

- 第一方自己就在用：`dsh-app-boot` 的 `addHarnessSourceSection()`
- 官方插件开发指南 `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` 明确推荐
- `order: -90` 落在 `harness:identity(-1000)` 之后、`deployment:persona-prefix(0)` 之前
  —— 即"模型读到的最早一条行为指令"，与社区插件取同一位置

## ⚠️ 三个坑（都是实测踩出来的）

### 坑 1：插件 `package.json` 缺 DSH 元数据 → 报 `REQUEST_EXTENSION`

**症状极具误导性**：报的是 `dsh: REQUEST_EXTENSION: DeepSeek request extension preparation failed`
—— 看起来像 LLM provider 的问题，实际是**插件包元数据不全**。

实验矩阵（唯一变量 = `package.json`，代码始终是我写的那份）：

| # | 代码 | `package.json` | 结果 |
|---|---|---|---|
| V1 | 社区插件原文 | 极简 `{name, private, type, main}` | ❌ `REQUEST_EXTENSION` |
| V2 | **我的代码** | 社区插件完整包 | ✅ 成功 |
| V3 | **我的代码** | 我们的 `dsh` 形态 + `peerDependencies` | ✅ 成功 |
| — | 社区插件原文 | 社区插件完整包（原位置） | ✅ 成功 |

⇒ **与代码无关，缺的是 `package.json` 里的 DSH 元数据。**
关键是 `dsh` 字段 + `peerDependencies` 里声明 `@deepseek-ai/dsh-system-prompt`
（推测 DSH 用它校验插件是否被允许使用该服务）。

**对正式实现的影响**：我们的根 `package.json` 已有 `dsh` 字段，
只需**补 `peerDependencies`**（声明 `@deepseek-ai/dsh-system-prompt`）。

### 坑 2：section 名不得与社区插件同名

插件级 `ctx` 的 scope 是 `undefined` ⇒ 落在 `ScopedLayers.global` 层；
`NamedEntries.insert()` 对同层同名**直接 `throw duplicateError`**（`dsh-scope/lib/index.js`）。

即：若我们也叫 `chinese-thinking`，用户同时装了社区插件时**两个插件都会挂在注册这一步**。
⇒ 用自有前缀：`think-voice:reasoning-language`。

### 坑 3：别把 `systemPrompt` 放进声明式 `inject`

声明式 `inject` 是**硬等待** —— 宿主 profile 里没有该服务时，**插件整个不激活**（桌宠也不显示）。
官方指南原话：

> Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin stays
> inactive in profiles without them instead of throwing.

⇒ 用 `ctx.inject(['systemPrompt'], cb)` 软探测：服务不在时只是不注入，主体照常工作。
（第一方 `addHarnessSourceSection` 是同样思路的 `ctx.get('systemPrompt')` + 未定义即返回。）

## 实测效果

| 配置 | 思考中文占比 |
|---|---|
| 无注入（基线） | 0.02 ~ 0.08 |
| 本探针（推荐形态） | **1.00** |
| 社区插件 `@max-null/dsh-chinese-thinking` | 0.58 ~ 0.88 |

> 效果与社区插件同级（因注入文本相同）。差异只在"谁来做"——本探针证明**我们能自己做**。
