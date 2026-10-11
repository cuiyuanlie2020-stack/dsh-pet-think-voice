/**
 * `lib/core/fragment-splitter.test.js` — P2-3 单测
 *
 * ⚠️ 语料结构的**长度特征**取自真实思考的统计（单句 p50=48 / p90=174 / max=582，
 *    整条中位 1290），但**文本内容一律为合成** —— 真实对话属隐私，永不入库。
 *
 * ⚠️ 必须能脱离 DSH / 浏览器单独跑：把 `lib/core/` 拷到空目录，`node --test` 全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAGMENT_LIMITS,
  SPEECH_CHARS_PER_SEC,
  estimateSpeechMs,
  normalizeText,
  splitFragments,
} from './fragment-splitter.js';

/** 去掉所有空白，用于「不丢字」比较 */
const squash = (s) => s.replace(/\s+/g, '');

/** 造一段合成思考：n 句，每句约 len 字（以句号结尾，便于断言语义完整） */
function makeSentences(n, len = 30, tail = '。') {
  return Array.from({ length: n }, (_, i) => {
    const head = `这是第${i + 1}句合成思考`;
    return head + '补'.repeat(Math.max(0, len - head.length - 1)) + tail;
  }).join('');
}

// ───────────────────────── 基础 ─────────────────────────

test('空/非法输入 → 空数组，且不抛错', () => {
  for (const input of ['', '   ', '\n\n', null, undefined, 0, [], {}]) {
    assert.deepEqual(splitFragments(input), []);
  }
});

test('短文本（不足 softChars）→ 单个片段', () => {
  const out = splitFragments('哦——原来是这样，我搞反了。');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '哦——原来是这样，我搞反了。');
  assert.equal(out[0].index, 0);
  assert.equal(out[0].charCount, 14);
});

test('片段 index 从 0 连续递增', () => {
  const out = splitFragments(makeSentences(20, 30));
  assert.ok(out.length > 1);
  out.forEach((f, i) => assert.equal(f.index, i));
});

// ───────────────────── 核心不变量：硬上限 ─────────────────────

test('每个片段都 ≤ maxChars（长思考，≥1000 字）', () => {
  const long = makeSentences(60, 30); // ≈1800 字
  assert.ok(long.length >= 1000);
  const out = splitFragments(long);
  assert.ok(out.length > 1, '长思考必须被切开');
  for (const f of out) {
    assert.ok(f.charCount <= FRAGMENT_LIMITS.maxChars,
      `片段 ${f.index} 长 ${f.charCount} 超过上限 ${FRAGMENT_LIMITS.maxChars}`);
  }
});

test('超长单句（无标点 300 字）被降到上限以内', () => {
  const one = '没'.repeat(300); // 无任何标点
  const out = splitFragments(one);
  assert.ok(out.length >= 2);
  for (const f of out) assert.ok(f.charCount <= FRAGMENT_LIMITS.maxChars);
});

test('硬切按块数均分 → 不产生一两字的尾巴（真实语料上曾出现 18 次）', () => {
  // 301 字 / 上限 180 ⇒ 2 块 ⇒ 151 + 150，而不是 180 + 121
  for (const n of [181, 301, 362, 541]) {
    const out = splitFragments('x'.repeat(n));
    assert.ok(out.length >= 2, `${n} 字应被切开`);
    for (const f of out) {
      assert.ok(f.charCount <= FRAGMENT_LIMITS.maxChars, `${n}: 超上限`);
      assert.ok(f.charCount >= FRAGMENT_LIMITS.minChars,
        `${n} 字切出了 ${f.charCount} 字的残渣`);
    }
    assert.equal(out.reduce((s, f) => s + f.charCount, 0), n, '总量必须守恒');
  }
});

test('过短片段优先并入相邻（含队首的情形）', () => {
  // 队首就是短片段：不能因为没有前邻居就原样留下
  const out = splitFragments('好。\n这是一句足够长的正常思考内容，用来验证合并。',
    { softChars: 10, maxChars: 180, minChars: 8 });
  for (const f of out) {
    assert.ok(f.charCount >= 8, `仍有过短片段：${JSON.stringify(f.text)}`);
  }
});

test('超长句优先在次级标点处断开，而不是生硬硬切', () => {
  // 三个 80 字的逗号分句 = 240 字，超过 180 上限
  const clause = '甲'.repeat(78) + '，';
  const out = splitFragments(clause.repeat(3), { softChars: 110, maxChars: 180 });
  assert.ok(out.length >= 2);
  // 至少有一个片段是以逗号结尾的（说明在次级标点处断了）
  assert.ok(out.some((f) => f.text.endsWith('，')), '应在逗号处断开');
});

test('emoji 不因硬切被切坏（不产生孤立代理项）', () => {
  const emojiRun = '😀'.repeat(300); // 每个占 2 个 UTF-16 码元
  const out = splitFragments(emojiRun);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
  for (const f of out) {
    assert.ok(f.charCount <= FRAGMENT_LIMITS.maxChars, `长度 ${f.charCount} 超限`);
    assert.ok(!loneSurrogate.test(f.text), '出现了孤立的代理项（字符被切坏）');
  }
  assert.equal(squash(out.map((f) => f.text).join('')), squash(emojiRun), '不丢字');
});

// ───────────────────── 核心不变量：不丢字 ─────────────────────

