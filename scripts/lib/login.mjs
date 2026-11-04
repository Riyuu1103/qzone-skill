// 扫码登录：用无窗口的 Edge 打开 QQ 空间登录页，把二维码截成图片，
// 用户用手机 QQ 扫一下即可。整个过程不弹出任何可见窗口。
//
// 为什么必须扫码：
//   QQ 空间没有可用的账号密码接口，唯一稳的登录方式就是手机 QQ 扫码。
//   扫码拿到的登录态会留在独立的浏览器配置目录里（--user-data-dir），
//   之后所有操作都复用这份登录态，不用再扫。

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureBrowser, closeBrowser } from './browser.mjs';
import { newPage, goto, evaluate, screenshot } from './cdp.mjs';
import { paths, loadConfig, saveConfig } from './store.mjs';
import { exportSession, injectSession, clearSession, hasSession } from './session.mjs';

const LOGIN_URL = 'https://user.qzone.qq.com/';
//: 登录成功后地址形如 https://user.qzone.qq.com/1234567890
const LOGGED_IN = /user\.qzone\.qq\.com\/(\d{5,})/;

/** 当前页面是不是已经登录了 */
export async function detectLogin(cdp, sessionId) {
  const href = await evaluate(cdp, sessionId, 'location.href');
  const m = String(href).match(LOGGED_IN);
  if (m) return { loggedIn: true, uin: m[1], url: href };

  // 兜底：URL 有时不会变成 /<uin>（会先在 i.qq.com 中转），但登录成功后
  // 一定会下发 p_skey / skey 这两个 cookie。只看 cookie 名，不解密、不打印值。
  try {
    const { cookies } = await cdp.send('Storage.getCookies');
    const has = cookies.some((c) => c.domain.includes('qq.com') && c.name === 'p_skey' && c.value);
    if (has) {
      const uinCookie = cookies.find((c) => c.domain.includes('qq.com') && /^(p_uin|uin|pt2gguin)$/.test(c.name));
      const raw = uinCookie?.value ?? '';
      // p_uin 形如 "o0123456789"；pt2gguin 形如 "o0123456789"
      const uin = raw.replace(/^o0*/i, '');
      if (/^\d{5,}$/.test(uin)) return { loggedIn: true, uin, url: href, via: 'cookie' };
    }
  } catch {
    /* 拿不到 cookie 就按未登录处理 */
  }
  return { loggedIn: false, uin: null, url: href };
}

/** 把登录框（含二维码）截成独立的小图，方便用户直接打开扫 */
async function captureQr(cdp, sessionId, outPath) {
  // 二维码在登录 iframe 里，直接按 iframe 的位置裁剪，比写死坐标抗改版
  const rect = await evaluate(
    cdp,
    sessionId,
    `(() => {
       const f = document.querySelector('iframe[src*="ptlogin"], iframe[src*="xlogin"]');
       if (!f) return null;
       const r = f.getBoundingClientRect();
       return { x: r.x, y: r.y, w: r.width, h: r.height };
     })()`,
  );

  if (rect && rect.w > 100) {
    const { data } = await cdp.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.w, height: rect.h, scale: 2 },
      },
      sessionId,
    );
    writeFileSync(outPath, Buffer.from(data, 'base64'));
  } else {
    // 找不到 iframe 就整页截图兜底，至少用户还能看到二维码在哪
    writeFileSync(outPath, await screenshot(cdp, sessionId));
  }
  return outPath;
}

/**
 * 扫码登录。
 * @param {object} opts
 * @param {number} opts.timeoutSec 等多久（默认 180 秒）
 * @param {boolean} opts.headless  true=不弹窗口（默认），false=弹出真窗口让用户在屏幕上扫
 * @param {(p:string)=>void} opts.onQr 二维码生成/刷新时的回调
 */
