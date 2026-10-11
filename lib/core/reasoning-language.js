/**
 * `lib/core/reasoning-language.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：把「思考语种」这一条链上的三件事收在一处 ——
 *
 * ```
 *   ① 用户选了什么语言      →  LANGUAGE_OPTIONS / normalizePolicy()
 *   ② 该往系统提示注入哪句话  →  injectionText()   （D10 的落地，机制见 DESIGN §9.3）
 *   ③ 这段文本用哪个音色念    →  resolveVoice()    （P3 的「TTS 自动对应语种」）
 * ```
 *
 * ⛔ 纯逻辑：不 import Node I/O、DSH API、网络库、pixi。
 *    注入的**接线**（`ctx.inject(['systemPrompt'], …)`）在入口层 `lib/index.js`；
 *    合成的**执行**在 `lib/infra/tts/`。本模块只出「决策」，不出「动作」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 本模块最重要的取舍：音色按【实际检测】定，不按【用户配置】定
 * ══════════════════════════════════════════════════════════════════════
 *
 * 直觉做法是「用户选了中文 ⇒ 就用中文音色」，但它会坏在三个真实场景上：
 *
 *   1. **注入不是 100% 生效**。实测同一句约束带来的思考中文占比是 0.58 ~ 1.00
 *      （`p0/inject-probe/` 三组对照）。模型偶尔漂回英文时，
 *      `zh-CN-XiaoyiNeural` 念英文**明显走音** —— 而这正是 D10 的起因。
 *   2. **片段可能是混合语种**。思考里夹英文术语 / 标识符是常态
 *      （212 条真实思考实测：ASCII 占 67.3%，中文只有 5.2%）。
 *      单语种音色覆盖不了，必须能退到多语言音色。
 *   3. **配置语言与片段语言本来就是两件事**。配置决定「让模型怎么想」，
 *      检测决定「这条实际是什么」。把后者绑死在前者上，等于让一个**概率性结果**
 *      去驱动一个**确定性决策**。
 *
 * ⇒ 所以 `resolveVoice` 的口径是：**检测说了算，配置只做兜底**。
 *   用户选了中文、模型却偷懒写英文时，宠物照样念得对。
 *
 * ⚠️ 与 `lib/core/interest-scorer.js#detectScript()` 的分工（**刻意不合并**）：
 *
 * | | `detectScript()`（打分器） | `detectLang()`（本模块） |
 * |---|---|---|
 * | 服务对象 | 打分报告 / 调试 | 选 TTS 音色 |
 * | 取值 | `zh` `en` `mixed` **`code`** `empty` | `zh` `en` `mixed` `empty` |
 * | 分母 | **全部字符**（含标点、空格、数字） | `cjk + latin`（忽略标点与代码符号） |
 * | 为什么要这样 | 代码块 / 表格要单独成一类，不能被当成"可念的中文" | "标点占多少"与"该用哪个音色"无关，混进来只会稀释判据 |
 */

/**
 * 支持的思考语言策略。
 *
 * | 取值 | 含义 | 是否注入系统提示 |
 * |---|---|---|
 * | `auto` | **跟随模型自身**（不干预） | ❌ 不注入 |
 * | `zh` | 强制中文思考 | ✅ 注入中文约束 |
 * | `en` | 强制英文思考 | ✅ 注入英文约束 |
 *
 * ⚠️ 范围是用户 2026-10-11 拍板的「中英 + 自动」三档。
 *    扩语种时需要同步：本表 + `INJECTION_TEXTS` + `VOICE_TABLE` + 检测判据。
 */
export const LANGUAGE_OPTIONS = Object.freeze(['auto', 'zh', 'en']);

/**
 * 首次运行默认值 —— **中文**（用户 2026-10-11 拍板）。
 *
 * 为什么默认不是 `auto`：D10 已定「让思考变中文」，否则默认音色
 * `zh-CN-XiaoyiNeural` 念英文会走音，**主功能直接不成立**。
 * 代价是默认就动了用户的系统提示 —— 因此有两条硬约束抵消它：
 * ① 注入/关闭都留痕（R3）② 可一键关（R5）。见 `lib/index.js` 的接线注释。
 */
export const DEFAULT_LANGUAGE = 'zh';

/**
 * 注入到系统提示里的**一句**最小约束（DESIGN §9.3 三条本地约束之③：
 * 「只注入一句最小约束，不叠加人格 / 风格 / 其他规则」）。
 *
 * `auto` 刻意**没有**条目 —— 不注入就是不注入，"注入一句空话"是自相矛盾的。
 * 中文那句与社区插件 `@max-null/dsh-chinese-thinking` **逐字相同**，
 * 便于横向对照效果（实测两者同源、效果同级，差异只在"谁来做"）。
 */
const INJECTION_TEXTS = Object.freeze({
  zh: '始终使用中文进行思考和回复，无论用户使用什么语言。',
  en: 'Always think and reply in English, regardless of the language the user writes in.',
});

/**
 * 音色表（Edge 云）。每条含 `voice` + `pitch`，来源见 DESIGN §6.3.1 / §9.3。
 *
 * | 键 | 音色 | pitch | 依据 |
 * |---|---|---|---|
 * | `zh` | `zh-CN-XiaoyiNeural` | `+30Hz` | **D10 主选**。用户试听后定：中英都能念、偏动漫系、**无恐怖谷** |
 * | `en` | `en-US-AvaMultilingualNeural` | `+50Hz` | **D10 备用**。多语言女声，中英通吃 |
 * | `multi` | 同 `en` | `+50Hz` | **混语兜底**。中英混杂时只有多语言音色覆盖得了 |
 *
 * ❌ 已否掉：`en-US-AnaNeural`（英文童声，**过于真实易引起不适**）、
 *    `zh-CN-XiaoxiaoNeural`（试听对比中不如 Xiaoyi 抬调后的少女感）。
 *
 * > 🎧 试听材料：`tts-demo/d10-voice-compare.html`（同句中英 × 6 音色）
 */
