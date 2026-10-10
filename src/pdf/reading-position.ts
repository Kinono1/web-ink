import { PageLayoutIndex } from "./layout";

const READING_POSITION_PREFIX = "ui.pdfReadingPosition.";
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
export const PDF_MIN_ZOOM = 0.1;
export const PDF_MAX_ZOOM = 5;

export type PdfRotation = 0 | 90 | 180 | 270;

export type PdfReadingPosition = {
  version: 1;
  pageNumber: number;
  pageOffsetRatio: number;
  zoom: number;
  rotation: PdfRotation;
};

export type PdfReadingPositionWriter = {
  save: (snapshot: PdfReadingPosition) => void;
  flush: () => Promise<void>;
  dispose: () => void;
};

function storageKey(documentHash: string): string | undefined {
  if (!HASH_PATTERN.test(documentHash)) return undefined;
  return `${READING_POSITION_PREFIX}${documentHash.toLowerCase()}`;
}

function isRotation(value: unknown): value is PdfRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function isFiniteRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isReadingPosition(value: unknown): value is PdfReadingPosition {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.pageNumber === "number" &&
    Number.isSafeInteger(record.pageNumber) &&
    record.pageNumber >= 1 &&
    isFiniteRatio(record.pageOffsetRatio) &&
    typeof record.zoom === "number" &&
    Number.isFinite(record.zoom) &&
    record.zoom >= PDF_MIN_ZOOM &&
    record.zoom <= PDF_MAX_ZOOM &&
    isRotation(record.rotation)
  );
}

function copyPosition(position: PdfReadingPosition): PdfReadingPosition {
  return { ...position };
}

export async function readPdfReadingPosition(
  documentHash: string,
): Promise<PdfReadingPosition | undefined> {
  const key = storageKey(documentHash);
  if (!key) return undefined;

  try {
    const values = await chrome.storage.local.get(key);
    const value = values[key];
    return isReadingPosition(value) ? copyPosition(value) : undefined;
  } catch {
    return undefined;
  }
}

export function capturePdfReadingPosition(
  layout: PageLayoutIndex,
  scrollTop: number,
  zoom: number,
  rotation: PdfRotation,
): PdfReadingPosition | undefined {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(zoom) || !isRotation(rotation))
    return undefined;

  const pageNumber = layout.pageAt(scrollTop);
  const pageHeight = layout.pageHeight(pageNumber);
  if (pageHeight === undefined) return undefined;

  const relative = scrollTop - layout.offsetBefore(pageNumber);
  const pageOffsetRatio = pageHeight > 0
    ? Math.max(0, Math.min(1, relative / pageHeight))
    : 0;
  const position = {
    version: 1 as const,
    pageNumber,
    pageOffsetRatio,
    zoom,
    rotation,
  };
  return isReadingPosition(position) ? position : undefined;
}

export function restorePdfReadingPosition(
  layout: PageLayoutIndex,
  position: unknown,
): number | undefined {
  if (!isReadingPosition(position)) return undefined;
  const pageHeight = layout.pageHeight(position.pageNumber);
  if (pageHeight === undefined) return undefined;

  const offset = layout.offsetBefore(position.pageNumber) + pageHeight * position.pageOffsetRatio;
  return Number.isFinite(offset) ? offset : undefined;
}

export function createPdfReadingPositionWriter(
  documentHash: string,
): PdfReadingPositionWriter {
  const key = storageKey(documentHash);
  if (!key) return noOpWriter();

  let disposed = false;
  let writing = false;
  let pending: PdfReadingPosition | undefined;
  let pendingReady = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWriteFailed = false;
  let lastFailure: unknown;
  const waiters: Array<{ resolve: () => void; reject: (cause: unknown) => void }> = [];

  const settleFlushes = (): void => {
    if (writing || pending || timer) return;
    const currentWaiters = waiters.splice(0);
    for (const waiter of currentWaiters) {
      if (!lastWriteFailed) waiter.resolve();
      else waiter.reject(lastFailure);
    }
  };

  const finishWrite = (succeeded: boolean, failure?: unknown): void => {
    writing = false;
    lastWriteFailed = !succeeded;
    lastFailure = failure;

    if (!disposed && pending && pendingReady) {
      startWrite();
      return;
    }
    settleFlushes();
  };

  const startWrite = (): void => {
    const snapshot = pending;
    pending = undefined;
    pendingReady = false;
    if (!snapshot) {
      settleFlushes();
      return;
    }

    writing = true;
    let result: Promise<void>;
    try {
      result = chrome.storage.local.set({ [key]: snapshot });
    } catch (cause) {
      finishWrite(false, cause);
      return;
    }
    void Promise.resolve(result).then(
      () => finishWrite(true),
      (cause: unknown) => finishWrite(false, cause),
    );
  };

  const scheduleWrite = (): void => {
    if (timer) clearTimeout(timer);
    pendingReady = false;
    timer = setTimeout(() => {
      timer = undefined;
      pendingReady = true;
      if (!writing) startWrite();
    }, 500);
  };

  return {
    save(snapshot) {
      if (disposed || !isReadingPosition(snapshot)) return;
      pending = copyPosition(snapshot);
      scheduleWrite();
    },
    flush() {
      if (pending) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        pendingReady = true;
        if (!writing) startWrite();
      }

      const flushed = new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        settleFlushes();
      });
      // Callers that intentionally ignore flush() must not create an unhandled
      // rejection if a browser storage write fails.
      void flushed.catch(() => undefined);
      return flushed;
    },
    dispose() {
      disposed = true;
      pending = undefined;
      pendingReady = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      settleFlushes();
    },
  };
}

function noOpWriter(): PdfReadingPositionWriter {
  return {
    save: () => undefined,
    flush: async () => undefined,
    dispose: () => undefined,
  };
}
