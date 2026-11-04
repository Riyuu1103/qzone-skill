// 隐私扫描：仓库里有没有真实账号、好友名、本地路径
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const root = 'D:/qzone-skill';
const files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

// 真实值（一旦出现在仓库里就算泄露）
const SENSITIVE = [
  { name: 'QQ 号', re: /123456789/g },
  { name: '空间昵称', re: /某某/g },
  { name: '英文昵称', re: /\bDemoUser\b/g },
  { name: 'Windows 用户名', re: /USER/gi },
  { name: '好友-示例甲', re: /示例甲/g },
  { name: '好友-示例乙', re: /示例乙/g },
  { name: '好友-示例丁', re: /示例丁/g },
  { name: '好友-示例人', re: /示例人/g },
  { name: '好友-示例戊', re: /示例戊/g },
  { name: '好友-示例丙', re: /示例丙/g },
  { name: '好友-示例辛', re: /示例辛/g },
  { name: '好友-示例庚', re: /示例庚/g },
  { name: '好友-示例壬', re: /示例壬/g },
  { name: '好友-示例己', re: /示例己/g },
  { name: '好友-QQ号', re: /\b(1022848171|2693084180|3217432735|1639974490)\b/g },
  { name: '绝对路径', re: /C:\\\\Users\\\\[A-Za-z]+/g },
];

let hits = 0;
const report = [];

for (const rel of files) {
  const abs = `${root}/${rel}`;
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > 5_000_000) continue;
  // 二进制跳过
  if (/\.(pdf|png|jpg|webp|gif|ico|zip)$/i.test(rel)) {
    report.push({ rel, note: '二进制（未扫文本）' });
    continue;
  }
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of SENSITIVE) {
    const m = text.match(re);
    if (m) {
      hits++;
      report.push({ rel, name, count: m.length, sample: m.slice(0, 3).join(', ') });
    }
  }
}

console.log(`扫描 ${files.length} 个文件\n`);
if (!hits) {
  console.log('✅ 没有发现敏感内容');
} else {
  console.log(`⚠️ 命中 ${hits} 处：`);
  for (const r of report.filter((x) => x.name)) {
    console.log(`  ${r.rel}  [${r.name}] ×${r.count}  ${r.sample}`);
  }
}
const bin = report.filter((r) => r.note);
if (bin.length) console.log(`\n未做文本扫描的二进制：${bin.map((b) => b.rel).join(', ')}`);
