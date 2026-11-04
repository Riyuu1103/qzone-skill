// 启动 / 复用 / 关闭一个「无窗口」的 Edge（headless），专门用来访问 QQ 空间。
//
// 为什么是独立配置目录（--user-data-dir）：
//   1) 不碰用户平时用的 Edge，不会把他的标签页弄乱、也不会抢 profile 锁；
//   2) 登录态只落在这个目录里，开关、备份、删除都只动一个文件夹；
//   3) 用户想「换号」直接删目录重扫码即可。
//
// 为什么不用 puppeteer：见 cdp.mjs 顶部注释。这里只依赖系统已有的 Edge。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Cdp, findBrowser, waitForPort } from './cdp.mjs';
import { paths } from './store.mjs';

//: 真实的 Edge UA。headless 默认 UA 里带 "HeadlessChrome"，很多站点（含 QQ）会直接拦。
//: 这里显式覆盖成普通 Edge 的写法，避免「明明是浏览器却被当成爬虫」。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

function argsFor(profileDir, { headless, extraArgs }) {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-popup-blocking',
    '--window-size=1280,900',
    `--user-agent=${UA}`,
    '--lang=zh-CN',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  return args.concat(extraArgs ?? [], ['about:blank']);
}

/** 从 profile 里的 DevToolsActivePort 读出上次用的端口（第一行是端口号） */
function lastPort(profileDir) {
  const f = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(f)) return null;
  try {
    const port = Number(readFileSync(f, 'utf8').split('\n')[0].trim());
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 拿到一个可用的浏览器连接。
 * 已有实例能连上就复用（省 2~3 秒启动时间，也避免多实例抢 profile 锁）。
 * @param {{headless?:boolean, browserPath?:string, extraArgs?:string[], reuse?:boolean}} opts
 *   reuse=false 时强制起新实例（登录要看到真窗口时用）
 */
export async function ensureBrowser({ headless = true, browserPath, extraArgs, reuse = true } = {}) {
  const { profileDir } = paths();
  await mkdir(profileDir, { recursive: true });

  // 1) 先试复用：profile 里记着端口、且 /json/version 还能响应
  //    reuse=false 时跳过 —— 有头登录必须重新起一个真窗口，不能捡现成的无头实例
  const port = reuse ? lastPort(profileDir) : null;
  if (port) {
    try {
      const ver = await waitForPort(port, 1200);
      const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
      return { cdp, port, reused: true, browserPath: findBrowser(browserPath), pid: null };
    } catch {
      /* 连不上就往下走，重新起一个 */
    }
  }

  // 2) 起新实例
  const exe = findBrowser(browserPath);
  if (!exe) {
    throw new Error(
      '没找到 Edge / Chrome。请安装 Microsoft Edge，或用环境变量指定：\n' +
        '  Windows: set QZONE_BROWSER=C:\\path\\to\\msedge.exe\n' +
        '  Linux/macOS: export QZONE_BROWSER=/path/to/chrome',
    );
  }
  const child = spawn(exe, argsFor(profileDir, { headless, extraArgs }), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // 3) 等端口文件出现（Chrome 会在启动完成后写 DevToolsActivePort）
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const p = lastPort(profileDir);
    if (p) {
      try {
        const ver = await waitForPort(p, 1500);
        const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
        return { cdp, port: p, reused: false, browserPath: exe, pid: child.pid };
      } catch {
        /* 端口写了但还没就绪，继续等 */
      }
    }
    await sleep(250);
  }
  throw new Error('浏览器 30 秒内没起来。可以手动跑一次看看报错：\n  ' + exe);
}

/** 关掉浏览器（由我们启动的才关；复用来的走 CDP 的 Browser.close） */
export async function closeBrowser(handle) {
  if (!handle) return;
  try {
    await handle.cdp.send('Browser.close');
  } catch {
    /* 忽略：进程可能已经没了 */
  }
  handle.cdp.close();
}

/** 清空浏览器配置目录（= 退出登录 / 换号 / 重来） */
export async function resetProfile() {
  const { profileDir } = paths();
  await rm(profileDir, { recursive: true, force: true });
}

/** 读一份页面 cookie（用于纯 HTTP 调用接口，免去每次都开页面） */
export async function getAllCookies(cdp, domainFilter = 'qq.com') {
  const { cookies } = await cdp.send('Storage.getCookies');
  return cookies.filter((c) => !domainFilter || c.domain.includes(domainFilter));
}
