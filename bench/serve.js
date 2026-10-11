/**
 * Live2D 开销测试台 —— 静态服务 + 结果回收
 * 复用上游真实资产：lib/live2d-vendor.js（pixi8 + 引擎） + pets/ds-whale-girl 模型
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'vendor/dsh-pet-live2d/dsh-live2d-pet');
const OUT = path.join(__dirname, 'out');

const MIME = {
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.html': 'text/html',
  '.moc3': 'application/octet-stream',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
};

const reports = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      let rec;
      try {
        rec = JSON.parse(b || '{}');
      } catch {
        rec = { raw: b };
      }
      rec.serverT = Date.now();
      reports.push(rec);
      console.log('REPORT ' + JSON.stringify(rec));
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/dump') {
    fs.writeFileSync(path.join(OUT, 'browser_report.json'), JSON.stringify(reports, null, 2));
    console.log('DUMP ok ' + reports.length);
    res.writeHead(204);
    res.end();
    return;
  }

  const p = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (p === '/') file = path.join(__dirname, 'index.html');
  else if (p.startsWith('/lib/')) file = path.join(PLUGIN, p);
  else if (p.startsWith('/pets/')) file = path.join(PLUGIN, p);
  else if (p.startsWith('/cubism/')) file = path.join(__dirname, p);
  else {
    res.writeHead(404);
    res.end('nf');
    return;
  }

  fs.readFile(file, (e, d) => {
    if (e) {
      res.writeHead(404);
      res.end('nf ' + p);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(d);
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(OUT, 'port.txt'), String(port));
  console.log('PORT ' + port);
});
