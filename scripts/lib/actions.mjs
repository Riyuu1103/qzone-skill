// 需要浏览器的动作：读动态、点赞、自动刷。
//
// 实现策略：全部在真实页面里做，而不是自己拼内部接口。
//   理由：QQ 空间的内部接口带签名参数（g_tk / curkey / unikey），逆向出来的实现
//         平均几个月就失效一次；而在页面里读 DOM、点按钮，改版时只需要换选择器，
//         而且浏览器自己会把 cookie、referer、签名都处理对。
//
// 代价：必须开着浏览器。但我们是 headless，用户看不到任何窗口。

import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBrowser, closeBrowser } from './browser.mjs';
import { newPage, goto, evaluate, screenshot } from './cdp.mjs';
import { loadConfig, loadState, saveState, isPaused, paths } from './store.mjs';

const FEED_URL = (uin) => `https://user.qzone.qq.com/${uin}`;

/** 打开一个已登录的页面，交给 callback 用完就关 */
async function withPage(fn, { pageUrl, headless } = {}) {
  const cfg = loadConfig();
  const uin = cfg.account?.uin;
  if (!uin) throw new Error('还没登录。先执行：node scripts/qzone.mjs login');

  const handle = await ensureBrowser({ headless: headless ?? cfg.browser?.headless !== false });
  const { sessionId } = await newPage(handle.cdp, 'about:blank');
  try {
    await goto(handle.cdp, sessionId, pageUrl ?? FEED_URL(uin), 40_000);
    await sleep(3000);
    return await fn({ cdp: handle.cdp, sessionId, uin, cfg });
  } finally {
    await closeBrowser(handle);
  }
}

//: 从页面里抓动态。选择器覆盖几代 QQ 空间的写法，抓不到会返回 candidates 方便排查。
const READ_SCRIPT = String.raw`(() => {
  const CARD_SELECTORS = ['li.f-single', 'div.f-single', 'li[class*="f-single"]', '.feed-item'];
  let nodes = [];
  for (const sel of CARD_SELECTORS) {
    nodes = [...document.querySelectorAll(sel)];
    if (nodes.length) break;
  }

  const out = [];
  const seen = new Set();
  for (const el of nodes) {
    const text = (el.querySelector('.f-info, [class*="f-info"]')?.innerText || '').trim();
    const name = (el.querySelector('.f-name, [class*="f-name"]')?.innerText || '').trim();
    const timeText = (el.querySelector('.f-time, [class*="f-time"]')?.innerText || '').trim();
    const key = el.getAttribute('data-key') || el.getAttribute('data-tid') || el.id || '';
    const likeBtn = el.querySelector('[class*="like_btn"], [class*="qz_like"]');
    const liked = likeBtn ? /_on|liked|已赞/.test(likeBtn.className || '') : false;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      name,
      text: text.slice(0, 500),
      time: timeText,
      liked,
      hasImage: Boolean(el.querySelector('img[src*="photo"], [class*="photo"] img')),
    });
  }

  const candidates = {};
  for (const sel of ['li.f-single','.f-single','.feed-item','[data-key]','[data-tid]','#feed_list','.f-list','[class*="like_btn"]']) {
    candidates[sel] = document.querySelectorAll(sel).length;
  }
  return { items: out, probe: { title: document.title, url: location.href, cardCount: nodes.length, candidates } };
})()`;

/** 读当前页面的动态（不做点赞，只读） */
export async function readFeed({ scrolls = 2 } = {}) {
  return withPage(async ({ cdp, sessionId }) => {
    for (let i = 0; i < scrolls; i++) {
      await evaluate(cdp, sessionId, 'window.scrollTo(0, document.body.scrollHeight); true').catch(() => {});
      await sleep(1500);
    }
    return evaluate(cdp, sessionId, READ_SCRIPT);
  });
}

/**
 * 给若干条动态点赞。返回每条的结果，不会因为一条失败就全中断。
 * @param {string[]} keys 动态 id
 * @param {{intervalMs?:number}} opts 两条之间的间隔，默认 8 秒（太快容易触发风控）
 * 返回 { results: [{key, ok, before, after, reason}] }
 */
