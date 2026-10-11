import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { NativePdfAnnotations } from "./native-annotations";
import type {
  PdfTextAnnotation,
  PdfAreaAnnotation,
  PdfRect,
} from "../core/model";
export type PdfAnnotation = PdfTextAnnotation | PdfAreaAnnotation;
export type NativePdfAnnotationReply = {
  id: string;
  subtype: string;
  contents: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  inReplyTo?: string;
  replyType?: string;
};
/** Read-only PDF metadata, scoped to the current document session. */
export type NativePdfAnnotation = NativePdfAnnotationReply & {
  key: string;
  documentHash: string;
  pageNumber: number;
  rect?: number[];
  color?: number[];
  replies?: NativePdfAnnotationReply[];
};
export type PdfApi = typeof import("pdfjs-dist");
export type SelectionTarget = {
  pageNumber: number;
  rects: PdfRect[];
  exact: string;
  prefix: string;
  suffix: string;
};
/** Transient viewport placement stays outside the durable PDF target. */
export type SelectionPreview = {
  target: SelectionTarget;
  anchor: { left: number; top: number; right: number; bottom: number };
};
export type OpenDocument = {
  document: PDFDocumentProxy;
  api: PdfApi;
  hash: string;
  fileName: string;
  sourceUrl?: string;
  nativeAnnotations?: NativePdfAnnotations;
};

export const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
