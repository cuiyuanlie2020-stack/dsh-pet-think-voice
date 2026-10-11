/**
 * `lib/core/line-polisher.test.js` — P4-2 单测
 *
 * 三层判据：
 *   ① **不变量**：输出是输入的子序列（去空白后）—— 把"只挑只裁、绝不改字"变成可执行断言
 *   ② **行为**：D12 残句被拦、Markdown/emoji 被清、超长裁到句界
 *   ③ **表情**：桶 → 模型表情 key，含「情绪外露」的偷懒/阴阳细分与多桶优先级
 *
 * ⚠️ 文本一律**合成**（真实对话属隐私，永不入库）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKET_EXPRESSION, DEFAULT_MAX_CHARS, EMOTION_PRIORITY, EXPRESSION_KEYS,
  SNARK_EXPRESSION, polish, polishAll, pickEmotion,
} from './line-polisher.js';

// ───────────────────── 工具 ─────────────────────

/** 去掉全部空白（用于"子序列"不变量：合并空白不算插入字符） */
const stripWs = (s) => s.replace(/\s+/g, '');

/** `sub` 是否为 `full` 的子序列（按码点） */
function isSubsequence(sub, full) {
  let i = 0;
  for (const ch of full) {
    if (i < sub.length && ch === sub[i]) i += 1;
  }
  return i === sub.length;
}

/** 断言：输出没有引入任何输入里没有的字符 */
function assertNoInsertion(line, original, label = '') {
  assert.ok(
    isSubsequence(stripWs(line.text), stripWs(original)),
    `${label} 输出插入了原文没有的字符：\n  原文=${original}\n  输出=${line.text}`,
  );
}

const CASES = [
  '，其实先别乱跑命令。',
  '**粗体** 后面跟着 `代码` 和 [链接](https://example.com/a) 这样的东西。',
  '- 第一项\n- 第二项，两行都要能念。',
  '这很有意思 🔴 真的很奇怪，值得再看一眼。',
  '其实先别乱跑命令。另外还有一点',
  '所以我现在要重新检查一下这个参数顺序，然后再决定。',
  '嗯，或者我们先跑个测试看看结果，不用急着改。',
  '\t多个   空白\n\n都要合并掉，念起来才顺。',
  '好吧，那就先这样，我待会儿再说。',
  '结论：当前用的是官方账号通道，所以行为一致。',
];

// ───────────────────── ① 不变量：绝不插入字符 ─────────────────────

test('铁律：输出是输入的子序列（去空白后）—— 绝不插入任何字符', () => {
  for (const original of CASES) {
    const { line } = polish(original);
    if (!line) continue;
    assertNoInsertion(line, original, `[${original.slice(0, 12)}]`);
  }
});

test('铁律的反面：往句子里加语气词会被这个不变量顶红', () => {
  const original = '结论：当前用的是官方账号通道。';
  const { line } = polish(original);
  assert.ok(line);
  // 模拟"以后有人想加个「诶？」"——不变量必须能抓到
  const withParticle = { text: `诶？${line.text}` };
  assert.equal(
    isSubsequence(stripWs(withParticle.text), stripWs(original)), false,
    '不变量失效：插入了原文没有的「诶？」却没被发现',
  );
});

test('纯函数：同输入必得同输出，且不改动入参', () => {
  const fragment = { text: '其实先别乱跑命令。' };
  const a = polish(fragment);
  const b = polish(fragment);
  assert.deepEqual(a, b);
  assert.equal(fragment.text, '其实先别乱跑命令。', '入参对象被改动了');
});

// ───────────────────── ② 边界裁齐（D12）─────────────────────

test('D12：切在句子中间的残句被拦下（真机抓到的原文形态）', () => {
  // ⚠️ 这是 HANDOFF §10 D12 记录的真实现场（英文侧），原样复现
  const residual = ', being honest about confidence levels and what still needs ';
  const { line, reason } = polish(residual);
  assert.equal(line, null, '残句不该被念出来');
  assert.match(reason, /残句/);
});

test('D12：片段以逗号开头 → 首部悬挂标点被删掉', () => {
  const { line, changes } = polish('，其实先别乱跑命令。');
  assert.equal(line.text, '其实先别乱跑命令。');
  assert.ok(changes.includes('去首部悬挂标点'));
});

test('尾部是半截尾巴（≤12 字）→ 裁到最近的句界', () => {
  const { line, changes } = polish('其实先别乱跑命令。另外还有一点');
  assert.equal(line.text, '其实先别乱跑命令。');
  assert.ok(changes.includes('裁掉未完成的尾巴'));
});

test('无句界 + 以悬挂词收尾 → 拒收（残句）', () => {
  for (const text of ['我需要先看一下这个的', 'I should check the file and', '这个方案看起来和']) {
    const { line } = polish(text);
    assert.equal(line, null, `应拒收：${text}`);
  }
});

