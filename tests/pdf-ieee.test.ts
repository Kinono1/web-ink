import { afterEach, expect, it, vi } from "vitest";
import { MAX_PDF_BYTES } from "../src/pdf/source";
import { readIeeePdf } from "../src/pdf/ieee";

const pageUrl = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
const sourceUrl = "https://ieeexplore.ieee.org/observed-file?ticket=fixture";
const pdf = new TextEncoder().encode("%PDF-1.7\nIEEE fixture");

afterEach(() => vi.unstubAllGlobals());

function read(input: { pageUrl: string; sourceUrl?: string } = { pageUrl, sourceUrl }, signal = new AbortController().signal): Promise<Uint8Array> {
  return readIeeePdf(input, signal);
}

function provideFetch(responses: Response[], allowed = true) {
  const contains = vi.fn(async () => allowed);
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => {
    const response = responses.shift();
    if (!response) throw Error("Unexpected request");
    return response;
  });
  vi.stubGlobal("chrome", { permissions: { contains } });
  vi.stubGlobal("fetch", fetcher);
  return { contains, fetcher };
}

it("reads an observed same-origin source with permission and isolated session fetch options", async () => {
  const { contains, fetcher } = provideFetch([new Response(pdf)]);
  const signal = new AbortController().signal;
  expect(Array.from(await read({ pageUrl, sourceUrl }, signal))).toEqual(Array.from(pdf));
  expect(contains).toHaveBeenCalledWith({ origins: ["https://ieeexplore.ieee.org/*"] });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(sourceUrl), {
    signal, credentials: "include", cache: "no-store", redirect: "error",
  });
});

it("accepts a validated direct-source page without a wrapper or .pdf suffix", async () => {
  provideFetch([new Response(pdf)]);
  expect(Array.from(await read({ pageUrl: sourceUrl, sourceUrl }))).toEqual(Array.from(pdf));
});

