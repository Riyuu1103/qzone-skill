// 用量测量：同一份数据用不同格式呈现，各占多少 token。
//
// 为什么需要它：这个工具最贵的不是网络请求，是「输出塞进模型上下文」。
// 一次 feed 全量输出可能几千 token，而真正有用的信息只要几百。
// 有了这组数字，才知道该默认用哪种输出。

/** 粗估 token：中日韩字符按 1 个算，其余按 3.6 字符算（JSON 符号偏贵） */
export function estimateTokens(s) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(s)) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 3.6);
}

function measure(name, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { name, bytes: Buffer.byteLength(text, 'utf8'), chars: text.length, tokens: estimateTokens(text) };
}

/**
 * 对同一批动态，比较三种呈现的 token 占用。
 * @param {object[]} items readFeed 的结果
 * @param {object} digest buildDigest 的结果
 */
export function compareFormats(items, digest, rawFeedJson) {
  const full = measure('feed 全量（含图片 URL）', rawFeedJson);

  const compact = measure(
    'feed 精简（不带图片 URL）',
    items.map(({ imgs, ...rest }) => ({ ...rest, img: imgs?.[0] })),
  );

  const briefItems = items.map((it) => ({
    t: it.time,
    a: it.name,
    x: (it.text || '').slice(0, 80),
    n: it.imgCount,
    k: it.key.slice(0, 10),
  }));
  const brief = measure('feed 极简（短键）', briefItems);
  const dig = measure('digest（按口味排序后 top N）', digest);

  const base = full.tokens || 1;
  for (const f of [full, compact, brief, dig]) {
    f.vsFull = `${Math.round((f.tokens / base) * 100)}%`;
  }

  return {
    ok: true,
    itemCount: items.length,
    formats: [full, compact, brief, dig],
    note: 'token 为粗估（中日韩字符 1 个/token，其它 3.6 字符/token），只看相对量级',
  };
}
