/** Keep content-bearing query parameters and hash routes. Ignore ordinary heading anchors. */
export function pageKey(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported page protocol");
  if (!url.hash.startsWith("#/") && !url.hash.startsWith("#!")) url.hash = "";
  return url.href;
}
export function isWebPage(raw?: string): boolean {
  try {
    return !!raw && ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}
