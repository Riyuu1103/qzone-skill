// 配置与状态：一切可变的用户数据都落在配置目录里，不进代码库、不进仓库。
//
// 目录位置（可用环境变量 QZONE_HOME 覆盖）：
//   Windows : %APPDATA%\qzone-skill
//   其他     : ~/.qzone-skill
//
// 里面有什么：
//   config.json   用户配置（偏好、开关、通知方式）
//   state.json    运行状态（已点赞过的动态 id、上次运行时间）—— 用来去重，别手改
//   browser\      headless Edge 的独立配置目录（登录态就在这里面）
//   out\          截图、导出的 JSON 之类

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function homeDir() {
  if (process.env.QZONE_HOME) return process.env.QZONE_HOME;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'qzone-skill');
  }
  return join(homedir(), '.qzone-skill');
}

export function paths() {
  const home = homeDir();
  return {
    home,
    configFile: join(home, 'config.json'),
    stateFile: join(home, 'state.json'),
    profileDir: join(home, 'browser'),
    outDir: join(home, 'out'),
    logDir: join(home, 'logs'),
  };
}

/** 默认配置：全部是通用值，不含任何人的账号、偏好或习惯 */
export const DEFAULT_CONFIG = {
  // 登录后自动写入
  account: { uin: '', nickname: '' },
  browser: { path: '', headless: true },

  // 自动刷（定时轮询好友动态 + 按规则点赞）
  auto: {
    enabled: false,
    intervalMinutes: 30,
    like: {
      enabled: true,
      // 只给这些人的动态点赞（留空 = 不按人筛选）
      allowUsers: [],
      // 永远不赞这些人的动态
      denyUsers: [],
      // 单次最多赞几条，防止一次刷太多触发风控
      maxPerRun: 10,
      // 两条点赞之间隔多久（秒），别调太小
      minIntervalSec: 8,
      // 多久之内的动态才赞（小时），老动态不补赞
      maxAgeHours: 24,
      // 含这些词的动态不赞（留空 = 不筛选）
      denyKeywords: [],
    },
  },

  // 结果通知：不配就只在终端打印
  notify: {
    // 任意可执行命令，通知内容通过环境变量 QZONE_TEXT 传入
    command: '',
    // 或 POST 一个 JSON 到某个 webhook
    webhook: '',
  },

  // 每次运行都留一份 JSON 到 out\ 里，方便排查
  saveRaw: false,
};

/** 深合并：只补缺失的键，数组整体替换 */
function merge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch ?? {})) {
      out[k] = k in base ? merge(base[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

export function loadConfig() {
  const { configFile } = paths();
  if (!existsSync(configFile)) return structuredClone(DEFAULT_CONFIG);
  try {
    return merge(structuredClone(DEFAULT_CONFIG), JSON.parse(readFileSync(configFile, 'utf8')));
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${configFile}\n${e.message}`);
  }
}

export function saveConfig(cfg) {
  const { home, configFile } = paths();
  mkdirSync(home, { recursive: true });
  writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 按点号路径读配置，例如 get('auto.like.maxPerRun') */
export function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/** 按点号路径写配置。值会尽量按原类型转换（数字/布尔/JSON/字符串） */
export function setPath(obj, dotted, rawValue) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  const last = keys.at(-1);
  cur[last] = coerce(rawValue, cur[last]);
  return obj;
}

/**
 * 把命令行里的字符串转成合适的类型。
 * 以当前值的类型为准：原来是布尔就认 true/false/1/0，原来是数组就按 JSON 或逗号分隔。
 */
export function coerce(raw, current) {
  if (typeof current === 'boolean') return /^(1|true|yes|on|y)$/i.test(String(raw).trim());
  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`需要数字，收到：${raw}`);
    return n;
  }
  if (Array.isArray(current)) {
    const s = String(raw).trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr;
      } catch {
        /* 退回逗号分隔 */
      }
    }
    return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  }
  if (current && typeof current === 'object') {
    try {
      return JSON.parse(String(raw));
    } catch {
      throw new Error(`需要 JSON 对象，收到：${raw}`);
    }
  }
  return String(raw);
}

/** 运行状态（去重 / 水位）。文件坏了就当空的重来，不让它挡住主流程 */
export function loadState() {
  const { stateFile } = paths();
  if (!existsSync(stateFile)) return { liked: {}, lastRunAt: null, lastSeenTs: 0 };
  try {
    return { liked: {}, lastRunAt: null, lastSeenTs: 0, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
  } catch {
    return { liked: {}, lastRunAt: null, lastSeenTs: 0 };
  }
}

export function saveState(state) {
  const { home, stateFile } = paths();
  mkdirSync(home, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

/** 一键开关的落点：这个文件存在 = 自动刷被暂停 */
export function pausedFlag() {
  return join(homeDir(), 'PAUSED');
}

export function isPaused() {
  return existsSync(pausedFlag());
}

export function setPaused(on) {
  const { home } = paths();
  mkdirSync(home, { recursive: true });
  if (on) {
    writeFileSync(pausedFlag(), new Date().toISOString(), 'utf8');
  } else if (existsSync(pausedFlag())) {
    unlinkSync(pausedFlag());
  }
}
