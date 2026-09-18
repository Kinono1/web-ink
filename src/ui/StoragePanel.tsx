import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "../core/client";
import type { Language, StorageStats } from "../core/model";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

/** This component listens only for data changes, never page re-anchoring/scroll notifications. */
export function StoragePanel({ language }: { language: Language }) {
  const zh = language === "zh-CN";
  const [stats, setStats] = useState<StorageStats>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const active = useRef(true);
  const generation = useRef(0);
  const refresh = useCallback(async (recalculate = false) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const next = await request<StorageStats>({
        type: "storage.stats",
        ...(recalculate ? { recalculate: true } : {}),
      });
      if (active.current && token === generation.current) {
        setStats(next);
        setError(undefined);
      }
    } catch (cause) {
      if (active.current && token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current && token === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (message: { type?: string }) => {
      if (
        ![
          "annotations.changed",
          "settings.changed",
          "page.mode.changed",
        ].includes(message?.type ?? "")
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
      }, 300);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      active.current = false;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refresh]);
  const tooLarge =
    stats &&
    (stats.backupBytes > stats.backupLimitBytes ||
      stats.annotationCount > stats.backupRecordLimit);
  const nearBackupLimit =
    stats &&
    (stats.backupBytes >= stats.backupLimitBytes * 0.75 ||
      stats.annotationCount >= stats.backupRecordLimit * 0.8);
  const quotaNear =
    stats &&
    stats.browserUsageBytes !== null &&
    stats.browserQuotaBytes !== null &&
    stats.browserQuotaBytes > 0 &&
    stats.browserUsageBytes / stats.browserQuotaBytes >= 0.8;
  return (
    <section
      className="storage-panel"
      aria-label={zh ? "本地存储" : "Local storage"}
      aria-busy={loading}
    >
      <div className="storage-header">
        <strong>{zh ? "本地存储" : "Local storage"}</strong>
        <button
          className="quiet"
          disabled={loading}
          onClick={() => void refresh(true)}
          aria-label={zh ? "刷新用量" : "Refresh usage"}
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      {error ? (
        <p className="storage-warning" role="status">
          {zh ? "暂时无法统计：" : "Usage unavailable: "}
          {error}
        </p>
      ) : null}
      {stats ? (
        <>
          <div className="storage-metrics">
            <span>
              <b>{stats.annotationCount.toLocaleString()}</b>
              {zh ? " 条标注" : " annotations"}
            </span>
            <span>
              <b>{stats.pageCount.toLocaleString()}</b>
              {zh ? " 个网页" : " pages"}
            </span>
          </div>
          <p>
            {zh ? "标注数据大小" : "Annotation data size"}{" "}
            <strong>{formatBytes(stats.logicalBytes)}</strong>{" "}
            <span className="storage-muted">
              {zh ? "（估算）" : "(estimated)"}
            </span>
          </p>
          <p className="storage-muted">
            {zh
              ? `文字 ${stats.textCount} · 图片 ${stats.imageCount} · PDF ${(stats.pdfTextCount ?? 0) + (stats.pdfAreaCount ?? 0)}`
              : `${stats.textCount} text · ${stats.imageCount} image · ${(stats.pdfTextCount ?? 0) + (stats.pdfAreaCount ?? 0)} PDF`}
          </p>
          <details>
            <summary>{zh ? "占用详情" : "Usage details"}</summary>
            <p>
              {zh
                ? "浏览器报告的存储占用："
                : "Browser-reported storage usage: "}
              {stats.browserUsageBytes === null
                ? zh
                  ? "不可用"
                  : "Unavailable"
                : `${formatBytes(stats.browserUsageBytes)} (${zh ? "估算" : "estimated"})`}
            </p>
            <p>
              {zh ? "JSON 备份大小：" : "JSON backup size: "}
              {formatBytes(stats.backupBytes)}
            </p>
            <p className="storage-muted">
              {zh
                ? "标注大小按记录的文本编码估算，实际数据库还包含索引等开销。浏览器估算不等于精确磁盘用量；以上均不含开发依赖和测试浏览器。"
                : "Record size is estimated from its text encoding; database indexes add overhead. Browser estimates are not exact disk usage. Development tools and test browsers are excluded."}
            </p>
          </details>
          {tooLarge ? (
            <p className="storage-warning" role="status">
              {zh
                ? "已超过当前单份备份上限（20 MiB / 50,000 条），完整备份可能无法导出。请保留浏览器数据；分卷备份尚未提供。"
                : "Above the current single-backup limit (20 MiB / 50,000 records). Full export may fail. Keep your browser data; split backups are not available yet."}
            </p>
          ) : nearBackupLimit ? (
            <p className="storage-warning" role="status">
              {zh
                ? "数据正在接近单份备份上限（20 MiB / 50,000 条），建议现在先导出一份备份。"
                : "Approaching the single-backup limit (20 MiB / 50,000 records). Export a backup soon."}
            </p>
          ) : null}
          {stats.logicalBytes >= stats.storageWarningBytes || quotaNear ? (
            <p className="storage-warning" role="status">
              {zh
                ? "存储用量较高。长笔记和复杂笔迹会增加占用；此提醒不会删除或阻止保存标注。"
                : "Storage usage is high. Long notes and detailed drawings increase usage; this notice does not delete or block annotations."}
            </p>
          ) : null}
        </>
      ) : !error ? (
        <p className="storage-muted">{zh ? "正在统计…" : "Calculating…"}</p>
      ) : null}
    </section>
  );
}
