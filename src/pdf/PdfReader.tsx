import { PdfFind } from "./PdfFind";
import type { PdfSearchMatch } from "./search";
import { PdfPage } from "./PdfPage";
import { PdfNote, type PdfNoteDraft } from "./PdfNote";
import { connectPdfSidebar } from "./sidebar-connection";
import type { PdfReaderRequest, PdfSidebarState } from "./sidebar-types";
import {
  errorText,
  type PdfAnnotation,
  type OpenDocument,
  type SelectionTarget,
  type SelectionPreview,
} from "./types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { request, RequestError, releaseChromeListener } from "../core/client";
import {
  COLORS,
  DEFAULT_SETTINGS,
  type Annotation,
  type AnnotationPage,
  type PdfHandoff,
  type PdfReturnResult,
  type Request,
  type PdfTarget,
  type Settings,
} from "../core/model";
import { THEME_TOKENS } from "../ui/theme";
import { Icon } from "../ui/management/helpers";
import { pdfHash, pdfSourceUrl, readLocalPdf, readRemotePdf } from "./source";
import { PageLayoutIndex } from "./layout";
import { PdfSession } from "./session";
import {
  PDF_MIN_ZOOM,
  PDF_MAX_ZOOM,
  readPdfReadingPosition,
  createPdfReadingPositionWriter,
  capturePdfReadingPosition,
  restorePdfReadingPosition,
  type PdfReadingPosition,
  type PdfReadingPositionWriter,
  type PdfRotation,
} from "./reading-position";
import "pdfjs-dist/web/pdf_viewer.css";
import "../ui/management.css";
import "./pdf.css";

const isPdf = (record: Annotation): record is PdfAnnotation =>
  record.kind === "pdf-text" || record.kind === "pdf-area";
const noteTags = (value: string) => [
  ...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean)),
];
const dirtyDraft = (draft: PdfNoteDraft) =>
  draft.note !== draft.base.note ||
  draft.color !== draft.base.color ||
  noteTags(draft.tags).join("\0") !== draft.base.tags.join("\0");
type LeaveAction =
  | { kind: "return" | "source" | "library" | "choose" }
  | { kind: "open"; file?: File; source: string };
type PositionSession = {
  session: number;
  hash: string;
  writer: PdfReadingPositionWriter;
  readReady: boolean;
  intent: number;
  pending?: PdfReadingPosition;
};
function safeSource(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return pdfSourceUrl(raw).href;
  } catch {
    return undefined;
  }
}

