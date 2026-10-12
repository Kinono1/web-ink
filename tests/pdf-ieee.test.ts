import { afterEach, expect, it, vi } from "vitest";
import { MAX_PDF_BYTES, readResponseBytes } from "../src/pdf/source";
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

it("reports each nonempty response-body chunk to the byte callback", async () => {
  const chunks = [Uint8Array.of(1, 2), new Uint8Array(), Uint8Array.of(3)];
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
  const received: number[] = [];

  expect(Array.from(await readResponseBytes(response, MAX_PDF_BYTES, bytes => received.push(bytes)))).toEqual([1, 2, 3]);
  expect(received).toEqual([2, 1]);
});

it("forwards nonempty IEEE response-body activity", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(pdf.subarray(0, 8));
      controller.enqueue(new Uint8Array());
      controller.enqueue(pdf.subarray(8));
      controller.close();
    },
  });
  provideFetch([new Response(body)]);
  const activity: number[] = [];

  await readIeeePdf({ pageUrl, sourceUrl }, new AbortController().signal, {
    onActivity: bytes => activity.push(bytes),
  });

  expect(activity).toEqual([8, pdf.length - 8]);
});

it("accepts a validated direct-source page without a wrapper or .pdf suffix", async () => {
  provideFetch([new Response(pdf)]);
  expect(Array.from(await read({ pageUrl: sourceUrl, sourceUrl }))).toEqual(Array.from(pdf));
});

it("reports direct IEEE reading phases without exposing the observed source URL", async () => {
  provideFetch([new Response(pdf)]);
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000003" });
  const now = vi.spyOn(Date, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(110)
    .mockReturnValueOnce(120);
  const progress: unknown[] = [];

  try {
    await readIeeePdf({ pageUrl, sourceUrl }, new AbortController().signal, {
      onProgress: diagnostic => progress.push(diagnostic),
    });
  } finally {
    now.mockRestore();
  }

  expect(progress).toEqual([
    { id: "00000000-0000-4000-8000-000000000003", version: 1, phase: "identify", elapsedMs: 0, sourceKind: "unknown" },
    { id: "00000000-0000-4000-8000-000000000003", version: 1, phase: "file", elapsedMs: 10, sourceKind: "file" },
    { id: "00000000-0000-4000-8000-000000000003", version: 1, phase: "validate", elapsedMs: 20, sourceKind: "file" },
  ]);
  expect(JSON.stringify(progress)).not.toContain("ticket=fixture");
});

it("reports wrapper parsing before the observed file read", async () => {
  provideFetch([new Response('<iframe src="/observed-file?ticket=fixture"></iframe>'), new Response(pdf)]);
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000005" });
  const now = vi.spyOn(Date, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(110)
    .mockReturnValueOnce(120)
    .mockReturnValueOnce(130);
  const progress: unknown[] = [];

  try {
    await readIeeePdf({ pageUrl }, new AbortController().signal, {
      onProgress: diagnostic => progress.push(diagnostic),
    });
  } finally {
    now.mockRestore();
  }

  expect(progress).toEqual([
    { id: "00000000-0000-4000-8000-000000000005", version: 1, phase: "identify", elapsedMs: 0, sourceKind: "unknown" },
    { id: "00000000-0000-4000-8000-000000000005", version: 1, phase: "wrapper", elapsedMs: 10, sourceKind: "wrapper" },
    { id: "00000000-0000-4000-8000-000000000005", version: 1, phase: "file", elapsedMs: 20, sourceKind: "file" },
    { id: "00000000-0000-4000-8000-000000000005", version: 1, phase: "validate", elapsedMs: 30, sourceKind: "file" },
  ]);
  expect(JSON.stringify(progress)).not.toContain("ticket=fixture");
});

it("adds a sanitized file diagnostic to an opaque network rejection", async () => {
  vi.stubGlobal("chrome", { permissions: { contains: async () => true } });
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000004" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw TypeError(`Fetch failed for ${sourceUrl}`); }));

  const error = await read().catch((failure) => failure);

  expect(error).toMatchObject({
    reason: "network",
    diagnostic: { id: "00000000-0000-4000-8000-000000000004", version: 1, phase: "file", sourceKind: "file" },
  });
  expect(JSON.stringify(error)).not.toContain("fixture");
  expect(JSON.stringify(error)).not.toContain(sourceUrl);
});

it("reads from the exact top-level IEEE source page without querying extension permissions", async () => {
  const sourcePage = { location: { origin: "https://ieeexplore.ieee.org", href: pageUrl } };
  Object.assign(sourcePage, { top: sourcePage });
  vi.stubGlobal("window", sourcePage);
  const { contains } = provideFetch([new Response(pdf)]);

  expect(Array.from(await readIeeePdf({ pageUrl, sourceUrl }, new AbortController().signal, { sourcePage: true })))
    .toEqual(Array.from(pdf));
  expect(contains).not.toHaveBeenCalled();
});

it("follows an observed same-origin IEEE redirect only from the verified source page", async () => {
  const sourcePage = { location: { origin: "https://ieeexplore.ieee.org", href: pageUrl } };
  Object.assign(sourcePage, { top: sourcePage });
  vi.stubGlobal("window", sourcePage);
  const redirected = new Response(pdf);
  Object.defineProperties(redirected, {
    redirected: { value: true },
    url: { value: "https://ieeexplore.ieee.org/final-file?temporary=fixture" },
  });
  const { contains, fetcher } = provideFetch([redirected]);
  const signal = new AbortController().signal;

  expect(Array.from(await readIeeePdf({ pageUrl, sourceUrl }, signal, { sourcePage: true }))).toEqual(Array.from(pdf));
  expect(contains).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(sourceUrl), {
    signal, credentials: "include", cache: "no-store", mode: "same-origin", redirect: "follow",
  });
});

it("resolves a source-page wrapper's relative PDF element from its verified final URL", async () => {
  const sourcePage = { location: { origin: "https://ieeexplore.ieee.org", href: pageUrl } };
  Object.assign(sourcePage, { top: sourcePage });
  vi.stubGlobal("window", sourcePage);
  const wrapper = new Response('<iframe src="observed-file?ticket=fixture"></iframe>');
  Object.defineProperties(wrapper, {
    redirected: { value: true },
    url: { value: "https://ieeexplore.ieee.org/document/123/" },
  });
  const { fetcher } = provideFetch([wrapper, new Response(pdf)]);

  expect(Array.from(await readIeeePdf({ pageUrl }, new AbortController().signal, { sourcePage: true }))).toEqual(Array.from(pdf));
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    pageUrl,
    "https://ieeexplore.ieee.org/document/123/observed-file?ticket=fixture",
  ]);
});

