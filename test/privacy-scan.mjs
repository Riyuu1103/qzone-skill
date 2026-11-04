// 隐私扫描：查仓库里有没有真实的账号、本机路径、好友昵称
//
// 设计上有个坑要注意：**不要把真实账号写进这个脚本当检测目标**，
// 否则脚本本身就成了泄露源。所以这里只放通用模式（QQ 号格式、本机路径格式），
// 具体要额外检查的字符串放到仓库外的 patterns 文件里。
//
// 用法：
//   node test/privacy-scan.mjs
//   node test/privacy-scan.mjs --patterns "C:/path/to/my-patterns.json"
//
// patterns 文件格式（放在仓库外，别提交）：
//   { "patterns": [{ "name": "我的账号", "re": "123456789" }] }

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 通用模式：不指向任何具体的人，只抓「看起来像真实数据」的东西
const GENERIC = [
  { name: '疑似 QQ 号（9~11 位数字）', re: /(?<![\d.-])\d{9,11}(?![\d.-])/g },
  { name: 'Windows 绝对路径带用户名', re: /[A-Za-z]:\\+Users\\+[A-Za-z][\w.-]*/g },
  { name: '/home/ 下的用户名', re: /\/home\/[a-z][\w.-]*/g },
  { name: '可能的登录凭证', re: /p_skey=[A-Za-z0-9]{16,}|skey=[A-Za-z0-9]{16,}/g },
];

// 可选：仓库外的私有模式
let extra = [];
const pi = process.argv.indexOf('--patterns');
if (pi > 0 && process.argv[pi + 1]) {
  const f = process.argv[pi + 1];
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      extra = (j.patterns || []).map((p) => ({ name: p.name, re: new RegExp(p.re, 'g') }));
      console.log(`（已加载 ${extra.length} 条私有模式）`);
    } catch (e) {
      console.log('私有模式文件读取失败：', e.message);
    }
  }
}

const files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

let hits = 0;
const rows = [];

for (const rel of files) {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > 5_000_000) continue;
  if (/\.(pdf|png|jpg|jpeg|webp|gif|ico|zip|exe)$/i.test(rel)) continue;

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }

  for (const { name, re } of [...GENERIC, ...extra]) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (!m) continue;
    // 明显虚构的连续数字不算（文档里用 123456789 当示例）
    const real = m.filter((v) =>
      !/^0?1?23456789\d?$/.test(v) && // 123456789 / 0123456789 这类示例
      !/^17[5-9]\d{7}$/.test(v) && // 2026 年前后的 Unix 时间戳
      !/^0+$/.test(v),
    );
    if (!real.length) continue;
    hits++;
    rows.push({ rel, name, count: real.length, sample: real.slice(0, 2).join(', ') });
  }
}

console.log(`\n扫描 ${files.length} 个文件`);
if (!hits) {
  console.log('✅ 没有发现疑似真实数据\n');
  process.exit(0);
}
console.log(`⚠️ 命中 ${hits} 处：\n`);
for (const r of rows) console.log(`  ${r.rel}\n    [${r.name}] ×${r.count}  例：${r.sample}`);
console.log('\n注意：9~11 位数字是通用模式，可能误报（比如时间戳）。逐条看上下文判断。\n');
process.exit(1);
