# 实验：D13 —— 「一次设置变更回调 4 次」的真因

- **分支**：`fix/d13-settings-loop`
- **日期**：2026-10-11
- **状态**：✅ 完成（已合并 `main`）
- **结论一句话**：**旧归因（路由注册多份）是错的**；真身是 `writeSettings` 的
  "只看传没传、不看内容变没变" 配合前端每轮重渲染的无条件落盘 ⇒ **设置活锁**。

## 1. 为什么要立这个实验

代码里从 2.0.0 起就挂着一个注释（`lib/index.js` 的 `apply()`）：

> ⚠️ **幂等守卫**。实测：宿主对**一次**设置变更会回调我们 **4 次**
> （插件路由被注册了多份，于是 POST 落到多个 handler 上）。

幂等守卫只是**把症状盖住**（语言注入不会被反复注册/撤销），但"为什么会 4 次"没人查过。
用户 2026-10-11 点名**要查**。⚠️ 规则 E3 要求实验必须有台账 —— 补上。

## 2. 假设与验证（E2：一次只证一个变量）

| # | 假设 | 取证 | 结论 |
|---|---|---|---|
| **A1** | 插件路由被注册了多份 | **静态**：读 DSH 的 `app.asar`（`p0/asar.js grep`）⇒ `dsh-host-webserver` 的 `register()` 对同 path **直接抛错**（`webserver: duplicate exact route`），README 亦写"同一张表内的重复路径会抛错"，匹配是"精确 → 最长前缀 → 回退"的**单一命中**。且我们的接法与 DSH **内置插件逐字相同** | ❌ **否** |
| **A2** | 一次 POST 会落到多个 handler | **动态**：真机 `curl` 一次 POST ⇒ `onSettingsWritten` 回调**各 1 次**、`rev` 只 **+1**、全程无 duplicated warn | ❌ **否** |
| **A3** | 前端存在"内容没变也落盘"的路径 | 代码：`saveOutfit()` **无条件** `persistShared({outfit})`，而它挂在"应用共享设置"的回调链上 ⇒ 每轮重渲染都可能跑一次 | ✅ **是** |
| **A4** | 落盘会推进 `rev`，从而引发跨窗口活锁 | 代码：`writeSettings` 的 `touched` 只看"这一项**传了没传**"，`typeof {} === 'object'` 就算 touched ⇒ 同样的内容也推进 `rev` | ✅ **是** |

## 3. 真机实测（A3 + A4 的现场）

起 DSH `web profile` → 一次 POST 把 `speech.intervalMs` 设成 15000 → 用 CDP 打开页面**放着不动**。

```
[think-voice-pet] 朗读间隔 → 15000ms（已生效）
[think-voice-pet] 朗读间隔 → 15000ms（与现值相同，未变）
…（同一行刷了 79 遍）
```

| 时刻 | `rev` | 存档内容 | 文件 mtime |
|---|---|---|---|
| POST 那一刻 | 1008 | `speech:{language:zh, intervalMs:15000}` | — |
| 约 5 分钟后 | **1084** | **一个字没变** | 每 3~4 秒变一次 |

⇒ 内容不变、`rev` 涨 76、**磁盘持续被写**。这违反 **R1**（一个"什么都不做"的插件不该持续写盘）。

## 4. 修复

`lib/settings.js`：`touched` 判定里加**内容比较**（`sameJson` —— 整份 JSON 比，不用浅比较；
浅比较会把"嵌套里改了一个字段"判成没变，那是**丢数据**，比回环更糟）。

⛔ **没有**改 `lib/client.js` 的 `saveOutfit`：那是"无条件的最后一次落盘"，本身无害；
把判重放在**写入口**上，任何调用点都受保护（和"两条通道去重靠内容哈希"同一个思路）。

## 5. 验证

| 项 | 结果 |
|---|---|
| 真机（同场景 90 秒） | `revBefore=1084` → `revAfter=1084`（**一次都没写**）；对照组会产生约 25 次写入 |
| 单测 | 新建 `lib/settings.test.js` **+7**，核心那条叫「D13 回归」 |
| 完整验收 | **40 PASS / 0 FAIL / 0 SKIP**（含资源闸 R-A~R-E） |

## 6. 复现（可重跑）

```bash
# ① 静态取证：DSH 的 webServer 对重复注册的态度
<node> p0/asar.js grep "<DSH>/resources/app.asar" "dsh/node_modules/@deepseek-ai/dsh-host-webserver" "duplicate"

# ② 真机：起服务 → 一次 POST → 打开页面放着，观察 rev 与日志
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' ELECTRON_RUN_AS_NODE=1 "<DSH>/DeepSeek Harness.exe" \
  --expose-internals "<DSH>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  --patch .workbuddy/tmp/overlay-ourhost.yml --profile web --port 8128 --no-open
curl -s --noproxy '*' -X POST http://127.0.0.1:8128/api/think-voice-pet/settings \
  -H 'content-type: application/json' -d '{"speech":{"intervalMs":15000}}'
cat ~/.dsh/pet-settings.json      # 隔几分钟再看 rev

# ③ 单测
<node> --test lib/settings.test.js
```

⚠️ 完整原始输出（含修复前的刷屏日志）另存 `p0/out/verify-2026-10-11.md`（**不入库**）。

## 7. 结论

- **改**：`lib/settings.js`（`sameJson` + `touched` 判定）；**新增** `lib/settings.test.js`
- **删**：无
- **留下的教训**：这条"路由注册多份"的说法在文档里挂了很久 —— **推翻它靠的是读 `app.asar`
  + 真机数次数，不是靠推断**。查"两边对不上"的失配，**先取证再下结论**。
- **顺带**：`lib/index.js` 里那段"回调 4 次"的注释**已订正**（见 HANDOFF §7.10.3）。
