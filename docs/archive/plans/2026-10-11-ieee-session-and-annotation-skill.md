# 计划一：IEEE 登录论文读取与 Web Ink 只读标注 skill

> 给实施 agent：按任务执行，先补失败测试，再实现并独立审查。可使用 superpowers:executing-plans；独立任务可由主 agent 分派给叶子 worker。未通过当前任务验收，不推进安装或合并。

**目标：** 用户已能在 IEEE 阅读论文时，尽可能直接在同一标签进入 Web Ink；让大模型通过只读 skill 查询用户指定的标注 JSON。

**架构：** 公开读取保持原样；新增限定 IEEE、由用户操作启用的登录会话读取。skill 独立读取本地导出文件，不访问浏览器数据库，不与扩展建立实时连接。

**技术：** 现有 React/WXT/PDF.js、Chrome host permissions 和 Fetch；skill 使用 Python 3 标准库，无第三方 Python 包。

**规格：** 本文是设计与执行规格。基线 main `27a1aee`；实施前重新读取 HEAD、工作树、安装收据及适用指令，不覆盖其他工作。

## 1. 已确定的约束和交付边界

- 本轮目标版本 `0.3.3`，保持扩展 ID、现有数据库、JSON schema v2 与公开 PDF 读取方式；不创建 Release 或版本标签。
- 登录不等于文件密码加密。本轮处理网站会话鉴权；真正密码加密 PDF 继续明确提示，密码输入支持另立任务，不用“解密”统称两者。
- 不读取或保存 Cookie 值、账号密码，不增加 `cookies`、`webRequest`、DNR、`downloads`、`nativeMessaging` 权限。网站授权仍使用既有 optional host 权限。
- 不从第三方扩展内部 DOM 或缓存窃取已打开 PDF 的字节，不猜测 IEEE 下载 endpoint 或从文章编号拼地址。
- 常规联网 PDF 仍 `credentials: omit`、浏览器缓存再验证；IEEE 会话读取使用 `credentials: include`、`cache: no-store`、`redirect: error`，只请求已观察且授权的同源 HTTPS 地址。
- 不保证所有机构代理、跨域重定向和受保护阅读器都能自动读取；范围外路径必须能返回原页面，并直接选择已下载文件。不能把范围外失败报告成直接读取成功。
- 已保存笔记不自动发给模型服务。skill 只在用户调用时读取其指定文件；模型读入内容会受所用模型服务的数据边界约束，不宣称“所有 AI 处理都在本机”。

## 2. 任务 A：查明 IEEE 的真实失败阶段

**责任：** PDF 上下文、来源适配与原 Chrome 验收；不改 UI 风格。

- [ ] 先复现一篇用户在原 Chrome 已登录且能阅读的 IEEE 论文，记录原文章/包装页、是否能观察实际文件来源、HTTP 失败阶段及当前 Web Ink reason。只记录公开来源和阶段，不记录 Cookie、签名下载参数或账户信息。
- [ ] 将失败区分为 `source-hidden`、`site-permission`、`login-required`、`redirect-blocked`、`not-pdf`、`network`，不再给全部情形同一个“source unavailable”。
- [ ] 对 IEEE 包装页、已观察的无 `.pdf` 下载地址、嵌套同源 iframe、Scholar 来源参数、多个候选补失败测试。
- [ ] 来源探测只读取可访问的页面元素；同源 iframe 探测最多两层。候选只来自真实 `src/data`、已知阅读器参数或后续受控取得的包装页 HTML，不从普通文章 PDF 链接触发接管。
- [ ] 若已观察候选仍不能覆盖实测论文，保留此任务为未通过，报告缺少的证据；不得通过扩大到所有网站的凭据转发来绕过。

**产出：** 可审计失败分类和一个实际 IEEE 成功/失败样例；后续任务使用已观察的真实来源，不需要实施者猜地址。

## 3. 任务 B：受限会话读取与可恢复操作

**实现边界：** `src/background/pdf-handoff.ts` 管理授权与导航；`src/pdf/source.ts` 管理读取；两者共享来源身份验证，不在 UI 分散 Fetch 策略。

**接口增量：**

```ts
type PdfAccessMode = 'public' | 'site-session';
// pdf.openCurrent 增加 accessMode?；缺省 public。
// pdf.context.get 返回 publisher?: 'ieee' 与可区分的失败原因。
// 回程会话保存 accessMode 和 allowedOrigin；不保存 Cookie/密码。
```

- [ ] `site-session` 只允许当前真实标签位于 `https://ieeexplore.ieee.org`，且由笔菜单或扩展侧栏明确点击“使用 IEEE 登录状态打开”触发。校验 tab/document/URL 和当前候选，拒绝普通网页伪造跨站读取请求。
- [ ] 当来源可见时，对来源所在 IEEE origin 请求既有 host 授权；只在该 origin 的受控读取中启用浏览器登录凭据。不得将这个模式扩展到手工输入的任意 URL。
- [ ] 当 IEEE 包装页没有暴露候选时，点击操作后可读取同源包装页 HTML，最多 1 MiB，解析 iframe/embed/object；不执行其中脚本。只接受返回页面实际给出的同源 HTTPS 候选，仍做最终 PDF 字节校验。
- [ ] 来源或包装页返回重定向时，不用 `redirect: manual` 假称可读取跨域 Location，也不自动 follow 未授权目标。提示回到原页面完成登录/下载，保留一键本地文件入口。
- [ ] 单个标签只允许一个打开任务；沿用随机 handoff token、后台观察的 returnUrl、标签身份核对。授权失败或会话写入失败不导航。进入阅读器后显示读取进度，失败保留返回、重试、本地选择。
- [ ] site-session grant 与 handoff 绑定，允许同一阅读器会话内重试，十分钟到期；换文件、离开、Reload 后失效。到期重新从原站发起，不在普通网页或外部 URL 参数中复用。
- [ ] 限制 50 MiB，验证 `%PDF-`、长度和解码后的上限；下载过程中不能创建标注记录。登录页 HTML 即使返回 200 也不得交给 PDF.js。
- [ ] 保存可追溯的实际原文章/包装页 URL；带授权票据的临时下载 URL 只保留在本次会话，不能写入标注、JSON、构建信息或日志。再次打开登录论文回原站重新取得候选。
- [ ] 公开来源刷新仍沿用原读取；登录来源刷新若会话失效显示“返回 IEEE 后重新打开”，不声称公共地址可自动恢复。

