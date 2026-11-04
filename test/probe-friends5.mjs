import { ensureBrowser, closeBrowser } from "../scripts/lib/browser.mjs";
import { newPage, goto, evaluate } from "../scripts/lib/cdp.mjs";
import { injectSession } from "../scripts/lib/session.mjs";
import { loadConfig } from "../scripts/lib/store.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const cfg = loadConfig();
const handle = await ensureBrowser({ headless: true });
const { sessionId } = await newPage(handle.cdp, "about:blank");
await injectSession(handle.cdp);
await goto(handle.cdp, sessionId, `https://user.qzone.qq.com/${cfg.account.uin}/myhome/friends/index`, 40000);
await sleep(8000);

const info = await evaluate(handle.cdp, sessionId, `(() => {
  const f = [...document.querySelectorAll("iframe")].find(x => (x.src||"").includes("pages/friends"));
  const d = f.contentDocument;
  const scoreEl = d.querySelector(".score .count");
  let node = scoreEl;
  const chain = [];
  for (let i=0;i<5 && node;i++){ chain.push(node.tagName + "." + String(node.className).split(" ")[0]); node = node.parentElement; }
  // 找到包住分数的"整条"容器
  const row = scoreEl.closest("li, .item, [class*=friend]");
  return { chain, rowHtml: row ? row.outerHTML.slice(0, 900) : null };
})()`);
console.log(JSON.stringify(info, null, 2));
await closeBrowser(handle);