test('无句界但没有悬挂成分（中文自语常态）→ 放行，不加标点', () => {
  const { line } = polish('其实先别乱跑命令');
  assert.ok(line, '完整的中文自语不该被拒');
  assert.equal(line.text, '其实先别乱跑命令', '不得补标点（那就是插入了）');
});

test('尾部已有句末标点 → 原样保留', () => {
  const { line, changes } = polish('所以先别急着改。');
  assert.equal(line.text, '所以先别急着改。');
  assert.deepEqual(changes, []);
});

// ───────────────────── ③ 呈现清洗 ─────────────────────

test('去 Markdown 标记：粗体/行内代码/链接只留文字', () => {
  const { line } = polish('**粗体** 后面跟着 `代码` 和 [文档](https://example.com/a) 这样的东西。');
  assert.ok(!line.text.includes('*'), '强调标记没去掉');
  assert.ok(!line.text.includes('`'), '行内代码标记没去掉');
  assert.ok(!line.text.includes('https://'), '链接地址没去掉');
  assert.ok(line.text.includes('粗体') && line.text.includes('文档'), '被包着的字丢了');
});

test('裸 URL 被去掉，句子仍可念', () => {
  const { line } = polish('更多说明见 https://example.com/a 这个页面就可以了。');
  assert.ok(line);
  assert.ok(!line.text.includes('http'), '裸 URL 没去掉');
});

test('列表符号被去掉，多行合并成一句', () => {
  const { line } = polish('- 第一项\n- 第二项，两行都要能念。');
  assert.ok(line);
  assert.ok(!/[-*+•]\s/.test(line.text), `列表符号残留：${line.text}`);
  assert.ok(line.text.includes('第一项') && line.text.includes('第二项'));
});

test('emoji 被去掉（念出来是噪声）', () => {
  const { line, changes } = polish('这很有意思 🔴 真的很奇怪，值得再看一眼。');
  assert.ok(!line.text.includes('🔴'), 'emoji 没去掉');
  assert.ok(changes.includes('去 emoji/零宽字符'));
});

test('Markdown 标题一律拒收（兜底打分侧，判据独立实现）', () => {
  const { line, reason } = polish('## 结论：不是卡住，是模型在长时间思考');
  assert.equal(line, null);
  assert.match(reason, /Markdown 标题/);
});

test('代码块与表格一律拒收', () => {
  assert.equal(polish('```js\nconst a = 1\n```').line, null);
  assert.equal(polish('| 列一 | 列二 |').line, null);
});

test('多空白/换行合并为单空格', () => {
  const { line, changes } = polish('\t多个   空白\n\n都要合并掉，念起来才顺。');
  assert.ok(!/\s{2,}/.test(line.text), `仍有连续空白：${JSON.stringify(line.text)}`);
  assert.ok(changes.includes('合并空白'));
});

test('标识符里的单下划线不动（剥掉它就等于改了模型写的字）', () => {
  const { line } = polish('这个名字叫 foo_bar_baz 的变量看起来没问题，需要确认。');
  assert.ok(line);
  assert.ok(line.text.includes('foo_bar_baz'), `标识符被改动了：${line.text}`);
});

// ───────────────────── ④ 长度 ─────────────────────

test('超长 → 裁到最后一个句界，不硬砍', () => {
  const long = '这是一句很长的中文。'.repeat(20);
  const { line, changes } = polish(long);
  assert.ok(line);
  assert.ok(line.text.length <= DEFAULT_MAX_CHARS);
  assert.ok(line.text.endsWith('。'), '裁完应以句末标点收尾');
  assert.ok(changes.includes('超长，裁到最后一个句界'));
});

test('超长且窗口内无句界 → 拒收（宁可不念，也不念半句话）', () => {
  const { line, reason } = polish('x'.repeat(DEFAULT_MAX_CHARS + 40));
  assert.equal(line, null);
  assert.match(reason, /无句界/);
});

test('清洗后过短 → 拒收', () => {
  assert.equal(polish('**ab**').line, null);
  assert.equal(polish('🔴🔴🔴🔴🔴🔴🔴🔴').line, null);
});

test('空片段 / 非字符串 → 拒收', () => {
  assert.equal(polish('').line, null);
  assert.equal(polish('   ').line, null);
  assert.equal(polish(null).line, null);
  assert.equal(polish({}).line, null);
  assert.equal(polishAll(null).length, 0);
});

// ───────────────────── ⑤ 表情标签 ─────────────────────

test('桶 → 模型表情 key', () => {
  assert.equal(pickEmotion(['顿悟'], {}), '星星眼');
  assert.equal(pickEmotion(['自我怀疑'], {}), '问号');
  assert.equal(pickEmotion(['吐槽'], {}), '生气');
  assert.equal(pickEmotion(['犹豫权衡'], {}), '呆呆眼');
});

