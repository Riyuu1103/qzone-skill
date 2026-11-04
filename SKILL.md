# QQ 空间（qzone-skill）

用无窗口浏览器操作 QQ 空间：读好友动态、点赞、按规则定时刷。

**这个 skill 不碰账号密码。** 登录只走手机扫码，登录态存在本机独立浏览器目录里。

---

## 0. 第一次给某个用户用时：先问这四个问题

**不要自顾自跑起来。** 用户的偏好差异很大，默认值只是兜底。第一次启用时先问清楚：

| 问题 | 对应配置 | 不填的默认 |
|---|---|---|
| 多久看一次？ | `auto.intervalMinutes` / 定时任务间隔 | 30 分钟 |
| 一次看多少条？ | `digest.top` | 8 条（最多 23） |
| 想看哪几类内容？ | `digest.types` / 打分权重 | 全部类型 |
| 要不要顺手点赞？ | `auto.enabled` | 关 |

问完再动手。用户说「随便，按默认来」就按默认，不要反复追问。

**同时要主动说明做不到什么**（详见 §8），尤其是：

- 只能看到当前列表里的（约 23 条 / 几小时），**看不到更早的**
- 不发说说、不评论、不加好友
- 靠定时查看，**不是实时推送**
- 非官方用法，有账号风险，改版会失效

---

## 0. 先判断该不该用

| 用户说的话 | 该做什么 |
|---|---|
| 「帮我看看 QQ 空间有什么」「刷一下空间」 | → §2 读动态 |
| 「给这条点赞」 | → §3 点赞 |
| 「以后自动给我刷空间 / 自动点赞」 | → §5 自动刷 |
| 「把好看的发给我」 | → §2 读到内容，由你挑选后告诉用户（本工具不发送） |
| 「帮我发条说说 / 评论一下」 | **做不到** —— 本工具只读和点赞，如实说明 |

---

## 1. 前置检查（每次任务开头跑一次）

```bash
node scripts/qzone.mjs status
```

看 `loggedIn`：

- `true` → 直接干活
- `false` → 让用户扫码：`node scripts/qzone.mjs login`，二维码图片路径会在输出里（`qrPath`），把路径告诉用户让他扫。**不要尝试用密码登录，也不要去读用户的浏览器 cookie。**

`loggedIn: false` 但 `account.uin` 有值时，说明**登录凭证丢了但账号记录还在**，重新 `login` 即可，不用 `logout`。

> `loggedIn` 的真正依据是 `session.json` 在不在。QQ 空间的登录 cookie 是 session cookie，浏览器一关就没，所以凭证是单独存盘的，不是靠浏览器配置目录。

输出里还有 `paused` 和 `auto.enabled`，做自动刷相关任务时先看这两个。

---

## 2. 读动态

### 2.1 先看摘要（推荐，最省 token）

```bash
node scripts/qzone.mjs digest --images
```

返回短键 JSON：

```json
{
  "ok": true,
  "total": 23, "pool": 18, "shown": 8,
  "prefs": { "seen": 23, "liked": 11, "authors": 5 },
  "more": { "remain": 10, "hint": "还有 10 条没显示，加 --top 18 可以看更多" },
  "typeStats": { "mood": { "seen": 2, "liked": 2 }, "other": { "seen": 7, "liked": 7 } },
  "items": [
    { "t": "12:33", "a": "示例同学", "c": "image", "x": "正文前 80 字…", "n": 3, "s": 3.2, "k": "d98289a49a", "L": 1, "p": "C:\\...\\out\\img\\283e171576.webp" }
  ]
}
```

字段：`t` 时间 · `a` 作者 · `c` 类型 · `x` 正文 · `n` 图片数 · `s` 分数 · `k` 短 id · `L` 你赞过 · `p` 本地图片路径 · `H` 电脑端读不到内容。

**关于 `H`（`hidden`）—— 别把它当成「好友发了句废话」。**

空间里有些卡片（视频、直播、部分活动组件）手机端能看，**电脑网页端只给一句「功能内测中，内容暂不支持查看」**。这是这边读不到正文，不是内容为空。所以：

- 摘要里仍然列出，但标 `H` 并降权（`-0.8`），不会被顶到最前
- 根级 `hidden` 字段会汇总：多少条、涉及谁
- **自动点赞会跳过** —— 看不到内容就点等于盲赞

跟用户解释时说清楚：「这条是电脑端加载不出，手机上看得到」，别说成「他发了条空的」。

- **`p` 可以直接读图**（`read_image`），不用再去下载
- `k` 只有 10 位，够用来点赞；要完整 id 用 `feed`
- `more` 非空时，**问用户要不要看更多**，别自己闭嘴

常用变体：

