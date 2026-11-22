# 计划二：Preview 原生标注读取与带标注 PDF 导出

> 给实施 agent：按任务执行，先用 fixture 契约验证 writer，再集成 UI；使用 superpowers:executing-plans 或由主 agent 分派独立任务。原生阅读器互通必须实际验收，不以下载成功替代。

**目标：** Preview 保存的 PDF 在 Web Ink 显示原有标记与笔记，用户新增标注后导出单个新 PDF，普通收件人无需安装 Web Ink 即可查看。

**架构：** PDF.js 读取和渲染原文件；原生批注只读；Web Ink 本地记录继续可编辑。按需加载固定版本 `pdf-lib`，使用其解析/对象/保存能力，把新增记录写为标准 PDF annotations。

**技术：** 现有 PDF.js、React、规范化 PDF 坐标；新增 `pdf-lib@1.17.1` 一个按需写入依赖，不引入商业 SDK、字体包或自己维护 PDF parser/xref。

**规格：** 本文包含设计和执行规格。接续计划一验收提交，目标版本 `0.3.5`。实施前核对实际 HEAD，不依赖历史候选通过结论。

## 1. 用户选择、范围与存储

- Preview 原有标注第一版只读显示并保留，不修改/删除，不自动复制为 Web Ink 数据库记录。
- 支持新增文字高亮、区域矩形及其笔记。原有标准高亮、下划线、删除线、矩形、便签、Popup/回复和 Ink 的文字元数据可读取；其他类型展示类型与“不支持完整交互”，不假称全部兼容。
- 所有标注仍在同一个 Chrome Web Ink 侧栏；用“全部／Web Ink／原文件”筛选和“原文件·只读”标签，不能新增阅读器内的第二个面板。
- 默认导出可编辑标注版 `<原名>-annotated.pdf`。第一版不做固定显示/flatten 选项，不用截图拼 PDF，不新增 sidecar 作为普通收件人的必需文件。
- 不静默覆盖原文件、不长期保存 PDF bytes；读取期间原文件在内存，输出为浏览器下载。JSON 仍是 Web Ink 数据恢复备份，PDF 导出不是数据库备份。
- 第一版禁止导出加密、存在数字签名、禁止注释权限、XFA、破损或超过 50 MiB 的输入；继续保留本地标注与可读范围。不给“绕过密码/权限”的选项，也不把输入 silently rasterize 为成功输出。

## 2. 任务 A：开源 writer 契约与硬门槛

**模块责任：** 一个导出 adapter 封装全部 pdf-lib 低层调用；UI 不直接操作 PDF 字典。PDF.js 的 saveDocument() 不会自动包含现有 SVG/IndexedDB 标注，不能作为快捷实现。

```ts
type PdfExportResult = { bytes: Uint8Array; fileName: string; count: number };
exportAnnotatedPdf(
  sourceBytes: Uint8Array,
  sourceHash: string,
  records: readonly PdfAnnotation[],
  signal: AbortSignal,
): Promise<PdfExportResult>;
```

