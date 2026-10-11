import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageContextError } from "../src/background/content-page";
import { createFloatingActionHandler } from "../src/background/floating-actions";

const ID = "web-ink-id";
const ownUrl = (path: string) => `chrome-extension://${ID}/${path}`;
const sender = (
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender => ({
  id: ID,
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
  url: "https://example.test/article",
  tab: { id: 7 } as chrome.tabs.Tab,
  ...overrides,
});

let open: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  open = vi.fn().mockResolvedValue(undefined);
  create = vi.fn().mockResolvedValue({ id: 8 });
  vi.stubGlobal("chrome", {
    runtime: { id: ID, getURL: ownUrl },
    sidePanel: { open },
    tabs: { create },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("floating action navigation", () => {
  it("opens the sidebar synchronously after validating the sender", async () => {
    const resolve = vi.fn(() => new Promise<string>(() => {}));
    const action = createFloatingActionHandler(resolve)({
      type: "ui.open",
      target: "sidebar",
    }, sender());

    expect(open).toHaveBeenCalledWith({ tabId: 7 });
    expect(resolve).not.toHaveBeenCalled();
    await expect(action).resolves.toEqual({ ok: true, data: true });
  });

  it.each([
    ["library", "library.html"],
    ["local-pdf", "pdf.html?open=local"],
  ] as const)("opens only the fixed %s destination after resolving the page", async (target, path) => {
    const resolve = vi.fn().mockResolvedValue("https://example.test/article");
    const result = await createFloatingActionHandler(resolve)({
      type: "ui.open",
      target,
    }, sender());

    expect(result).toEqual({ ok: true, data: true });
    expect(create).toHaveBeenCalledWith({ url: ownUrl(path) });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign runtime", sender({ id: "other-extension" })],
    ["subframe", sender({ frameId: 1 })],
    ["missing document", sender({ documentId: undefined })],
    ["inactive document", sender({ documentLifecycle: "cached" })],
    ["extension page", sender({ url: ownUrl("sidepanel.html") })],
  ])("rejects %s before resolving or navigating", async (_name, source) => {
    const resolve = vi.fn();
    const result = await createFloatingActionHandler(resolve)({
      type: "ui.open",
      target: "library",
    }, source);

    expect(result.ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    { type: "ui.open", target: "library", url: "https://attacker.test/" },
    { type: "ui.open", target: "local-pdf", tabId: 22 },
    { type: "ui.open", target: "sidebar", targetUrl: ownUrl("library.html") },
    { type: "ui.open", target: "unknown" },
  ])("rejects an unrecognized or over-specified request %j", async (request) => {
    const resolve = vi.fn();
    const result = await createFloatingActionHandler(resolve)(request, sender());

    expect(result.ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["library", "local-pdf"] as const)("does not create a tab when the sending %s document is stale", async (target) => {
    const resolve = vi.fn().mockRejectedValue(new PageContextError());
    const result = await createFloatingActionHandler(resolve)({ type: "ui.open", target }, sender());

    expect(result).toMatchObject({ ok: false, code: "PAGE_CHANGED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns Chrome API failures to the caller", async () => {
    create.mockRejectedValueOnce(new Error("tabs denied"));
    const resolve = vi.fn().mockResolvedValue("https://example.test/article");
    const library = await createFloatingActionHandler(resolve)({ type: "ui.open", target: "library" }, sender());
    open.mockRejectedValueOnce(new Error("panel denied"));
    const sidebar = await createFloatingActionHandler(resolve)({ type: "ui.open", target: "sidebar" }, sender());

    expect(library).toMatchObject({ ok: false, error: "tabs denied" });
    expect(sidebar).toMatchObject({ ok: false, error: "panel denied" });
  });
});
