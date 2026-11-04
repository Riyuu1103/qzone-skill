// 摘要（digest）、内容分类与兴趣模型。
//
// 三条设计原则：
//   1) 用「赞的比例」而不是「赞的次数」判断偏好 —— 发得多的人次数天然高，
//      但那不代表你爱看。比例才反映"看到就给赞"的概率。
//   2) 按内容类型再学一层 —— 你可能整体不喜欢某个人，但特别爱看他的画画记录。
//   3) 输出尽量短 —— 每个字段都是要进模型上下文的，能省就省。

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { paths } from './store.mjs';

function prefsFile() {
  return join(paths().home, 'prefs.json');
}

/** 内容类型。顺序有意义：越具体的放前面，先命中先算。 */
const TYPE_RULES = [
  { type: 'recruit', kw: ['扩列', '加我', '互关', '交友', 'qq号', '同好'] },
  { type: 'art', kw: ['画画', '线稿', '上色', '稿子', '摸鱼', '画完', '画了', '涂鸦', '起稿'] },
  { type: 'study', kw: ['数学', '论文', '代码', '考试', '作业', '复习', '证明', '定理', '算法', '讲义'] },
  { type: 'music', kw: ['网易云', '专辑', '音乐', '这首歌', '歌单', '听歌'] },
  { type: 'mood', kw: ['难受', '好烦', '累了', '不想', '崩溃', '焦虑', '想死', '失眠', 'emo'] },
  { type: 'meme', kw: ['哈哈', '笑死', 'hhhh', '梗', '草', '乐', '绷不住'] },
  { type: 'life', kw: ['今天', '吃', '睡', '回家', '出门', '上课', '食堂', '天气'] },
];

/** 给一条动态分类。返回类型名，猜不出就是 other。 */
export function classify(item) {
  const text = `${item.text || ''}`.toLowerCase();
  if (!text) return item.imgCount > 0 ? 'image' : 'other';
  for (const rule of TYPE_RULES) {
    if (rule.kw.some((k) => text.includes(k))) return rule.type;
  }
  if (item.imgCount >= 3) return 'image';
  if (text.length > 120) return 'longtext';
  return 'other';
}

export const ALL_TYPES = [...TYPE_RULES.map((r) => r.type), 'image', 'longtext', 'other'];

const TYPE_LABEL = {
  recruit: '扩列条',
  art: '画画记录',
  study: '学习技术',
  music: '音乐',
  mood: '情绪吐槽',
  meme: '梗图段子',
  life: '生活记录',
  image: '多图',
  longtext: '长文',
  other: '其他',
};

export function typeLabel(t) {
  return TYPE_LABEL[t] || t;
}

export function loadPrefs() {
  const f = prefsFile();
  const empty = { version: 2, authors: {}, types: {}, globalLiked: 0, globalSeen: 0, updatedAt: null };
  if (!existsSync(f)) return empty;
  try {
    const p = JSON.parse(readFileSync(f, 'utf8'));
    // 旧版（只有 authors 计数）直接作废重学，避免用错误的模型
    if (p.version !== 2) return empty;
    return { ...empty, ...p };
  } catch {
    return empty;
  }
}

export function savePrefs(p) {
  const { home } = paths();
  mkdirSync(home, { recursive: true });
  writeFileSync(prefsFile(), JSON.stringify(p, null, 2), 'utf8');
}

/**
 * 学习口味。关键点：**每个出现过的动态都要计入 seen**，不管赞没赞。
 * 只统计赞过的，就没法知道"这个人发了多少、你赞了其中几成"。
 */
export function learnFrom(items) {
  const prefs = loadPrefs();
  prefs.authors ||= {};
  prefs.types ||= {};
  let likedCount = 0;

  for (const it of items) {
    if (!it.key) continue; // 广告没 key，不参与
    const type = classify(it);
    const a = (prefs.authors[it.name] ||= { seen: 0, liked: 0 });
    const t = (prefs.types[type] ||= { seen: 0, liked: 0 });
    a.seen++;
    t.seen++;
    prefs.globalSeen = (prefs.globalSeen || 0) + 1;
    if (it.liked) {
      a.liked++;
      t.liked++;
      prefs.globalLiked = (prefs.globalLiked || 0) + 1;
      likedCount++;
    }
  }

  prefs.updatedAt = new Date().toISOString();
  savePrefs(prefs);
  return {
    seen: items.length,
    liked: likedCount,
    authors: Object.keys(prefs.authors).length,
    types: Object.keys(prefs.types).length,
  };
}

/**
 * 把 (liked, seen) 换算成 0~1 的偏好率，用全局平均做先验。
 * 这样「没见过的人」不会被误判成高偏好，也不会被误判成低偏好。
 */
function rate(stat, prefs, alpha = 2) {
  const prior = prefs.globalSeen ? prefs.globalLiked / prefs.globalSeen : 0.5;
  const seen = stat?.seen || 0;
  const liked = stat?.liked || 0;
  return (liked + prior * alpha) / (seen + alpha);
}

