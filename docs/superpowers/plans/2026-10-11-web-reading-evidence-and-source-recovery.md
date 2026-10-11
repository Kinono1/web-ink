# 计划三：网页阅读证据留存、来源状态与可审计恢复

> 给实施 agent：这是数据和备份兼容性改动。使用 superpowers:executing-plans 逐任务执行；迁移、证据不可变、跨页恢复与并发必须独立审查。不得以定位失败推断文章已删除。

**目标：** 即使原文章改写、迁移或消失，用户仍能知道当时标了什么、何时标注、原地址是什么；现在能否访问与定位单独记录，并让只读 skill 正确回顾这些证据。

**架构：** 现有 top-level pageUrl/target 继续表示当前绑定；新增不可变 origin 与追加式重绑定历史。来源观察和阅读时间放入现有 pages 元数据；不保存全文/HTML，不做后台网站监控。

**技术：** 现有 Dexie、文字/图片锚点、内容脚本、Chrome 侧栏和备份验证；新备份 schema v3、内部 Dexie version 4。无新运行时依赖。

**规格：** 本文是设计与执行规格。基于计划一、二的验收 main；目标版本 `0.4.0`，实施前核对实际基线。

## 1. 已锁定的产品原则

- 所有已保存标注保留，来源不存在、改动或无法定位都不能自动删除记录。只有用户删除才进入现有撤销/冲突保护流程。
- 默认自动保存所选摘录与附近上下文，不保存整篇正文、HTML、截图或图片 bytes。来源状态不是原文的永久存档。
- 记录标注创建时间和已标注文档重开时间，不记录未标注网页，不采集完整浏览历史，不以网页打开证明用户已经读完。
- 不做定时联网巡检；进入已标注网页时检查现有 DOM/锚点，资料库的“检查来源”才额外联网。关闭页面后的状态显示最后检查时间，不伪装为实时状态。
- 默认严格恢复：原摘录、上下文和原作用域能唯一匹配时显示；改变 offset 不必改写持久记录。歧义或无法确认时不猜位置、不静默套到相似文章。
- 原地址与当前绑定地址分开；跳转、canonical、标题相同不能自动合并来源，也不修改现有 query/SPA URL 规范化策略。
- PDF 继续按精确文件 hash 隔离。网页迁移流程不用于把旧 PDF 坐标套到新文件；新版 PDF 显示旧资料可回顾，人工重建新标注另立关联，不自动迁移。

## 2. 任务 A：不可变证据、上下文和数据迁移

**实现责任：** model/validation、database/data、backup；锚点算法继续使用现有目标模型，不引入另一套搜索引擎。

```ts
type AnnotationOrigin = {
  pageUrl: string; pageTitle: string;
  target: TextTarget | ImageTarget | PdfTarget;
  shape?: ImageShape; // 图片标记的原始形状，其他类型不得携带。
  capturedAt: string; // 标注创建时间，不能被重新绑定改写。
  context?: { before: string; after: string; mode: 'paragraph' | 'legacy-anchor' };
  captureQuality: 'at-creation' | 'legacy-unverified';
};
type RebindEvent = {
  at: string;
  from: { pageUrl: string; pageTitle: string; target: Annotation['target'] };
  to: { pageUrl: string; pageTitle: string; target: Annotation['target'] };
  method: 'manual-text' | 'manual-image';
};
// Annotation 增加 origin 和 rebindHistory。
// 原 pageUrl/pageTitle/target 保持“当前用于定位的绑定”语义。
```

