/** PDF logic exposed to the extension UI. */
export {
  ieeeFailureMessage,
  formatIeeeDiagnostic,
  pdfPreparationLabel,
  type IeeePdfDiagnostic,
} from "../core/ieee-contract";
export { ieeeSourceUrl } from "./ieee";
export { doiUrl, readPdfPaperIdentity, rememberPdfPaperReopen, type PdfPaperIdentity } from "./paper-identity";
export { connectPdfSidebar } from "./sidebar-connection";