export async function login({ timeoutSec = 180, headless = true, onQr } = {}) {
  const { outDir } = paths();
  mkdirSync(outDir, { recursive: true });
  const qrPath = join(outDir, 'login-qr.png');

  // 有头模式必须先关掉可能残留的无头实例，否则会复用它、窗口永远不出现
  if (!headless) {
    const old = await ensureBrowser({ headless: true }).catch(() => null);
    if (old) await closeBrowser(old).catch(() => {});
  }

  const handle = await ensureBrowser({ headless, reuse: headless });
  let { sessionId } = await newPage(handle.cdp, 'about:blank');

  try {
    // 先把上次导出的登录态注回去，否则每次都判定成「未登录」要重扫
    await injectSession(handle.cdp).catch(() => {});
    await goto(handle.cdp, sessionId, LOGIN_URL, 40_000);
    await sleep(2500);

    // 已经登录过就直接返回（用户重复执行 login 时不折腾）
    let state = await detectLogin(handle.cdp, sessionId).catch(() => ({ loggedIn: false, uin: null }));
    if (state.loggedIn) {
      await persistAccount(handle.cdp, sessionId, state.uin);
      // 已经登录也要重新导出一次：session cookie 每次浏览器重启都会丢
      const saved = await exportSession(handle.cdp);
      return { ok: true, already: true, ...state, qrPath: null, saved };
    }

    await captureQr(handle.cdp, sessionId, qrPath);
    onQr?.(qrPath);

    const deadline = Date.now() + timeoutSec * 1000;
    let lastRefresh = Date.now();
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      await sleep(2000);

      // 页面跳转 / 重载期间 evaluate 会卡住甚至超时。这种情况不能让整个登录崩掉，
      // 重开一个标签页接着等就行（二维码会重新渲染，重截一张即可）。
      try {
        state = await detectLogin(handle.cdp, sessionId);
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        if (consecutiveErrors >= 2) {
          try {
            const fresh = await newPage(handle.cdp, 'about:blank');
            sessionId = fresh.sessionId;
            await goto(handle.cdp, sessionId, LOGIN_URL, 40_000);
            await sleep(2000);
            await captureQr(handle.cdp, sessionId, qrPath);
            onQr?.(qrPath);
            lastRefresh = Date.now();
          } catch {
            /* 重开也失败就继续下一轮 */
          }
          consecutiveErrors = 0;
        }
        continue;
      }

      if (state.loggedIn) {
        // 等空间首页把用户信息写进 cookie / DOM
        await sleep(1500);
        const account = await persistAccount(handle.cdp, sessionId, state.uin);
        // 关键：session cookie 关浏览器就没了，这里趁它还在内存里抓出来存盘
        const saved = await exportSession(handle.cdp);
        return { ok: true, already: false, ...state, account, qrPath, saved };
      }
      // 二维码约 2 分钟过期，页面会自己轮换；这里定时重截，保证用户看到的是有效的
      if (Date.now() - lastRefresh > 25_000) {
        lastRefresh = Date.now();
        await captureQr(handle.cdp, sessionId, qrPath).catch(() => {});
        onQr?.(qrPath);
      }
    }
    return { ok: false, reason: 'timeout', qrPath };
  } finally {
    await closeBrowser(handle);
  }
}

/** 登录成功：把 uin 和昵称写进配置，方便后续调用接口 */
async function persistAccount(cdp, sessionId, uin) {
  let nickname = '';
  try {
    nickname = await evaluate(
      cdp,
      sessionId,
      `(document.querySelector('#QZ_Bg_Title, .head-name, #QZ_Bg_Title a, .qz-name')?.textContent || document.title || '').trim()`,
    );
  } catch {
    /* 昵称拿不到不影响主流程 */
  }

  // 空间首页的 title 形如「某某的空间 [http://123.qzone.qq.com]」，
  // 直接当昵称很脏，这里把网址和「的空间」后缀去掉
  nickname = String(nickname ?? '')
    .replace(/\s*\[https?:\/\/[^\]]*\]/gi, '')
    .replace(/\s*的空间$/, '')
    .trim();

  // 有些页面拿不到昵称，退化用 cookie 里的昵称字段
  if (!nickname) {
    try {
      const cookies = await cdp.send('Storage.getCookies');
      const ck = Object.fromEntries(
        cookies.cookies.filter((c) => c.domain.includes('qq.com')).map((c) => [c.name, c.value]),
      );
      nickname = ck.qz_nickname ? decodeURIComponent(ck.qz_nickname) : '';
    } catch {
      /* 忽略 */
    }
  }

  const cfg = loadConfig();
  cfg.account = { uin: String(uin), nickname: nickname || cfg.account?.nickname || '' };
  saveConfig(cfg);
  return cfg.account;
}

/** 读当前登录态（不开浏览器也能判断） */
export function cachedAccount() {
  const cfg = loadConfig();
  const { profileDir } = paths();
  return {
    uin: cfg.account?.uin || '',
    nickname: cfg.account?.nickname || '',
    hasProfile: existsSync(profileDir),
    // 配置里有 uin 不代表真能登进去：session.json 才是真正的凭证
    hasSession: hasSession(),
  };
}

/** 退出登录：删掉浏览器配置目录（登录态就在里面），并清掉导出的 session */
export async function logout() {
  const { profileDir } = paths();
  const { rm } = await import('node:fs/promises');
  await rm(profileDir, { recursive: true, force: true });
  await clearSession();
  const cfg = loadConfig();
  cfg.account = { uin: '', nickname: '' };
  saveConfig(cfg);
}
