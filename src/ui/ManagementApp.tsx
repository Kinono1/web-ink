import { memo, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { formatIeeeDiagnostic } from "../pdf/public";
import { installPageTheme } from "../core/theme";
import { useAnnotationSync } from "./hooks/useAnnotationSync";
import { useManagementSettings } from "./hooks/useManagementSettings";
import { usePdfActions, type PdfActions } from "./hooks/usePdfActions";
import { isPdfSurface, useTabObserver } from "./hooks/useTabObserver";
import { ManagementContext, LibraryContext, SettingsContext, useManagementContext } from "./contexts/ManagementContext";
import { TabContext, useTabContext } from "./contexts/TabContext";
import { LibraryScreen } from "./screens/LibraryScreen";
import { PageScreen } from "./screens/PageScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { Alert, Empty } from "./management/components";
import { Icon } from "./management/helpers";
import type { Mode, Screen } from "./management/types";
import "./management.css";
import "./sidepanel.css";

export { pdfReaderUrl } from "./management/helpers";

export function mountManagementApp(root: HTMLElement, mode: Mode): void {
  installPageTheme();
  createRoot(root).render(<ManagementApp mode={mode} />);
}

const MemoLibraryScreen = memo(LibraryScreen);
const MemoSettingsScreen = memo(SettingsScreen);
const MemoPageScreen = memo(PageScreen);

export function ManagementApp({ mode }: { mode: Mode }) {
  const [screen, setScreen] = useState<Screen>("library");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const preferences = useManagementSettings(setError);
  const { language, receiveSettings, selectionToolbarEnabled } = preferences;
  const observer = useTabObserver({ mode, selectionToolbarEnabled, receiveSettings, language, setError });
  const { tab, pdfContext, pageUrl, activeDocument, documentVersion } = observer;
  const annotations = useAnnotationSync({ mode, pageUrl, language, setError, setNotice });
  const pdf = usePdfActions({ mode, tab, pdfContext, activeDocument, documentVersion, language, setError });
  const management = useMemo(() => ({ mode, preferences, annotations, setError, setNotice }),
    [mode, preferences, annotations]);
  const library = useMemo(() => ({ language, t: preferences.t, annotations }),
    [language, preferences.t, annotations]);
  const settings = useMemo(() => ({ preferences, loadRecords: annotations.loadRecords, setError, setNotice }),
    [preferences, annotations.loadRecords]);
  return (
    <ManagementContext.Provider value={management}>
      <LibraryContext.Provider value={library}>
        <SettingsContext.Provider value={settings}>
          <TabContext.Provider value={observer}>
            <ManagementLayout screen={screen} setScreen={setScreen} error={error} notice={notice} pdf={pdf} />
          </TabContext.Provider>
        </SettingsContext.Provider>
      </LibraryContext.Provider>
    </ManagementContext.Provider>
  );
}

function ManagementLayout({ screen, setScreen, error, notice, pdf }: {
  screen: Screen;
  setScreen: Dispatch<SetStateAction<Screen>>;
  error?: string;
  notice?: string;
  pdf: PdfActions;
}) {
  const { mode, preferences, annotations, setError, setNotice } = useManagementContext();
  const { settings, language, t } = preferences;
  const { records, nextCursor, loadRecords, libraryDocument, showAllDocuments } = annotations;
  const { pdfContext, pageUrl, hasPermission, refreshContext, enablePermissions,
    contextError, setContextError } = useTabContext();
  const { pdfActionError, setPdfActionError, ieeeDiagnostic, openingPdf,
    showHeaderPdfAction, isIeeeSession, ieeeCandidates, openCurrentPdf,
    openIeeeSessionPdf, openLibrary, openPdf } = pdf;
  const origin = pageUrl ? new URL(pageUrl).origin : undefined;
  const paused = Boolean(origin && settings.disabledOrigins.includes(origin));
  const displayError = error ?? pdfActionError ?? contextError;
  const closeError = () => {
    if (error) setError(undefined);
    else if (pdfActionError) setPdfActionError(undefined);
    else setContextError(undefined);
  };
  const copyDiagnostic = () => {
    if (!ieeeDiagnostic) return;
    const text = formatIeeeDiagnostic(ieeeDiagnostic, chrome.runtime.getManifest().version);
    void navigator.clipboard.writeText(text)
      .then(() => setNotice(language === "zh-CN" ? "诊断摘要已复制" : "Diagnostic summary copied"))
      .catch(() => setNotice(language === "zh-CN" ? "请手动选择上面的摘要复制" : "Select the summary above to copy it"));
  };

  return (
    <main
      className={mode === "sidepanel" ? "ink-app sidepanel" : "ink-app"}
      data-theme={settings.theme ?? "system"}
      data-reduce-motion={settings.reduceMotion === true}
      data-reduce-transparency={settings.reduceTransparency === true}
    >
      <header className="topbar">
        <div className="app-title">
          <h1>
            {mode === "sidepanel"
              ? t.pageAnnotations
              : screen === "settings"
                ? t.settings
                : t.library}
          </h1>
          {(mode === "sidepanel" ? pageUrl && !paused : screen === "library") &&
          records.length ? (
            <span className="count">
              {records.length}
              {nextCursor ? "+" : ""}
            </span>
          ) : null}
        </div>
        <div className="header-actions">
          {mode === "sidepanel" ? (
            <>
              {showHeaderPdfAction ? (
                <button className="quiet icon-button" disabled={openingPdf}
                  onClick={() => {
                    if (isIeeeSession) void openIeeeSessionPdf(ieeeCandidates[0]?.url);
                    else openCurrentPdf(pdfContext?.candidates[0]?.url);
                  }}
                  title={isIeeeSession ? t.openIeeeSessionPdf : t.openPdf}
                  aria-label={isIeeeSession ? t.openIeeeSessionPdf : t.openPdf}>
                  <Icon name="pdf" />
                </button>
              ) : null}
              <button
                className="quiet icon-button"
                aria-label={t.openLibrary}
                title={t.openLibrary}
                onClick={openLibrary}
              >
                <Icon name="library" />
              </button>
            </>
          ) : (
            <div className="segmented-control" role="group">
              <button
                className={
                  screen === "library" ? "segmented selected" : "segmented"
                }
                aria-pressed={screen === "library"}
                onClick={() => setScreen("library")}
              >
                {t.library}
              </button>
              <button
                className={
                  screen === "settings" ? "segmented selected" : "segmented"
                }
                aria-pressed={screen === "settings"}
                onClick={() => setScreen("settings")}
              >
                {t.settings}
              </button>
            </div>
          )}
          {mode === "library" && screen === "library" ? (
            <button
              className="quiet icon-button"
              onClick={() => openPdf()}
              aria-label={t.openPdf}
              title={t.openPdf}
            >
              <Icon name="pdf" />
            </button>
          ) : null}
          <button
            className="quiet icon-button"
            onClick={() => {
              void refreshContext();
              void loadRecords();
            }}
            aria-label={t.refresh}
            title={t.refresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {mode === "library" && screen === "library" && libraryDocument && <div className="alert notice" role="status">
        <span>{language === "zh-CN" ? "之前版本的标注" : "Annotations from the previous version"}</span>
        <button className="quiet" onClick={showAllDocuments}>{language === "zh-CN" ? "查看全部" : "View all"}</button>
      </div>}
      {displayError ? (
        <Alert
          kind="error"
          text={displayError}
          close={closeError}
          closeLabel={t.close}
        />
      ) : null}
      {pdfActionError && ieeeDiagnostic && (
        <details className="ieee-diagnostic">
          <summary>{language === "zh-CN" ? "诊断详情" : "Diagnostic details"}</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>
            {formatIeeeDiagnostic(ieeeDiagnostic, chrome.runtime.getManifest().version)}
          </pre>
          <button className="quiet" onClick={copyDiagnostic}>
            {language === "zh-CN" ? "复制诊断摘要" : "Copy diagnostic summary"}
          </button>
        </details>
      )}
      {notice ? (
        <Alert
          kind="notice"
          text={notice}
          close={() => setNotice(undefined)}
          closeLabel={t.close}
        />
      ) : null}
      {!hasPermission && !(mode === "sidepanel" && isPdfSurface(pdfContext)) ? (
        <Empty
          title={t.permission}
          text={t.permissionText}
          action={
            <button
              className="primary"
              onClick={() => void enablePermissions()}
            >
              {t.permission}
            </button>
          }
        />
      ) : null}
      {mode === "sidepanel" ? (
        <MemoPageScreen visible={hasPermission || isPdfSurface(pdfContext)} pdf={pdf} />
      ) : (
        <>
          <MemoLibraryScreen visible={hasPermission && screen === "library"} openPdf={openPdf} />
          <MemoSettingsScreen visible={hasPermission && screen === "settings"} />
        </>
      )}
    </main>
  );
}
