import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDoi, pdfDoi, type PdfMetadataInput } from "../src/pdf/metadata";
import { doiUrl, learnPdfPaperIdentity, readPdfPaperIdentity } from "../src/pdf/paper-identity";

const hash = "a".repeat(64);
const oldHash = "b".repeat(64);
const key = `ui.pdfPaperIdentity.${hash}`;
const oldKey = `ui.pdfPaperIdentity.${oldHash}`;
const doi = "10.1109/TII.2026.3716639";
const paperUrl = "https://ieeexplore.ieee.org/document/11643626";
const sourceUrl = "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11643626&ticket=temporary#page=3";

function metadata(values: Record<string, unknown>): PdfMetadataInput {
  return { metadata: { get: (name) => values[name] } };
}

function storage(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const get = vi.fn(async (requested: string | null) => requested === null
    ? { ...values }
    : { [requested]: values[requested] });
  const set = vi.fn(async (entries: Record<string, unknown>) => { Object.assign(values, entries); });
  vi.stubGlobal("chrome", { storage: { local: { get, set } } });
  return { values, get, set };
}

afterEach(() => vi.unstubAllGlobals());

describe("explicit PDF DOI", () => {
  it.each([
    ["10.1109/TII.2026.3716639", doi],
    [" DOI: 10.1109/TII.2026.3716639 ", doi],
    ["https://doi.org/10.1234/a%3Bb(c)%2Fd%3Ae%2Bf", "10.1234/a;b(c)/d:e+f"],
  ])("parses the explicit identifier %s", (value, expected) => {
    expect(parseDoi(value)).toBe(expected);
    expect(pdfDoi(metadata({ "prism:doi": value }))).toBe(expected);
    expect(pdfDoi(metadata({ "dc:identifier": value }))).toBe(expected);
  });

  it("keeps the publisher field priority and falls back from invalid publisher values", () => {
    expect(pdfDoi(metadata({ "prism:doi": doi, "dc:identifier": "10.1234/other" }))).toBe(doi);
    expect(pdfDoi(metadata({ "prism:doi": "bad", "dc:identifier": doi }))).toBe(doi);
  });

  it("does not infer an identity from titles or non-DOI fields", () => {
    expect(pdfDoi({
      info: { Title: `Paper — DOI: ${doi}`, DOI: doi },
      metadata: { get: (name) => name === "dc:title" ? `Paper ${doi}` : undefined },
    })).toBeUndefined();
    expect(parseDoi(`Paper — DOI: ${doi}`)).toBeUndefined();
  });

  it.each([
    null, undefined, 123, {}, [doi], "", "10.123/a", "10.1234/", "10.1234/a b",
    "http://doi.org/10.1234/a", "https://@doi.org/10.1234/a",
    "https://doi.org.evil.test/10.1234/a", "https://doi.org/10.1234/a?x=1",
    "https://doi.org/10.1234/a#section", "https://doi.org/10.1234/%",
    "https://doi.org/10.1234/a%3Fb", "10.1234/a\u0000", "10.1234/a\uD800",
    `10.1234/${"a".repeat(201)}`,
  ])("rejects a malformed DOI value: %j", (value) => {
    expect(parseDoi(value)).toBeUndefined();
    expect(pdfDoi(metadata({ "prism:doi": value }))).toBeUndefined();
    expect(doiUrl(value)).toBeUndefined();
  });

  it("ignores malformed metadata containers and throwing getters", () => {
    const broken = new Proxy({}, { get() { throw Error("unavailable metadata"); } });
    for (const input of [null, undefined, 1, {}, { metadata: {} }, broken])
      expect(pdfDoi(input as PdfMetadataInput)).toBeUndefined();
    expect(pdfDoi({ metadata: { get: (name) => {
      if (name === "prism:doi") throw Error("unavailable field");
      return doi;
    } } })).toBe(doi);
  });

  it("formats only a validated DOI as a resolver URL and preserves suffix punctuation", () => {
    expect(doiUrl(`DOI: ${doi}`)).toBe("https://doi.org/10.1109/TII.2026.3716639");
    expect(doiUrl("https://doi.org/10.1234/a%3Bb(c)%2Fd%3Ae%2Bf"))
      .toBe("https://doi.org/10.1234/a;b(c)/d:e+f");
  });
});

