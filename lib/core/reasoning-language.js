/**
 * `lib/core/reasoning-language.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：把「思考语种」这一条链上的三件事收在一处 ——
 *
 * ```
 *   ① 用户选了什么语言      →  LANGUAGE_OPTIONS / normalizePolicy()
 *   ② 该往系统提示注入哪句话  →  injectionText()   （D10 的落地，机制见 DESIGN §9.3）
 *   ③ 这段用哪个音色念       →  createVoiceResolver()（P3 的「TTS 对应语种」）
 * ```
 *
 * ⛔ 纯逻辑：不 import Node I/O、DSH API、网络库、pixi。
 *    注入的**接线**（`ctx.inject(['systemPrompt'], …)`）在入口层 `lib/index.js`；
 *    合成的**执行**在 `lib/infra/tts/`。本模块只出「决策」，不出「动作」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 音色决策：由**用户选的策略**决定，且**会话内恒定 —— 绝不逐句切换**
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 这一条推翻过一版实现（原版是"按实际检测语种逐句选音色"）。
 *    用户 2026-10-11 的修正原话：
 *
 *   > 不要中途换音色；就是 xiaoyi 的音色中英文下都是可以的；我们可以这样来理解，
 *   > 中文输出的用户就用 xiaoyi 的音色，英文输出的用户就用 ava 的音色；其他的自动；
 *   > 总之不要出现同一个输出语言场景下，音色会变为另外一套音色的情况。
 *
 * **原版为什么错**：逐句检测会让宠物在**同一场对话里**一会儿 Xiaoyi、一会儿 Ava。
 * 用户听到的不是"同一只宠物在说话"，而是"换了一个人"。**人格一致性**比
 * "每个音色都用在它最擅长的语种上"更重要 —— 后者是工程最优，不是体验最优。
 *
 * 而且实测也支持这个简化：**Xiaoyi 念英文是可接受的**（用户试听确认过），
 * 所以"中文策略下偶尔漂出一句英文"根本不需要换音色去救。
 *
 * ⇒ 现行规则（`createVoiceResolver`）：
 *
 * | 策略 | 音色 | 看不看文本 |
 * |---|---|---|
 * | `zh` | `zh-CN-XiaoyiNeural` +30Hz | ❌ 完全不看 —— 中英混合也用它 |
 * | `en` | `en-US-AvaMultilingualNeural` +50Hz | ❌ 完全不看 |
 * | `auto` | 按**首次**判出的语种锁定，之后不再变 | ✅ 只看第一次 |
 *
 * `detectLang()` 仍然保留：它**不再决定音色**（`auto` 之外），但**进日志** ——
 * 像"配的是中文、这一句实际是英文"这种信号，是判断「注入漂没漂」的唯一线索（R3 留痕）。
 *
 * ⚠️ 与 `lib/core/interest-scorer.js#detectScript()` 的分工（**刻意不合并**）：
 *
 * | | `detectScript()`（打分器） | `detectLang()`（本模块） |
 * |---|---|---|
 * | 服务对象 | 打分报告 / 调试 | 语种日志 + `auto` 的首次判定 |
 * | 取值 | `zh` `en` `mixed` **`code`** `empty` | `zh` `en` `mixed` `empty` |
 * | 分母 | **全部字符**（含标点、空格、数字） | `cjk + latin`（忽略标点与代码符号） |
 * | 为什么 | 代码块 / 表格要单独成一类，不能被当成"可念的中文" | "标点占多少"与语种判定无关，混进来只会稀释判据 |
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
 * | `zh` | `zh-CN-XiaoyiNeural` | `+30Hz` | **D10 主选**。用户试听后定：**中英都能念**、偏动漫系、无恐怖谷 |
 * | `en` | `en-US-AvaMultilingualNeural` | `+50Hz` | **D10 备用**。多语言女声，中英通吃 |
 *
 * ⚠️ 表里**不再有 `multi` 键** —— 它原来用于"中英混杂时兜底"，但那正是"逐句换音色"的
 *    入口。现在混杂片段跟着**策略**走（中文用户就继续用 Xiaoyi，实测可接受）。
 *
 * ❌ 已否掉：`en-US-AnaNeural`（英文童声，**过于真实易引起不适**）、
 *    `zh-CN-XiaoxiaoNeural`（试听对比中不如 Xiaoyi 抬调后的少女感）。
 *
 * > 🎧 试听材料：`tts-demo/d10-voice-compare.html`（同句中英 × 6 音色）
 */
