/**
 * `lib/index.test.js` — P2-2 / P2-6 入口层单测
 *
 * 入口层的职责只有"参数校验 + 事件转发"（DESIGN §4.3），所以这里守的也是这件事：
 * 订阅签名对不对、参数形状传对没有、异常会不会外泄。
 *
 * ⚠️ 这些用例**不启动 DSH**：用假 `ctx` 记录订阅，用假 pipeline 记录转发。
 *    真正的端到端验证另有其人（`p0/` 的真实语料回放 + 开发循环）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActivityHub, API, LANGUAGE_SECTION, attachReasoningLanguage, attachThinkingEvents, inject, name } from './index.js';

// ───────────────────── 改名硬契约（HANDOFF §6.2）─────────────────────

test('改名硬契约：row id 与路由前缀必须是本项目自己的名字', () => {
  assert.equal(name, 'think-voice-pet');
  assert.equal(API, '/api/think-voice-pet');
});

// ───────────────────── 订阅签名与参数形状 ─────────────────────

/** 造一个记录订阅的假 ctx */
function fakeCtx({ globalThrows = false } = {}) {
  const subs = [];
  return {
    subs,
    on(event, handler, options) {
      if (options?.global === true && globalThrows) {
        throw new Error('this host does not accept the global option');
      }
      subs.push({ event, handler, options });
      return () => {};
    },
    find(event) {
      return subs.find((s) => s.event === event);
    },
  };
}

function fakePipeline() {
  const calls = [];
  return {
    calls,
    onSessionEvent(event) { calls.push(['session', event]); return { kind: 'ok' }; },
    onStreamFrame(payload) { calls.push(['stream', payload]); return { kind: 'ok' }; },
  };
}

test('两条通道都用 { global: true } 订阅（Scoped 事件不带它永不回调）', () => {
  const ctx = fakeCtx();
  const pipeline = fakePipeline();
  const res = attachThinkingEvents(ctx, pipeline);

  assert.deepEqual(res, { persistent: true, realtime: true });
  assert.equal(ctx.subs.length, 2);
  for (const s of ctx.subs) {
    assert.equal(s.options?.global, true, `${s.event} 必须带 { global: true }`);
  }
  assert.ok(ctx.find('session/event'), '必须订阅 session/event');
  assert.ok(ctx.find('agent/assistant-stream'), '必须订阅 agent/assistant-stream');
});

test('宿主不接受 global 选项时退回默认签名（不抛、不静默死掉）', () => {
  const ctx = fakeCtx({ globalThrows: true });
  const pipeline = fakePipeline();
  const res = attachThinkingEvents(ctx, pipeline);

  assert.deepEqual(res, { persistent: true, realtime: true });
  assert.equal(ctx.subs.length, 2);
  for (const s of ctx.subs) assert.equal(s.options, undefined, '退回后不应再带 options');
});

test('持久通道：两个**位置参数**，且只转发 assistant/message', () => {
  const ctx = fakeCtx();
  const pipeline = fakePipeline();
  attachThinkingEvents(ctx, pipeline);
  const handler = ctx.find('session/event').handler;

  handler({ id: 'sess-1' }, { type: 'assistant/message', data: { message: { content: [] } } });
  assert.equal(pipeline.calls.length, 1);
  assert.equal(pipeline.calls[0][0], 'session');
  assert.equal(pipeline.calls[0][1].type, 'assistant/message');

  // 别的事件类型不得转发 —— 否则整条事件流都会进流水线
  for (const t of ['user/message', 'turn/end', 'tool/call', undefined]) {
    handler({ id: 'sess-1' }, { type: t, data: {} });
  }
  assert.equal(pipeline.calls.length, 1, '非 assistant/message 不应转发');
});

test('实时通道：一个**对象参数**（{ agent, frame }）', () => {
  const ctx = fakeCtx();
  const pipeline = fakePipeline();
  attachThinkingEvents(ctx, pipeline);
  const handler = ctx.find('agent/assistant-stream').handler;

  const envelope = { agent: { id: 'a1' }, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'x' } } };
  handler(envelope);
  assert.equal(pipeline.calls.length, 1);
  assert.equal(pipeline.calls[0][0], 'stream');
  assert.equal(pipeline.calls[0][1], envelope, '应原样转发整个 envelope');
});