```bash
node scripts/qzone.mjs digest --since              # 只看上次之后的新内容
node scripts/qzone.mjs digest --top 15             # 多给几条
node scripts/qzone.mjs digest --types art,life     # 只看画画和生活记录
node scripts/qzone.mjs digest --images             # 附图片（自动清理旧图）
```

`--types` 可选值：`recruit` 扩列条 · `art` 画画 · `study` 学习技术 · `music` 音乐 · `mood` 情绪吐槽 · `meme` 梗图段子 · `life` 生活记录 · `image` 多图 · `longtext` 长文 · `other` 其他。

**第一次用之前先跑一次 `learn`，再跑一次 `friends`**，否则没有口味数据，排序等于按「有没有图 + 文字长短」猜。

`friends` 会抓好友页的亲密度排行（0~100），存进本机 prefs.json。亲密度反映「你在意谁」，比「谁发得多」稳定，所以也进了打分（0~100 归一化后占 0~2 分）。

### 2.2 要原始数据才用 feed

```bash
node scripts/qzone.mjs feed --limit 25
```

返回完整字段（`key`/`name`/`text`/`time`/`liked`/`hasImage`/`imgCount`/`img`），token 大约是 digest 的 5～10 倍。

- `key` 是完整动态 id，点赞时用它
- `liked: true` = 用户自己已经赞过
- `count` 是 0 且 `probe.cardCount` 也是 0 → 见 §7

**给用户汇报时**：说清「谁、说了什么、多久前」，别把 `key` 糊给用户看，那是给你用的。

---

## 3. 点赞

```bash
node scripts/qzone.mjs like <key> [更多 key]
```

返回每条的结果：

```json
{ "results": [{ "key": "abc123", "ok": true, "reason": "ok" }] }
```

`ok:false` 的常见 `reason`：

| reason | 含义 | 怎么办 |
|---|---|---|
| 已经赞过了 | 无需操作 | 如实说 |
| 点了但状态没变 | 被风控或按钮结构变了 | 停止这一轮，别重试 |
| DOM 里找不到这条动态 | 没滚到 | 先 `feed --scrolls 3` 再试 |

**硬规则**：一次最多 10 条，两条之间至少 8 秒。用户明确要求更快时也要先说清风险再动。

---

## 4. 只算不赞（安全预览）

```bash
node scripts/qzone.mjs auto --dry-run
```

返回 `picked`（会赞几条）和 `skipped`（跳过的原因）。**第一次给用户开自动刷之前，一定先跑这个**，把结果念给用户确认。

---

## 5. 自动刷

四个东西要分清：

| 命令 | 管什么 | 打个比方 |
|---|---|---|
| `on` / `off` | 自动刷总开关（写进配置） | 车的电源 |
| `pause` / `resume` | 紧急刹车（临时文件，不改配置） | 手刹 |
| `service install` | 系统定时任务 | 定速巡航 |
| `watch` | 前台常驻循环 | 司机一直踩着油门 |
| `auto --only-new` | 只赞游标之后的新动态 | 秒赞模式 |

### 想接近「秒赞」

`--only-new` 只处理比上次更新的动态，老的一条不碰。配合更短的定时任务间隔就能接近秒赞：

```bash
node scripts/qzone.mjs config auto.intervalMinutes 5
node scripts/qzone.mjs service install --interval 5
```

**先跟用户讲清楚代价**：间隔越短，请求越频繁，被判定异常的概率越高。默认 30 分钟是保守值。

> 有些人自己开「秒赞」插件，会把你的好友动态全部点赞。这类动态的 `L` 字段本来就是 1，`auto` 会自动跳过，不会重复赞 —— 不用额外处理。

典型开启流程：

```bash
node scripts/qzone.mjs config auto.like.maxAgeHours 24
node scripts/qzone.mjs config auto.like.maxPerRun 10
node scripts/qzone.mjs auto --dry-run     # 先看它会赞什么
node scripts/qzone.mjs on                 # 开开关
node scripts/qzone.mjs service install --interval 30   # 挂定时任务
```

关掉：

```bash
node scripts/qzone.mjs off
node scripts/qzone.mjs service uninstall
```

**注意**：`on` 只改配置，不会自己开始跑。真正让它跑起来的是 `service install`（后台定时）或 `watch`（前台常驻）。两个都没有时，`on` 是「开着但没跑」。用户问「为什么没动静」先查这个。

---

## 6. 配置

```bash
node scripts/qzone.mjs config                          # 看全部
node scripts/qzone.mjs config auto.like.maxPerRun      # 看一项
node scripts/qzone.mjs config auto.like.denyUsers "某某" # 改一项
```

