// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreparedPdfStore,
  type Owner,
  type PreparedPdfStore,
} from "../src/background/pdf-prepared";
import { MAX_PDF_BYTES } from "../src/core/pdf-source";

const SOURCE: Owner = { tabId: 7, documentId: "source-document", generation: "worker-generation" };
const READER: Owner = { ...SOURCE, documentId: "reader-document" };
const SMALL = new TextEncoder().encode("%PDF-1.7\nhello prepared reader\n%%EOF\n");
const SMALL_HASH = "9742166a4f490dd101782117fba9696c1f057c89358d2df3dbb680de88b3b569";
let store: PreparedPdfStore;

const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function largePdf(): Uint8Array {
  const bytes = new Uint8Array(524_305);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 17) % 256;
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  return bytes;
}
async function ready(bytes: Uint8Array = SMALL) {
  const token = store.begin(SOURCE);
  for (let offset = 0, index = 0; offset < bytes.length; offset += 262_144, index++)
    store.append(token, SOURCE, index, encoded(bytes.subarray(offset, offset + 262_144)));
  return store.finish(token, SOURCE, bytes.length);
}

function pauseDigest() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const observed = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
    const result = await digest(algorithm, bytes);
    started();
    await gate;
    return result;
  });
  return { started: observed, resume };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
  store = createPreparedPdfStore(SOURCE.generation);
});
afterEach(() => {
  store?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prepared PDF upload validation", () => {
  it("round-trips irregular upload chunks into three fixed reader chunks", async () => {
    const bytes = largePdf();
    const token = store.begin(SOURCE);
    const ends = [5, 200_005, 462_149, 524_305];
    let offset = 0;
    ends.forEach((end, index) => {
      store.append(token, SOURCE, index, encoded(bytes.subarray(offset, end)));
      offset = end;
    });
    const info = await store.finish(token, SOURCE, 524_305);
    expect(info).toEqual({
      token,
      byteLength: 524_305,
      hash: "b3c377cced11c9ea8b87dbd43c4b15f35d98a220c07291102f942f90deed5018",
      chunks: 3,
    });
    expect(store.claim(token, READER)).toEqual(info);
    const chunks = [0, 1, 2].map(index => store.chunk(token, READER, index));
    expect(chunks[2]).toBe("ETBPbo2sy+oJKEdmhaTD4gE=");
    const decoded = chunks.map(value => Buffer.from(value, "base64"));
    expect(decoded.map(value => value.length)).toEqual([262_144, 262_144, 17]);
    expect(Buffer.concat(decoded)).toEqual(Buffer.from(bytes));
  });

  it("hashes all bytes and returns metadata without mutable store references", async () => {
    const info = await ready();
    expect(info).toEqual({ token: info.token, byteLength: 37, hash: SMALL_HASH, chunks: 1 });
    const token = info.token;
    info.hash = "changed";
    info.byteLength = 0;
    info.chunks = 0;
    expect(store.claim(token, READER)).toEqual({ token, byteLength: 37, hash: SMALL_HASH, chunks: 1 });
  });

  it("accepts many small chunks without changing the final byte order", async () => {
    const token = store.begin(SOURCE);
    SMALL.forEach((byte, index) => store.append(token, SOURCE, index, encoded(Uint8Array.of(byte))));
    expect(await store.finish(token, SOURCE, 37)).toEqual({ token, byteLength: 37, hash: SMALL_HASH, chunks: 1 });
    store.claim(token, READER);
    expect(store.chunk(token, READER, 0)).toBe(encoded(SMALL));
  });

  it.each(["", " ", "%", "YQ", "YQ=", "YR==", "YWJ=", "Y Q==", "YQ==\n", "YQ====", "====", "-w==", "_w==", 123, null])(
    "rejects empty or noncanonical base64 %j without advancing upload index",
    async payload => {
      const token = store.begin(SOURCE);
      expect(() => store.append(token, SOURCE, 0, payload as string)).toThrow();
      store.append(token, SOURCE, 0, encoded(SMALL));
      expect((await store.finish(token, SOURCE, 37)).hash).toBe(SMALL_HASH);
    },
  );

  it("rejects a decoded chunk over 256 KiB without discarding valid bytes", async () => {
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(SMALL));
    expect(() => store.append(token, SOURCE, 1, encoded(new Uint8Array(262_145)))).toThrow("256 KiB");
    expect((await store.finish(token, SOURCE, 37)).hash).toBe(SMALL_HASH);
  });

  it.each([0, 2, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects duplicate, future, or invalid upload index %s without advancing state",
    async index => {
      const token = store.begin(SOURCE);
      store.append(token, SOURCE, 0, encoded(SMALL.subarray(0, 5)));
      expect(() => store.append(token, SOURCE, index, encoded(SMALL))).toThrow(/index/i);
      store.append(token, SOURCE, 1, encoded(SMALL.subarray(5)));
      expect((await store.finish(token, SOURCE, 37)).hash).toBe(SMALL_HASH);
    },
  );

  it.each([
    { ...SOURCE, tabId: 8 },
    { ...SOURCE, documentId: "replacement-source" },
    { ...SOURCE, generation: "old-generation" },
  ])("blocks source impersonation by %j without destroying the upload", async owner => {
    const token = store.begin(SOURCE);
    expect(() => store.append(token, owner, 0, encoded(SMALL))).toThrow();
    await expect(store.finish(token, owner, 37)).rejects.toThrow();
    expect(store.peekToken(7)).toBe(token);
    store.append(token, SOURCE, 0, encoded(SMALL));
    expect((await store.finish(token, SOURCE, 37)).hash).toBe(SMALL_HASH);
  });

  it("does not destroy a legitimate upload when an unknown token is supplied", async () => {
    const token = store.begin(SOURCE);
    const unknown = crypto.randomUUID();
    expect(() => store.append(unknown, SOURCE, 0, encoded(SMALL))).toThrow();
    await expect(store.finish(unknown, SOURCE, 37)).rejects.toThrow();
    store.append(token, SOURCE, 0, encoded(SMALL));
    expect((await store.finish(token, SOURCE, 37)).hash).toBe(SMALL_HASH);
  });

  it("releases an incomplete upload when expected and actual lengths differ", async () => {
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(SMALL));
    await expect(store.finish(token, SOURCE, 38)).rejects.toThrow(/length/i);
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => store.begin(SOURCE)).not.toThrow();
  });

  it("releases an empty upload even when a positive expected length is supplied", async () => {
    const token = store.begin(SOURCE);
    await expect(store.finish(token, SOURCE, 1)).rejects.toThrow(/length/i);
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 0.5, NaN, undefined, MAX_PDF_BYTES + 1])(
    "releases an owned upload with invalid expected byte length %s",
    async expected => {
      const token = store.begin(SOURCE);
      store.append(token, SOURCE, 0, encoded(SMALL));
      await expect(store.finish(token, SOURCE, expected as number)).rejects.toThrow(/length/i);
      expect(store.peekToken(7)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a header-only partial upload using the mandatory expected length", async () => {
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(new TextEncoder().encode("%PDF-1.7\n")));
    await expect(store.finish(token, SOURCE, 37)).rejects.toThrow(/length/i);
    expect(store.peekToken(7)).toBeUndefined();
  });

  it("uses shared PDF validation and releases a login page response", async () => {
    const bytes = new TextEncoder().encode("<html>Sign in</html>");
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(bytes));
    await expect(store.finish(token, SOURCE, bytes.length)).rejects.toThrow("not a PDF");
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps decoded total bytes at 50 MiB and preserves the valid exact-limit upload", async () => {
    const token = store.begin(SOURCE);
    const page = new Uint8Array(262_144).fill(120);
    const first = page.slice();
    first.set(new TextEncoder().encode("%PDF-1.7\n"));
    store.append(token, SOURCE, 0, encoded(first));
    const repeated = encoded(page);
    for (let index = 1; index < 200; index++) store.append(token, SOURCE, index, repeated);
    expect(() => store.append(token, SOURCE, 200, "eA==")).toThrow("50 MiB");
    const info = await store.finish(token, SOURCE, 52_428_800);
    expect(info.byteLength).toBe(52_428_800);
    expect(info.chunks).toBe(200);
    store.claim(token, READER);
    expect(Buffer.from(store.chunk(token, READER, 0), "base64")).toEqual(Buffer.from(first));
  });
});

