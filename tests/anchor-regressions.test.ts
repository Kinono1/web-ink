import { describe, it, expect } from "vitest";
import {
  captureText,
  resolveText,
  createTextResolver,
  TextAnchorSession,
} from "../src/core/text-anchor";
import type { TextTarget } from "../src/core/model";

describe("real selection boundaries and large restore batches", () => {
  it("selectNodeContents after earlier siblings uses offsets in the reading root", () => {
    document.body.innerHTML =
      '<article><p>Earlier paragraph must not be selected.</p><p id="target">正确的目标 <b>bold text</b> 尾部</p></article>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#target")!);
    const target = captureText(range);
    expect(target.exact).toBe("正确的目标 bold text 尾部");
    expect(resolveText(target).range?.toString()).toBe(range.toString());
  });
  it("anchors inside the second article instead of querying the first one", () => {
    document.body.innerHTML =
      "<article><p>First article</p></article><article><p>The second article</p></article>";
    const range = document.createRange();
    range.selectNodeContents(document.querySelectorAll("article p")[1]!);
    const target = captureText(range);
    expect(resolveText(target).range?.toString()).toBe("The second article");
  });
  it("restores 200 records using one disposable reading index", () => {
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) => `Paragraph ${i}: independent annotation 测试内容.`,
    );
    document.body.innerHTML = `<article>${paragraphs.map((text, i) => `<p id="p${i}">${text}</p>`).join("")}</article>`;
    // Model records already saved by previous visits. Capture is covered above;
    // doing 200 full DOM captures here measures fixture setup instead of restore.
    const normalized = paragraphs.join(" ");
    let offset = 0;
    const targets: TextTarget[] = paragraphs.map((exact, i) => {
      const start = offset,
        end = start + exact.length;
      offset = end + 1;
      return {
        exact,
        start,
        end,
        prefix: normalized.slice(Math.max(0, start - 64), start),
        suffix: normalized.slice(end, end + 64),
        rootSelector: "article",
        containerId: `p${i}`,
      };
    });
    const resolver = createTextResolver();
    const results = targets.map((t) => resolver(t));
    expect(
      results.filter((result) => result.status === "located"),
    ).toHaveLength(200);
    expect(results.map((result) => result.range?.toString())).toEqual(
      paragraphs,
    );
    resolver.dispose();
  });
});

describe("TextAnchorSession lifecycle", () => {
  it("shares the mouseup reading with save capture when the DOM and boundaries are unchanged", () => {
    document.body.innerHTML =
      '<main id="story"><p id="target">before chosen after</p></main>';
    const range = document.createRange();
    const node = document.querySelector("#target")!.firstChild!;
    range.setStart(node, 7);
    range.setEnd(node, 13);
    let builds = 0;
    const session = new TextAnchorSession(document, {
      onIndexBuild: () => builds++,
    });
    try {
      const preview = session.capture(range);
      const saved = session.captureSelected(range);
      expect(saved).toEqual(preview);
      expect(builds).toBeLessThanOrEqual(1);
    } finally {
      session.dispose();
    }
  });

  it("flushes a queued text mutation before reusing a selected capture", () => {
    document.body.innerHTML =
      '<main id="story"><p id="target">before chosen after</p></main>';
    const range = document.createRange();
    const node = document.querySelector("#target")!.firstChild as Text;
    range.setStart(node, 7);
    range.setEnd(node, 13);
    const session = new TextAnchorSession(document);
    try {
      const preview = session.capture(range);
      node.data = "before change! after";
      // Browser range repair after a character-data edit may leave the old
      // selection unrepresentable. Either way, a stale preview must never save.
      expect(() => session.captureSelected(range)).toThrow(
        "selection cannot be represented",
      );
      expect(preview.exact).toBe("chosen");
    } finally {
      session.dispose();
    }
  });

  it("keeps a reading index for class and style-only geometry changes", () => {
    document.body.innerHTML =
      '<main id="story"><p id="target">before chosen after</p></main>';
    let builds = 0;
    const session = new TextAnchorSession(document, {
      onIndexBuild: () => builds++,
    });
    try {
      const target = session.capture(selectRange("#target", 7, 13));
      document.querySelector("#target")!.classList.add("layout-shift");
      document
        .querySelector("#target")!
        .setAttribute("style", "margin-top: 1px");
      expect(session.resolve(target).status).toBe("located");
      expect(builds).toBe(1);
    } finally {
      session.dispose();
    }
  });

  it("rebuilds after a replacement root and rejects contenteditable text", () => {
    document.body.innerHTML =
      '<main id="story"><p id="target">before chosen after</p></main>';
    const range = document.createRange();
    const node = document.querySelector("#target")!.firstChild!;
    range.setStart(node, 7);
    range.setEnd(node, 13);
    const session = new TextAnchorSession(document);
    try {
      const target = session.capture(range);
      document.querySelector("#story")!.outerHTML =
        '<main id="story"><p id="target">before chosen after</p></main>';
      expect(session.resolve(target).range?.toString()).toBe("chosen");
      document
        .querySelector("#target")!
        .setAttribute("contenteditable", "true");
      expect(session.resolve(target).status).toBe("unresolved");
    } finally {
      session.dispose();
    }
  });

  it("drops an explicitly invalidated detached root before resolving its replacement", () => {
    document.body.innerHTML =
      '<main id="story"><p id="target">before chosen after</p></main>';
    let builds = 0;
    const session = new TextAnchorSession(document, {
      onIndexBuild: () => builds++,
    });
    try {
      const target = session.capture(selectRange("#target", 7, 13));
      const oldRoot = document.querySelector("#story") as HTMLElement;
      session.invalidate(oldRoot);
      oldRoot.remove();
      document.body.insertAdjacentHTML(
        "beforeend",
        '<main id="story"><p id="target">before chosen after</p></main>',
      );
      expect(session.resolve(target).range?.toString()).toBe("chosen");
      expect(builds).toBe(2);
    } finally {
      session.dispose();
    }
  });

  it("fails closed after disposal and leaves no reusable reading index", () => {
    document.body.innerHTML =
      '<main><p id="target">before chosen after</p></main>';
    const target = captureText(selectRange("#target", 7, 13));
    let builds = 0;
    const session = new TextAnchorSession(document, {
      onIndexBuild: () => builds++,
    });
    session.resolve(target);
    expect(builds).toBe(1);
    session.dispose();
    expect(session.resolve(target).status).toBe("unresolved");
    expect(builds).toBe(1);
  });
});

function selectRange(selector: string, start: number, end: number): Range {
  const node = document.querySelector(selector)?.firstChild;
  if (!node) throw new Error(`No text node for ${selector}`);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}
