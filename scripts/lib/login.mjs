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

const LOGIN_URL = 'https://user.qzone.qq.com/';
//: 登录成功后地址形如 https://user.qzone.qq.com/1234567890
const LOGGED_IN = /user\.qzone\.qq\.com\/(\d{5,})/;

/** 当前页面是不是已经登录了 */
export async function detectLogin(cdp, sessionId) {
  const href = await evaluate(cdp, sessionId, 'location.href');
  const m = String(href).match(LOGGED_IN);
  if (m) return { loggedIn: true, uin: m[1], url: href };
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
 * @param {(p:string)=>void} opts.onQr 二维码生成/刷新时的回调
 */
export async function login({ timeoutSec = 180, onQr } = {}) {
  const { outDir } = paths();
  mkdirSync(outDir, { recursive: true });
  const qrPath = join(outDir, 'login-qr.png');

  const handle = await ensureBrowser({ headless: true });
  const { sessionId } = await newPage(handle.cdp, 'about:blank');

  try {
    await goto(handle.cdp, sessionId, LOGIN_URL, 40_000);
    await sleep(2500);

    // 已经登录过就直接返回（用户重复执行 login 时不折腾）
    let state = await detectLogin(handle.cdp, sessionId);
    if (state.loggedIn) {
      await persistAccount(handle.cdp, sessionId, state.uin);
      return { ok: true, already: true, ...state, qrPath: null };
    }

    await captureQr(handle.cdp, sessionId, qrPath);
    onQr?.(qrPath);

    const deadline = Date.now() + timeoutSec * 1000;
    let lastRefresh = Date.now();

    while (Date.now() < deadline) {
      await sleep(2000);
      state = await detectLogin(handle.cdp, sessionId);
      if (state.loggedIn) {
        // 等空间首页把用户信息写进 cookie / DOM
        await sleep(1500);
        const account = await persistAccount(handle.cdp, sessionId, state.uin);
        return { ok: true, already: false, ...state, account, qrPath };
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
      `(document.querySelector('#QZ_Bg_Title, .head-name, #QZ_Bg_Title a')?.textContent || document.title || '').trim()`,
    );
  } catch {
    /* 昵称拿不到不影响主流程 */
  }
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

/** 读当前登录态（不开新页面也能判断：配置里有 uin + 浏览器目录在） */
export function cachedAccount() {
  const cfg = loadConfig();
  const { profileDir } = paths();
  const hasProfile = existsSync(profileDir);
  return { uin: cfg.account?.uin || '', nickname: cfg.account?.nickname || '', hasProfile };
}

/** 退出登录：删掉浏览器配置目录（登录态就在里面） */
export async function logout() {
  const { profileDir } = paths();
  const { rm } = await import('node:fs/promises');
  await rm(profileDir, { recursive: true, force: true });
  const cfg = loadConfig();
  cfg.account = { uin: '', nickname: '' };
  saveConfig(cfg);
}
