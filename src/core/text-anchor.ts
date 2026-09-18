import type { AnchorStatus, TextTarget } from "./model";

const CONTEXT_LENGTH = 64;
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "DT",
  "DD",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
const EXCLUDED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "BUTTON",
]);

type Boundary = { node: Node; offset: number };
type RawAtom = {
  char: string;
  start: Boundary;
  end: Boundary;
  textNode?: Text;
  textOffset?: number;
};
type Reading = {
  text: string;
  chars: Array<{ char: string; start: Boundary; end: Boundary }>;
  rawToNormal: number[];
  textOffsets: WeakMap<Text, number[]>;
  atoms: RawAtom[];
};

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
  // Versions must never keep a replaced article/main root alive. A WeakMap has
  // no enumeration API; whole-session invalidation replaces it instead of clear().
  private rootVersions = new WeakMap<Element, number>();
  private readonly observer: MutationObserver;
  private snapshot: RangeSnapshot | undefined;
  private epoch = 0;
  private disposed = false;

  constructor(
    private readonly doc: Document = document,
    private readonly options: TextAnchorSessionOptions = {},
  ) {
    this.observer = new MutationObserver((mutations) =>
      this.applyMutations(mutations),
    );
    // documentElement survives a body replacement and lets us release indexes
    // for roots removed during a route transition.
    this.observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "contenteditable", "id"],
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
    const root = rootFromTarget(target, this.doc);
    if (!root) throw new Error("The selection reading root is unavailable.");
    this.snapshot = {
      target,
      root,
      selector: target.rootSelector,
      version: this.versionFor(root),
      epoch: this.epoch,
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
    if (
      snapshot &&
      snapshot.root.isConnected &&
      rootFromTarget(snapshot.target, this.doc) === snapshot.root &&
      snapshot.selector === snapshot.target.rootSelector &&
      snapshot.version === this.versionFor(snapshot.root) &&
      snapshot.epoch === this.epoch &&
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
        status: "unresolved",
        reason: "Text anchor session is disposed.",
      };
    this.flush();
    return this.resolveInReading(target);
  }

  /** Explicit invalidation remains useful for callers that replace an entire root. */
  invalidate(root?: Element): void {
    if (this.disposed) return;
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
    this.rootVersions = new WeakMap<Element, number>();
    this.snapshot = undefined;
  }

  private captureFresh(range: Range): TextTarget {
    const root = readingRoot(range, this.doc);
    const reading = this.readingFor(root);
    const start = normalOffset(
      reading,
      root,
      range.startContainer,
      range.startOffset,
    );
    const end = normalOffset(
      reading,
      root,
      range.endContainer,
      range.endOffset,
    );
    if (start === undefined || end === undefined || start >= end) {
      throw new Error(
        "The selection cannot be represented in readable page text.",
      );
    }
    const exact = reading.text.slice(start, end);
    if (!exact || rangeForOffsets(reading, root, start, end) === undefined) {
      throw new Error("The selection has no stable readable text anchor.");
    }
    const container = stableContainer(range, root);
    return {
      exact,
      prefix: reading.text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: reading.text.slice(end, end + CONTEXT_LENGTH),
      start,
      end,
      rootSelector: selectorForRoot(root),
      ...(container?.id ? { containerId: container.id } : {}),
    };
  }

  private resolveInReading(target: TextTarget): {
    range?: Range;
    status: AnchorStatus;
    reason?: string;
  } {
    const root = rootFromTarget(target, this.doc);
    if (!root)
      return { status: "unresolved", reason: "Reading root is unavailable." };

    let container: Element | undefined;
    if (target.containerId) {
      container = this.doc.getElementById(target.containerId) ?? undefined;
      if (!container || !root.contains(container)) {
        return {
          status: "unresolved",
          reason: "The original stable container is unavailable.",
        };
      }
    }
    const reading = this.readingFor(root);
    const matches = contextMatches(reading.text, target).filter((start) => {
      if (!container) return true;
      const range = rangeForOffsets(
        reading,
        root,
        start,
        start + target.exact.length,
      );
      return Boolean(
        range &&
        container.contains(range.startContainer) &&
        container.contains(range.endContainer),
      );
    });
    if (matches.length !== 1) {
      return {
        status: "unresolved",
        reason:
          matches.length === 0
            ? "Exact text with its surrounding context was not found."
            : "Exact text is ambiguous in the original scope.",
      };
    }
    const start = matches[0]!;
    const range = rangeForOffsets(
      reading,
      root,
      start,
      start + target.exact.length,
    );
    if (!range)
      return {
        status: "unresolved",
        reason: "The resolved text cannot be mapped to DOM positions.",
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
      // class/style are geometry-only changes. They must not force an expensive
      // text rebuild, but the content controller still repaints image overlays.
      if (
        mutation.type === "attributes" &&
        (mutation.attributeName === "class" ||
          mutation.attributeName === "style")
      )
        continue;
      for (const root of this.readings.keys())
        if (mutationTouchesRoot(mutation, root)) affected.add(root);
      if (this.snapshot && mutationTouchesRoot(mutation, this.snapshot.root))
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

export function captureText(range: Range): TextTarget {
  const session = new TextAnchorSession(
    range.startContainer.ownerDocument ?? document,
  );
  try {
    return session.capture(range);
  } finally {
    session.dispose();
  }
}

export function resolveText(
  target: TextTarget,
  doc: Document = document,
): { range?: Range; status: AnchorStatus; reason?: string } {
  const session = new TextAnchorSession(doc);
  try {
    return session.resolve(target);
  } finally {
    session.dispose();
  }
}

/** Share the text index within one restore pass; discard it whenever the DOM changes. */
export interface TextResolver {
  (target: TextTarget): {
    range?: Range;
    status: AnchorStatus;
    reason?: string;
  };
  /** Drop cached root indexes after a meaningful DOM mutation. */
  invalidate: (root?: Element) => void;
  /** Release observer and all document references when the restore pass ends. */
  dispose: () => void;
}

export function createTextResolver(doc: Document = document): TextResolver {
  const session = new TextAnchorSession(doc);
  const resolve = ((target: TextTarget) =>
    session.resolve(target)) as TextResolver;
  resolve.invalidate = (root?: Element) => session.invalidate(root);
  resolve.dispose = () => session.dispose();
  return resolve;
}

function readingRoot(range: Range, doc: Document): Element {
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  for (
    let current: Element | null = start;
    current && current !== doc.body;
    current = current.parentElement
  ) {
    if (
      (current.tagName === "ARTICLE" || current.tagName === "MAIN") &&
      current.contains(end)
    )
      return current;
  }
  return doc.body;
}

function rootFromTarget(
  target: TextTarget,
  doc: Document,
): Element | undefined {
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
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
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
  if (mutation.type !== "childList") return false;
  // A cached root may itself have been detached/replaced. Added nodes outside a
  // root cannot affect its reading, but removing/reparenting the root can.
  return Array.from(mutation.removedNodes).some(
    (node) => node === root || (node instanceof Element && node.contains(root)),
  );
}

function extensionUiMutation(mutation: MutationRecord): boolean {
  const element =
    mutation.target.nodeType === Node.ELEMENT_NODE
      ? (mutation.target as Element)
      : mutation.target.parentElement;
  return Boolean(element?.closest("[data-web-ink]"));
}

function stableContainer(range: Range, root: Element): Element | undefined {
  const end = elementFor(range.endContainer);
  for (
    let current: Element | null = elementFor(range.startContainer);
    current && current !== root.parentElement;
    current = current.parentElement
  ) {
    if (current.id && current.contains(end)) return current;
  }
  return undefined;
}

function elementFor(node: Node): Element {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : (node.parentElement ?? node.ownerDocument!.body);
}

function excluded(node: Node): boolean {
  for (
    let element: Element | null = elementFor(node);
    element;
    element = element.parentElement
  ) {
    if (
      EXCLUDED_TAGS.has(element.tagName) ||
      element.hasAttribute("contenteditable")
    )
      return true;
    // The extension's UI is marked by this attribute. Shadow-tree content is not walked by TreeWalker.
    if (element.hasAttribute("data-web-ink-ui")) return true;
  }
  return false;
}

function buildReading(root: Element): Reading {
  const atoms: RawAtom[] = [];
  const textOffsets = new WeakMap<Text, number[]>();
  const pushBoundarySpace = (node: Node, offset: number) => {
    if (atoms.length && !isWhitespace(atoms[atoms.length - 1]!.char)) {
      atoms.push({ char: " ", start: { node, offset }, end: { node, offset } });
    }
  };
  const visit = (node: Node) => {
    if (excluded(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const offsets: number[] = [atoms.length];
      for (let index = 0; index < text.data.length; index += 1) {
        atoms.push({
          char: text.data[index]!,
          start: { node: text, offset: index },
          end: { node: text, offset: index + 1 },
          textNode: text,
          textOffset: index,
        });
        offsets.push(atoms.length);
      }
      textOffsets.set(text, offsets);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.tagName === "BR") {
      pushBoundarySpace(element.parentNode ?? element, childIndex(element));
      return;
    }
    const block = element !== root && BLOCK_TAGS.has(element.tagName);
    if (block)
      pushBoundarySpace(element.parentNode ?? element, childIndex(element));
    for (const child of Array.from(element.childNodes)) visit(child);
    if (block)
      pushBoundarySpace(element.parentNode ?? element, childIndex(element) + 1);
  };
  visit(root);

  const rawToNormal = new Array<number>(atoms.length + 1).fill(0);
  const chars: Reading["chars"] = [];
  let raw = 0;
  while (raw < atoms.length) {
    const atom = atoms[raw]!;
    if (!isWhitespace(atom.char)) {
      rawToNormal[raw] = chars.length;
      chars.push({ char: atom.char, start: atom.start, end: atom.end });
      rawToNormal[raw + 1] = chars.length;
      raw += 1;
      continue;
    }
    let end = raw + 1;
    while (end < atoms.length && isWhitespace(atoms[end]!.char)) end += 1;
    const leading = chars.length === 0;
    const trailing = end === atoms.length;
    const position = chars.length;
    // The boundary before a whitespace run belongs to the preceding text as well.
    // Keeping it before the collapsed space prevents a range ending at `</em>` from
    // silently absorbing the following br/block separator.
    rawToNormal[raw] = position;
    for (let index = raw + 1; index <= end; index += 1) {
      rawToNormal[index] = position + (leading || trailing ? 0 : 1);
    }
    if (!leading && !trailing) {
      chars.push({
        char: " ",
        start: atoms[raw]!.start,
        end: atoms[end - 1]!.end,
      });
    }
    raw = end;
  }
  return {
    text: chars.map((entry) => entry.char).join(""),
    chars,
    rawToNormal,
    textOffsets,
    atoms,
  };
}

function normalOffset(
  reading: Reading,
  root: Element,
  node: Node,
  offset: number,
): number | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const offsets = reading.textOffsets.get(node as Text);
    const raw = offsets?.[offset];
    return raw === undefined ? undefined : reading.rawToNormal[raw];
  }
  if (
    node.nodeType !== Node.ELEMENT_NODE &&
    node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
  )
    return undefined;
  const parent = node as ParentNode;
  const children = Array.from(parent.childNodes);
  if (offset < 0 || offset > children.length || !root.contains(node))
    return undefined;
  const boundary = root.ownerDocument.createRange();
  boundary.setStart(node, offset);
  boundary.collapse(true);
  const probe = root.ownerDocument.createRange();
  let left = 0,
    right = reading.atoms.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2),
      end = reading.atoms[mid]!.end;
    probe.setStart(end.node, end.offset);
    probe.collapse(true);
    if (probe.compareBoundaryPoints(Range.START_TO_START, boundary) <= 0)
      left = mid + 1;
    else right = mid;
  }
  return reading.rawToNormal[left];
}

