import { PAGE_THEME_CSS } from "./theme";

/** Installs the shared design tokens once per extension page. */
export function installPageTheme(): void {
  if (document.head.querySelector("style[data-ink-theme]")) return;
  const style = document.createElement("style");
  style.dataset.inkTheme = "true";
  style.textContent = PAGE_THEME_CSS;
  document.head.prepend(style);
}

/** Resolves "system" through CSS so the page follows OS changes live. */
export function applyPageTheme(theme: "system" | "light" | "dark" | undefined): void {
  document.documentElement.dataset.theme = theme ?? "system";
}