- [ ] 固定 tag `v1.17.1` 审查 PDFDocument.load/save、PDFContext.obj/register/formXObject、PDFPageLeaf.addAnnot、PDFHexString.fromText，记录采用的短逻辑、输入输出和许可证；不复制 parser 或 serialization 实现。
- [ ] 在隔离的临时探针目录安装固定版本，先写合成 PDF fixture：已有 Highlight/Square/Text、Popup/回复、自定义 appearance，再写多行高亮、区域框及中文笔记。以独立 PDF.js getAnnotations() 读回验证，不以 writer 自读自证。
- [ ] 原注释验证语义指纹：页码、类型、rect/quad、颜色、contents、flags、关联关系、数量；允许对象号、xref、保存日期改变。不承诺字节级保留或任意复杂 PDF 无损重写。
- [ ] 新 `pdf-text` 一条记录写一个 `/Highlight`，多行用同一注释的 QuadPoints；`pdf-area` 写一个 `/Square`。归一化坐标映射至未旋转 page.view/CropBox，不能写 CSS 屏幕坐标。
- [ ] 高亮颜色保持现有 Apple 五色原值；生成 `/AP /N`，使用 Multiply、透明度 0.42。框为无填充、2 PDF point 边框、不透明。各阅读器外观须实际核对，不宣称像素完全一致。
- [ ] 笔记写所属 Highlight/Square 的 `/Contents`，用 PDFHexString.fromText 编码；支持中文、emoji、换行，不需要额外贴文字字体。带 `/NM` 名称 `web-ink:<id>`、`/Subj Web Ink` 与实际创建/修改时间，不能把内容当 PDF 操作符拼接。
- [ ] pdf-lib load 使用 updateMetadata:false；save 禁止自动更新既有表单外观。只追加注释，不主动重写原 annotations、表单值、链接和页面内容。输入能力检测先于保存。
- [ ] 证明非零 CropBox、0/90/180/270 度旋转、混合页尺寸、中文笔记和原生标注保留均通过后才集成依赖。失败即修复 adapter；不得自动换商业 SDK 或以 flatten 交付。

## 3. 任务 B：原生标注展示与只读侧栏

**接口增量：**

```ts
type NativePdfAnnotation = {
  key: string; documentHash: string; pageNumber: number;
  subtype: string; contents: string; author?: string;
  createdAt?: string; updatedAt?: string;
  // 位置、颜色及 Popup/回复关系从 PDF.js 的解析结果取得。
};
// 当前 PDF sidebar state 增加 nativeRecords / nativeLoading / nativeError。
```

- [ ] PDF.js canvas 继续默认原生 appearance 渲染，接入官方 AnnotationLayer 处理便签/Popup/交互定位；不再手绘一份原生高亮覆盖 canvas。仅本地 Web Ink 标注继续 SVG 展示。
- [ ] 按虚拟分页加载可见页原生 annotations；打开“原文件”筛选时以每批 8 页懒读剩余页面，允许取消，缓存仅在当前文档会话。不得为取笔记渲染所有 canvas。
- [ ] 去掉 Popup 独立重复卡，按 parent 关联到主注释；只有笔记、没有可提取引用的记录明确显示“原文件笔记”，不编造高亮摘录。
- [ ] 原生记录 key 使用当前 hash、页码和 PDF.js annotation ID；只在同一次文档会话内使用，不作为跨文件全局 ID。无效日期标记未知，不把打开时间当原标注时间。
- [ ] 单击侧栏原生记录跳到页和位置；笔记正文可阅读复制，编辑/删除禁用并说明“原文件标注只读”。本地记录的保存、删除撤销、冲突保护不变。
- [ ] 禁止执行 PDF 内 JavaScript、自动网络动作、Launch/嵌入文件等。外部链接只在用户点击且通过现有安全 URL 检查后打开。
- [ ] 原生笔记不自动写进整库备份。当前文档“导出给 AI”输出 `format: web-ink-pdf-notes`、schemaVersion:1、exportedAt、document `{documentHash,fileName,sourceUrl?}`、annotations（当前文件已保存的 Web Ink 记录）与 nativeAnnotations（只读原文件记录）。使用计划一 skill 的独立 adapter，不误装成可导入的 Web Ink backup；同文件每次导出完整重新生成，不累计追加。

## 4. 任务 C：导出 UI、快照和再次打开

