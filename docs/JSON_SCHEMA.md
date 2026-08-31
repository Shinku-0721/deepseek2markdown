# JSON 导出格式说明

JSON 导出用于保留 DeepSeek 接口返回的会话数据。每个 `.json` 文件的顶层都是一个会话对象，不存在 `exportedAt`、`scope` 或 `sessions` 包装层。

DeepSeek 网页接口可能新增、删除或调整字段。本扩展会尽量原样保留接口字段，因此本文只描述扩展可以保证的结构和补充字段，不是上游接口的封闭 JSON Schema。

## 输出文件

| 导出来源 | 输出形式 | 每个 JSON 文件的数据来源 |
| --- | --- | --- |
| 当前对话 | `<会话标题>.json` | 当前会话历史接口的 `data.biz_data` |
| 全部对话 | `deepseek-all-<时间>.zip` 中每个会话目录下的 `<会话标题>.json` | 会话列表元数据与对应历史接口 `data.biz_data` 的合并结果 |
| 分享链接 | `<分享标题>.json` | 公开分享接口的 `data.biz_data` |

文件名和 ZIP 路径会经过跨平台安全处理，不一定与原始标题逐字相同。JSON 对象中的 `title` 仍保留会话标题。

## 通用结构

正常导出的顶层值是一个对象，常见结构如下：

```json
{
  "id": "<session-id>",
  "title": "<session-title>",
  "messages": []
}
```

以下字段由扩展提供稳定语义：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` 或上游原始类型 | 会话标识。当前对话缺失时使用 URL 中的会话 ID；分享数据缺失时使用 share ID。 |
| `title` | `string` | 会话标题。当前对话或分享数据缺失时使用对应的后备标题。 |
| `messages` | `array` | 私有会话历史的规范化消息视图，来源为上游 `chat_messages` 或 `messages`。 |
| `chat_messages` | `array` | 上游接口提供时原样保留；可能与 `messages` 表示同一组消息。 |

消息、fragment、搜索结果、模型信息、时间戳和附件描述等字段均来自 DeepSeek 接口。扩展不会把这些可能变化的字段限制为固定清单。

## 当前对话

当前对话 JSON 以历史接口的 `data.biz_data` 为基础，并确保存在：

- `id`：优先使用历史响应中的值，否则使用当前路由中的会话 ID。
- `title`：优先使用历史响应中的值，否则使用页面标题或“当前对话”。
- `messages`：由 `chat_messages` 或 `messages` 规范化得到。

业务错误或缺少必要历史结构时不会生成下载文件，错误会显示在扩展状态区域。

## 全部对话

全量导出为每个会话生成一个独立 JSON 文件。对象由会话列表元数据与历史数据合并，因此通常还包含 `updated_at`、`pinned` 等列表字段；实际字段以当次接口响应为准。

如果某个会话的历史获取失败，其他会话仍会继续导出。失败会话保留列表元数据，并补充：

```json
{
  "id": "<session-id>",
  "title": "<session-title>",
  "messages": [],
  "export_error": "<history request error>"
}
```

`export_error` 只会出现在全量导出中单个会话历史获取失败的文件内。列表获取失败或 ZIP 构建失败会中止整个任务，不会生成带该字段的普通会话文件。

## 分享链接

分享 JSON 原样保留公开分享接口 `data.biz_data` 中的未知字段，并只在缺失时补充 `id` 和 `title`。分享接口可能使用 `chat_messages`、`messages` 或其他随版本变化的字段；扩展不会为 JSON 强制改写完整结构。

## Markdown 选项和附件

“思考过程”“网络搜索”和“分支展示”只影响 Markdown 渲染。JSON 始终保存接口返回的完整会话对象，不按这些选项过滤消息或 fragment。

JSON 导出不会额外请求或下载上传文件。接口响应中已有的附件元数据仍会随会话对象保存，但 ZIP 中不会新增 `Files` 目录或附件内容。
