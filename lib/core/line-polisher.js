/**
 * `lib/core/line-polisher.js` — 领域层（DESIGN §4.3 的【③ 领域】）
 *
 * 职责：把一条**已过阈的片段**收拾成"能开口念的一条台词"，并给出表情标签。
 * 它在七步流水线里的位置是 **第 ④ 步「拟人化」**（DESIGN §4.2）：
 *
 *   ③ 筛选（interest-scorer）──▶ ④ **拟人化（本模块）** ──▶ ⑤ 节流（speech-planner）
 *
 * ⛔ 纯逻辑：不 import 任何 Node 内置 I/O、DSH API、网络库、pixi。
 * ⛔ 不读时钟、不读随机数 —— 同一输入必得同一输出（否则单测只能靠 sleep）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 本模块的第一条铁律：**只挑只裁，绝不改字**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用户 2026-10-11 拍定（P4-2 开工前）：改写的力度上限是"清洗 + 裁齐"，
 * **不允许插入任何模型没想过的词**（不做「嗯…」包装、不补标点、不做同义替换）。
 *
 * 理由不是懒：红线 R2 的立身之本是"**读**模型的思考"。一旦我们往句子里加词，
 * 宠物念的就不再是模型的思考，而是我们编的台词 —— 那是另一款产品
 * （而且是个更坏的产品：观众以为宠物在转述，其实在演戏）。
 *
 * ⇒ 这条铁律被一个**可执行的不变量**守着（见 `line-polisher.test.js`）：
 *     把输出与输入的**空白全部去掉**后，输出必须是输入的**子序列**。
 *   任何"插入字符"的改动都会当场把它顶红 —— 包括以后有人想加个「诶？」。
 *
 * 允许的动作只有四类，全部是**删除**：
 *   ① 去 Markdown 标记（`**粗体**` / `` `代码` `` / 列表符号 / 链接壳）
 *   ② 去不可朗读的字符（emoji、零宽字符）
 *   ③ 合并空白
 *   ④ 裁掉首尾的悬挂残句/标点（**这是 D12 的修复**，见下）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它修的两个真实缺陷
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【缺陷 1 · D12「片段边界」】真机抓到一条实际朗读的文本是
 *     `", being honest about confidence levels and what still needs "`
 *     —— 以逗号开头、短语被截断。念出来是"逗号 being honest about…"。
 *   这是**切分器**切在句子中间留下的残句，而打分器只看关键词不看完整性，
 *   所以它一路绿灯走到了 TTS。⇒ 本模块是**最后一道闸**：残句在这里被拦下。
 *
 * 【缺陷 2 · Markdown 标题】§7.7.4 已在**打分侧**硬扣 0.3 让标题过不了阈。
 *   这里做**第二道**兜底（判据相同但独立实现）—— 打分阈值将来若被人调低，
 *   标题不会因此重新漏到耳朵里。两道闸都拦同一件事，不算冗余，算防御纵深。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 表情标签：**直接用模型自己的表情 key**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用户 2026-10-11 拍定：emotion 不搞"抽象语义标签再映射"那一层，**直接用
 * `pets/ds-whale-girl/catalog.json` 里 category=emotion 的 key**
 * （脸红 / 星星眼 / 问号 / 生气 / 调皮 / 吐舌 …共 20 个）。
 *
 * 这样 P4-3 是**零映射**的直通：领域层说 `问号`，浏览器就演 `问号`。
 * 少一层映射 = 少一处"两边对不上却谁都不报错"的隐患（本项目已在这类
 * 静默失配上踩过坑：三条改名硬契约、`rev` 判旧覆盖）。
 *
 * 标签的来源是**打分器已经算出来的命中桶**（`interest-scorer` 的 `buckets`
 * 与 `matches`）—— 不重新做一遍关键词匹配。好处是"为什么念这句"与
 * "为什么演这个表情"**同源**：句子和表情天然一致，不会各说各话。
 */

/**
 * 该模型 `category=emotion` 的全部表情 key（20 个）。
 *
 * ⚠️ 这是一份**白名单**，不是"可选清单"：`polish()` 只会产出于此的标签或 `null`。
 *    换模型时（`pets/` 下换一只）必须同步这份表 —— 单测会校验它与
 *    `catalog.json` 的一致性（见 `line-polisher.test.js` 的模型一致性守卫）。
 */
