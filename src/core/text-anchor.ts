import type { AnchorStatus, TextTarget } from "./model";
import { buildReading, elementFor, normalOffset, rangeForOffsets, type Boundary, type Reading } from "./text-reading";
import { textLinkScope, textLinkSelector, textLinkUrl } from "./text-link";

const CONTEXT_LENGTH = 64;

type CachedReading = { reading: Reading; version: number };
type RangeSnapshot = {
  target: TextTarget;
  root: Element;
  selector: string;
  version: number;
  epoch: number;
  start: Boundary;
  end: Boundary;
};

/** Test-only hook. It is deliberately injected instead of being product telemetry. */
export interface TextAnchorSessionOptions {
  onIndexBuild?: (root: Element) => void;
}

/**
 * Owns the short-lived DOM reading indexes used by one content-engine instance.
 * The session is intentionally not persisted: DOM nodes and cache versions are
 * meaningful only for the current document lifecycle.
 */
export class TextAnchorSession {
  private readonly readings = new Map<Element, CachedReading>();
  private readonly linkedRoots = new Map<string, Element[]>();
  // Versions must never keep a replaced article/main root alive. A WeakMap has
  // no enumeration API; whole-session invalidation replaces it instead of clear().
  private rootVersions = new WeakMap<Element, number>();
  private readonly observer: MutationObserver;
  private snapshot: RangeSnapshot | undefined;
  private epoch = 0;
  private disposed = false;

