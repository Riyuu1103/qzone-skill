// 极简 Chrome DevTools Protocol 客户端（零依赖，只用 Node 内置 fetch / WebSocket）
//
// 用途：驱动一个 headless 的 Edge，在里面执行 JS、读 DOM、截图。
// 之所以自己写而不装 puppeteer / playwright：
//   1) 本机优先复用已装的 Edge，不需要下 300MB 的 Chromium；
//   2) 只用到 Browser / Page / Runtime 三组域，几十行就够；
//   3) 零依赖 = 用户拿到就能跑，不会卡在 npm install 上。

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** 在若干常见位置里找 Edge / Chrome 可执行文件 */
export function findBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.QZONE_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.id != null) {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else slot.resolve(msg.result);
      return;
    }
    // 事件：sessionId 用来区分是哪个 target 的事件
    const key = `${msg.sessionId ?? ''}:${msg.method}`;
    for (const fn of this.handlers.get(key) ?? []) fn(msg.params);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60_000);
    });
  }

  on(method, fn, sessionId = '') {
    const key = `${sessionId}:${method}`;
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key).push(fn);
    return () => {
      const arr = this.handlers.get(key) ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 等一个端口能连上（浏览器启动到监听之间有 1~3 秒空窗） */
export async function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw new Error(`浏览器调试端口 ${port} 在 ${timeoutMs}ms 内没起来: ${lastErr?.message}`);
}

/** 打开一个新标签页并附加调试会话，返回 { sessionId, targetId } */
export async function newPage(cdp, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${new URL(cdp.ws.url).port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`新建标签页失败 HTTP ${res.status}`);
  const target = await res.json();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});
  await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
  await cdp.send('Network.enable', {}, sessionId).catch(() => {});
  return { sessionId, targetId: target.id, target };
}

/** 在页面里跑一段 JS，返回 JSON 化后的值 */
export async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(`页面内脚本报错: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return result?.value;
}

/** 等页面导航完成（或超时后放弃，让调用方自己判断） */
export function waitForLoad(cdp, sessionId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(why);
    };
    const off = cdp.on('Page.loadEventFired', () => finish('load'), sessionId);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/** 导航到某个地址并等加载完成 */
export async function goto(cdp, sessionId, url, timeoutMs = 30_000) {
  const waiter = waitForLoad(cdp, sessionId, timeoutMs);
  await cdp.send('Page.navigate', { url }, sessionId);
  return waiter;
}

/** 截当前页面的图，返回 PNG 的 Buffer */
export async function screenshot(cdp, sessionId, { fullPage = false } = {}) {
  if (fullPage) {
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, sessionId);
  return Buffer.from(data, 'base64');
}