值会自动转类型：原值是数组就按逗号分隔，原值是数字就转数字，原值是布尔就认 `true/false/1/0`。

**跟用户确认过再改的项**（影响别人看到什么）：

- `auto.like.allowUsers` / `denyUsers` —— 赞谁不赞谁
- `auto.like.maxPerRun` / `minIntervalSec` —— 频率
- `auto.like.denyKeywords` —— 什么内容不赞

其余（`intervalMinutes`、`maxAgeHours`）可以直接按用户意思设。

---

## 7. 排查

按这个顺序走，别跳：

```bash
node scripts/qzone.mjs status      # 1. 登录了吗
node scripts/qzone.mjs explore     # 2. 页面结构对不对
node scripts/qzone.mjs feed        # 3. 能不能读到
```

`explore` 会输出 `counts`（各选择器命中数）和 `screenshot`（截图的绝对路径）。

| 现象 | 判断 | 处理 |
|---|---|---|
| `status.loggedIn: false` | 登录态没了（过期或换了机器） | 重新 `login` 扫码 |
| `explore.counts` 全是 0 | 页面没加载完 / 被要求验证 | 看 `explore.screenshot`，把图给用户看 |
| `li.f-single` 有值但 `.f-item[data-key]` 是 0 | 页面改版了，动态 id 换位置了 | 改 `scripts/lib/actions.mjs` 的 `READ_SCRIPT` |
| 正文读出来全是空 | 正文容器换了（现在在 `.txt-box`） | 同上 |
| 点赞返回「点了但状态没变」 | 风控 | 停手，等几小时再说，别连着重试 |
| 浏览器起不来 | 找不到 Edge/Chrome | 设 `QZONE_BROWSER` 环境变量指到可执行文件 |

> 真实的 DOM 结构（2026-11 实测）写在 `docs/QZone刷空间-开发者手册.pdf` 第 6 章。改选择器前先看那里，别靠猜。

---

## 8. 边界（很重要）

1. **只读 + 点赞**。不要试图让它发说说、评论、加好友、删动态 —— 代码里没有，也不该加。
2. **不要读用户的浏览器 cookie / 密码库**。登录走扫码，这是设计上的硬边界。
3. **不要绕过风控**。遇到验证码、滑块、"操作过于频繁"，停下来告诉用户，不要换 IP、不要改 UA 硬闯。
4. **不要一次大量点赞**。默认参数是保守值，用户要调快必须先讲清后果。
5. **登录态目录不要外发**：`%APPDATA%\qzone-skill\browser` 与 `session.json` 等同于用户账号。
6. 这是**非官方用法**。用户问「会不会封号」时如实说：有风险，频率低风险小，但不保证。
7. **单次上限约 150 条**（`--limit 150`，能覆盖到昨天），但**不稳定**：同一台机器可能只读到 78 条。目标条数是上限不是保证。
8. **读满 150 条约 2 分钟**。日常用 `--limit 40`（约 40 秒、几小时内容）最划算；首屏 `--limit 0` 约 15 秒。

### 8.1 省 token 的规矩

`digest` 的输出只有 `feed` 的 10%（实测 336 vs 3526 tokens）。所以：

- **默认用 `digest`**，需要完整字段（要点赞、要 id）才用 `feed`
- 给用户念结果时**不要贴 JSON**，翻成人话
- 用 `--same` 系列里没有的参数就别乱加，`--limit` 调大只会更慢更贵
- `--images` 只在用户真的要看图时加，下载图片有网络开销

---

## 9. 给 agent 的输出规范

- 命令输出是 JSON，成功 `{"ok":true,...}`，失败 `{"ok":false,"reason":"..."}`
- 给用户看的时候**翻译成自然语言**，别直接贴 JSON
- 失败时把 `reason` 原样告诉用户，不要自己编一个原因
- 涉及数量（赞了几条、读到几条）必须报准确数字，不要"差不多先生"

---

## 附：文件在哪

```
scripts/qzone.mjs        CLI 入口
scripts/lib/cdp.mjs      CDP 客户端（零依赖）
scripts/lib/browser.mjs  无窗口 Edge 的启动/复用/关闭
scripts/lib/login.mjs    扫码登录
scripts/lib/actions.mjs  读动态、点赞、自动刷
scripts/lib/service.mjs  系统定时任务
scripts/lib/store.mjs    配置与状态
```

用户数据（不在仓库里）：

```
%APPDATA%\qzone-skill\config.json     配置
%APPDATA%\qzone-skill\state.json      已赞过的动态（去重）
%APPDATA%\qzone-skill\browser\        登录态
%APPDATA%\qzone-skill\out\            二维码、截图
%APPDATA%\qzone-skill\logs\auto.log   定时任务日志
```
