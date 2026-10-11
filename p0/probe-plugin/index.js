/**
 * P0-1 探针：验证 Host 插件能否拿到模型的「思考原文（reasoning）」。
 *
 * 依据（均为 DSH 安装体内核实的权威来源：dsh-tool-cordis/lib/types/api-catalog.js）：
 *   - 事件 `session/event`            (emit) `(session, event)`            —— 持久、已提交
 *       event.type === 'assistant/message'
 *       event.data = { turn, step, message, stream, usage?, interrupted? }
 *       message.content[i] : { type: 'reasoning', text }                        ← 完整思考
 *       stream[i]          : { type:'reasoning-chunks', time0, index, dt[], texts[] } ← 逐 token + 时间
 *   - 事件 `agent/assistant-stream`   (emit) `{ agent, frame }`            —— 瞬态、实时
 *       frame.type === 'chunk' → frame.chunk : { type: 'reasoning-delta', index, text }
 *
 * 本探针只写日志：不注册界面、不追加任何会话事件（不违反「不得新增事件 type」的约束）。
 *
 * 除捕获思考外，还会统计**所有 session 事件类型**并定期落盘——这样即使没抓到思考，
 * 也能区分是「订阅通道根本没触发」还是「通道触发了但本条消息没有思考」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 日志路径按可靠性与可发现性排序：
 *   1) 环境变量显式指定（最可控）
 *   2) %DSH_HOME%/think-probe.log —— 最容易被找到（插件可能被安装到 profile 的 node_modules，
 *      那时 HERE 会指向那里而不是工作区，所以不能只依赖 HERE）
 *   3) 插件目录旁（工作区场景）
 *   4) 系统临时目录（兜底）
 */
function resolveLogPath() {
  const candidates = [
    process.env.DSH_THINK_PROBE_LOG,
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'think-probe.log') : null,
    path.join(HERE, 'probe.log'),
    path.join(os.tmpdir(), 'dsh-think-probe.log'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.appendFileSync(p, '');
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const LOG_PATH = resolveLogPath();

function log(obj) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: Date.now(), ...obj }) + '\n');
  } catch {
    /* 探针绝不因日志失败而抛错 */
  }
}

const cut = (s, n = 200) => (typeof s === 'string' ? s.slice(0, n) : s);

// 实时增量按 attempt 缓冲，end 时汇总（避免每 token 一行撑爆日志）
const liveByAttempt = new Map();

// 统计：session 事件类型分布 + 捕获到的思考条数
const eventTypes = Object.create(null);
let reasoningCaptured = 0;
let eventSinceFlush = 0;

function flushHistogram(reason) {
  log({ ev: 'histogram', reason, sessionEvents: { ...eventTypes }, reasoningCaptured, sinceFlush: eventSinceFlush });
  eventSinceFlush = 0;
}

// 每条持久消息只完整采样若干条，之后降为摘要
let fullSamplesLeft = 5;

/** 注册监听，兼容带/不带 { global: true } 两种签名 */
function on(ctx, name, handler) {
  const wrapped = (...args) => {
    try {
      handler(...args);
    } catch (err) {
      log({ ev: 'handler-error', name, error: String(err && err.stack ? err.stack : err) });
    }
  };
  try {
    const dispose = ctx.on(name, wrapped, { global: true });
    log({ ev: 'subscribed', name, mode: 'global' });
    return dispose;
  } catch (err) {
    try {
      const dispose = ctx.on(name, wrapped);
      log({ ev: 'subscribed', name, mode: 'default', note: String(err && err.message) });
      return dispose;
    } catch (err2) {
      log({ ev: 'subscribe-failed', name, error: String(err2 && err2.message) });
      return null;
    }
  }
}

