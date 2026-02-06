# function.md

## FeishuUploaderSettingTab.display
```typescript
display(): void
```
- 功能: 渲染插件设置界面
- 参数: 无
- 返回值: void

## Setting.setHeading
```typescript
setHeading(): Setting
```
- 功能: 将 Setting 标记为标题样式
- 参数: 无
- 返回值: Setting

## HTMLElement.createSpan
```typescript
createSpan(options?: { text?: string; cls?: string }): HTMLSpanElement
```
- 功能: 创建 span 元素并设置可选文本和样式类
- 参数: options? - 可选的文本与类名配置
- 返回值: HTMLSpanElement

## FeishuUploaderPlugin.uploadFile
```typescript
uploadFile(file: TFile): Promise<void>
```
- 功能: 上传指定文件到飞书
- 参数: file - TFile 文件对象
- 返回值: Promise<void>

## FeishuUploaderPlugin.performNormalUpload
```typescript
performNormalUpload(file: TFile, content: string, hasImages: boolean, orderedImageInfos: ImageInfo[], progressModal: UploadProgressModal): Promise<{ token: string; url: string }>
```
- 功能: 执行正常上传流程并返回上传结果
- 参数: file - TFile 文件对象; content - string 文档内容; hasImages - boolean 是否包含图片; orderedImageInfos - ImageInfo[] 图片信息; progressModal - UploadProgressModal 进度模态框
- 返回值: Promise<{ token: string; url: string }>

## FeishuUploaderPlugin.updateHistoryTimestamp
```typescript
updateHistoryTimestamp(docToken: string): Promise<void>
```
- 功能: 更新历史记录时间戳并保存
- 参数: docToken - string 文档token
- 返回值: Promise<void>

## UploadProgressModal.constructor
```typescript
constructor(app: App)
```
- 功能: 创建上传进度弹窗
- 参数: app - App Obsidian 应用实例
- 返回值: UploadProgressModal

## UploadProgressModal.onOpen
```typescript
onOpen(): void
```
- 功能: 打开上传进度弹窗并初始化界面
- 参数: 无
- 返回值: void

## UploadProgressModal.updateProgress
```typescript
updateProgress(progress: number, step: string): void
```
- 功能: 更新进度条和步骤提示
- 参数: progress - number 进度百分比; step - string 当前步骤描述
- 返回值: void

## UploadProgressModal.complete
```typescript
complete(): void
```
- 功能: 标记上传完成并更新状态
- 参数: 无
- 返回值: void

## UploadProgressModal.showError
```typescript
showError(errorMessage: string): void
```
- 功能: 显示上传失败状态
- 参数: errorMessage - string 错误信息
- 返回值: void

## UploadResultModal.constructor
```typescript
constructor(app: App, url: string, title: string)
```
- 功能: 创建上传结果弹窗
- 参数: app - App Obsidian 应用实例; url - string 文档链接; title - string 文档标题
- 返回值: UploadResultModal

## UploadResultModal.onOpen
```typescript
onOpen(): void
```
- 功能: 打开上传结果弹窗并渲染内容
- 参数: 无
- 返回值: void

## FeishuApiClient.getDocumentBlocksDetailed
```typescript
getDocumentBlocksDetailed(documentId: string): Promise<DocumentBlock[]>
```
- 功能: 获取文档所有块的详细信息
- 参数: documentId - string 文档ID
- 返回值: Promise<DocumentBlock[]>

## FeishuApiClient.batchUpdateDocumentBlocks
```typescript
batchUpdateDocumentBlocks(documentId: string, requests: BlockUpdateRequest[]): Promise<unknown>
```
- 功能: 批量更新文档块
- 参数: documentId - string 文档ID; requests - BlockUpdateRequest[] 批量更新请求
- 返回值: Promise<unknown>

## FeishuApiClient.createDocumentBlocks
```typescript
createDocumentBlocks(documentId: string, parentId: string, index: number, children: DocumentBlockPayload[]): Promise<unknown>
```
- 功能: 创建文档块
- 参数: documentId - string 文档ID; parentId - string 父块ID; index - number 插入位置索引; children - DocumentBlockPayload[] 子块定义
- 返回值: Promise<unknown>

