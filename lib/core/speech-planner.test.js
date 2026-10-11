/**
 * `lib/core/speech-planner.test.js` — P2-5 单测
 *
 * 时钟全部由参数注入（`now`），**不 sleep** —— 所以整套测试是毫秒级的、必定的。
 * 若哪天有人往 planner 里塞了 `Date.now()`，这些用例会立刻暴露。
 *
 * ⚠️ 必须能脱离 DSH / 浏览器单独跑：把 `lib/core/` 拷到空目录，`node --test` 全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEECH_INTERVAL_MS,
  createSpeechPlanner,
  isNearDuplicate,
  normalizeForDedupe,
  similarity,
} from './speech-planner.js';

const T0 = 1_000_000; // 任意起点，不用真实时间

// ───────────────────── 频率闸：D3 定的 20s ─────────────────────

test('D3：20s 内最多放行 1 句', () => {
  const p = createSpeechPlanner();
  assert.equal(SPEECH_INTERVAL_MS, 20_000, '默认间隔必须是 D3 定稿的 20s');

  p.submit({ text: '第一句要念的话。', score: 0.6 }, T0);
  p.submit({ text: '第二句完全不同的话。', score: 0.7 }, T0);

  const first = p.next(T0);
  assert.ok(first, '第一条应立即放行');

  assert.equal(p.next(T0 + 1), null, '1ms 后不得再放');
  assert.equal(p.next(T0 + 19_999), null, '差 1ms 也不行');
  assert.equal(p.stats().pending, 1, '第二条仍在队列里等着，没被丢掉');
});

test('D3：恰好满 20s 就能放行下一条', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '第一句要念的话。', score: 0.6 }, T0);
  p.submit({ text: '第二句完全不同的话。', score: 0.7 }, T0);

  // 队列按**分数**出队，不是 FIFO —— 先念最值得念的那句
  const first = p.next(T0);
  assert.equal(first.text, '第二句完全不同的话。', '应先念分高的');
  assert.equal(p.next(T0 + 19_999), null);
  const second = p.next(T0 + 20_000);
  assert.equal(second.text, '第一句要念的话。', '到点放行剩下那条');
});

test('D3：20s 内两条候选只放一条、另一条仍在队列里', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '第一条候选内容。', score: 0.5 }, T0);
  p.submit({ text: '第二条候选内容。', score: 0.5 }, T0);
  assert.ok(p.next(T0));
  assert.equal(p.next(T0 + 10_000), null);
  assert.equal(p.stats().pending, 1, '被闸住的那条不能消失');
});

test('频率闸可配置（便于 P4 调参 / P3-5 负载档）', () => {
  const p = createSpeechPlanner({ minIntervalMs: 1000 });
  p.submit({ text: '甲句内容在这里。', score: 0.5 }, T0);
  p.submit({ text: '乙句内容在这里。', score: 0.5 }, T0);
  assert.ok(p.next(T0));
  assert.equal(p.next(T0 + 999), null);
  assert.ok(p.next(T0 + 1000));
});

test('队列空时不放行，也不推进冷却', () => {
  const p = createSpeechPlanner();
  assert.equal(p.next(T0), null);
  p.submit({ text: '唯一的一句内容。', score: 0.5 }, T0);
  assert.ok(p.next(T0), '第一条应立即放行（不应被"空队列"那次调用拖住）');
});

// ───────────────────── 去重闸 ─────────────────────

test('完全相同的文本被拒', () => {
  const p = createSpeechPlanner();
  const a = p.submit({ text: '这句话一模一样。', score: 0.6 }, T0);
  const b = p.submit({ text: '这句话一模一样。', score: 0.9 }, T0);
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, false);
  assert.match(b.reason, /队列/);
});

test('归一化后相同也算重复（标点/空白/大小写差异不算新句）', () => {
  const p = createSpeechPlanner();
  p.submit({ text: 'Hmm, this looks wrong.', score: 0.6 }, T0);
  const dup = p.submit({ text: 'hmm this   looks wrong', score: 0.9 }, T0);
  assert.equal(dup.accepted, false, '归一化后应判为同一句');
});

test('念过的句子不再接受（判重记忆）', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '会念出去的一句话。', score: 0.6 }, T0);
  assert.ok(p.next(T0));
  const again = p.submit({ text: '会念出去的一句话。', score: 0.99 }, T0 + 30_000);
  assert.equal(again.accepted, false);
  assert.equal(again.reason, '已念过');
});

test('高度相似（只差几个字）也算重复', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '这个参数顺序好像不太对，我再确认一下。', score: 0.6 }, T0);
  const near = p.submit({ text: '这个参数顺序好像不太对，我再确认一下试试。', score: 0.6 }, T0);
  assert.equal(near.accepted, false, `相似度 ${similarity('这个参数顺序好像不太对，我再确认一下。', '这个参数顺序好像不太对，我再确认一下试试。').toFixed(3)} 应判为重复`);
});

test('isNearDuplicate：包含关系也算重复（bigram 相似度对"原句+尾巴"不够敏感）', () => {
  // 实测这对 Jaccard 只有 0.889，纯靠相似度阈值会漏判 —— 靠"包含"挡住
  assert.equal(isNearDuplicate('这个参数顺序好像不太对，我再确认一下。',
    '这个参数顺序好像不太对，我再确认一下试试。'), true);
  assert.equal(isNearDuplicate('这个参数顺序好像不太对', '这个参数顺序好像不太对，我再确认一下'), true);
  // 太短的不做包含判定，避免"问题"被当成"这个问题在哪"的重复
  assert.equal(isNearDuplicate('问题', '这个问题出在参数顺序上'), false);
  // 明显不同的不误判
  assert.equal(isNearDuplicate('先看看这个文件里写了什么。', 'Hmm, the regex matches too much.'), false);
});

test('真正不同的话照常接受', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '先看看这个文件里到底写了什么。', score: 0.6 }, T0);
  const other = p.submit({ text: 'Hmm, the regex is matching too much.', score: 0.6 }, T0);
  assert.equal(other.accepted, true);
});

test('相似度函数本身的边界', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('abc', ''), 0);
  assert.equal(similarity('完全不同的句子内容', 'xyz'), 0);
  assert.ok(similarity('参数顺序不对', '参数顺序不太对') > 0.5);
});

test('normalizeForDedupe：去空白、去标点、统一小写', () => {
  assert.equal(normalizeForDedupe(' Hmm, it  is wrong. '), 'hmmitiswrong');
  assert.equal(normalizeForDedupe('参数顺序，不对！'), '参数顺序不对');
  assert.equal(normalizeForDedupe(null), '');
});

// ───────────────────── 排队：溢出丢最差的 ─────────────────────

test('队列满了丢**最低分**的，而不是丢最新来的', () => {
  const p = createSpeechPlanner({ maxQueue: 2, minIntervalMs: 0 });
  p.submit({ text: '平淡的一句内容。', score: 0.2 }, T0);
  p.submit({ text: '一般般的一句内容。', score: 0.5 }, T0);
  // 新来的是高分句：应挤掉 0.2 那条
  const r = p.submit({ text: '特别有意思的一句！', score: 0.9 }, T0);
  assert.equal(r.accepted, true);

  assert.equal(p.stats().pending, 2);
  assert.equal(p.next(T0).text, '特别有意思的一句！');
  assert.equal(p.next(T0).text, '一般般的一句内容。');
  assert.equal(p.next(T0), null, '0.2 那条已被淘汰');
});

test('队列满且新条目不更高时，拒绝新条目（保护已有的高分句）', () => {
  const p = createSpeechPlanner({ maxQueue: 2 });
  p.submit({ text: '高分的一句内容在这里。', score: 0.9 }, T0);
  p.submit({ text: '另一个高分内容在这里。', score: 0.8 }, T0);
  const low = p.submit({ text: '低分的废话一句在这里。', score: 0.1 }, T0);
  assert.equal(low.accepted, false);
  assert.match(low.reason, /分数不更高/);
  assert.equal(p.stats().pending, 2);
});

test('队列里取分数最高的先念', () => {
  const p = createSpeechPlanner({ maxQueue: 5, minIntervalMs: 0 });
  p.submit({ text: '低分内容一。', score: 0.2 }, T0);
  p.submit({ text: '高分内容二。', score: 0.95 }, T0);
  p.submit({ text: '中分内容三。', score: 0.5 }, T0);
  assert.equal(p.next(T0).text, '高分内容二。');
  assert.equal(p.next(T0).text, '中分内容三。');
  assert.equal(p.next(T0).text, '低分内容一。');
  assert.equal(p.next(T0), null);
});

test('同分时先入队者先出（稳定）', () => {
  const p = createSpeechPlanner({ maxQueue: 5, minIntervalMs: 0 });
  p.submit({ text: '同分内容甲。', score: 0.5 }, T0);
  p.submit({ text: '同分内容乙。', score: 0.5 }, T0);
  assert.equal(p.next(T0).text, '同分内容甲。');
});

// ───────────────────── 健壮性与可观测 ─────────────────────

test('空/非法候选被拒，且不抛错', () => {
  const p = createSpeechPlanner();
  for (const bad of [null, undefined, {}, { text: '' }, { text: '   ' }, { text: 123 }]) {
    const r = p.submit(bad, T0);
    assert.equal(r.accepted, false);
    assert.equal(typeof r.reason, 'string');
  }
});

test('score 缺失/非数值时按 0 处理，不抛错', () => {
  const p = createSpeechPlanner();
  const r = p.submit({ text: '没有分数的一句话。' }, T0);
  assert.equal(r.accepted, true);
  assert.equal(p.next(T0).score, 0);
});

test('cooldownRemaining / etaForNext 反映还有多久', () => {
  const p = createSpeechPlanner();
  assert.equal(p.cooldownRemaining(T0), 0, '还没念过 → 无冷却');
  assert.equal(p.etaForNext(T0), null, '队列空 → 没有 ETA');

  p.submit({ text: '要被念的一句内容。', score: 0.5 }, T0);
  assert.equal(p.etaForNext(T0), 0);
  assert.ok(p.next(T0));
  assert.equal(p.cooldownRemaining(T0 + 5_000), 15_000);
  assert.equal(p.cooldownRemaining(T0 + 25_000), 0, '冷却不能为负');

  p.submit({ text: '后面还有一句内容。', score: 0.5 }, T0 + 5_000);
  assert.equal(p.etaForNext(T0 + 5_000), 15_000);
});

test('reset 清空队列与判重记忆；clearQueue 只清队列', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '会被念出去的一句。', score: 0.5 }, T0);
  assert.ok(p.next(T0));

  p.submit({ text: '排在后面的一句内容。', score: 0.5 }, T0);
  p.clearQueue();
  assert.equal(p.stats().pending, 0, 'clearQueue 应清空队列');
  assert.equal(p.submit({ text: '会被念出去的一句。', score: 0.5 }, T0).accepted, false,
    'clearQueue 不该忘掉"念过什么"，否则恢复后会重复念');

  p.reset();
  assert.equal(p.submit({ text: '会被念出去的一句。', score: 0.5 }, T0).accepted, true,
    'reset 之后记忆清空');
  assert.equal(p.stats().spoken, 0);
});

test('stats 只观测、不影响决策', () => {
  const p = createSpeechPlanner({ maxQueue: 1 });
  p.submit({ text: '第一条内容在这里。', score: 0.5 }, T0);
  p.submit({ text: '第二条内容在这里。', score: 0.1 }, T0); // 被拒
  const s = p.stats();
  assert.equal(s.pending, 1);
  assert.equal(s.spoken, 0);
  assert.equal(s.dropped, 1);
  assert.equal(s.lastSpokenAt, null);
});

test('确定性：同一串操作 → 完全一样的输出（不依赖真实时钟/随机）', () => {
  const run = () => {
    const p = createSpeechPlanner();
    const out = [];
    const inputs = [
      ['甲句要念的内容在这里。', 0.4], ['乙句完全不同的内容。', 0.7],
      ['丙句又是另外的内容。', 0.6], ['甲句要念的内容在这里。', 0.9],
    ];
    for (const [text, sco] of inputs) p.submit({ text, score: sco }, T0);
    for (const t of [T0, T0 + 1_000, T0 + 20_000, T0 + 40_000]) {
      const task = p.next(t);
      out.push(task ? task.text : null);
    }
    return out;
  };
  assert.deepEqual(run(), run());
});

// ───────────────────── 无损换档 setMinInterval（P4-5）─────────────────────

test('setMinInterval：调小后立刻按新间隔放行（不用等满旧的 20s）', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '第一句要念的内容在这里。', score: 0.6 }, T0);
  p.submit({ text: '第二句话跟前面完全不同。', score: 0.9 }, T0);
  assert.equal(p.next(T0).text, '第二句话跟前面完全不同。', 'T0 放行分数最高的那条');
  assert.equal(p.next(T0 + 5_000), null, '默认 20s 闸：5s 时还不到点');

  assert.equal(p.setMinInterval(5_000), true, '换档应报告"真的变了"');
  assert.equal(p.next(T0 + 5_000).text, '第一句要念的内容在这里。', '换完立刻可放');
});

test('setMinInterval：换档**无损** —— 队列与判重记忆都留着', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '念过一次的这一句内容。', score: 0.5 }, T0);
  assert.equal(p.next(T0).text, '念过一次的这一句内容。');
  p.submit({ text: '排在队里的另一句内容。', score: 0.7 }, T0);
  assert.equal(p.stats().pending, 1, '换档前队列里有一条');

  p.setMinInterval(30_000);

  assert.equal(p.stats().pending, 1, '换档不该清空队列（清了就是"调个节奏把宠物弄结巴"）');
  assert.equal(
    p.submit({ text: '念过一次的这一句内容。', score: 0.9 }, T0).reason, '已念过',
    '判重记忆也必须留着',
  );
  assert.equal(p.next(T0 + 20_000), null, '新间隔是 30s，20s 时还不到点');
  assert.equal(p.next(T0 + 30_000).text, '排在队里的另一句内容。');
});

test('setMinInterval：调大后要等更久；非法值与同值都是一次 no-op', () => {
  const p = createSpeechPlanner();
  assert.equal(p.setMinInterval(0), false, '0 不是合法间隔');
  assert.equal(p.setMinInterval(-1), false);
  assert.equal(p.setMinInterval(Number.NaN), false);
  assert.equal(p.setMinInterval(SPEECH_INTERVAL_MS), false, '与现值相同 = 没变');

  // ⚠️ 先念一条把 `lastSpokenAt` 建起来：**从未念过时 `lastSpokenAt` 是 `-Infinity`**，
  //    于是"距上次朗读"是无穷大、随时可放 —— 间隔闸根本不参与。
  //    （这正是上面那个"调小立刻可放"用例要先放一条的原因，同一个既有语义。）
  p.submit({ text: '先把闸门的时间基准打上吧。', score: 0.5 }, T0);
  assert.equal(p.next(T0).text, '先把闸门的时间基准打上吧。');

  assert.equal(p.setMinInterval(45_000), true);
  p.submit({ text: '换档之后要念的这一句。', score: 0.8 }, T0);
  assert.equal(p.next(T0 + 20_000), null, '旧的 20s 默认不再适用');
  assert.equal(p.next(T0 + 44_999), null);
  assert.equal(p.next(T0 + 45_000).text, '换档之后要念的这一句。');
});

test('setMinInterval：非整数毫秒取整（滑杆可能给出浮点）', () => {
  const p = createSpeechPlanner();
  p.submit({ text: '先把闸门的时间基准打上吧。', score: 0.5 }, T0);
  assert.equal(p.next(T0).text, '先把闸门的时间基准打上吧。');
  assert.equal(p.setMinInterval(12_345.67), true);
  p.submit({ text: '取整之后按 12346 毫秒走。', score: 0.5 }, T0);
  assert.equal(p.next(T0 + 12_345), null);
  assert.equal(p.next(T0 + 12_346).text, '取整之后按 12346 毫秒走。');
});
