// 登录态的导出与注入。
//
// 为什么需要这一层：
//   QQ 空间的 p_skey / p_uin / skey / uin 全是 **session cookie**（Chromium 里
//   is_persistent=0）。它们只活在内存里，浏览器一关就没了 —— 也就是说
//   「用 profile 目录记住登录」这件事对它们不成立。
//
//   所以登录成功的那一刻必须把 cookie 抓出来存到磁盘，之后每次起浏览器再注入回去。
//   注入时把 expires 从 -1（session）改成未来时间，Chromium 才会把它当持久 cookie。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './store.mjs';

const KEEP_DAYS = 30;

function sessionFile() {
  return join(paths().home, 'session.json');
}

/** 只留 QQ 相关的 cookie，别把整个浏览器的 cookie 都存下来 */
function pickQq(cookies) {
  return cookies.filter((c) => c.domain && c.domain.includes('qq.com'));
}

/**
 * 把当前浏览器里的 QQ cookie 导出到磁盘。
 * @returns {{count:number, file:string, exportedAt:string}}
 */
export async function exportSession(cdp) {
  const { cookies } = await cdp.send('Storage.getCookies');
  const now = Date.now() / 1000;
  const keepUntil = now + KEEP_DAYS * 86_400;

  const out = pickQq(cookies).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? '/',
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite ?? 'None',
    // session cookie（expires=-1）换成未来时间，否则注入后还是 session
    expires: c.expires && c.expires > 0 ? c.expires : keepUntil,
  }));

  const { home } = paths();
  mkdirSync(home, { recursive: true });
  const file = sessionFile();
  writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), cookies: out }, null, 2), 'utf8');
  return { count: out.length, file, exportedAt: new Date().toISOString() };
}

/**
 * 把磁盘上的 cookie 注入浏览器。
 * 返回注入了几条；没有 session.json 时返回 0（调用方据此提示「还没登录」）。
 */
export async function injectSession(cdp) {
  const file = sessionFile();
  if (!existsSync(file)) return { count: 0, file };

  let cookies;
  try {
    ({ cookies } = JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { count: 0, file, error: 'session.json 不是合法 JSON' };
  }
  if (!Array.isArray(cookies) || !cookies.length) return { count: 0, file };

  // 过期的就不注入了，注了也没用
  const now = Date.now() / 1000;
  const alive = cookies.filter((c) => !c.expires || c.expires > now);
  if (!alive.length) return { count: 0, file, expired: true };

  // Chromium 的校验比导出的字段严：SameSite=None 必须同时 Secure，
  // 非 Secure 的 cookie 带 SameSite=None 会被整条拒掉（报 Invalid cookie fields）。
  const clean = alive.map((c) => {
    const item = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: Math.floor(c.expires || now + 86_400),
    };
    if (c.secure) item.secure = true;
    if (c.httpOnly) item.httpOnly = true;
    if (c.secure && (c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict')) {
      item.sameSite = c.sameSite;
    }
    return item;
  });

  // 逐条注入：批量注入时只要有一条字段不合法，整批都会失败，排查起来很痛苦
  let ok = 0;
  const failed = [];
  for (const c of clean) {
    try {
      await cdp.send('Storage.setCookies', { cookies: [c] });
      ok++;
    } catch (e) {
      failed.push({ name: c.name, domain: c.domain, reason: e.message });
    }
  }
  return { count: ok, file, failed: failed.length ? failed : undefined };
}

/** 本地是否存着登录态（不代表还有效） */
export function hasSession() {
  return existsSync(sessionFile());
}

/** 删掉登录态文件 */
export async function clearSession() {
  const { unlink } = await import('node:fs/promises');
  await unlink(sessionFile()).catch(() => {});
}
