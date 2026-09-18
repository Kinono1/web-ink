import { PdfPage } from "./PdfPage";
import { PdfNote } from "./PdfNote";
import {
  errorText,
  type PdfAnnotation,
  type OpenDocument,
  type SelectionTarget,
} from "./types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import { request, RequestError } from "../core/client";
import {
  COLORS,
  DEFAULT_SETTINGS,
  type Annotation,
  type AnnotationPage,
  type PageMode,
  type PdfAreaAnnotation,
  type PdfRect,
  type PdfTarget,
  type PdfTextAnnotation,
  type Settings,
} from "../core/model";
import { THEME_TOKENS } from "../ui/theme";
import { ICON_PATHS } from "../ui/icons";
import { pdfHash, pdfSourceUrl, readLocalPdf, readRemotePdf } from "./source";
import { fromPdfRect, toPdfRect } from "./geometry";
import "pdfjs-dist/web/pdf_viewer.css";
import "../ui/management.css";
import "./pdf.css";

const isPdf = (record: Annotation): record is PdfAnnotation =>
  record.kind === "pdf-text" || record.kind === "pdf-area";
const initialParams = new URLSearchParams(location.search);

export function PdfReader() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [source, setSource] = useState(initialParams.get("source") || "");
  const [opened, setOpened] = useState<OpenDocument>();
  const [records, setRecords] = useState<PdfAnnotation[]>([]);
  const [enabled, setEnabled] = useState(false),
    [area, setArea] = useState(false);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [pageNumber, setPageNumber] = useState(1);
  const [selection, setSelection] = useState<SelectionTarget>();
  const [picked, setPicked] = useState<PdfAnnotation>();
  const [undoRecord, setUndoRecord] = useState<PdfAnnotation>();
  const [unsaved, setUnsaved] = useState<PdfAnnotation>();
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [removing, setRemoving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pageWindow, setPageWindow] = useState({ start: 0, end: 3 });
  const [dimensions, setDimensions] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const container = useRef<HTMLDivElement>(null),
    loadTask = useRef<PDFDocumentLoadingTask | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined),
    generation = useRef(0),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const zh = settings.language === "zh-CN";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const key = opened ? `urn:web-ink:pdf:${opened.hash}` : undefined;
  const tell = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 1800);
  };
  useEffect(() => {
    void request<Settings>({ type: "settings.get" }).then((next) => {
      setSettings(next);
      setColor(next.defaultColor);
    });
    const listener = (m: { type?: string }) => {
      if (m.type === "settings.changed")
        void request<Settings>({ type: "settings.get" }).then(setSettings);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme =
        settings.theme === "dark" ||
        (settings.theme !== "light" && media.matches)
          ? "dark"
          : "light";
      for (const [k, v] of Object.entries(THEME_TOKENS[theme]))
        document.documentElement.style.setProperty(k, v);
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.reduceMotion = String(
        settings.reduceMotion === true,
      );
      document.documentElement.dataset.reduceTransparency = String(
        settings.reduceTransparency === true,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings]);
  useEffect(
    () => () => {
      generation.current++;
      abort.current?.abort();
      void loadTask.current?.destroy();
      clearTimeout(noticeTimer.current);
    },
    [],
  );
  const refresh = useCallback(async () => {
    if (!key) return;
    const all = await request<Annotation[]>({
      type: "annotations.list",
      pageUrl: key,
    });
    setRecords(all.filter(isPdf));
  }, [key]);
  useEffect(() => {
    if (!key) return;
    const listener = (m: {
      type?: string;
      pageUrl?: string;
      annotation?: Annotation;
      deletedId?: string;
    }) => {
      if (
        m.type === "annotations.changed" &&
        (!m.pageUrl || m.pageUrl === key)
      ) {
        if (m.annotation && isPdf(m.annotation)) {
          const changed = m.annotation;
          setRecords((old) =>
            [...old.filter((r) => r.id !== changed.id), changed].sort(
              (a, b) => a.target.pageNumber - b.target.pageNumber,
            ),
          );
        } else if (m.deletedId)
          setRecords((old) => old.filter((r) => r.id !== m.deletedId));
        else void refresh();
      }
      if (m.type === "page.mode.changed" && m.pageUrl === key)
        void request<PageMode>({ type: "page.mode.get", pageUrl: key }).then(
          (m) => setEnabled(m.enabled),
        );
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [key, refresh]);
  const layout = useMemo(() => {
    const offsets = [0];
    const fallback = (rotation % 180 ? 612 : 792) * zoom;
    for (let n = 1; n <= (opened?.document.numPages ?? 0); n++) {
      offsets.push(offsets[n - 1]! + (dimensions[n]?.height ?? fallback) + 20);
    }
    return offsets;
  }, [opened, dimensions, zoom, rotation]);
  useEffect(() => {
    const scroller = container.current;
    if (!opened || !scroller) return;
    let frame = 0;
    const findPage = (position: number) => {
      let low = 0,
        high = opened.document.numPages - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (layout[mid]! <= position) low = mid;
        else high = mid - 1;
      }
      return low;
    };
    const update = () => {
      frame = 0;
      const first = findPage(Math.max(0, scroller.scrollTop - 24));
      const last = findPage(scroller.scrollTop + scroller.clientHeight);
      const start = Math.max(0, first - 1),
        end = Math.min(opened.document.numPages, last + 2);
      setPageWindow((old) =>
        old.start === start && old.end === end ? old : { start, end },
      );
      setPageNumber(first + 1);
    };
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(scroll);
    scroller.addEventListener("scroll", scroll, { passive: true });
    resize.observe(scroller);
    update();
    return () => {
      scroller.removeEventListener("scroll", scroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [opened, layout]);
  async function openPdf(file?: File) {
    if (unsaved || saving || removing) {
      setError(
        t(
          "请先保存或放弃未保存标注。",
          "Resolve the unsaved annotation first.",
        ),
      );
      return;
    }
    const chromeVersion = Number(
      navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || 0,
    );
    if (chromeVersion && chromeVersion < 125) {
      setError(
        t(
          "PDF 阅读需要 Chrome 125 或更高版本。",
          "PDF reading requires Chrome 125 or later.",
        ),
      );
      return;
    }
    const token = ++generation.current;
    abort.current?.abort();
    abort.current = new AbortController();
    const signal = abort.current.signal;
    setError("");
    setNotice("");
    setBusy(true);
    setOpened(undefined);
    setSelection(undefined);
    setPicked(undefined);
    setUndoRecord(undefined);
    setRecords([]);
    setDimensions({});
    setPageWindow({ start: 0, end: 3 });
    try {
      let remote: string | undefined;
      if (!file) {
        const url = pdfSourceUrl(source.trim());
        remote = url.href;
        const origins = [`${url.origin}/*`];
        if (
          !(await chrome.permissions.contains({ origins })) &&
          !(await chrome.permissions.request({ origins }))
        )
          throw Error(
            t("未授予网站访问权限。", "Site permission was not granted."),
          );
      }
      await loadTask.current?.destroy();
      loadTask.current = undefined;
      const bytes = file
        ? await readLocalPdf(file)
        : await readRemotePdf(remote!, signal);
      if (token !== generation.current) return;
      const hash = await pdfHash(bytes);
      if (token !== generation.current) return;
      const api = await import("pdfjs-dist/legacy/build/pdf.mjs");
      api.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
        "/pdfjs/pdf.worker.min.mjs",
      );
      const task = api.getDocument({
        data: bytes,
        cMapUrl: chrome.runtime.getURL("/pdfjs/cmaps/"),
        cMapPacked: true,
        standardFontDataUrl: chrome.runtime.getURL("/pdfjs/standard_fonts/"),
        wasmUrl: chrome.runtime.getURL("/pdfjs/wasm/"),
        iccUrl: chrome.runtime.getURL("/pdfjs/iccs/"),
        enableXfa: false,
        maxImageSize: 16777216,
        canvasMaxAreaInBytes: 67108864,
      });
      loadTask.current = task;
      task.onPassword = () => {
        setError(
          t(
            "加密 PDF 暂不支持，请先解锁文件。",
            "Encrypted PDFs are not supported; unlock the file first.",
          ),
        );
        void task.destroy();
      };
      const doc = await task.promise;
      if (token !== generation.current) {
        await task.destroy();
        return;
      }
      const fileName =
        file?.name ||
        decodeURIComponent(
          new URL(remote!).pathname.split("/").pop() || "Document.pdf",
        );
      const pageUrl = `urn:web-ink:pdf:${hash}`;
      const [all, mode] = await Promise.all([
        request<Annotation[]>({ type: "annotations.list", pageUrl }),
        request<PageMode>({ type: "page.mode.get", pageUrl }),
      ]);
      if (token !== generation.current) return;
      setOpened({
        document: doc,
        api,
        hash,
        fileName,
        ...(remote ? { sourceUrl: remote } : {}),
      });
      setRecords(all.filter(isPdf));
      setEnabled(mode.enabled);
      setArea(false);
      setZoom(1);
      setRotation(0);
      setPageNumber(1);
      const expected = initialParams.get("document");
      let changed = !!expected && expected !== hash;
      if (remote && !changed) {
        const earlier = await request<AnnotationPage>({
          type: "annotations.query",
          query: { text: remote, limit: 50 },
        });
        changed = earlier.items.some(
          (r) =>
            isPdf(r) &&
            r.target.sourceUrl === remote &&
            r.target.documentHash !== hash,
        );
      }
      if (token === generation.current && changed)
        setNotice(
          t(
            "文档版本已变化：旧标注已保留，没有套用到这份文件。",
            "Document changed: previous annotations are preserved and were not applied to this file.",
          ),
        );
    } catch (cause) {
      if (token === generation.current && !signal.aborted) {
        setError(errorText(cause));
        await loadTask.current?.destroy().catch(() => undefined);
        loadTask.current = undefined;
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  async function toggle() {
    if (!key || unsaved || saving || removing) return;
    try {
      const mode = await request<PageMode>({
        type: "page.mode.put",
        pageUrl: key,
        enabled: !enabled,
      });
      setEnabled(mode.enabled);
      setSelection(undefined);
      setPicked(undefined);
      setArea(false);
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  async function save(record: PdfAnnotation) {
    if (saving) return;
    setSaving(true);
    setUnsaved(record);
    setError("");
    try {
      const stored = await request<PdfAnnotation>({
        type: "annotations.put",
        annotation: record,
        expectedRevision: record.revision,
      });
      setRecords((old) => [...old.filter((r) => r.id !== stored.id), stored]);
      setUnsaved(undefined);
      setSelection(undefined);
      getSelection()?.removeAllRanges();
      tell(t("已保存到本机", "Saved on this device"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }
  async function remove(record: PdfAnnotation) {
    if (removing || saving || unsaved || record.pageUrl !== key) return;
    setRemoving(true);
    setError("");
    try {
      await request({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      });
      setRecords((old) => old.filter((item) => item.id !== record.id));
      setPicked((current) => (current?.id === record.id ? undefined : current));
      setUndoRecord(record);
      tell(t("已移除标注，可撤销。", "Annotation removed. Undo is available."));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRemoving(false);
    }
  }
  async function restoreRemoved() {
    if (
      !undoRecord ||
      removing ||
      saving ||
      unsaved ||
      undoRecord.pageUrl !== key
    )
      return;
    setRemoving(true);
    setError("");
    try {
      const restored = await request<PdfAnnotation>({
        type: "annotations.restore",
        annotation: { ...undoRecord, updatedAt: new Date().toISOString() },
      });
      setRecords((old) => [
        ...old.filter((item) => item.id !== restored.id),
        restored,
      ]);
      setUndoRecord(undefined);
      tell(t("标注已恢复。", "Annotation restored."));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRemoving(false);
    }
  }
  function mark(
    target: SelectionTarget,
    kind: "pdf-text" | "pdf-area",
    chosen = color,
  ) {
    if (!opened || !key || !enabled || saving || removing || unsaved) return;
    const now = new Date().toISOString();
    const pdfTarget: PdfTarget = {
      ...target,
      documentHash: opened.hash,
      fileName: opened.fileName,
      ...(opened.sourceUrl ? { sourceUrl: opened.sourceUrl } : {}),
    };
    void save({
      id: crypto.randomUUID(),
      pageUrl: key,
      pageTitle: opened.fileName,
      color: chosen,
      note: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
      kind,
      target: pdfTarget,
    });
  }
  function jump(n: number) {
    if (!opened) return;
    const page = Math.min(opened.document.numPages, Math.max(1, n));
    setPageNumber(page);
    setPageWindow({
      start: Math.max(0, page - 2),
      end: Math.min(opened.document.numPages, page + 2),
    });
    container.current?.scrollTo({
      top: layout[page - 1] ?? 0,
      behavior: "instant",
    });
  }
  return (
    <main className="pdf-app">
      <header className="pdf-header">
        <div className="pdf-brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={ICON_PATHS.pdf} />
          </svg>
          <strong>
            Web Ink <span>PDF</span>
          </strong>
        </div>
        <a href={chrome.runtime.getURL("/library.html")}>
          {t("资料库", "Library")}
        </a>
      </header>
      <section className="pdf-open" aria-label={t("打开 PDF", "Open PDF")}>
        <label className="pdf-file-button">
          {t("选择本地 PDF", "Choose local PDF")}
          <input
            aria-label={t("选择本地 PDF", "Choose local PDF")}
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy || saving || removing || !!unsaved}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openPdf(file);
              e.target.value = "";
            }}
          />
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void openPdf();
          }}
        >
          <input
            aria-label={t("公开 PDF 网址", "Public PDF URL")}
            type="url"
            value={source}
            placeholder="https://…/paper.pdf"
            onChange={(e) => setSource(e.target.value)}
            required
          />
          <button disabled={busy || saving || removing || !!unsaved}>
            {busy ? t("正在读取…", "Loading…") : t("打开网址", "Open URL")}
          </button>
        </form>
      </section>
      {error && (
        <div className="pdf-message error" role="alert">
          <span>{error}</span>
          {unsaved ? (
            <>
              <button disabled={saving} onClick={() => void save(unsaved)}>
                {t("重试保存", "Retry save")}
              </button>
              <button
                disabled={saving}
                onClick={() => {
                  setUnsaved(undefined);
                  setError("");
                }}
              >
                {t("放弃本次修改", "Discard change")}
              </button>
            </>
          ) : (
            <button onClick={() => setError("")}>{t("关闭", "Dismiss")}</button>
          )}
        </div>
      )}
      {notice && (
        <div className="pdf-message" role="status">
          {notice}
        </div>
      )}
      {opened ? (
        <>
          <nav
            className="pdf-toolbar"
            aria-label={t("PDF 工具栏", "PDF toolbar")}
          >
            <span className="pdf-name" title={opened.fileName}>
              {opened.fileName}
            </span>
            <label>
              {t("页", "Page")}{" "}
              <input
                aria-label={t("页码", "Page number")}
                type="number"
                min="1"
                max={opened.document.numPages}
                value={pageNumber}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  if (Number.isInteger(n)) jump(n);
                }}
              />{" "}
              / {opened.document.numPages}
            </label>
            <button
              aria-label={t("缩小", "Zoom out")}
              disabled={zoom <= 0.5}
              onClick={() => {
                setSelection(undefined);
                setDimensions({});
                setZoom((z) => Math.max(0.5, z - 0.25));
              }}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label={t("放大", "Zoom in")}
              disabled={zoom >= 3}
              onClick={() => {
                setSelection(undefined);
                setDimensions({});
                setZoom((z) => Math.min(3, z + 0.25));
              }}
            >
              +
            </button>
            <button
              onClick={() => {
                setSelection(undefined);
                setDimensions({});
                setRotation((r) => (r + 90) % 360);
              }}
            >
              {t("旋转", "Rotate")}
            </button>
            <button
              aria-pressed={enabled}
              disabled={saving || !!unsaved}
              onClick={() => void toggle()}
            >
              {enabled
                ? t("关闭标注", "Disable annotations")
                : t("开启标注", "Enable annotations")}
            </button>
            {enabled && (
              <>
                <button
                  aria-pressed={area}
                  onClick={() => {
                    setArea((a) => !a);
                    setSelection(undefined);
                  }}
                >
                  {area
                    ? t("文字选择", "Select text")
                    : t("区域标注", "Mark area")}
                </button>
                <input
                  aria-label={t("标注颜色", "Annotation color")}
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              </>
            )}
          </nav>
          {selection && enabled && (
            <div
              className="pdf-selection"
              role="toolbar"
              aria-label={t("选中文字高亮", "Highlight selected text")}
            >
              {COLORS.slice(0, 4).map((c) => (
                <button
                  className="pdf-swatch"
                  key={c}
                  aria-label={`${t("高亮", "Highlight")} ${c}`}
                  style={{ background: c }}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => mark(selection, "pdf-text", c)}
                />
              ))}
              <button
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => mark(selection, "pdf-text")}
              >
                {t("应用当前颜色", "Use current color")}
              </button>
              <button
                onClick={() => {
                  setSelection(undefined);
                  getSelection()?.removeAllRanges();
                }}
              >
                {t("取消", "Cancel")}
              </button>
            </div>
          )}
          {picked && enabled && (
            <div className="pdf-mark-menu" role="status">
              <span>
                {picked.kind === "pdf-text"
                  ? t("文字标注", "Text annotation")
                  : t("区域标注", "Area annotation")}
              </span>
              <button disabled={removing} onClick={() => void remove(picked)}>
                {t("取消标注", "Remove annotation")}
              </button>
              <button disabled={removing} onClick={() => setPicked(undefined)}>
                {t("关闭", "Close")}
              </button>
            </div>
          )}
          {undoRecord && (
            <div className="pdf-undo" role="status">
              <span>{t("标注已移除。", "Annotation removed.")}</span>
              <button disabled={removing} onClick={() => void restoreRemoved()}>
                {t("撤销移除", "Undo remove")}
              </button>
              <button
                disabled={removing}
                onClick={() => setUndoRecord(undefined)}
              >
                {t("关闭", "Close")}
              </button>
            </div>
          )}
          <div className="pdf-workspace">
            <div
              className="pdf-pages"
              tabIndex={0}
              ref={container}
              aria-label={t("PDF 页面", "PDF pages")}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSelection(undefined);
                  setArea(false);
                }
              }}
            >
              <div
                aria-hidden="true"
                style={{ height: layout[pageWindow.start] ?? 0 }}
              />
              {Array.from(
                {
                  length:
                    Math.min(pageWindow.end, opened.document.numPages) -
                    pageWindow.start,
                },
                (_, i) => i + pageWindow.start + 1,
              ).map((n) => (
                <div
                  className="pdf-slot"
                  data-page={n}
                  key={`${opened.hash}-${n}`}
                  style={{
                    width: dimensions[n]?.width || 612 * zoom,
                    height: dimensions[n]?.height || 792 * zoom,
                  }}
                >
                  {
                    <PdfPage
                      opened={opened}
                      number={n}
                      zoom={zoom}
                      rotation={rotation}
                      records={
                        enabled
                          ? records.filter((r) => r.target.pageNumber === n)
                          : []
                      }
                      enabled={enabled}
                      area={area}
                      color={color}
                      onSelection={setSelection}
                      onPick={(record) => {
                        setPicked(record);
                        setSelection(undefined);
                      }}
                      onArea={(target) => mark(target, "pdf-area")}
                      onDimensions={(width, height) =>
                        setDimensions((old) =>
                          old[n]?.width === width && old[n]?.height === height
                            ? old
                            : { ...old, [n]: { width, height } },
                        )
                      }
                      onError={setError}
                    />
                  }
                </div>
              ))}
              <div
                aria-hidden="true"
                style={{
                  height: Math.max(
                    0,
                    (layout.at(-1) ?? 0) -
                      (layout[
                        Math.min(pageWindow.end, opened.document.numPages)
                      ] ?? 0),
                  ),
                }}
              />
            </div>
            <aside className="pdf-notes">
              <h2>
                {t("本篇标注", "Annotations")} <span>{records.length}</span>
              </h2>
              {!records.length && (
                <p className="pdf-muted">
                  {t(
                    "开启标注后，选择文字高亮，或框选图表区域。",
                    "Enable annotations, then select text or draw a rectangle over a figure.",
                  )}
                </p>
              )}
              {records
                .slice()
                .sort(
                  (a, b) =>
                    a.target.pageNumber - b.target.pageNumber ||
                    a.createdAt.localeCompare(b.createdAt),
                )
                .map((r) => (
                  <PdfNote
                    key={r.id}
                    record={r}
                    language={settings.language}
                    onJump={() => jump(r.target.pageNumber)}
                    onError={setError}
                    onRemove={remove}
                    removing={removing}
                  />
                ))}
            </aside>
          </div>
        </>
      ) : (
        <section className="pdf-welcome">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={ICON_PATHS.pdf} />
          </svg>
          <h1>{t("读论文，留下重点", "Read. Mark. Return.")}</h1>
          <p>
            {t(
              "选择一份 PDF，或打开公开网址。标注保存在本机，原文件不会存入资料库。",
              "Choose a PDF or open a public URL. Annotations stay on this device; the PDF is not stored in your library.",
            )}
          </p>
          <p className="pdf-muted">
            {t(
              "单份文件最多 50 MiB。登录网站的 PDF 请下载后选择本地文件；扫描件可做区域标注。",
              "Up to 50 MiB per file. Download authenticated PDFs first. Scanned documents support area annotations.",
            )}
          </p>
          {initialParams.has("document") && (
            <p role="status">
              {t(
                "请重新选择同一 PDF，核对文件内容后恢复标注。",
                "Choose the same PDF again to verify its content and restore annotations.",
              )}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