export const EXPRESSION_KEYS = Object.freeze([
  '脸红', '爱心眼', '星星眼', '情绪花花', '心跳', '开心兴奋', '悲伤', '大哭', '生气', '晕晕',
  '流汗', '问号', '感叹号', '阴暗', '调皮', '闭眼口水', '吐魂', '吐舌', '呆呆眼', '冒爱心',
]);

/**
 * 命中桶 → 表情 key。权重与桶的语义见 `interest-scorer.js` 的 `TRIGGER_LEXICON`。
 *
 * ⚠️ `情绪外露` 在下面被**细分**成两种（偷懒 vs 阴阳怪气）—— 它们是完全不同的表情，
 *    而桶只有一个。细分靠 `SNARK_WORDS`，词表与打分器保持同源（改词要两边一起改）。
 */
export const BUCKET_EXPRESSION = Object.freeze({
  // 偷懒/降级 → 调皮；阴阳怪气/松散 → 吐舌（细分见 SNARK_WORDS）
  情绪外露: '调皮',
  // 认错 / 小失误 / 顺手开脱 → 流汗（"呃…不好意思"）。
  // 模型 20 个 category=emotion 的表情里，`流汗` 此前完全没用上，而这个桶正好是它的语义。
  手滑·坦白: '流汗',
  吐槽: '生气',
  顿悟: '星星眼',
  自我怀疑: '问号',
  犹豫权衡: '呆呆眼',
});

/**
 * 多桶同时命中时的**取用优先级**。
 *
 * 依据是"哪个标签更值得演"，不是桶的权重：一条同时命中「顿悟」与「自我怀疑」的
 * 思考（`wait, ... I see now`）戏剧点在**顿悟**上，就该演星星眼而不是问号。
 * 顺序：戏核 > 认错 > 受挫 > 收获 > 困惑 > 铺垫。
 *
 * ⚠️ `手滑·坦白` 排在第二位（仅次于「情绪外露」）：认错与自嘲是**最像人**的一类，
 *    也正是用户点名要的那一味（"手滑了一次编辑…这种也很不错，适合念"）。
 */
export const EMOTION_PRIORITY = Object.freeze([
  '情绪外露', '手滑·坦白', '吐槽', '顿悟', '自我怀疑', '犹豫权衡',
]);

/** 「情绪外露」桶里的阴阳怪气侧（→ 吐舌）。其余归偷懒侧（→ 调皮）。 */
const SNARK_WORDS = Object.freeze(['无所谓', '有意思', '有趣', '好吧', '绝了', '无语']);

/** 阴阳怪气侧表情（与 `BUCKET_EXPRESSION.情绪外露` 配对） */
export const SNARK_EXPRESSION = '吐舌';

/**
 * 桶内**逐词纠偏** —— 桶太粗时，用词本身修正表情。
 *
 * 证据：`p0/polish-probe.mjs` 在 37.9 万片段（过阈 30394）上的**逐词归因表**
 * （`p0/out/polish-report.md` §4.1）。归因发现「自我怀疑」桶里混着两种词：
 *
 * | 词 | 条数 | 它其实是 | 该演 |
 * |---|---|---|---|
 * | `等等` `wait` `hmm` `wrong` `reconsider` `不对` | 约 1.2 万 | **真怀疑 / 自我修正** | 问号（不变） |
 * | `其实` `实际上` | **6698**（占放行 22%） | **澄清与确证**（"实际上是这么回事"） | 感叹号 |
 *
 * 若不做纠偏，「问号」会吃掉 63% 的放行片段 —— 宠物会一脸疑惑地念
 * `实际上，用户提供的总结非常详细` 这种平铺直叙的陈述句。
 *
 * ⚠️ **英文 `actually` 不纠偏**：它在英文思考里多为"等等，其实是……"的**修正**标记，
 *    推「问号」是对的。中英在这一点上又不是一个体系 —— 与 DESIGN §5.1.1 的结论同源。
 *
 * ⚠️ 只纠**表情**，**不动打分**：词仍留在「自我怀疑」桶里参与打分，
 *    阈值与通过率（P4-1 刚校准完）**一点都没碰**。
 */
export const WORD_EXPRESSION = Object.freeze({
  其实: '感叹号',
  实际上: '感叹号',
});

