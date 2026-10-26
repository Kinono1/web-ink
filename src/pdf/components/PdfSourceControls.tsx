import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = {
  state: Pick<ReaderSnapshot,
    "busy" | "localFileEntry" | "locked" | "setSource" | "source"
  >;
  actions: Pick<ReaderActions,
    "requestLeave"
  >;
};

export function PdfSourceControls({ state, actions }: Props) {
  const { busy, localFileEntry, locked, setSource, source } = state;
  const { requestLeave } = actions;
  const opened = usePdfDocument();
  const { t } = usePdfUI();
  return (<section className="pdf-open" aria-label={t("打开 PDF", "Open PDF")}>
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
  </section>);
}
