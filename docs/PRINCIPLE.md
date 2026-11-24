# 原理详解：抖音评论为什么会「变色」

本文记录从逆向到实测的完整链路，所有结论都有**线上数据**或**反编译源码**支撑。

---

## 一、评论不是纯文本

抖音的评论模型里，正文是一个字符串，外加一个 `text_extra` 数组：

```json
{
  "text": "人生若只如初见",
  "text_extra": [
    { "start": 0, "end": 7, "user_id": "", "type": 21, "hashtag_name": "", "hashtag_id": "" }
  ]
}
```

每个元素表示：**正文的第 `start` 到 `end` 个字符不是普通文字，而是一个带样式的区间**。

| 字段 | 含义 |
|---|---|
| `start` / `end` | UTF-16 索引（左闭右开），`end - start` = 区间长度 |
| `type` | 样式类型（见 [TYPES.md](TYPES.md)） |
| `user_id` / `sec_uid` | `type:0`（@提及）时指向用户 |
| `hashtag_name` / `hashtag_id` | `type:1`（话题）时指向话题 |

这就是为什么 `#话题#`、`@某人`、搜索高亮能显示成不同颜色——**客户端只是照着 `text_extra` 画**。

---

## 二、为什么「人人可见」

关键在于：**颜色写在评论数据里，不在你的浏览器里**。

```
你发评论
  → 请求体带上 text_extra
  → 服务端原样落库
  → 任何人拉评论列表，都拿到同一份 text_extra
  → 每个人的官方客户端用自己的渲染逻辑画颜色
```

所以：

| 方案 | 改的是什么 | 别人能看到？ |
|---|---|---|
| 本脚本 | 发布请求里的 `text_extra` | ✅ 是 |
| CSS / DOM 注入脚本 | 你屏幕上的样式 | ❌ 只有自己 |
| 图片评论 | 内容载体 | ✅ 是（但已不是文字） |
| Unicode 花体 | 文本内容本身 | ✅ 是（但没有颜色） |

**观看端不需要装任何东西**，这是「数据层」与「渲染层」的区别。

---

## 三、注入点：篡改发布请求

抖音网页版发表评论走 `POST /aweme/v1/web/comment/publish`，body 是 `application/x-www-form-urlencoded`：

```
aweme_id=...&text=评论内容&text_extra=[]&comment_send_celltime=...&...
```

脚本在 `XMLHttpRequest.prototype.send`（以及 `fetch`）里拦截：

1. 判断 URL 包含 `comment/publish`
2. 解析 body，取出 `text`
3. 按选定样式生成 `text_extra` 段
4. 用 `encodeURIComponent(JSON.stringify(segments))` 覆盖 `text_extra` 字段
5. 其余字段一个字节不动，原样发送

**核心原则**：
- 只改 `text_extra`（位置/话题样式额外改 `text` 前缀）
- 正文绝不重新编码（避免把用户的 emoji / 换行破坏）
- 任何异常都放行原请求（`try/catch` 兜底，失败等于普通评论）
- 不缓存、不上报、不请求任何外部地址

---

## 四、type 枚举的逆向过程

### 4.1 从 DouX 反编译得到候选

DouX 是一个 LSPosed 模块，核心样式逻辑在 `com.shijiuyyds.doux.comment.t6`：

```java
// red_blue_alt：每个非空白字符单独一段，偶数段红、奇数段蓝
byte b3 = i8 % 2 == 0 ? (byte) 21 : (byte) 1;

// 结构：start / end / type
new r6(s6Var.a, s6Var.b, b3)
```

它的样式表（`t6.java` 的样式名）：

| 样式名 | type | 语义 |
|---|---|---|
| `mention` | 0 | @提及 |
| `hashtag` | 1 | 话题蓝字 |
| `search` | 21 | 搜索命中（红字） |
| `location` | 33 | 位置 |

`location` 分支还做了关键处理：

```java
if (str.equals("location")) {
    strConcat = "[位置]".concat(strConcat);   // 正文前加 [位置]
}
```

### 4.2 用线上数据验证

用 `ttwid` + `a_bogus=1`（`a_bogus` 只做存在性校验）免签拉取真实评论：

```bash
GET https://www.douyin.com/aweme/v1/web/comment/list/
    ?aweme_id={id}&cursor=0&count=50&a_bogus=1&...
Cookie: ttwid=xxx
```

299 条评论的 `type` 分布：

```
{21: 39, 0: 5}     ← 39 条红字、5 条 @、0 条蓝字
```

红字样本（服务端原文）：

```json
{
  "text": "是这个样子的么[捂脸]",
  "text_extra": [
    { "start": 0, "end": 1, "user_id": "", "type": 21, "hashtag_name": "", "hashtag_id": "" },
    { "start": 2, "end": 3, "user_id": "", "type": 21, "hashtag_name": "", "hashtag_id": "" },
    { "start": 4, "end": 5, "user_id": "", "type": 21, "hashtag_name": "", "hashtag_id": "" }
  ]
}
```

`@` 样本（注意 `user_id` 是真实的 16 位数字）：

