# 故障排查

按顺序走，别跳。每一步都能排除掉一类原因。

```bash
node scripts/qzone.mjs status     # 1. 登录了吗
node scripts/qzone.mjs explore    # 2. 页面打开了吗、结构对吗
node scripts/qzone.mjs feed       # 3. 能读到吗
```

---

## 登录

### 二维码扫了没反应

- 二维码 **2 分钟**过期。`login` 每 25 秒会重截一次，如果图在本地文件管理器里预览着，刷新一下再看
- 手机 QQ 和空间账号必须是同一个
- 扫码后手机上还要点一次「确认登录」，只扫不点不算

### `login` 说已经登录，但 `feed` 说没登录

`status` 读的是 `config.json` 里的 `account.uin`，`feed` 也读它 —— 正常不会不一致。真遇到就重跑一次 `login`，它会重新确认并写回 uin。

### 登录态莫名其妙没了

腾讯会让登录态过期（通常几周，也可能因为异地登录、改密码而立即失效）。重新 `login` 即可。

---

## 浏览器

### 提示「没找到 Edge / Chrome」

用环境变量指到可执行文件：

```bash
# Windows (PowerShell)
$env:QZONE_BROWSER = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# Windows (cmd)
set QZONE_BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

# macOS / Linux
export QZONE_BROWSER=/usr/bin/google-chrome
```

也可以写进配置：`node scripts/qzone.mjs config browser.path "C:\...\msedge.exe"`。

### 浏览器起不来 / 30 秒超时

配置文件里的 `browser.headless` 改成 `false`，再跑一次，就能看到真实窗口和报错：

```bash
node scripts/qzone.mjs config browser.headless 0
node scripts/qzone.mjs login
```

看完记得改回 `1`。

### 同时开了多个浏览器实例

`browser.mjs` 会复用同一个配置目录里已经在跑的那个（读 `DevToolsActivePort` 文件）。如果你手动删了这个文件，或者同时用不同的 `QZONE_HOME` 各跑一份，就会出现多个实例 —— 各管各的，不冲突，只是费内存。

---

## 读不到动态

### `count: 0` 且 `probe.cardCount: 0`

三个可能，按概率排：

1. **没登录**（最常见）→ `status` 看 `loggedIn`
2. **页面加载慢** → `feed --scrolls 0` 试，或 `explore` 看截图
3. **页面改版** → 看 `explore.counts`，如果 `[data-key]` 有值但 `li.f-single` 是 0，说明卡片的 class 变了

### 改版了怎么修

改 `scripts/lib/actions.mjs` 里的两处：

```js
// 1. 卡片选择器（READ_SCRIPT 顶部）
const CARD_SELECTORS = ['li.f-single', 'div.f-single', 'li[class*="f-single"]', '.feed-item'];

// 2. 赞按钮（likeByKeys 里）
el.querySelector('[class*="like_btn"], [class*="qz_like"]')
```

改完跑 `node scripts/qzone.mjs feed` 验证。`firstCard` 里能看到真实的 HTML，照着写选择器。

### 只读到几条就没了

`--scrolls` 加大。注意每多滚一屏多等 1.5 秒，滚太多会慢。

---

## 点赞

### 「点了但状态没变」

优先级从高到低：

1. **风控**：短时间内赞太多。停手，隔几小时再说。**不要连着重试**，越试越糟
2. **按钮结构变了**：`explore` 看 `[class*="like_btn"]` 是不是还有值
3. **这条动态的赞需要先展开评论**：个别类型的动态（比如带长文的）赞按钮在折叠区里

### 「DOM 里找不到这条动态」

页面只渲染了前面几条，你要赞的在下面。先 `feed --scrolls 3` 拿到它，再立刻 `like` —— 但下一次 `like` 会重新开页面、重新只渲染前几条，所以**赞较旧的动态经常失败**。

解决办法：一次 `auto` 跑完，或者用 `like` 时把 `--scrolls` 也带上（`like` 目前不支持，需要在 `likeByKeys` 里加滚动，属于待增强项）。

### 「已经赞过了」但页面显示没赞

本地 `state.json` 记着赞过。删掉对应条目，或者直接删 `state.json`（会丢失去重记录，下次可能重复赞已赞过的）。

---

## 定时任务

### `service install` 成功但日志没有新内容

