import type { NativePdfAnnotation, PdfAnnotation } from "./pdf-types";

export type PdfNoteDraft = {
  note: string;
  tags: string;
  color: string;
  base: PdfAnnotation;
  editing: boolean;
};

export type PdfAnnotationFilter = "all" | "web-ink" | "original";

/** A live reader snapshot; the broker never persists it. */
export type PdfSidebarState = {
  pageUrl: string;
  sessionId: string;
  fileName: string;
  records: PdfAnnotation[];
  totalCount: number;
  drafts: Record<string, PdfNoteDraft>;
  conflicts: Record<string, boolean>;
  locked: boolean;
  noteSaving?: string;
  removing: boolean;
  undoRecord?: PdfAnnotation;
  error?: string;
  notice?: string;
  nativeFilter?: PdfAnnotationFilter;
  nativeRecords?: NativePdfAnnotation[];
  nativeTotalCount?: number;
  nativeOffset?: number;
  nativeLimit?: number;
  nativePageEnd?: number;
  nativeLoading?: boolean;
  nativeProgress?: { completed: number; total: number };
  nativeError?: string;
};

export type PdfSidebarCommand = | { type: "focus"; id: string }
  | { type: "draft"; id: string; draft?: PdfNoteDraft; resolveConflict?: boolean }
  | { type: "save"; id: string }
  | { type: "remove"; id: string }
  | { type: "undo" }
  | { type: "more" }
  | { type: "filter"; filter: PdfAnnotationFilter }
  | { type: "focus-native"; key: string }
  | { type: "cancel-native" }
  | { type: "more-native" }
  | { type: "previous-native" };

export type PdfReaderStateMessage = {
  type: "state";
  state: PdfSidebarState | null;
  ack?: string;
};
export type PdfSidebarCommandMessage = {
  type: "command";
  commandId: string;
  pageUrl: string;
  sessionId: string;
  command: PdfSidebarCommand;
};
export type PdfSidebarUpdate = PdfReaderStateMessage | { type: "unavailable" };
export type PdfReaderRequest = | PdfSidebarCommandMessage
  | { type: "attached"; attached: boolean };
