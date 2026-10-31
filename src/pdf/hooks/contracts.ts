import { type AnnotationPreset } from "../../core/annotation-presets";
import type { PdfNoteDraft } from "../../core/sidebar";
import type { PdfAnnotationFilter } from "../../core/sidebar";
import { type PdfAnnotation, type NativePdfAnnotation, type SelectionTarget } from "../../core/pdf-types";
import { type Annotation, type PdfHandoff } from "../../core/model";
import { pdfSourceUrl } from "../../core/pdf-source";
import { ieeeSourceUrl } from "../ieee";
import { type PdfReadingPosition, type PdfReadingPositionWriter, type PdfRotation, } from "../reading-position";
import type { useDocumentSessionState } from "./useDocumentSession";
import type { useViewportState } from "./useViewport";
import type { useAnnotationsState } from "./useAnnotations";
import type { useNativeAnnotationsState } from "./useNativeAnnotations";
import type { useExportState } from "./useExport";
import type { useNotificationsState, useReaderUIState, useReaderDerived } from "./useReaderUI";
import type { useSidebarSyncState } from "./useSidebarSync";
import type { useLeaveGuardState } from "./useLeaveGuard";
export type ReaderState = ReturnType<typeof useDocumentSessionState> &
  ReturnType<typeof useViewportState> &
  ReturnType<typeof useAnnotationsState> &
  ReturnType<typeof useNativeAnnotationsState> &
  ReturnType<typeof useExportState> &
  ReturnType<typeof useReaderUIState> &
  ReturnType<typeof useSidebarSyncState> &
  ReturnType<typeof useLeaveGuardState> &
  ReturnType<typeof useNotificationsState>;
export type ReaderSnapshot = ReaderState & ReturnType<typeof useReaderDerived>;
export interface ReaderActions {
  claimIeeeGrant(): Promise<PdfHandoff>; loadPdf(file?: File, automatic?: boolean, chosenSource?: string, siteSession?: boolean): Promise<void>; userIntent(): void; pagesPadding(): number;
  currentPosition(): PdfReadingPosition | undefined; savePosition(): void; flushPosition():
    Promise<void>; onPageDimensions(page: number, generation: number, width: number, height: number): void; jump(n: number): void;
  applyView(nextZoom: number, nextRotation?: PdfRotation): void; changeZoom(delta: number): void; commitZoom(raw:
    string): void; updateRecords(next: PdfAnnotation[] | ((current: PdfAnnotation[]) => PdfAnnotation[])): void;
  updateDraft(id: string, draft?: PdfNoteDraft, resolveConflict?: boolean): void; trackWrite<T>(operation: () => Promise<T>): Promise<T>; refresh(): Promise<void>;
  save(record: PdfAnnotation, editNote?: boolean): Promise<PdfAnnotation>; saveNote(id: string, draft:
    PdfNoteDraft): Promise<void>; remove(record: PdfAnnotation): Promise<void>; restoreRemoved(): Promise<void>;
  mark(target: SelectionTarget, kind: "pdf-text" | "pdf-area", chosen?: string, editNote?: boolean, tags?
    : string[]): void; receiveOriginalNotes(next: NativePdfAnnotation[]): void; cancelNativeScan(): void;
  scanOriginalNotes(): Promise<void>; filterAnnotations(filter: PdfAnnotationFilter): void; nextOriginalPage():
    void; previousOriginalPage(): void; focusOriginalNote(record: NativePdfAnnotation): Promise<void>;
  download(blob: Blob, fileName: string): void; cancelExport(): void; exportAnnotations(kind: "export" | "ai"):
    Promise<void>; cancelFocusAttempt(): void; openNotes(): void; enterFocus(): Promise<void>; exitFocus(): void;
  choosePreset(preset: AnnotationPreset): boolean; dialogKeys(event: React.KeyboardEvent<HTMLElement>): void; executeLeave(action: LeaveAction): Promise<void>; requestLeave(action: LeaveAction): void;
  saveAndContinue(): Promise<void>; discardAndContinue(): void; keepEditing(): void; tell(message: string): void;
}
export type ReaderActionsRef<K extends keyof ReaderActions = keyof ReaderActions> =
  React.RefObject<Pick<ReaderActions, K>>;

export const isPdf = (record: Annotation): record is PdfAnnotation =>
  record.kind === "pdf-text" || record.kind === "pdf-area";
export const noteTags = (value: string) => [
  ...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean)),
];
export const dirtyDraft = (draft: PdfNoteDraft) =>
  draft.note !== draft.base.note ||
  draft.color !== draft.base.color ||
  noteTags(draft.tags).join("\0") !== draft.base.tags.join("\0");
export type LeaveAction =
  | { kind: "return" | "source" | "paper" | "library" | "previous" | "choose" | "export" | "ai" }
  | { kind: "open"; file?: File; source: string };
export type PositionSession = { session: number; hash: string; writer: PdfReadingPositionWriter; readReady: boolean; intent: number; pending?: PdfReadingPosition; };
export function safeSource(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return pdfSourceUrl(raw).href;
  } catch {
    return undefined;
  }
}
export function ieeeRecordSource(raw: string): string {
  const page = ieeeSourceUrl(raw);
  const article = page.searchParams.get("arnumber");
  page.search = "";
  if (page.pathname.toLowerCase() === "/stamp/stamp.jsp" && article && /^\d+$/.test(article)) page.searchParams.set("arnumber", article);
  return page.href;
}