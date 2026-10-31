import { createContext, useContext } from "react";
import type { OpenDocument } from "../../core/pdf-types";

// Only document identity is shared. Scroll/layout epochs remain local to the reader.
export const PdfDocumentContext = createContext<OpenDocument | undefined>(undefined);
export function usePdfDocument() {
  return useContext(PdfDocumentContext);
}
