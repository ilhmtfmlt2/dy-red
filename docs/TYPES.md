# `text_extra.type` 枚举表

所有结论基于 **DouX APK 反编译** + **2026-11 线上评论数据实测**。

## 已验证

| type | 名称 | 结构 | 服务端 | 渲染 | 结论 |
|---|---|---|---|---|---|
| `0` | @提及 | `user_id` + `sec_uid` | ✅ 接受（原生 @） | 蓝色可点链接 | 手写会被拒（`status_code: 5`），需输入框原生 token |
| `1` | 话题 | `hashtag_name` + `hashtag_id` | ⚠️ 空 hashtag 会被剥离 | 话题蓝（带 `#` 前后缀） | 裸发不可见，必须走话题蓝 |
| `21` | 搜索命中（红字） | 空字段即可 | ✅ 接受 | 红/深色黄 | **唯一稳定可用** |
| `33` | 位置 | 需正文 `[位置]` 前缀 + `poi_id` | ✅ 接受 | web 端待验证 | 网页端无入口，效果不保证 |
| `65282` | 私有粉色 | 空字段 | ❌ 拒绝（`status_code: 5`） | App 旧版可见 | 已被服务端白名单剔除 |

## 线上真实样本

### type 21（红字，整段）

```json
{
  "text": "真的吗",
  "text_extra": [
    { "start": 0, "end": 3, "user_id": "", "type": 21, "hashtag_name": "", "hashtag_id": "" }
  ]
}
```

### type 21（红字，隔字分段）

```json
{
  "text": "是这个样子的么[捂脸]",
  "text_extra": [
    { "start": 0,  "end": 1,  "type": 21 },
    { "start": 2,  "end": 3,  "type": 21 },
    { "start": 4,  "end": 5,  "type": 21 },
    { "start": 6,  "end": 7,  "type": 21 },
    { "start": 8,  "end": 9,  "type": 21 },
    { "start": 10, "end": 11, "type": 21 }
  ]
}
```

### type 0（@提及）

```json
{
  "text": "<@红色",
  "text_extra": [
    {
      "start": 1,
      "end": 4,
      "user_id": "100492915676",
      "type": 0,
      "hashtag_name": "",
      "hashtag_id": "",
      "sec_uid": "MS4wLjABAAAALy6eRltdvFDsECeiXHVoiWIO5O_4_6GuiYmMq_TxLYA"
    }
  ]
}
```

### type 5（搜索词高亮，读者侧自动生成）

```json
{
  "start": 0,
  "end": 4,
  "type": 5,
  "search_text": "关键词",
  "search_query_id": "..."
}
```

手动构造无意义——这是读者搜索时由客户端注入的。

## 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `start` | int | UTF-16 起始索引（含） |
| `end` | int | UTF-16 结束索引（不含） |
| `type` | int | 样式类型 |
| `user_id` | string | @用户的数字 ID（16~19 位） |
| `sec_uid` | string | @用户的加密 ID（`MS4wLjABAAAA...`） |
| `hashtag_name` | string | 话题名（不带 `#`） |
| `hashtag_id` | string | 话题 ID（数字字符串） |

## 客户端渲染差异

| 场景 | type 21 | type 1 | type 33 |
|---|---|---|---|
| 网页版 | 红（深色模式黄） | 话题蓝（需 hashtag） | 不渲染 |
| iOS App | 红/黄 | 旧版评论区可见蓝 | 需 POI |
| Android 旧版评论区 | 红 | 可见 | 可见 |
| Android 41.x 新版（KMP） | 红 | 不渲染 | 不渲染 |

> DouX 的更新日志原文：「新增新版评论区红字样式，恢复旧版评论区无前后缀蓝字」——印证了 `21` 是新版红字、`1` 是旧版蓝字。

## 发布请求字段（实测）

```
aweme_id, comment_send_celltime, comment_video_celltime,
one_level_comment_rank, paste_edit_method, text, text_extra
```

- **没有 `poi_id`**：位置信息只能放 `text_extra` 或正文
- `text_extra` 为 URL 编码后的 JSON 字符串
- 服务端对 `type` 有白名单校验：非法 type（如 65282）会让整个请求返回 `status_code: 5`
