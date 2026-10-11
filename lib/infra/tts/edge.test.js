/**
 * `lib/infra/tts/edge.test.js` — P3-1 基础设施层单测
 *
 * **全部不打网络**：用一个假 `WebSocket` 注入，把一条合成的完整帧序列
 * （open → config/ssml → audio 二进制帧 → `Path:turn.end` → close）手工喂进去。
 *
 * 这样做的价值不只是"跑得快"：协议的四条要点（必须带 Origin/UA、`Sec-MS-GEC`、
 * 二进制帧头 2 字节长度、结束标志在文本帧）**每一条单独漏掉都只在真连时才炸**，
 * 有了假 WS 就能把它们钉成回归项。
 *
 * ⚠️ 真连的那一份验证在 `p0/edge-tts-zerodep.mjs`（6/6 样本字节数与本机
 *    Python 版 `edge-tts` 一致），本文件不重复它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDGE_COST, EDGE_MIME, audioFromFrame, buildSsml, createEdgeProvider,
  escapeXml, parseHeaders, secMsGec,
} from './edge.js';
import { TTS_PROVIDERS, createTtsProvider } from './index.js';

/** 一个"手动挡"的 WebSocket：测试自己决定什么时候 open / 收帧 / 断线。 */
class FakeWebSocket {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.closed = false;
    this.handlers = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  send(data) { this.sent.push(data); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code: 1000, reason: '' });
  }

  emit(type, event) {
    for (const fn of this.handlers.get(type) ?? []) fn(event);
  }

  // ── 测试驱动
  emitOpen() { this.emit('open', {}); }
  emitText(text) { this.emit('message', { data: text }); }
  emitBinary(buffer) { this.emit('message', { data: buffer }); }
  emitError(message) { this.emit('error', { message }); }
}

function makeProvider(options = {}) {
  FakeWebSocket.instances.length = 0;
  return createEdgeProvider({ WebSocket: FakeWebSocket, now: () => 1_700_000_000_000, ...options });
}

