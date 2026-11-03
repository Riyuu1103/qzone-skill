# 命令参考

所有命令都可以加 `--pretty`（缩进）或 `--json`（紧凑）。终端里默认缩进。

失败时一律输出 `{"ok": false, "reason": "..."}` 并带非零退出码。

---

## login

扫码登录。

```
node scripts/qzone.mjs login [--timeout 180]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--timeout` | 180 | 等扫码的秒数 |

**过程**：起无窗口浏览器 → 打开 `user.qzone.qq.com` → 截登录框存成 `out/login-qr.png` → 每 2 秒查一次是否已登录 → 每 25 秒重截一次二维码（防过期）。

**输出**：

```json
{ "ok": true, "uin": "123456789", "nickname": "昵称", "already": false, "qrPath": "C:\\...\\login-qr.png" }
```

- `already: true` 表示本来就已经登录，没有重新扫
- 超时返回 `{"ok": false, "reason": "扫码超时，二维码已过期。重新执行 login 即可"}`

---

## logout

删掉浏览器配置目录（登录态在里面），并把配置里的 `account` 清空。

```
node scripts/qzone.mjs logout
```

---

## status

不启动浏览器，纯读本地状态，通常几百毫秒返回。

```
node scripts/qzone.mjs status
```

```json
{
  "ok": true,
  "loggedIn": true,
  "account": { "uin": "123456789", "nickname": "昵称" },
  "paused": false,
  "auto": { "enabled": true, "intervalMinutes": 30, "like": { ... } },
  "home": "C:\\Users\\...\\AppData\\Roaming\\qzone-skill"
}
```

---

## config

```
node scripts/qzone.mjs config                      # 全部
node scripts/qzone.mjs config auto.like.maxPerRun  # 单项
node scripts/qzone.mjs config auto.like.maxPerRun 5   # 改
```

值的类型由**原值的类型**决定：

| 原值类型 | 输入 | 结果 |
|---|---|---|
| number | `5` | `5` |
| boolean | `1` / `0` / `true` / `false` | `true` / `false` |
| array | `张三,李四` | `["张三","李四"]` |
| array | `["a","b"]` | `["a","b"]` |
| 对象 | `{"k":1}` | 解析成对象 |

完整的配置项见 `README.md` 的「配置」一节。

---

## feed

读好友动态。

```
node scripts/qzone.mjs feed [--scrolls 2]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--scrolls` | 2 | 向下滚几屏（每屏等 1.5 秒）。滚得越多读到的越旧 |

**输出**：

```json
{
  "ok": true,
  "count": 12,
  "items": [
    {
      "key": "abc123",
      "name": "张三",
      "text": "正文（最多 500 字）",
      "time": "3小时前",
      "liked": false,
      "hasImage": true
    }
  ],
  "probe": {
    "title": "QQ空间",
    "url": "https://user.qzone.qq.com/123456789",
    "cardCount": 12,
    "candidates": { "li.f-single": 12, "[data-key]": 12 }
  }
}
```

`probe` 是排查用的：`cardCount` 是 0 说明页面结构变了或没登录。

---

## like

```
node scripts/qzone.mjs like <key> [key2 ...]
```

两条之间按配置的 `auto.like.minIntervalSec` 间隔（默认 8 秒）。

**输出**：

```json
{
  "ok": true,
  "results": [
    { "key": "abc123", "ok": true, "before": "qz_like_btn_v3", "after": "qz_like_btn_v3_on", "reason": "ok" }
  ]
}
```

单条失败不会中断整批，失败项的 `ok` 是 `false`，`reason` 说明原因。

---

## auto

跑一轮：读动态 → 按规则筛选 → 点赞 → 记状态 → 返回摘要。

```
node scripts/qzone.mjs auto [--dry-run] [--scrolls 2]
```

`--dry-run` 只算不赞。

**输出**：

```json
{
  "ok": true,
  "dryRun": false,
  "total": 15,
  "picked": 8,
  "skipped": [{ "key": "x1", "name": "李四", "why": "命中 denyUsers" }],
  "liked": [{ "key": "abc123", "ok": true, "reason": "ok" }],
  "probe": { ... }
}
```

去重靠 `state.json` 里的 `liked` 表，最多保留最近 500 条。

---

## on / off / pause / resume

```
node scripts/qzone.mjs on        # auto.enabled = true
node scripts/qzone.mjs off       # auto.enabled = false
node scripts/qzone.mjs pause     # 写 PAUSED 文件，运行中的循环立刻停手
node scripts/qzone.mjs resume    # 删 PAUSED 文件
```

区别：

- `on/off` 写进**配置文件**，重启后仍然有效
- `pause/resume` 只动一个标记文件，不改配置，用来临时打断

两个都要放开才真的会跑：`auto.enabled === true && !paused`。

---

## watch

前台常驻循环，适合自己开着终端跑。

```
node scripts/qzone.mjs watch [--interval 30]
```

每轮醒来先检查开关，未开启或已暂停就跳过（不会退出进程）。日志打到 stderr。

`Ctrl+C` 结束。

---

## service

系统定时任务。

```
node scripts/qzone.mjs service status
node scripts/qzone.mjs service install --interval 30
node scripts/qzone.mjs service uninstall
```

Windows 上实际做的是：

1. 在配置目录生成 `run-auto.vbs`（**纯 ASCII**，内容只有两行）
2. 建计划任务 `QZone Auto Like`，操作为 `wscript.exe "...\run-auto.vbs"`

用 wscript 而不是直接指向 node，是因为计划任务直接跑 `.exe` / `.cmd` 会创建**可见的控制台窗口**，每 30 分钟闪一下。`wscript` + `Run(..., 0, ...)` 是真正的隐藏执行。

日志：`logs/auto.log`（追加写）。

macOS / Linux 上不自动改 crontab（改别人的 crontab 太越界），只返回一行建议。

---

## explore

页面结构探测。改版后排查用。

```
node scripts/qzone.mjs explore
```

**输出**：

```json
{
  "ok": true,
  "uin": "123456789",
  "url": "https://user.qzone.qq.com/123456789",
  "title": "QQ空间",
  "counts": { "li.f-single": 12, "[data-key]": 12, "[class*=\"like_btn\"]": 12 },
  "firstCard": "<li class=\"f-single\" …>（前 3000 字符）",
  "bodyLen": 5231,
  "screenshot": "C:\\...\\out\\explore.png"
}
```

`counts` 全 0 → 没登录或页面没加载；`firstCard` 用来确认选择器要不要改。