- [ ] 新建文本标注时，在现有阅读根内取得所选范围所在段落的前后文，各最多 2,000 Unicode 字符；选中文本自身由 target.exact 原样保存，不因上下文上限截断。跨多个段落取首段前文和末段后文，不抓整篇正文。图片 origin 同时保存 target 与原 shape，后续改图形也不能改变这份初始证据。
- [ ] 不抓输入框、contenteditable、密码表单或脚本/style/隐藏文本。图片保留现有 alt/caption/context 和原始 shape，不另存图片；PDF 使用现有 exact/prefix/suffix/页码/文件 hash。
- [ ] origin、创建时间和 ID 在首次保存后不可变。修改笔记、标签、颜色不更改 origin，不复制追加一份原始记录。
- [ ] 迁移已有 v1/v2 记录：保留 ID/revision/createdAt/updatedAt/笔记/标签/颜色/current target/PDF hash；复制现存引用为 origin，rebindHistory=[]，captureQuality=legacy-unverified；已有 64 字符锚点前后文作为 legacy-anchor。
- [ ] 不声称迁移恢复了当年原始引用：旧版本可能已覆盖锚点，无法重建。UI 明示“旧版现存摘录；更早的引用历史未记录”。createdAt 仍可标为首次标注时间，但现存摘录的历史来源未验证。
- [ ] Dexie 升到 version 4，补 origin.pageUrl、[origin.capturedAt+id] 查询索引；迁移与统计重算在 upgrade transaction 内完成。失败保留原库并报错，不清空数据库、不拿旧结构继续写。
- [ ] `annotations.query` 增加可选 originPageUrl 和 sortBy:'updatedAt'|'capturedAt'；默认维持最近修改排序，新 cursor 绑定排序键和 ID，禁止不同排序混用 cursor。按原文分组及回顾时间的查询走新索引，不能先取前 50 条再在前端假装全库筛选。
- [ ] schema v3 JSON 包含完整 origin、rebindHistory、当前绑定及相关 pages 的证据元数据。读入 v1/v2 时走同一纯迁移，v3 完整验证后事务导入。
- [ ] 备份仍保留 20 MiB/50,000 条上限，不自动删上下文或历史来通过导出。达到容量警戒显示实际限制，支持按文档和用户当前筛选导出资料；全库备份超限明确失败，本轮不设计自动分片。
- [ ] 更新前要求用户先保存旧版 JSON。旧版本不能导入 v3，要在说明中明确；不提供会丢失历史的无提示降级导出。

## 3. 任务 B：来源状态、摘录变化与阅读时间

**不用单个 exists:boolean。** 三个维度各有证据和时间，互不推导：

| 维度 | 内部状态 | 用户文案与含义 |
|---|---|---|
| 来源访问 | unchecked | 尚未检查 |
| 来源访问 | accessible | 本次成功打开并读取页面；不是永久有效 |
| 来源访问 | http-reachable | 服务器返回成功状态，但文章可读性尚未确认 |
| 来源访问 | not-found | 本次明确得到 404/410；可能以后恢复，不写“永久删除” |
| 来源访问 | restricted | 401/403 或实际观察到登录/权限要求 |
| 来源访问 | failed | 网络、超时或无法验证；不等于文章不存在 |
| 来源访问 | redirected | 明确跳转到另一个地址；目标是否同文未确认 |
| 摘录比较 | matched | 所存摘录与相关上下文仍匹配；不证明整篇文章没改 |
| 摘录比较 | context-changed | 原作用域内唯一找到摘录，但附近语境不同；不能直接恢复高亮 |
| 摘录比较 | absent-in-scope | 能检查原作用域但没找到摘录；不等于已证明全文删除 |
| 摘录比较 | different-binding | 用户确认的新引用与历史摘录不同 |
| 摘录比较 | unknown | 原作用域、权限或页面尚未就绪，无法比较 |
| 本页定位 | pending/located/unresolved/unsupported | 沿用现有定位状态；只代表当前标签页 |

**持久数据：** PageRecord 增加 lastSourceCheck `{status,checkedAt,method,httpStatus?,observedUrl?}` 和 reading `{lastOpenedAt?,openCount}`；单条 annotation 增加 latestExcerptCheck `{status,checkedAt,observedUrl}`。定位状态保持当前 tab/session，不把关闭页面后的 located 当作新页面验证。

