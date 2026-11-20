import { HASH, publicSource, baseRecord, reader, deferred, settle, mount, button, click, selectPage, puts, io } from "../helpers/pdf-reader";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { type AnnotationPage, type Request } from "../../src/core/model";

describe("PDF reader workspace", () => {
  describe("previous PDF version detection", () => {
    const doi = "10.1109/TII.2026.3716639";
    const citation = "https://doi.org/10.1109/TII.2026.3716639";
    const oldHash = "b".repeat(64);
    const changedNotice = "旧标注已保留";
    const incompleteNotice = "旧版本检查未完成";
    function prior(sourceUrl = publicSource, hash = oldHash, id = "previous-highlight") {
      const record = baseRecord();
      return { ...record, id, pageUrl: `urn:web-ink:pdf:${hash}`,
        target: { ...record.target, documentHash: hash, sourceUrl } };
    }
    function queries() {
      return reader.messages.filter((message): message is Extract<Request, { type: "annotations.query" }> => message.type === "annotations.query");
    }

    async function choosePrevious() {
      await click("找回旧标注");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      await settle();
      expect(reader.host.querySelector('[role="dialog"]')?.textContent).toContain("Original note");
      await click("查找并选择");
      await selectPage();
    }

    it("copies a confirmed old highlight to the new PDF without changing the original", async () => {
      io.pageCount = 1;
      reader.previousRecords = [{ ...prior(), note: "Original note", tags: ["keep"], color: "#7cc868" }];
      const original = structuredClone(reader.previousRecords[0]);
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      await choosePrevious();
      expect(puts()).toHaveLength(0);
      expect(reader.records).toEqual([]);
      await click("复制旧标注到此处");
      expect(reader.previousRecords[0]).toEqual(original);
      expect(reader.records).toHaveLength(1);
      expect(reader.records[0]).toMatchObject({ kind: "pdf-text", pageUrl: `urn:web-ink:pdf:${HASH}`,
        note: "Original note", tags: ["keep"], color: "#7cc868",
        target: { documentHash: HASH, pageNumber: 1, exact: "selected" } });
      expect(reader.records[0]!.id).not.toBe(original!.id);
      expect(puts()).toHaveLength(1);
    });

    it("keeps a failed copy available for retry and leaves the old annotation untouched", async () => {
      io.pageCount = 1;
      reader.previousRecords = [{ ...prior(), note: "Original note", tags: ["keep"] }];
      const original = structuredClone(reader.previousRecords[0]);
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      await choosePrevious();
      reader.putError = "Storage temporarily unavailable";
      await click("复制旧标注到此处");
      expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("Storage temporarily unavailable");
      expect(reader.records).toEqual([]);
      expect(reader.previousRecords[0]).toEqual(original);
      reader.putError = "";
      await click("重试保存");
      expect(reader.records).toHaveLength(1);
      expect(reader.records[0]).toMatchObject({ note: "Original note", tags: ["keep"], target: { documentHash: HASH } });
      expect(reader.previousRecords[0]).toEqual(original);
      expect(puts()).toHaveLength(2);
    });

    it("rejects a previous annotation changed after the recovery dialog was opened", async () => {
      io.pageCount = 1;
      reader.previousRecords = [{ ...prior(), note: "Original note" }];
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      await choosePrevious();
      reader.previousRecords[0] = { ...reader.previousRecords[0]!, revision: 4, note: "Edited elsewhere" };
      await click("复制旧标注到此处");
      expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("旧标注或文档已改变");
      expect(puts()).toHaveLength(0);
      expect(reader.records).toEqual([]);
      expect(reader.previousRecords[0]!.note).toBe("Edited elsewhere");
    });

    it("finds legacy source-only annotations when the new PDF exposes a DOI", async () => {
      io.metadataDoi = doi;
      reader.previousRecords = [prior()];
      reader.records = [baseRecord()];
      const original = structuredClone(reader.previousRecords);
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.textContent).toContain(changedNotice);
      expect(button("查看之前的标注")).toBeTruthy();
      expect(reader.host.querySelector('[data-pdf-annotation="previous-highlight"]')).toBeNull();
      expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).not.toBeNull();
      expect(reader.previousRecords).toEqual(original);
      expect(puts()).toHaveLength(0);
      expect(queries().map(message => message.query.text)).toEqual([citation, publicSource]);
    });

    it.each([citation, publicSource])("finds a previous hash beyond the first page for %s", async (source) => {
      io.metadataDoi = doi;
      reader.previousRecords = [
        ...Array.from({ length: 51 }, (_, index) => prior(source, HASH, `current-${String(99 - index).padStart(2, "0")}`)),
        prior(source), prior(source, "c".repeat(64), "even-older"),
      ];
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.textContent).toContain(changedNotice);
      expect(button("查看之前的标注")).toBeTruthy();
      expect(reader.host.querySelector('[data-pdf-annotation="previous-highlight"]')).toBeNull();
      expect(queries().filter(message => message.query.text === source)).toHaveLength(2);
      expect(puts()).toHaveLength(0);
    });

    it("rejects text-only source matches and the current document hash", async () => {
      io.metadataDoi = doi;
      reader.previousRecords = [prior(publicSource, HASH), prior(`${publicSource}?other=1`),
        { ...prior("https://other.example.test/paper.pdf"), note: citation }];
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.textContent).not.toContain(changedNotice);
      expect(reader.host.textContent).not.toContain(incompleteNotice);
      expect(reader.host.querySelector('[data-pdf-annotation="previous-highlight"]')).toBeNull();
      expect(puts()).toHaveLength(0);
    });

    it("opens the detected older hash when the reader URL already names the current document", async () => {
      reader.previousRecords = [prior(), prior(publicSource, "c".repeat(64), "older")];
      await mount(`?document=${HASH}&source=${encodeURIComponent(publicSource)}`, false);
      const destinations: string[] = [];
      vi.spyOn(chrome.runtime, "getURL").mockImplementation(path => {
        destinations.push(path);
        return `${location.href}#library`;
      });
      await click("查看之前的标注");
      expect(destinations).toContain(`/library.html?document=${oldHash}`);
      expect(puts()).toHaveLength(0);
    });

    it("queries a DOI source only once and stops after an exact previous version", async () => {
      io.metadataDoi = doi;
      reader.previousRecords = [prior(citation), prior(citation, "c".repeat(64), "older")];
      await mount(`?source=${encodeURIComponent(citation)}`, false);
      expect(reader.host.textContent).toContain(changedNotice);
      expect(queries()).toHaveLength(1);
      expect(puts()).toHaveLength(0);
    });

    it("keeps the loaded PDF readable and reports an incomplete version check on query failure", async () => {
      reader.previousQuery = async () => { throw Error("query unavailable"); };
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.querySelector('[role="alert"]')).toBeNull();
      expect(reader.host.textContent).toContain(incompleteNotice);
      expect(reader.host.textContent).toContain("资料库");
      expect(reader.host.querySelector('.pdf-page')).not.toBeNull();
      expect(button("更多").disabled).toBe(false);
      expect(reader.host.textContent).not.toContain(changedNotice);
      expect(puts()).toHaveLength(0);
    });

    it("continues with the observed source if the DOI query fails", async () => {
      io.metadataDoi = doi;
      reader.previousQuery = async (query) => {
        if (query.text === citation) throw Error("DOI query unavailable");
        return { items: [prior()] };
      };
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.querySelector('[role="alert"]')).toBeNull();
      expect(reader.host.textContent).toContain(changedNotice);
      expect(reader.host.textContent).not.toContain(incompleteNotice);
      expect(queries()).toHaveLength(2);
    });

    it.each(["same", "newer"])("stops a %s cursor and reports the incomplete check", async (direction) => {
      reader.previousQuery = async query => ({ items: [prior(publicSource, HASH)],
        nextCursor: { updatedAt: query.cursor && direction === "newer" ? "2026-10-11T00:00:00Z" : "2026-10-10T00:00:00Z", id: "previous-highlight" } });
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.textContent).toContain(incompleteNotice);
      expect(queries()).toHaveLength(2);
      expect(reader.host.querySelector('[role="alert"]')).toBeNull();
    });

    it("does not treat a cancelled response as a completed version check", async () => {
      reader.previousQuery = async () => ({ items: [], cancelled: true });
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.textContent).toContain(incompleteNotice);
      expect(reader.host.querySelector('[role="alert"]')).toBeNull();
      expect(queries()).toHaveLength(1);
    });

    it("bounds a large history and directs the reader to the library when checking is incomplete", async () => {
      reader.previousRecords = [
        ...Array.from({ length: 1000 }, (_, index) =>
          prior(publicSource, HASH, `current-${String(2000 - index).padStart(4, "0")}`)),
        prior(),
      ];
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      expect(reader.host.textContent).toContain(incompleteNotice);
      expect(reader.host.textContent).toContain("资料库");
      expect(reader.host.textContent).not.toContain(changedNotice);
      expect(queries()).toHaveLength(20);
      expect(button("更多").disabled).toBe(false);
    });

    it.each(["resolve", "reject"])("cancels the obsolete check and ignores a late %s after changing readers", async (finish) => {
      const pending = deferred<AnnotationPage>();
      reader.previousQuery = async query => query.text === publicSource ? pending.promise : { items: [] };
      await mount(`?source=${encodeURIComponent(publicSource)}`, false);
      const firstQuery = queries()[0]!;
      await act(async () => reader.root!.unmount());
      reader.root = undefined;
      const otherSource = "https://papers.example.test/other.pdf";
      io.hash = "c".repeat(64);
      await mount(`?source=${encodeURIComponent(otherSource)}`, false);
      await act(async () => {
        if (finish === "resolve") pending.resolve({ items: [prior()],
          nextCursor: { updatedAt: "2026-10-10T00:00:00Z", id: "previous-highlight" } });
        else pending.reject(Error("obsolete query failure"));
      });
      await settle();
      expect(reader.host.querySelector('.pdf-name')?.textContent).toBe("other.pdf");
      expect(reader.host.textContent).not.toContain(changedNotice);
      expect(reader.host.textContent).not.toContain(incompleteNotice);
      expect(reader.host.querySelector('[role="alert"]')).toBeNull();
      expect(queries().filter(message => message.query.text === publicSource)).toHaveLength(1);
      expect(reader.messages).toContainEqual({ type: "annotations.query.cancel", requestId: firstQuery.query.requestId });
    });
  });
});
