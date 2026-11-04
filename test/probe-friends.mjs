// 探测「好友」页能不能拿到亲密度
import { ensureBrowser, closeBrowser } from '../scripts/lib/browser.mjs';
import { newPage, goto, evaluate } from '../scripts/lib/cdp.mjs';
import { injectSession } from '../scripts/lib/session.mjs';
import { loadConfig } from '../scripts/lib/store.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const cfg = loadConfig();
const uin = cfg.account.uin;

const urls = [
  `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`,
  `https://user.qzone.qq.com/${uin}/myhome/friends`,
  `https://user.qzone.qq.com/${uin}/friend`,
  `https://user.qzone.qq.com/${uin}/myhome/1`,
];

const handle = await ensureBrowser({ headless: true });

for (const url of urls) {
  const { sessionId } = await newPage(handle.cdp, 'about:blank');
  await injectSession(handle.cdp);
  await goto(handle.cdp, sessionId, url, 30000).catch(() => {});
  await sleep(5000);

  const info = await evaluate(
    handle.cdp,
    sessionId,
    `(() => {
      const txt = document.body.innerText || '';
      const hitIntimacy = txt.match(/亲密度|亲密|互动|经常访问|特别关心/g);
      return {
        url: location.href,
        title: document.title.slice(0, 40),
        bodyLen: txt.length,
        keywords: hitIntimacy ? [...new Set(hitIntimacy)] : [],
        hasFriendList: document.querySelectorAll('[class*="friend"], .mod-friend-list, .friend-list').length,
        head: txt.replace(/\\s+/g, ' ').slice(0, 200),
      };
    })()`,
  );
  console.log(JSON.stringify(info, null, 2));
  console.log('---');
}

await closeBrowser(handle);