it("keeps a final same-origin 202 HTML download response as not-pdf", async () => {
  const sourcePage = { location: { origin: "https://ieeexplore.ieee.org", href: pageUrl } };
  Object.assign(sourcePage, { top: sourcePage });
  vi.stubGlobal("window", sourcePage);
  const finalResponse = new Response("", {
    status: 202,
    headers: { "content-type": "text/html" },
  });
  Object.defineProperties(finalResponse, {
    redirected: { value: true },
    url: { value: "https://ieeexplore.ieee.org/document/11197215/" },
  });
  provideFetch([finalResponse]);

  const error = await readIeeePdf({
    pageUrl,
    sourceUrl: "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?arnumber=123&ticket=fixture",
  }, new AbortController().signal, { sourcePage: true }).catch(failure => failure);

  expect(error).toMatchObject({ reason: "not-pdf", diagnostic: { phase: "file", status: 202, mime: "text/html" } });
  expect(JSON.stringify(error)).not.toContain("ticket=fixture");
  expect(JSON.stringify(error)).not.toContain("11197215");
});

it("rejects a source-page redirect whose final URL leaves the exact IEEE origin", async () => {
  const sourcePage = { location: { origin: "https://ieeexplore.ieee.org", href: pageUrl } };
  Object.assign(sourcePage, { top: sourcePage });
  vi.stubGlobal("window", sourcePage);
  const redirected = new Response(pdf);
  Object.defineProperties(redirected, {
    redirected: { value: true },
    url: { value: "https://example.test/final-file" },
  });
  provideFetch([redirected]);

  await expect(readIeeePdf({ pageUrl, sourceUrl }, new AbortController().signal, { sourcePage: true }))
    .rejects.toMatchObject({ reason: "redirect-blocked" });
});

it("keeps default extension reads on the exact observed URL after a same-origin redirect", async () => {
  const redirected = new Response(pdf);
  Object.defineProperties(redirected, {
    redirected: { value: true },
    url: { value: "https://ieeexplore.ieee.org/final-file?temporary=fixture" },
  });
  provideFetch([redirected]);

  await expect(read()).rejects.toMatchObject({ reason: "redirect-blocked" });
});

it.each([
  { name: "a different origin", origin: "https://example.test", href: pageUrl, topLevel: true },
  { name: "a different IEEE page", origin: "https://ieeexplore.ieee.org", href: sourceUrl, topLevel: true },
  { name: "an IEEE subframe", origin: "https://ieeexplore.ieee.org", href: pageUrl, topLevel: false },
])("rejects sourcePage reading from $name before any request", async ({ origin, href, topLevel }) => {
  const sourcePage = { location: { origin, href } };
  Object.assign(sourcePage, { top: topLevel ? sourcePage : {} });
  vi.stubGlobal("window", sourcePage);
  const { contains, fetcher } = provideFetch([]);

  await expect(readIeeePdf({ pageUrl, sourceUrl }, new AbortController().signal, { sourcePage: true }))
    .rejects.toMatchObject({ reason: "source-hidden" });
  expect(contains).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  'https://ieeexplore.ieee.org/document/11643626',
  'https://ieeexplore.ieee.org/document/11643626/',
])('reads only the supplied observed same-origin source from an IEEE document page: %s', async page => {
  const { fetcher } = provideFetch([new Response(pdf)]);
  const signal = new AbortController().signal;
  expect(Array.from(await read({ pageUrl: page, sourceUrl }, signal))).toEqual(Array.from(pdf));
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(sourceUrl), {
    signal, credentials: 'include', cache: 'no-store', redirect: 'error',
  });
});

it.each([
  { pageUrl: 'https://ieeexplore.ieee.org/document/11643626' },
  { pageUrl: 'https://ieeexplore.ieee.org/document/11643626/' },
  { pageUrl: 'https://ieeexplore.ieee.org/document/11643626', sourceUrl: 'https://other.test/paper.pdf' },
])('never fetches an IEEE article implicitly or forwards credentials cross-origin: %j', async input => {
  const { fetcher, contains } = provideFetch([]);
  await expect(read(input)).rejects.toMatchObject({ reason: 'source-hidden' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(contains).not.toHaveBeenCalled();
});

it.each([
  { pageUrl: "https://example.test/a.pdf", sourceUrl },
  { pageUrl: "https://ieeexplore.ieee.org/document/123/authors", sourceUrl },
  { pageUrl: "https://ieeexplore.ieee.org/document/123/metrics", sourceUrl },
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