/**
 * **不该演表情**的词（D15 的落地，用户 2026-10-11 拍定取方案 A）。
 *
 * ⚠️ 与 `WORD_EXPRESSION` 的区别：那张表是"换成另一个表情"，这张表是"**这个桶给不出表情**"。
 *
 * 证据（`p0/out/polish-report.md` §4.1 + 逐词抽样）：
 * `说明` 命中 7730 条，其中 **5699 条**（占放行 **18.9%**）被它推成「星星眼」。但抽样 14 条
 * 逐条数过是 **7 条元信息 · 6 条推断 · 1 条无法判定**：
 *
 * | 用法 | 实例 | 该演 |
 * |---|---|---|
 * | 推断（≈顿悟） | `这说明笔记链接在 DOM 中存在但不在可视区域内` | 星星眼（对） |
 * | 元信息/流程 | `更新 _tmp_scratch/ 的路径说明` · `已说明是签名发布产物` | **不该演"兴奋"** |
 *
 * 用户的取舍：**"不演"比"演错"好** —— 宠物对着"更新路径说明"演兴奋，比面无表情更惹人烦。
 * 所以这里的处理是**整句不演**（`emotion: null`），代价是那 6 条推断型也一起被牺牲。
 *
 * ⚠️ **只静音表情、不动打分**：`说明` 仍是「顿悟」桶的有效信号词，过阈率不变
 * （这正是方案 A 相对方案 D「移出词表」的关键区别 —— D 会动 P4-1 刚校准的阈值）。
 * ⚠️ 桶里**只要还有别的真信号词**（如 `结论` / `interesting`），照常按桶的默认表情演。
 */
export const SILENT_WORDS = Object.freeze(['说明']);


// ── 可调参数（默认值与邻居模块对齐，见各自注释）─────────────────────────

/** 长度窗口下限：与 `fragment-splitter` 的 `minChars` 一致，也对应打分器的 `len<8` 扣分 */
export const DEFAULT_MIN_CHARS = 8;

/**
 * 长度窗口上限 170 —— 与 `interest-scorer` 的"长度适合朗读"窗口一致。
 * ⚠️ 不是 `fragment-splitter` 的硬上限 180：这里要留出**裁到句界**的余量。
 */
export const DEFAULT_MAX_CHARS = 170;

/**
 * 允许"尾部长于多少字"就认为它是**一个完整的分句**而不是截断残句。
 * 12 字是实测口径：`其实先别乱跑命令`（9 字，无句末标点，是完整自语）要放行，
 * 而 `and what still needs`（4 字尾巴）要砍。见 `trimBoundary`。
 */
export const DANGLING_TAIL_MAX = 12;

// ── 噪声判据（与 `interest-scorer` 的判据同义，但独立实现 ≠ 重复调用）──────

