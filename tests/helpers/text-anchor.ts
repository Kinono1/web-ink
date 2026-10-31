import type { AnchorStatus, TextTarget } from "../../src/core/model";
import { TextAnchorSession } from "../../src/core/text-anchor";
export { TextAnchorSession };

/** Test-only convenience wrappers relocated from core (no product references). */
export function captureText(range: Range): TextTarget {
  const session = new TextAnchorSession(range.startContainer.ownerDocument ?? document);
  try {
    return session.capture(range);
  } finally {
    session.dispose();
  }
}

export function resolveText(target: TextTarget, doc: Document = document,
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
  const resolve = ((target: TextTarget) => session.resolve(target)) as TextResolver;
  resolve.invalidate = (root?: Element) => session.invalidate(root);
  resolve.dispose = () => session.dispose();
  return resolve;
}
