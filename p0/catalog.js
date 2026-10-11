/**
 * 解析 DSH API 目录（api-catalog.js），输出可读的事件/服务清单
 * 用法: node catalog.js [过滤正则]
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'extract/api-catalog.js'), 'utf8');

// 条目形如： { name: 'xxx', mode: 'emit', signature: '...', summary: '...' }
const re =
  /name:\s*'([^']+)'\s*,\s*mode:\s*'([^']+)'\s*,\s*signature:\s*'((?:[^'\\]|\\.)*)'\s*,\s*summary:\s*'((?:[^'\\]|\\.)*)'/g;

const items = [];
let m;
while ((m = re.exec(src))) {
  items.push({ name: m[1], mode: m[2], signature: m[3], summary: m[4] });
}

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;

const modes = {};
for (const it of items) modes[it.mode] = (modes[it.mode] || 0) + 1;
console.log(`总条目 ${items.length}；mode 分布: ${JSON.stringify(modes)}\n`);

const events = items.filter((i) => i.mode !== 'service');
console.log(`=== 事件（emit / waterfall / parallel）共 ${events.length} 条 ===`);
for (const e of events) {
  if (filter && !filter.test(e.name)) continue;
  console.log(`  [${e.mode.padEnd(9)}] ${e.name}`);
}
console.log(`\n=== 服务（service）共 ${items.length - events.length} 条 ===`);
for (const e of items.filter((i) => i.mode === 'service')) {
  if (filter && !filter.test(e.name)) continue;
  console.log(`  ${e.name}`);
}

if (process.argv[3] === '-v') {
  console.log('\n===== 详细（含签名）=====');
  for (const it of items) {
    if (filter && !filter.test(it.name)) continue;
    console.log(`\n[${it.mode}] ${it.name}`);
    console.log(`  sig: ${it.signature}`);
    console.log(`  sum: ${it.summary}`);
  }
}
