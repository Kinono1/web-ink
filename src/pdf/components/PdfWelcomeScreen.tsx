import type { ComponentProps } from "react";
import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";
import { PdfSourceControls } from "./PdfSourceControls";
type Props = { state: Pick<ReaderSnapshot, "busy" | "currentParams" | "localFileEntry" | "publicUrl"> & ComponentProps<typeof PdfSourceControls>["state"]; actions: Pick<ReaderActions, never> & ComponentProps<typeof PdfSourceControls>["actions"] };

export function PdfWelcomeScreen({ state, actions }: Props) {
  const { busy, currentParams, localFileEntry, publicUrl } = state;
  const { t } = usePdfUI();
  return (<section className="pdf-welcome" aria-busy={busy}>
    <span className="pdf-welcome-icon" aria-hidden="true"><Icon name="pdf" /></span>
    <h1>{busy ? t("正在打开 PDF…", "Opening PDF…") : localFileEntry
      ? t("选择电脑上的 PDF", "Choose a PDF from your computer") : t("选择 PDF", "Choose a PDF")}</h1>
    <p>{localFileEntry
      ? t("选择已下载的 PDF 文件。标注保存在本机，原文件不会存入资料库。", "Choose a downloaded PDF file. Annotations stay on this device; the PDF is not stored in your library.")
      : t("选择本地文件，或打开公开 PDF 网址。标注保存在本机，原文件不会存入资料库。", "Choose a local file or public PDF URL. Annotations stay on this device; the PDF is not stored in your library.")}</p>
    <PdfSourceControls state={state} actions={actions} />
    <p className="pdf-muted">{t("单份文件最多 50 MiB。IEEE 登录论文请从原页面选择「使用 IEEE 登录状态打开」；其他受保护来源请下载后选择文件。扫描件可做区域标注。", "Up to 50 MiB. Open IEEE papers from the original page with Open using IEEE sign-in; download other protected sources first. Scans support area annotations.")}</p>
    {currentParams.has("document") && !publicUrl && <p role="status">{t("重新选择原来的 PDF，即可恢复标注与阅读位置。", "Choose the original PDF again to restore annotations and reading position.")}</p>}
  </section>);
}
