import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";

/** Welcome header, welcome screen and the source picker share one module. */
export function PdfWelcomeHeader({
  state,
  actions,
}: {
  state: ReaderSnapshot;
  actions: ReaderActions;
}) {
  const { backAction, backLabel, handoffReady, handoffToken, leaving } = state;
  const { t } = usePdfUI();
  const { requestLeave } = actions;
  return (
    <header className="pdf-header">
      <div className="pdf-brand"><Icon name="pdf" /><strong>Web Ink <span>PDF</span></strong></div>
      {handoffToken && <button className="quiet" disabled={!handoffReady || leaving} onClick={() => requestLeave(backAction)}>{backLabel}</button>}
      <button className="quiet icon-button" aria-label={t("资料库", "Library")} title={t("资料库", "Library")}
        onClick={() => requestLeave({ kind: "library" })}><Icon name="library" /></button>
    </header>
  );
}

function PdfSourceControls({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
  const { busy, localFileEntry, locked, setSource, source } = state;
  const { requestLeave } = actions;
  const opened = usePdfDocument();
  const { t } = usePdfUI();
  return (
    <section className="pdf-open" aria-label={t("打开 PDF", "Open PDF")}>
      <label className="pdf-file-button" title={t("选择本地 PDF", "Choose local PDF")}>
        <Icon name="pdf" />{t("选择本地 PDF", "Choose local PDF")}
        <input aria-label={t("选择本地 PDF", "Choose local PDF")} type="file" accept="application/pdf,.pdf" disabled={locked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) requestLeave({ kind: "open", file, source });
            event.target.value = "";
          }} />
      </label>
      {(!localFileEntry || opened) && <form onSubmit={(event) => { event.preventDefault(); requestLeave({ kind: "open", source }); }}>
        <input aria-label={t("公开 PDF 网址", "Public PDF URL")} type="url" value={source} disabled={locked}
          placeholder="https://…/paper.pdf" onChange={(event) => setSource(event.target.value)} required />
        <button disabled={locked}>{busy ? t("正在读取…", "Loading…") : t("打开网址", "Open URL")}</button>
      </form>}
    </section>
  );
}

export function PdfWelcomeScreen({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
  const { busy, currentParams, localFileEntry, publicUrl } = state;
  const { t } = usePdfUI();
  return (
    <section className="pdf-welcome" aria-busy={busy}>
      <span className="pdf-welcome-icon" aria-hidden="true"><Icon name="pdf" /></span>
      <h1>{busy ? t("正在打开 PDF…", "Opening PDF…") : localFileEntry
        ? t("选择电脑上的 PDF", "Choose a PDF from your computer") : t("选择 PDF", "Choose a PDF")}</h1>
      <p>{localFileEntry
        ? t("选择已下载的 PDF 文件。标注保存在本机，原文件不会存入资料库。", "Choose a downloaded PDF file. Annotations stay on this device; the PDF is not stored in your library.")
        : t("选择本地文件，或打开公开 PDF 网址。标注保存在本机，原文件不会存入资料库。", "Choose a local file or public PDF URL. Annotations stay on this device; the PDF is not stored in your library.")}</p>
      <PdfSourceControls state={state} actions={actions} />
      <p className="pdf-muted">{t("单份文件最多 50 MiB。IEEE 登录论文请从原页面选择「使用 IEEE 登录状态打开」；其他受保护来源请下载后选择文件。扫描件可做区域标注。", "Up to 50 MiB. Open IEEE papers from the original page with Open using IEEE sign-in; download other protected sources first. Scans support area annotations.")}</p>
      {currentParams.has("document") && !publicUrl && <p role="status">{t("重新选择原来的 PDF，即可恢复标注与阅读位置。", "Choose the original PDF again to restore annotations and reading position.")}</p>}
    </section>
  );
}

export function PdfSourceDialog({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
  const { setSourceOpen } = state;
  const { dialogKeys } = actions;
  const { t } = usePdfUI();
  return (
    <div className="pdf-dialog-backdrop">
      <section className="pdf-dialog" role="dialog" aria-modal="true"
        aria-label={t("打开其他 PDF", "Open another PDF")} onKeyDown={dialogKeys}>
        <h2>{t("打开其他 PDF", "Open another PDF")}</h2><p>{t("标注保留在本机；原文件不会存入资料库。", "Annotations stay on this device; PDF files are not stored in your library.")}</p>
        <PdfSourceControls state={state} actions={actions} /><button autoFocus onClick={() => setSourceOpen(false)}>{t("继续阅读", "Keep reading")}</button>
      </section>
    </div>
  );
}
