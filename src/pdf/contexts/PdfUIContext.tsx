import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Language } from "../../core/model";

type PdfUI = { language: Language; t: (cn: string, en: string) => string };
const PdfUIContext = createContext<PdfUI | undefined>(undefined);
export function PdfUIProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo(() => ({ language, t: (cn: string, en: string) => language === "zh-CN" ? cn : en }), [language]);
  return <PdfUIContext.Provider value={value}>{children}</PdfUIContext.Provider>;
}
export function usePdfUI() {
  const value = useContext(PdfUIContext);
  if (!value) throw Error("PDF UI provider is missing");
  return value;
}
