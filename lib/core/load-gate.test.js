/**
 * `lib/core/load-gate.test.js` — P3-5 负载闸判定单测
 *
 * 全部用**假时钟**，不真去把 CPU 跑满 —— 这正是把判定拆成纯逻辑的目的。
 *
 * 守两件事：
 *   ① 「持续」真的是持续（抖一下不闭嘴、回落也要防抖）
 *   ② 样本残缺时**不误判**（GPU 拿不到 ≠ GPU 满了；采样失败不该让宠物闭嘴）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS, createLoadGate } from './load-gate.js';

const T0 = 1_700_000_000_000;

test('默认阈值就是 D7 那套（CPU/GPU 50% · 持续 10s）', () => {
  assert.equal(DEFAULT_LIMITS.cpu, 0.5);
  assert.equal(DEFAULT_LIMITS.gpu, 0.5);
  assert.equal(DEFAULT_LIMITS.sustainMs, 10_000);
});

test('低负载：一直不静默', () => {
  const gate = createLoadGate();
  for (let i = 0; i < 20; i += 1) {
    const state = gate.judge({ cpu: 0.1, gpu: 0.05 }, T0 + i * 10_000);
    assert.equal(state.silent, false);
    assert.equal(state.changed, false);
    assert.equal(state.reason, 'ok');
  }
});

test('★ 「持续」才算数：瞬间冲高不闭嘴', () => {
  const gate = createLoadGate();
  // 第一次超阈值只是开始计时
  assert.equal(gate.judge({ cpu: 0.9 }, T0).silent, false);
  // 还没到 10s
  assert.equal(gate.judge({ cpu: 0.9 }, T0 + 9_000).silent, false, '9s 还不到');
  // 到 10s 才翻转，且这一次要报 changed
  const flipped = gate.judge({ cpu: 0.9 }, T0 + 10_000);
  assert.equal(flipped.silent, true);
  assert.equal(flipped.changed, true, '状态翻转必须报 changed —— 调用方靠它打日志');
  assert.equal(flipped.reason, 'cpu');
});

test('中途回落会重新计时（防"编译时抖一下"）', () => {
  const gate = createLoadGate();
  gate.judge({ cpu: 0.9 }, T0);
  gate.judge({ cpu: 0.1 }, T0 + 5_000);          // 掉下来了 → 计时清零
  gate.judge({ cpu: 0.9 }, T0 + 8_000);          // 重新开始计时
  assert.equal(gate.judge({ cpu: 0.9 }, T0 + 15_000).silent, false, '只持续了 7s，不该闭嘴');
  assert.equal(gate.judge({ cpu: 0.9 }, T0 + 18_000).silent, true, '到 10s 了，该闭嘴');
});

test('★ 恢复也要防抖：回落没满 recoverMs 之前一直闭嘴', () => {
  const gate = createLoadGate();
  gate.judge({ cpu: 0.9 }, T0);
  assert.equal(gate.judge({ cpu: 0.9 }, T0 + 10_000).silent, true);

  assert.equal(gate.judge({ cpu: 0.1 }, T0 + 20_000).silent, true, '刚回落，先不急着开');
  assert.equal(gate.judge({ cpu: 0.1 }, T0 + 29_000).silent, true, '9s 还不到');
  const back = gate.judge({ cpu: 0.1 }, T0 + 30_000);
  assert.equal(back.silent, false);
  assert.equal(back.changed, true);
  assert.equal(back.reason, 'recovered');
});

test('静默期间又冲高 → 恢复计时清零，别提前开', () => {
  const gate = createLoadGate();
  gate.judge({ cpu: 0.9 }, T0);
  gate.judge({ cpu: 0.9 }, T0 + 10_000);
  assert.equal(gate.silent(), true);

  gate.judge({ cpu: 0.1 }, T0 + 12_000);   // 开始恢复计时
  gate.judge({ cpu: 0.9 }, T0 + 15_000);   // 又高 → 清零
  assert.equal(gate.judge({ cpu: 0.1 }, T0 + 20_000).silent, true, '恢复计时被清零，现在只过了 5s');
});

test('★ GPU 拿不到（null）不算踩线，也不会因此恢复或静默', () => {
  const gate = createLoadGate();
  // 只有 cpu 这条线可用
  assert.equal(gate.judge({ cpu: 0.1, gpu: null }, T0).silent, false);
  assert.equal(gate.judge({ cpu: 0.9, gpu: null }, T0 + 1_000).silent, false);
  assert.equal(gate.judge({ cpu: 0.9, gpu: null }, T0 + 11_000).silent, true, 'CPU 单独也能触发');

  // 反向：GPU 单独超阈值也要能触发
  const gpuOnly = createLoadGate();
  gpuOnly.judge({ cpu: 0.05, gpu: 0.95 }, T0);
  const flipped = gpuOnly.judge({ cpu: 0.05, gpu: 0.95 }, T0 + 10_000);
  assert.equal(flipped.silent, true);
  assert.equal(flipped.reason, 'gpu');
});

test('样本残缺（null / 空对象 / 非数字）不崩、不误判过载', () => {
  const gate = createLoadGate();
  for (const sample of [null, undefined, {}, { cpu: null }, { cpu: 'x' }, { cpu: NaN }, 42]) {
    const state = gate.judge(sample, T0);
    assert.equal(state.silent, false, `${JSON.stringify(sample)} 不该被判成过载`);
    assert.equal(state.cpu, null);
    assert.equal(state.gpu, null);
  }
});

test('changed 只在翻转时为 true（否则日志会被刷屏）', () => {
  const gate = createLoadGate();
  const changes = [];
  for (let i = 0; i <= 30; i += 1) {
    const state = gate.judge({ cpu: 0.9 }, T0 + i * 1_000);
    if (state.changed) changes.push(i);
  }
  assert.deepEqual(changes, [10], '30 秒里只该翻转一次');
});

test('阈值可配（低配机想把线画低一点）', () => {
  const gate = createLoadGate({ limits: { cpu: 0.2, sustainMs: 1_000 } });
  assert.equal(gate.limits.cpu, 0.2);
  assert.equal(gate.judge({ cpu: 0.3 }, T0).silent, false);
  assert.equal(gate.judge({ cpu: 0.3 }, T0 + 1_000).silent, true);
  // 0.3 在默认阈值(0.5)下不会触发 —— 证明配置真的生效了
  const standard = createLoadGate();
  standard.judge({ cpu: 0.3 }, T0);
  assert.equal(standard.judge({ cpu: 0.3 }, T0 + 1_000).silent, false);
});

test('正好等于阈值算踩线（>= 而不是 >）', () => {
  const gate = createLoadGate({ limits: { sustainMs: 0 } });
  assert.equal(gate.judge({ cpu: 0.5 }, T0).silent, true);
});
