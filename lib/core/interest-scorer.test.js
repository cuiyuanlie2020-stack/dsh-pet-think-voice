/**
 * `lib/core/interest-scorer.test.js` — P2-4 单测
 *
 * 断言策略：**只断言相对次序与区间，不断言具体分数**。理由 ——
 * D2（词表与阈值校准）明确排在 P4-1「用真实数据校准」；此刻若把 0.53 这类
 * 数字写死在测试里，等于把"未校准的假设"固化成了契约，P4-1 一调就全红。
 * 这里守的是真正该守的东西：**命中词表 > 平淡 > 噪声**，以及分数始终在 0..1。
 *
 * ⚠️ 文本内容一律合成（真实对话属隐私，永不入库）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THRESHOLD,
  TRIGGER_LEXICON,
  rank,
  score,
  scoreSync,
} from './interest-scorer.js';

// 合成样本（结构模拟真实思考里的四类"有戏"表达）
// ⚠️ P4-1 重校后：样本里的信号词**必须是实测存在的**（见 interest-scorer.js 的 P4-1 段）。
//    上一版用了「原来」/「哎」/「绕了一大圈」—— 那些词在 4714 个真实片段上**零命中**，
//    等于护栏建在空气上。现在改为实测 DF≥5 的词。
const SELF_DOUBT = '等等，这个方向其实不对，我该重新看一遍再动手。';
const EPIPHANY = '结论：参数顺序反了，这说明之前的报错根本原因就在这里。';
const GRUMBLE = '又踩到同一个坑，这里还要重跑一次，真够麻烦的。';
const HESITATE = '嗯……不过还是先看一眼再决定吧，或者先跑个测试试试？';
const PLAIN = '先看看这个文件里的实现，然后接着处理下一个问题。';
const CODE = 'const a = { b: 1 };';
const PATH = 'C:\\Users\\MSI\\WorkBuddy\\project\\lib\\index.js';
const SYMBOLS = '=> { } [ ] ; //```';

// ───────────────────────── 契约形状 ─────────────────────────

test('契约形状：score() 是异步的，返回 {score, reason}', async () => {
  const r = await score(EPIPHANY);
  assert.equal(typeof r.score, 'number');
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0, 'reason 不得为空 —— G2 要求"命中率可被规则解释"');
});

test('score 恒落在 0..1', async () => {
  const samples = [SELF_DOUBT, EPIPHANY, GRUMBLE, HESITATE, PLAIN, CODE, PATH, SYMBOLS];
  for (const s of samples) {
    const { score: v } = await score(s);
    assert.ok(v >= 0 && v <= 1, `${JSON.stringify(s.slice(0, 20))} → ${v} 越界`);
  }
});

test('async score 与 scoreSync 结果一致（规则级是同步实现套壳）', async () => {
  for (const s of [EPIPHANY, PLAIN, CODE]) {
    const a = await score(s);
    const b = scoreSync(s);
    assert.equal(a.score, b.score);
    assert.equal(a.reason, b.reason);
  }
});

test('空/非法输入 → 0 分，且不抛错', async () => {
  for (const input of ['', '   ', '\n\n', null, undefined, 0, [], {}]) {
    const r = await score(input);
    assert.equal(r.score, 0);
  }
});

test('容忍片段对象（{text}）形态', async () => {
  const a = await score(FragmentLike(EPIPHANY));
  const b = await score(EPIPHANY);
  assert.equal(a.score, b.score);
});

function FragmentLike(text) {
  return { index: 0, text, charCount: text.length, estMs: 0 };
}

// ───────────────────── 核心判据：命中 > 平淡 > 噪声 ─────────────────────

test('命中情绪词表的片段得分 > 平淡片段（P2-4 判据之一）', async () => {
  const plain = (await score(PLAIN)).score;
  for (const [name, sample] of [
    ['自我怀疑', SELF_DOUBT], ['顿悟', EPIPHANY], ['吐槽', GRUMBLE], ['犹豫权衡', HESITATE],
  ]) {
    const got = (await score(sample)).score;
    assert.ok(got > plain, `${name}(${got}) 应高于平淡(${plain})`);
  }
});

test('噪声片段得分 < 平淡片段（P2-4 判据之二）', async () => {
  const plain = (await score(PLAIN)).score;
  for (const [name, sample] of [['代码', CODE], ['路径', PATH], ['纯符号', SYMBOLS]]) {
    const got = (await score(sample)).score;
    assert.ok(got < plain, `${name}(${got}) 应低于平淡(${plain})`);
  }
});

test('噪声片段被压到低位（无论如何都过不了阈值）', async () => {
  for (const label of [CODE, PATH, SYMBOLS]) {
    const { score: v } = await score(label);
    assert.ok(v < 0.3, `噪声仍得 ${v} 分：${label.slice(0, 24)}`);
  }
});

test('四类情绪都真的能命中（词表不是摆设）', async () => {
  for (const [name, sample] of [
    ['自我怀疑', SELF_DOUBT], ['顿悟', EPIPHANY], ['吐槽', GRUMBLE], ['犹豫权衡', HESITATE],
  ]) {
    const { reason, hits } = await score(sample);
    assert.ok(reason.includes(name), `${name} 未出现在 reason：${reason}`);
    assert.ok(hits.some((h) => h.rule.includes(name)), `${name} 未出现在 hits`);
  }
});

test('平淡但有信息量的片段拿不到阈值（这是"降噪"的实现方式）', async () => {
  const { score: v } = await score(PLAIN);
  assert.ok(v < DEFAULT_THRESHOLD, `平淡片段 ${v} 不应越过阈值 ${DEFAULT_THRESHOLD}`);
});

test('命中片段能越过阈值（否则规则级筛出来是空的）', async () => {
  for (const [name, sample] of [['自我怀疑', SELF_DOUBT], ['顿悟', EPIPHANY], ['吐槽', GRUMBLE]]) {
    const { score: v } = await score(sample);
    assert.ok(v >= DEFAULT_THRESHOLD, `${name} 只拿到 ${v}，低于阈值 ${DEFAULT_THRESHOLD}`);
  }
});

// ───────────────────────── 细节规则 ─────────────────────────

test('同一类情绪多次命中只计一次（防止"还是…还是…还是"刷分）', async () => {
  // ⚠️ 用例里不能出现别的桶的词（第一版用了「等等」，它属于"自我怀疑"，
  //    造成跨桶命中 + 叠加奖励，测出来的差异不是"重复计分"造成的）
  // ⚠️ P4-1 起「还是」属"犹豫权衡"，仍只命中该桶，用例成立。
  const once = '还是先看一眼吧。';
  const many = '还是先看一眼吧，还是再核对一下，还是别急着改，还是先这样。';
  const a = (await score(once)).score;
  const b = (await score(many)).score;
  // 允许长度/标点带来微小差异，但不得因为重复 4 次就把权重翻 4 倍
  assert.ok(b - a < 0.15, `重复命中不该线性加分：1 次 ${a} → 4 次 ${b}`);
});

test('多类情绪叠加 > 单类（"边怀疑边顿悟"最好听）', async () => {
  const single = (await score(EPIPHANY)).score;
  const both = (await score(`${SELF_DOUBT}${EPIPHANY}`)).score;
  assert.ok(both > single, `叠加(${both}) 应高于单类(${single})`);
});

test('带疑问/感叹号的片段得分更高', async () => {
  const plain = '先看看这个文件的实现，然后接着处理下一个问题；';
  const withQ = '先看看这个文件的实现，然后接着处理下一个问题？';
  assert.ok((await score(withQ)).score > (await score(plain)).score);
});

test('长度适合朗读的区间被加分，过短被扣分', async () => {
  const tiny = (await score('嗯。')).score;
  const good = (await score('嗯……这个写法其实不太对，我再确认一下参数顺序。')).score;
  assert.ok(good > tiny, `适中长度(${good}) 应高于过短(${tiny})`);
});

// ───────────────────────── 词表可校准性（D2 铺垫）─────────────────────────

test('词表独立导出且含四类 —— P4-1 校准时不需改逻辑', () => {
  assert.deepEqual(Object.keys(TRIGGER_LEXICON).sort(),
    ['犹豫权衡', '吐槽', '顿悟', '自我怀疑'].sort());
  for (const [name, entry] of Object.entries(TRIGGER_LEXICON)) {
    assert.ok(Array.isArray(entry.words) && entry.words.length > 0, `${name} 词表为空`);
    assert.equal(typeof entry.weight, 'number');
  }
});

test('阈值是导出的常量，可被上层覆盖使用', () => {
  assert.equal(typeof DEFAULT_THRESHOLD, 'number');
  assert.ok(DEFAULT_THRESHOLD > 0 && DEFAULT_THRESHOLD < 1);
});

// ─────────────────── 中文侧护栏（P4-1 / D11 —— 这是"能出声"的前置）───────────────
// ⚠️ 这组测试守的是 D11 那次事故：中文注入生效后，**中文思考必须有片段选得出来**。
//    上一版词表在中文侧"顿悟/吐槽两桶全 0"，中文语料过阈率只有 4.4%，
//    默认配置下宠物永远不出声。下面每条样本都用**实测 DF≥5** 的词构成。

test('中文四类信号都真的能命中（不是英文半边撑场面）', async () => {
  for (const [name, sample] of [
    ['自我怀疑', '其实这条路不太对，等等，我先重新看一遍再说。'],
    ['顿悟', '结论出来了：是这个参数反了，说明之前的判断有问题。'],
    ['吐槽', '这里又踩到同一个坑，改完还要重跑，挺麻烦的。'],
    ['犹豫权衡', '嗯……不过或者先跑个测试？这个至少能排除一种可能。'],
  ]) {
    const { reason, hits } = await score(sample);
    assert.ok(hits.some((h) => h.rule.includes(name)), `${name} 未命中：${reason}`);
  }
});

test('中文强信号片段能越过阈值（D11 的判据）', async () => {
  for (const [name, sample] of [
    ['自我怀疑', '其实这条路不太对，等等，我先重新看一遍再说。'],
    ['顿悟', '结论出来了：是这个参数反了，说明之前的判断有问题。'],
  ]) {
    const { score: v, reason } = await score(sample);
    assert.ok(v >= DEFAULT_THRESHOLD, `${name} 只拿到 ${v}（阈值 ${DEFAULT_THRESHOLD}）：${reason}`);
  }
});

test('词表不含"僵尸词"——P4-1 剔除的 37 个凭想象写的词不得回流', () => {
  // 这些词在 4714 个真实片段上**零命中**（见 interest-scorer.js 的 P4-1 段）。
  // 它们不会让代码报错，只会让人误以为"这桶有覆盖"从而掩盖真实缺口。
  const ZOMBIES = [
    '原来', '懂了', '想通', '明白了', '知道了', '恍然大悟',
    '我搞错', '搞错', '反了', '弄错', '看错',
    '哎', '绕了一大圈', '白折腾', '无语', '离谱',
    '权衡', '纠结',
    'makes sense', 'got it', 'turns out', 'ugh', 'tricky',
  ];
  const all = Object.values(TRIGGER_LEXICON).flatMap((e) => e.words);
  for (const z of ZOMBIES) {
    assert.ok(!all.includes(z), `僵尸词「${z}」回流了 —— 它在本模型语料上零命中`);
  }
});

test('词表每个词条都是非空字符串（防手滑写成空串 → 命中一切）', () => {
  for (const [name, entry] of Object.entries(TRIGGER_LEXICON)) {
    for (const w of entry.words) {
      assert.equal(typeof w, 'string', `${name} 含非字符串词条`);
      assert.ok(w.trim().length > 0, `${name} 含空词条 —— 会让所有片段命中该桶`);
    }
  }
});

// ───────────────────────── rank 批量 ─────────────────────────

test('rank 按分数降序，且能把噪声排到最后', async () => {
  const out = await rank([CODE, PLAIN, EPIPHANY, PATH, GRUMBLE]);
  assert.equal(out.length, 5);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].score >= out[i].score, '必须降序');
  }
  const top2 = out.slice(0, 2).map((x) => x.fragment);
  assert.ok(top2.includes(EPIPHANY) && top2.includes(GRUMBLE), `top2 = ${JSON.stringify(top2)}`);
  assert.ok(out[out.length - 1].score < 0.3, '噪声应垫底');
});

test('rank 对非数组输入返回空数组', async () => {
  for (const bad of [null, undefined, 0, 'x', {}]) {
    assert.deepEqual(await rank(bad), []);
  }
});
