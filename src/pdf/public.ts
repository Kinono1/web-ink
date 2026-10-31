/**
 * Public facade for the PDF logic layer consumed by UIs.
 *
 * UI code imports PDF logic through this module only, so it does not reach
 * into individual logic modules. Logic modules stay free to move or split
 * behind these re-exports.
 */
export {
  ieeeFailureMessage,
  formatIeeeDiagnostic,
  pdfPreparationLabel,
} from "../core/ieee-contract";
export type { IeeePdfDiagnostic } from "../core/ieee-contract";
export { ieeeSourceUrl } from "./ieee";
export { doiUrl, readPdfPaperIdentity } from "./paper-identity";
export type { PdfPaperIdentity } from "./paper-identity";
export { rememberPdfPaperReopen } from "./paper-identity";
export { connectPdfSidebar } from "./sidebar-connection";