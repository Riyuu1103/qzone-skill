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

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failures.length ? '❌' : '✅'} 通过 ${passed} 项，失败 ${failures.length} 项\n`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