export function PdfReader() {
  const [initialParams] = useState(() => new URLSearchParams(location.search));
  const handoffToken = initialParams.get("handoff");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const autoOpenAttempted = useRef(false);
  const [source, setSource] = useState(initialParams.get("source") || "");
  const [opened, setOpened] = useState<OpenDocument>();
  const [records, setRecords] = useState<PdfAnnotation[]>([]);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const [showMarks, setShowMarks] = useState(true),
    [area, setArea] = useState(false);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState<PdfRotation>(0),
    [pageNumber, setPageNumber] = useState(1);
  const [searchMatch, setSearchMatch] = useState<PdfSearchMatch>();
  const pendingSearchPosition = useRef<{ pageNumber: number; intent: number } | undefined>(undefined);
  const [zoomText, setZoomText] = useState("100%");
  const [fitWidth, setFitWidth] = useState(false);
  const intrinsicDimensions = useRef(new Map<number, { width: number; height: number }>());
  const currentView = useRef({ zoom, rotation });
  currentView.current = { zoom, rotation };
  const [selection, setSelection] = useState<SelectionPreview>();
  const selectionBar = useRef<HTMLDivElement>(null);
  const [selectionStyle, setSelectionStyle] = useState<React.CSSProperties>({});
  const [notesOpen, setNotesOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false);
  const moreMenu = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const notesRail = useRef<HTMLElement>(null);
  const readerTab = useRef<number | undefined>(undefined);
  const supportsSidebar = typeof chrome.sidePanel?.open === "function";
  const [fallbackNotes, setFallbackNotes] = useState(false);
  const [sidebarAttached, setSidebarAttached] = useState(false);
  const sidebarAttachedRef = useRef(false);
  const sidebarClient = useRef<ReturnType<typeof connectPdfSidebar> | undefined>(undefined);
  const sidebarHandler = useRef<(message: PdfReaderRequest) => void>(() => {});
  const sidebarView = useRef<PdfSidebarState | null>(null);
  const [sidebarAck, setSidebarAck] = useState<string>();
  const [handoff, setHandoff] = useState<PdfHandoff | null>(null);
  const [handoffReady, setHandoffReady] = useState(!handoffToken);
  const [pendingLeave, setPendingLeave] = useState<LeaveAction>();
  const [leaving, setLeaving] = useState(false),
    [guardSaving, setGuardSaving] = useState(false);
  const [positionError, setPositionError] = useState("");
  const [positionEpoch, setPositionEpoch] = useState(0);
  const positionSession = useRef<PositionSession | undefined>(undefined);
  const intentEpoch = useRef(0);
  const [picked, setPicked] = useState<PdfAnnotation>();
  const [undoRecord, setUndoRecord] = useState<PdfAnnotation>();
  const [unsaved, setUnsaved] = useState<PdfAnnotation>();
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [removing, setRemoving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pageWindow, setPageWindow] = useState({ start: 0, end: 3 });
  const [notesLimit, setNotesLimit] = useState(50);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, PdfNoteDraft>>(
    {},
  );
  const draftsRef = useRef(noteDrafts);
  draftsRef.current = noteDrafts;
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  const noteAfterSave = useRef(false);
  const annotationWrites = useRef(new Set<Promise<unknown>>());
  const [writeCount, setWriteCount] = useState(0);
  const [noteSaving, setNoteSaving] = useState<string>();
  const [noteConflicts, setNoteConflicts] = useState<Record<string, boolean>>({});
  const [documentSession, setDocumentSession] = useState(0);
  const sidebarSession = useMemo(() => crypto.randomUUID(), [documentSession]);
  const container = useRef<HTMLDivElement>(null);
  const session = useRef(new PdfSession());
  const documentSessionRef = useRef(0);
  const layoutIndex = useRef(new PageLayoutIndex());
  const measureFrame = useRef(0),
    layoutGeneration = useRef(0),
    pendingScrollAdjustment = useRef(0),
    pendingMeasures = useRef(
      new Map<number, { width: number; height: number }>(),
    ),
    dimensions = useRef(new Map<number, { width: number; height: number }>()),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [measurementGeneration, setMeasurementGeneration] = useState(0);
  const zh = settings.language === "zh-CN";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const key = opened ? `urn:web-ink:pdf:${opened.hash}` : undefined;
  const inlineNotes = notesOpen && (!supportsSidebar || fallbackNotes) && !sidebarAttached;
  useEffect(() => {
    void chrome.tabs?.getCurrent?.()
      .then((tab) => { readerTab.current = tab?.id; })
      .catch((cause) => setError(errorText(cause)));
    if (!chrome.runtime.connect) return;
    const client = connectPdfSidebar("web-ink-pdf-reader", (message) => {
      if (message.type === "attached") {
        sidebarAttachedRef.current = message.attached;
        setSidebarAttached(message.attached);
        if (message.attached) setFallbackNotes(false);
      } else if (message.type === "command") sidebarHandler.current(message);
      else if (message.type === "unavailable") {
        sidebarAttachedRef.current = false;
        setSidebarAttached(false);
      }
    }, () => client.send({ type: "state", state: sidebarView.current }));
    sidebarClient.current = client;
    return () => { sidebarClient.current = undefined; client.dispose(); };
  }, []);
  function openNotes() {
    if (!supportsSidebar) { setNotesOpen((open) => !open); return; }
    setNotesOpen(true);
    if (readerTab.current === undefined) {
      setError(t("请点击浏览器工具栏 Web Ink 打开标注侧栏。", "Click Web Ink in the browser toolbar to open annotations."));
      return;
    }
    // Must run on the click, before saving yields the user gesture.
    void chrome.sidePanel.open({ tabId: readerTab.current }).then(() => setFallbackNotes(false)).catch(() => {
      if (!sidebarAttachedRef.current) setFallbackNotes(true);
      setError(t("侧栏暂时无法打开，请重试或点击工具栏 Web Ink。", "The sidebar could not open. Retry or click Web Ink in the toolbar."));
    });
  }
  const savedIds = useMemo(() => new Set(records.map((record) => record.id)), [records]);
  const deletedDrafts = Object.values(noteDrafts).filter(
    (draft) => dirtyDraft(draft) && !savedIds.has(draft.base.id),
  );
  useLayoutEffect(() => {
    if (inlineNotes && deletedDrafts.length && !pendingLeave && !sourceOpen)
      notesRail.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [inlineNotes, deletedDrafts.length, pendingLeave, sourceOpen]);
  const sortedNotes = useMemo(
    () =>
      records
        .slice()
        .sort(
          (a, b) =>
            a.target.pageNumber - b.target.pageNumber ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        ),
    [records],
  );
  const recordsByPage = useMemo(() => {
    const pages = new Map<number, PdfAnnotation[]>();
    for (const record of records) {
      const page = pages.get(record.target.pageNumber);
      if (page) page.push(record);
      else pages.set(record.target.pageNumber, [record]);
    }
    return pages;
  }, [records]);
  const tell = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 1800);
  };
  // Remote deletion must reach pending save callbacks before React renders.
  function updateRecords(next: PdfAnnotation[] | ((current: PdfAnnotation[]) => PdfAnnotation[])) {
    const values = typeof next === "function" ? next(recordsRef.current) : next;
    const ids = new Set(values.map((record) => record.id));
    for (const record of recordsRef.current) {
      const draft = draftsRef.current[record.id];
      if (draft && dirtyDraft(draft) && !ids.has(record.id)) {
        setNotesOpen(true);
        break;
      }
    }
    recordsRef.current = values;
    setRecords(values);
  }
  function updateDraft(id: string, draft?: PdfNoteDraft, resolveConflict = false) {
    const next = { ...draftsRef.current };
    if (draft) next[id] = draft;
    else delete next[id];
    draftsRef.current = next;
    setNoteDrafts(next);
    if (!draft || resolveConflict) setNoteConflicts((current) => ({ ...current, [id]: false }));
  }
  function userIntent() {
    intentEpoch.current++;
    if (positionSession.current) positionSession.current.pending = undefined;
    setPositionEpoch((epoch) => epoch + 1);
  }
  function pagesPadding() {
    return container.current ? parseFloat(getComputedStyle(container.current).paddingTop) || 0 : 0;
  }
  function currentPosition() {
    const active = positionSession.current;
    const scroller = container.current;
    if (!active || !scroller || active.session !== documentSessionRef.current || !active.readReady || active.pending) return;
    const top = Math.max(0, scroller.scrollTop - pagesPadding());
    if (!dimensions.current.has(layoutIndex.current.pageAt(top))) return;
    return capturePdfReadingPosition(layoutIndex.current, top, zoom, rotation);
  }
  function savePosition() {
    const snapshot = currentPosition();
    if (snapshot) positionSession.current?.writer.save(snapshot);
  }
  async function flushPosition() {
    savePosition();
    try {
      await positionSession.current?.writer.flush();
      setPositionError("");
    } catch {
      setPositionError(t("阅读位置暂未保存，可重试；标注不受影响。", "Reading position was not saved. Retry is available; annotations are unaffected."));
    }
  }
  async function trackWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    annotationWrites.current.add(pending);
    setWriteCount(annotationWrites.current.size);
    try {
      return await pending;
    } finally {
      annotationWrites.current.delete(pending);
      setWriteCount(annotationWrites.current.size);
    }
  }
  useEffect(() => {
    if (!handoffToken) return;
    let dead = false;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(handoffToken)) {
      setHandoffReady(true);
      return;
    }
    void request<PdfHandoff | null>({ type: "pdf.handoff.get", token: handoffToken })
      .then((value) => { if (!dead) setHandoff(value?.token === handoffToken ? value : null); })
      .catch(() => { if (!dead) setHandoff(null); })
      .finally(() => { if (!dead) setHandoffReady(true); });
    return () => { dead = true; };
  }, [handoffToken]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!unsavedRef.current && !annotationWrites.current.size && !Object.values(draftsRef.current).some(dirtyDraft)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const hide = () => { void positionSession.current?.writer.flush().catch(() => undefined); };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (event: PointerEvent) => {
      if (!moreMenu.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [moreOpen]);
  useEffect(() => {
    void request<Settings>({ type: "settings.get" }).then((next) => {
      setSettings(next);
      setColor(next.defaultColor);
      setSettingsReady(true);
    }).catch((cause) => setError(errorText(cause)));
    const listener = (m: { type?: string }) => {
      if (m.type === "settings.changed")
        void request<Settings>({ type: "settings.get" }).then(setSettings).catch((cause) => setError(errorText(cause)));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
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
      void session.current.dispose();
      const position = positionSession.current;
      positionSession.current = undefined;
      if (position) void position.writer.flush().catch(() => undefined).finally(() => position.writer.dispose());
      cancelAnimationFrame(measureFrame.current);
      measureFrame.current = 0;
      clearTimeout(noticeTimer.current);
    },
    [],
  );
  const refresh = useCallback(async () => {
    if (!key) return;
    const active = documentSession;
    try {
      const all = await request<Annotation[]>({
        type: "annotations.list",
        pageUrl: key,
      });
      if (active === documentSessionRef.current) updateRecords(all.filter(isPdf));
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
    }
  }, [key, documentSession]);
  useEffect(() => {
    if (!key) return;
    const active = documentSession;
    const listener = (m: {
      type?: string;
      pageUrl?: string;
      annotation?: Annotation;
      deletedId?: string;
    }) => {
      if (active !== documentSessionRef.current) return;
      if (
        m.type === "annotations.changed" &&
        (!m.pageUrl || m.pageUrl === key)
      ) {
        if (m.annotation && isPdf(m.annotation)) {
          const changed = m.annotation;
          updateRecords((old) =>
            [...old.filter((r) => r.id !== changed.id), changed].sort(
              (a, b) => a.target.pageNumber - b.target.pageNumber,
            ),
          );
        } else if (m.deletedId)
          updateRecords((old) => old.filter((r) => r.id !== m.deletedId));
        else void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
  }, [key, documentSession, refresh]);
  useLayoutEffect(() => {
    if (!opened) return;
    const scroller = container.current;
    const oldScroll = scroller?.scrollTop ?? 0;
    const padding = pagesPadding();
    const anchor = scroller ? layoutIndex.current.pageAt(Math.max(0, oldScroll - padding)) : 1;
    const relative = Math.max(0, oldScroll - padding) - layoutIndex.current.offsetBefore(anchor);
    cancelAnimationFrame(measureFrame.current);
    measureFrame.current = 0;
    pendingMeasures.current.clear();
    pendingScrollAdjustment.current = 0;
    layoutGeneration.current++;
    setMeasurementGeneration(layoutGeneration.current);
    const fallback = (rotation % 180 ? 612 : 792) * zoom;
    layoutIndex.current.reset(opened.document.numPages, fallback);
    dimensions.current.clear();
    for (const [page, size] of intrinsicDimensions.current) {
      const width = (rotation % 180 ? size.height : size.width) * zoom;
      const height = (rotation % 180 ? size.width : size.height) * zoom;
      dimensions.current.set(page, { width, height });
      layoutIndex.current.update(page, height);
    }
    pendingScrollAdjustment.current = scroller
      ? layoutIndex.current.offsetBefore(anchor) + relative + padding - oldScroll
      : 0;
    setLayoutEpoch((value) => value + 1);
  }, [documentSession, zoom, rotation]);
  useEffect(() => {
    setNotesLimit(50);
  }, [documentSession]);
  const onPageDimensions = useCallback(
    (page: number, generation: number, width: number, height: number) => {
      if (generation !== layoutGeneration.current) return;
      const view = currentView.current;
      intrinsicDimensions.current.set(page, {
        width: (view.rotation % 180 ? height : width) / view.zoom,
        height: (view.rotation % 180 ? width : height) / view.zoom,
      });
      pendingMeasures.current.set(page, { width, height });
      if (measureFrame.current) return;
      measureFrame.current = requestAnimationFrame(() => {
        measureFrame.current = 0;
        const scroller = container.current;
        const anchor = scroller
          ? layoutIndex.current.pageAt(Math.max(0, scroller.scrollTop - pagesPadding()))
          : 1;
        const before = scroller ? layoutIndex.current.offsetBefore(anchor) : 0;
        if (generation !== layoutGeneration.current) return;
        const measurements = [...pendingMeasures.current];
        let changed = false;
        for (const [number, size] of measurements) {
          if (layoutIndex.current.update(number, size.height)) changed = true;
        }
        pendingMeasures.current.clear();
        if (scroller && changed)
          pendingScrollAdjustment.current +=
            layoutIndex.current.offsetBefore(anchor) - before;
        let dimensionsChanged = false;
        for (const [number, size] of measurements) {
          const previous = dimensions.current.get(number);
          if (
            previous?.width !== size.width ||
            previous?.height !== size.height
          ) {
            dimensions.current.set(number, size);
            dimensionsChanged = true;
          }
        }
        if (changed || dimensionsChanged) setLayoutEpoch((value) => value + 1);
      });
    },
    [],
  );
  useLayoutEffect(() => {
    const adjustment = pendingScrollAdjustment.current;
    if (!adjustment) return;
    const scroller = container.current;
    if (scroller) scroller.scrollTop += adjustment;
    pendingScrollAdjustment.current = 0;
  }, [layoutEpoch]);
  useLayoutEffect(() => {
    const active = positionSession.current;
    const pending = active?.pending;
    const scroller = container.current;
    if (!active || !pending || !scroller || active.session !== documentSessionRef.current) return;
    if (active.intent !== intentEpoch.current) { active.pending = undefined; return; }
    if (!dimensions.current.has(pending.pageNumber)) return;
    const top = restorePdfReadingPosition(layoutIndex.current, pending);
    if (top === undefined) return;
    pendingScrollAdjustment.current = 0;
    scroller.scrollTop = top + pagesPadding();
    active.pending = undefined;
    setPageNumber(pending.pageNumber);
    setPositionEpoch((epoch) => epoch + 1);
  }, [layoutEpoch, positionEpoch, documentSession, zoom, rotation]);
  useLayoutEffect(() => {
    const bar = selectionBar.current;
    const scroller = container.current;
    if (!selection || !bar || !scroller) return;
    const page = scroller.getBoundingClientRect();
    const bounds = bar.getBoundingClientRect();
    const left = Math.max(8, page.left), right = Math.min(innerWidth - 8, page.right);
    const top = Math.max(60, page.top), bottom = Math.min(innerHeight - 8, page.bottom);
    const anchor = selection.anchor;
    const above = anchor.top - bounds.height - 8;
    const below = anchor.bottom + 8;
    if (bounds.width > right - left || anchor.bottom < top || anchor.top > bottom || (above < top && below + bounds.height > bottom)) {
      setSelectionStyle({});
      return;
    }
    setSelectionStyle({ left: Math.max(left, Math.min(right - bounds.width, (anchor.left + anchor.right - bounds.width) / 2)),
      top: above >= top ? above : below, bottom: "auto", transform: "none" });
  }, [selection, layoutEpoch]);
  useEffect(() => { savePosition(); }, [layoutEpoch, positionEpoch, documentSession, zoom, rotation]);
  useEffect(() => {
    const scroller = container.current;
    if (!opened || !scroller) return;
    let frame = 0;
    const findPage = (position: number) => {
      return layoutIndex.current.pageAt(position) - 1;
    };
    const update = () => {
      frame = 0;
      if (positionSession.current?.pending) return;
      const position = Math.max(0, scroller.scrollTop - pagesPadding());
      const first = findPage(position);
      const last = findPage(position + scroller.clientHeight);
      const start = Math.max(0, first - 1),
        end = Math.min(opened.document.numPages, last + 2);
      setPageWindow((old) =>
        old.start === start && old.end === end ? old : { start, end },
      );
      setPageNumber((current) => {
        let chosen = first + 1, largest = -1;
        for (let page = first + 1; page <= Math.min(opened.document.numPages, last + 1); page++) {
          const start = layoutIndex.current.offsetBefore(page);
          const height = layoutIndex.current.pageHeight(page) ?? 0;
          const visible = Math.max(0, Math.min(position + scroller.clientHeight, start + height) - Math.max(position, start));
          const fraction = height > 0 ? visible / height : 0;
          // A short final page cannot always align to the viewport top. Keep
          // an equally visible requested page rather than selecting its gap.
          if (fraction > largest + 0.0001 || (Math.abs(fraction - largest) < 0.0001 && page === current)) {
            chosen = page;
            largest = fraction;
          }
        }
        return chosen;
      });
      savePosition();
    };
    const scroll = () => {
      setSelectionStyle({});
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
  }, [opened?.hash, layoutEpoch, positionEpoch, zoom, rotation]);
  useEffect(() => {
    if (!settingsReady || autoOpenAttempted.current) return;
    autoOpenAttempted.current = true;
    if (safeSource(initialParams.get("source") || undefined)) {
      // A side-panel click starts this handoff. Never request site access from
      // an effect: if needed, the reader's Open URL button supplies the gesture.
      void loadPdf(undefined, true);
    }
  }, [settingsReady]);
  async function loadPdf(file?: File, automatic = false, chosenSource = source) {
    const openingParams = new URLSearchParams(location.search);
    const openingIntent = intentEpoch.current;
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
    let token = 0,
      signal: AbortSignal | undefined;
    setError("");
    setNotice("");
    setBusy(true);
    // Invalidate every async callback from the currently displayed document
    // before a new source read can complete.
    documentSessionRef.current++;
    positionSession.current?.writer.dispose();
    positionSession.current = undefined;
    setOpened(undefined);
    setSearchMatch(undefined);
    pendingSearchPosition.current = undefined;
    setSelection(undefined);
    setPicked(undefined);
    setUndoRecord(undefined);
    updateRecords([]);
    setNoteDrafts({});
    draftsRef.current = {};
    setNoteConflicts({});
    setShowMarks(true);
    setNotesOpen(false);
    setSourceOpen(false);
    setPositionError("");
    setFitWidth(false);
    intrinsicDimensions.current.clear();
    setZoom(1);
    setRotation(0);
    setPageNumber(1);
    dimensions.current.clear();
    setPageWindow({ start: 0, end: 3 });
    try {
      const active = await session.current.begin();
      token = active.token;
      signal = active.signal;
      let remote: string | undefined;
      if (!file) {
        const url = pdfSourceUrl(chosenSource.trim());
        remote = url.href;
        const origins = [`${url.origin}/*`];
        if (!(await chrome.permissions.contains({ origins }))) {
          if (automatic) {
            setNotice(t("链接已带入。点击「打开网址」授权并读取，或选择本地 PDF。", "Link ready. Click Open URL to grant access, or choose a local PDF."));
            return;
          }
          if (!(await chrome.permissions.request({ origins })))
            throw Error(t("未授予网站访问权限。", "Site permission was not granted."));
        }
      }
      const bytes = file
        ? await readLocalPdf(file)
        : await readRemotePdf(remote!, signal);
      if (!session.current.isCurrent(token)) return;
      const hash = await pdfHash(bytes);
      if (!session.current.isCurrent(token)) return;
      const positionRead = readPdfReadingPosition(hash);
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
        // Font fallbacks are recoverable; page failures still reject and show an alert.
        verbosity: api.VerbosityLevel.ERRORS,
        stopAtErrors: true,
        maxImageSize: 16777216,
        canvasMaxAreaInBytes: 67108864,
      });
      session.current.setTask(token, task);
      task.onPassword = () => {
        if (!session.current.isCurrent(token)) return;
        setError(
          t(
            "加密 PDF 暂不支持，请先解锁文件。",
            "Encrypted PDFs are not supported; unlock the file first.",
          ),
        );
        void session.current.disposeCurrent();
      };
      const doc = await task.promise;
      if (!session.current.isCurrent(token)) return;
      const fileName =
        file?.name ||
        decodeURIComponent(
          new URL(remote!).pathname.split("/").pop() || "Document.pdf",
        );
      const pageUrl = `urn:web-ink:pdf:${hash}`;
      const all = await request<Annotation[]>({ type: "annotations.list", pageUrl });
      if (!session.current.isCurrent(token)) return;
      // Keep the reader URL aligned with the successfully loaded document so
      // a later library/source handoff cannot reuse a tab showing another PDF.
      const readerLocation = new URL(location.href);
      readerLocation.searchParams.set("document", hash);
      readerLocation.searchParams.delete("open");
      readerLocation.searchParams.delete("page");
      if (remote) readerLocation.searchParams.set("source", remote);
      else readerLocation.searchParams.delete("source");
      history.replaceState(null, "", readerLocation.href);
      setSource(remote ?? "");
      setOpened({
        document: doc,
        api,
        hash,
        fileName,
        ...(remote ? { sourceUrl: remote } : {}),
      });
      documentSessionRef.current++;
      setDocumentSession(documentSessionRef.current);
      updateRecords(all.filter(isPdf));
      setArea(false);
      const expected = openingParams.get("document");
      const requestedPage = openingParams.get("page");
      const explicitPage = requestedPage && /^[1-9]\d*$/.test(requestedPage) && (!expected || expected === hash) && Number(requestedPage) <= doc.numPages
        ? Number(requestedPage) : undefined;
      const position: PositionSession = {
        session: documentSessionRef.current, hash,
        writer: createPdfReadingPositionWriter(hash), readReady: false, intent: openingIntent,
      };
      positionSession.current = position;
      void positionRead.then((stored) => {
        if (!session.current.isCurrent(token) || positionSession.current !== position) return;
        position.readReady = true;
        if (openingIntent === intentEpoch.current) {
          const valid = stored && stored.pageNumber <= doc.numPages ? stored : undefined;
          const target = explicitPage ? { version: 1 as const, pageNumber: explicitPage, pageOffsetRatio: 0,
            zoom: valid?.zoom ?? 1, rotation: valid?.rotation ?? 0 } : valid;
          if (target) {
            position.pending = target;
            setZoom(target.zoom);
            setRotation(target.rotation);
            setPageNumber(target.pageNumber);
            setPageWindow({ start: Math.max(0, target.pageNumber - 2), end: Math.min(doc.numPages, target.pageNumber + 2) });
          }
        }
        setPositionEpoch((epoch) => epoch + 1);
      });
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
      if (session.current.isCurrent(token) && changed)
        setNotice(
          t(
            "文档版本已变化：旧标注已保留，没有套用到这份文件。",
            "Document changed: previous annotations are preserved and were not applied to this file.",
          ),
        );
    } catch (cause) {
      if (token && session.current.isCurrent(token) && !signal?.aborted) {
        setError(errorText(cause));
        await session.current.disposeCurrent();
      }
    } finally {
      if (token && session.current.isCurrent(token)) setBusy(false);
    }
  }
  async function save(record: PdfAnnotation, editNote = false): Promise<PdfAnnotation> {
    setSaving(true);
    setUnsaved(record);
    unsavedRef.current = record;
    noteAfterSave.current = editNote;
    setError("");
    const active = documentSession;
    return trackWrite(async () => { try {
      const stored = await request<PdfAnnotation>({
        type: "annotations.put",
        annotation: record,
        expectedRevision: record.revision,
      });
      if (active !== documentSessionRef.current) throw new DOMException("Document changed", "AbortError");
      updateRecords((old) => [...old.filter((r) => r.id !== stored.id), stored]);
      setUnsaved(undefined);
      unsavedRef.current = undefined;
      setSelection(undefined);
      getSelection()?.removeAllRanges();
      tell(t("已保存到本机", "Saved on this device"));
      if (editNote) {
        setNotesOpen(true);
        if (!supportsSidebar || fallbackNotes) setNotesLimit((limit) => Math.max(limit, records.length + 1));
        updateDraft(stored.id, { note: stored.note, tags: stored.tags.join(", "), color: stored.color, base: stored, editing: true });
      }
      return stored;
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
      throw cause;
    } finally {
      if (active === documentSessionRef.current) setSaving(false);
    } });
  }
  async function saveNote(id: string, draft: PdfNoteDraft): Promise<void> {
    const deletedMessage = t(
      "原标注已被删除。草稿仅保留在此窗口，请复制内容或放弃草稿后再继续。",
      "The original annotation was deleted. This draft remains in this window; copy its contents or discard it before leaving.",
    );
    if (!recordsRef.current.some((record) => record.id === id)) {
      setNotesOpen(true);
      setError(deletedMessage);
      throw Error(deletedMessage);
    }
    const active = documentSession;
    setNoteSaving(id);
    setError("");
    return trackWrite(async () => { try {
      const stored = await request<PdfAnnotation>({ type: "annotations.put", annotation: {
        ...draft.base, note: draft.note, tags: noteTags(draft.tags), color: draft.color, updatedAt: new Date().toISOString(),
      }, expectedRevision: draft.base.revision });
      if (active !== documentSessionRef.current) return;
      if (!recordsRef.current.some((record) => record.id === id)) throw Error(deletedMessage);
      updateRecords((old) => [...old.filter((record) => record.id !== id), stored]);
      updateDraft(id);
    } catch (cause) {
      if (active === documentSessionRef.current) {
        if (cause instanceof RequestError && cause.code === "CONFLICT") setNoteConflicts((current) => ({ ...current, [id]: true }));
        setError(errorText(cause));
      }
      throw cause;
    } finally {
      if (active === documentSessionRef.current) setNoteSaving(undefined);
    } });
  }
  const currentParams = new URLSearchParams(location.search);
  const publicUrl = opened ? safeSource(opened.sourceUrl) : safeSource(currentParams.get("source") || undefined);
  async function executeLeave(action: LeaveAction) {
    if (leaving) return;
    setLeaving(true);
    try {
      await flushPosition();
      switch (action.kind) {
        case "return":
          if (!handoff) throw Error(t("原阅读器会话已失效，请打开 PDF 来源或重新选择本地文件。", "Original-reader session expired. Open the public source or choose the local file again."));
          await request<PdfReturnResult>({ type: "pdf.returnOriginal", token: handoff.token });
          break;
        case "source":
          if (publicUrl) location.assign(publicUrl);
          else setSourceOpen(true);
          break;
        case "library": location.assign(chrome.runtime.getURL("/library.html")); break;
        case "choose": setSourceOpen(true); break;
        case "open": await loadPdf(action.file, false, action.source); break;
      }
      setPendingLeave(undefined);
    } catch (cause) {
      if (action.kind === "return" && cause instanceof RequestError &&
        (cause.code === "PDF_SOURCE_UNAVAILABLE" || cause.code === "FORBIDDEN")) setHandoff(null);
      setError(errorText(cause));
    } finally { setLeaving(false); }
  }
  function requestLeave(action: LeaveAction) {
    if (action.kind === "open") {
      autoOpenAttempted.current = true;
      // Cancel old initialization without queuing another old-document write.
      intentEpoch.current++;
      if (positionSession.current) positionSession.current.pending = undefined;
    }
    setMoreOpen(false);
    if (unsavedRef.current || annotationWrites.current.size || Object.values(draftsRef.current).some(dirtyDraft)) {
      setPendingLeave(action);
      return;
    }
    void executeLeave(action);
  }
  async function saveAndContinue() {
    if (!pendingLeave || guardSaving) return;
    setGuardSaving(true);
    try {
      await Promise.all([...annotationWrites.current]);
      if (unsavedRef.current) await save(unsavedRef.current, noteAfterSave.current);
      for (const [id, draft] of Object.entries(draftsRef.current)) {
        if (dirtyDraft(draft)) await saveNote(id, draft);
      }
      await executeLeave(pendingLeave);
    } catch (cause) { setError(errorText(cause)); }
    finally { setGuardSaving(false); }
  }
  function discardAndContinue() {
    if (!pendingLeave || annotationWrites.current.size || guardSaving) return;
    unsavedRef.current = undefined;
    setUnsaved(undefined);
    draftsRef.current = {};
    setNoteDrafts({});
    setNoteConflicts({});
    setSelection(undefined);
    getSelection()?.removeAllRanges();
    setError("");
    void executeLeave(pendingLeave);
  }
  function keepEditing() {
    setPendingLeave(undefined);
    if (deletedDrafts.length) setNotesOpen(true);
  }
  async function remove(record: PdfAnnotation) {
    if (removing || saving || unsaved || record.pageUrl !== key) return;
    setRemoving(true);
    setError("");
    const active = documentSession;
    try {
      await trackWrite(() => request({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      }));
      if (active !== documentSessionRef.current) return;
      updateRecords((old) => old.filter((item) => item.id !== record.id));
      setNoteDrafts((current) => {
        const { [record.id]: _removed, ...rest } = current;
        return rest;
      });
      setPicked((current) => (current?.id === record.id ? undefined : current));
      setUndoRecord(record);
      tell(t("已移除标注，可撤销。", "Annotation removed. Undo is available."));
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
    } finally {
      if (active === documentSessionRef.current) setRemoving(false);
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
    const active = documentSession;
    try {
      const restored = await trackWrite(() => request<PdfAnnotation>({
        type: "annotations.restore",
        annotation: { ...undoRecord, updatedAt: new Date().toISOString() },
      }));
      if (active !== documentSessionRef.current) return;
      updateRecords((old) => [
        ...old.filter((item) => item.id !== restored.id),
        restored,
      ]);
      setUndoRecord(undefined);
      tell(t("标注已恢复。", "Annotation restored."));
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
    } finally {
      if (active === documentSessionRef.current) setRemoving(false);
    }
  }
  function mark(
    target: SelectionTarget,
    kind: "pdf-text" | "pdf-area",
    chosen = color,
    editNote = false,
  ) {
    if (!opened || !key || locked || annotationWrites.current.size) return;
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
    }, editNote).catch(() => undefined);
  }
  function jump(n: number) {
    if (!opened) return;
    userIntent();
    const page = Math.min(opened.document.numPages, Math.max(1, n));
    setPageNumber(page);
    setPageWindow({
      start: Math.max(0, page - 2),
      end: Math.min(opened.document.numPages, page + 2),
    });
    container.current?.scrollTo({
      top: layoutIndex.current.offsetBefore(page) + pagesPadding(),
      behavior: "instant",
    });
  }
  const locked = busy || saving || removing || !!unsaved || leaving || guardSaving || writeCount > 0;
  const sidebarState: PdfSidebarState | null = opened && key && !busy ? {
    sessionId: sidebarSession, pageUrl: key, fileName: opened.fileName,
    totalCount: records.length,
    records: sortedNotes.filter((record, index) => index < notesLimit || noteDrafts[record.id]),
    drafts: noteDrafts, conflicts: noteConflicts,
    locked: locked || !!pendingLeave || sourceOpen,
    noteSaving, removing, undoRecord, error, notice,
  } : null;
  sidebarView.current = sidebarState;
  useEffect(() => {
    sidebarClient.current?.send({ type: "state", state: sidebarState, ack: sidebarAck });
  }, [opened, key, busy, records, notesLimit, noteDrafts, noteConflicts, locked, pendingLeave, sourceOpen, noteSaving, removing, undoRecord, error, notice, sidebarAck, sidebarSession]);
  sidebarHandler.current = (message) => {
    if (message.type !== "command" || message.pageUrl !== key || message.sessionId !== sidebarSession) return;
    const { command, commandId } = message;
    const handle = async () => {
      if (locked || pendingLeave || sourceOpen || annotationWrites.current.size || unsavedRef.current) return;
      const record = "id" in command ? recordsRef.current.find((record) => record.id === command.id) : undefined;
      switch (command.type) {
        case "focus": if (record) { jump(record.target.pageNumber); setPicked(record); } break;
        case "draft":
          if (record || draftsRef.current[command.id]) {
            updateDraft(command.id, command.draft, command.resolveConflict);
            if (record && command.draft && command.draft.base.revision !== record.revision)
              setNoteConflicts((old) => ({ ...old, [command.id]: true }));
          }
          break;
        case "save": {
          const draft = draftsRef.current[command.id];
          if (draft && !noteConflicts[command.id]) await saveNote(command.id, draft);
          break;
        }
        case "remove": if (record) await remove(record); break;
        case "undo": await restoreRemoved(); break;
        case "more": setNotesLimit((limit) => limit + 50); break;
      }
    };
    void handle().catch(() => undefined).finally(() => setSidebarAck(commandId));
  };
  function applyView(nextZoom: number, nextRotation: PdfRotation = rotation) {
    if (nextZoom === zoom && nextRotation === rotation) return;
    const anchor = positionSession.current?.pending ?? currentPosition();
    userIntent();
    const active = positionSession.current;
    if (active && anchor) {
      active.intent = intentEpoch.current;
      active.pending = { ...anchor, zoom: nextZoom, rotation: nextRotation };
      setPageWindow({ start: Math.max(0, anchor.pageNumber - 2), end: Math.min(opened?.document.numPages ?? 0, anchor.pageNumber + 2) });
    }
    setSelection(undefined);
    setPicked(undefined);
    getSelection()?.removeAllRanges();
    setZoom(nextZoom);
    setRotation(nextRotation);
  }
  function changeZoom(delta: number) {
    setFitWidth(false);
    applyView(Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, Math.round((zoom + delta) * 1000) / 1000)));
  }
  function commitZoom(raw: string) {
    const value = /^\d+(?:\.\d+)?\s*%?$/.test(raw.trim()) ? Number(raw.trim().replace(/%$/, "").trim()) / 100 : NaN;
    if (Number.isFinite(value) && value >= PDF_MIN_ZOOM && value <= PDF_MAX_ZOOM) {
      setFitWidth(false);
      applyView(value);
      setZoomText(`${Math.round(value * 100)}%`);
    } else {
      setZoomText(`${Math.round(zoom * 100)}%`);
      tell(t("请输入 10%～500% 的缩放比例。", "Enter a zoom percentage between 10% and 500%."));
    }
  }
  useEffect(() => { setZoomText(`${Math.round(zoom * 100)}%`); }, [zoom]);
  useEffect(() => {
    const scroller = container.current;
    if (!fitWidth || !opened || !scroller) return;
    let dead = false, request = 0;
    const fit = async () => {
      const token = ++request;
      try {
        const page = await opened.document.getPage(pageNumber);
        if (dead || token !== request) return;
        const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
        const style = getComputedStyle(scroller);
        const available = (scroller.clientWidth || scroller.getBoundingClientRect().width) - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        const value = Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, available / viewport.width));
        if (Number.isFinite(value) && Math.abs(value - zoom) > 0.0001) applyView(value);
      } catch (cause) { if (!dead) setError(errorText(cause)); }
    };
    void fit();
    const resize = new ResizeObserver(() => void fit());
    resize.observe(scroller);
    return () => { dead = true; resize.disconnect(); };
  }, [opened, fitWidth, pageNumber, rotation, zoom]);
  function dialogKeys(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const zoomControls = <>
    <button className="quiet icon-button" aria-label={t("缩小", "Zoom out")} title={t("缩小", "Zoom out")}
      disabled={locked || zoom <= PDF_MIN_ZOOM} onClick={() => changeZoom(-0.25)}><Icon name="minus" /></button>
    <input className="pdf-zoom" aria-label={t("缩放比例", "Zoom percentage")} inputMode="decimal" value={zoomText} disabled={locked}
      onChange={(event) => { setFitWidth(false); userIntent(); setZoomText(event.target.value); }}
      onBlur={(event) => commitZoom(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commitZoom(event.currentTarget.value); }
        if (event.key === "Escape") { event.stopPropagation(); setZoomText(`${Math.round(zoom * 100)}%`); }
      }} />
    <button className="quiet icon-button" aria-label={t("放大", "Zoom in")} title={t("放大", "Zoom in")}
      disabled={locked || zoom >= PDF_MAX_ZOOM} onClick={() => changeZoom(0.25)}><Icon name="plus" /></button>
  </>;
  const backLabel = handoff ? t("返回原阅读器", "Return to original reader") : publicUrl
    ? t("打开 PDF 来源", "Open PDF source") : t("重新选择 PDF", "Choose PDF again");
  const backAction: LeaveAction = { kind: handoff ? "return" : publicUrl ? "source" : "choose" };
  const sourceControls = (
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
      <form onSubmit={(event) => { event.preventDefault(); requestLeave({ kind: "open", source }); }}>
        <input aria-label={t("公开 PDF 网址", "Public PDF URL")} type="url" value={source} disabled={locked}
          placeholder="https://…/paper.pdf" onChange={(event) => setSource(event.target.value)} required />
        <button disabled={locked}>{busy ? t("正在读取…", "Loading…") : t("打开网址", "Open URL")}</button>
      </form>
    </section>
  );
  return (
    <main className="pdf-app" onKeyDown={(event) => {
      if (event.key !== "Escape" || guardSaving || leaving) return;
      if (pendingLeave) keepEditing();
      else if (sourceOpen) setSourceOpen(false);
      else {
        if (moreOpen) moreTrigger.current?.focus();
        setMoreOpen(false);
        setSelection(undefined);
        setPicked(undefined);
        setArea(false);
      }
    }}>
      {opened ? <nav className="pdf-toolbar" aria-label={t("PDF 工具栏", "PDF toolbar")}>
        <button className="quiet icon-button pdf-back" aria-label={backLabel} title={backLabel}
          disabled={leaving || !handoffReady} onClick={() => requestLeave(backAction)}><Icon name="chevron" /></button>
        <span className="pdf-name" title={opened.fileName}>{opened.fileName}</span>
        <button className="quiet icon-button pdf-previous pdf-page-action" aria-label={t("上一页", "Previous page")} title={t("上一页", "Previous page")}
          disabled={locked || pageNumber <= 1} onClick={() => jump(pageNumber - 1)}><Icon name="chevron" /></button>
        <label className="pdf-page-field"><input aria-label={t("页码", "Page number")} type="number" min="1"
          max={opened.document.numPages} value={pageNumber} disabled={locked}
          onChange={(event) => { const number = event.target.valueAsNumber; if (Number.isInteger(number)) jump(number); }} />
          <span>/ {opened.document.numPages}</span></label>
        <button className="quiet icon-button pdf-page-action" aria-label={t("下一页", "Next page")} title={t("下一页", "Next page")}
          disabled={locked || pageNumber >= opened.document.numPages} onClick={() => jump(pageNumber + 1)}><Icon name="chevron" /></button>
        <div className="pdf-zoom-controls">{zoomControls}</div>
        <button className="quiet icon-button pdf-view-action" aria-label={t("适合宽度", "Fit to width")} title={t("适合宽度", "Fit to width")} aria-pressed={fitWidth}
          disabled={locked} onClick={() => { userIntent(); setFitWidth(true); }}><Icon name="fitWidth" /></button>
        <button className="quiet icon-button pdf-view-action" aria-label={t("旋转页面", "Rotate page")} title={t("旋转页面", "Rotate page")}
          disabled={locked} onClick={() => applyView(zoom, ((rotation + 90) % 360) as PdfRotation)}><Icon name="rotate" /></button>
        <PdfFind opened={opened} language={settings.language} blocked={leaving || guardSaving || !!pendingLeave || sourceOpen}
          onMatch={(match) => { pendingSearchPosition.current = undefined; setSearchMatch(match); }}
          onNavigate={(page) => { jump(page); pendingSearchPosition.current = { pageNumber: page, intent: intentEpoch.current }; }} />
        <div className="pdf-more" ref={moreMenu}>
          <button className="quiet icon-button" ref={moreTrigger} aria-label={t("更多", "More")} title={t("更多", "More")}
            aria-expanded={moreOpen} aria-controls="pdf-more-menu" disabled={leaving || guardSaving}
            onClick={() => setMoreOpen((open) => !open)}><Icon name="more" /></button>
          {moreOpen && <div className="pdf-more-menu" id="pdf-more-menu" aria-label={t("更多阅读器操作", "More reader actions")}>
            <div className="pdf-more-zoom">{zoomControls}</div>
            {!sidebarAttached && !inlineNotes && <button onClick={() => { openNotes(); setMoreOpen(false); }}>
              <Icon name="note" />{t("查看标注", "View annotations")}</button>}
            <button className="pdf-more-page" disabled={locked || pageNumber <= 1} onClick={() => { jump(pageNumber - 1); setMoreOpen(false); }}>
              <Icon name="chevron" />{t("上一页", "Previous page")}</button>
            <button className="pdf-more-page" disabled={locked || pageNumber >= opened.document.numPages} onClick={() => { jump(pageNumber + 1); setMoreOpen(false); }}>
              <Icon name="chevron" />{t("下一页", "Next page")}</button>
            <button className="pdf-more-view" disabled={locked} aria-pressed={fitWidth} onClick={() => { userIntent(); setFitWidth(true); setMoreOpen(false); }}>
              <Icon name="fitWidth" />{t("适合宽度", "Fit to width")}</button>
            <button className="pdf-more-view" disabled={locked} onClick={() => { applyView(zoom, ((rotation + 90) % 360) as PdfRotation); setMoreOpen(false); }}>
              <Icon name="rotate" />{t("旋转页面", "Rotate page")}</button>
            <button aria-pressed={area} disabled={locked} onClick={() => { userIntent(); setArea((value) => !value); setSelection(undefined); setMoreOpen(false); }}>
              <Icon name="highlight" />{area ? t("文字选择", "Select text") : t("区域标注", "Mark area")}</button>
            <label className="pdf-area-color">{t("标注颜色", "Annotation color")}<input type="color" aria-label={t("标注颜色", "Annotation color")}
              value={color} disabled={locked} onChange={(event) => setColor(event.target.value)} /></label>
            <button aria-pressed={showMarks} onClick={() => { setShowMarks((value) => !value); setPicked(undefined); setMoreOpen(false); }}>
              {showMarks ? t("隐藏标注", "Hide annotations") : t("显示标注", "Show annotations")}</button>
            <button onClick={() => requestLeave({ kind: "choose" })}><Icon name="pdf" />{t("打开其他文件", "Open another file")}</button>
            <button onClick={() => requestLeave({ kind: "library" })}><Icon name="library" />{t("资料库", "Library")}</button>
          </div>}
        </div>
      </nav> : <header className="pdf-header">
        <div className="pdf-brand"><Icon name="pdf" /><strong>Web Ink <span>PDF</span></strong></div>
        {handoffToken && <button className="quiet" disabled={!handoffReady || leaving} onClick={() => requestLeave(backAction)}>{backLabel}</button>}
        <button className="quiet icon-button" aria-label={t("资料库", "Library")} title={t("资料库", "Library")}
          onClick={() => requestLeave({ kind: "library" })}><Icon name="library" /></button>
      </header>}
      {error && <div className="pdf-message error" role="alert">
        <span>{error}</span>
        {!opened && <p>{t("无法直接读取？下载 PDF 后，点击「选择本地 PDF」继续。", "Can't open the link? Download the PDF, then choose the local file.")}</p>}
        {unsaved ? <>
          <button disabled={saving} onClick={() => void save(unsaved, noteAfterSave.current).catch(() => undefined)}>{t("重试保存", "Retry save")}</button>
          <button disabled={saving} onClick={() => { unsavedRef.current = undefined; setUnsaved(undefined); setSelection(undefined); getSelection()?.removeAllRanges(); setError(""); }}>
            {t("放弃本次修改", "Discard change")}</button>
        </> : <button onClick={() => setError("")}>{t("关闭", "Dismiss")}</button>}
      </div>}
      {positionError && <div className="pdf-message error" role="status"><span>{positionError}</span>
        <button onClick={() => void flushPosition()}>{t("重试保存阅读位置", "Retry reading position")}</button>
        <button onClick={() => setPositionError("")}>{t("关闭", "Dismiss")}</button></div>}
      {notice && <div className="pdf-message" role="status">{notice}</div>}
      {!notice && handoffToken && handoffReady && !handoff && <div className="pdf-message" role="status">
        <span>{t("暂时无法返回原阅读器。", "The original reader is unavailable.")}</span>
        <button onClick={() => requestLeave(backAction)}>{backLabel}</button>
      </div>}
      {opened ? <>
        {selection && <div className="pdf-selection" ref={selectionBar} style={selectionStyle} role="toolbar" aria-label={t("选中文字高亮", "Highlight selected text")}>
          {COLORS.map((chosen) => <button className="pdf-swatch" key={chosen} aria-label={`${t("高亮", "Highlight")} ${chosen}`}
            title={`${t("高亮", "Highlight")} ${chosen}`} style={{ background: chosen }} disabled={locked}
            onPointerDown={(event) => event.preventDefault()} onClick={() => mark(selection.target, "pdf-text", chosen)} />)}
          <button disabled={locked} onPointerDown={(event) => event.preventDefault()}
            onClick={() => { openNotes(); mark(selection.target, "pdf-text", color, true); }}><Icon name="note" />{t("添加笔记", "Add note")}</button>
          <button disabled={saving} onClick={() => { setSelection(undefined); getSelection()?.removeAllRanges(); }}>{t("取消", "Cancel")}</button>
        </div>}
        {picked && showMarks && <div className="pdf-mark-menu" role="status">
          <span>{picked.kind === "pdf-text" ? t("文字标注", "Text annotation") : t("区域标注", "Area annotation")}</span>
          <button disabled={locked} onClick={() => void remove(picked)}>{t("取消标注", "Remove annotation")}</button>
          <button onClick={() => setPicked(undefined)}>{t("关闭", "Close")}</button>
        </div>}
        {undoRecord && <div className="pdf-undo" role="status"><span>{t("标注已移除。", "Annotation removed.")}</span>
          <button disabled={locked} onClick={() => void restoreRemoved()}>{t("撤销移除", "Undo remove")}</button>
          <button disabled={removing} onClick={() => setUndoRecord(undefined)}>{t("关闭", "Close")}</button>
        </div>}
        <div className={`pdf-workspace${inlineNotes ? " notes-open" : ""}`}>
          <div className="pdf-pages" tabIndex={0} ref={container} aria-label={t("PDF 页面", "PDF pages")}
            onWheelCapture={userIntent} onPointerDownCapture={userIntent}
            onKeyDownCapture={(event) => { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) userIntent(); }}>
            <div aria-hidden="true" style={{ height: layoutIndex.current.offsetBefore(pageWindow.start + 1) }} />
            {Array.from({ length: Math.min(pageWindow.end, opened.document.numPages) - pageWindow.start }, (_, index) => index + pageWindow.start + 1).map((number) => (
              <div className="pdf-slot" data-page={number} key={`${opened.hash}-${number}`} style={{
                width: dimensions.current.get(number)?.width || (rotation % 180 ? 792 : 612) * zoom,
                height: dimensions.current.get(number)?.height || (rotation % 180 ? 612 : 792) * zoom,
              }}>
                <PdfPage language={settings.language} opened={opened} number={number} zoom={zoom} rotation={rotation} records={showMarks ? recordsByPage.get(number) ?? [] : []}
                  searchRanges={searchMatch?.pageNumber === number ? searchMatch.itemRanges : undefined}
                  onSearchPosition={(top) => {
                    const pending = pendingSearchPosition.current;
                    const scroller = container.current;
                    if (!pending || pending.pageNumber !== number || pending.intent !== intentEpoch.current || !scroller) return;
                    pendingSearchPosition.current = undefined;
                    const start = layoutIndex.current.offsetBefore(number) + pagesPadding();
                    scroller.scrollTo({ top: Math.max(start, start + top - scroller.clientHeight / 4), behavior: "instant" });
                  }}
                  area={area && !locked} color={color} measurementGeneration={measurementGeneration}
                  onSelection={(next) => { if (!unsavedRef.current && !annotationWrites.current.size) { setSelection(next); setPicked(undefined); } }}
                  onPick={(record) => { setPicked(record); if (!unsavedRef.current) setSelection(undefined); }}
                  onArea={(target) => mark(target, "pdf-area")}
                  onDimensions={(generation, width, height) => onPageDimensions(number, generation, width, height)}
                  onError={(message) => { if (documentSession === documentSessionRef.current) setError(message); }} />
              </div>
            ))}
            <div aria-hidden="true" style={{ height: Math.max(0, layoutIndex.current.totalHeight() - layoutIndex.current.offsetBefore(Math.min(pageWindow.end, opened.document.numPages) + 1)) }} />
          </div>
          <aside className="pdf-notes" id="pdf-notes" ref={notesRail} aria-label={t("本篇笔记", "Document notes")} hidden={!inlineNotes}>
            <div className="pdf-notes-header"><h2>{t("本篇标注", "Annotations")} <span>{records.length}</span></h2>
              <button className="quiet icon-button" aria-label={t("关闭笔记", "Close notes")} onClick={() => setNotesOpen(false)}><Icon name="close" /></button></div>
            {!records.length && <p className="pdf-muted">{t("选中文字后选择颜色保存高亮，或用「区域标注」框选图表。", "Select text and choose a color to save it, or use Mark area for a figure.")}</p>}
            {[...deletedDrafts.map((draft) => draft.base), ...sortedNotes.slice(0, notesLimit)].map((record) => <PdfNote key={record.id} record={record} language={settings.language}
              onJump={() => jump(record.target.pageNumber)} onSave={(draft) => saveNote(record.id, draft)} onRemove={remove}
              removing={removing} saving={noteSaving === record.id} conflict={noteConflicts[record.id] === true}
              locked={leaving || guardSaving || writeCount > 0 || !!unsaved} draft={noteDrafts[record.id]}
              deleted={!savedIds.has(record.id)}
              onDraft={(draft, resolveConflict) => updateDraft(record.id, draft, resolveConflict)} onClearDraft={() => updateDraft(record.id)} />)}
            {notesLimit < sortedNotes.length && <button onClick={() => setNotesLimit((limit) => limit + 50)}>{t("加载更多", "Load more")}</button>}
          </aside>
        </div>
      </> : <section className="pdf-welcome" aria-busy={busy}>
        <span className="pdf-welcome-icon" aria-hidden="true"><Icon name="pdf" /></span>
        <h1>{busy ? t("正在打开 PDF…", "Opening PDF…") : t("选择 PDF", "Choose a PDF")}</h1>
        <p>{t("选择本地文件，或打开公开 PDF 网址。标注保存在本机，原文件不会存入资料库。", "Choose a local file or public PDF URL. Annotations stay on this device; the PDF is not stored in your library.")}</p>
        {sourceControls}
        <p className="pdf-muted">{t("单份文件最多 50 MiB。登录网站的 PDF 请下载后选择本地文件；扫描件可做区域标注。", "Up to 50 MiB per file. Download authenticated PDFs first. Scanned documents support area annotations.")}</p>
        {currentParams.has("document") && !publicUrl && <p role="status">{t("重新选择原来的 PDF，即可恢复标注与阅读位置。", "Choose the original PDF again to restore annotations and reading position.")}</p>}
      </section>}
      {sourceOpen && <div className="pdf-dialog-backdrop"><section className="pdf-dialog" role="dialog" aria-modal="true"
        aria-label={t("打开其他 PDF", "Open another PDF")} onKeyDown={dialogKeys}>
        <h2>{t("打开其他 PDF", "Open another PDF")}</h2><p>{t("标注保留在本机；原文件不会存入资料库。", "Annotations stay on this device; PDF files are not stored in your library.")}</p>
        {sourceControls}<button autoFocus onClick={() => setSourceOpen(false)}>{t("继续阅读", "Keep reading")}</button>
      </section></div>}
      {pendingLeave && <div className="pdf-dialog-backdrop"><section className="pdf-dialog" role="dialog" aria-modal="true"
        aria-label={t("未保存的内容", "Unsaved changes")} onKeyDown={dialogKeys}>
        <h2>{t("未保存的内容", "Unsaved changes")}</h2><p>{t("保存或放弃当前草稿后继续，也可以留在这里编辑。", "Save or discard the current draft to continue, or keep editing here.")}</p>
        {error && <p role="alert">{error}</p>}
        <div className="pdf-dialog-actions">
          <button disabled={guardSaving || leaving} onClick={() => void saveAndContinue()}>{guardSaving ? t("正在保存…", "Saving…") : t("保存并继续", "Save and continue")}</button>
          <button disabled={guardSaving || leaving || writeCount > 0} onClick={discardAndContinue}>{t("放弃并继续", "Discard and continue")}</button>
          <button autoFocus disabled={guardSaving || leaving} onClick={keepEditing}>{t("继续编辑", "Keep editing")}</button>
        </div>
      </section></div>}
    </main>
  );
}
