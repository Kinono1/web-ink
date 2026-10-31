import type { Language } from "../../core/model";

/** One bilingual label helper for the PDF views that render outside the provider. */
export const textFor =
  (language: Language) =>
  (zh: string, en: string): string =>
    language === "zh-CN" ? zh : en;
