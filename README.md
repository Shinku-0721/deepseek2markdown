# DeepSeek to Markdown

DeepSeek to Markdown 是一个基于 Manifest V3 的浏览器扩展，可将 DeepSeek 当前对话、全部对话或公开分享链接导出为 Markdown 或 JSON。扩展适用于 Chromium 内核浏览器，包括 Microsoft Edge 和 Google Chrome。

## 功能

- 导出当前对话为 Markdown 或 JSON。
- 将账号下的全部对话按目录组织并导出为 ZIP。
- 导出 DeepSeek 公开分享链接，无需先打开对应对话。
- 保留思考过程、网络搜索结果和消息分支，并提供 Markdown 展示选项。
- 全量导出采用受限并发、固定请求间隔和分页间隔，逐会话写入 ZIP；单个会话请求失败时继续处理其余会话。
- 按会话更新时间复用本地历史缓存，支持增量导出和中断后的接续执行。
- 文件在浏览器本地生成，不依赖额外的导出服务。

## 安装

本项目目前通过开发者模式加载，无需构建。

1. 下载或克隆本仓库。
2. 在 Edge 打开 `edge://extensions`，或在 Chrome 打开 `chrome://extensions`。
3. 启用“开发人员模式”或“开发者模式”。
4. 选择“加载解压缩的扩展”或“加载已解压的扩展程序”，然后选择仓库根目录。
5. 打开或刷新 [DeepSeek](https://chat.deepseek.com)，再从浏览器工具栏打开扩展。

更新本地代码后，需要在扩展管理页重新加载扩展，并刷新已经打开的 DeepSeek 标签页。

## 使用

### 当前对话

登录 DeepSeek 并打开任意对话。扩展识别到当前会话后，可在“当前对话”区域选择 Markdown 或 JSON。

### 全部对话

登录 DeepSeek 后先打开任意对话，以便扩展读取当前页面正在使用的登录凭证。随后在“全部对话”区域选择 Markdown 或 JSON。导出期间可以关闭弹窗；再次打开弹窗时仍会显示任务进度。

全部对话始终打包为 `deepseek-all-<时间>.zip`。每个会话使用独立目录，重名会话会自动生成不同目录名。

首次全量导出会获取全部会话历史，并在扩展本地存储中保存成功响应。再次导出时，扩展仍会读取完整会话列表，但只请求新增或 `updated_at` 已变化的会话；最终产物仍是可独立使用的完整 ZIP，而不是只包含差异的增量包。

如果页面刷新、浏览器关闭或下载阶段中断，重新打开 DeepSeek、等待扩展识别登录状态后，再次点击相同的全量导出按钮即可接续。已经成功缓存且未变化的会话不会重复请求，ZIP 会从头在本地重新生成。

### 分享链接

在“分享链接”区域粘贴完整的 DeepSeek 分享地址或 share ID，然后选择 Markdown 或 JSON。公开分享链接不要求当前标签页处于 DeepSeek 对话页面。

## Markdown 选项

这些选项只影响 Markdown；JSON 始终保留接口返回的完整会话、消息和 fragment 字段。

- **思考过程**：将思考内容写入可折叠的 `<details>` 区块。
- **网络搜索**：保留搜索与打开网页的工具记录，并生成对应的 `Search` 文件。
- **分支展示**：选择保留全部消息分支，或只保留每个分叉的最后版本。

DeepSeek 正文中的 `[reference:N]` 会转换为指向对应搜索文件的 Wiki 链接。关闭网络搜索后，不生成 `Search` 文件，并清理正文中的相关引用标记。

## 输出结构

没有搜索附件的单会话 Markdown 直接输出为 `.md`；单会话 JSON 直接输出为 `.json`。当单会话 Markdown 包含搜索文件时，输出标题同名 ZIP：

```text
会话标题.zip
└─ 会话标题/
   ├─ 会话标题.md
   └─ Search/
      ├─ 2-3.md
      └─ 2-5.md
```

全量导出使用相同的会话目录结构，并统一写入一个 ZIP 文件。

## 权限与隐私

扩展声明以下权限：

- `activeTab`：在用户打开扩展时识别并访问当前 DeepSeek 标签页。
- `storage`：保存 Markdown 选项和全量导出的会话历史缓存。
- `unlimitedStorage`：解除扩展本地存储的默认容量限制，以保存较大的历史缓存。
- `https://chat.deepseek.com/*`：请求 DeepSeek 的会话、历史记录和公开分享接口。

登录凭证仅保存在当前 DeepSeek 标签页的内存中，不写入 `chrome.storage`。成功获取的会话历史会保存在扩展本地存储中，用于后续增量导出和中断接续，并在扩展被移除时一并删除。导出内容始终在浏览器本地整理和压缩；扩展不包含后端服务，也不会把对话发送给开发者或其他自建服务。

## 注意事项

- 全量导出依赖 DeepSeek 当前网页接口，DeepSeek 更新接口后可能需要同步适配。
- 页面刷新或扩展重新加载后，需要打开任意 DeepSeek 对话，让页面发起一次请求后才能执行全量导出。
- 网络异常或接口限流会按递增间隔自动重试；多次失败的单个会话会计入失败数量，其余会话仍会继续导出。再次执行时，扩展只需补取失败或已经变化的会话。
- 会话更新时间缺失、缓存不可用或缓存版本不匹配时，扩展会直接请求对应历史，不会使用无法确认有效性的缓存。
- 导出的内容可能包含敏感信息，请妥善保管生成的文件。

## 开发与验证

项目不需要打包步骤，仓库根目录就是可加载的扩展目录。测试使用 Node.js 内置测试运行器：

```bash
node --test
node --check content.js
node --check popup/popup.js
node --check lib/deepseek-client.js
node --check lib/export-core.js
node --check lib/markdown-export.js
node --check lib/export-delivery.js
node --check lib/download-client.js
node --check lib/injected.js
node --check lib/history-cache.js
```

主要模块：

- `content.js`：协调当前、全量和分享导出，并维护任务进度。
- `lib/deepseek-client.js`：封装 DeepSeek 请求、分页、超时与重试。
- `lib/markdown-export.js`：生成 Markdown 正文和搜索附件。
- `lib/export-core.js`：统一会话数据和导出格式。
- `lib/export-delivery.js`：生成单文件或 ZIP 归档。
- `lib/download-client.js`：在当前页面上下文触发本地下载。
- `lib/injected.js`：在 DeepSeek 页面内观察当前请求使用的 Bearer Token。
- `lib/history-cache.js`：按会话更新时间维护增量历史缓存。
- `popup/`：扩展弹窗界面和交互。
- `tests/`：导出规则、归档、下载和状态测试。

ZIP 压缩使用本地固定的 [fflate](https://github.com/101arrowz/fflate) 0.8.3，采用 MIT License。

## 许可证

本项目采用 [MIT License](LICENSE)。
