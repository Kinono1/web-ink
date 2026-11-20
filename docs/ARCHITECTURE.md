# 模块边界与内部 API

Web Ink 是 Manifest V3 扩展。WXT 从 `entrypoints/` 构建后台 Service Worker、网页脚本、侧栏、资料库和 PDF 阅读器。Chrome 配置文件承载持久数据。网页和扩展页面经由后台 RPC 读写标注。

## 依赖方向

| 模块 | 职责和允许依赖 |
| --- | --- |
| `entrypoints/` | 装配各运行入口，调用所属的后台、网页、PDF 或管理模块以及共享契约。WXT 发现入口文件，后台按权限与文档状态注入网页脚本。 |
| `src/core/` | 提供记录、URL、锚点、公共验证和消息类型。浏览器适配文件调用 Chrome API。这里的内部依赖指向其他 `core/` 模块。 |
| `src/background/` | WXT 后台入口管理生命周期、注册和广播。`rpc.ts` 校验发送者与当前网页，分发网页、PDF 和数据消息。持久数据由 `data/` 按标注、页面模式和备份请求分发，Dexie 事务负责提交。PDF Port 独立校验阅读器与侧栏的会话绑定。 |
| `src/content/` | 轻量 `bootstrap.ts` 管理浮动入口、权限状态和懒加载。引擎由 `AnnotationController` 组合 `UIController`、`DataEngine` 和 `PageRefresh`。网页写入使用 `core/client.ts`。 |
| `src/pdf/` | 管理文件会话、渲染代次、草稿、原文件笔记与导出 Worker。管理页面复用 `pdf/public.ts`、笔记显示组件和文案。阅读器依赖共享的图标、查询 hook、预设控件和页面样式。 |
| `src/ui/` | 侧栏、资料库和设置负责交互及展示。`ui/shared/` 的图标和查询 hook 依赖 React 与 `core/`，也供阅读器使用。 |
| `scripts/`、`skills/web-ink-annotations/` | 前者构建、封存、验证和打包扩展。后者通过 Python CLI 读取用户选定的 JSON。两者通过运行文件、构建清单和版本化导出格式与扩展交互。 |

新增持久化功能时，先在 `core/model.ts` 定义消息和结果，再在后台验证输入、确认发送者权限并提交存储。其他页面通过 `core/client.ts` 发请求。新增跨页面显示组件时，把通用部分放入 `ui/shared/`，把 PDF 专用部分放入 `pdf/components/`。

PDF 的会话、视口和草稿状态在 `reader-state.ts` 分别定义。行为 hook 从对应状态中选择所需字段。`PdfReader.tsx` 组装渲染快照，在换文档时按顺序清理各模块状态。

## 请求与数据契约

| 请求 | 约定 |
| --- | --- |
| `annotations.list`、`annotations.query` | 扩展页面可查询资料库。网页脚本限当前顶层文档的规范 URL。`query` 使用 `updatedAt` 与 `id` 游标，`requestId` 在发送文档内有效。没有页面、类型或颜色限制的标签查询可通过现有索引批量读取最多 128 条记录。更大的集合沿用按游标顺序扫描。 |
| `annotations.put`、`annotations.delete`、`annotations.restore` | 新建使用 `expectedRevision: 0`。更新、删除和恢复对照事务中读取的版本或删除记录。冲突返回 `CONFLICT`。相同内容的 `annotations.put` 可安全重试。 |
| `backup.preview`、`backup.import`、`backup.export`、`storage.stats` | 仅扩展页面可调用。导入先验证完整 JSON，再在单个事务中查找本地版本与墓碑、批量写入标注和页面、更新统计。每页按导入顺序采用最后一条写入记录的标题和时间。校验上限为 20 MiB 和 50,000 条标注。 |
| `pdf.openCurrent`、`pdf.handoff.*`、`pdf.prepared.*` | 后台核对入口、标签页、文档或会话。`pdf-handoff/tab-context.ts` 固定 Chrome 标签页、文档和代次。`pdf-handoff/session-store.ts` 验证用于返回原页面的临时记录。普通在线 PDF 使用显式站点授权和无凭据 HTTPS 请求。IEEE 会话流限定授权源，按期限回收临时数据。 |
| `web-ink-pdf-reader`、`web-ink-pdf-sidebar` | 后台代理 Chrome Port。命令绑定当前标签页和阅读器会话。阅读器拥有草稿与持久化动作，侧栏消费快照并发出命令。 |

`request<T>()` 在后台返回 `{ ok: true, data }` 后解析，失败时抛出包含错误码的 `RequestError`。写入成功的响应表示事务已提交。后台把输入、权限、导航和冲突作为可处理结果返回。意外的存储和路由失败返回固定的 `INTERNAL` 消息，开发者控制台记录操作名和错误码。PDF 会话保留其诊断码。离线、切页、端口断开等预期状态由拥有该会话的模块处理。

相关入口见 [后台 RPC](../src/background/rpc.ts)、[核心消息类型](../src/core/model.ts)、[数据 RPC 处理器](../src/background/data/handler.ts)、[PDF Port 代理](../src/background/pdf-sidebar.ts)和[本地开发步骤](../README.md#开发与验证)。
