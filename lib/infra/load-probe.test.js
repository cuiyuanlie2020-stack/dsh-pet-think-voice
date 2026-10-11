/**
 * `lib/infra/load-probe.test.js` — P3-5 采样层单测
 *
 * **不调真的 `nvidia-smi`**（那台机器有没有、什么版本都不该影响测试）：
 * 用 `process.execPath`（就是 node 自己）当"命令"，让它打印想要的数字。
 * 这样连"输出不是数字""命令不存在"这两条分支都能稳定复现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLoadProbe } from './load-probe.js';

/** 造一个"假的 GPU 命令"：让 node 自己打印 `text` */
const nodePrints = (text) => ({
  gpuCommand: process.execPath,
  gpuArgs: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
});

test('CPU 第一次采样没有参照 → 返回 0（而不是瞎报一个数）', async () => {
  const probe = createLoadProbe(nodePrints('0'));
  assert.equal((await probe.read()).cpu, 0);
});

test('CPU 第二次起给出 0..1 之间的占用率', async () => {
  const probe = createLoadProbe(nodePrints('0'));
  await probe.read();
  // 制造一点可观测的 CPU 活动，免得 "0..1" 这条断言空过
  const spinUntil = Date.now() + 60;
  while (Date.now() < spinUntil) { /* busy wait */ }
  const sample = await probe.read();
  assert.equal(typeof sample.cpu, 'number');
  assert.ok(sample.cpu >= 0 && sample.cpu <= 1, `cpu=${sample.cpu} 越界`);
  assert.ok(sample.cpu > 0, '忙等之后不该还是 0');
});

test('GPU：百分比能解析成 0..1', async () => {
  const probe = createLoadProbe(nodePrints('37\n'));
  assert.equal((await probe.read()).gpu, 0.37);
});

test('GPU：多卡只看第一张（目标是"别跟主力负载抢"）', async () => {
  const probe = createLoadProbe(nodePrints('12\n98\n'));
  assert.equal((await probe.read()).gpu, 0.12);
});

test('GPU：命令不存在 → null，且标记为不可用', async () => {
  const probe = createLoadProbe({ gpuCommand: '__think_voice_no_such_command__' });
  const sample = await probe.read();
  assert.equal(sample.gpu, null);
  assert.equal(sample.cpu !== null, true, 'GPU 挂了不该连带 CPU');
  assert.equal(probe.gpuAvailable(), false, '要记住它不可用，否则每 10s 白起一个进程');
});

test('GPU：输出不是数字 → null，但**不**标记不可用（命令本身是好的）', async () => {
  const probe = createLoadProbe(nodePrints('N/A'));
  assert.equal((await probe.read()).gpu, null);
  assert.equal(probe.gpuAvailable(), true, '命令能跑，只是这次没给出数字');
});

test('GPU：超范围的值会被夹回 0..1', async () => {
  const probe = createLoadProbe(nodePrints('180'));
  assert.equal((await probe.read()).gpu, 1);
});

test('read() 永不抛 —— 探针挂掉不该让宠物闭嘴', async () => {
  const probe = createLoadProbe({ gpuCommand: '__think_voice_no_such_command__' });
  await assert.doesNotReject(() => probe.read());
});

test('reset() 能清掉"GPU 不可用"的记忆（换了机器/装了驱动之后）', async () => {
  const probe = createLoadProbe({ gpuCommand: '__think_voice_no_such_command__' });
  await probe.read();
  assert.equal(probe.gpuAvailable(), false);
  probe.reset();
  assert.equal(probe.gpuAvailable(), true);
});