- [ ] 来源可访问由实际已授权页面的阅读就绪事件取得；不能从“有 Chrome 标签”“HTTP 200”或“标注未定位”独自推导文章可读。
- [ ] 明确 404/410/401/403 仅由用户点击“检查来源”后的受控请求或可取得的可靠浏览器响应得出；页面 DOM 像错误页时只能记无法确认。
- [ ] 手动 HEAD/GET 的成功响应只记 http-reachable，只有实际页面阅读就绪才记 accessible；二者不得混成“文章仍完整存在”。
- [ ] 手动检查只针对所选原始/当前来源，使用已有 host 授权。公开模式 credentials:omit、redirect:error，HEAD 不支持时才用取消可控的有界 GET；不将正文写入存储。十秒超时，同一来源一个在途任务。
- [ ] Fetch 无法读取 opaque redirect 的目标时仍只记 redirected、目标未知，不假称拿到了 Location。用户实际浏览到新地址后可供人工确认。
- [ ] 登录来源不做无凭据探测后标“已失效”。用户在实际原站登录页面检查，或使用计划一已有明确授权的限定 session 模式；没有有效会话时显示未确认/需登录。
- [ ] 进入已标注页复用现有阅读根索引与 MutationObserver，比较摘录，不新增持续全文 hash/定时扫描。新增文字在其他段落只影响页面内容，不足以判定已标摘录改变。
- [ ] 摘录比较始终针对 origin.target/原始上下文，定位则针对当前 target。新绑定引用与原始引用不同，即使当前高亮能定位也保持 different-binding，不能写成“原摘录仍匹配”。
- [ ] 每个稳定文档加载/SPA 路由进入在阅读根就绪后记一次 lastOpenedAt；同一 tab/document 不因焦点、主题、service worker 唤醒、重复注入或侧栏打开重复计数。无需新增历史表或每次访问事件数组。
- [ ] 首次标注时间来自各条 createdAt/origin.capturedAt；lastOpenedAt 从新版本的实际观察开始，旧记录未知，不反推“最后读过时间”。UI 使用“最近打开”，不声称保存了每一次访问。
- [ ] 观察记录不增加 annotation revision、不改变 updatedAt 或笔记排序；写入仅在状态改变或稳定页面再次打开时合并提交，不按指针/滚动写库。不同标签检查各自带 observedAt，只接收时间较新的持久观察。

## 4. 任务 C：同地址恢复与跨地址人工重新绑定

**接口：** 新增内部 `annotations.rebind.commit`，输入 `id/expectedRevision/token/target`；URL、标题及 document identity 来自后台核验的实际标签，不能完全相信传入字符串。

- [ ] 资料库提供“打开原始来源”“打开当前来源”“在当前网页重新定位”；修复目前资料库 rebind 无实际操作的问题。
- [ ] 用户在扩展 UI 选择原记录后，再确认使用哪个当前网页。后台签发五分钟一次性 token，绑定 annotation ID、expectedRevision、tab/document/规范化 URL；允许跨原 URL，但只针对用户所选目标页。
- [ ] 内容脚本进入现有文字/图片重绑模式；用户选中并确认，提交前同时显示“历史摘录”和“新选择”。原摘录不同明确提示“原记录仍保留，将记录新的位置与引用”。
- [ ] 后台事务：验证 token、来源身份、revision、tombstone→追加 from/to 事件→更新当前 pageUrl/pageTitle/target→revision+1→更新页索引/统计。token 在成功后消费；失败不得有半条历史。
- [ ] 普通编辑接口只允许改 note/tags/color，以及图片记录原本就允许编辑的当前 shape；对已有记录的 origin、target、pageUrl、history 修改拒绝。新建与删除撤销通过专门内部路径写完整记录，不能因保护规则破坏现有撤销。图片重绑保存旧/新 target 与各自 shape 快照。
- [ ] 页面导航、过期 token、错误标签或旧 revision 均取消，保留原记录；无匹配、多个候选时保持未定位。模糊匹配只能作为建议，不保存、不画高亮。
- [ ] 同地址文字前面新增段落，但原摘录和语境唯一匹配时用现有严格锚点恢复，无须产生历史事件。附近语境变化、容器丢失或相同句重复出现时不给自动绑定。
- [ ] 单条恢复只改变该条记录，不把整个旧网址的其他标注迁移到新网址。是否同一文章由用户对每条目标确认，不用标题/canonical 自动合并全库。
- [ ] 历史不自动截断；资料库可分页查看，日常卡片只显示最近一次与总数。导出过大时报告容量，不静默删除早期证据。

## 5. 任务 D：显示、导出与只读 AI 回顾

