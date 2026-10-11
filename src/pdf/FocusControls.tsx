import type { Language } from "../core/model";
import { Icon } from "../ui/management/helpers";

export function FocusControls({
  language,
  pageNumber,
  totalPages,
  blocked,
  onJump,
  onNotes,
  onExit,
  sidebarHint = false,
}: {
  language: Language;
  pageNumber: number;
  totalPages: number;
  blocked: boolean;
  onJump: (pageNumber: number) => void;
  onNotes: () => void;
  onExit: () => void;
  sidebarHint?: boolean;
}) {
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => zh ? cn : en;
  const previousDisabled = blocked || pageNumber <= 1;
  const nextDisabled = blocked || pageNumber >= totalPages;

  return <>
    <nav className="pdf-focus-controls" aria-label={t("专注阅读控件", "Focus reading controls")}>
      <button type="button" className="quiet icon-button pdf-focus-previous"
        aria-label={t("上一页", "Previous page")} title={t("上一页", "Previous page")}
        disabled={previousDisabled} onClick={() => onJump(pageNumber - 1)}>
        <Icon name="chevron" />
      </button>
      <span className="pdf-focus-page" aria-label={t(`第 ${pageNumber} / ${totalPages} 页`, `Page ${pageNumber} of ${totalPages}`)}>
        {pageNumber} / {totalPages}
      </span>
      <button type="button" className="quiet icon-button pdf-focus-next"
        aria-label={t("下一页", "Next page")} title={t("下一页", "Next page")}
        disabled={nextDisabled} onClick={() => onJump(pageNumber + 1)}>
        <Icon name="chevron" />
      </button>
      <button type="button" className="quiet pdf-focus-notes"
        aria-label={t("查看标注", "View annotations")} title={t("查看标注", "View annotations")}
        disabled={blocked} onClick={onNotes}>
        <Icon name="note" /><span>{t("标注", "Annotations")}</span>
      </button>
      <button type="button" className="quiet pdf-focus-exit"
        aria-label={t("退出专注阅读", "Exit focus reading")} title={t("退出专注阅读", "Exit focus reading")}
        onClick={onExit}>
        <Icon name="focus" /><span>{t("退出专注", "Exit focus")}</span>
      </button>
    </nav>
    {sidebarHint && <p className="pdf-focus-hint" role="status">
      {t("请手动关闭 Chrome 标注侧栏。", "Close Chrome's annotations sidebar manually.")}
    </p>}
  </>;
}
