// 自检：不需要登录态，也不需要网络。
// 用法：node test/run.mjs
//
// 覆盖三块最容易写错、又最不该出错的地方：
//   1) 相对时间文案 → 小时数（决定「这条太旧了不赞」）
//   2) 点赞规则判定（决定「赞谁不赞谁」，错了会得罪人）
//   3) 配置的点号读写与类型转换（决定用户改配置能不能生效）

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import store 之前设好，否则会写到真实配置目录
const sandbox = mkdtempSync(join(tmpdir(), 'qzone-test-'));
process.env.QZONE_HOME = sandbox;

const { ageHoursFromText, shouldLike } = await import('../scripts/lib/actions.mjs');
const { loadConfig, saveConfig, getPath, setPath, coerce, paths, setPaused, isPaused } = await import(
  '../scripts/lib/store.mjs'
);

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('\n[1] 相对时间 → 小时数');
const now = new Date('2026-11-02T12:00:00');
test('刚刚 = 0 小时', () => assert.equal(ageHoursFromText('刚刚', now), 0));
test('30分钟前 = 0.5 小时', () => assert.equal(ageHoursFromText('30分钟前', now), 0.5));
test('3小时前 = 3 小时', () => assert.equal(ageHoursFromText('3小时前', now), 3));
test('2天前 = 48 小时', () => assert.equal(ageHoursFromText('2天前', now), 48));
test('昨天 = 24 小时', () => assert.equal(ageHoursFromText('昨天 12:34', now), 24));
test('前天 = 48 小时', () => assert.equal(ageHoursFromText('前天', now), 48));
test('具体日期能算出小时', () => {
  const h = ageHoursFromText('10月30日', now);
  assert.ok(h > 48 && h < 96, `期望 48~96，实际 ${h}`);
});
test('认不出的文案返回 null（不能瞎猜成 0）', () => {
  assert.equal(ageHoursFromText('很久以前', now), null);
  assert.equal(ageHoursFromText('', now), null);
});

console.log('\n[2] 点赞规则');
const likeCfg = {
  enabled: true,
  allowUsers: [],
  denyUsers: ['领导'],
  maxPerRun: 10,
  minIntervalSec: 8,
  maxAgeHours: 24,
  denyKeywords: ['讣告'],
};
const base = { key: 'k1', name: '张三', text: '今天天气不错', time: '3小时前', liked: false };

test('正常动态应该赞', () => assert.equal(shouldLike(base, likeCfg).like, true));
test('没有动态 id 的广告卡片不赞', () => assert.equal(shouldLike({ ...base, key: '' }, likeCfg).like, false));
test('占位正文不赞', () =>
  assert.equal(shouldLike({ ...base, text: '功能内测中，内容暂不支持查看' }, likeCfg).like, false));
test('已赞过的不重复赞', () => assert.equal(shouldLike({ ...base, liked: true }, likeCfg).like, false));
test('上轮赞过的跳过', () =>
  assert.equal(shouldLike(base, likeCfg, { likedKeys: { k1: 1 } }).like, false));
test('denyUsers 命中不赞', () => assert.equal(shouldLike({ ...base, name: '领导小王' }, likeCfg).like, false));
test('超出最大年龄不赞', () => assert.equal(shouldLike({ ...base, time: '3天前' }, likeCfg).like, false));
test('认不出时间时放行（宁可按页面已赞状态判断）', () =>
  assert.equal(shouldLike({ ...base, time: '很久以前' }, likeCfg).like, true));
test('denyKeywords 命中不赞', () =>
  assert.equal(shouldLike({ ...base, text: '一则讣告' }, likeCfg).like, false));
test('allowUsers 非空时只赞名单内的人', () => {
  const cfg = { ...likeCfg, allowUsers: ['张三'] };
  assert.equal(shouldLike(base, cfg).like, true);
  assert.equal(shouldLike({ ...base, name: '李四' }, cfg).like, false);
});

console.log('\n[3] 配置读写与类型转换');
test('点号取值', () => assert.equal(getPath({ a: { b: 1 } }, 'a.b'), 1));
test('点号赋值不破坏兄弟键', () => {
  const o = { a: { b: 1, c: 2 } };
  setPath(o, 'a.b', '9');
  assert.deepEqual(o.a, { b: 9, c: 2 });
});
test('原值是数字就转数字', () => assert.equal(coerce('42', 1), 42));
test('原值是布尔就认 1/0', () => {
  assert.equal(coerce('1', false), true);
  assert.equal(coerce('0', true), false);
  assert.equal(coerce('true', false), true);
});
test('原值是数组就按逗号拆', () => assert.deepEqual(coerce('张三, 李四，王五', []), ['张三', '李四', '王五']));
test('数组可以给 JSON', () => assert.deepEqual(coerce('["a","b"]', []), ['a', 'b']));
test('空字符串给数组 = 清空', () => assert.deepEqual(coerce('', ['x']), []));
test('数字位置给非数字要报错', () => assert.throws(() => coerce('abc', 1)));