test('handler 抛异常绝不外泄到宿主事件流', () => {
  const ctx = fakeCtx();
  const boom = {
    onSessionEvent() { throw new Error('pipeline blew up'); },
    onStreamFrame() { throw new Error('pipeline blew up'); },
  };
  attachThinkingEvents(ctx, boom);

  for (const event of ['session/event', 'agent/assistant-stream']) {
    const handler = ctx.find(event).handler;
    assert.doesNotThrow(() => handler({}, { type: 'assistant/message' }),
      `${event} 的异常泄漏到了宿主`);
  }
});

test('宿主连事件都没有（旧版本）→ 报不可用，而不是崩', () => {
  const ctx = { on() { throw new Error('unknown event'); } };
  const res = attachThinkingEvents(ctx, fakePipeline());
  assert.deepEqual(res, { persistent: false, realtime: false });
});

// ───────────────────── SSE 广播（P2-6）─────────────────────

test('ActivityHub.broadcast：把 speak 帧送到所有订阅者', () => {
  const hub = new ActivityHub();
  const got = [];
  hub.subscribe((f) => got.push(f));

  hub.broadcast({ type: 'speak', payload: { text: '一句话', audioUrl: null, emotion: null } });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'speak');
  hub.dispose();
});

test('ActivityHub.broadcast：单个订阅者抛异常不影响其他订阅者', () => {
  const hub = new ActivityHub();
  const got = [];
  hub.subscribe(() => { throw new Error('this stream is dead'); });
  hub.subscribe((f) => got.push(f));

  assert.doesNotThrow(() => hub.broadcast({ type: 'speak', payload: { text: 'x' } }));
  assert.equal(got.length, 1, '活着的流必须照常收到');
  hub.dispose();
});

test('不改已有帧的形状：相位快照仍然没有 type 字段', () => {
  const hub = new ActivityHub();
  const snap = hub.snapshot();
  assert.ok('phase' in snap && 'detail' in snap && 'at' in snap);
  assert.equal('type' in snap, false, '相位快照不得被加上 type —— 否则浏览器分派规则会乱');
  hub.dispose();
});

test('broadcast 与 emit 互不干扰（相位帧不会带上 speak 的内容）', () => {
  const hub = new ActivityHub();
  const got = [];
  hub.subscribe((f) => got.push(f));
  hub.set('thinking', '');
  hub.broadcast({ type: 'speak', payload: { text: 'x', audioUrl: null, emotion: null } });
  assert.equal(got.length, 2);
  assert.equal('type' in got[0], false, '第一条是相位帧');
  assert.equal(got[1].type, 'speak', '第二条是朗读帧');
  hub.dispose();
});

// ───────────────────── 思考语言注入（P3-0b / D10）─────────────────────

/**
 * 造一个**带 systemPrompt 服务**的假 ctx。
 *
 * `failOnInject` / `failOnSection` 用来复现两个真实故障：
 * 宿主没有 inject 能力（旧版本）、以及 section 撞名（与社区插件同时装）。
 */
function promptHost({ failOnInject = false, failOnSection = false } = {}) {
  const record = { injects: [], sections: [], disposed: 0 };
  const ctx = {
    inject(services, callback) {
      record.injects.push(services);
      if (failOnInject) throw new Error('this host has no inject()');
      const scoped = {
        systemPrompt: {
          section(spec) {
            if (failOnSection) throw new Error('duplicate section name');
            record.sections.push(spec);
            return () => { record.disposed += 1; };
          },
        },
        effect(fn) { fn(); return () => {}; },
      };
      callback(scoped);
      return () => {};
    },
  };
  return { ctx, record };
}

test('注入用本项目自己的 section 前缀（同层同名会 throw，撞社区插件就两个都挂）', () => {
  assert.ok(LANGUAGE_SECTION.startsWith('think-voice:'), '必须带本项目前缀');
  assert.equal(LANGUAGE_SECTION, 'think-voice:reasoning-language');
});

