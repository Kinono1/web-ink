import type { AnchorStatus, ImageTarget } from "./model";

export function captureImage(image: HTMLImageElement): ImageTarget {
  const doc = image.ownerDocument;
  const selector = selectorFor(image);
  const candidates = sourceCandidates(image);
  const images = Array.from(doc.images).filter((candidate) =>
    sameSource(candidate, candidates),
  );
  return {
    src: image.currentSrc || image.src || image.getAttribute("src") || "",
    sourceCandidates: candidates,
    alt: image.alt.trim(),
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    selector,
    occurrence: Math.max(0, images.indexOf(image)),
    context: imageContext(image),
  };
}

export function resolveImage(
  target: ImageTarget,
  doc: Document = document,
): { image?: HTMLImageElement; status: AnchorStatus; reason?: string } {
  const all = Array.from(doc.images);
  const sourceMatches = all.filter((image) =>
    sameSource(
      image,
      target.sourceCandidates.length ? target.sourceCandidates : [target.src],
    ),
  );
  if (!sourceMatches.length)
    return {
      status: "unresolved",
      reason: "No image with the recorded source was found.",
    };
  const ready = sourceMatches.filter(
    (image) =>
      image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
  );
  if (!ready.length)
    return {
      status: "pending",
      reason: "A matching image is present but has not loaded.",
    };

  const candidates = ready
    .filter((image) => compatibleDimensions(image, target))
    .filter((image) => {
      const selectorMatch = matchesSelector(image, target.selector);
      const altMatch = Boolean(target.alt) && image.alt.trim() === target.alt;
      const contextMatch =
        Boolean(target.context) && imageContext(image) === target.context;
      // A source URL by itself is intentionally not enough: repeated logos and thumbnails are common.
      return selectorMatch || altMatch || contextMatch;
    });
  if (candidates.length !== 1) {
    return {
      status: "unresolved",
      reason: candidates.length
        ? "Matching images remain ambiguous."
        : "Source matched, but its selector, dimensions, alt text, or context did not verify.",
    };
  }
  return { image: candidates[0], status: "located" };
}

function sourceCandidates(image: HTMLImageElement): string[] {
  const values = [
    image.currentSrc,
    image.src,
    image.getAttribute("src"),
    image.getAttribute("data-src"),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => absoluteSource(value, image.ownerDocument));
  return [...new Set(values)];
}

function sameSource(image: HTMLImageElement, targetSources: string[]): boolean {
  const sources = sourceCandidates(image);
  return sources.some((source) => targetSources.includes(source));
}

function absoluteSource(value: string, doc: Document): string {
  try {
    return new URL(value, doc.baseURI).href;
  } catch {
    return value;
  }
}

function compatibleDimensions(
  image: HTMLImageElement,
  target: ImageTarget,
): boolean {
  if (!target.naturalWidth || !target.naturalHeight) return true;
  if (!image.naturalWidth || !image.naturalHeight) return false;
  const targetRatio = target.naturalWidth / target.naturalHeight;
  const actualRatio = image.naturalWidth / image.naturalHeight;
  return (
    Math.abs(targetRatio - actualRatio) <= 0.002 * Math.max(1, targetRatio)
  );
}

function matchesSelector(image: HTMLImageElement, selector: string): boolean {
  try {
    return Boolean(selector) && image.matches(selector);
  } catch {
    return false;
  }
}

function imageContext(image: HTMLImageElement): string {
  const figure = image.closest("figure");
  const caption = figure?.querySelector("figcaption");
  const nearby =
    caption ??
    image.closest("p,li,article,main,section,div") ??
    image.parentElement;
  return normalize(nearby?.textContent ?? "").slice(0, 160);
}

function selectorFor(image: HTMLImageElement): string {
  if (image.id) return `img#${escapeCss(image.id)}`;
  const parts: string[] = [];
  for (
    let current: Element | null = image;
    current && current.tagName !== "HTML";
    current = current.parentElement
  ) {
    if (current.id) {
      parts.unshift(
        `${current.tagName.toLowerCase()}#${escapeCss(current.id)}`,
      );
      break;
    }
    const siblings = Array.from(current.parentElement?.children ?? []).filter(
      (item) => item.tagName === current!.tagName,
    );
    parts.unshift(
      `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`,
    );
  }
  return parts.join(" > ");
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
function escapeCss(value: string): string {
  const css = globalThis.CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}