describe("prepared PDF reader authority", () => {
  it("refuses claims until byte verification and hashing finish", () => {
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(SMALL));
    expect(() => store.claim(token, READER)).toThrow(/ready/i);
    expect(store.peekToken(7)).toBe(token);
  });

  it.each([SOURCE, { ...READER, tabId: 8 }, { ...READER, generation: "old-generation" }])(
    "refuses the source document or wrong reader authority %j", async reader => {
      const { token } = await ready();
      expect(() => store.claim(token, reader)).toThrow();
      expect(store.claim(token, READER).hash).toBe(SMALL_HASH);
    },
  );

  it("requires a bound claim before delivering any chunk", async () => {
    const { token } = await ready();
    expect(() => store.chunk(token, READER, 0)).toThrow();
    expect(() => store.chunk(token, SOURCE, 0)).toThrow();
    expect(() => store.release(token, READER)).toThrow();
    store.claim(token, READER);
    expect(store.chunk(token, READER, 0)).toBe(encoded(SMALL));
  });

  it("binds only the first reader document and copies its identity", async () => {
    const info = await ready();
    const mutable = { ...READER };
    expect(store.claim(info.token, mutable)).toEqual(info);
    mutable.documentId = "replacement-reader";
    expect(() => store.claim(info.token, mutable)).toThrow();
    expect(() => store.chunk(info.token, mutable, 0)).toThrow();
    expect(() => store.release(info.token, mutable)).toThrow();
    expect(store.claim(info.token, READER)).toEqual(info);
    expect(store.chunk(info.token, READER, 0)).toBe(encoded(SMALL));
    store.release(info.token, READER);
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only the next chunk or the immediately prior chunk retry", async () => {
    const { token } = await ready(largePdf());
    store.claim(token, READER);
    expect(() => store.chunk(token, READER, 1)).toThrow(/index/i);
    const first = store.chunk(token, READER, 0);
    expect(store.chunk(token, READER, 0)).toBe(first);
    const second = store.chunk(token, READER, 1);
    expect(store.chunk(token, READER, 1)).toBe(second);
    expect(() => store.chunk(token, READER, 0)).toThrow(/index/i);
    store.claim(token, READER);
    expect(store.chunk(token, READER, 2)).toBe("ETBPbo2sy+oJKEdmhaTD4gE=");
    expect(() => store.chunk(token, READER, 3)).toThrow(/index/i);
  });

  it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid reader index %s", async index => {
    const { token } = await ready();
    store.claim(token, READER);
    expect(() => store.chunk(token, READER, index)).toThrow(/index/i);
    expect(store.chunk(token, READER, 0)).toBe(encoded(SMALL));
  });

  it.each([{ ...READER, tabId: 8 }, { ...READER, generation: "old-generation" }, SOURCE])(
    "rejects chunk delivery to the wrong actor %j", async actor => {
      const { token } = await ready();
      store.claim(token, READER);
      expect(() => store.chunk(token, actor, 0)).toThrow();
      expect(store.chunk(token, READER, 0)).toBe(encoded(SMALL));
    },
  );

  it("starts a fresh 120-second ready TTL without renewing it on claim or retry", async () => {
    const token = store.begin(SOURCE);
    vi.advanceTimersByTime(59_000);
    store.append(token, SOURCE, 0, encoded(SMALL));
    await store.finish(token, SOURCE, 37);
    vi.advanceTimersByTime(119_999);
    store.claim(token, READER);
    store.chunk(token, READER, 0);
    store.chunk(token, READER, 0);
    expect(store.peekToken(7)).toBe(token);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(store.peekToken(7)).toBeUndefined();
    expect(() => store.claim(token, READER)).toThrow();
    expect(() => store.chunk(token, READER, 0)).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an old token after release and a new upload", async () => {
    const { token } = await ready();
    store.claim(token, READER);
    store.release(token, SOURCE);
    const replacement = store.begin(SOURCE);
    expect(() => store.chunk(token, READER, 0)).toThrow();
    expect(() => store.claim(token, READER)).toThrow();
    expect(store.peekToken(7)).toBe(replacement);
  });

  it("rejects further writes or finish calls without clearing a ready record", async () => {
    const { token } = await ready();
    expect(() => store.append(token, SOURCE, 1, encoded(SMALL))).toThrow(/closed/i);
    await expect(store.finish(token, SOURCE, 37)).rejects.toThrow(/closed/i);
    expect(store.claim(token, READER).hash).toBe(SMALL_HASH);
    expect(store.chunk(token, READER, 0)).toBe(encoded(SMALL));
  });
});