/** 造一个服务端风格的音频二进制帧：`uint16 BE 头长度` + 头文本 + 负载 */
function binaryFrame(payload, header = 'Path:audio\r\n') {
  const head = Buffer.from(header, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(head.length, 0);
  return Buffer.concat([len, head, Buffer.from(payload, 'utf8')]);
}

// ───────────────────── 静态契约 ─────────────────────

test('成本声明是零显存（红线 R1 的静态保证：Edge 是纯云端）', () => {
  assert.equal(EDGE_COST.vramMb, 0);
  assert.ok(EDGE_COST.netBytesPerCall > 0, '不占显存，但要如实声明会走网络');
});

test('随包只提供 edge（N7：不做本地 TTS 后端）', () => {
  assert.deepEqual([...TTS_PROVIDERS], ['edge']);
});

test('未实现的 provider 名要抛错，不静默退回 edge', () => {
  assert.throws(() => createTtsProvider('kokoro'), /未实现/);
});

// ───────────────────── 鉴权与协议细节 ─────────────────────

test('Sec-MS-GEC 按 300 秒窗口截断（服务端按同一窗口校验，差一个窗口就 403）', () => {
  const t = 1_700_000_000_000;
  // 该时刻落在窗口的第 200 秒：往后 99s 仍同窗口，往后 101s 已跨窗口
  assert.equal(secMsGec(t), '42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF');
  assert.equal(secMsGec(t + 99_000), secMsGec(t), '同一窗口内必须稳定');
  assert.notEqual(secMsGec(t + 101_000), secMsGec(t), '跨窗口必须变化');
  assert.match(secMsGec(t), /^[0-9A-F]{64}$/, '必须是 64 位大写十六进制');
});

test('SSML 正文必须转义 —— 思考里出现 a < b 这类文本不能让服务端解析失败', () => {
  assert.equal(escapeXml('a < b & c > d "e" \'f\''), 'a &lt; b &amp; c &gt; d &quot;e&quot; &apos;f&apos;');
  const ssml = buildSsml({ voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz', text: 'if a < b && c > d' });
  assert.match(ssml, /<voice name='zh-CN-XiaoyiNeural'>/);
  assert.match(ssml, /pitch='\+30Hz'/);
  assert.ok(ssml.includes('&lt;') && ssml.includes('&amp;'), '正文里的尖括号与 & 必须已转义');
  assert.ok(!ssml.includes('a < b'), '未转义的正文不得直接出现在 SSML 里');
});

test('二进制帧要先跳过 uint16 BE 的头长度，否则音频里会插进一段垃圾头', () => {
  const frame = binaryFrame('MP3DATA', 'X-RequestId:1\r\nPath:audio\r\nContent-Type:audio/mpeg\r\n');
  assert.equal(audioFromFrame(frame)?.toString(), 'MP3DATA');
});

test('非音频帧与畸形短帧一律返回 null（不猜、不崩）', () => {
  assert.equal(audioFromFrame(binaryFrame('x', 'Path:turn.start\r\n')), null);
  assert.equal(audioFromFrame(Buffer.from([0x00])), null, '连头长度都放不下');
  const bad = Buffer.alloc(4);
  bad.writeUInt16BE(999, 0);   // 声称头有 999 字节，实际没有
  assert.equal(audioFromFrame(bad), null);
});

test('parseHeaders 认得结束标志 Path: turn.end', () => {
  assert.equal(parseHeaders('X-RequestId:abc\r\nPath:turn.end\r\n\r\nbody').Path, 'turn.end');
  assert.equal(parseHeaders('Path:audio\r\n\r\n').Path, 'audio');
});

// ───────────────────── 合成流程 ─────────────────────

test('环境没有 WebSocket → available() 为 false，且 synthesize 显式抛错（R3 不许静默降级）', async () => {
  const provider = createEdgeProvider({ WebSocket: {} });   // 非函数 = 没有可用实现
  assert.equal(provider.available(), false);
  await assert.rejects(provider.synthesize('你好'), /WebSocket/);
});

test('空文本直接抛错（不浪费一次请求、也不产出 0 字节）', async () => {
  const provider = makeProvider();
  await assert.rejects(provider.synthesize('   '), /空文本/);
  assert.equal(FakeWebSocket.instances.length, 0, '不该建立连接');
});

test('正常一轮：先 speech.config 再 ssml，收到 turn.end 后拼出完整音频', async () => {
  const provider = makeProvider();
  const promise = provider.synthesize('你好，世界', { voice: 'zh-CN-XiaoyiNeural', pitch: '+30Hz' });
  const ws = FakeWebSocket.instances.at(-1);

  assert.match(ws.url, /Sec-MS-GEC=[0-9A-F]{64}/, 'URL 必须带鉴权串');
  assert.match(ws.url, /TrustedClientToken=/, 'URL 必须带客户端令牌');
  assert.equal(typeof ws.options.headers.Origin, 'string', '缺 Origin 会 non-101');
  assert.match(ws.options.headers['User-Agent'], /Edg\//, '缺 UA 会 non-101');

  ws.emitOpen();
  assert.equal(ws.sent.length, 2, '打开后应发两帧：config 与 ssml');
  assert.match(ws.sent[0], /Path:speech\.config/);
  assert.match(ws.sent[1], /Path:ssml/);
  assert.match(ws.sent[1], /<voice name='zh-CN-XiaoyiNeural'>/);
  assert.ok(ws.sent[1].includes('你好，世界'));

  ws.emitBinary(binaryFrame('AAA'));
  ws.emitBinary(binaryFrame('BB'));
  ws.emitText('X-RequestId:1\r\nPath:turn.end\r\n\r\n');

  const audio = await promise;
  assert.ok(Buffer.isBuffer(audio), '返回 Buffer（路由侧要直接写流）');
  assert.equal(audio.toString(), 'AAABB', '多段音频必须按序拼接');
  assert.equal(provider.inFlightCount(), 0, '完成后要摘掉在途登记');
});

test('0 字节音频必须 reject —— 有的音色念另一种语言会返回空（实测 AnaNeural 念中文）', async () => {
  const provider = makeProvider();
  const promise = provider.synthesize('你好', { voice: 'en-US-AnaNeural' });
  const ws = FakeWebSocket.instances.at(-1);
  ws.emitOpen();
  ws.emitText('Path:turn.end\r\n\r\n');

  await assert.rejects(promise, /0 字节/, '宁可报错，也不要静默产出一个空 mp3');
});

test('超时要 reject，并且不留悬挂连接', async () => {
  FakeWebSocket.instances.length = 0;
  const provider = createEdgeProvider({ WebSocket: FakeWebSocket, timeoutMs: 5 });
  // ⚠️ `edge.js` 的超时计时器是 **unref** 的 —— 那是有意的（不让一次合成为进程续命）。
  //    副作用：测试里事件循环会先一步空掉，导致这个用例被 cancelledByParent 连坐。
  //    所以这里自己挂一个 keep-alive，用完即清。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const outcome = provider.synthesize('你好').then(() => null, (error) => error);
    const error = await outcome;
    assert.match(String(error?.message), /超时/);
    assert.equal(provider.inFlightCount(), 0);
  } finally {
    clearInterval(keepAlive);
  }
});

test('dispose 掐断在途连接（红线 R1：随时能停）', async () => {
  const provider = makeProvider();
  const outcome = provider.synthesize('你好').then(() => null, (error) => error);
  const ws = FakeWebSocket.instances.at(-1);
  ws.emitOpen();
  assert.equal(provider.inFlightCount(), 1);

  await provider.dispose();
  assert.equal(provider.inFlightCount(), 0);
  assert.equal(ws.closed, true, 'dispose 必须真的关掉 socket，不能只是忘记它');

  const error = await outcome;
  assert.match(String(error?.message), /提前关闭/);
});

test('连接出错时 reject 且错误信息带 provider 前缀（便于日志识别）', async () => {
  const provider = makeProvider();
  const outcome = provider.synthesize('你好').then(() => null, (error) => error);
  const ws = FakeWebSocket.instances.at(-1);
  ws.emitOpen();
  ws.emitError('boom');

  const error = await outcome;
  assert.match(String(error?.message), /^edge: /);
});

test('mime 常量与产物一致（mp3 → audio/mpeg）', () => {
  assert.equal(EDGE_MIME, 'audio/mpeg');
});