describe("PDF paper identity preferences", () => {
  it("learns an explicit DOI under one hash without retaining the source ticket", async () => {
    const local = storage({ "ui.other": "preserve" });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    expect(await learnPdfPaperIdentity(hash.toUpperCase(), metadata({ "prism:doi": doi }), sourceUrl))
      .toEqual({ doi, paperUrl });
    expect(local.values).toEqual({ "ui.other": "preserve", [key]: { doi, paperUrl } });
    expect(local.get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps independent learned hashes without replacing a shared registry", async () => {
    const local = storage();
    await Promise.all([
      learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }), sourceUrl),
      learnPdfPaperIdentity(oldHash, metadata({ "dc:identifier": "10.1234/other" })),
    ]);
    expect(local.values).toEqual({ [key]: { doi, paperUrl }, [oldKey]: { doi: "10.1234/other" } });
  });

  it("preserves a confirmed article when the same hash and DOI are reopened locally", async () => {
    const local = storage({ [key]: { doi: doi.toLowerCase(), paperUrl } });
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }))).toEqual({ doi });
    expect(await readPdfPaperIdentity(hash)).toEqual({ doi, paperUrl });
    expect(local.get.mock.calls).toEqual([[key], [key]]);
  });

  it("does not carry an old article association into a conflicting learned DOI", async () => {
    storage({ [key]: { doi: "10.1234/conflict", paperUrl } });
    await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }));
    expect(await readPdfPaperIdentity(hash)).toEqual({ doi });
  });

  it.each([
    undefined, "", "https://papers.example.test/10.1109/TII.2026.3716639.pdf",
    "https://ieeexplore.ieee.org/observed-file?arnumber=11643626",
    "https://ieeexplore.ieee.org/document/11643626/authors", "http://ieeexplore.ieee.org/document/11643626",
    "https://ieeexplore.ieee.org.evil.test/document/11643626", "https://@ieeexplore.ieee.org/document/11643626",
    "https:////@ieeexplore.ieee.org/document/11643626", "https://ieeexplore.ieee.org:8443/document/11643626",
    "https://ieeexplore.ieee.org/docu\nment/11643626", "https://ieeexplore.ieee.org\\document\\11643626",
    "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626&arnumber=999",
  ])("retains only the DOI when the observed source has no trusted article identity: %s", async (source) => {
    const local = storage();
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }), source)).toEqual({ doi });
    expect(local.values[key]).toEqual({ doi });
  });

  it("does not retain an oversized source association", async () => {
    const local = storage();
    const oversizedSource = `https://ieeexplore.ieee.org/document/11643626?ticket=${"a".repeat(8192)}`;
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }), oversizedSource)).toEqual({ doi });
    expect(local.values[key]).toEqual({ doi });
  });

  it("does not learn a guessed DOI from a filename, title, or IEEE article number", async () => {
    const local = storage();
    expect(await learnPdfPaperIdentity(hash, { info: { Title: `IEEE-${doi}.pdf` } }, sourceUrl)).toBeUndefined();
    expect(local.values).toEqual({});
  });

  it.each(["", "a".repeat(63), "g".repeat(64), `${hash}.other`, null, 42])(
    "does not use an invalid hash as a storage key: %j", async (invalidHash) => {
      const local = storage({ [oldKey]: { doi, paperUrl } });
      expect(await learnPdfPaperIdentity(invalidHash as string, metadata({ "prism:doi": doi }), sourceUrl)).toBeUndefined();
      expect(await readPdfPaperIdentity(invalidHash as string)).toBeUndefined();
      expect(local.get).not.toHaveBeenCalled();
      expect(local.set).not.toHaveBeenCalled();
    },
  );

  it("returns learned metadata without waiting for a storage write", async () => {
    vi.stubGlobal("chrome", { storage: { local: { set: () => new Promise(() => {}) } } });
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }), sourceUrl)).toEqual({ doi, paperUrl });
  });

  it("returns local metadata without waiting for the association merge read", async () => {
    const get = vi.fn(() => new Promise(() => {}));
    const set = vi.fn();
    vi.stubGlobal("chrome", { storage: { local: { get, set } } });
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }))).toEqual({ doi });
    expect(get).toHaveBeenCalledExactlyOnceWith(key);
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["sync", "async", "missing"])("keeps explicit metadata usable when storage is denied (%s)", async (failure) => {
    const denied = failure === "sync"
      ? () => { throw Error("storage denied"); }
      : () => Promise.reject(Error("storage denied"));
    vi.stubGlobal("chrome", failure === "missing" ? undefined : { storage: { local: { get: denied, set: denied } } });
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }))).toEqual({ doi });
    expect(await learnPdfPaperIdentity(hash, metadata({ "prism:doi": doi }), sourceUrl)).toEqual({ doi, paperUrl });
  });

  it("reads the exact hash before considering a conflicting article mapping", async () => {
    const local = storage({ [key]: { doi, paperUrl }, [oldKey]: { doi: "10.1234/conflict", paperUrl } });
    expect(await readPdfPaperIdentity(hash.toUpperCase(), sourceUrl)).toEqual({ doi, paperUrl });
    expect(local.get).toHaveBeenCalledExactlyOnceWith(key);
  });

  it("keeps an exact DOI without inventing an association to the caller's article", async () => {
    const local = storage({ [key]: { doi } });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toEqual({ doi });
    local.values[key] = { doi, paperUrl };
    expect(await readPdfPaperIdentity(hash, "https://ieeexplore.ieee.org/document/999"))
      .toEqual({ doi, paperUrl });
    expect(local.get.mock.calls).toEqual([[key], [key]]);
  });

  it("finds an old hash only through the same observed stable IEEE article", async () => {
    const local = storage({
      "ui.other": { doi: "10.1234/other", paperUrl },
      "ui.pdfPaperIdentity.invalid-hash": { doi: "10.1234/invalid-key", paperUrl },
      [oldKey]: { doi, paperUrl },
    });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toEqual({ doi, paperUrl });
    expect(local.get.mock.calls).toEqual([[key], [null]]);
  });

  it.each([undefined, "", "invalid-hash"])("can recover a known observed article before a document hash is available: %s", async (missingHash) => {
    const local = storage({ [oldKey]: { doi, paperUrl } });
    expect(await readPdfPaperIdentity(missingHash, sourceUrl)).toEqual({ doi, paperUrl });
    expect(local.get).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("accepts case differences for the same DOI but rejects conflicting mappings", async () => {
    const thirdKey = `ui.pdfPaperIdentity.${"c".repeat(64)}`;
    const local = storage({ [oldKey]: { doi, paperUrl }, [thirdKey]: { doi: doi.toLowerCase(), paperUrl } });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toEqual({ doi, paperUrl });
    local.values[thirdKey] = { doi: "10.1234/conflict", paperUrl };
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toBeUndefined();
  });

  it.each([
    undefined, "https://ieeexplore.ieee.org/document/999", "https://papers.example.test/paper.pdf",
    "https://ieeexplore.ieee.org/observed-file?arnumber=11643626", "https://@ieeexplore.ieee.org/document/11643626",
  ])("does not recover an old identity from an unknown or different source: %s", async (source) => {
    const local = storage({ [oldKey]: { doi, paperUrl } });
    expect(await readPdfPaperIdentity(hash, source)).toBeUndefined();
    if (source !== "https://ieeexplore.ieee.org/document/999")
      expect(local.get).toHaveBeenCalledExactlyOnceWith(key);
  });

  it.each([
    null, 42, [], {}, { doi: "bad", paperUrl }, { doi, paperUrl: "https://evil.test/" },
    { doi, paperUrl: 42 }, { doi: [doi] }, { doi: `${doi}\u0000`, paperUrl },
  ])("ignores malformed stored identities: %j", async (identity) => {
    storage({ [key]: identity, [oldKey]: identity });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toBeUndefined();
  });

  it("ignores invalid mappings while recovering a valid old identity", async () => {
    storage({ [key]: { doi: "bad", paperUrl }, [oldKey]: { doi, paperUrl } });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toEqual({ doi, paperUrl });
  });

  it("copies a validated identity instead of exposing stored fields", async () => {
    const local = storage({ [key]: { doi: `DOI: ${doi}`, paperUrl, ticket: "do not expose" } });
    const identity = await readPdfPaperIdentity(hash);
    expect(identity).toEqual({ doi, paperUrl });
    identity!.doi = "10.1234/changed";
    expect(local.values[key]).toEqual({ doi: `DOI: ${doi}`, paperUrl, ticket: "do not expose" });
  });

  it.each([null, 1, [], "bad"])("ignores malformed storage containers: %j", async (values) => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => values } } });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toBeUndefined();
  });

  it.each(["sync", "async", "missing"])("returns unknown when storage reads are denied (%s)", async (failure) => {
    const get = failure === "sync"
      ? () => { throw Error("storage denied"); }
      : () => Promise.reject(Error("storage denied"));
    vi.stubGlobal("chrome", failure === "missing" ? undefined : { storage: { local: { get } } });
    expect(await readPdfPaperIdentity(hash, sourceUrl)).toBeUndefined();
  });
});