test('不丢字：所有片段拼接后 == 归一化原文（忽略空白）', () => {
  const inputs = [
    '一句话。',
    makeSentences(30, 40),
    '第一段。\n\n第二段。\n\n\n\n第三段。',
    '前面有空白   \n\n   后面也有   ',
    '带\r\n回车换行\r\n的文本。',
  ];
  for (const input of inputs) {
    const out = splitFragments(input);
    assert.equal(
      squash(out.map((f) => f.text).join('')),
      squash(normalizeText(input)),
      `丢了字：${JSON.stringify(input.slice(0, 40))}`,
    );
  }
});

// ───────────────────── 语义完整：不切碎句子 ─────────────────────

test('正常句子全部以句末标点结尾（说明没在句中乱切）', () => {
  const out = splitFragments(makeSentences(40, 30));
  for (const f of out) {
    assert.ok(/[。！？!?；;]$/.test(f.text), `片段未以句末标点结尾：…${f.text.slice(-12)}`);
  }
});

test('标点归属前句', () => {
  // minChars 调小，否则"你好。"(4 字) 会被 minChars 规则并进下一句
  const out = splitFragments('你好。世界。', { softChars: 4, maxChars: 10, minChars: 2 });
  assert.deepEqual(out.map((f) => f.text), ['你好。', '世界。']);
});

test('空行分隔的段落是强边界 → 一律断开', () => {
  const a = '甲'.repeat(58) + '。';
  const b = '乙'.repeat(58) + '。';
  const out = splitFragments(`${a}\n\n${b}`, { softChars: 200, maxChars: 300 });
  assert.equal(out.length, 2, '段落之间不应被合并');
  assert.equal(out[0].text, a);
  assert.equal(out[1].text, b);
});

test('单换行不是强边界 → 同一段落内可打包到 softChars 附近', () => {
  const a = '甲'.repeat(28) + '。';
  const b = '乙'.repeat(28) + '。';
  const packed = splitFragments(`${a}\n${b}`, { softChars: 100, maxChars: 180 });
  assert.equal(packed.length, 1, '同一段落内的相邻行应被打包成一句，避免碎成 2~3 秒的短句');
  assert.equal(packed[0].text, a + b);

  const notPacked = splitFragments(`${a}\n${b}`, { softChars: 10, maxChars: 180, minChars: 2 });
  assert.equal(notPacked.length, 2, 'softChars 调小时应各自成句');
});

test('凑不满 minChars 的碎片并入相邻片段，而不是被丢弃', () => {
  const tiny = '嗯。';                       // 2 字，远低于 minChars
  const normal = '这是一句正常长度的思考内容。';
  const out = splitFragments(`${normal}\n${tiny}`, { softChars: 100, maxChars: 180 });
  assert.equal(out.length, 1, '过短片段应被并入，而不是单独产出');
  assert.ok(out[0].text.includes('嗯。'), '并入后内容必须还在（不丢字）');
});

// ───────────────────────── 归一化 ─────────────────────────

test('normalizeText：统一换行、折叠空行、去首尾与行尾空白', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  assert.equal(normalizeText('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeText('  a  \n  b  '), 'a\nb');
  assert.equal(normalizeText('   '), '');
  assert.equal(normalizeText(null), '');
});

test('normalizeText 不改变实义字符', () => {
  const tricky = '哦——原来 param 是必填的，难怪一直报 undefined。';
  assert.equal(squash(normalizeText(tricky)), squash(tricky));
});

// ───────────────────────── 时长折算 ─────────────────────────

test('estMs 按实测语速 22.2 字/秒折算', () => {
  assert.equal(estimateSpeechMs(222), 10000);
  assert.equal(estimateSpeechMs(0), 0);
  assert.equal(estimateSpeechMs(-5), 0);
  assert.equal(estimateSpeechMs(NaN), 0);

  const out = splitFragments(makeSentences(10, 40));
  for (const f of out) {
    assert.equal(f.estMs, Math.round((f.charCount / SPEECH_CHARS_PER_SEC) * 1000));
  }
});

test('默认参数落在「一口气念得完」的区间（≈3~8 秒）', () => {
  const softSec = FRAGMENT_LIMITS.softChars / SPEECH_CHARS_PER_SEC;
  const maxSec = FRAGMENT_LIMITS.maxChars / SPEECH_CHARS_PER_SEC;
  assert.ok(softSec > 3 && softSec < 8, `softChars 折算 ${softSec.toFixed(1)}s 不在 3~8s`);
  assert.ok(maxSec > softSec && maxSec <= 10, `maxChars 折算 ${maxSec.toFixed(1)}s 过长`);
});

// ───────────────────────── 可配置与纯度 ─────────────────────────

test('自定义参数生效', () => {
  const text = makeSentences(20, 30);
  const small = splitFragments(text, { softChars: 40, maxChars: 60 });
  const large = splitFragments(text, { softChars: 300, maxChars: 400 });
  assert.ok(small.length > large.length, 'softChars 越小片段越多');
  for (const f of small) assert.ok(f.charCount <= 60);
  for (const f of large) assert.ok(f.charCount <= 400);
});

test('纯函数：不修改入参，重复调用结果一致', () => {
  const text = makeSentences(12, 30);
  const before = JSON.stringify(text);
  const a = splitFragments(text);
  const b = splitFragments(text);
  assert.equal(JSON.stringify(text), before, '入参不得被修改');
  assert.deepEqual(a, b, '同样输入必须同样输出');
});