console.log('\n[4] 配置文件落盘');
test('默认配置能加载', () => assert.equal(typeof loadConfig().auto.like.maxPerRun, 'number'));
test('改了能存、能读回来', () => {
  const cfg = loadConfig();
  cfg.auto.like.maxPerRun = 3;
  saveConfig(cfg);
  assert.equal(loadConfig().auto.like.maxPerRun, 3);
});
test('配置文件只写到沙箱里', () => {
  assert.ok(paths().configFile.startsWith(sandbox), `写到了 ${paths().configFile}`);
  assert.ok(readFileSync(paths().configFile, 'utf8').includes('maxPerRun'));
});
test('缺字段时用默认值补齐（老版本配置不会崩）', () => {
  writeFileSync(paths().configFile, JSON.stringify({ auto: { like: { maxPerRun: 7 } } }), 'utf8');
  const cfg = loadConfig();
  assert.equal(cfg.auto.like.maxPerRun, 7);
  assert.equal(cfg.auto.like.minIntervalSec, 8, '缺的字段应该回落到默认值');
});
test('坏 JSON 要报明确的错，而不是静默用默认值', () => {
  writeFileSync(paths().configFile, '{ 坏掉的', 'utf8');
  assert.throws(() => loadConfig(), /不是合法 JSON/);
});

console.log('\n[5] 紧急刹车开关');
test('默认没暂停', () => assert.equal(isPaused(), false));
test('pause 之后是暂停', () => {
  setPaused(true);
  assert.equal(isPaused(), true);
});
test('resume 之后恢复', () => {
  setPaused(false);
  assert.equal(isPaused(), false);
});

console.log('\n[6] 动态 id 校验（游标不能存错东西）');
const { isFeedKey } = await import('../scripts/lib/actions.mjs');
test('标准 24 位 hex 认作动态 id', () => assert.equal(isFeedKey('abcdef1234567890abcdef12'), true));
test('页面位置标记不认', () => assert.equal(isFeedKey('403_2_123456789'), false));
test('空串 / undefined 不认', () => {
  assert.equal(isFeedKey(''), false);
  assert.equal(isFeedKey(undefined), false);
});
test('太短的 hex 不认', () => assert.equal(isFeedKey('abcd'), false));

console.log('\n[7] token 估算与打分');
const { estimateTokens } = await import('../scripts/lib/bench.mjs');
const { scoreItem, classify, typeLabel, isHidden, negativity } = await import('../scripts/lib/digest.mjs');

const emptyPrefs = { authors: {}, types: {}, globalSeen: 0, globalLiked: 0 };
const scoreOf = (item, prefs = emptyPrefs) => scoreItem(item, prefs).score;

test('纯中文按 1 字 1 token 估', () => assert.equal(estimateTokens('中文测试'), 4));
test('英文按 3.6 字符 1 token 估（向下取整放宽）', () => {
  const t = estimateTokens('abcdefghij');
  assert.ok(t >= 2 && t <= 4, `实际 ${t}`);
});
test('空串是 0', () => assert.equal(estimateTokens(''), 0));

test('作者偏好率会拉高分数', () => {
  const item = { name: '示例人', text: '短', imgCount: 0 };
  const plain = scoreOf(item);
  const fan = scoreOf(item, { authors: { 示例人: { seen: 4, liked: 4 } }, types: {}, globalSeen: 10, globalLiked: 5 });
  assert.ok(fan > plain, `常赞的应更高：${fan} vs ${plain}`);
});

test('发得多但一次没赞过的人，分数低于陌生人', () => {
  const prefs = { authors: { 刷屏: { seen: 20, liked: 0 } }, types: {}, globalSeen: 40, globalLiked: 10 };
  const spammer = scoreOf({ name: '刷屏', text: '短', imgCount: 0 }, prefs);
  const stranger = scoreOf({ name: '陌生人', text: '短', imgCount: 0 }, prefs);
  assert.ok(spammer < stranger, `刷屏狂应低于陌生人：${spammer} vs ${stranger}`);
});

test('类型偏好也会影响分数', () => {
  const item = { name: 'x', text: '今天吃了拉面', imgCount: 0 };
  const noType = scoreOf(item);
  const loveLife = scoreOf(item, { authors: {}, types: { life: { seen: 3, liked: 3 } }, globalSeen: 10, globalLiked: 3 });
  assert.ok(loveLife > noType, `爱看生活记录应更高：${loveLife} vs ${noType}`);
});

test('带图加分', () => {
  const base = { name: 'x', text: '短', imgCount: 0 };
  const withImg = { ...base, imgCount: 3 };
  assert.ok(scoreOf(withImg) > scoreOf(base));
});