  constructor(private readonly doc: Document = document,
    private readonly options: TextAnchorSessionOptions = {},
  ) {
    this.observer = new MutationObserver((mutations) => this.applyMutations(mutations));
    // documentElement survives a body replacement and lets us release indexes
    // for roots removed during a route transition.
    this.observer.observe(this.doc.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "contenteditable", "id", "href"],
    });
  }

  /** Process records queued after the browser's observer microtask, before a save. */
  flush(): void {
    if (this.disposed) return;
    const records = this.observer.takeRecords();
    if (records.length) this.applyMutations(records);
    this.dropDisconnectedRoots();
  }

  capture(range: Range): TextTarget {
    if (this.disposed)
      throw new Error("The text anchor session has been disposed.");
    this.flush();
    const target = this.captureFresh(range);
    const root = readingRoot(range, this.doc);
    this.snapshot = {
      target, root, selector: target.rootSelector, version: this.versionFor(root), epoch: this.epoch,
      start: { node: range.startContainer, offset: range.startOffset },
      end: { node: range.endContainer, offset: range.endOffset },
    };
    return target;
  }

  /** Reuses a mouseup capture only when the exact live range is still valid. */
  captureSelected(range: Range): TextTarget {
    if (this.disposed)
      throw new Error("The text anchor session has been disposed.");
    this.flush();
    const snapshot = this.snapshot;
    if (snapshot && snapshot.root.isConnected && (textLinkUrl(snapshot.target, this.doc.URL)
        ? snapshot.root instanceof HTMLAnchorElement && textLinkSelector(snapshot.root) === snapshot.selector
        : rootFromTarget(snapshot.target, this.doc) === snapshot.root) &&
      snapshot.selector === snapshot.target.rootSelector &&
      snapshot.version === this.versionFor(snapshot.root) && snapshot.epoch === this.epoch &&
      sameBoundary(range.startContainer, range.startOffset, snapshot.start) &&
      sameBoundary(range.endContainer, range.endOffset, snapshot.end) &&
      rangeBoundariesAreValid(range, snapshot.root)
    )
      return snapshot.target;
    return this.capture(range);
  }

  resolve(target: TextTarget): {
    range?: Range;
    status: AnchorStatus;
    reason?: string;
  } {
    if (this.disposed)
      return {
        status: "unresolved", reason: "Text anchor session is disposed.",
      };
    this.flush();
    return this.resolveInReading(target);
  }

  /** Find exact-text candidates only on explicit request; they are never auto-bound. */
  candidates(target: TextTarget): Range[] {
    if (this.disposed || !target.exact) return [];
    this.flush();
    const scope = textLinkScope(target, this.doc.URL);
    let roots: Element[];
    if (scope) {
      if (textLinkUrl(target, this.doc.baseURI) !== scope.url) return [];
      try {
        roots = Array.from(this.doc.querySelectorAll(scope.selector)).filter((root) =>
          root instanceof HTMLAnchorElement && textLinkUrl(
            { rootSelector: `a[href=${JSON.stringify(root.getAttribute("href"))}]` }, this.doc.baseURI,
          ) === scope.url);
      } catch {
        return [];
      }
    } else {
      // A malformed or legacy link selector cannot establish destination identity.
      if (target.rootSelector.startsWith("a[")) return [];
      const root = rootFromTarget(target, this.doc);
      roots = root ? [root] : [];
    }
    const results: Range[] = [];
    let examined = 0;
    for (const root of roots) {
      const container = target.containerId ? this.doc.getElementById(target.containerId) : root;
      if (!container || !root.contains(container)) continue;
      const reading = this.readingFor(container);
      for (let index = reading.text.indexOf(target.exact); index !== -1;
        index = reading.text.indexOf(target.exact, index + 1)) {
        if (++examined > 50) return results;
        const range = rangeForOffsets(reading, container, index, index + target.exact.length);
        if (!range || !container.contains(range.startContainer) || !container.contains(range.endContainer) ||
          !visibleCandidate(range)) continue;
        results.push(range);
        if (results.length === 5) return results;
      }
    }
    return results;
  }

  /** Explicit invalidation remains useful for callers that replace an entire root. */
  invalidate(root?: Element): void {
    if (this.disposed) return;
    this.linkedRoots.clear();
    if (!root) {
      this.epoch++;
      this.readings.clear();
      this.rootVersions = new WeakMap<Element, number>();
      this.snapshot = undefined;
      return;
    }
    this.invalidateRoot(root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.readings.clear();
    this.linkedRoots.clear();
    this.rootVersions = new WeakMap<Element, number>();
    this.snapshot = undefined;
  }

  private captureFresh(range: Range): TextTarget {
    const root = readingRoot(range, this.doc);
    const reading = this.readingFor(root);
    const start = normalOffset(reading, root, range.startContainer, range.startOffset);
    const end = normalOffset(reading, root, range.endContainer, range.endOffset);
    if (start === undefined || end === undefined || start >= end) {
      throw new Error("The selection cannot be represented in readable page text.");
    }
    const exact = reading.text.slice(start, end);
    if (!exact || rangeForOffsets(reading, root, start, end) === undefined) {
      throw new Error("The selection has no stable readable text anchor.");
    }
    // Link identity and local text already delimit a recommendation. Its DOM
    // slot IDs can change during rendering and must not become durable identity.
    const container = root instanceof HTMLAnchorElement
      ? undefined
      : stableContainer(range, root);
    return {
      exact, prefix: reading.text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: reading.text.slice(end, end + CONTEXT_LENGTH), start, end, rootSelector: selectorForRoot(root),
      ...(container?.id ? { containerId: container.id } : {}),
    };
  }

  private resolveInReading(target: TextTarget): {
    range?: Range;
    status: AnchorStatus;
    reason?: string;
  } {
    const scope = textLinkScope(target, this.doc.URL);
    if (scope) {
      if (textLinkUrl(target, this.doc.baseURI) !== scope.url)
        return {
          status: "unresolved",
          reason: "The original link destination cannot be confirmed with the current document base.",
        };
      const matches: Range[] = [];
      let roots = this.linkedRoots.get(scope.selector);
      if (!roots) {
        try {
          roots = Array.from(this.doc.querySelectorAll(scope.selector));
        } catch {
          return { status: "unresolved", reason: "Reading root is unavailable." };
        }
        this.linkedRoots.set(scope.selector, roots);
      }
      for (const root of roots) {
        if ( !(root instanceof HTMLAnchorElement) || textLinkUrl(
            { rootSelector: `a[href=${JSON.stringify(root.getAttribute("href"))}]` }, this.doc.baseURI,
          ) !== scope.url
        )
          continue;
        const result = this.resolveInRoot(target, root);
        if (result.status === "unresolved" &&
          result.reason === "Exact text is ambiguous in the original scope."
        )
          return result;
        if (result.range) matches.push(result.range);
        if (matches.length > 1)
          return {
            status: "unresolved", reason: "Exact text is ambiguous in the original scope.",
          };
      }
      return matches.length === 1
        ? { range: matches[0], status: "located" }
        : {
            status: "unresolved", reason: "The original linked text is not currently present.",
          };
    }
    const root = rootFromTarget(target, this.doc);
    if (!root)
      return { status: "unresolved", reason: "Reading root is unavailable." };
    return this.resolveInRoot(target, root);
  }

  private resolveInRoot(target: TextTarget, root: Element): {
    range?: Range;
    status: AnchorStatus;
    reason?: string;
  } {
    let container: Element | undefined;
    if (target.containerId) {
      container = this.doc.getElementById(target.containerId) ?? undefined;
      if (!container || !root.contains(container)) {
        return {
          status: "unresolved", reason: "The original stable container is unavailable.",
        };
      }
    }
    const reading = this.readingFor(root);
    const matches = contextMatches(reading.text, target, (start) => {
      if (!container) return true;
      const range = rangeForOffsets(reading, root, start, start + target.exact.length);
      return Boolean(range && container.contains(range.startContainer) &&
        container.contains(range.endContainer),
      );
    });
    if (matches.length !== 1) {
      return {
        status: "unresolved", reason: matches.length === 0
            ? "Exact text with its surrounding context was not found."
            : "Exact text is ambiguous in the original scope.",
      };
    }
    const start = matches[0]!;
    const range = rangeForOffsets(reading, root, start, start + target.exact.length);
    if (!range)
      return {
        status: "unresolved", reason: "The resolved text cannot be mapped to DOM positions.",
      };
    return { range, status: "located" };
  }

  private readingFor(root: Element): Reading {
    const version = this.versionFor(root);
    const cached = this.readings.get(root);
    if (cached?.version === version) return cached.reading;
    const reading = buildReading(root);
    this.options.onIndexBuild?.(root);
    this.readings.set(root, { reading, version });
    return reading;
  }

  private versionFor(root: Element): number {
    return this.rootVersions.get(root) ?? 0;
  }

  private invalidateRoot(root: Element): void {
    this.epoch++;
    this.rootVersions.set(root, this.versionFor(root) + 1);
    this.readings.delete(root);
    if (this.snapshot?.root === root) this.snapshot = undefined;
  }

  private applyMutations(mutations: MutationRecord[]): void {
    if (this.disposed || !mutations.length) return;
    const affected = new Set<Element>();
    for (const mutation of mutations) {
      if (extensionUiMutation(mutation)) continue;
      if (mutation.type === "childList" || mutation.attributeName === "href")
        this.linkedRoots.clear();
      // class/style are geometry-only changes. They must not force an expensive
      // text rebuild, but the content controller still repaints image overlays.
      if (mutation.type === "attributes" && (mutation.attributeName === "class" ||
          mutation.attributeName === "style")
      )
        continue;
      for (const root of this.readings.keys())
        if ((mutation.attributeName !== "href" || root instanceof HTMLAnchorElement) &&
          mutationTouchesRoot(mutation, root)
        )
          affected.add(root);
      if (this.snapshot &&
        (mutation.attributeName !== "href" || this.snapshot.root instanceof HTMLAnchorElement) &&
        mutationTouchesRoot(mutation, this.snapshot.root)
      )
        affected.add(this.snapshot.root);
    }
    for (const root of affected) this.invalidateRoot(root);
    this.dropDisconnectedRoots();
  }

  private dropDisconnectedRoots(): void {
    for (const root of this.readings.keys())
      if (!root.isConnected) {
        this.readings.delete(root);
        this.rootVersions.delete(root);
      }
    if (this.snapshot && !this.snapshot.root.isConnected)
      this.snapshot = undefined;
  }
}

