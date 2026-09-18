import type { AnchorStatus, TextTarget } from './model';

const CONTEXT_LENGTH = 64;
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH',
  'THEAD', 'TR', 'UL',
]);
const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON']);

type Boundary = { node: Node; offset: number };
type RawAtom = { char: string; start: Boundary; end: Boundary; textNode?: Text; textOffset?: number };
type Reading = {
  text: string;
  chars: Array<{ char: string; start: Boundary; end: Boundary }>;
  rawToNormal: number[];
  textOffsets: WeakMap<Text, number[]>;
  atoms: RawAtom[];
};

export function captureText(range: Range): TextTarget {
  const doc = range.startContainer.ownerDocument ?? document;
  const root = readingRoot(range, doc);
  const reading = buildReading(root);
  const start = normalOffset(reading, root, range.startContainer, range.startOffset);
  const end = normalOffset(reading, root, range.endContainer, range.endOffset);
  if (start === undefined || end === undefined || start >= end) {
    throw new Error('The selection cannot be represented in readable page text.');
  }
  const exact = reading.text.slice(start, end);
  if (!exact || rangeForOffsets(reading, root, start, end) === undefined) {
    throw new Error('The selection has no stable readable text anchor.');
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

export function resolveText(
  target: TextTarget,
  doc: Document = document,
): { range?: Range; status: AnchorStatus; reason?: string } {
  return resolveInReading(target, doc, new Map());
}

/** Share the text index within one restore pass; discard it whenever the DOM changes. */
export function createTextResolver(doc: Document = document) {
  const readings = new Map<Element, Reading>();
  return (target: TextTarget) => resolveInReading(target, doc, readings);
}

function resolveInReading(target: TextTarget, doc: Document, readings: Map<Element, Reading>): { range?: Range; status: AnchorStatus; reason?: string } {
  const root = rootFromTarget(target, doc);
  if (!root) return { status: 'unresolved', reason: 'Reading root is unavailable.' };

  let container: Element | undefined;
  if (target.containerId) {
    container = doc.getElementById(target.containerId) ?? undefined;
    if (!container || !root.contains(container)) {
      return { status: 'unresolved', reason: 'The original stable container is unavailable.' };
    }
  }
  // Context is always relative to the stored reading root. A stable container narrows
  // candidates; it must not discard the preceding root-level context captured above.
  const reading = readings.get(root) ?? buildReading(root);
  readings.set(root, reading);
  const matches = contextMatches(reading.text, target).filter((start) => {
    if (!container) return true;
    const range = rangeForOffsets(reading, root, start, start + target.exact.length);
    return Boolean(range && container.contains(range.startContainer) && container.contains(range.endContainer));
  });
  if (matches.length !== 1) {
    return {
      status: 'unresolved',
      reason: matches.length === 0 ? 'Exact text with its surrounding context was not found.' : 'Exact text is ambiguous in the original scope.',
    };
  }
  const start = matches[0]!;
  const range = rangeForOffsets(reading, root, start, start + target.exact.length);
  if (!range) return { status: 'unresolved', reason: 'The resolved text cannot be mapped to DOM positions.' };
  return { range, status: 'located' };
}

function readingRoot(range: Range, doc: Document): Element {
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  for (let current: Element | null = start; current && current !== doc.body; current = current.parentElement) {
    if ((current.tagName === 'ARTICLE' || current.tagName === 'MAIN') && current.contains(end)) return current;
  }
  return doc.body;
}

function rootFromTarget(target: TextTarget, doc: Document): Element | undefined {
  if (target.rootSelector === 'body') return doc.body;
  try {
    return doc.querySelector(target.rootSelector) ?? undefined;
  } catch {
    return undefined;
  }
}

function stableContainer(range: Range, root: Element): Element | undefined {
  const end = elementFor(range.endContainer);
  for (let current: Element | null = elementFor(range.startContainer); current && current !== root.parentElement; current = current.parentElement) {
    if (current.id && current.contains(end)) return current;
  }
  return undefined;
}

function elementFor(node: Node): Element {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement ?? node.ownerDocument!.body;
}

function excluded(node: Node): boolean {
  for (let element: Element | null = elementFor(node); element; element = element.parentElement) {
    if (EXCLUDED_TAGS.has(element.tagName) || element.hasAttribute('contenteditable')) return true;
    // The extension's UI is marked by this attribute. Shadow-tree content is not walked by TreeWalker.
    if (element.hasAttribute('data-web-ink-ui')) return true;
  }
  return false;
}

function buildReading(root: Element): Reading {
  const atoms: RawAtom[] = [];
  const textOffsets = new WeakMap<Text, number[]>();
  const pushBoundarySpace = (node: Node, offset: number) => {
    if (atoms.length && !isWhitespace(atoms[atoms.length - 1]!.char)) {
      atoms.push({ char: ' ', start: { node, offset }, end: { node, offset } });
    }
  };
  const visit = (node: Node) => {
    if (excluded(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const offsets: number[] = [atoms.length];
      for (let index = 0; index < text.data.length; index += 1) {
        atoms.push({ char: text.data[index]!, start: { node: text, offset: index }, end: { node: text, offset: index + 1 }, textNode: text, textOffset: index });
        offsets.push(atoms.length);
      }
      textOffsets.set(text, offsets);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.tagName === 'BR') {
      pushBoundarySpace(element.parentNode ?? element, childIndex(element));
      return;
    }
    const block = element !== root && BLOCK_TAGS.has(element.tagName);
    if (block) pushBoundarySpace(element.parentNode ?? element, childIndex(element));
    for (const child of Array.from(element.childNodes)) visit(child);
    if (block) pushBoundarySpace(element.parentNode ?? element, childIndex(element) + 1);
  };
  visit(root);

  const rawToNormal = new Array<number>(atoms.length + 1).fill(0);
  const chars: Reading['chars'] = [];
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
      chars.push({ char: ' ', start: atoms[raw]!.start, end: atoms[end - 1]!.end });
    }
    raw = end;
  }
  return { text: chars.map((entry) => entry.char).join(''), chars, rawToNormal, textOffsets, atoms };
}

function normalOffset(reading: Reading, root: Element, node: Node, offset: number): number | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const offsets = reading.textOffsets.get(node as Text);
    const raw = offsets?.[offset];
    return raw === undefined ? undefined : reading.rawToNormal[raw];
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return undefined;
  const parent = node as ParentNode;
  const children = Array.from(parent.childNodes);
  if (offset < 0 || offset > children.length || !root.contains(node)) return undefined;
  const boundary = root.ownerDocument.createRange();
  boundary.setStart(node, offset); boundary.collapse(true);
  const probe = root.ownerDocument.createRange();
  let left = 0, right = reading.atoms.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2), end = reading.atoms[mid]!.end;
    probe.setStart(end.node, end.offset); probe.collapse(true);
    if (probe.compareBoundaryPoints(Range.START_TO_START, boundary) <= 0) left = mid + 1;
    else right = mid;
  }
  return reading.rawToNormal[left];
}

