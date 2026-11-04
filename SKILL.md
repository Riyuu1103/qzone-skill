# QQ 空间（qzone-skill）

用无窗口浏览器操作 QQ 空间：读好友动态、点赞、按规则定时刷。

**这个 skill 不碰账号密码。** 登录只走手机扫码，登录态存在本机独立浏览器目录里。

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

```bash
node scripts/qzone.mjs feed --scrolls 2
```

返回：

```json
{
  "ok": true,
  "count": 12,
  "items": [
    { "key": "abc123", "name": "张三", "text": "正文…", "time": "3小时前", "liked": false, "hasImage": true }
  ],
  "probe": { "cardCount": 12, "candidates": { "li.f-single": 12 } }
}
```

- `key` 是这条动态的 id，点赞时用它
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
5. **登录态目录不要外发**：`%APPDATA%\qzone-skill\browser` 等同于用户账号。
6. 这是**非官方用法**。用户问「会不会封号」时如实说：有风险，频率低风险小，但不保证。

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