/** 从持久事件里抽取思考文本（两条路径互证） */
function inspectAssistantMessage(session, event) {
  const data = event.data ?? {};
  const content = data.message?.content ?? [];
  const blocks = content.filter((b) => b && b.type === 'reasoning');
  const blockText = blocks.map((b) => b.text ?? '').join('');

  const recs = (data.stream ?? []).filter((s) => s && s.type === 'reasoning-chunks');
  const streamText = recs.map((r) => (r.texts ?? []).join('')).join('');
  const tokenCount = recs.reduce((n, r) => n + (r.texts?.length ?? 0), 0);
  const dtSum = recs.reduce((n, r) => n + (r.dt ?? []).reduce((a, b) => a + b, 0), 0);

  const bothPresent = blockText.length > 0 && streamText.length > 0;
  if (blockText.length || streamText.length) reasoningCaptured++;

  const rec = {
    ev: 'durable:assistant/message',
    session: session?.id,
    turn: data.turn,
    step: data.step,
    interrupted: data.interrupted ?? false,
    contentBlockTypes: content.map((b) => b && b.type),
    reasoningBlockCount: blocks.length,
    reasoningChars: blockText.length,
    streamRecordCount: recs.length,
    streamTokens: tokenCount,
    streamChars: streamText.length,
    dtSumMs: dtSum,
    // ★ 关键互证：两条独立路径抽出的思考文本是否一致
    pathsAgree: bothPresent ? blockText === streamText : null,
  };
  if (fullSamplesLeft > 0 && (blockText.length || streamText.length)) {
    fullSamplesLeft--;
    rec.sampleBlockText = cut(blockText, 400);
    rec.sampleStreamText = cut(streamText, 400);
  }
  log(rec);
}

export function apply(ctx, config) {
  log({
    ev: 'plugin-activated',
    logPath: LOG_PATH,
    config: config ?? null,
    dshProfile: process.env.DSH_PROFILE ?? null,
    dshHome: process.env.DSH_HOME ?? null,
    node: process.version,
  });

  ctx.effect(() => {
    const disposers = [
      on(ctx, 'session/event', (session, event) => {
        const t = event?.type ?? '<none>';
        eventTypes[t] = (eventTypes[t] ?? 0) + 1;
        eventSinceFlush++;

        // 诊断：即使没有思考，也要证明订阅通道是活的
        if (t === 'turn/end' || t === 'session/end-seed' || eventSinceFlush >= 50) {
          flushHistogram(t === 'turn/end' ? 'turn/end' : 'threshold');
        }
        if (t !== 'assistant/message') return;
        inspectAssistantMessage(session, event);
      }),

      on(ctx, 'agent/assistant-stream', (payload) => {
        const { agent, frame } = payload ?? {};
        if (!frame) return;
        const sid = agent?.session?.id;

        if (frame.type === 'start') {
          liveByAttempt.set(frame.attemptId, { session: sid, turn: frame.turn, step: frame.step, chars: 0, tokens: 0, first: '' });
          log({ ev: 'live:start', session: sid, attemptId: frame.attemptId, turn: frame.turn, step: frame.step });
          return;
        }

        if (frame.type === 'chunk') {
          const chunk = frame.chunk;
          if (!chunk || chunk.type !== 'reasoning-delta') return;
          const buf = liveByAttempt.get(frame.attemptId) ?? { session: sid, chars: 0, tokens: 0, first: '' };
          buf.chars += (chunk.text ?? '').length;
          buf.tokens += 1;
          if (buf.first.length < 120) buf.first += chunk.text ?? '';
          liveByAttempt.set(frame.attemptId, buf);
          return;
        }

        if (frame.type === 'end') {
          const buf = liveByAttempt.get(frame.attemptId);
          liveByAttempt.delete(frame.attemptId);
          log({
            ev: 'live:end',
            session: sid,
            attemptId: frame.attemptId,
            outcome: frame.outcome?.kind,
            committedAs: frame.outcome?.eventType,
            reasoningCharsSeenLive: buf?.chars ?? 0,
            reasoningTokensSeenLive: buf?.tokens ?? 0,
            sampleLiveText: cut(buf?.first ?? '', 200),
          });
        }
      }),
    ];

    return () => {
      flushHistogram('dispose');
      for (const d of disposers) {
        try {
          if (typeof d === 'function') d();
        } catch {
          /* ignore */
        }
      }
      log({ ev: 'disposed' });
    };
  });
}