/**
 * 打分。分三块：作者偏好率、类型偏好率、内容本身特征。
 * 都用比例而非次数，所以「发得多但你不爱看」的人不会排到前面。
 */
export function scoreItem(item, prefs) {
  const type = classify(item);
  const aRate = rate(prefs.authors?.[item.name], prefs);
  const tRate = rate(prefs.types?.[type], prefs);

  let s = 1;
  s += aRate * 2.5; // 作者偏好：0~1 → 0~2.5
  s += tRate * 2.5; // 类型偏好：0~1 → 0~2.5
  if (item.imgCount > 0) s += 0.3 + Math.min(0.4, item.imgCount * 0.1);
  const len = (item.text || '').length;
  if (len > 80) s += 0.3;
  else if (len > 30) s += 0.15;
  return { score: Math.round(s * 10) / 10, type };
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

function imageDir() {
  return join(paths().outDir, 'img');
}

/**
 * 清理过期图片。
 * 图片是摘要的副产物，会一直堆着 —— 默认保留 7 天，也限制总数量。
 * @returns {{removed:number, kept:number, freedBytes:number}}
 */
export function cleanImages({ keepDays = 7, maxFiles = 300 } = {}) {
  const dir = imageDir();
  if (!existsSync(dir)) return { removed: 0, kept: 0, freedBytes: 0 };

  const cutoff = Date.now() - keepDays * 86_400_000;
  let files;
  try {
    files = readdirSync(dir)
      .map((n) => {
        const f = join(dir, n);
        try {
          const st = statSync(f);
          return { f, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return { removed: 0, kept: 0, freedBytes: 0 };
  }

  // 先按时间淘汰，再按数量兜底（保留最新的 maxFiles 个）
  files.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  let freedBytes = 0;
  files.forEach((it, idx) => {
    const tooOld = it.mtime < cutoff;
    const tooMany = idx >= maxFiles;
    if (tooOld || tooMany) {
      try {
        unlinkSync(it.f);
        removed++;
        freedBytes += it.size;
      } catch {
        /* 忽略单个失败 */
      }
    }
  });
  return { removed, kept: files.length - removed, freedBytes };
}

/** 图片目录当前占用 */
export function imageStorage() {
  const dir = imageDir();
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const n of readdirSync(dir)) {
    try {
      const st = statSync(join(dir, n));
      if (st.isFile()) {
        files++;
        bytes += st.size;
      }
    } catch {
      /* 忽略 */
    }
  }
  return { files, bytes };
}

/** 把图片下载到本地，返回短路径（失败返回 null，不影响主流程） */
async function downloadImage(url, key) {
  try {
    const res = await fetch(url, {
      headers: {
        Referer: 'https://user.qzone.qq.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) return null;
    const dir = imageDir();
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
 * @param {object[]} items 已读到的动态
 * @param {object} opts
 * @param {number} opts.top 输出几条
 * @param {boolean} opts.withImages 是否下载首图
 * @param {number} opts.textLen 正文截断长度
 * @param {object} opts.onlyTypes 只保留这些类型（数组）
 * @param {object} opts.cleanup 图片清理参数（false 关闭）
 */
export async function buildDigest(items, { top = 8, withImages = false, textLen = 80, onlyTypes, cleanup } = {}) {
  const prefs = loadPrefs();

  let pool = items.filter((it) => it.key);
  if (onlyTypes?.length) pool = pool.filter((it) => onlyTypes.includes(classify(it)));

  const scored = pool
    .map((it) => {
      const { score, type } = scoreItem(it, prefs);
      return { it, score, type };
    })
    .sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, top);

  // 下载图片前顺手清理旧的，避免长期堆积
  let cleaned;
  if (withImages && cleanup !== false) {
    cleaned = cleanImages(typeof cleanup === 'object' ? cleanup : {});
  }

  const out = [];
  for (const { it, score, type } of picked) {
    const row = {
      t: it.time || '',
      a: it.name || '',
      c: type,
      x: (it.text || '').replace(/\s+/g, ' ').slice(0, textLen),
      n: it.imgCount || 0,
      s: score,
      k: it.key.slice(0, 10),
    };
    if (it.liked) row.L = 1;
    if (withImages && it.imgCount) {
      const got = await downloadImage(it.imgs[0], it.key);
      if (got) row.p = got.file;
    }
    out.push(row);
  }

  const remain = scored.length - out.length;
  return {
    ok: true,
    total: items.length,
    pool: pool.length,
    shown: out.length,
    prefs: {
      seen: prefs.globalSeen || 0,
      liked: prefs.globalLiked || 0,
      authors: Object.keys(prefs.authors || {}).length,
    },
    // 提示调用方：还有多少条没给，要不要多给一些
    more: remain > 0 ? { remain, hint: `还有 ${remain} 条没显示，加 --top ${Math.min(out.length + remain, out.length + 8)} 可以看更多` } : null,
    typeStats: Object.fromEntries(
      Object.entries(prefs.types || {}).map(([t, s]) => [t, { seen: s.seen, liked: s.liked }]),
    ),
    cleaned: cleaned || undefined,
    items: out,
  };
}
