/**
 * `lib/core/reasoning-language.test.js` — P3-0 领域层单测
 *
 * 守三件事：
 *   ① **语言策略的契约**（三档、默认中文、非法值不崩）
 *   ② **注入文案**（auto 必须"不注入"；中英各有一句非空约束）
 *   ③ **音色决策**：由**用户选的策略**决定，且**会话内恒定、绝不逐句切换**
 *
 * ⚠️ ③ 是用户 2026-10-11 明确修正过的口径，原实现（按检测语种逐句换音色）已被推翻。
 *    所以这里有两条测试是**反的**，别看着别扭就改回去：
 *      - 配置中文 → **即使这一句是英文也不换 Ava**
 *      - 配置英文 → **即使这一句是中文也不换 Xiaoyi**
 *    用户原话："不要出现同一个输出语言场景下，音色会变为另外一套音色的情况。"
 *
 * ⚠️ 这些用例**不碰网络、不碰 DSH**：本模块是纯逻辑，这正是它存在的意义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, VOICE_TABLE,
  createVoiceResolver, detectLang, injectionText, normalizePolicy, resolveVoice,
} from './reasoning-language.js';

// ───────────────────── ① 语言策略契约 ─────────────────────

test('语言策略就是用户拍板的「中英 + 自动」三档', () => {
  assert.deepEqual([...LANGUAGE_OPTIONS], ['auto', 'zh', 'en']);
});

test('默认语言是中文（D10 决定；不改音色默认值，否则主功能不成立）', () => {
  assert.equal(DEFAULT_LANGUAGE, 'zh');
});

test('非法策略落到默认值而不是抛异常（设置文件是用户能手改的）', () => {
  for (const bad of ['', 'jp', 'ZH', null, undefined, 42, {}, []]) {
    assert.equal(normalizePolicy(bad), DEFAULT_LANGUAGE, `${String(bad)} 应落到默认值`);
  }
  assert.equal(normalizePolicy('en'), 'en');
  assert.equal(normalizePolicy('auto'), 'auto');
});

// ───────────────────── ② 注入文案 ─────────────────────

test('auto 必须「不注入」—— 返回 null，而不是一句空话', () => {
  assert.equal(injectionText('auto'), null);
  // 未知值也当作"不注入"：宁可不改系统提示，也不要往用户提示里塞没验证过的东西
  assert.equal(injectionText('jp'), null);
  assert.equal(injectionText(undefined), null);
});

test('中英各有一句非空的最小约束，且各自要求对应语种', () => {
  const zh = injectionText('zh');
  const en = injectionText('en');
  assert.equal(typeof zh, 'string');
  assert.equal(typeof en, 'string');
  assert.ok(zh.length > 0 && en.length > 0);
  assert.match(zh, /中文/, '中文约束必须点名「中文」');
  assert.match(en, /English/i, '英文约束必须点名 English');
  // 只注入一句：约束里不得出现换行（多行 = 塞了不止一条规则）
  assert.equal(zh.includes('\n'), false);
  assert.equal(en.includes('\n'), false);
});

// ───────────────────── 语种检测（只服务日志与 auto 首判）─────────────────────

test('detectLang：纯中文 / 纯英文 / 混杂 / 判不出', () => {
  assert.equal(detectLang('这是中文'), 'zh');
  assert.equal(detectLang('hello world'), 'en');
  assert.equal(detectLang('这是中文 abcd'), 'mixed');
  assert.equal(detectLang('12345 !!!'), 'empty');
  assert.equal(detectLang(''), 'empty');
  assert.equal(detectLang(null), 'empty');
});

test('detectLang 的分母忽略标点符号', () => {
  assert.equal(detectLang('你好，世界！！！'), 'zh');
  assert.equal(detectLang('hello, world!!!'), 'en');
});

test('detectLang 容忍 { text } 形态的片段对象', () => {
  assert.equal(detectLang({ text: '这是中文' }), 'zh');
  assert.equal(detectLang({ text: 'hello' }), 'en');
  assert.equal(detectLang({ notText: 'x' }), 'empty');
});

test('detectLang 的主导线是 0.7（两侧对称）', () => {
  assert.equal(detectLang('一二三四五六七 abc'), 'zh');
  assert.equal(detectLang('一二三 abcdefg'), 'en');
  assert.equal(detectLang('一二三四 abcd'), 'mixed');
});

// ───────────────────── ③ 音色决策：按策略，不按文本 ─────────────────────

test('中文策略下**即使整句是英文**也用中文音色（用户已确认 Xiaoyi 中英都能念）', () => {
  const picked = resolveVoice('Or just ask in prose and see what happens.', 'zh');
  assert.equal(picked.voice, VOICE_TABLE.zh.voice, '不得因为这一句是英文就换 Ava');
  assert.equal(picked.pitch, VOICE_TABLE.zh.pitch);
  assert.equal(picked.lang, 'en', 'lang 仍如实回报检测结果 —— 那是给日志用的');
  assert.equal(picked.reason, 'policy-zh');
});

test('英文策略下即使整句是中文也用英文音色（Ava 是多语言，念得了）', () => {
  const picked = resolveVoice('这里应该先看日志再改代码', 'en');
  assert.equal(picked.voice, VOICE_TABLE.en.voice);
  assert.equal(picked.lang, 'zh');
  assert.equal(picked.reason, 'policy-en');
});

test('auto 策略下才看检测结果（单次决策，不粘滞）', () => {
  assert.equal(resolveVoice('这是中文', 'auto').voice, VOICE_TABLE.zh.voice);
  assert.equal(resolveVoice('this is english', 'auto').voice, VOICE_TABLE.en.voice);
  // 混合 / 判不出 → 多语言音色（中英通吃那个）
  assert.equal(resolveVoice('这里的 race condition 要小心', 'auto').voice, VOICE_TABLE.en.voice);
  assert.equal(resolveVoice('=== 42 ===', 'auto').voice, VOICE_TABLE.en.voice);
});

test('resolveVoice 从不抛异常，任何输入都返回可用的音色', () => {
  for (const text of ['', null, undefined, 123, {}, 'x'.repeat(500)]) {
    for (const policy of ['auto', 'zh', 'en', 'jp', undefined]) {
      const picked = resolveVoice(text, policy);
      assert.equal(typeof picked.voice, 'string');
      assert.ok(picked.voice.length > 0);
      assert.equal(typeof picked.pitch, 'string');
      assert.equal(typeof picked.reason, 'string');
    }
  }
});

// ───────────────────── ③ 会话内恒定（本模块最重要的一条）─────────────────────

test('★ 一场对话里音色恒定：中英混杂片段轮番来，也只出现一种音色', () => {
  // 用户明确要求："不要出现同一个输出语言场景下，音色会变为另外一套音色的情况。"
  const samples = [
    '先看看日志再改代码',
    'Wait, that assumption is wrong',
    '这里的 race condition 要小心',
    '12345 !!!',
    '',
    '还是先验证一下再说',
    'Or just ask in prose',
  ];
  for (const policy of ['zh', 'en']) {
    const voices = createVoiceResolver(policy);
    const seen = new Set(samples.map((text) => voices.resolve(text).voice));
    assert.equal(seen.size, 1, `${policy} 策略下出现了多种音色：${[...seen].join(' / ')}`);
    assert.equal([...seen][0], VOICE_TABLE[policy].voice);
  }
});

test('★ auto 策略下首判后粘滞：不会因为第二句换语种就换音色', () => {
  const voices = createVoiceResolver('auto');
  const first = voices.resolve('这是中文的一句思考');
  assert.equal(first.reason, 'auto-locked-zh');
  assert.equal(first.voice, VOICE_TABLE.zh.voice);

  // 第二句漂成英文 —— 不得换音色
  const second = voices.resolve('Wait, that is wrong');
  assert.equal(second.voice, VOICE_TABLE.zh.voice, 'auto 锁定后必须粘滞');
  assert.equal(second.reason, 'auto-sticky-zh');
  assert.equal(voices.state().locked, 'zh');
});

test('auto 首次若判出英文，就锁英文音色', () => {
  const voices = createVoiceResolver('auto');
  assert.equal(voices.resolve('this is english').reason, 'auto-locked-en');
  assert.equal(voices.resolve('这是中文').voice, VOICE_TABLE.en.voice, '锁定后不因中文片段改回 Xiaoyi');
});

test('auto 首句判不出（纯符号）→ 落到多语言音色并锁定', () => {
  const voices = createVoiceResolver('auto');
  const picked = voices.resolve('=== 42 ===');
  assert.equal(picked.voice, VOICE_TABLE.en.voice);
  assert.equal(voices.state().locked, 'en');
});

test('用户改设置 → 音色立刻跟随（R5 的同一条链路）', () => {
  const voices = createVoiceResolver('zh');
  assert.equal(voices.resolve('任意文本').voice, VOICE_TABLE.zh.voice);

  assert.equal(voices.setPolicy('en'), true, '策略真的变了要返回 true');
  assert.equal(voices.resolve('任意文本').voice, VOICE_TABLE.en.voice, '音色必须立刻跟随');

  assert.equal(voices.setPolicy('en'), false, '没变就该返回 false');
});

test('从 auto 切到 zh 再切回 auto：锁定状态必须清掉（否则"改了设置没反应"）', () => {
  const voices = createVoiceResolver('auto');
  voices.resolve('this is english');          // 锁 en
  voices.setPolicy('zh');
  voices.setPolicy('auto');
  assert.equal(voices.state().locked, null, '切进 auto 时旧锁定必须作废');

  const picked = voices.resolve('这是中文');   // 重新首判 → 应锁 zh
  assert.equal(picked.reason, 'auto-locked-zh');
  assert.equal(picked.voice, VOICE_TABLE.zh.voice);
});

test('非法策略进 resolver 也落到默认值，不崩', () => {
  const voices = createVoiceResolver('jp');
  assert.equal(voices.policy(), DEFAULT_LANGUAGE);
  assert.equal(voices.resolve('x').voice, VOICE_TABLE.zh.voice);
});

test('音色表两条都有 voice + pitch，且都是本项目定稿的音色', () => {
  assert.deepEqual(Object.keys(VOICE_TABLE).sort(), ['en', 'zh']);
  for (const key of ['zh', 'en']) {
    assert.equal(typeof VOICE_TABLE[key].voice, 'string', `${key}.voice`);
    assert.equal(typeof VOICE_TABLE[key].pitch, 'string', `${key}.pitch`);
  }
  assert.equal(VOICE_TABLE.zh.voice, 'zh-CN-XiaoyiNeural');
  assert.equal(VOICE_TABLE.en.voice, 'en-US-AvaMultilingualNeural');
});
