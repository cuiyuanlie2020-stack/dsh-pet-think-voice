/**
 * `lib/settings.test.js` — 共享设置存档单测
 *
 * 重点守 **D13 的真机结论**：*内容没变就不该算一次写入*。
 * 少了这条，"把一模一样的值再写一遍"会推进 `rev`；而前端每轮重渲染都会无条件落盘
 * 一次（`saveOutfit` 不管变没变都 POST），另一个窗口的 3 秒轮询一发现 rev 变了就
 * apply → 重渲染 → 再落盘 ⇒ **活锁**。
 * 实测（web profile，页面开着 5 分钟）：内容一个字没变，rev 从 1008 涨到 1084，
 * 磁盘每 3~4 秒被写一次 —— 违反 R1。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SETTINGS_KEYS, readSettings, settingsPath, writeSettings } from './settings.js';

/** 每个用例一个干净目录：存档是**文件**状态，共用一个目录会互相污染。 */
const withHome = (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-settings-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test('空存档：每个键都是 null，rev 从 0 开始', () => {
  withHome((home) => {
    const saved = readSettings(home);
    assert.equal(saved.rev, 0);
    for (const key of SETTINGS_KEYS) assert.equal(saved[key], null, `${key} 应为 null`);
  });
});

test('首次写入：落盘并推进 rev', () => {
  withHome((home) => {
    const written = writeSettings(home, { tuning: { bubbleHoldMs: 4200 } });
    assert.equal(written.rev, 1);
    assert.deepEqual(written.tuning, { bubbleHoldMs: 4200 });
    assert.ok(existsSync(settingsPath(home)), '应该真的落盘了');
    assert.equal(readSettings(home).rev, 1);
  });
});

test('🔴 D13 回归：内容一模一样 → 不推进 rev（推了就是活锁）', () => {
  withHome((home) => {
    const first = writeSettings(home, { speech: { language: 'zh', intervalMs: 15000 } });
    assert.equal(first.rev, 1);

    // 把**同一份内容**再写两遍 —— 这正是前端每轮重渲染会做的事
    assert.equal(
      writeSettings(home, { speech: { language: 'zh', intervalMs: 15000 } }).rev, 1,
    );
    assert.equal(
      writeSettings(home, { speech: { language: 'zh', intervalMs: 15000 } }).rev, 1,
    );
    assert.equal(readSettings(home).rev, 1, '落盘次数不该随"空写"增长');
  });
});

test('内容真变了才推进（含嵌套里只改一个字段）', () => {
  withHome((home) => {
    writeSettings(home, { speech: { language: 'zh', intervalMs: 15000 } });
    const changed = writeSettings(home, { speech: { language: 'zh', intervalMs: 20000 } });
    assert.equal(changed.rev, 2, '嵌套里改了一个字段必须算变（浅比较会丢数据）');
    assert.equal(changed.speech.intervalMs, 20000);
  });
});

test('混写：一项变了、一项没变 → 只推进一次，没变的那项保持', () => {
  withHome((home) => {
    writeSettings(home, { tuning: { gazeRangePx: 220 }, outfit: {} });
    const mixed = writeSettings(home, { tuning: { gazeRangePx: 220 }, outfit: { hair: '双马尾' } });
    assert.equal(mixed.rev, 2, '有任意一项真变了就推进，且只推进一次');
    assert.deepEqual(mixed.tuning, { gazeRangePx: 220 });
    assert.deepEqual(mixed.outfit, { hair: '双马尾' });
  });
});

test('空写（只带 rev / 什么都不带 / 显式 null）不推进 —— 旧的防回环守卫仍在', () => {
  withHome((home) => {
    writeSettings(home, { tuning: { gazeRangePx: 220 } });
    assert.equal(writeSettings(home, { rev: 99 }).rev, 1);
    assert.equal(writeSettings(home, {}).rev, 1);
    assert.equal(writeSettings(home, { tuning: null }).rev, 1, '显式 null = 不动这一项');
  });
});

test('坏值不传染：非对象 / 数组 / 手改坏的文件都被挡在外面', () => {
  withHome((home) => {
    writeSettings(home, { tuning: { gazeRangePx: 220 } });
    assert.equal(writeSettings(home, { tuning: 'not-an-object' }).rev, 1);
    assert.equal(writeSettings(home, { tuning: [1, 2, 3] }).rev, 1);

    // 手改坏存档：读回时回落到空档，而不是把坏值传给页面
    writeFileSync(settingsPath(home), '{ 这不是 JSON');
    const after = readSettings(home);
    assert.equal(after.rev, 0);
    assert.equal(after.tuning, null);
  });
});
