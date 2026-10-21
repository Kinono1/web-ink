import type { TextTarget } from "./model";

/** A linked reading root retains its destination in the existing CSS selector. */
export function textLinkUrl(
  target: Pick<TextTarget, "rootSelector">,
  pageUrl: string,
): string | undefined {
  const match = /^a\[href=("(?:[^"\\]|\\.)*")\]$/.exec(target.rootSelector);
  if (!match) return undefined;
  try {
    const href: unknown = JSON.parse(match[1]!);
    // JSON and CSS disagree on escapes such as \u0061. Only our canonical
    // serializer is a URL identity; other imported CSS remains a legacy scope.
    if (
      typeof href !== "string" ||
      JSON.stringify(href) !== match[1] ||
      /[\u0000-\u001f\u007f]/.test(href)
    )
      return undefined;
    const url = new URL(href, pageUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function textLinkSelector(link: HTMLAnchorElement): string | undefined {
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#")) return undefined;
  // Relative URLs on pages with a custom <base> cannot be reconstructed later
  // from pageUrl alone. Keep their original, conservative page anchor instead.
  if (
    link.ownerDocument.baseURI !== link.ownerDocument.URL &&
    !/^https?:\/\//i.test(href)
  )
    return undefined;
  const rootSelector = `a[href=${JSON.stringify(href)}]`;
  if (rootSelector.length > 2_048) return undefined;
  return textLinkUrl({ rootSelector }, link.ownerDocument.baseURI)
    ? rootSelector
    : undefined;
}