function immediateChild(parent: ParentNode, node: Node): ChildNode | undefined {
  let current: Node | null = node;
  while (current?.parentNode && current.parentNode !== parent)
    current = current.parentNode;
  return current?.parentNode === parent ? (current as ChildNode) : undefined;
}

function rangeForOffsets(
  reading: Reading,
  root: Element,
  start: number,
  end: number,
): Range | undefined {
  if (start < 0 || end > reading.chars.length || start >= end) return undefined;
  const first = reading.chars[start];
  const last = reading.chars[end - 1];
  if (!first || !last) return undefined;
  const range = root.ownerDocument!.createRange();
  try {
    range.setStart(first.start.node, first.start.offset);
    range.setEnd(last.end.node, last.end.offset);
    return range;
  } catch {
    return undefined;
  }
}

function contextMatches(text: string, target: TextTarget): number[] {
  if (!target.exact) return [];
  const matches: number[] = [];
  for (
    let index = text.indexOf(target.exact);
    index !== -1;
    index = text.indexOf(target.exact, index + 1)
  ) {
    const before = text.slice(Math.max(0, index - target.prefix.length), index);
    const after = text.slice(
      index + target.exact.length,
      index + target.exact.length + target.suffix.length,
    );
    if (before === target.prefix && after === target.suffix)
      matches.push(index);
  }
  return matches;
}

function selectorForRoot(root: Element): string {
  if (root === root.ownerDocument!.body) return "body";
  if (root.id) return `${root.tagName.toLowerCase()}#${escapeCss(root.id)}`;
  const parts: string[] = [];
  for (
    let current: Element | null = root;
    current && current !== root.ownerDocument.body;
    current = current.parentElement
  ) {
    if (current.id) {
      parts.unshift(
        `${current.tagName.toLowerCase()}#${escapeCss(current.id)}`,
      );
      break;
    }
    const siblings = Array.from(current.parentElement?.children ?? []).filter(
      (el) => el.tagName === current!.tagName,
    );
    parts.unshift(
      `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`,
    );
  }
  return parts.join(" > ");
}

function childIndex(element: Element): number {
  return Array.from(element.parentNode?.childNodes ?? []).indexOf(element);
}

function escapeCss(value: string): string {
  const css = globalThis.CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}
