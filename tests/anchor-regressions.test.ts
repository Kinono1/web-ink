import { describe, it, expect, vi } from "vitest";
import { textLinkUrl } from "../src/core/text-link";
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
  it("recaptures instead of saving a linked snapshot after the base changes", () => {
    document.body.innerHTML = '<main><a href="/video/one">Title</a></main>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const session = new TextAnchorSession(document);
    const base = document.createElement("base");
    try {
      session.capture(range);
      base.href = "https://changed.test/";
      document.head.append(base);
      const saved = session.captureSelected(range);
      expect(saved).toEqual(captureText(range));
      expect(textLinkUrl(saved, document.URL)).toBeUndefined();
    } finally {
      base.remove();
      session.dispose();
    }
  });

  it("invalidates a linked capture when its ancestor becomes editable", () => {
    document.body.innerHTML = '<main><a href="https://example.test/video/one">Title</a></main>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const session = new TextAnchorSession(document);
    try {
      const target = session.capture(range);
      document.querySelector("main")!.setAttribute("contenteditable", "true");
      expect(session.resolve(target).status).toBe("unresolved");
      expect(() => session.captureSelected(range)).toThrow("selection cannot be represented");
    } finally {
      session.dispose();
    }
  });

  it("refuses a relative linked scope when the document base changes its destination", () => {
    document.body.innerHTML = '<a href="/video/one">Title</a>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const session = new TextAnchorSession(document);
    const base = document.createElement("base");
    try {
      const target = session.capture(range);
      base.href = "https://changed.test/";
      document.head.append(base);
      expect(session.resolve(target).status).toBe("unresolved");
      base.remove();
      expect(session.resolve(target).range?.toString()).toBe("Title");
    } finally {
      base.remove();
      session.dispose();
    }
  });

  it("does not interpret noncanonical JSON escapes as a linked destination", () => {
    const rootSelector = 'a[href="https://example.test/\\u0061"]';
    expect(textLinkUrl({ rootSelector }, "https://example.test/feed")).toBeUndefined();
  });

  it("uses a linked content identity instead of a recycled DOM id", () => {
    document.body.innerHTML = '<a id="slot-one" href="https://example.test/video/one"><span id="title-one">Title</span></a>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("span")!);
    const target = captureText(range);
    document.body.innerHTML = '<a id="slot-two" href="https://example.test/video/one"><span id="title-two">Title</span></a>';
    expect(resolveText(target).range?.toString()).toBe("Title");
  });

  it("queries a shared linked scope only once per unchanged restore batch", () => {
    document.body.innerHTML = '<a href="https://example.test/video/one">Title</a>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const session = new TextAnchorSession(document);
    try {
      const target = session.capture(range);
      const query = vi.spyOn(document, "querySelectorAll");
      for (let i = 0; i < 20; i++) expect(session.resolve(target).status).toBe("located");
      expect(query.mock.calls.filter(([selector]) => selector === target.rootSelector)).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it("preserves a quoted relative link through selector lookup and URL reconstruction", () => {
    document.body.innerHTML = '<a>Title</a>';
    const link = document.querySelector("a")!;
    link.setAttribute("href", '/video/one?label="quoted"');
    const range = document.createRange();
    range.selectNodeContents(link);
    const target = captureText(range);
    expect(resolveText(target).range?.toString()).toBe("Title");
    expect(textLinkUrl(target, "https://example.test/feed")).toBe("https://example.test/video/one?label=%22quoted%22");
  });

  it("never turns unsafe or arbitrary imported selectors into navigation links", () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'https://name:secret@example.test/', 'https://example.test/\npath']) {
      expect(textLinkUrl({ rootSelector: `a[href=${JSON.stringify(href)}]` } as TextTarget, "https://example.test/feed")).toBeUndefined();
    }
    expect(textLinkUrl({ rootSelector: 'body, a[href="https://example.test/video/one"]' } as TextTarget, "https://example.test/feed")).toBeUndefined();
  });

  it("restores a linked recommendation after neighbouring cards change", () => {
    document.body.innerHTML = '<main><p>Previous recommendation</p><a href="https://example.test/video/one">A saved recommendation</a><p>Next recommendation</p></main>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const session = new TextAnchorSession(document);
    try {
      const target = session.capture(range);
      document.querySelector("main")!.innerHTML = '<p>New preceding recommendation</p><a href="https://example.test/video/one">A saved recommendation</a><p>New following recommendation</p>';
      expect(session.resolve(target).range?.toString()).toBe("A saved recommendation");
    } finally {
      session.dispose();
    }
  });

  it("does not move a linked title to a different video with identical text", () => {
    document.body.innerHTML = '<main><a href="https://example.test/video/one">Same title</a></main>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const target = captureText(range);
    document.querySelector("a")!.href = "https://example.test/video/two";
    expect(resolveText(target).status).toBe("unresolved");
  });

  it("keeps missing recommendations unresolved and restores only their original link when it returns", () => {
    document.body.innerHTML = '<a href="https://example.test/video/one">A saved recommendation</a>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const target = captureText(range);
    document.body.innerHTML = '<a href="https://example.test/video/two">A saved recommendation</a>';
    expect(resolveText(target).status).toBe("unresolved");
    document.body.insertAdjacentHTML("beforeend", '<a href="https://example.test/video/one"><span>A saved recommendation</span></a>');
    const result = resolveText(target);
    expect(result.status).toBe("located");
    expect(result.range?.startContainer.parentElement?.closest("a")?.href).toBe("https://example.test/video/one");
  });

  it("ignores empty thumbnail links but rejects duplicate matching titles", () => {
    document.body.innerHTML = '<a href="https://example.test/video/one">Title</a>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    const target = captureText(range);
    document.body.innerHTML = '<a href="https://example.test/video/one"><img alt="Thumbnail"></a><a href="https://example.test/video/one">Title</a>';
    expect(resolveText(target).range?.toString()).toBe("Title");
    document.body.insertAdjacentHTML("beforeend", '<a href="https://example.test/video/one">Title</a>');
    expect(resolveText(target).status).toBe("unresolved");
  });

  it("does not rebuild a linked reading index for unrelated feed mutations", () => {
    document.body.innerHTML = '<main><a href="https://example.test/video/one">Title</a><p id="other">Views: 1</p></main>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("a")!);
    let builds = 0;
    const session = new TextAnchorSession(document, { onIndexBuild: () => builds++ });
    try {
      const target = session.capture(range);
      document.querySelector("#other")!.textContent = "Views: 2";
      expect(session.resolve(target).range?.toString()).toBe("Title");
      expect(builds).toBe(1);
    } finally {
      session.dispose();
    }
  });

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

  it("recaptures offsets and context after a pending sibling insertion", () => {
    document.body.innerHTML =
      '<main id="story"><p id="target">before chosen after</p></main>';
    let builds = 0;
    const session = new TextAnchorSession(document, {
      onIndexBuild: () => builds++,
    });
    try {
      const range = selectRange("#target", 7, 13);
      const before = session.capture(range);
      document
        .querySelector("#target")!
        .insertAdjacentHTML("beforebegin", "<p>new preceding context</p>");
      const after = session.captureSelected(range);
      expect(after.exact).toBe("chosen");
      expect(after.start).toBeGreaterThan(before.start);
      expect(after.prefix).toContain("new preceding context");
      expect(session.resolve(after).range?.toString()).toBe("chosen");
      expect(builds).toBe(2);
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