test('systemPrompt 不进声明式 inject（硬等待会让插件整个不激活，桌宠都不显示）', () => {
  assert.equal(inject.includes('systemPrompt'), false, 'systemPrompt 必须走软探测');
  assert.deepEqual([...inject], ['webServer'], '声明式 inject 只留必需的 webServer');
});

test('默认策略是中文（用户 2026-10-11 拍板）→ 不传 getPolicy 也会注入', () => {
  const { ctx, record } = promptHost();
  attachReasoningLanguage(ctx);
  assert.equal(record.sections.length, 1);
  assert.match(record.sections[0].text, /中文/);
});

test('中文策略：软探测 + 注册一句约束，位置与社区同类插件一致，并留痕', () => {
  const { ctx, record } = promptHost();
  const logs = [];
  const ctl = attachReasoningLanguage(ctx, {
    getPolicy: () => 'zh',
    log: (level, message) => logs.push([level, message]),
  });

  assert.deepEqual(record.injects, [['systemPrompt']], '必须是 ctx.inject 软探测');
  assert.equal(record.sections.length, 1);
  assert.equal(record.sections[0].name, LANGUAGE_SECTION);
  assert.equal(record.sections[0].order, -90, '位置：harness:identity 之后、persona-prefix 之前');
  assert.equal(ctl.available(), true);
  assert.equal(ctl.current(), 'zh');
  assert.ok(logs.some(([l, m]) => l === 'info' && m.includes('已开启')), '开启必须留痕（R3）');
});

test('auto 策略一个字都不注入，并留痕说明没动系统提示', () => {
  const { ctx, record } = promptHost();
  const logs = [];
  const ctl = attachReasoningLanguage(ctx, {
    getPolicy: () => 'auto',
    log: (level, message) => logs.push([level, message]),
  });

  assert.equal(record.sections.length, 0, 'auto 不得注册任何 section');
  assert.equal(ctl.current(), 'auto');
  assert.ok(logs.some(([, m]) => m.includes('已关闭')));
});

test('R5 一键关：中文 → auto 会当场撤销已注册的 section', () => {
  const { ctx, record } = promptHost();
  const ctl = attachReasoningLanguage(ctx, { getPolicy: () => 'zh' });
  assert.equal(record.sections.length, 1);

  ctl.setPolicy('auto');
  assert.equal(record.disposed, 1, '旧的 section 必须被撤销');
  assert.equal(record.sections.length, 1, '不得再注册新的');
  assert.equal(ctl.current(), 'auto');
});

test('换语言不会留下两条 section 同时生效（先撤旧的再注册）', () => {
  const { ctx, record } = promptHost();
  const ctl = attachReasoningLanguage(ctx, { getPolicy: () => 'zh' });

  ctl.setPolicy('en');
  assert.equal(record.disposed, 1, '先撤旧的');
  assert.equal(record.sections.length, 2);
  assert.match(record.sections[1].text, /English/i);
  assert.equal(ctl.current(), 'en');
});

test('宿主没有 systemPrompt 服务 → 不崩，并如实报"不可用"（主体功能照常）', () => {
  const seen = [];
  const ctx = { inject(services) { seen.push(services); return () => {}; } };  // 回调永不执行
  const ctl = attachReasoningLanguage(ctx, { getPolicy: () => 'zh' });

  assert.equal(ctl.available(), false);
  assert.equal(ctl.current(), null, '环境没就绪时不得谎报"已应用"');
  assert.equal(ctl.setPolicy('zh'), false, '没服务时切换应返回 false，而不是抛');
});

test('宿主连 inject 都没有（旧版本）→ 只留痕，不抛', () => {
  const logs = [];
  assert.doesNotThrow(() => attachReasoningLanguage({}, { log: (l, m) => logs.push([l, m]) }));
  assert.ok(logs.some(([l]) => l === 'warn'), '探测失败必须留痕');
});

test('注册 section 抛错（例如与社区插件撞名）→ 只留痕，异常不外泄', () => {
  const { ctx } = promptHost({ failOnSection: true });
  const logs = [];
  const ctl = attachReasoningLanguage(ctx, {
    getPolicy: () => 'zh',
    log: (level, message) => logs.push([level, message]),
  });

  assert.equal(ctl.available(), true);
  assert.ok(logs.some(([l, m]) => l === 'warn' && m.includes('注册失败')));
});
