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
  const txt = document.body.innerText || "";
  const kws = {};
  for (const k of ["亲密度","特别关心","分组","好友","最近访客","互动"]) kws[k] = txt.includes(k);
  const ifs = [...document.querySelectorAll("iframe")].map(f => (f.src||"").slice(0,120));
  let inFrame = null;
  const f = [...document.querySelectorAll("iframe")].find(x => (x.src||"").includes("friend"));
  if (f && f.contentDocument) {
    const d = f.contentDocument;
    inFrame = {
      len: (d.body?.innerText||"").length,
      hasIntimacy: /亲密度/.test(d.body?.innerText||""),
      items: d.querySelectorAll("[class*=friend], .friend-item, li").length,
      head: (d.body?.innerText||"").replace(/\\s+/g," ").slice(0,150),
    };
  }
  return { url: location.href, bodyLen: txt.length, kws, iframes: ifs, inFrame,
           head: txt.replace(/\\s+/g," ").slice(0,250) };
})()`);
console.log(JSON.stringify(info, null, 2));
await closeBrowser(handle);
