import { ensureBrowser, closeBrowser } from "../scripts/lib/browser.mjs";
import { newPage, goto, evaluate } from "../scripts/lib/cdp.mjs";
import { injectSession } from "../scripts/lib/session.mjs";
import { loadConfig } from "../scripts/lib/store.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const cfg = loadConfig();
const url = `https://user.qzone.qq.com/${cfg.account.uin}/myhome/friends/index`;
const handle = await ensureBrowser({ headless: true });
const { sessionId } = await newPage(handle.cdp, "about:blank");
await injectSession(handle.cdp);
await goto(handle.cdp, sessionId, url, 40000);
await sleep(8000);

const info = await evaluate(handle.cdp, sessionId, `(() => {
  const f = [...document.querySelectorAll("iframe")].find(x => (x.src||"").includes("pages/friends"));
  const d = f.contentDocument;
  // 找出可能的列表项容器
  const cand = {};
  for (const sel of ["li","[class*=item]","[class*=friend]","[class*=list]","tr","dd"]) {
    cand[sel] = d.querySelectorAll(sel).length;
  }
  // 找带数字的短元素（分数）
  const scoreLike = [...d.querySelectorAll("*")].filter(e => e.children.length === 0 && /^\\d{1,3}$/.test((e.textContent||"").trim())).slice(0,5).map(e => ({ tag: e.tagName, cls: (e.className||"").toString().slice(0,40), v: e.textContent.trim(), parentCls: (e.parentElement?.className||"").toString().slice(0,40) }));
  // dump 前两个列表项
  const lis = [...d.querySelectorAll("li")].slice(0,2).map(li => li.outerHTML.slice(0, 700));
  return { cand, scoreLike, lis };
})()`);
console.log(JSON.stringify(info, null, 2));
await closeBrowser(handle);