- [ ] 默认卡片仍突出摘录和笔记；未定位显示“摘录已保留，当前页面未能定位”，不要空卡或隐藏旧记录。状态指示用简洁徽标，完整证据展开后看，不给每条卡片堆三排工程状态。
- [ ] 详情显示“首次标注”“最近修改”“此来源最近打开”“最后检查时间”、原始链接、当前链接，以及原始/当前引用不同的对照。UTC ISO 存储，UI 按用户时区显示并保留可查看时区。
- [ ] 来源明确 404/410 显示“此地址在上次检查时未找到（时间）”；登录/网络失败分开。始终可查看保存摘录、复制、导出和人工重绑。
- [ ] 来源迁移按原始 URL 维持资料库分组追溯，同时列当前链接；新页面侧栏按当前 pageUrl 查询已确认绑定。相关联的旧来源可从详情进入，不自动把所有旧记录画在新页。
- [ ] Markdown 加首次标注时间、原地址、当前地址、上下文、笔记与必要历史；JSON v3 完整 round-trip。新增“导出阅读资料”允许全库/当前文档/当前筛选，实际说明条目数，不导出其他未选文档。
- [ ] 更新计划一 skill 支持 schema v3：按 origin.capturedAt 查询“当时标了什么”，按 pages.reading.lastOpenedAt 查询“最近打开哪些已标注资料”；搜索 origin/current 两份引用，但回答明确区分。
- [ ] skill 的每条引用附 ID、原始地址和首次标注时间；有人工恢复则补当前地址/绑定时间。状态报告附 lastCheckedAt，不在离线文件上断言来源现在仍有效。
- [ ] 缺少全文、图像 OCR、旧版历史或原文件 native annotations 时显示覆盖限制。计划二原生 PDF 笔记资料单独作为只读输入，不冒充 Web Ink 本地记录；不新增自动联网验证。

## 6. 验证与升级交付

**审查重点：** 旧数据被误称原始证据；重绑覆盖历史；网络失败被称删除；观察写入引发编辑冲突；跨站错绑定。各任务测试覆盖这些条件。

- [ ] 迁移：v1/v2 数据和备份→v3，ID、正文、笔记、标签、颜色、PDF hash、revision、开关、tombstone 全保留；重复导入、失败中断、错误 v3 输入和回滚；20 MiB/50,000 上限仍有效。
- [ ] 锚点：前置段落增删、语境改写、原容器丢失、同句重复、图片替换/缩放、SPA路由、中文长选区；严格匹配恢复，不确定不高亮，旧引用不丢。
- [ ] 重绑：同地址和跨地址、连续两次、修改后的新引用、跨 tab、过期 token、导航、revision 冲突、存储失败、删除撤销；origin 字节级不变，事务和 history 完整。
- [ ] 状态：404/410、401/403、200登录页、网络断开、超时、无法取得 redirect 目标、scope unavailable、当前摘录仍匹配但其他内容改动；三维状态互不混淆。
- [ ] 时间：首次标注与改笔记不同、重开与重复注入不同、旧版未知日期、多时区显示、观察不改变 revision/updatedAt；skill 引用不用修改时间替代首次时间。
- [ ] UI：320px 侧栏、深浅色、键盘焦点、长 URL、原始/当前引用对照、没有来源但有摘录；没有新增第二个侧栏，状态详情按需展开。
- [ ] E2E 用可控站点执行标注→保存→原文改写/404/迁移→回顾摘录→人工恢复→备份/导入→skill 检索。真实原窗口另测一个普通网页和一个动态网页，不用个人笔记作仓库 fixture。
- [ ] 完整类型/单元/大数据/发布工具/构建/E2E/ZIP；保留 Chrome 120 网页和 Chrome 125 PDF；原版本资料升级完整性独立验收。
- [ ] PR 精确 CI、审查、merge main、最终 main CI、干净构建、原目录同步、原 Chrome Reload；原始备份和恢复备份保留。不能回退到卸载重装或清空存储。

**完成门槛：** 原文不存在时仍可独立回顾摘录；来源/内容/定位状态有时间与证据；跨地址恢复不抹掉原始资料；skill 能回答“何时标注、原文哪里、现在绑定哪里、哪些尚未确认”。未满足这些条件，不宣称解决文章变化问题。
