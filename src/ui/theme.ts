/**
 * Presentation-only tokens shared by extension React pages and the content
 * Shadow DOM.  This module deliberately has no React, browser, or DOM imports.
 */
export const THEME_TOKENS = {
  light: {
    "--ink-bg": "#f5f5f7",
    "--ink-surface": "rgba(255,255,255,.82)",
    "--ink-surface-solid": "#ffffff",
    "--ink-text": "#1d1d1f",
    "--ink-secondary": "#6e6e73",
    "--ink-tertiary": "#8e8e93",
    "--ink-separator": "rgba(60,60,67,.18)",
    "--ink-fill": "rgba(118,118,128,.12)",
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
    "--ink-surface": "rgba(44,44,46,.82)",
    "--ink-surface-solid": "#2c2c2e",
    "--ink-text": "#f5f5f7",
    "--ink-secondary": "#aeaeb2",
    "--ink-tertiary": "#8e8e93",
    "--ink-separator": "rgba(235,235,245,.18)",
    "--ink-fill": "rgba(118,118,128,.24)",
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

/** Safe to embed verbatim in a content-script ShadowRoot stylesheet. */
export const CONTENT_THEME_CSS = `
:host { color-scheme: light dark; }
:host, :host([data-web-ink-theme="light"]) { ${Object.entries(
  THEME_TOKENS.light,
)
  .map(([key, value]) => `${key}:${value};`)
  .join("")} }
@media (prefers-color-scheme: dark) { :host:not([data-web-ink-theme="light"]) { ${Object.entries(
  THEME_TOKENS.dark,
)
  .map(([key, value]) => `${key}:${value};`)
  .join("")} } }
:host([data-web-ink-theme="dark"]) { ${Object.entries(THEME_TOKENS.dark)
  .map(([key, value]) => `${key}:${value};`)
  .join("")} }
`;