it.each([
  { pageUrl: "https://example.test/a.pdf", sourceUrl },
  { pageUrl: "https://ieeexplore.ieee.org/document/123", sourceUrl },
  { pageUrl: "http://ieeexplore.ieee.org/stamp/stamp.jsp", sourceUrl },
  { pageUrl: "https://user@ieeexplore.ieee.org/stamp/stamp.jsp", sourceUrl },
  { pageUrl: "https://@ieeexplore.ieee.org/stamp/stamp.jsp", sourceUrl },
  { pageUrl: "https:////@ieeexplore.ieee.org/stamp/stamp.jsp", sourceUrl },
  { pageUrl, sourceUrl: "https:@ieeexplore.ieee.org/observed-file?ticket=fixture" },
  { pageUrl, sourceUrl: "https://other.ieee.org/paper.pdf" },
  { pageUrl, sourceUrl: "https://ieeexplore.ieee.org:8443/paper.pdf" },
  { pageUrl, sourceUrl: "https://user:secret@ieeexplore.ieee.org/paper.pdf" },
  { pageUrl, sourceUrl: "http://ieeexplore.ieee.org/paper.pdf" },
  { pageUrl: "https://ieeexplore.ieee.org/document/123" },
])("rejects untrusted page/source input before any request: %j", async (input) => {
  const { fetcher, contains } = provideFetch([]);
  await expect(read(input)).rejects.toMatchObject({ reason: "source-hidden" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(contains).not.toHaveBeenCalled();
});

it("does not fetch when IEEE host permission has not been granted", async () => {
  const { fetcher } = provideFetch([], false);
  await expect(read()).rejects.toMatchObject({ reason: "site-permission" });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  '<iframe src="/observed-file?ticket=fixture"></iframe>',
  '<embed src="/observed-file?ticket=fixture" type="application/pdf">',
  '<object data="/observed-file?ticket=fixture" type="application/pdf"></object>',
])("reads the actual wrapper element without requiring a PDF extension: %s", async (html) => {
  const { fetcher, contains } = provideFetch([new Response(html), new Response(pdf)]);
  expect(Array.from(await read({ pageUrl }))).toEqual(Array.from(pdf));
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([pageUrl, sourceUrl]);
  expect(contains).toHaveBeenCalledTimes(2);
});

it("deduplicates actual candidates and decodes HTML attributes using the wrapper URL", async () => {
  const html = '<base href="https://example.test/"><iframe src="/observed-file?a=1&amp;b=2#page=1"></iframe><object data="/observed-file?a=1&amp;b=2"></object>';
  const { fetcher } = provideFetch([new Response(html), new Response(pdf)]);
  expect(Array.from(await read({ pageUrl }))).toEqual(Array.from(pdf));
  expect(String(fetcher.mock.calls[1]![0])).toBe("https://ieeexplore.ieee.org/observed-file?a=1&b=2");
});

it.each([
  '<iframe src="https://example.test/paper.pdf"></iframe>',
  '<script>document.write(\'<iframe src="/guessed.pdf"></iframe>\')</script>',
  '<form><input type="password"></form>',
  '<iframe src="/first-file"></iframe><embed src="/second-file">',
])("stops at the wrapper when no unique actual same-origin source is available: %s", async (html) => {
  const { fetcher } = provideFetch([new Response(html)]);
  await expect(read({ pageUrl })).rejects.toMatchObject({ reason: "source-hidden" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  [401, "login-required"],
  [403, "access-restricted"],
  [302, "redirect-blocked"],
  [500, "network"],
])("classifies an observed HTTP %s without inferring a subscription state", async (status, reason) => {
  provideFetch([new Response("", { status: status as number })]);
  await expect(read()).rejects.toMatchObject({ reason });
});

it("rejects HTML returned as a direct PDF response", async () => {
  provideFetch([new Response('<html><form><input type="password"></form></html>')]);
  await expect(read()).rejects.toMatchObject({ reason: "not-pdf" });
});

it("keeps an opaque fetch rejection as network without copying an ephemeral URL into the error", async () => {
  vi.stubGlobal("chrome", { permissions: { contains: async () => true } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw TypeError(`Fetch failed for ${sourceUrl}`); }));
  const error = await read().catch((failure) => failure);
  expect(error).toMatchObject({ reason: "network" });
  expect(error.message).not.toContain("fixture");
  expect(error.message).not.toContain(sourceUrl);
});

it("rechecks permission before fetching the candidate discovered in a wrapper", async () => {
  const { contains, fetcher } = provideFetch([new Response('<iframe src="/observed-file?ticket=fixture"></iframe>')]);
  contains.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(read({ pageUrl })).rejects.toMatchObject({ reason: "site-permission" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects a redirected response and cancels its unused body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const response = new Response(body);
  Object.defineProperty(response, "url", { value: "https://example.test/login" });
  provideFetch([response]);
  await expect(read()).rejects.toMatchObject({ reason: "redirect-blocked" });
  expect(cancelled).toBe(true);
});

it("does not treat HTTP 304 as an observed redirect", async () => {
  provideFetch([new Response(null, { status: 304 })]);
  await expect(read()).rejects.toMatchObject({ reason: "network" });
});

it("rejects an HTML MIME response even when its text mentions a PDF header", async () => {
  provideFetch([new Response('<html><!-- %PDF-1.7 --><form><input type="password"></form></html>', { headers: { "content-type": "text/html" } })]);
  await expect(read()).rejects.toMatchObject({ reason: "not-pdf" });
});

it.each([
  { input: { pageUrl }, limit: 1024 * 1024, headers: new Headers() },
  { input: { pageUrl }, limit: 1024 * 1024, headers: new Headers({ "content-encoding": "gzip", "content-length": "10" }) },
  { input: { pageUrl, sourceUrl }, limit: MAX_PDF_BYTES, headers: new Headers() },
  { input: { pageUrl, sourceUrl }, limit: MAX_PDF_BYTES, headers: new Headers({ "content-encoding": "gzip", "content-length": "10" }) },
])("bounds decoded response bytes and cancels the stream at $limit bytes", async ({ input, limit, headers }) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(limit + 1)); },
    cancel() { cancelled = true; },
  });
  provideFetch([new Response(body, { headers })]);
  await expect(read(input)).rejects.toMatchObject({ reason: "network" });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it.each([
  { input: { pageUrl }, limit: 1024 * 1024 },
  { input: { pageUrl, sourceUrl }, limit: MAX_PDF_BYTES },
])("rejects excessive identity Content-Length before locking the stream", async ({ input, limit }) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  provideFetch([new Response(body, { headers: { "content-length": String(limit + 1) } })]);
  await expect(read(input)).rejects.toMatchObject({ reason: "network" });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it("rejects a dishonest Content-Length and releases the PDF stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(pdf); },
    cancel() { cancelled = true; },
  });
  provideFetch([new Response(body, { headers: { "content-length": "1" } })]);
  await expect(read()).rejects.toMatchObject({ reason: "network" });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it("reports a fixed PDF size failure without retaining the source ticket", async () => {
  const body = new ReadableStream<Uint8Array>();
  provideFetch([new Response(body, { headers: { "content-length": String(MAX_PDF_BYTES + 1) } })]);
  const error = await read().catch((failure) => failure);
  expect(error).toMatchObject({ reason: "network", stage: "size-limit" });
  expect(error.message).toContain("50 MiB");
  expect(error.message).not.toContain(sourceUrl);
});

it("reports a fixed length mismatch without retaining the source ticket", async () => {
  provideFetch([new Response(pdf, { headers: { "content-length": "1" } })]);
  const error = await read().catch((failure) => failure);
  expect(error).toMatchObject({ reason: "network", stage: "length-mismatch" });
  expect(error.message).toContain("Content-Length");
  expect(error.message).not.toContain(sourceUrl);
});

it("does not start a credentialed request when the signal is already aborted", async () => {
  const { fetcher } = provideFetch([]);
  const controller = new AbortController();
  controller.abort();
  await expect(read({ pageUrl, sourceUrl }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves interruption and allows an independent retry", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason));
    },
  });
  const { fetcher } = provideFetch([new Response(body), new Response(pdf)]);
  const pending = read({ pageUrl, sourceUrl }, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(body.locked).toBe(false);
  expect(Array.from(await read())).toEqual(Array.from(pdf));
});