```json
{
  "text": "<@红色",
  "text_extra": [
    { "start": 1, "end": 4, "user_id": "100492915676", "type": 0, "sec_uid": "MS4wLjABAAA..." }
  ]
}
```

**结论**：`type 21` 就是红字，`type 0` 是 @，`type 1` 在这批数据里一条都没有。

---

## 五、三种样式的真相

### 5.1 红字（type 21）—— 唯一稳定可用

- 语义：搜索命中高亮
- 渲染：新版评论区红/深色黄，iOS 也认
- 结构：`{"start":0,"end":N,"type":21,"user_id":"","hashtag_name":"","hashtag_id":""}`
- **服务端接受并原样下发**（39 条线上样本佐证）
- 全部字符染一段即可，也可以分段

### 5.2 蓝字（type 1）—— 本质是话题，不是「蓝色字体」

- `type 1` 是**话题样式**，必须带 `hashtag_name` / `hashtag_id` 才有意义
- 裸发（`hashtag_name` 空）Web 端：本地乐观渲染能看到蓝色，**但服务端会剥离**，别人拉到的数据里没有
- 能人人可见的只有「话题蓝」：正文写 `#话题名#`，`text_extra` 指向话题名，客户端渲染成蓝色话题链接
- DouX 那种「无前后缀蓝字」是 **App 旧版评论区**专属渲染路径，网页端复刻不了

### 5.3 位置（type 33）—— 需要正文前缀 + POI

- DouX 的实现：正文前加 `[位置]`，`text_extra` 指向整段或部分
- Web 发布接口的字段列表里**没有 `poi_id`**：

  ```
  aweme_id, comment_send_celltime, comment_video_celltime,
  one_level_comment_rank, paste_edit_method, text, text_extra
  ```

- 也就是说位置信息只能塞在 `text_extra` 里或靠正文前缀；`poi_id` 属于「额外尝试」
- 实测：纯 `type 33` 服务端接受（`status_code: 0`）但网页端与普通评论无区别；补 `[位置]` 前缀和 `poi_id` 后仍待验证

---

## 六、「红蓝相间」的两种手法

### 手法 A：DouX 原版（`red_blue_alt`）

```
每个非空白字符一段，连续覆盖：
[0-1, 21] [1-2, 1] [2-3, 21] [3-4, 1]
```

依赖 `type 1` 被服务端保留 + 客户端渲染成蓝色。Web 端 `type 1` 会被剥离，所以蓝段通常失效（变回默认色）。

### 手法 B：线上样本（全 21 隔字）

真实数据里另一款工具的做法：

```
文本：是这个样子的么[捂脸]
段：  [0-1,21] [2-3,21] [4-5,21] [6-7,21] [8-9,21] [10-11,21]
```

**全部是 `type 21`，但只染第 1、3、5… 个字符，中间留空**。推测是借客户端对连续搜索高亮段的交替配色（红/黄）制造「多彩」效果。

本脚本同时提供两种（`红蓝·连续` / `红黄·隔字`），实测对比。

---

## 七、服务端与客户端的边界

| 环节 | 能控制吗 | 说明 |
|---|---|---|
| 发布请求体 | ✅ 脚本可改 | `text_extra`、`text` |
| 服务端落库 | ⚠️ 不可控 | 可能校验/剥离非法样式 |
| 下发数据 | ⚠️ 不可控 | 剥离后的样式无法恢复 |
| 客户端渲染 | ❌ 不可控 | 由对方的抖音版本决定 |

这解释了几个现象：

- 同样的 `type 21`，有人看到红、有人看到黄（客户端主题不同）
- `type 1` 自己能看到蓝、别人看不到（本地乐观渲染 vs 服务端剥离）
- `type 33` 服务端接受但网页端不渲染（缺 POI 渲染路径）

---

## 八、实测方法论（无需安卓设备）

```python
# 1. 拿 ttwid
POST https://ttwid.bytedance.com/ttwid/union/register/
     {"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com",...}

# 2. 免签拉评论（a_bogus 填 1 即可，真门只有 ttwid）
GET https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id={id}&a_bogus=1&...
Cookie: ttwid=xxx

# 3. 找自己刚发的评论，看 text_extra 是否被保留
```

这套方法可以在没有安卓手机的情况下，验证「服务端到底存没存样式」。

---

## 九、风险与边界

1. **风控**：篡改发布请求比纯 CSS 敏感；建议小号、低频
2. **服务端校验**：若某天红字也要求身份，样式会被剥离
3. **版本适配**：抖音前端频繁改版，`text_extra` 字段名与渲染行为可能变化
4. **合规**：仅用于技术研究，勿用于刷屏/引流

---

## 十、参考

- DouX APK 反编译：`com.shijiuyyds.doux.comment.t6`（样式枚举与分段）、`h0.java`（注入执行体）
- 2023 年 Super Douyin 油猴脚本：最早的 `text_extra` 注入公开实现（`type 65282` 粉色，已被服务端拒绝）
- 抖音网页版 `comment/list` / `comment/publish` 接口实测（2026-11）
