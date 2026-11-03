// 可行性探针：headless Edge 打开 QQ 空间，看是已登录还是停在扫码页
// 用法：node test/probe.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureBrowser, closeBrowser } from '../scripts/lib/browser.mjs';
import { newPage, goto, evaluate, screenshot } from '../scripts/lib/cdp.mjs';
import { paths } from '../scripts/lib/store.mjs';

const handle = await ensureBrowser({ headless: true });
console.log('浏览器:', handle.browserPath, '| 端口:', handle.port, '| 复用:', handle.reused);

const { sessionId } = await newPage(handle.cdp, 'about:blank');
await goto(handle.cdp, sessionId, 'https://user.qzone.qq.com/', 40000).catch((e) => console.log('goto:', e.message));
await sleep(4000);

const info = await evaluate(
  handle.cdp,
  sessionId,
  `({
     url: location.href,
     title: document.title,
     bodyLen: document.body ? document.body.innerText.length : 0,
     text: document.body ? document.body.innerText.slice(0, 500) : '',
     hasQR: !!document.querySelector('iframe[src*="ptlogin"], #qrlogin, canvas, img[src*="qrcode"]'),
     iframes: [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 5),
   })`,
);
console.log(JSON.stringify(info, null, 2));

const png = await screenshot(handle.cdp, sessionId);
const out = join(paths().outDir, 'probe.png');
const { mkdirSync } = await import('node:fs');
mkdirSync(paths().outDir, { recursive: true });
writeFileSync(out, png);
console.log('截图:', out, png.length, 'bytes');

await closeBrowser(handle);