/** Markdown 标题：`#` ~ `######` 起头（含行内任意一行的行首） */
const HEADING_LINE = /^#{1,6}\s/m;
/** 围栏代码块：念出来是"三个反引号 js" */
const CODE_FENCE = /```|~~~/;
/** Markdown 表格：念出来是一串竖线横杠 */
const TABLE_LINE = /^\s*\|/m;
/** Markdown 列表符号（行首） */
const LIST_MARKER = /^[ \t]*(?:[-*+•·]|\d{1,2}[.)])\s+/gm;
/** 行内代码 */
const INLINE_CODE = /`([^`\n]*)`/g;
/**
 * 强调标记 → 只去标记，保留被强调的字。
 *
 * ⚠️ 刻意**只处理双下划线/双星号与单星号，不处理单下划线**：
 *    单下划线在标识符里到处都是（`foo_bar_baz`），剥掉它等于**改了模型写的字**
 *    —— 违反本模块的第一条铁律。宁可留一个 `_` 不处理，也不动标识符。
 */
const EMPHASIS_BOLD = /\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*|__(?=\S)([\s\S]*?)(?<=\S)__/g;
const EMPHASIS_ITALIC = /(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g;
/** Markdown 链接 `[文字](url)` → 只留文字 */
const MD_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
/** 裸 URL */
const BARE_URL = /\bhttps?:\/\/\S+/gi;
/** emoji / 象形符号 / 零宽字符：TTS 要么跳过、要么念成怪东西 */
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\u200b-\u200f\u2060\ufe0f]/gu;
/** 句末标点（中英）；英文句点另有"必须后接空白"的额外条件，见 `boundaryIndices` */
const TERMINAL_CHARS = '。！？…!?';
/** 句末标点（含英文句点）+ 可能跟随的成对收尾符号 */
const TERMINAL_TAIL = /[。！？…!?\.]["'”’）」』】〕》]?\s*$/;
/** 尾部悬挂的收尾符号（引号/括号未闭合时留给 TTS 是噪声） */
const TRAILING_CLOSERS = /["'”’）」』】〕》\s]+$/;
/**
 * 首部悬挂标点（D12 的现场：片段以逗号开头）。
 * ⚠️ 字符类里的 `]` **必须转义** —— 不转义会让字符类提前闭合，
 *    整个剥离规则**静默失效**（不是报错，是"什么都没做"）。这个坑已踩过一次。
 */
const LEADING_PUNCT = /^[\s，,、;；:：。.！!？?…—–~·）)】〕》」』"'”’\]}]+/;
/** 中文里的悬挂词尾：留着它说明这句话没说完 */
const DANGLING_ZH = Object.freeze([
  '的', '地', '得', '和', '与', '及', '或', '而', '但', '把', '被', '让', '从', '向', '以',
  '因为', '所以', '如果', '虽然', '但是', '然后', '而且', '以及', '并且', '或者', '关于', '对于',
]);
/** 英文里的悬挂词尾（同上） */
const DANGLING_EN = new Set([
  'and', 'or', 'but', 'so', 'because', 'if', 'when', 'while', 'with', 'without', 'to', 'of',
  'the', 'a', 'an', 'that', 'which', 'who', 'as', 'in', 'on', 'at', 'for', 'from', 'by', 'is',
  'was', 'were', 'are', 'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
  'then', 'than', 'into', 'over', 'under', 'about', 'like', 'such', 'being', 'not',
]);

const CJK = /[\u4e00-\u9fff]/g;
const LATIN = /[A-Za-z]/g;

const countMatches = (text, re) => (text.match(re) ?? []).length;

/** 归一化入参：契约是 `Fragment`，但流水线里也可能直接传字符串。 */
function toText(fragment) {
  if (typeof fragment === 'string') return fragment;
  if (fragment !== null && typeof fragment === 'object' && typeof fragment.text === 'string') {
    return fragment.text;
  }
  return '';
}

/** 末尾的"悬挂词"：中文按结尾子串、英文按最后一个单词 */
function endsWithDangling(text) {
  if (text === '') return false;
  for (const word of DANGLING_ZH) {
    if (text.endsWith(word)) return true;
  }
  const lastWord = /([A-Za-z']+)$/.exec(text);
  if (lastWord) return DANGLING_EN.has(lastWord[1].toLowerCase());
  return false;
}

/**
 * 找出所有"可当句界"的位置（返回索引，升序）。
 *
 * 中文句末标点（`。！？…!?`）无条件算句界；英文句点 `.` 只在**后接空白或结尾**时算
 * —— 否则 `lib/core/foo.js` 里那个点会被当成句子结束，把片段劈成"lib/core/foo"。
 */
function boundaryIndices(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (TERMINAL_CHARS.includes(ch)) {
      out.push(i);
      continue;
    }
    if (ch === '.' && (i + 1 === text.length || /\s/.test(text[i + 1]))) out.push(i);
  }
  return out;
}

/**
 * 裁齐首尾（**D12 的修复**）。返回 `{text, changes, rejected}`。
 *
 * 判定顺序（每一步都可独立单测）：
 *   1. 首部悬挂标点 → 删（片段以逗号开头 = 切在了句子中间）
 *   2. 尾部已有句末标点 → 完事
 *   3. 尾部无句末标点：
 *      a. 有内部句界，且尾巴 ≤ `DANGLING_TAIL_MAX` → 裁到该句界（丢掉半截尾巴）
 *      b. 有内部句界，尾巴更长 → 视为一个完整分句，保留（中文自语常常没有句号）
 *      c. 没有内部句界，且（首部原本有悬挂标点 或 以悬挂词收尾）→ **拒收**（残句）
 *      d. 没有内部句界，其余情况 → 保留
 */
function trimBoundary(input, minChars) {
  const changes = [];
  let text = input;
  const hadLeadingPunct = text !== text.replace(LEADING_PUNCT, '');
  if (hadLeadingPunct) {
    text = text.replace(LEADING_PUNCT, '');
    changes.push('去首部悬挂标点');
  }
  if (text.length < minChars) return { text, changes, rejected: '去首部标点后过短' };

  // 尾部未闭合的引号/括号：先摘掉再看它是不是句子收尾
  // （`"Wait, this looks wrong."` 这种整句引用，`.后跟引号` 也该算说完）
  if (!TERMINAL_TAIL.test(text)) {
    const withoutClosers = text.replace(TRAILING_CLOSERS, '');
    if (withoutClosers !== text && TERMINAL_TAIL.test(withoutClosers)) {
      text = withoutClosers;
      changes.push('去尾部悬挂引号');
    }
  }

  if (TERMINAL_TAIL.test(text)) return { text, changes, rejected: null };

  const bounds = boundaryIndices(text);
  const last = bounds.length > 0 ? bounds[bounds.length - 1] : -1;

  if (last >= 0) {
    const tail = text.slice(last + 1).trim();
    if (tail.length > 0 && tail.length <= DANGLING_TAIL_MAX) {
      text = text.slice(0, last + 1);
      changes.push('裁掉未完成的尾巴');
    }
    return { text: text.trim(), changes, rejected: null };
  }

  if (hadLeadingPunct || endsWithDangling(text)) {
    return { text, changes, rejected: '残句（无句界且首尾是悬挂成分）' };
  }
  return { text, changes, rejected: null };
}

/**
 * 长度适配：只在**句界**上裁，绝不在词中间砍。
 * @returns {{text:string, changes:string[], rejected:string|null}}
 */
function fitLength(input, maxChars) {
  if (input.length <= maxChars) return { text: input, changes: [], rejected: null };
  const bounds = boundaryIndices(input).filter((i) => i + 1 <= maxChars);
  if (bounds.length > 0) {
    const cut = bounds[bounds.length - 1];
    return { text: input.slice(0, cut + 1), changes: ['超长，裁到最后一个句界'], rejected: null };
  }
  // 窗口内一个句界都没有 —— 硬砍会念半句话，宁可不念（R3：拒绝也要留痕）
  return { text: input, changes: [], rejected: '超长且窗口内无句界' };
}

/**
 * 清洗（只做**删除**，不做插入）。返回 `{text, changes, rejected}`。
 */
function clean(input) {
  const changes = [];
  let text = input;

  // ① 结构性噪声：这几种整条都不该念（兜底打分侧，判据独立实现）
  if (CODE_FENCE.test(text)) return { text, changes, rejected: '含代码块' };
  if (HEADING_LINE.test(text)) return { text, changes, rejected: '含 Markdown 标题' };
  if (TABLE_LINE.test(text)) return { text, changes, rejected: '含 Markdown 表格' };

  // ② 标记类：只去标记，保留它包着的字
  const before = text;
  text = text
    .replace(LIST_MARKER, '')
    .replace(MD_LINK, '$1')
    .replace(BARE_URL, '')
    .replace(INLINE_CODE, '$1')
    .replace(EMPHASIS_BOLD, '$1$2')
    .replace(EMPHASIS_ITALIC, '$1');
  if (text !== before) changes.push('去 Markdown 标记');

  // ③ 不可朗读字符
  const noPict = text.replace(PICTOGRAPHIC, '');
  if (noPict !== text) {
    text = noPict;
    changes.push('去 emoji/零宽字符');
  }

  // ④ 空白合并（换行/多空格 → 单空格）
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed !== text.trim()) changes.push('合并空白');
  text = collapsed;

  return { text, changes, rejected: null };
}

/** 最终验收：清洗裁齐之后，还剩下"能开口念"的东西吗？ */
function isSpeakable(text, minChars) {
  if (text.length < minChars) return false;
  if (text.replace(PICTOGRAPHIC, '').trim() === '') return false;
  const letters = countMatches(text, CJK) + countMatches(text, LATIN);
  if (letters / text.length < 0.35) return false; // 只剩标点/符号
  return true;
}

/**
 * 从打分结果推表情标签。
 *
 * @param {string[]} [buckets] 命中桶名（`interest-scorer` 的 `buckets`）
 * @param {Record<string,string[]>} [matches] 桶名 → 命中词（`interest-scorer` 的 `matches`）
 * @returns {string|null} 模型表情 key，或 null（"没有情绪可言，别演"）
 */
export function pickEmotion(buckets, matches) {
  const list = Array.isArray(buckets) ? buckets : [];
  for (const bucket of EMOTION_PRIORITY) {
    if (!list.includes(bucket)) continue;
    const words = (matches && matches[bucket]) || [];

    // 拿不到命中词（调用方只给了桶名）⇒ 无法细分，用桶的默认表情
    if (words.length === 0) return BUCKET_EXPRESSION[bucket] ?? null;

    if (bucket === '情绪外露') {
      const snark = words.some((w) => SNARK_WORDS.includes(w));
      return snark ? SNARK_EXPRESSION : BUCKET_EXPRESSION['情绪外露'];
    }

    // 逐词纠偏（见 `WORD_EXPRESSION` / `SILENT_WORDS`）：
    //   桶里**还有"普通信号词"在场** ⇒ 按桶的默认表情演（`其实…但是等等` 里的"等等"更可疑）；
    //   整句**只由特殊词撑起来** ⇒ 按词的裁定：换表情（`其实`→感叹号）或**不演**（`说明`→null）。
    //   ⚠️ 「不演」时**继续看下一个桶**，而不是直接返回 null ——
    //      否则 `说明`（顿悟，静音）+ `其实`（自我怀疑，感叹号）会白丢一个可演的表情。
    const isSpecial = (w) => Object.hasOwn(WORD_EXPRESSION, w) || SILENT_WORDS.includes(w);
    if (words.some((w) => !isSpecial(w))) return BUCKET_EXPRESSION[bucket] ?? null;

    const expressive = words.find((w) => Object.hasOwn(WORD_EXPRESSION, w));
    if (expressive !== undefined) return WORD_EXPRESSION[expressive];
    // 这个桶全是"不该演"的词 ⇒ 交给下一个桶决定
  }
  return null; // 没有可演的情绪（含"靠结构信号过阈"与"只剩静音词"两种情况）
}

/**
 * 收拾一条片段，产出可念的台词。
 *
 * @param {unknown} fragment 片段（`{text}` 或裸字符串）
 * @param {object} [context]
 * @param {number} [context.score]   打分结果（透传，不参与清洗）
 * @param {string[]} [context.buckets] 命中桶（`interest-scorer` 的 `buckets`）
 * @param {Record<string,string[]>} [context.matches] 命中词
 * @param {number} [context.maxChars]
 * @param {number} [context.minChars]
 * @returns {{line: {text:string, emotion:string|null, score:number}|null, reason:string, changes:string[]}}
 *          `line === null` ⇒ 这条**不该念**（残句/标题/代码/裁完没内容），
 *          `reason` 是给日志看的原因（R3：拒绝必须留痕，不得静默）。
 */
export function polish(fragment, context = {}) {
  const original = toText(fragment);
  const minChars = context.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = context.maxChars ?? DEFAULT_MAX_CHARS;
  const score = Number.isFinite(context.score) ? context.score : 0;

  if (original.trim() === '') return { line: null, reason: '空片段', changes: [] };

  const cleaned = clean(original);
  if (cleaned.rejected) return { line: null, reason: cleaned.rejected, changes: cleaned.changes };
  if (cleaned.text.length < minChars) {
    return { line: null, reason: '清洗后过短', changes: cleaned.changes };
  }

  const fitted = fitLength(cleaned.text, maxChars);
  if (fitted.rejected) {
    return { line: null, reason: fitted.rejected, changes: [...cleaned.changes, ...fitted.changes] };
  }

  const trimmed = trimBoundary(fitted.text, minChars);
  if (trimmed.rejected) {
    return { line: null, reason: trimmed.rejected, changes: [...cleaned.changes, ...trimmed.changes] };
  }

  const text = trimmed.text;
  const changes = [...cleaned.changes, ...fitted.changes, ...trimmed.changes];
  if (!isSpeakable(text, minChars)) {
    return { line: null, reason: '清洗裁齐后没有可念内容', changes };
  }

  return {
    line: { text, emotion: pickEmotion(context.buckets, context.matches), score },
    reason: 'ok',
    changes,
  };
}

/**
 * 批量收拾（顺序保持，便于上层按原顺序入队）。
 * @returns {Array<{ok:boolean, line:object|null, reason:string, original:string}>}
 */
export function polishAll(fragments, context = {}) {
  if (!Array.isArray(fragments)) return [];
  return fragments.map((fragment) => {
    const original = toText(fragment);
    const { line, reason, changes } = polish(fragment, context);
    return { ok: line !== null, line, reason, changes, original };
  });
}