describe("prepared PDF asynchronous finish", () => {
  it("locks the upload while hashing and publishes only after hashing succeeds", async () => {
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(SMALL));
    const digest = pauseDigest();
    const task = store.finish(token, SOURCE, 37);
    await digest.started;
    try {
      expect(() => store.begin({ ...SOURCE, tabId: 8 })).toThrow(/busy/i);
      expect(() => store.append(token, SOURCE, 1, encoded(SMALL))).toThrow(/closed/i);
      await expect(store.finish(token, SOURCE, 37)).rejects.toThrow(/closed/i);
      expect(() => store.claim(token, READER)).toThrow(/ready/i);
      expect(() => store.release(token, { ...SOURCE, documentId: "attacker" })).toThrow();
      expect(store.peekToken(7)).toBe(token);
    } finally {
      digest.resume();
    }
    expect(await task).toEqual({ token, byteLength: 37, hash: SMALL_HASH, chunks: 1 });
  });

  it.each(["source release", "tab removal", "dispose", "upload expiry", "expiry without callback"])(
    "does not resurrect a canceled upload after %s during hashing", async cancellation => {
      const token = store.begin(SOURCE);
      store.append(token, SOURCE, 0, encoded(SMALL));
      const digest = pauseDigest();
      const task = store.finish(token, SOURCE, 37);
      const outcome = task.catch(error => error as Error);
      await digest.started;
      let replacement: string | undefined;
      try {
        if (cancellation === "source release") store.release(token, SOURCE);
        else if (cancellation === "tab removal") store.releaseTab(7);
        else if (cancellation === "dispose") store.dispose();
        else if (cancellation === "upload expiry") vi.advanceTimersByTime(60_000);
        else vi.setSystemTime(new Date("2026-10-12T00:01:00Z"));
        if (cancellation !== "expiry without callback") {
          expect(store.peekToken(7)).toBeUndefined();
          expect(vi.getTimerCount()).toBe(0);
        }
        if (cancellation !== "dispose" && cancellation !== "expiry without callback") replacement = store.begin(SOURCE);
      } finally {
        digest.resume();
      }
      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/available/i);
      expect(store.peekToken(7)).toBe(replacement);
      expect(vi.getTimerCount()).toBe(replacement ? 1 : 0);
    },
  );

  it("releases the authenticated upload if hashing fails", async () => {
    const token = store.begin(SOURCE);
    store.append(token, SOURCE, 0, encoded(SMALL));
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(Error("Hash failed."));
    await expect(store.finish(token, SOURCE, 37)).rejects.toThrow("Hash failed.");
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => store.begin(SOURCE)).not.toThrow();
  });
});

