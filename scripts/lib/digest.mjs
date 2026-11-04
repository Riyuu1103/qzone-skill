// 摘要（digest）与兴趣模型。
//
// 目标：用尽量少的 token，把「值得看的那几条」呈现给调用方。
//   1) 只输出短键 JSON（t/a/x/n/s），不重复长字段；
//   2) 按用户自己的口味排序 —— 口味来自「他赞过谁」，不是我们猜的；
//   3) 带图的可选下载到本地，给的是短路径而不是几百字符的图片 URL。
//
// 为什么用「赞过谁」当口味信号：那是用户唯一主动表达过的偏好，
// 不需要额外打标签，也不会因为我们的猜测而失真。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { paths } from './store.mjs';

function prefsFile() {
  return join(paths().home, 'prefs.json');
}

export function loadPrefs() {
  const f = prefsFile();
  if (!existsSync(f)) return { authors: {}, likedSamples: 0, updatedAt: null };
  try {
    return { authors: {}, likedSamples: 0, updatedAt: null, ...JSON.parse(readFileSync(f, 'utf8')) };
  } catch {
    return { authors: {}, likedSamples: 0, updatedAt: null };
  }
}

export function savePrefs(p) {
  const { home } = paths();
  mkdirSync(home, { recursive: true });
  writeFileSync(prefsFile(), JSON.stringify(p, null, 2), 'utf8');
}

/**
 * 从已赞的动态里学习口味：谁的内容你赞得多，谁的权重就高。
 * 权重用对数衰减，避免某个人刷屏就把权重顶死。
 */
export function learnFrom(items) {
  const prefs = loadPrefs();
  let added = 0;
  for (const it of items) {
    if (!it.liked || !it.name) continue;
    prefs.authors[it.name] = (prefs.authors[it.name] || 0) + 1;
    added++;
  }
  prefs.likedSamples = (prefs.likedSamples || 0) + added;
  prefs.updatedAt = new Date().toISOString();
  savePrefs(prefs);
  return { added, authors: Object.keys(prefs.authors).length, likedSamples: prefs.likedSamples };
}

/** 对权重做对数压缩，返回 0~3 之间的加成 */
function authorBoost(name, prefs) {
  const n = prefs.authors?.[name] || 0;
  if (!n) return 0;
  return Math.min(3, Math.log2(n + 1));
}

/**
 * 给一条动态打分。分数只用来排序，不代表好坏。
 *   + 作者是你常赞的人（对数权重）
 *   + 带图（更可能是你愿意点开看的）
 *   + 正文更长（短句多为吐槽，长文更有信息量）
 */
export function scoreItem(item, prefs) {
  let s = 1;
  s += authorBoost(item.name, prefs);
  if (item.imgCount > 0) s += 0.5 + Math.min(0.5, item.imgCount * 0.1);
  const len = (item.text || '').length;
  if (len > 80) s += 0.4;
  else if (len > 30) s += 0.2;
  return Math.round(s * 10) / 10;
}

/** 按文件头猜真实格式（qpic 经常返回 webp，但 URL 后缀写的是 jpg） */
function extOf(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'webp';
  if (buf.length > 3 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return 'bin';
}

/** 把图片下载到本地，返回短路径（失败返回 null，不影响主流程） */
async function downloadImage(url, key) {
  try {
    const res = await fetch(url, {
      headers: {
        // qpic 对 referer 不算严，但带上更稳
        Referer: 'https://user.qzone.qq.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) return null;
    const { outDir } = paths();
    const dir = join(outDir, 'img');
    mkdirSync(dir, { recursive: true });
    const name = createHash('sha1').update(key + url).digest('hex').slice(0, 10) + '.' + extOf(buf);
    const file = join(dir, name);
    writeFileSync(file, buf);
    return { file, bytes: buf.length };
  } catch {
    return null;
  }
}

/**
 * 生成摘要。
 * @param {object} opts
 * @param {object[]} opts.items 已读到的动态
 * @param {number} opts.top 输出几条（默认 8）
 * @param {boolean} opts.withImages 是否把首图下载到本地
 * @param {number} opts.textLen 每条正文截断长度（默认 80）
 */
export async function buildDigest(items, { top = 8, withImages = false, textLen = 80 } = {}) {
  const prefs = loadPrefs();
  const scored = items
    .filter((it) => it.key) // 广告卡没有 key，直接排除
    .map((it) => ({ it, s: scoreItem(it, prefs) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, top);

  const out = [];
  for (const { it, s } of scored) {
    const row = {
      t: it.time || '',
      a: it.name || '',
      x: (it.text || '').replace(/\s+/g, ' ').slice(0, textLen),
      n: it.imgCount || 0,
      s,
      k: it.key.slice(0, 10), // 短 id，够用来点赞；完整 id 用 feed 取
    };
    if (it.liked) row.L = 1;
    if (withImages && it.imgCount) {
      const got = await downloadImage(it.imgs[0], it.key);
      if (got) row.p = got.file; // 本地绝对路径，AI 可以直接读图
    }
    out.push(row);
  }

  return {
    ok: true,
    total: items.length,
    shown: out.length,
    prefs: { likedSamples: prefs.likedSamples || 0, authors: Object.keys(prefs.authors || {}).length },
    items: out,
  };
}
