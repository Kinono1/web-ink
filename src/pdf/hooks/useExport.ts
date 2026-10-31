import { errorText } from "../../core/pdf-types";
import { useEffect, useRef, useState } from "react";
import { MAX_PDF_BYTES } from "../../core/pdf-source";
import { safeSource, type ReaderSnapshot, type ReaderActionsRef } from "./contracts";

export function useExportState() {
  const exportController = useRef<AbortController | undefined>(undefined);
  const [exportStage, setExportStage] = useState<"preparing" | "writing" | "verifying">();
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  return { exportController, exportStage, setExportStage, downloadUrls };
}
type Inputs = Pick<ReaderSnapshot,
  "documentSessionRef" | "downloadUrls" | "exportController" | "key" | "opened" | "recordsRef" | "setError" | "setExportStage" | "setNativeProgress" | "setNativeRecords" | "setNotice" | "t">;

export function useExport(state: Inputs, actions: ReaderActionsRef<"cancelNativeScan">,) {
  const { documentSessionRef, downloadUrls, exportController, key, opened, recordsRef, setError, setExportStage, setNativeProgress, setNativeRecords, setNotice, t, } = state;
  useEffect(() => () => {
    exportController.current?.abort();
    for (const [url, timer] of downloadUrls.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloadUrls.current.clear();
  }, []);
  function download(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    try { link.click(); }
    catch (cause) { URL.revokeObjectURL(url); throw cause; }
    finally { link.remove(); }
    downloadUrls.current.set(url, setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.current.delete(url);
    }, 30_000));
  }
  function cancelExport() {
    exportController.current?.abort();
    exportController.current = undefined;
    setExportStage(undefined);
    setNotice(t("已取消导出。", "Export cancelled."));
  }
  async function exportAnnotations(kind: "export" | "ai") {
    if (!opened || exportController.current) return;
    const active = documentSessionRef.current;
    const current = opened;
    const snapshot = structuredClone(recordsRef.current.filter((record) => record.pageUrl === key && record.target.documentHash === current.hash && record.revision > 0));
    const controller = new AbortController();
    exportController.current = controller;
    actions.current.cancelNativeScan();
    setExportStage("preparing");
    setError("");
    setNotice("");
    try {
      if (kind === "export") {
        const bytes = await current.document.getData();
        if (controller.signal.aborted || active !== documentSessionRef.current) return;
        if (bytes.byteLength > MAX_PDF_BYTES) throw Error(t("PDF 超过 50 MiB 导出上限。", "PDF exceeds the 50 MiB export limit."));
        const [{ exportPdfInWorker }, { verifyPdfExport }] = await Promise.all([import("../export-client"), import("../export-verify")]);
        if (controller.signal.aborted || active !== documentSessionRef.current) return;
        setExportStage("writing");
        const result = await exportPdfInWorker(bytes, current.hash, snapshot, controller.signal, current.fileName);
        if (controller.signal.aborted || active !== documentSessionRef.current) return;
        if (result.bytes.byteLength > MAX_PDF_BYTES || result.count !== snapshot.length)
          throw Error(t("PDF 导出数量或大小校验未通过。", "PDF export count or size verification failed."));
        setExportStage("verifying");
        const verified = await verifyPdfExport(bytes, result.bytes, current.hash, snapshot, controller.signal);
        if (controller.signal.aborted || active !== documentSessionRef.current) return;
        if (verified.count !== snapshot.length || verified.sourceHash !== current.hash || verified.outputHash === current.hash)
          throw Error(t("PDF 导出校验未通过。", "PDF export verification failed."));
        download(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), result.fileName);
        setNotice(t("PDF 已生成并开始下载。", "PDF generated and download started."));
        return;
      }
      const nativeAnnotations = await current.nativeAnnotations!.loadAll(controller.signal, (completed, total) => {
        if (controller.signal.aborted || active !== documentSessionRef.current) return;
        setNativeProgress({ completed, total });
        setNativeRecords(current.nativeAnnotations!.records);
      });
      if (controller.signal.aborted || active !== documentSessionRef.current) return;
      setNativeRecords(nativeAnnotations);
      if (snapshot.length + nativeAnnotations.length > 50_000)
        throw Error(t("导出给 AI 最多支持 50,000 条标注。", "AI export supports at most 50,000 annotations."));
      const sourceUrl = safeSource(current.sourceUrl);
      const notes = { format: "web-ink-pdf-notes", schemaVersion: 1, exportedAt: new Date().toISOString(),
        document: { documentHash: current.hash, fileName: current.fileName, ...(sourceUrl ? { sourceUrl } : {}) },
        annotations: snapshot, nativeAnnotations };
      const name = current.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\.pdf$/i, "") || "Document";
      const file = new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" });
      if (file.size > 20 * 1024 * 1024)
        throw Error(t("导出给 AI 的笔记超过 20 MiB 上限。", "AI notes exceed the 20 MiB export limit."));
      download(file, `${name}-notes.json`);
      setNotice(t("笔记已生成并开始下载。", "Notes generated and download started."));
    } catch (cause) {
      if (!controller.signal.aborted && active === documentSessionRef.current) setError(errorText(cause));
    } finally {
      if (exportController.current === controller) { exportController.current = undefined; setExportStage(undefined); }
    }
  }
  return { download, cancelExport, exportAnnotations };
}