describe("prepared PDF ownership and lifetime", () => {
  it("creates a UUID and exposes it only for the source tab", () => {
    const token = store.begin(SOURCE);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(store.peekToken(7)).toBe(token);
    expect(store.peekToken(8)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    null,
    [],
    { ...SOURCE, tabId: -1 },
    { ...SOURCE, tabId: 1.5 },
    { ...SOURCE, tabId: Number.MAX_SAFE_INTEGER + 1 },
    { ...SOURCE, documentId: "" },
    { ...SOURCE, documentId: " " },
    { ...SOURCE, generation: "old-generation" },
  ].map(owner => ({ owner })))("rejects invalid owner $owner without acquiring the slot", ({ owner }) => {
    expect(() => store.begin(owner as Owner)).toThrow();
    expect(store.peekToken(7)).toBeUndefined();
    expect(() => store.begin(SOURCE)).not.toThrow();
  });

  it.each(["", " ", undefined])("rejects an empty factory generation %j", generation => {
    expect(() => createPreparedPdfStore(generation as string)).toThrow("generation");
  });

  it("rejects a second begin from any tab while the one slot is occupied", () => {
    const token = store.begin(SOURCE);
    expect(() => store.begin(SOURCE)).toThrow(/busy/i);
    expect(() => store.begin({ ...SOURCE, tabId: 8 })).toThrow(/busy/i);
    expect(store.peekToken(7)).toBe(token);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("expires an upload at 60 seconds and permits a fresh upload", () => {
    const first = store.begin(SOURCE);
    vi.advanceTimersByTime(59_999);
    expect(store.peekToken(7)).toBe(first);
    vi.advanceTimersByTime(1);
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.begin(SOURCE)).not.toBe(first);
  });

  it("keeps an uploading PDF available beyond 60 seconds after source activity", async () => {
    const token = store.begin(SOURCE);
    vi.advanceTimersByTime(59_000);
    store.touch(token, SOURCE);
    vi.advanceTimersByTime(59_000);
    store.append(token, SOURCE, 0, encoded(SMALL));

    expect((await store.finish(token, SOURCE, SMALL.length)).hash).toBe(SMALL_HASH);
  });

  it("does not renew an upload after a rejected chunk", () => {
    const token = store.begin(SOURCE);
    vi.advanceTimersByTime(59_999);
    expect(() => store.append(token, SOURCE, 0, "not-base64")).toThrow();
    vi.advanceTimersByTime(1);

    expect(store.peekToken(7)).toBeUndefined();
  });

  it("rejects foreign activity without extending the upload TTL", () => {
    const token = store.begin(SOURCE);
    vi.advanceTimersByTime(59_999);
    expect(() => store.touch(token, { ...SOURCE, documentId: "attacker" })).toThrow(/belongs/i);
    vi.advanceTimersByTime(1);

    expect(store.peekToken(7)).toBeUndefined();
  });

  it("cannot extend the 120-second ready TTL with upload activity", async () => {
    const { token } = await ready();
    vi.advanceTimersByTime(119_999);
    expect(() => store.touch(token, SOURCE)).toThrow(/closed/i);
    vi.advanceTimersByTime(1);

    expect(store.peekToken(7)).toBeUndefined();
  });

  it("enforces expiry even if a timer callback has not run", () => {
    store.begin(SOURCE);
    vi.setSystemTime(new Date("2026-10-12T00:01:00Z"));
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => store.begin(SOURCE)).not.toThrow();
  });

  it("copies source identity and rejects release by another document", () => {
    const mutable = { ...SOURCE };
    const token = store.begin(mutable);
    mutable.documentId = "replacement-document";
    expect(() => store.release(token, mutable)).toThrow();
    expect(() => store.release(token, { ...SOURCE, tabId: 8 })).toThrow();
    expect(() => store.release(token, { ...SOURCE, generation: "old-generation" })).toThrow();
    expect(store.peekToken(7)).toBe(token);
    store.release(token, SOURCE);
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats unknown release tokens as idempotent without clearing current data", () => {
    const token = store.begin(SOURCE);
    store.release(crypto.randomUUID(), { ...SOURCE, documentId: "other-document" });
    expect(store.peekToken(7)).toBe(token);
    store.release(token, SOURCE);
    expect(() => store.release(token, SOURCE)).not.toThrow();
  });

  it("releases only the trusted lifecycle tab", () => {
    const token = store.begin(SOURCE);
    store.releaseTab(8);
    expect(store.peekToken(7)).toBe(token);
    store.releaseTab(7);
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes timers and permanently stops accepting uploads", () => {
    const token = store.begin(SOURCE);
    store.dispose();
    store.dispose();
    expect(store.peekToken(7)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => store.begin(SOURCE)).toThrow(/disposed/i);
    expect(() => store.release(token, SOURCE)).not.toThrow();
  });
});