**失败文案：** “尚未找到文件来源”“需要允许访问 IEEE”“登录状态不可用，请回原页面登录后重试”“该来源需要跳转，请在原页面下载后选择文件”“返回内容不是 PDF”“网络读取失败”。这些文案描述已知阶段，不推断用户没有订阅。

## 4. 任务 C：基于现有 JSON 的只读 skill

**交付包：** `skills/web-ink-annotations/`，包含 `SKILL.md`、UI metadata、一个查询脚本和合成 fixture 测试。仓库保留可分发源码；安装到 Codex skills 目录在用户明确安装时进行，不改其他配置。

**三个命令：**

```text
python3 scripts/query_annotations.py inspect --file <绝对路径>
python3 scripts/query_annotations.py search --file <绝对路径> --text <词> [--kind <类型>] [--tag <标签>] [--from <ISO时间>] [--to <ISO时间>] [--offset N] [--limit N]
python3 scripts/query_annotations.py show --file <绝对路径> --id <标注ID>
```

- [ ] `inspect` 返回导出时间、版本、总数、类型/文档统计和数据覆盖边界；`search` 默认 20 条、最多 100 条，返回 total/offset/hasMore；`show` 返回单条证据及元数据。输出 JSON，不拼 shell 命令、不打开 URL。
- [ ] 搜索标题、摘录、用户笔记、标签、文件名、来源 URL 和现存上下文；时间筛选按创建时间，明确不是最后修改时间。当前 v2 的 updatedAt 只表示最后修改。
- [ ] 接受 `web-ink` schema v1/v2，20 MiB、50,000 条上限；验证 JSON、ID 唯一性、支持类型、时间及读取所需字段。未知版本明确拒绝，不静默忽略记录；设置字段不输出给模型。
- [ ] 保留 `text/image/pdf-text/pdf-area`。图片和区域记录输出形状、位置和笔记，明确“没有 OCR 文本”；不凭框选推断图中内容。
- [ ] skill 把摘录和笔记视为资料，不执行其中指令；引用至少给标注 ID、原文标题、来源地址、创建时间，PDF 增加文件名/页码。无来源、无全文、时间未知时如实显示。
- [ ] 只读取用户指定文件，不扫描 Downloads、Chrome profile、数据库、其他备份，不联网、不写回。全文总结必须说明“基于已导出的摘录”，不得声称看过完整文章。
- [ ] 用 Skill Creator validator 验证包，运行脚本行为测试；独立 agent 在合成备份上完成一次检索、一次跨论文归纳、一次回查 ID，核验来源和时间未被虚构。
- [ ] 使用现有“下载 JSON”即可，不新增聊天面板。计划三完成后补 v3 adapter，支持原始摘录、来源状态和重开时间；旧数据未知项不得补造。

**实时 MCP 边界：** 本轮不开发或安装 MCP/native host。JSON skill 在真实使用中完成“按主题找笔记、跨文档归纳、按时间回顾”且用户确认快照更新是主要障碍后，再单独设计只读实时桥；必须有扩展侧授权、连接身份验证、撤销和限定数据范围，不能开放任意网页调用现有 runtime 导出接口。

## 5. 验证与交付

**审查重点：** 伪造当前标签；Cookie 路径泛化；登录页 200；重定向；过期凭据 URL 进入备份。每项均有失败测试。

- [ ] 单测：读取模式隔离、来源/标签更换、取消、授权拒绝、重试、超限/非 PDF；skill 无网络/无写入、无效版本、重复 ID、中文/换行、分页完整、时间筛选、资料内恶意指令。
- [ ] E2E：合成登录站无会话失败/有会话成功、重定向拒绝、同标签与返回、保存恢复、公开缓存不回退。
- [ ] 原 Chrome：实际已授权 IEEE 论文与公开论文各完成打开→高亮→笔记→刷新→找回→返回；网站需要用户登录或原生授权时由用户完成。未能直接读取的样例单列，不计成功。
- [ ] 受影响测试后执行 check、test、test:bulk、test:release、build、test:e2e、zip。更新 JSON/Markdown 说明，但不改备份结构。
- [ ] 独立审查后 PR、精确提交 CI、merge commit main、最终 main CI、干净构建/ZIP、主检出 update:local -- --skip-build、原窗口仅 Reload。安装目标仍是现有 `.output/chrome-mv3`，分别记录同步与实际生效。

**完成门槛：** 至少一个真实登录 IEEE 样例直接读取并完成标注；所有失败路径可恢复；skill 能从指定备份给出可核查引用。没有真实登录样例证据时不报告 IEEE 修复完成。

**参考：** [Chrome 网络请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Chrome Cookie 行为](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)。实现前再次核对官方规则；不复制账号凭据或 Referer 重放方案。