```bash
node scripts/qzone.mjs service status     # 看 installed 是不是 true
schtasks /Query /TN "QZone Auto Like" /FO LIST
```

再看日志：

```
%APPDATA%\qzone-skill\logs\auto.log
```

日志是**追加写**的，如果文件时间戳一直不动，说明任务没执行。

### 任务在跑但什么都没赞

这几乎总是因为**开关没开**：

```bash
node scripts/qzone.mjs status    # 看 auto.enabled 和 paused
```

`service install` 只负责「定时唤起 `auto`」，`auto` 内部每次都检查 `auto.enabled` 和 `paused` 吗？

**注意**：`auto` 命令本身**不检查**这两个开关（它被设计成「跑一次就干活」），检查发生在 `watch` 循环里。定时任务直接调 `auto`，所以它**不看开关**。

⇒ 想让它彻底不动，要么 `service uninstall`，要么在 `auto` 里加开关检查。当前行为是刻意选的：定时任务 = 明确要我跑。

### 任务删不掉

```
schtasks /Delete /TN "QZone Auto Like" /F
```

需要管理员权限时用管理员终端跑。

---

## 摘要与图片

### `digest` 返回 0 条

- 先看 `total`：`total` 是 0 → 没读到内容，按上一节排查
- `total` 有值但 `shown` 是 0 → 加了 `--since` 且确实没有新内容，正常
- 用了 `--since` 但 `skippedOld` 也是 0 → 游标丢了（间隔太久，那条已被挤出列表），这轮会返回全部

### 排序看着不对

`prefs.likedSamples` 是 0 说明还没学口味，排序等于按「有没有图 + 正文长短」。

```bash
node scripts/qzone.mjs learn
```

### 读到的条数远少于 23

QQ 空间是懒加载，每次滚动只多 4 条。可能的原因：

1. 网络慢，4～6.5 秒内没加载出来 → 重跑一次
2. 已经滚到底（页面本身就只有这么多）→ 正常
3. `--limit` 设成了 0 → 只读首屏，约 7 条

### 图片下载失败（`p` 字段缺失）

`p` 只在 `--images` 时出现，下载失败就不给这个字段。原因可能是：

- 图片 URL 过期（qpic 的 psc 链接有时效）
- 网络超时（脚本里给 15 秒）
- 文件小于 512 字节的被当成坏图丢弃

**不影响主流程**，只是那条没图。

### 图片打不开 / 格式不对

qpic 经常返回 **webp** 但 URL 后缀写的是 jpg。脚本已按文件头纠正扩展名（`.webp` / `.png` / `.jpg`）。如果你手动另存过，注意扩展名要和实际格式一致。

---

## 增量（`--since`）

### 每次都返回全部，不生效

游标存在 `state.json` 的 `lastCursor`。两种可能：

1. 从没成功推进过游标 → 正常，第一次就是全量
2. 游标指向的旧动态已经被挤出列表 → 会返回全部并重新建立游标

想看当前游标：

```bash
node -e "console.log(require(process.env.APPDATA+'/qzone-skill/state.json').lastCursor)"
```

想重置（下次重新全量）：

```bash
node -e "const fs=require('fs'),p=process.env.APPDATA+'/qzone-skill/state.json',s=JSON.parse(fs.readFileSync(p));s.lastCursor='';fs.writeFileSync(p,JSON.stringify(s,null,2));"
```

---

## Windows 专有坑

### 计划任务会弹黑框

如果看到黑框闪一下，说明 `service install` 生成的 `run-auto.vbs` 被改坏了（比如编辑器加了 BOM 或存成了 UTF-8）。

`.vbs` 必须是**纯 ASCII**。重新跑 `service install` 会重新生成。

### 路径里有空格

本工具所有路径都用双引号包起来，理论上没问题。但如果自己改 `run-auto.vbs`，记得引号。

### 中文乱码

`auto.log` 是 **UTF-8**。用 `Get-Content` 读要指定编码：

```powershell
Get-Content "$env:APPDATA\qzone-skill\logs\auto.log" -Encoding utf8 -Tail 30
```

---

## 完全重来

```bash
node scripts/qzone.mjs logout            # 删登录态
node scripts/qzone.mjs service uninstall # 删定时任务
rmdir /s "%APPDATA%\qzone-skill"         # 删所有本地数据
```

然后重新 `login`。