test('「情绪外露」细分：偷懒 → 调皮，阴阳怪气 → 吐舌', () => {
  assert.equal(pickEmotion(['情绪外露'], { 情绪外露: ['算了', '省事'] }), '调皮');
  assert.equal(pickEmotion(['情绪外露'], { 情绪外露: ['无语'] }), SNARK_EXPRESSION);
  assert.equal(pickEmotion(['情绪外露'], { 情绪外露: ['有意思'] }), SNARK_EXPRESSION);
  // 两类都有时，优先演阴阳怪气（那是用户点名"最折磨"的戏核）
  assert.equal(pickEmotion(['情绪外露'], { 情绪外露: ['算了', '绝了'] }), SNARK_EXPRESSION);
  // 词表缺失时兜底到偷懒侧，不能抛错
  assert.equal(pickEmotion(['情绪外露'], undefined), '调皮');
});

test('多桶同时命中：按戏剧性优先级取用，不是按权重', () => {
  // `wait, ... I see now` —— 戏核在「顿悟」上，该演星星眼而不是问号
  assert.equal(pickEmotion(['自我怀疑', '顿悟'], {}), '星星眼');
  // 优先级表的顺序必须真的是这个顺序
  assert.deepEqual([...EMOTION_PRIORITY], ['情绪外露', '吐槽', '顿悟', '自我怀疑', '犹豫权衡']);
});

test('逐词纠偏：中文「其实/实际上」是澄清确证，不该演「问号」', () => {
  // 证据：p0/out/polish-report.md §4.1 —— 这两个词贡献 6698 条问号（占放行 22%）
  assert.equal(pickEmotion(['自我怀疑'], { 自我怀疑: ['实际上'] }), '感叹号');
  assert.equal(pickEmotion(['自我怀疑'], { 自我怀疑: ['其实'] }), '感叹号');
  // 真怀疑词不受影响
  assert.equal(pickEmotion(['自我怀疑'], { 自我怀疑: ['等等'] }), '问号');
  assert.equal(pickEmotion(['自我怀疑'], { 自我怀疑: ['hmm'] }), '问号');
  // 英文 actually 不纠偏（它在英文里多是"等等，其实是…"的修正标记）
  assert.equal(pickEmotion(['自我怀疑'], { 自我怀疑: ['actually'] }), '问号');
  // 桶里有真信号词在场 → 按桶的默认表情演（"其实……但是等等"里"等等"更可疑）
  assert.equal(pickEmotion(['自我怀疑'], { 自我怀疑: ['其实', '等等'] }), '问号');
});

test('没有命中桶 → 不演（null），不硬凑表情', () => {
  assert.equal(pickEmotion([], {}), null);
  assert.equal(pickEmotion(undefined, undefined), null);
  assert.equal(pickEmotion(['不存在的桶'], {}), null);
});

test('白名单：标签只能来自模型自己的表情 key（P4-3 才能零映射直通）', () => {
  for (const value of Object.values(BUCKET_EXPRESSION)) {
    assert.ok(EXPRESSION_KEYS.includes(value), `桶映射产出白名单外的标签：${value}`);
  }
  assert.ok(EXPRESSION_KEYS.includes(SNARK_EXPRESSION));
  // ⚠️ 这份表来自 `pets/ds-whale-girl/catalog.json` 里 category=emotion 的 20 个 key。
  //    换模型 / 上游更新美术包时必须同步（本层不允许读文件，故此处只守数量与内部一致性）。
  assert.equal(EXPRESSION_KEYS.length, 20, '表情数与模型对不上了，检查 catalog.json');
  assert.equal(new Set(EXPRESSION_KEYS).size, EXPRESSION_KEYS.length, '表情白名单有重复项');
});

test('polish 产出的 emotion 一定在白名单内或为 null', () => {
  const { line } = polish('嗯，或者我们先跑个测试看看结果，不用急着改。', {
    buckets: ['犹豫权衡'], matches: { 犹豫权衡: ['嗯'] }, score: 0.6,
  });
  assert.ok(line);
  assert.ok(EXPRESSION_KEYS.includes(line.emotion));
});

test('polish 透传打分，不改分数', () => {
  const { line } = polish('结论：当前用的是官方账号通道，所以行为一致。', { score: 0.73 });
  assert.equal(line.score, 0.73);
});

// ───────────────────── ⑥ 批量 ─────────────────────

test('polishAll：逐条给出成败与原因，顺序不变', () => {
  const out = polishAll(['其实先别乱跑命令。', '## 标题不该念', '']);
  assert.equal(out.length, 3);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.match(out[1].reason, /标题/);
  assert.equal(out[2].ok, false);
  assert.equal(out[0].original, '其实先别乱跑命令。');
});