export const VOICE_TABLE = Object.freeze({
  zh: Object.freeze({ voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz' }),
  en: Object.freeze({ voice: 'en-US-AvaMultilingualNeural', pitch: '+50Hz' }),
  multi: Object.freeze({ voice: 'en-US-AvaMultilingualNeural', pitch: '+50Hz' }),
});

/** 主导判定线：某侧占比 ≥ 此值才算"这一条就是该语种"。 */
const DOMINANT_RATIO = 0.7;

const CJK = /[\u4e00-\u9fff]/g;
const LATIN = /[A-Za-z]/g;
const countMatches = (text, re) => (text.match(re) ?? []).length;

/**
 * 归一化入参：契约写的是 `text: string`，但流水线里的片段是 `{text}` 对象。
 * 容忍两种形态，省得每个调用点都写 `.text`。
 * （与 `interest-scorer.js` 的同名私有函数一致；刻意不跨模块导出，避免把
 * 小工具变成公开契约 —— 它随时可能改。）
 */
function asText(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }
  return '';
}

/**
 * 校验并归一化语言策略。未知值一律落到 `DEFAULT_LANGUAGE`，
 * **不抛异常** —— 设置文件是用户能手改的，改坏了不该让桌宠起不来。
 */
export function normalizePolicy(value) {
  return LANGUAGE_OPTIONS.includes(value) ? value : DEFAULT_LANGUAGE;
}

/**
 * 该策略要不要注入系统提示，以及注入什么。
 *
 * @returns {string|null} 注入文本；`null` = **不注入**（含 `auto` 与未知值）
 */
export function injectionText(policy) {
  const key = LANGUAGE_OPTIONS.includes(policy) ? policy : 'auto';
  return INJECTION_TEXTS[key] ?? null;
}

/**
 * 判定一段文本的主导书写系统。
 *
 * 分母用 `cjk + latin`，**不含**标点 / 空格 / 数字 / 代码符号 ——
 * 因为标点密度与"该用哪个音色"无关，混进来只会稀释判据。
 * （口径与 `p0/reasoning-language.py` 的 `ratio()` 一致，两者结论可直接对照。）
 *
 * @returns {'zh'|'en'|'mixed'|'empty'}
 *   - `empty` —— 没有任何字母/汉字（纯数字、纯符号、纯代码）
 *   - `mixed` —— 两侧都有且都没到 `DOMINANT_RATIO`
 */
export function detectLang(text) {
  const value = asText(text);
  const cjk = countMatches(value, CJK);
  const latin = countMatches(value, LATIN);
  const total = cjk + latin;
  if (total === 0) return 'empty';
  const zhRatio = cjk / total;
  if (zhRatio >= DOMINANT_RATIO) return 'zh';
  if (1 - zhRatio >= DOMINANT_RATIO) return 'en';
  return 'mixed';
}

/**
 * 给一段**实际要念的文本**解析出音色 —— P3「TTS 自动对应语种」的实现。
 *
 * 决策顺序（**检测优先，配置兜底**，理由见文件头）：
 *
 * ```
 *   ① 能判出 zh / en  → 直接采信检测结果（哪怕与配置不符 ⇒ 记 config-mismatch）
 *   ② 判出 mixed      → 多语言音色（中英混杂只有它覆盖得了）
 *   ③ 判出 empty      → 用配置语言；配置是 auto 就用多语言音色
 * ```
 *
 * `reason` 会进日志（R3 留痕），所以**取值要能自解释**：
 * 看到 `detected-config-mismatch` 就知道"注入漂了"，而不是"代码坏了"。
 *
 * @param {string|{text:string}} text 待朗读的实际文本（**不是**思考全文）
 * @param {string} policy 用户选的思考语言（`auto` / `zh` / `en`）
 * @returns {{voice:string, pitch:string, lang:string, reason:string}}
 */
export function resolveVoice(text, policy = DEFAULT_LANGUAGE) {
  const chosen = normalizePolicy(policy);
  const configured = chosen === 'auto' ? null : chosen;
  const lang = detectLang(text);

  // ① 检测可用 —— 它是权威，配置只影响 reason（用于诊断注入有没有漂）
  if (lang === 'zh' || lang === 'en') {
    return {
      ...VOICE_TABLE[lang],
      lang,
      reason: configured === null
        ? 'detected-auto'
        : (configured === lang ? 'detected-config-match' : 'detected-config-mismatch'),
    };
  }

  // ② 中英混杂 —— 单语种音色念另一种会走音，必须退到多语言音色
  if (lang === 'mixed') {
    return { ...VOICE_TABLE.multi, lang, reason: 'mixed-multilingual' };
  }

  // ③ 判不出（纯符号 / 纯数字 / 纯代码）—— 用配置兜底
  if (configured !== null) {
    return { ...VOICE_TABLE[configured], lang, reason: 'fallback-config' };
  }
  return { ...VOICE_TABLE.multi, lang, reason: 'fallback-multilingual' };
}