console.log('\n[8] 内容分类');
test('扩列条', () => assert.equal(classify({ text: '来扩列！互关一下', imgCount: 0 }), 'recruit'));
test('画画记录', () => assert.equal(classify({ text: '今天画完了这张线稿', imgCount: 1 }), 'art'));
test('学习技术', () => assert.equal(classify({ text: '复习一下常微分方程的定理', imgCount: 0 }), 'study'));
test('情绪吐槽', () => assert.equal(classify({ text: '好烦啊不想动', imgCount: 0 }), 'mood'));
test('梗图段子', () => assert.equal(classify({ text: '哈哈哈哈笑死我了', imgCount: 1 }), 'meme'));
test('生活记录', () => assert.equal(classify({ text: '今天食堂的饭还行', imgCount: 0 }), 'life'));
test('三张以上图算多图', () => assert.equal(classify({ text: '', imgCount: 4 }), 'image'));
test('长文兜底', () =>
  assert.equal(classify({ text: 'x'.repeat(200), imgCount: 0 }), 'longtext'));
test('什么都没有算 other', () => assert.equal(classify({ text: '嗯', imgCount: 0 }), 'other'));
test('类型有中文名', () => assert.equal(typeLabel('art'), '画画记录'));

console.log('\n[9] 电脑端读不到内容的动态');
test('识别「功能内测中」这类占位', () =>
  assert.equal(isHidden({ text: '功能内测中，内容暂不支持查看。' }), true));
test('识别「该内容暂不支持查看」', () =>
  assert.equal(isHidden({ text: '该内容暂不支持查看' }), true));
test('正常内容不误判', () => assert.equal(isHidden({ text: '今天吃了拉面' }), false));
test('空正文不误判', () => assert.equal(isHidden({ text: '' }), false));
console.log('\n[10] 负面内容识别');
test('情绪类识别为 level 1', () => {
  const r = negativity({ text: '好烦啊不想动，心累' });
  assert.equal(r.level, 1);
  assert.ok(r.tags.includes('mood'));
});
test('坏消息识别为 level 2', () => {
  const r = negativity({ text: '听说他家里出了事故' });
  assert.equal(r.level, 2);
  assert.ok(r.tags.includes('news'));
});
test('「笑死」不能因为含「死」被判负面', () => assert.equal(negativity({ text: '哈哈哈哈笑死我了' }).level, 0));
test('「积累」不能因为含「累」被判负面', () => assert.equal(negativity({ text: '知识的积累很重要' }).level, 0));
test('普通内容不是负面', () => assert.equal(negativity({ text: '今天去吃了拉面' }).level, 0));
test('空正文不是负面', () => assert.equal(negativity({ text: '' }).level, 0));
test('demote 模式下降权但仍保留', () => {
  const item = { name: 'x', text: '好烦啊心累', imgCount: 0 };
  const asIs = scoreItem(item, {}, { negative: 'include' }).score;
  const demoted = scoreItem(item, {}, { negative: 'demote' }).score;
  assert.ok(demoted < asIs, '应当降权');
  assert.ok(demoted > 0, '不该归零消失');
});
test('normal 内容不受 negative 设置影响', () => {
  const item = { name: 'x', text: '今天去吃了拉面', imgCount: 0 };
  assert.equal(
    scoreItem(item, {}, { negative: 'include' }).score,
    scoreItem(item, {}, { negative: 'demote' }).score,
  );
});

console.log('\n[11] 补遗（没看到的补给你）');
test('推送过的内容会降权', () => {
  const item = { key: 'k1', name: 'x', text: '普通内容', imgCount: 0 };
  const fresh = scoreItem(item, {}, { shownKeys: new Set() }).score;
  const seen = scoreItem(item, {}, { shownKeys: new Set(['k1']) }).score;
  assert.ok(seen < fresh, '推送过的应更低');
  assert.ok(seen > 0, '但不该归零');
});
test('没推送过的不受影响', () => {
  const item = { key: 'k2', name: 'x', text: '普通内容', imgCount: 0 };
  const a = scoreItem(item, {}, { shownKeys: new Set(['k1']) }).score;
  const b = scoreItem(item, {}, { shownKeys: new Set() }).score;
  assert.equal(a, b);
});

test('看不到内容的降权但不会消失', () => {
  const normal = { name: 'x', text: '普通内容', imgCount: 0 };
  const hidden = { name: 'x', text: '功能内测中，内容暂不支持查看', imgCount: 0 };
  assert.ok(scoreOf(hidden) < scoreOf(normal), '应当降权');
  assert.ok(scoreOf(hidden) > 0, '不该被压成 0 分导致彻底消失');
});

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failures.length ? '❌' : '✅'} 通过 ${passed} 项，失败 ${failures.length} 项\n`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
