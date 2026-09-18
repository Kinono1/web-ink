# Web Ink

一个默认安静、数据保存在本机的 Chrome 网页标注扩展。需要阅读时，点击右下角调色盘，标记文字或圈画图片；重开网页后恢复。

[English](README.en.md) · [下载 v0.1.3](https://github.com/Kinono1/web-ink/releases/tag/v0.1.3) · [CI](https://github.com/Kinono1/web-ink/actions/workflows/ci.yml) · [隐私说明](PRIVACY.md)

**v0.1.3 是预发布版本。支持普通网页；暂不支持 PDF、跨设备同步或所有动态网站。**

![调色盘开启及文字高亮；图中内容为人工测试数据](docs/images/palette-on.png)

## 安装：无需编译

1. 打开 [Release 页面](https://github.com/Kinono1/web-ink/releases/tag/v0.1.3)，下载 Assets 中的 **`web-ink-0.1.3-chrome.zip`**。
2. 解压到固定文件夹，例如 `Web-Ink-Chrome`。文件夹内应直接能看到 `manifest.json`。
3. Chrome 地址栏打开 `chrome://extensions`，启用“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择刚才的文件夹。
5. 将 Web Ink 固定到工具栏。打开普通网页，点击扩展图标，在侧栏选择“启用网页访问”，确认 Chrome 的权限提示。
6. 刷新网页，点击右下角灰色调色盘。变为彩色后，即可选中文字进行标注。

这是通过 GitHub 分发的手动加载版，尚未上架 Chrome Web Store。需要桌面 Chrome 120 或以上。

## 怎么用

| 操作 | 方法 |
| --- | --- |
| 开启/关闭当前页 | 点击右下角调色盘；灰色为关闭，彩色为开启 |
| 文字高亮 | 选中文字，再选颜色；成功保存后出现短暂提示 |
| 图片圈画 | 在侧栏点击“绘制”，选图片，再使用矩形、椭圆、箭头或画笔；“完成”或 Esc 退出 |
| 笔记、标签、改色 | 在侧栏或资料库打开该条标注的“笔记” |
| 查看全部记录 | 侧栏“打开资料库”，按关键词、类型、颜色或标签筛选 |
| 暂停整个网站 | 侧栏“暂停此网站”；恢复后再使用本页开关 |
| 查看占用 | “本地存储”面板；记录大小与浏览器占用分别标为估算 |
| 备份 | “备份与导入” → “下载 JSON”；导入时先预览，再决定是否覆盖冲突记录 |

开关按网页地址独立记忆。关闭只隐藏工具和标记，不会删除数据。新页默认关闭；已有标注但没有开关偏好的页面，首次需点一下圆钮。

![图片圈画示例，全部为人工测试内容](docs/images/image-tools.png)

## 保存、升级与恢复

标注保存在扩展自己的 IndexedDB，设置保存在 `chrome.storage.local`。没有账号、云同步、遥测或上传标注的服务。

- 升级前下载 JSON 备份。
- 把新版 ZIP 解压内容放到原来的固定安装文件夹，再在 `chrome://extensions` 点击“重新加载”，刷新已打开的网页。
- 卸载扩展会删除其本地存储；更新请使用“重新加载”。
- 导入按 ID 合并，相同记录跳过，冲突默认保留本地。勾选覆盖后才替换；本地设置和网页开关不被备份覆盖。
- 单份备份上限为 **20 MiB / 50,000 条**。接近上限会提醒，目前尚无分卷导出。
- Markdown 是阅读索引，不包含可还原的圈画图片；完整恢复请使用 JSON。

普通网络图片不另外下载原图，只记录来源与圈画位置。内嵌图片地址可能自身包含少量图像数据，详见 [PRIVACY.md](PRIVACY.md)。

## 已知限制

- **PDF 尚未实现**，包括 Chrome 内置 PDF 阅读器。Canvas、跨域 iframe 和网页自身的 Shadow DOM 内容也不在当前支持范围。
- 原文、附近上下文、页面结构或网址改变时，标注可能无法自动定位。记录仍保留，可在同一网页内手动重新定位；暂不支持跨网址迁移。
- 图片用地址、结构等线索识别，没有内容指纹校验。同一地址被替换成相同比例的新图片时，可能无法识别这个变化。
- 图片或祖先元素使用旋转、缩放等 CSS 变换时，当前会拒绝绘图，避免错误坐标。
- 大资料库目前全量读取和显示；分页、分卷备份和 PDF 阅读器属于后续工作。

## 开发与验证

开发环境推荐 **Node.js 24.15.0**（`.node-version`）；Node.js 26 系列也用于本地验证。安装依赖使用提交的 `package-lock.json`。

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run zip
node scripts/checksum.mjs
```

本地构建输出为 `.output/chrome-mv3`；发布 ZIP 在 `.output/`。在 ZIP 所在目录验证校验文件：

```sh
cd .output
shasum -a 256 -c web-ink-0.1.3-chrome.zip.sha256
```

已完成的本地验证包括 **53 项单元测试、11 项浏览器测试**。自动化测试使用隔离 Chromium 配置；功能测试副本预授予网站权限，**不等于 Chrome 原生授权弹窗已经通过自动验收**。公开网页样本也不代表所有网站都兼容。[完整验证记录](docs/VALIDATION.md)

可选的 `node scripts/real-site-smoke.mjs` 检查公开 Wikipedia、MDN、GitHub 页面，不进入 CI。

## 发布边界与贡献

源码仓库包含代码、测试、锁文件、文档、许可证及人工演示素材。安装 ZIP 和 SHA-256 文件放在 Release；依赖目录、构建目录、本机安装目录、浏览器配置、测试轨迹和个人标注备份不进入源码仓库。

[发布流程与文件边界](docs/RELEASING.md) · [贡献说明](CONTRIBUTING.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

本项目使用 [MIT License](LICENSE)。
