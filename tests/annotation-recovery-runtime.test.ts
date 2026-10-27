import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, Result } from "../src/core/model";
import type { WebInkDatabase } from "../src/background/database";

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;
let listener: Listener;
let db: WebInkDatabase;
let resetDatabase: () => void;
const annotation: Annotation = {
  id: "private-record", kind: "text", pageUrl: "https://private.example/article", pageTitle: "Private",
  color: "#facc15", note: "Private note", tags: [], revision: 7,
  createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
  target: { exact: "hello", prefix: "", suffix: "", start: 0, end: 5, rootSelector: "article" },
};

beforeEach(async () => {
  vi.resetModules();
  const database = await import("../src/background/database");
  db = new database.WebInkDatabase(`annotation-recovery-runtime-${crypto.randomUUID()}`);
  database.setDatabaseForTesting(db);
  resetDatabase = () => database.setDatabaseForTesting(undefined);
  await db.annotations.put(annotation);
  const event = () => ({ addListener() {} });
  vi.stubGlobal("defineBackground", (main: () => void) => ({ main }));
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ version: "0.3.14", commit: "a".repeat(40), dirty: false }) }));
  vi.stubGlobal("chrome", {
    runtime: {
      id: "web-ink-id", getURL: (path: string) => `chrome-extension://web-ink-id/${path}`,
      getManifest: () => ({ version: "0.3.14" }), onConnect: event(), onInstalled: event(), onStartup: event(),
      onMessage: { addListener: (value: Listener) => { listener = value; } }, sendMessage: async () => {},
    },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    permissions: { contains: async () => false, onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {} },
    tabs: { query: async () => [], onRemoved: event(), onUpdated: event(), onActivated: event() },
    sidePanel: { setPanelBehavior: async () => {} },
  });
  (await import("../entrypoints/background")).default.main();
});

afterEach(async () => {
  resetDatabase();
  db.close();
  await db.delete();
  vi.unstubAllGlobals();
});

function read(sender: chrome.runtime.MessageSender) {
  return new Promise<Result<Annotation | null>>((resolve) => {
    listener({ type: "annotations.get", id: annotation.id }, sender, (value) => resolve(value as Result<Annotation | null>));
  });
}

it("routes an ID read from the extension UI to the current record", async () => {
  expect(await read({ id: "web-ink-id", url: "chrome-extension://web-ink-id/library.html" }))
    .toEqual({ ok: true, data: annotation });
});

it.each([
  { id: "web-ink-id", url: "https://public.example/page", frameId: 0 },
  { id: "web-ink-id", url: "https://private.example/article", frameId: 0 },
  { id: "foreign-extension", url: "chrome-extension://web-ink-id/library.html" },
  { id: "web-ink-id", url: "chrome-extension://web-ink-id.evil/library.html" },
])("does not expose ID reads to an untrusted runtime sender: %j", async (sender) => {
  expect(await read(sender)).toMatchObject({ ok: false });
});
