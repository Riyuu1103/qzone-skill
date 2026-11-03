# qzone-skill

让 AI agent 帮你刷 QQ 空间：读好友动态、按你自己的规则点赞，**全程不弹出任何浏览器窗口**。

零依赖（不用装 puppeteer / playwright），直接复用系统里已有的 Edge 或 Chrome。

```
┌──────────────┐   扫码一次    ┌────────────────────┐   读动态 / 点赞   ┌─────────┐
│  你的手机 QQ  │ ───────────▶ │ 无窗口 Edge（独立    │ ───────────────▶ │ QQ 空间  │
└──────────────┘               │ 配置目录，登录态存这）│                   └─────────┘
                               └────────────────────┘
```

---

## 它能做什么

- **读**：拉取好友动态（作者、正文、时间、有没有图、自己赞过没）
- **赞**：给指定的某几条点赞
- **自动刷**：按你设的规则（只赞谁、不赞谁、只要多久以内的、一次最多赞几条）定时执行
- **一键开关**：`on` / `off` 切自动刷，`pause` / `resume` 是紧急刹车
- **挂定时任务**：关掉终端也会照常跑

## 它不做什么

- 不自动评论、不自动发说说、不加好友 —— 这个工具只读动态和点赞
- 不保存你的 QQ 密码。登录只走手机扫码，登录态留在本地浏览器目录里
- 不上传任何数据。所有请求都是浏览器直接发给腾讯

---

## 三步上手

### 1. 登录（只需一次）

```bash
node scripts/qzone.mjs login
```

它会打开一个**无窗口**的浏览器，把登录二维码截成图片放在：

```
%APPDATA%\qzone-skill\out\login-qr.png     # Windows
~/.qzone-skill/out/login-qr.png            # macOS / Linux
```

用手机 QQ 扫这张图，最多等 3 分钟。成功后登录态就存在本地了，以后不用再扫。

> 二维码过期会自动刷新，重新截同一张图即可；`login` 也可以重复执行，已登录会直接返回。

### 2. 看一眼动态

```bash
node scripts/qzone.mjs feed --pretty
```

返回 JSON，每条有 `key`（动态 id）、`name`（谁发的）、`text`（正文）、`time`、`liked`。

### 3. 开启自动刷

```bash
node scripts/qzone.mjs config auto.like.maxAgeHours 24     # 只赞 24 小时内的
node scripts/qzone.mjs config auto.like.maxPerRun 10       # 一次最多 10 条
node scripts/qzone.mjs on                                  # 打开开关
node scripts/qzone.mjs service install --interval 30       # 每 30 分钟跑一次
```

想关：

```bash
node scripts/qzone.mjs off              # 关掉自动刷
node scripts/qzone.mjs service uninstall # 连定时任务一起卸掉
```

---

## 命令表

| 命令 | 作用 |
|---|---|
| `login` | 扫码登录（无窗口，二维码存成图片） |
| `status` | 看登录态、开关、关键配置 |
| `logout` | 退出登录（删掉登录态目录） |
| `config` | 看全部配置 |
| `config <键> <值>` | 改一项，键用点号，值自动转类型 |
| `feed` | 读好友动态 |
| `like <id> [更多 id]` | 给指定动态点赞 |
| `auto` | 跑一轮：读 + 按规则赞 |
| `auto --dry-run` | 只算不赞，看它会赞哪些 |
| `on` / `off` | 开 / 关自动刷 |
| `pause` / `resume` | 紧急刹车（不改配置） |
| `watch` | 前台常驻循环（适合自己开着跑） |
| `service status/install/uninstall` | 系统定时任务 |
| `explore` | 页面结构探测（改版后排查用） |

所有命令默认输出 JSON（在终端里会自动缩进）。加 `--json` 强制紧凑，方便别的程序解析。

---

## 配置

配置文件位置：

```
%APPDATA%\qzone-skill\config.json     # Windows
~/.qzone-skill/config.json            # macOS / Linux
```

设环境变量 `QZONE_HOME` 可以整体换位置。

```jsonc
{
  "account": { "uin": "", "nickname": "" },   // 登录后自动写入
  "browser": { "path": "", "headless": true }, // path 留空 = 自动找 Edge/Chrome
  "auto": {
    "enabled": false,          // 总开关
    "intervalMinutes": 30,     // 定时任务间隔
    "like": {
      "enabled": true,
      "allowUsers": [],        // 只赞这些人（留空 = 不按人筛）
      "denyUsers": [],         // 永不赞这些人
      "maxPerRun": 10,         // 一次最多赞几条
      "minIntervalSec": 8,     // 两条之间隔几秒
      "maxAgeHours": 24,       // 只赞多久以内的
      "denyKeywords": []       // 正文含这些词就不赞
    }
  },
  "notify": { "command": "", "webhook": "" },
  "saveRaw": false
}
```

改配置两种方式，效果一样：

```bash
node scripts/qzone.mjs config auto.like.allowUsers "张三,李四"   # 逗号分隔 → 数组
node scripts/qzone.mjs config auto.like.maxAgeHours 12          # 自动转数字
```

---

## 接到自己的 AI agent 上

这个工具被设计成「agent 友好」的：

1. **每个命令一个 JSON 输出**，成功 `{"ok":true,...}`，失败 `{"ok":false,"reason":"..."}`
2. **不读 stdin、不交互**（除了 `login` 等扫码）
3. **状态在磁盘上**，agent 不需要维持会话

把下面这份文件交给你的 agent 即可（就是本仓库的 `SKILL.md`）：

```
SKILL.md                 给 AI 读的操作说明
references/commands.md   每个命令的完整参数与输出格式
references/troubleshooting.md  出问题怎么查
```

如果你的 agent 支持 skill / 工具描述文件，把 `SKILL.md` 放到它的技能目录里；如果只支持「执行 shell」，把 `references/commands.md` 喂给它就够。

---

## 原理

不用腾讯的内部接口，而是：

1. 起一个 **headless Edge**，用独立的 `--user-data-dir`（不碰你平时的浏览器）
2. 在里面打开 `user.qzone.qq.com`，页面自己会把 cookie / 签名都算好
3. 从 DOM 里读动态；点赞就是**点页面上的那个赞按钮**
4. 做完关掉浏览器

为什么这么绕：QQ 空间的内部接口带 `g_tk` / `curkey` / `unikey` 这些签名参数，逆向实现平均几个月就失效。走页面 DOM 的话，改版只需要换选择器，而且不会因为签名算错而静默失败。

代价是要开浏览器 —— 但它是无窗口的，你看不到。

---

## 风险与边界

- **这是非官方用法**。腾讯没有开放这套接口，页面改版或风控策略变化都可能导致失效。
- **点赞频率别调太高**。默认 8 秒一条、一次最多 10 条，是保守值。调快了自己承担。
- **登录态等同于你的账号**。`%APPDATA%\qzone-skill\browser` 这个目录不要发给别人。
- 出了问题先跑 `node scripts/qzone.mjs explore`，它会 dump 当前页面结构，通常看一眼就知道是选择器变了还是没登录。

---

## 环境要求

- Node.js **22 或更高**（用到内置 `WebSocket`）
- Windows 上需要 Microsoft Edge（系统自带）；macOS / Linux 上需要 Chrome 或 Chromium
- 找不到浏览器时用环境变量指定：`QZONE_BROWSER=/path/to/chrome`

---

## License

MIT
