import { HASH, baseRecord, reader, deferred, settle, mount, chooseLocalPdf, button, click, puts, unloadBlocked, editNote, runtimeListeners, sidebarPort, exportIo, io } from "../helpers/pdf-reader";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("PDF annotation export and original notes", () => {
  it.each(["导出带标注的 PDF…", "导出给 AI"])("reveals a dirty Web Ink editor after Keep editing from Original while requesting %s", async (label) => {
    io.pageCount = 2;
    reader.records = [baseRecord()];
    await mount();
    await editNote("Keep this Web Ink draft");
    await click("原文件");
    expect(reader.host.querySelector("textarea")).toBeNull();
    await click("更多");
    await click(label);
    await click("继续编辑");
    expect(reader.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this Web Ink draft");
    expect(reader.host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(reader.host.querySelector('.pdf-annotation-filters button[aria-pressed="true"]')?.textContent).toBe("Web Ink");
    expect(unloadBlocked()).toBe(true);
    expect(puts()).toHaveLength(0);
    expect(reader.downloads).toHaveLength(0);
  });

  it("reveals an orphan editor and keeps its conflict state after failed Save and continue from Original", async () => {
    io.pageCount = 2;
    reader.records = [baseRecord()];
    const listeners = runtimeListeners();
    const port = sidebarPort();
    await mount();
    await editNote("Keep this conflicted draft");
    await click("原文件");
    await click("更多");
    await click("导出给 AI");
    reader.putError = "changed elsewhere";
    await click("保存并继续");
    expect(puts()).toHaveLength(1);
    await act(async () => {
      reader.records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
    });
    await settle();
    await click("继续编辑");
    const note = reader.host.querySelector('[data-pdf-note="saved-highlight"]')!;
    expect(note?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this conflicted draft");
    expect(note?.textContent).toContain("原标注已被删除");
    expect(port.state().conflicts["saved-highlight"]).toBe(true);
    expect(unloadBlocked()).toBe(true);
    expect(reader.records).toHaveLength(0);
    expect(reader.downloads).toHaveLength(0);
  });

  it.each([2, 1, 0])("accounts for exact JSON array bytes and advances past a native record of cap minus %i", async (remainingBytes) => {
    const cap = 4 * 1024 * 1024;
    const original = { key: `${HASH}:1:parent`, documentHash: HASH, pageNumber: 1, id: "parent", subtype: "Text", contents: "",
      replies: Array.from({ length: 5 }, (_, i) => ({ id: `reply-${i}`, subtype: "Text", contents: "", inReplyTo: "parent", replyType: "R" })) };
    let bodyBytes = cap - remainingBytes - new TextEncoder().encode(JSON.stringify(original)).byteLength;
    for (const reply of original.replies) {
      const length = Math.min(1_000_000, bodyBytes);
      reply.contents = "n".repeat(length);
      bodyBytes -= length;
    }
    expect(bodyBytes).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(original)).byteLength).toBe(cap - remainingBytes);
    io.pageCount = 2;
    io.nativeByPage[1] = [
      { id: "parent", subtype: "Text", contentsObj: { str: "" } },
      ...original.replies.map((reply) => ({ id: reply.id, subtype: reply.subtype, contentsObj: { str: reply.contents },
        inReplyTo: reply.inReplyTo, replyType: reply.replyType })),
      { id: "following", subtype: "Text", contentsObj: { str: "Following original note" } },
    ];
    const port = sidebarPort();
    await mount();
    expect(port.state().nativeTotalCount).toBe(2);
    expect(port.state().nativePageEnd).toBe(1);
    if (remainingBytes === 2) {
      expect(port.state().nativeRecords.map((record: any) => record.id)).toEqual(["parent"]);
      expect(new TextEncoder().encode(JSON.stringify(port.state().nativeRecords)).byteLength).toBe(cap);
      expect(port.state().nativeError).toBe("");
    } else {
      expect(port.state().nativeRecords).toHaveLength(0);
      expect(port.state().nativeError).toContain("超过侧栏显示上限");
    }
    await port.command({ type: "more-native" });
    expect(port.state().nativeOffset).toBe(1);
    expect(port.state().nativePageEnd).toBe(2);
    expect(port.state().nativeRecords.map((record: any) => record.id)).toEqual(["following"]);
    expect(port.state().nativeError).toBe("");
  });

  it("publishes at most 50 original cards per page and retains the complete count for navigation", async () => {
    io.pageCount = 3;
    io.nativeByPage[1] = Array.from({ length: 60 }, (_, i) => ({ id: `original-${i}`, subtype: "Text", contentsObj: { str: `Original ${i}` } }));
    const port = sidebarPort();
    await mount();
    expect(port.state().nativeRecords).toHaveLength(50);
    expect(port.state().nativeTotalCount).toBe(60);
    expect(port.state().nativeLimit).toBe(50);
    await port.command({ type: "more-native" });
    expect(port.state().nativeRecords).toHaveLength(10);
    expect(port.state().nativeRecords[0].id).toBe("original-50");
    expect(port.state().nativeOffset).toBe(50);
    await port.command({ type: "previous-native" });
    expect(port.state().nativeRecords).toHaveLength(50);
    expect(port.state().nativeRecords[0].id).toBe("original-0");
  });

  it("refuses an AI snapshot over the combined 50k annotation limit without emitting a file", async () => {
    io.pageCount = 25;
    reader.records = Array.from({ length: 50_000 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, target: { ...baseRecord().target, pageNumber: 25 } }));
    io.nativeByPage[1] = [{ id: "original", subtype: "Text", contentsObj: { str: "Original note" } }];
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(reader.downloads).toHaveLength(0);
    expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("50,000");
  });

  it("refuses an AI snapshot over 20 MiB instead of downloading JSON the adapter cannot read", async () => {
    io.pageCount = 25;
    reader.records = Array.from({ length: 2100 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, note: "n".repeat(9999), target: { ...baseRecord().target, pageNumber: 25 } }));
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(reader.downloads).toHaveLength(0);
    expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("20 MiB");
  });

  it("freezes the complete saved PDF snapshot at click and starts a download only after independent verification", async () => {
    reader.records = Array.from({ length: 65 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, note: `Saved ${i}` }));
    reader.records.push({ ...baseRecord(), id: "other-file", pageUrl: `urn:web-ink:pdf:${"b".repeat(64)}`,
      target: { ...baseRecord().target, documentHash: "b".repeat(64) } });
    const writing = deferred<any>();
    const verification = deferred<any>();
    exportIo.writer.mockReturnValue(writing.promise);
    exportIo.verify.mockReturnValue(verification.promise);
    await mount();
    expect(io.dataReads).toBe(0);
    expect(exportIo.writer).not.toHaveBeenCalled();
    await click("更多");
    await click("导出带标注的 PDF…");
    expect(io.dataReads).toBe(1);
    expect(reader.host.textContent).toContain("正在写入");
    const [sourceBytes, hash, snapshot, signal, fileName] = exportIo.writer.mock.calls[0]!;
    expect(Array.from(sourceBytes)).toEqual([37, 80, 68, 70]);
    expect(hash).toBe(HASH);
    expect(fileName).toBe("fixture.pdf");
    expect(snapshot).toHaveLength(65);
    reader.records[0]!.note = "Changed after click";
    expect(snapshot[0]).toMatchObject({ id: "saved-0", revision: 3, note: "Saved 0" });
    expect(signal.aborted).toBe(false);
    await click("更多");
    expect(button("导出带标注的 PDF…").disabled).toBe(true);
    await act(async () => writing.resolve({ bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "fixture-annotated.pdf", count: 65 }));
    await settle();
    expect(exportIo.verify).toHaveBeenCalledWith(sourceBytes, new Uint8Array([37, 80, 68, 70, 45]), HASH, snapshot, signal);
    expect(reader.downloads).toHaveLength(0);
    expect(reader.host.textContent).toContain("正在校验");
    await act(async () => verification.resolve({ count: 65, sourceHash: HASH, outputHash: "c".repeat(64) }));
    await settle();
    expect(reader.downloads).toHaveLength(1);
    expect(reader.downloads[0]!.fileName).toBe("fixture-annotated.pdf");
    expect(reader.downloads[0]!.blob.type).toBe("application/pdf");
    expect(reader.host.textContent).toContain("已生成并开始下载");
    expect(puts()).toHaveLength(0);
  });

  it.each(["writer", "verification"])("keeps saved notes and refuses a PDF download after %s failure", async (stage) => {
    reader.records = [baseRecord()];
    if (stage === "writer") exportIo.writer.mockRejectedValue(Error("PDF export was refused"));
    else exportIo.verify.mockRejectedValue(Error("PDF preservation check failed"));
    await mount();
    await click("更多");
    await click("导出带标注的 PDF…");
    expect(reader.downloads).toHaveLength(0);
    expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain(stage === "writer" ? "PDF export was refused" : "PDF preservation check failed");
    expect(reader.records).toEqual([baseRecord()]);
    expect(puts()).toHaveLength(0);
    expect(reader.host.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it.each(["cancel", "leave", "pagehide", "unmount"])("aborts the owned export on %s and ignores a late worker result", async (action) => {
    const writing = deferred<any>();
    exportIo.writer.mockReturnValue(writing.promise);
    await mount();
    await click("更多");
    await click("导出带标注的 PDF…");
    const signal = exportIo.writer.mock.calls[0]![3] as AbortSignal;
    if (action === "cancel") await click("取消导出");
    else if (action === "leave") await click("重新选择 PDF");
    else if (action === "pagehide") await act(async () => window.dispatchEvent(new Event("pagehide")));
    else { await act(async () => reader.root!.unmount()); reader.root = undefined; }
    expect(signal.aborted).toBe(true);
    await act(async () => writing.resolve({ bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "late.pdf", count: 0 }));
    await settle();
    expect(exportIo.verify).not.toHaveBeenCalled();
    expect(reader.downloads).toHaveLength(0);
  });

  it("exports the saved revision after Save and continue rather than the stale draft base", async () => {
    reader.records = [baseRecord()];
    await mount();
    await editNote("Saved for PDF export");
    await click("更多");
    await click("导出带标注的 PDF…");
    expect(exportIo.writer).not.toHaveBeenCalled();
    await click("保存并继续");
    expect(exportIo.writer.mock.calls[0]![2]).toEqual([{ ...baseRecord(), note: "Saved for PDF export", revision: 4,
      updatedAt: reader.records[0]!.updatedAt }]);
    expect(reader.host.querySelector('[aria-label="未保存的内容"]')).toBeNull();
    expect(reader.downloads).toHaveLength(1);
  });

  it("downloads a standalone AI snapshot of all saved current-file notes and original notes without database writes", async () => {
    io.pageCount = 25;
    reader.records = Array.from({ length: 65 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, note: `Saved ${i}` }));
    reader.records.push({ ...baseRecord(), id: "other-file", pageUrl: `urn:web-ink:pdf:${"b".repeat(64)}`,
      target: { ...baseRecord().target, documentHash: "b".repeat(64) } });
    io.nativeByPage[24] = [{ id: "24R", subtype: "Text", contentsObj: { str: "Original late-page note" } }];
    await mount();
    await click("更多");
    await click("导出给 AI");
    // The native collector yields between batches; wait for its download, not
    // a fixed number of render/microtask rounds.
    await act(async () => { await vi.waitFor(() => expect(reader.downloads).toHaveLength(1)); });
    const exported = JSON.parse(await blobText(reader.downloads[0]!.blob));
    expect(Object.keys(exported).sort()).toEqual(["annotations", "document", "exportedAt", "format", "nativeAnnotations", "schemaVersion"]);
    expect(exported).toMatchObject({ format: "web-ink-pdf-notes", schemaVersion: 1,
      document: { documentHash: HASH, fileName: "fixture.pdf" } });
    expect(exported.annotations).toHaveLength(65);
    expect(exported.annotations.at(-1)).toMatchObject({ id: "saved-64", revision: 3, note: "Saved 64" });
    expect(exported.nativeAnnotations).toEqual([{ key: `${HASH}:24:24R`, documentHash: HASH, pageNumber: 24,
      id: "24R", subtype: "Text", contents: "Original late-page note" }]);
    expect(io.dataReads).toBe(0);
    expect(puts()).toHaveLength(0);
    expect(reader.messages.some((message) => /backup|export|import/.test(message.type))).toBe(false);
    expect(reader.host.textContent).toContain("已生成并开始下载");
  });

  it("cancels AI export before its final original-note batch and never downloads a partial snapshot", async () => {
    io.pageCount = 25;
    const reading = deferred<unknown[]>();
    io.annotationGates[12] = reading.promise;
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(reader.host.textContent).toContain("正在准备");
    await click("取消导出");
    await act(async () => reading.resolve([{ id: "late", subtype: "Text", contentsObj: { str: "Late original note" } }]));
    await settle();
    expect(reader.downloads).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    expect(reader.host.textContent).toContain("已取消导出");
  });

  it.each(["导出带标注的 PDF…", "导出给 AI"])("guards a dirty note before %s and retains failed saves", async (label) => {
    reader.records = [baseRecord()];
    await mount();
    await editNote("draft for export");
    await click("更多");
    await click(label);
    expect(reader.host.querySelector('[aria-label="未保存的内容"]')).toBeTruthy();
    expect(io.dataReads).toBe(0);
    reader.putError = "cannot save export draft";
    await click("保存并继续");
    expect(reader.host.querySelector("textarea")?.value).toBe("draft for export");
    expect(reader.host.querySelector('[aria-label="未保存的内容"]')).toBeTruthy();
    expect(io.dataReads).toBe(0);
  });

  it("reads original notes lazily without rendering canvases for the remaining pages", async () => {
    io.pageCount = 25;
    io.nativeByPage[2] = [{ id: "10R", subtype: "Text", contentsObj: { str: "Visible original note" } }];
    io.nativeByPage[24] = [{ id: "24R", subtype: "Text", contentsObj: { str: "Last original note" } }];
    const port = sidebarPort();
    await mount();
    expect(port.state().nativeFilter).toBe("web-ink");
    expect(io.annotationsRead.length).toBeLessThan(8);
    expect(port.state().nativeRecords.some((record: any) => record.contents === "Visible original note")).toBe(true);
    const renders = io.renderedPages.slice();
    await port.command({ type: "filter", filter: "original" });
    for (let round = 0; round < 10 && port.state().nativeProgress?.completed !== 25; round++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await settle();
    }
    expect(port.state().nativeRecords.some((record: any) => record.contents === "Last original note")).toBe(true);
    expect(port.state().nativeProgress).toEqual({ completed: 25, total: 25 });
    expect(io.renderedPages).toEqual(renders);
    expect(puts()).toHaveLength(0);
  });

  it("cancels an original-note scan and rejects its late state after a document change", async () => {
    io.pageCount = 25;
    const reading = deferred<unknown[]>();
    io.annotationGates[12] = reading.promise;
    const port = sidebarPort();
    await mount();
    await port.command({ type: "filter", filter: "all" });
    expect(port.state().nativeLoading).toBe(true);
    await port.command({ type: "cancel-native" });
    expect(port.state().nativeLoading).toBe(false);
    await click("更多");
    await click("打开其他文件");
    io.hash = "b".repeat(64);
    io.annotationGates = {};
    await chooseLocalPdf(new File(["%PDF-"], "replacement.pdf"));
    await act(async () => reading.resolve([{ id: "late", subtype: "Text", contentsObj: { str: "Old file note" } }]));
    await settle();
    expect(port.state().pageUrl).toBe(`urn:web-ink:pdf:${"b".repeat(64)}`);
    expect(port.state().nativeRecords.some((record: any) => record.contents === "Old file note")).toBe(false);
  });
});
