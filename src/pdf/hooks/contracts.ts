import { type AnnotationPreset } from "../../core/annotation-presets";
import { type PdfNoteDraft } from "../PdfNote";
import type { PdfAnnotationFilter } from "../sidebar-types";
import { type PdfAnnotation, type NativePdfAnnotation, type SelectionTarget } from "../types";
import { type PdfHandoff } from "../../core/model";
import { type PdfReadingPosition, type PdfRotation } from "../reading-position";
import { type LeaveAction } from "./reader-utils";
import type { useDocumentSessionState } from "./useDocumentSession";
import type { useViewportState } from "./useViewport";
import type { useAnnotationsState } from "./useAnnotations";
import type { useNativeAnnotationsState } from "./useNativeAnnotations";
import type { useExportState } from "./useExport";
import type { useReaderUIState } from "./useReaderUI";
import type { useSidebarSyncState } from "./useSidebarSync";
import type { useLeaveGuardState } from "./useLeaveGuard";
import type { useNotificationsState } from "./useNotifications";
import type { useReaderDerived } from "./useReaderDerived";
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
  claimIeeeGrant(): Promise<PdfHandoff>;
  loadPdf(file?: File, automatic?: boolean, chosenSource?: string, siteSession?: boolean): Promise<void>;
  userIntent(): void;
  pagesPadding(): number;
  currentPosition(): PdfReadingPosition | undefined;
  savePosition(): void;
  flushPosition(): Promise<void>;
  onPageDimensions(page: number, generation: number, width: number, height: number): void;
  jump(n: number): void;
  applyView(nextZoom: number, nextRotation?: PdfRotation): void;
  changeZoom(delta: number): void;
  commitZoom(raw: string): void;
  updateRecords(next: PdfAnnotation[] | ((current: PdfAnnotation[]) => PdfAnnotation[])): void;
  updateDraft(id: string, draft?: PdfNoteDraft, resolveConflict?: boolean): void;
  trackWrite<T>(operation: () => Promise<T>): Promise<T>;
  refresh(): Promise<void>;
  save(record: PdfAnnotation, editNote?: boolean): Promise<PdfAnnotation>;
  saveNote(id: string, draft: PdfNoteDraft): Promise<void>;
  remove(record: PdfAnnotation): Promise<void>;
  restoreRemoved(): Promise<void>;
  mark(target: SelectionTarget, kind: "pdf-text" | "pdf-area", chosen?: string, editNote?: boolean, tags?: string[]): void;
  receiveOriginalNotes(next: NativePdfAnnotation[]): void;
  cancelNativeScan(): void;
  scanOriginalNotes(): Promise<void>;
  filterAnnotations(filter: PdfAnnotationFilter): void;
  nextOriginalPage(): void;
  previousOriginalPage(): void;
  focusOriginalNote(record: NativePdfAnnotation): Promise<void>;
  download(blob: Blob, fileName: string): void;
  cancelExport(): void;
  exportAnnotations(kind: "export" | "ai"): Promise<void>;
  cancelFocusAttempt(): void;
  openNotes(): void;
  enterFocus(): Promise<void>;
  exitFocus(): void;
  choosePreset(preset: AnnotationPreset): boolean;
  dialogKeys(event: React.KeyboardEvent<HTMLElement>): void;
  executeLeave(action: LeaveAction): Promise<void>;
  requestLeave(action: LeaveAction): void;
  saveAndContinue(): Promise<void>;
  discardAndContinue(): void;
  keepEditing(): void;
  tell(message: string): void;
}
export type ReaderActionsRef<K extends keyof ReaderActions = keyof ReaderActions> =
  React.RefObject<Pick<ReaderActions, K>>;
