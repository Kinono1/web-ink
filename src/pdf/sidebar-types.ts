import type { PdfNoteDraft } from "./PdfNote";
import type { PdfAnnotation } from "./types";

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
};

export type PdfSidebarCommand =
  | { type: "focus"; id: string }
  | { type: "draft"; id: string; draft?: PdfNoteDraft; resolveConflict?: boolean }
  | { type: "save"; id: string }
  | { type: "remove"; id: string }
  | { type: "undo" }
  | { type: "more" };

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
export type PdfSidebarMessage =
  | { type: "watch"; tabId: number | undefined }
  | PdfSidebarCommandMessage;
export type PdfSidebarUpdate = PdfReaderStateMessage | { type: "unavailable" };
export type PdfReaderRequest =
  | PdfSidebarCommandMessage
  | { type: "attached"; attached: boolean };
