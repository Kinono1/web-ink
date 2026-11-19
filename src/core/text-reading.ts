/** Maps normalized reading text back to DOM boundaries for annotation capture and restore. */
const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "DT", "DD",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
  "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
]);
const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT",
  "OPTION", "BUTTON",
]);

export type Boundary = { node: Node; offset: number };
type RawAtom = {
  char: string;
  start: Boundary;
  end: Boundary;
};
export type Reading = {
  text: string;
  chars: Array<{ char: string; start: Boundary; end: Boundary }>;
  rawToNormal: number[];
  textOffsets: WeakMap<Text, number[]>;
  atoms: RawAtom[];
};

export function elementFor(node: Node): Element {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : (node.parentElement ?? node.ownerDocument!.body);
}

function excluded(node: Node): boolean {
  for (let element: Element | null = elementFor(node);
    element;
    element = element.parentElement
  ) {
    if (EXCLUDED_TAGS.has(element.tagName) || element.hasAttribute("contenteditable"))
      return true;
    // The extension's UI is marked by this attribute. Shadow-tree content is not walked by TreeWalker.
    if (element.hasAttribute("data-web-ink-ui")) return true;
  }
  return false;
}

export function buildReading(root: Element): Reading {
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
          char: text.data[index]!, start: { node: text, offset: index },
          end: { node: text, offset: index + 1 },
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
        char: " ", start: atoms[raw]!.start, end: atoms[end - 1]!.end,
      });
    }
    raw = end;
  }
  return {
    text: chars.map((entry) => entry.char).join(""), chars, rawToNormal, textOffsets, atoms,
  };
}

export function normalOffset(reading: Reading, root: Element, node: Node, offset: number): number | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const offsets = reading.textOffsets.get(node as Text);
    const raw = offsets?.[offset];
    return raw === undefined ? undefined : reading.rawToNormal[raw];
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)
    return undefined;
  const parent = node as ParentNode;
  if (offset < 0 || offset > parent.childNodes.length || !root.contains(node))
    return undefined;
  const boundary = root.ownerDocument.createRange();
  boundary.setStart(node, offset);
  boundary.collapse(true);
  const probe = root.ownerDocument.createRange();
  let left = 0, right = reading.atoms.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2), end = reading.atoms[mid]!.end;
    probe.setStart(end.node, end.offset);
    probe.collapse(true);
    if (probe.compareBoundaryPoints(Range.START_TO_START, boundary) <= 0)
      left = mid + 1;
    else right = mid;
  }
  return reading.rawToNormal[left];
}

export function rangeForOffsets(reading: Reading, root: Element, start: number, end: number): Range | undefined {
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

function childIndex(element: Element): number {
  return Array.from(element.parentNode?.childNodes ?? []).indexOf(element);
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}
