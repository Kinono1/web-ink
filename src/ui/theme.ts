/**
 * Presentation-only tokens shared by extension React pages and the content
 * Shadow DOM.  This module deliberately has no React, browser, or DOM imports.
 */
export const THEME_TOKENS = {
  light: {
    "--ink-bg": "#f6f7f9",
    "--ink-panel": "#ffffff",
    "--ink-surface": "#ffffff",
    "--ink-surface-solid": "#ffffff",
    "--ink-text": "#18181b",
    "--ink-secondary": "#52525b",
    "--ink-tertiary": "#71717a",
    "--ink-separator": "#e4e4e7",
    "--ink-fill": "#eef0f4",
    "--ink-fill-hover": "#e4e4e7",
    "--ink-accent": "#2563eb",
    "--ink-accent-fill": "#dbeafe",
    "--ink-primary": "#27272a",
    "--ink-primary-text": "#ffffff",
    "--ink-danger": "#b42318",
    "--ink-warning": "#9b5b00",
    "--ink-warning-fill": "#fff7df",
    "--ink-success": "#16803c",
    "--ink-shadow": "0 10px 30px rgba(0,0,0,.10)",
  },
  dark: {
    "--ink-bg": "#111318",
    "--ink-panel": "#191c23",
    "--ink-surface": "#191c23",
    "--ink-surface-solid": "#191c23",
    "--ink-text": "#f4f4f5",
    "--ink-secondary": "#a1a1aa",
    "--ink-tertiary": "#a1a1aa",
    "--ink-separator": "#2b303b",
    "--ink-fill": "#252a34",
    "--ink-fill-hover": "#2b303b",
    "--ink-accent": "#60a5fa",
    "--ink-accent-fill": "#1e3a5f",
    "--ink-primary": "#f4f4f5",
    "--ink-primary-text": "#18181b",
    "--ink-danger": "#fda4af",
    "--ink-warning": "#facc15",
    "--ink-warning-fill": "#4b3c00",
    "--ink-success": "#86efac",
    "--ink-shadow": "0 10px 30px rgba(0,0,0,.32)",
  },
} as const;

export type ThemeName = keyof typeof THEME_TOKENS;

/**
 * Theme-independent scale. Every surface draws from these steps only:
 * System families, four sizes, a 36px minimum touch target, and shared
 * control/surface radii keep extension pages and content UI aligned.
 */
export const SCALE_TOKENS = {
  "--ink-font":
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  "--ink-font-serif":
    '"New York", "Iowan Old Style", Charter, Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "Microsoft YaHei", serif',
  "--ink-size-meta": "12px",
  "--ink-size-body": "14px",
  "--ink-size-title": "16px",
  "--ink-size-display": "22px",
  "--ink-control-min-height": "36px",
  "--ink-radius-control": "8px",
  "--ink-radius": "12px",
  "--ink-motion-fast": "120ms",
} as const;

const declarations = (tokens: Readonly<Record<string, string>>) =>
  Object.entries(tokens)
    .map(([key, value]) => `${key}:${value};`)
    .join("");

/** Safe to embed verbatim in a content-script ShadowRoot stylesheet. */
export const CONTENT_THEME_CSS = `
:host { color-scheme: light dark; ${declarations(SCALE_TOKENS)} }
:host, :host([data-web-ink-theme="light"]) { ${declarations(THEME_TOKENS.light)} }
@media (prefers-color-scheme: dark) { :host:not([data-web-ink-theme="light"]) { ${declarations(THEME_TOKENS.dark)} } }
:host([data-web-ink-theme="dark"]) { ${declarations(THEME_TOKENS.dark)} }
`;

/**
 * Extension pages keep tokens on :root, so the body, popovers and every
 * surface resolve the same values. Pages set <html data-theme> from settings.
 */
export const PAGE_THEME_CSS = `
:root { color-scheme: light; ${declarations(SCALE_TOKENS)}${declarations(THEME_TOKENS.light)} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${declarations(THEME_TOKENS.dark)} } }
:root[data-theme="dark"] { color-scheme: dark; ${declarations(THEME_TOKENS.dark)} }
`;
