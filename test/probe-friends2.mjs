import { ensureBrowser, closeBrowser } from "../scripts/lib/browser.mjs";
import { newPage, goto, evaluate } from "../scripts/lib/cdp.mjs";
import { injectSession } from "../scripts/lib/session.mjs";
import { loadConfig } from "../scripts/lib/store.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const cfg = loadConfig();
const uin = cfg.account.uin;
const handle = await ensureBrowser({ headless: true });
const { sessionId } = await newPage(handle.cdp, "about:blank");
await injectSession(handle.cdp);
await goto(handle.cdp, sessionId, `https://user.qzone.qq.com/${uin}`, 30000);
await sleep(4000);

const links = await evaluate(handle.cdp, sessionId, `(() => {
  const out = [];
  for (const a of document.querySelectorAll("a")) {
    const t = (a.textContent || "").trim();
    if (/好友|friend/i.test(t) || /friend/i.test(a.href || "")) {
      out.push({ text: t.slice(0,10), href: (a.href||"").slice(0,120) });
    }
  }
  return out.slice(0, 15);
})()`);
console.log("导航里的好友链接:");
console.log(JSON.stringify(links, null, 2));

// 也试 myhome/friends 的 iframe
const { sessionId: s2 } = await newPage(handle.cdp, "about:blank");
await injectSession(handle.cdp);
await goto(handle.cdp, s2, `https://user.qzone.qq.com/${uin}/myhome/friends`, 30000);
await sleep(6000);
const info = await evaluate(handle.cdp, s2, `(() => {
  const ifs = [...document.querySelectorAll("iframe")].map(f => (f.src||"").slice(0, 150));
  const txt = document.body.innerText || "";
  return { url: location.href, iframes: ifs, bodyLen: txt.length, hasIntimacy: /亲密度/.test(txt) };
})()`);
console.log("\nmyhome/friends:", JSON.stringify(info, null, 2));
await closeBrowser(handle);
