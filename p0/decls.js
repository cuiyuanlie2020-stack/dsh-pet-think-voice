/**
 * 从 api-catalog.js 抽出所有内嵌类型声明，落盘为可读文件
 * 用法: node decls.js
 * 产出: p0/extract/decls/*.d.ts  +  p0/extract/decls/INDEX.md
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'extract/api-catalog.js'), 'utf8');

// 匹配 declaration: '...' 与相邻的 name
const re = /\{\s*name:\s*'([^']*)'[\s\S]{0,400}?declaration:\s*'((?:[^'\\]|\\.)*)'/g;

const outDir = path.join(__dirname, 'extract/decls');
fs.mkdirSync(outDir, { recursive: true });

let m;
const index = [];
const seen = new Set();
while ((m = re.exec(src))) {
  const name = m[1] || 'anonymous';
  const code = m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const key = name + '|' + code.slice(0, 60);
  if (seen.has(key)) continue;
  seen.add(key);
  const safe = (name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'anon') + '_' + index.length;
  const file = safe + '.d.ts';
  fs.writeFileSync(path.join(outDir, file), code, 'utf8');
  const firstLine = code.split('\n').find((l) => /interface|type |declare /.test(l)) || code.slice(0, 70);
  index.push({ name, file, lines: code.split('\n').length, firstLine: firstLine.trim() });
}

index.sort((a, b) => a.name.localeCompare(b.name));
let md = `# DSH API 类型声明索引（自动抽取自 api-catalog.js）\n\n共 ${index.length} 个声明。\n\n| name | 行数 | 首行 | 文件 |\n|---|---|---|---|\n`;
for (const i of index) {
  md += `| ${i.name} | ${i.lines} | \`${i.firstLine.slice(0, 100)}\` | ${i.file} |\n`;
}
fs.writeFileSync(path.join(outDir, 'INDEX.md'), md, 'utf8');

console.log(`抽出 ${index.length} 个类型声明 → p0/extract/decls/`);
console.log('\n--- 与「思考 / 流 / 会话事件」相关的 ---');
for (const i of index) {
  if (/reason|think|stream|session|message|block/i.test(i.name + i.firstLine)) {
    console.log(`  ${i.name}  (${i.lines} 行)  ${i.file}`);
  }
}
