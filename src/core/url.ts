/**
 * Query parameters that only identify a campaign, click or analytics session.
 * They never select page content, so dropping them lets the same article match
 * however it was reached, and keeps click IDs out of the library and backups.
 */
const TRACKING_PARAMETER =
  /^(?:utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|ttclid|_ga|_gl|_hsenc|_hsmi|mkt_tok)$/i;

function parameterName(part: string): string {
  const raw = part.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** Remove tracking parameters while keeping every other parameter byte-for-byte. */
function withoutTracking(search: string): string {
  if (search.length <= 1) return search;
  const parts = search.slice(1).split("&");
  const kept = parts.filter((part) => !TRACKING_PARAMETER.test(parameterName(part)));
  if (kept.length === parts.length) return search;
  return kept.some((part) => part.length > 0) ? `?${kept.join("&")}` : "";
}

/**
 * Keep content-bearing query parameters and hash routes. Ignore ordinary heading
 * anchors and known tracking parameters.
 */
export function pageKey(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported page protocol");
  if (!url.hash.startsWith("#/") && !url.hash.startsWith("#!")) url.hash = "";
  const search = withoutTracking(url.search);
  if (search !== url.search) url.search = search;
  return url.href;
}

export function isWebPage(raw?: string): boolean {
  try {
    return !!raw && ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}
