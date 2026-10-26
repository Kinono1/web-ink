import { type PdfNoteDraft } from "../PdfNote";
import { type PdfAnnotation } from "../types";
import { type Annotation } from "../../core/model";
import { pdfSourceUrl } from "../source";
import { ieeeSourceUrl } from "../ieee";
import { type PdfReadingPosition, type PdfReadingPositionWriter } from "../reading-position";
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
export type PositionSession = {
  session: number;
  hash: string;
  writer: PdfReadingPositionWriter;
  readReady: boolean;
  intent: number;
  pending?: PdfReadingPosition;
};
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