function immediateChild(parent: ParentNode, node: Node): ChildNode | undefined {
  let current: Node | null = node;
  while (current?.parentNode && current.parentNode !== parent) current = current.parentNode;
  return current?.parentNode === parent ? current as ChildNode : undefined;
}

function rangeForOffsets(reading: Reading, root: Element, start: number, end: number): Range | undefined {
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
  for (let index = text.indexOf(target.exact); index !== -1; index = text.indexOf(target.exact, index + 1)) {
    const before = text.slice(Math.max(0, index - target.prefix.length), index);
    const after = text.slice(index + target.exact.length, index + target.exact.length + target.suffix.length);
    if (before === target.prefix && after === target.suffix) matches.push(index);
  }
  return matches;
}

function selectorForRoot(root: Element): string {
  if (root === root.ownerDocument!.body) return 'body';
  if (root.id) return `${root.tagName.toLowerCase()}#${escapeCss(root.id)}`;
  const parts: string[] = [];
  for (let current: Element | null = root; current && current !== root.ownerDocument.body; current = current.parentElement) {
    if (current.id) { parts.unshift(`${current.tagName.toLowerCase()}#${escapeCss(current.id)}`); break; }
    const siblings = Array.from(current.parentElement?.children ?? []).filter(el => el.tagName === current!.tagName);
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
  }
  return parts.join(' > ');
}

function childIndex(element: Element): number {
  return Array.from(element.parentNode?.childNodes ?? []).indexOf(element);
}

function escapeCss(value: string): string {
  const css = globalThis.CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function isWhitespace(value: string): boolean { return /\s/u.test(value); }
