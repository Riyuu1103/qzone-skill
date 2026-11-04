#!/usr/bin/env node
// QQ 空间命令行入口。
//
// 设计目标：让「另一个 AI agent」也能直接调用 ——
//   1) 每个命令只做一件事，参数少、语义直白；
//   2) 一律输出 JSON（--pretty 给人看），成功带 ok:true，失败带 ok:false + reason；
//   3) 不读任何人的私人偏好，所有可变配置都在 config.json 里，用户自己设。

import { existsSync } from 'node:fs';
import { login, logout, cachedAccount } from './lib/login.mjs';
import { loadConfig, saveConfig, getPath, setPath, paths, isPaused, setPaused } from './lib/store.mjs';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const rest = argv.slice(1);

/** 极简参数解析：--key value / --flag / 位置参数 */
function parseArgs(list) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

function out(obj, flags) {
  if (flags.pretty || process.stdout.isTTY) console.log(JSON.stringify(obj, null, 2));
  else console.log(JSON.stringify(obj));
}

function fail(reason, extra = {}) {
  console.log(JSON.stringify({ ok: false, reason, ...extra }));
  process.exitCode = 1;
}

const HELP = `QQ 空间工具

  node scripts/qzone.mjs login            扫码登录（无窗口，二维码会存成图片）
  node scripts/qzone.mjs login --headed   扫码登录（弹出真窗口，直接在屏幕上扫）
  node scripts/qzone.mjs status           看登录态 / 开关 / 关键配置
  node scripts/qzone.mjs logout           退出登录（清掉登录态）
  node scripts/qzone.mjs config           看全部配置
  node scripts/qzone.mjs config <键> <值>  改一项配置，键用点号，如 auto.like.maxPerRun
  node scripts/qzone.mjs feed             读好友动态
  node scripts/qzone.mjs digest           摘要（按你赞过谁排序，最省 token）
  node scripts/qzone.mjs digest --images  摘要并把首图下载到本地
  node scripts/qzone.mjs learn            从你赞过的动态里学习口味
  node scripts/qzone.mjs bench            测各输出格式的 token 占用
  node scripts/qzone.mjs like <动态id>     给一条动态点赞
  node scripts/qzone.mjs auto             跑一轮：读动态 + 按规则点赞
  node scripts/qzone.mjs on | off         一键开启 / 关闭自动刷
  node scripts/qzone.mjs pause | resume   紧急刹车（不改配置，让运行中的循环立刻停手）
  node scripts/qzone.mjs service status   看系统定时任务装没装
  node scripts/qzone.mjs service install --interval 30   挂成定时任务（关掉终端也会跑）
  node scripts/qzone.mjs service uninstall               卸掉定时任务

通用参数：
  --pretty    人看的缩进输出（默认在终端里自动开启）
  --json      强制紧凑输出（给别的程序调用时用）
`;

async function main() {
  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case 'login': {
      const timeoutSec = Number(flags.timeout ?? 180);
      const headed = Boolean(flags.headed);
      const res = await login({
        timeoutSec,
        headless: !headed,
        onQr: (p) => {
          // 打到 stderr，避免污染 JSON 输出
          console.error(`\n[qzone] 请用手机 QQ 扫码登录：${p}${headed ? '（也可以直接扫弹出的窗口）' : ''}\n`);
        },
      });
      if (!res.ok) return fail('扫码超时，二维码已过期。重新执行 login 即可', { qrPath: res.qrPath });
      return out({ ok: true, uin: res.uin, nickname: res.account?.nickname ?? '', already: res.already, qrPath: res.qrPath }, flags);
    }

    case 'logout': {
      await logout();
      return out({ ok: true, message: '已退出登录，登录态目录已删除' }, flags);
    }

    case 'status': {
      const cfg = loadConfig();
      const acc = cachedAccount();
      // 真正的判据是 session.json 在不在，光有 uin 是假的
      const loggedIn = Boolean(acc.uin && acc.hasSession);
      return out(
        {
          ok: true,
          loggedIn,
          account: { uin: acc.uin, nickname: acc.nickname },
          hasSession: acc.hasSession,
          hint: loggedIn ? undefined : acc.uin ? '有账号记录但登录凭证已丢失，需要重新 login' : '还没登录过',
          paused: isPaused(),
          auto: { enabled: cfg.auto.enabled, intervalMinutes: cfg.auto.intervalMinutes, like: cfg.auto.like },
          home: paths().home,
        },
        flags,
      );
    }

    case 'config': {
      const cfg = loadConfig();
      if (positional.length === 0) return out({ ok: true, config: cfg, file: paths().configFile }, flags);
      const [key, ...valueParts] = positional;
      if (valueParts.length === 0) {
        return out({ ok: true, key, value: getPath(cfg, key) }, flags);
      }
      const rawValue = valueParts.join(' ');
      setPath(cfg, key, rawValue);
      saveConfig(cfg);
      return out({ ok: true, key, value: getPath(cfg, key) }, flags);
    }

    case 'on':
    case 'off': {
      // 只改「自动刷」这个开关，不碰紧急刹车（pause）
      const enable = command === 'on';
      const cfg = loadConfig();
      cfg.auto.enabled = enable;
      saveConfig(cfg);
      return out({ ok: true, autoEnabled: enable, paused: isPaused() }, flags);
    }

    case 'pause':
    case 'resume': {
      // 紧急刹车：不改配置，只让正在跑的循环立刻停手（比如临时不想让它动）
      setPaused(command === 'pause');
      return out({ ok: true, paused: isPaused(), autoEnabled: loadConfig().auto.enabled }, flags);
    }

    case 'service': {
      // 把自动刷挂成系统定时任务（Windows 计划任务 / 其他平台给 crontab 建议）
      const mod = await import('./lib/service.mjs');
      const sub = positional[0] ?? 'status';
      if (sub === 'install') return out(await mod.install({ intervalMinutes: Number(flags.interval ?? 30) }), flags);
      if (sub === 'uninstall') return out(await mod.uninstall(), flags);
      return out(await mod.status(), flags);
    }

    case 'feed':
    case 'like':
    case 'auto':
    case 'watch':
    case 'explore':
    case 'digest':
    case 'learn':
    case 'bench': {
      // 这几个要开浏览器，延迟加载，保证 help / config 这类命令秒回
      const mod = await import('./lib/actions.mjs');
      return mod.run(command, { ...flags, _: positional }, { out, fail });
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      console.error(`不认识的命令：${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, reason: e.message, stack: e.stack?.split('\n').slice(0, 4) }));
  process.exitCode = 1;
});
