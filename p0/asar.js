/**
 * 最小 asar 解析器（Electron asar 格式）
 * 用法:
 *   node asar.js list  <archive> [前缀]
 *   node asar.js cat   <archive> <内部路径>
 *   node asar.js grep  <archive> <路径前缀> <正则>
 */
const fs = require('fs');

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const headerSize = head.readUInt32LE(4); // pickle size
  const base = 8 + headerSize;
  fs.closeSync(fd);
  return { json: JSON.parse(jsonBuf.toString('utf8')), base };
}

function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (v.files) walk(v, p, out);
    else out.push({ path: p, size: Number(v.size || 0), offset: v.offset === undefined ? null : Number(v.offset) });
  }
}

const [cmd, file, ...rest] = process.argv.slice(2);
const { json, base } = readHeader(file);
const entries = [];
walk(json, '', entries);

if (cmd === 'list') {
  const filter = rest[0] || '';
  const hits = entries.filter((e) => e.path.startsWith(filter));
  // 按目录聚合，深度由 DEPTH 控制
  const depth = Number(process.env.DEPTH || 3);
  const dirs = new Map();
  for (const e of hits) {
    const parts = e.path.split('/').filter(Boolean);
    const key = parts.slice(0, depth).join('/');
    if (!dirs.has(key)) dirs.set(key, { n: 0, bytes: 0 });
    const d = dirs.get(key);
    d.n++;
    d.bytes += e.size;
  }
  console.log(`共 ${entries.length} 个文件；匹配 "${filter}" 的 ${hits.length} 个`);
  console.log(`--- 目录聚合（前 ${depth} 层）---`);
  [...dirs.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 60)
    .forEach(([k, v]) => console.log(`  ${(v.bytes / 1024).toFixed(0).padStart(9)} KB  ${String(v.n).padStart(5)}  ${k}/`));
} else if (cmd === 'cat') {
  const e = entries.find((x) => x.path === rest[0]);
  if (!e) {
    console.error('未找到: ' + rest[0]);
    process.exit(1);
  }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, base + e.offset);
  fs.closeSync(fd);
  process.stdout.write(buf);
} else if (cmd === 'grep') {
  const [prefix, pattern] = rest;
  const re = new RegExp(pattern);
  const fd = fs.openSync(file, 'r');
  let scanned = 0;
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    if (e.size > 8 * 1024 * 1024) continue; // 跳过超大文件
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, base + e.offset);
    const txt = buf.toString('utf8');
    if (re.test(txt)) {
      const idx = txt.search(re);
      const line = txt.slice(Math.max(0, idx - 120), idx + 200).split('\n').join(' ⏎ ');
      console.log(`\n=== ${e.path}  (${(e.size / 1024).toFixed(0)} KB)`);
      console.log('    ' + line);
    }
    scanned++;
  }
  fs.closeSync(fd);
  console.error(`[grep] 扫描 ${scanned} 个文件`);
} else {
  console.error('用法: node asar.js list|cat|grep ...');
}