- [ ] 阅读器“更多”增加“导出带标注的 PDF…”。有未保存笔记或失败待重试项时沿用“保存／放弃／继续编辑”；保存失败不得导出半成品。
- [ ] 点击时冻结已保存记录 `(id, revision)` 与原字节 H0，仅包含 target.documentHash 等于 H0 的当前完整记录。不根据 URL 或相似文字混入其他版本。
- [ ] 首次点击才加载 writer，在独立 worker 中运行；UI 显示准备／写入／已生成，禁用重复点击。取消或离开终止自有 worker、释放 buffer；不终止浏览器进程。
- [ ] 产物内存上限：输入与输出各 50 MiB，写入 worker 有 60 秒超时；超限/超时明确失败，本地记录仍在。仅传递必要 buffers，避免 Base64 和数组 JSON 扩大体积。
- [ ] 输出完成后独立校验 PDF 结构、预期原注释语义、新增数量及 contents，然后触发下载。“已生成并开始下载”不夸大为已经写入用户磁盘。
- [ ] 同一会话重复导出总是从同一 H0 和最新完整快照生成 H1，不累计追加到上一次输出；删除或编辑本地标注后重新导出应反映最新快照。
- [ ] 新文件 H1 与 H0 hash 不同。再次打开 H1，将其内嵌标注当原文件只读记录，不能自动套用 H0 本地标注，否则会重复高亮。用户在 H1 新增的标注归 H1，之后导出保留 H1 原有批注。
- [ ] 不根据 `/NM`、相近颜色、几何或文字自动去重第三方批注；名称只用于来源说明，不能从 PDF 向数据库自动写入记录。原文件 H0、JSON 记录与 ID/revision 全部保持原样。

## 5. 验证与交付

**审查重点：** 原生高亮绘制两次；Popup 重复计数；旋转/CropBox 坐标；中文 Contents 编码；签名/权限输入静默损坏。均有对应 fixture 或拒绝测试。

- [ ] 单测/契约：native 元数据归一化、Popup 聚合、日期未知；Highlight/Square 的语义、AP、QuadPoints、颜色、Contents、原注释保留；错误类型和取消；导出快照与 revision 不变。
- [ ] E2E：打开带原生注释的 PDF→侧栏读笔记→新增高亮/笔记/框→导出→再打开，无重复标注；加载原生笔记不突破虚拟 canvas 数量。
- [ ] 真实互通：用专门合成的非个人 PDF 在 Preview 标黄/绿、下划线、便签和矩形并保存；Web Ink 查看；新增中文笔记和跨行高亮；导出后分别在 Preview、Chrome、Acrobat Reader 查看页码、位置、颜色与正文。Acrobat 未安装或无法测不得算通过，也不得自动安装。
- [ ] 原有批注第一次和输出后的语义数量一致，新 Web Ink 记录各出现一次；原文件前后 SHA-256 完全相同，输出是独立文件。
- [ ] 完整 check/test/bulk/release/build/E2E/ZIP、独立代码审查、PR 精确 CI、merge main、最终 main CI/构建、固定安装目录同步、原 Chrome Reload。许可证随构建分发。
- [ ] PDF 导出性能基线使用 10 页和 100 页合成文件各 5 次，记录输入大小、导出耗时/输出大小；不把包体大小当内存或速度。writer 不能增加 PDF 打开首屏的请求或解析工作。

**完成门槛：** 收件人只拿一个 PDF 就能在测试阅读器看到新增标注及笔记；Preview 原有标注保留；源文件不变。任何核心互通失败返回 writer/display 任务，不以 JSON sidecar 或截图替代。

**来源：** [PDF.js annotation/render API](https://mozilla.github.io/pdf.js/api/draft/api.js.html)、[Apple Preview 保存与固定标注](https://support.apple.com/guide/preview/annotate-a-pdf-prvw11580/mac)、[pdf-lib 固定版本 PDFContext](https://github.com/Hopding/pdf-lib/blob/v1.17.1/src/core/PDFContext.ts)、[PDFHexString](https://github.com/Hopding/pdf-lib/blob/v1.17.1/src/core/objects/PDFHexString.ts)。采用低层 API 必须固定版本并通过上述契约，不宣称 pdf-lib 已有高层 annotations API。
