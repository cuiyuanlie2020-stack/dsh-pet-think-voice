/**
 * DSH 插件 host 半区「常驻开销」探针
 * 复刻 dsh-pet-live2d host 的真实形态：HTTP 路由 + 同源 SSE 长连接 + 周期性推帧
 * 测量：Node 进程 RSS / 堆 / 外部内存 / 累计 CPU —— 常驻 vs 空载基线
 */
const http = require('http');

const CLIENTS = [];
let frameCount = 0;
let speakCount = 0;

function snap(label) {
  const m = process.memoryUsage();
  const c = process.cpuUsage();
  return {
    label,
    rss_mb: +(m.rss / 1048576).toFixed(1),
    heapUsed_mb: +(m.heapUsed / 1048576).toFixed(1),
    external_mb: +(m.external / 1048576).toFixed(1),
    cpu_ms: +((c.user + c.system) / 1000).toFixed(1),
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/live2d-pet/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    CLIENTS.push(res);
    req.on('close', () => {
      const i = CLIENTS.indexOf(res);
      if (i >= 0) CLIENTS.splice(i, 1);
    });
    return;
  }
  if (req.url === '/api/live2d-pet/speak') {
    // 模拟一次 TTS 合成后的音频回传（约 30KB mp3）
    const buf = Buffer.alloc(30 * 1024);
    speakCount++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  res.writeHead(404);
  res.end();
});

const t0 = Date.now();
console.log('== 0s 进程启动（未起服务）==', JSON.stringify(snap('boot')));

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`== 服务已起 @${port}（SSE 空闲，无客户端）==`, JSON.stringify(snap('server-up')));

  // 建立 1 个 SSE 客户端（模拟 DSH Web GUI 挂着的桌宠）
  http.get({ port, host: '127.0.0.1', path: '/api/live2d-pet/events' }, (res) => {
    res.on('data', () => {});
    res.resume();
  });

  setTimeout(() => {
    console.log('== 客户端已连（SSE 长连接保持）==', JSON.stringify(snap('sse-connected')));

    // 每 1s 推 1 帧（模拟相位/心跳），每 5s 触发 1 次 speak（模拟朗读）
    let sec = 0;
    const timer = setInterval(() => {
      sec++;
      const frame = `data: ${JSON.stringify({
        type: sec % 5 === 0 ? 'speak' : 'phase',
        payload: { text: '这是一条模拟思考片段，长度约五十个字符用于逼近真实负载。'.repeat(2) },
      })}\n\n`;
      frameCount++;
      for (const c of CLIENTS) c.write(frame);

      if (sec % 5 === 0) {
        // 模拟 host 拉一次音频（本地回环）
        http.get({ port, host: '127.0.0.1', path: '/api/live2d-pet/speak' }, (r) => {
          r.on('data', () => {});
          r.resume();
        });
      }
      if (sec % 5 === 0) {
        console.log(`== ${sec}s ==`, JSON.stringify(snap(`${sec}s`)));
      }
    }, 1000);

    setTimeout(() => {
      clearInterval(timer);
      const total = snap('end');
      const cpu = total.cpu_ms;
      console.log('== 20s 结束 ==', JSON.stringify(total));
      console.log(`\n===== 汇总 =====`);
      console.log(`时长 ${((Date.now() - t0) / 1000).toFixed(1)}s；SSE 帧 ${frameCount} 条；speak ${speakCount} 次`);
      console.log(`进程 RSS 终值 ${total.rss_mb} MB；堆 ${total.heapUsed_mb} MB；external ${total.external_mb} MB`);
      console.log(`累计 CPU 时间 ${cpu} ms → 平均占用率 ≈ ${((cpu / (Date.now() - t0)) * 100).toFixed(2)} % （单核）`);
      console.log(`客户端连接数（存活）${CLIENTS.length}`);
      server.close();
      process.exit(0);
    }, 20000);
  }, 500);
});