export async function likeByKeys(keys, { intervalMs } = {}) {
  if (!keys?.length) return { results: [] };
  const gap = Math.max(1000, intervalMs ?? 8_000);
  return withPage(async ({ cdp, sessionId }) => {
    const results = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (i > 0) await sleep(gap);
      const r = await evaluate(
        cdp,
        sessionId,
        `(async () => {
          const KEY = ${JSON.stringify(key)};
          const el = [...document.querySelectorAll('li.f-single, div.f-single, .feed-item, [data-key]')]
            .find(n => n.getAttribute('data-key') === KEY || n.getAttribute('data-tid') === KEY || n.id === KEY);
          if (!el) return { ok: false, reason: 'DOM 里找不到这条动态（可能需要先滚动加载）' };
          const btn = el.querySelector('[class*="like_btn"], [class*="qz_like"]');
          if (!btn) return { ok: false, reason: '找不到赞按钮' };
          const before = btn.className || '';
          if (/_on|liked/.test(before)) return { ok: true, skipped: true, reason: '已经赞过了', before };
          btn.click();
          await new Promise(r => setTimeout(r, 1200));
          const after = btn.className || '';
          return { ok: /_on|liked/.test(after), before, after, reason: /_on|liked/.test(after) ? 'ok' : '点了但状态没变（可能被风控或按钮结构变了）' };
        })()`,
      ).catch((e) => ({ ok: false, reason: e.message }));
      results.push({ key, ...r });
    }
    return { results };
  });
}

/** 把 "3分钟前" / "昨天 12:34" / "10月18日" 这类文案换算成小时数；认不出返回 null */
export function ageHoursFromText(text, now = new Date()) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, '');
  let m;
  if (/刚刚|刚才/.test(t)) return 0;
  if ((m = t.match(/^(\d+)\s*秒前/))) return Number(m[1]) / 3600;
  if ((m = t.match(/^(\d+)\s*分钟前/))) return Number(m[1]) / 60;
  if ((m = t.match(/^(\d+)\s*小时前/))) return Number(m[1]);
  if ((m = t.match(/^(\d+)\s*天前/))) return Number(m[1]) * 24;
  if (/昨天/.test(t)) return 24;
  if (/前天/.test(t)) return 48;
  if ((m = t.match(/^(\d{1,2})月(\d{1,2})日/))) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d > now) d.setFullYear(d.getFullYear() - 1);
    return (now - d) / 3_600_000;
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return (now - d) / 3_600_000;
  }
  return null;
}

/** 按配置里的规则决定一条动态要不要赞 */
export function shouldLike(item, likeCfg, { likedKeys = {} } = {}) {
  if (likedKeys[item.key]) return { like: false, why: '这次运行的更早轮次赞过' };
  if (item.liked) return { like: false, why: '页面显示已赞' };

  const allow = likeCfg.allowUsers ?? [];
  const deny = likeCfg.denyUsers ?? [];
  if (deny.some((n) => item.name.includes(n))) return { like: false, why: '命中 denyUsers' };
  if (allow.length && !allow.some((n) => item.name.includes(n))) return { like: false, why: '不在 allowUsers 里' };

  const denyWords = likeCfg.denyKeywords ?? [];
  const hit = denyWords.find((w) => item.text.includes(w));
  if (hit) return { like: false, why: `正文命中 denyKeywords: ${hit}` };

  const age = ageHoursFromText(item.time);
  if (age != null && age > (likeCfg.maxAgeHours ?? 24)) return { like: false, why: `太旧（${age.toFixed(1)} 小时）` };

  return { like: true, why: 'ok' };
}

