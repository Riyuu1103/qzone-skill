// 把「自动刷」挂成系统定时任务 —— 这样就不需要一直开着一个终端窗口。
//
// Windows：用计划任务 + 一层 wscript 启动器。
//   为什么要 .vbs：计划任务直接指向 .cmd / node.exe 会创建可见的控制台窗口，
//   每 30 分钟闪一下，很难看。wscript + Run(...,0,...) 是真正的隐藏执行。
//   .vbs 必须是纯 ASCII（wscript 按 ANSI/GBK 读，中文注释会吞掉行尾把下一行代码并进注释）。
//
// macOS / Linux：不自动改 crontab，只打印建议的一行，由用户自己决定（改别人的 crontab 太越界）。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { paths } from './store.mjs';

const exec = promisify(execFile);
const TASK_NAME = 'QZone Auto Like';

const isWin = process.platform === 'win32';

async function schtasks(args) {
  return exec('schtasks.exe', args, { windowsHide: true, timeout: 30_000 });
}

/** 生成纯 ASCII 的隐藏启动器 */
function writeLauncher(intervalMinutes) {
  const { home, logDir } = paths();
  mkdirSync(logDir, { recursive: true });
  const launcher = join(home, 'run-auto.vbs');
  const nodeExe = process.execPath;
  const script = join(import.meta.dirname, '..', 'qzone.mjs');
  const logFile = join(logDir, 'auto.log');

  // 全部用双引号包住路径（本机路径可能带空格）；不写任何中文
  const cmd = `"${nodeExe}" "${script}" auto --json >> "${logFile}" 2>&1`;
  const content =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    `sh.Run "${cmd}", 0, False\r\n`;

  writeFileSync(launcher, content, 'ascii');
  return launcher;
}

export async function install({ intervalMinutes = 30 } = {}) {
  if (!isWin) {
    return {
      ok: false,
      reason: '非 Windows 平台不自动改 crontab，请手动加一行',
      hint: `*/${intervalMinutes} * * * * cd "${join(import.meta.dirname, '..')}" && node scripts/qzone.mjs auto --json >> ${join(paths().logDir, 'auto.log')} 2>&1`,
    };
  }

  const launcher = writeLauncher(intervalMinutes);
  // 先删再建，保证改了间隔能生效
  await schtasks(['/Delete', '/TN', TASK_NAME, '/F']).catch(() => {});

  await schtasks([
    '/Create',
    '/TN', TASK_NAME,
    '/TR', `wscript.exe "${launcher}"`,
    '/SC', 'MINUTE',
    '/MO', String(intervalMinutes),
    '/F',
  ]);

  return { ok: true, task: TASK_NAME, intervalMinutes, launcher, log: join(paths().logDir, 'auto.log') };
}

export async function uninstall() {
  if (!isWin) return { ok: true, reason: '非 Windows 平台无需处理' };
  await schtasks(['/Delete', '/TN', TASK_NAME, '/F']).catch(() => {});
  const { home } = paths();
  const launcher = join(home, 'run-auto.vbs');
  if (existsSync(launcher)) {
    try {
      unlinkSync(launcher);
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true, removed: TASK_NAME };
}

export async function status() {
  if (!isWin) return { ok: true, platform: process.platform, installed: false };
  let installed = false;
  let detail = '';
  try {
    const { stdout } = await exec('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], {
      windowsHide: true,
      timeout: 20_000,
    });
    installed = true;
    detail = stdout.trim();
  } catch {
    installed = false;
  }
  return { ok: true, platform: process.platform, task: TASK_NAME, installed, detail, log: join(paths().logDir, 'auto.log') };
}