function visibleCandidate(range: Range): boolean {
  if (typeof range.getClientRects !== "function" || !Array.from(range.getClientRects()).some(
    (rect) => rect.width > 0 && rect.height > 0,
  )) return false;
  const view = range.startContainer.ownerDocument?.defaultView;
  if (!view) return false;
  for (const boundary of [range.startContainer, range.endContainer]) {
    for (let element: Element | null = elementFor(boundary); element; element = element.parentElement) {
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
        Number.parseFloat(style.opacity) === 0 || element.hasAttribute("hidden")) return false;
    }
  }
  return true;
}


function readingRoot(range: Range, doc: Document): Element {
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  const link = start.closest<HTMLAnchorElement>("a[href]");
  if (link instanceof HTMLAnchorElement && link.contains(end) && textLinkSelector(link)) return link;
  for (let current: Element | null = start;
    current && current !== doc.body;
    current = current.parentElement
  ) {
    if ((current.tagName === "ARTICLE" || current.tagName === "MAIN") && current.contains(end) )
      return current;
  }
  return doc.body;
}

function rootFromTarget(target: TextTarget, doc: Document): Element | undefined {
  if (target.rootSelector === "body") return doc.body;
  try {
    return doc.querySelector(target.rootSelector) ?? undefined;
  } catch {
    return undefined;
  }
}

