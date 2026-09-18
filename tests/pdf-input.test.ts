import { afterEach, expect, it, vi } from "vitest";
import { MAX_PDF_BYTES, readRemotePdf } from "../src/pdf/source";

afterEach(() => vi.unstubAllGlobals());

function provideResponse(body: ReadableStream<Uint8Array>, headers = {}) {
  vi.stubGlobal("chrome", { permissions: { contains: async () => true } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { headers })),
  );
}

it("joins unknown-length chunks and releases the stream lock", async () => {
  const pieces = ["%PDF-1.7\n", "unknown ", "length"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces)
        controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    },
  });
  provideResponse(body);
  const result = await readRemotePdf(
    "https://example.test/a.pdf",
    new AbortController().signal,
  );
  expect(new TextDecoder().decode(result)).toBe(pieces.join(""));
  expect(body.locked).toBe(false);
});

it.each([{}, { "content-encoding": "gzip", "content-length": "20" }])(
  "enforces the decoded output limit when length is unavailable or compressed: %j",
  async (headers) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PDF_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    provideResponse(body, headers);
    await expect(
      readRemotePdf("https://example.test/a.pdf", new AbortController().signal),
    ).rejects.toThrow("50 MiB");
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  },
);

it("rejects an identity body larger than its declared length without retaining the reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("%PDF-1.7\nmore bytes"));
    },
    cancel() {
      cancelled = true;
    },
  });
  provideResponse(body, { "content-length": "9" });
  await expect(
    readRemotePdf("https://example.test/a.pdf", new AbortController().signal),
  ).rejects.toThrow("Content-Length");
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it("rejects an interrupted stream and allows a subsequent independent input", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  provideResponse(body, { "content-length": "100" });
  const aborted = readRemotePdf(
    "https://example.test/a.pdf",
    new AbortController().signal,
  );
  stream!.error(new DOMException("The input was interrupted", "AbortError"));
  await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  expect(body.locked).toBe(false);
  const next = new TextEncoder().encode("%PDF-1.7\nnext input");
  provideResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(next);
        controller.close();
      },
    }),
  );
  const result = await readRemotePdf(
    "https://example.test/b.pdf",
    new AbortController().signal,
  );
  expect(Array.from(result)).toEqual(Array.from(next));
});