/** 跑一轮：读动态 → 按规则挑 → 点赞 → 记状态 → 返回摘要 */
export async function runAuto({ dryRun = false, scrolls = 2 } = {}) {
  const cfg = loadConfig();
  const state = loadState();
  const likeCfg = cfg.auto.like;

  const feed = await readFeed({ scrolls });
  const decided = feed.items.map((item) => ({ item, ...shouldLike(item, likeCfg, { likedKeys: state.liked }) }));
  const picked = decided.filter((d) => d.like).slice(0, likeCfg.maxPerRun ?? 10);

  let likeResults = [];
  if (picked.length && !dryRun) {
    likeResults = await likeByKeys(picked.map((p) => p.item.key), { intervalMs: (likeCfg.minIntervalSec ?? 8) * 1000 });
    const byKey = new Map(likeResults.results.map((r) => [r.key, r]));
    for (const p of picked) {
      const r = byKey.get(p.item.key);
      if (r?.ok) state.liked[p.item.key] = { at: Date.now(), name: p.item.name, text: p.item.text.slice(0, 80) };
    }
    // 只保留最近 500 条记录，别让状态文件无限长
    const keys = Object.keys(state.liked);
    if (keys.length > 500) {
      keys.sort((a, b) => (state.liked[a].at ?? 0) - (state.liked[b].at ?? 0));
      for (const k of keys.slice(0, keys.length - 500)) delete state.liked[k];
    }
  }

  state.lastRunAt = new Date().toISOString();

  if (cfg.saveRaw) {
    const { outDir } = paths();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `feed-${Date.now()}.json`), JSON.stringify(feed, null, 2), 'utf8');
  }
  saveState(state);

  return {
    ok: true,
    dryRun,
    total: feed.items.length,
    picked: picked.length,
    skipped: decided.filter((d) => !d.like).map((d) => ({ key: d.item.key, name: d.item.name, why: d.why })),
    liked: likeResults.results ?? [],
    probe: feed.probe,
  };
}

/** 探测：把页面结构 dump 出来，用于写/修选择器 */
export async function explore() {
  return withPage(async ({ cdp, sessionId, uin }) => {
    for (let i = 0; i < 2; i++) {
      await evaluate(cdp, sessionId, 'window.scrollTo(0, document.body.scrollHeight); true').catch(() => {});
      await sleep(1500);
    }
    const info = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const counts = {};
        for (const sel of ['li.f-single','.f-single','.feed-item','[data-key]','[data-tid]','#feed_list','.f-list','[class*="like_btn"]']) {
          counts[sel] = document.querySelectorAll(sel).length;
        }
        const first = document.querySelector('li.f-single, .f-single, [data-key]');
        return { url: location.href, title: document.title, counts, firstCard: first ? first.outerHTML.slice(0, 3000) : null, bodyLen: document.body.innerText.length };
      })()`,
    );
    const png = await screenshot(cdp, sessionId);
    const { outDir } = paths();
    mkdirSync(outDir, { recursive: true });
    const shot = join(outDir, 'explore.png');
    writeFileSync(shot, png);
    return { uin, ...info, screenshot: shot };
  });
}

/** 常驻循环：每次醒来先看开关，被暂停就跳过（不是退出） */
export async function watch({ intervalMinutes } = {}) {
  const cfg0 = loadConfig();
  const every = (intervalMinutes ?? cfg0.auto.intervalMinutes ?? 30) * 60_000;
  process.stderr.write(`[qzone] 自动刷已启动，间隔 ${Math.round(every / 60000)} 分钟\n`);
  for (;;) {
    const cfgNow = loadConfig();
    if (isPaused() || !cfgNow.auto.enabled) {
      process.stderr.write('[qzone] 自动刷未开启或已暂停，等待\n');
    } else {
      try {
        const r = await runAuto();
        process.stderr.write(`[qzone] 本轮：读到 ${r.total} 条，赞了 ${r.liked.filter((x) => x.ok).length} 条\n`);
      } catch (e) {
        process.stderr.write(`[qzone] 本轮失败：${e.message}\n`);
      }
    }
    await sleep(every);
  }
}

/** CLI 分发 */
export async function run(command, flags, io) {
  try {
    switch (command) {
      case 'feed': {
        const r = await readFeed({ scrolls: Number(flags.scrolls ?? 2) });
        return io.out({ ok: true, count: r.items.length, items: r.items, probe: r.probe }, flags);
      }
      case 'like': {
        const keys = flags._ ?? [];
        if (!keys.length) return io.fail('用法：like <动态id> [更多id]');
        const r = await likeByKeys(keys);
        return io.out({ ok: true, ...r }, flags);
      }
      case 'auto': {
        const r = await runAuto({ dryRun: Boolean(flags['dry-run']) });
        return io.out(r, flags);
      }
      case 'watch':
        return watch({ intervalMinutes: flags.interval ? Number(flags.interval) : undefined });
      case 'explore': {
        const r = await explore();
        return io.out({ ok: true, ...r }, flags);
      }
      default:
        return io.fail(`actions 不认识的命令：${command}`);
    }
  } catch (e) {
    return io.fail(e.message);
  }
}