function sameBoundary(node: Node, offset: number, boundary: Boundary): boolean {
  return node === boundary.node && offset === boundary.offset;
}

function rangeBoundariesAreValid(range: Range, root: Element): boolean {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer))
    return false;
  try {
    const probe = root.ownerDocument.createRange();
    probe.setStart(range.startContainer, range.startOffset);
    probe.setEnd(range.endContainer, range.endOffset);
    return !probe.collapsed;
  } catch {
    return false;
  }
}

function mutationTouchesRoot(mutation: MutationRecord, root: Element): boolean {
  if (!root.isConnected) return true;
  if (root.contains(mutation.target)) return true;
  if (mutation.attributeName === "contenteditable" && mutation.target instanceof Element &&
    mutation.target.contains(root)
  )
    return true;
  if (mutation.type !== "childList") return false;
  // A cached root may itself have been detached/replaced. Added nodes outside a
  // root cannot affect its reading, but removing/reparenting the root can.
  return Array.from(mutation.removedNodes).some(
    (node) => node === root || (node instanceof Element && node.contains(root)),
  );
}

function extensionUiMutation(mutation: MutationRecord): boolean {
  const element = mutation.target.nodeType === Node.ELEMENT_NODE
      ? (mutation.target as Element)
      : mutation.target.parentElement;
  return Boolean(element?.closest("[data-web-ink]"));
}

function stableContainer(range: Range, root: Element): Element | undefined {
  const end = elementFor(range.endContainer);
  for (let current: Element | null = elementFor(range.startContainer);
    current && current !== root.parentElement;
    current = current.parentElement
  ) {
    if (current.id && current.contains(end)) return current;
  }
  return undefined;
}

function contextMatches(text: string, target: TextTarget, withinScope: (start: number) => boolean): number[] {
  if (!target.exact) return [];
  const matches: number[] = [];
  for (let index = text.indexOf(target.exact);
    index !== -1;
    index = text.indexOf(target.exact, index + 1)
  ) {
    const before = text.slice(Math.max(0, index - target.prefix.length), index);
    const after = text.slice(index + target.exact.length, index + target.exact.length + target.suffix.length,
    );
    if (before === target.prefix && after === target.suffix && withinScope(index)) {
      matches.push(index);
      // Two valid candidates are enough to reject an ambiguous anchor.
      if (matches.length === 2) break;
    }
  }
  return matches;
}

function selectorForRoot(root: Element): string {
  if (root === root.ownerDocument!.body) return "body";
  if (root instanceof HTMLAnchorElement) {
    const selector = textLinkSelector(root);
    if (selector) return selector;
  }
  if (root.id) return `${root.tagName.toLowerCase()}#${escapeCss(root.id)}`;
  const parts: string[] = [];
  for (let current: Element | null = root;
    current && current !== root.ownerDocument.body;
    current = current.parentElement
  ) {
    if (current.id) {
      parts.unshift(`${current.tagName.toLowerCase()}#${escapeCss(current.id)}`);
      break;
    }
    const siblings = Array.from(current.parentElement?.children ?? []).filter(
      (el) => el.tagName === current!.tagName,
    );
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
  }
  return parts.join(" > ");
}

function escapeCss(value: string): string {
  const css = globalThis.CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}