export const VOICE_TABLE = Object.freeze({
  zh: Object.freeze({ voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz' }),
  en: Object.freeze({ voice: 'en-US-AvaMultilingualNeural', pitch: '+50Hz' }),
});

/** 主导判定线：某侧占比 ≥ 此值才算"这一条就是该语种"。 */
const DOMINANT_RATIO = 0.7;

const CJK = /[\u4e00-\u9fff]/g;
const LATIN = /[A-Za-z]/g;
const countMatches = (text, re) => (text.match(re) ?? []).length;

/**
 * 归一化入参：契约写的是 `text: string`，但流水线里的片段是 `{text}` 对象。
 * 容忍两种形态，省得每个调用点都写 `.text`。
 *（与 `interest-scorer.js` 的同名私有函数一致；刻意不跨模块导出，
 * 免得这个小工具变成公开契约 —— 它随时可能改。）
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
 * 因为标点密度与语种判定无关，混进来只会稀释判据。
 * （口径与 `p0/reasoning-language.py` 的 `ratio()` 一致，两者结论可直接对照。）
 *
 * ⚠️ 它**不再决定音色**（`auto` 策略之外），只用于日志与 `auto` 的首次判定。
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

/** `auto` 下只有明确判为中文才用中文音色；混合 / 判不出 / 英文一律走多语言音色。 */
const autoKeyFor = (lang) => (lang === 'zh' ? 'zh' : 'en');

/**
 * **无状态**音色解析：给一个策略与一段文本，返回这一刻该用哪个音色。
 *
 * | 策略 | 结果 |
 * |---|---|
 * | `zh` / `en` | 固定音色，**完全不看文本** |
 * | `auto` | 按这次文本判定（**不粘滞** —— 要跨句恒定请用 `createVoiceResolver`） |
 *
 * `lang` 字段仍回实际检测结果，供调用方**打日志**（不是用来切音色的）。
 *
 * @param {string|{text:string}} text 待朗读的实际文本
 * @param {string} policy 用户选的思考语言
 * @returns {{voice:string, pitch:string, lang:string, reason:string}}
 */
export function resolveVoice(text, policy = DEFAULT_LANGUAGE) {
  const chosen = normalizePolicy(policy);
  const lang = detectLang(text);
  if (chosen === 'zh' || chosen === 'en') {
    return { ...VOICE_TABLE[chosen], lang, reason: 'policy-' + chosen };
  }
  const key = autoKeyFor(lang);
  return { ...VOICE_TABLE[key], lang, reason: 'auto-' + key };
}

/**
 * **有状态**音色解析器 —— 宿主应该用它，而不是每句调 `resolveVoice`。
 *
 * 它唯一多做的事就是"**记住**"：`auto` 策略下按**第一次**判出的语种锁定，
 * 之后整场不再变。这就是用户要求的"不要中途换音色"。
 *
 * `zh` / `en` 下连记都不用记 —— 它们压根不看文本。
 *
 * ```js
 * const voices = createVoiceResolver('zh');
 * voices.resolve('先看日志');            // → Xiaoyi（policy-zh）
 * voices.resolve('Wait, that is wrong'); // → 仍是 Xiaoyi ← 关键：不切 Ava
 * voices.setPolicy('en');                // 用户改了设置 → 立刻跟随（R5）
 * voices.resolve('…');                   // → Ava
 * ```
 *
 * @param {string} [policy]
 */
export function createVoiceResolver(policy = DEFAULT_LANGUAGE) {
  let current = normalizePolicy(policy);
  /** `auto` 下锁定下来的音色键；`null` = 还没定过 */
  let lockedAuto = null;

  return {
    /** 当前策略 */
    policy: () => current,

    /**
     * 切换策略。音色**立刻**跟随用户选择（R5「可一键关」的同一条链路）。
     *
     * ⚠️ 切到 `auto` 时要把锁定状态清掉 —— 否则用户从 `zh` 改成 `auto`，
     *    宠物会继续用上一个策略锁的音色，"改了设置没反应"。
     *
     * @returns {boolean} 策略是否真的变了（没变就不用做任何事）
     */
    setPolicy(next) {
      const normalized = normalizePolicy(next);
      if (normalized === current) return false;
      current = normalized;
      lockedAuto = null;
      return true;
    },

    /**
     * 解析音色。
     * @param {string|{text:string}} text
     * @returns {{voice:string, pitch:string, lang:string, reason:string}}
     */
    resolve(text) {
      const lang = detectLang(text);

      // zh / en：完全不看文本 —— 哪怕这一句是另一种语言也不换音色
      if (current === 'zh' || current === 'en') {
        return { ...VOICE_TABLE[current], lang, reason: 'policy-' + current };
      }

      // auto：只看第一次，之后粘滞
      if (lockedAuto === null) {
        lockedAuto = autoKeyFor(lang);
        return { ...VOICE_TABLE[lockedAuto], lang, reason: 'auto-locked-' + lockedAuto };
      }
      return { ...VOICE_TABLE[lockedAuto], lang, reason: 'auto-sticky-' + lockedAuto };
    },

    /** 诊断快照（日志用） */
    state: () => ({ policy: current, locked: lockedAuto }),
  };
}
