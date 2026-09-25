/**
 * Presentation-only tokens shared by extension React pages and the content
 * Shadow DOM.  This module deliberately has no React, browser, or DOM imports.
 */
export const THEME_TOKENS = {
  light: {
    "--ink-bg": "#f5f5f7",
    "--ink-panel": "#ffffff",
    "--ink-surface": "rgba(255,255,255,.82)",
    "--ink-surface-solid": "#ffffff",
    "--ink-text": "#1d1d1f",
    "--ink-secondary": "#6e6e73",
    "--ink-tertiary": "#8e8e93",
    "--ink-separator": "rgba(60,60,67,.18)",
    "--ink-fill": "rgba(118,118,128,.12)",
    "--ink-fill-hover": "rgba(118,118,128,.2)",
    "--ink-accent": "#0066cc",
    "--ink-accent-fill": "rgba(10,132,255,.14)",
    "--ink-danger": "#d70015",
    "--ink-warning": "#9b5b00",
    "--ink-warning-fill": "#fff7df",
    "--ink-success": "#16803c",
    "--ink-shadow": "0 10px 30px rgba(0,0,0,.10)",
    "--ink-radius": "12px",
  },
  dark: {
    "--ink-bg": "#1c1c1e",
    "--ink-panel": "#1c1c1e",
    "--ink-surface": "rgba(44,44,46,.82)",
    "--ink-surface-solid": "#2c2c2e",
    "--ink-text": "#f5f5f7",
    "--ink-secondary": "#aeaeb2",
    "--ink-tertiary": "#8e8e93",
    "--ink-separator": "rgba(235,235,245,.18)",
    "--ink-fill": "rgba(118,118,128,.24)",
    "--ink-fill-hover": "rgba(118,118,128,.34)",
    "--ink-accent": "#0a84ff",
    "--ink-accent-fill": "rgba(10,132,255,.25)",
    "--ink-danger": "#ff6961",
    "--ink-warning": "#ffd60a",
    "--ink-warning-fill": "#4b3c00",
    "--ink-success": "#30d158",
    "--ink-shadow": "0 10px 30px rgba(0,0,0,.32)",
    "--ink-radius": "12px",
  },
} as const;

export type ThemeName = keyof typeof THEME_TOKENS;

/**
 * Theme-independent scale. Every surface draws from these steps only:
 * two families, four sizes and, with --ink-radius, three corner radii.
 * Quotes use the serif so what you read stands apart from the tool around it.
 */
export const SCALE_TOKENS = {
  "--ink-font":
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  "--ink-font-serif":
    '"New York", "Iowan Old Style", Charter, Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "Microsoft YaHei", serif',
  "--ink-size-meta": "12px",
  "--ink-size-body": "13px",
  "--ink-size-title": "15px",
  "--ink-size-display": "20px",
  "--ink-radius-control": "6px",
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
