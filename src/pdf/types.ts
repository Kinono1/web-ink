import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type {
  PdfTextAnnotation,
  PdfAreaAnnotation,
  PdfRect,
} from "../core/model";
export type PdfAnnotation = PdfTextAnnotation | PdfAreaAnnotation;
export type PdfApi = typeof import("pdfjs-dist");
export type SelectionTarget = {
  pageNumber: number;
  rects: PdfRect[];
  exact: string;
  prefix: string;
  suffix: string;
};
export type OpenDocument = {
  document: PDFDocumentProxy;
  api: PdfApi;
  hash: string;
  fileName: string;
  sourceUrl?: string;
};

export const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
