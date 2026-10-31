import type { TextTarget } from "./model";

/** A linked reading root retains its destination in the existing CSS selector. */
export function textLinkScope(target: Pick<TextTarget, "rootSelector">, pageUrl: string,
): { url: string; selector: string } | undefined {
  const match = /^a\[href(\^?)=("(?:[^"\\]|\\.)*")\]$/.exec(target.rootSelector);
  if (!match) return undefined;
  try {
    const href: unknown = JSON.parse(match[2]!);
    // JSON and CSS disagree on escapes such as \u0061. Only our canonical
    // serializer is a URL identity; other imported CSS remains a legacy scope.
    if (typeof href !== "string" || JSON.stringify(href) !== match[2] || /[\u0000-\u001f\u007f]/.test(href) )
      return undefined;
    const url = new URL(href, pageUrl);
    if ( !["http:", "https:"].includes(url.protocol) || url.username || url.password )
      return undefined;
    const prefix = href.split(/[?#]/, 1)[0]!.replace(/\/$/, "");
    const videoId = /^\/video\/(BV[\da-zA-Z]{10})\/?$/.exec(url.pathname)?.[1];
    const isBilibiliVideo = ["www.bilibili.com", "bilibili.com"].includes(url.host) && videoId && prefix &&
      !url.hash && [...url.searchParams.keys()].every((key) => key === "trackid");
    if (isBilibiliVideo) {
      // Homepage links carry trackid alongside the video's BV identity.
      // Unknown/content-bearing query parameters
      // retain exact matching. A prefix is only a candidate lookup, never proof.
      if (match[1] && (url.search || url.hash)) return undefined;
      url.pathname = `/video/${videoId}`;
      url.search = "";
      return { url: url.href, selector: `a[href^=${JSON.stringify(prefix)}]` };
    }
    if (match[1]) return undefined;
    return { url: url.href, selector: target.rootSelector };
  } catch {
    return undefined;
  }
}

export function textLinkUrl(target: Pick<TextTarget, "rootSelector">, pageUrl: string,
): string | undefined {
  return textLinkScope(target, pageUrl)?.url;
}

export function textLinkSelector(link: HTMLAnchorElement): string | undefined {
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#")) return undefined;
  // Relative URLs on pages with a custom <base> cannot be reconstructed later
  // from pageUrl alone. Keep their original, conservative page anchor instead.
  if (link.ownerDocument.baseURI !== link.ownerDocument.URL && !/^https?:\/\//i.test(href)
  )
    return undefined;
  const rootSelector = `a[href=${JSON.stringify(href)}]`;
  if (rootSelector.length > 2_048) return undefined;
  return textLinkScope({ rootSelector }, link.ownerDocument.baseURI)?.selector;
}
