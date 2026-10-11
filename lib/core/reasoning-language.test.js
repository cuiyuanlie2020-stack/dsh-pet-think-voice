/**
 * `lib/core/reasoning-language.test.js` — P3-0 领域层单测
 *
 * 守三件事：
 *   ① **语言策略的契约**（三档、默认中文、非法值不崩）
 *   ② **注入文案**（auto 必须"不注入"；中英各有一句非空约束）
 *   ③ **音色的决策顺序** —— 尤其是那条**反直觉的取舍**：
 *      「检测说了算，配置只兜底」。这条一旦被改回"按配置选音色"，
 *      `zh-CN-XiaoyiNeural` 就会念起英文来（D10 的原始故障），必须有测试拦住。
 *
 * ⚠️ 这些用例**不碰网络、不碰 DSH**：本模块是纯逻辑，这正是它存在的意义
 *    （DESIGN §4.3：`lib/core/` 必须能脱离宿主单独跑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, VOICE_TABLE,
  detectLang, injectionText, normalizePolicy, resolveVoice,
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

// ───────────────────── ③ 语种检测口径 ─────────────────────

test('detectLang：纯中文 / 纯英文 / 混杂 / 判不出', () => {
  assert.equal(detectLang('这是中文'), 'zh');
  assert.equal(detectLang('hello world'), 'en');
  assert.equal(detectLang('这是中文 abcd'), 'mixed');
  assert.equal(detectLang('12345 !!!'), 'empty');
  assert.equal(detectLang(''), 'empty');
  assert.equal(detectLang(null), 'empty');
});

test('detectLang 的分母忽略标点符号（标点多少与选音色无关）', () => {
  // 中文标点/空格/感叹号不该把一条中文稀释成 mixed
  assert.equal(detectLang('你好，世界！！！'), 'zh');
  assert.equal(detectLang('hello, world!!!'), 'en');
});

test('detectLang 容忍 { text } 形态的片段对象', () => {
  assert.equal(detectLang({ text: '这是中文' }), 'zh');
  assert.equal(detectLang({ text: 'hello' }), 'en');
  assert.equal(detectLang({ notText: 'x' }), 'empty');
});

test('detectLang 的主导线是 0.7（两侧对称）', () => {
  // 7 汉字 : 3 字母 = 0.7 → 刚好算中文
  assert.equal(detectLang('一二三四五六七 abc'), 'zh');
  // 3 汉字 : 7 字母 = 0.3 → 刚好算英文
  assert.equal(detectLang('一二三 abcdefg'), 'en');
  // 4 : 4 = 0.5 → 谁都不是主导
  assert.equal(detectLang('一二三四 abcd'), 'mixed');
});

// ───────────────────── ③ 音色决策（本模块的核心取舍）─────────────────────

test('检测到的语种说了算：配置中文但片段是英文 → 换英文音色（不许用中文音色念英文）', () => {
  const picked = resolveVoice('Or just ask in prose and see what happens.', 'zh');
  assert.equal(picked.lang, 'en');
  assert.equal(picked.voice, VOICE_TABLE.en.voice);
  assert.notEqual(picked.voice, VOICE_TABLE.zh.voice, '宁可不跟配置，也不能让中文音色念英文');
  assert.equal(picked.reason, 'detected-config-mismatch', 'reason 要能诊断「注入漂了」');
});

test('配置与检测一致时用该语种音色，并标成 match', () => {
  const zh = resolveVoice('这里应该先看日志再改代码', 'zh');
  assert.equal(zh.voice, VOICE_TABLE.zh.voice);
  assert.equal(zh.pitch, VOICE_TABLE.zh.pitch);
  assert.equal(zh.reason, 'detected-config-match');

  const en = resolveVoice('Wait, that assumption is wrong', 'en');
  assert.equal(en.voice, VOICE_TABLE.en.voice);
  assert.equal(en.reason, 'detected-config-match');
});

test('auto 策略下纯检测驱动（不注入、也不假装有配置）', () => {
  assert.equal(resolveVoice('这是中文', 'auto').reason, 'detected-auto');
  assert.equal(resolveVoice('this is english', 'auto').voice, VOICE_TABLE.en.voice);
});

test('中英混杂 → 退到多语言音色（单语种念另一种会走音）', () => {
  const picked = resolveVoice('这里的 race condition 要小心', 'zh');
  assert.equal(picked.lang, 'mixed');
  assert.equal(picked.voice, VOICE_TABLE.multi.voice);
  assert.equal(picked.reason, 'mixed-multilingual');
});

test('判不出语种时用配置兜底；auto 时用多语言音色', () => {
  const configured = resolveVoice('=== 42 ===', 'zh');
  assert.equal(configured.voice, VOICE_TABLE.zh.voice);
  assert.equal(configured.reason, 'fallback-config');

  const auto = resolveVoice('=== 42 ===', 'auto');
  assert.equal(auto.voice, VOICE_TABLE.multi.voice);
  assert.equal(auto.reason, 'fallback-multilingual');
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

test('音色表三条都有 voice + pitch（换音色时别漏字段）', () => {
  for (const key of ['zh', 'en', 'multi']) {
    assert.equal(typeof VOICE_TABLE[key].voice, 'string', `${key}.voice`);
    assert.equal(typeof VOICE_TABLE[key].pitch, 'string', `${key}.pitch`);
  }
  assert.match(VOICE_TABLE.zh.voice, /^zh-CN-/, '中文音色必须是中文族');
});