## FeishuApiClient.createDocumentDescendants
```typescript
createDocumentDescendants(documentId: string, parentId: string, index: number, childrenIds: string[], descendants: DocumentBlockPayload[]): Promise<unknown>
```
- 功能: 创建嵌套文档块
- 参数: documentId - string 文档ID; parentId - string 父块ID; index - number 插入位置索引; childrenIds - string[] 子块ID数组; descendants - DocumentBlockPayload[] 嵌套块定义
- 返回值: Promise<unknown>

## FeishuApiClient.batchDeleteDocumentBlocks
```typescript
batchDeleteDocumentBlocks(documentId: string, parentId: string, startIndex: number, endIndex: number): Promise<unknown>
```
- 功能: 批量删除文档块
- 参数: documentId - string 文档ID; parentId - string 父块ID; startIndex - number 起始索引; endIndex - number 结束索引
- 返回值: Promise<unknown>

## FeishuApiClient.deleteDocumentBlock
```typescript
deleteDocumentBlock(documentId: string, blockId: string, parentId?: string, index?: number): Promise<unknown>
```
- 功能: 删除单个文档块
- 参数: documentId - string 文档ID; blockId - string 块ID; parentId? - string 父块ID; index? - number 索引
- 返回值: Promise<unknown>

## FeishuApiClient.convertMarkdownToBlocks
```typescript
convertMarkdownToBlocks(content: string): Promise<MarkdownConvertResponse>
```
- 功能: 转换 Markdown 为文档块
- 参数: content - string Markdown 内容
- 返回值: Promise<MarkdownConvertResponse>

## createFeishuClient
```typescript
createFeishuClient(appId: string, appSecret: string, app?: App, apiCallCountCallback?: () => void): FeishuApiClient
```
- 功能: 创建飞书API客户端实例
- 参数: appId - string 应用ID; appSecret - string 应用密钥; app? - App Obsidian 应用实例; apiCallCountCallback? - () => void API调用计数回调
- 返回值: FeishuApiClient

## getErrorMeta
```typescript
getErrorMeta(error: unknown): ErrorMeta
```
- 功能: 提取错误对象的可用元信息
- 参数: error - unknown 错误对象
- 返回值: ErrorMeta

## isImportTaskQueryResponse
```typescript
isImportTaskQueryResponse(value: unknown): value is ImportTaskQueryResponse
```
- 功能: 判断对象是否为导入任务查询响应结构
- 参数: value - unknown 待判断对象
- 返回值: boolean

## CryptoUtils.encryptSensitiveSettings
```typescript
encryptSensitiveSettings<T extends SensitiveSettings>(settings: T): Promise<T>
```
- 功能: 加密设置对象中敏感字段并返回同结构对象
- 参数: settings - T 设置对象
- 返回值: Promise<T>

## CryptoUtils.decryptSensitiveSettings
```typescript
decryptSensitiveSettings<T extends SensitiveSettings>(settings: T): Promise<T>
```
- 功能: 解密设置对象中敏感字段并返回同结构对象
- 参数: settings - T 设置对象
- 返回值: Promise<T>

## CalloutConverter.addIndexToBlocks
```typescript
addIndexToBlocks(blocks: FeishuBlock[]): FeishuBlock[]
```
- 功能: 为文档块补充父子索引信息
- 参数: blocks - FeishuBlock[] 文档块数组
- 返回值: FeishuBlock[]

## LinkProcessor.constructor
```typescript
constructor(app: App, feishuClient: FeishuApiClient, plugin: LinkProcessorPluginContext)
```
- 功能: 创建双链处理器实例
- 参数: app - App Obsidian应用实例; feishuClient - FeishuApiClient 飞书客户端; plugin - LinkProcessorPluginContext 插件上下文
- 返回值: LinkProcessor

## MarkdownRenderer.render
```typescript
render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void>
```
- 功能: 渲染 Markdown 内容到指定容器
- 参数: app - App Obsidian应用实例; markdown - string Markdown内容; el - HTMLElement 容器元素; sourcePath - string 源路径; component - Component 组件实例
- 返回值: Promise<void>

## DeleteConfirmationModal.constructor
```typescript
constructor(app: App, message: string, onConfirm: () => void | Promise<void>)
```
- 功能: 创建删除确认弹窗
- 参数: app - App Obsidian应用实例; message - string 提示信息; onConfirm - () => void | Promise<void> 确认回调
- 返回值: DeleteConfirmationModal

## DeleteConfirmationModal.onOpen
```typescript
onOpen(): void
```
- 功能: 打开删除确认弹窗并渲染内容
- 参数: 无
- 返回值: void
