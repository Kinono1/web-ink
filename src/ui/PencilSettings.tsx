import { useEffect, useRef, useState } from "react";
import { type Language } from "../core/model";
import { PALETTE_SIZE_KEY, normalizePaletteSize, readPaletteSize, writePaletteSize } from "../core/palette-appearance";
import { releaseChromeListener } from "../core/client";
import { Icon } from "./management/helpers";

export function PencilSettings({ language }: { language: Language }) {
  const [size, setSize] = useState(40);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const committed = useRef(40);
  const storageRevision = useRef(0);
  const pending = useRef(false);
  const queue = useRef(Promise.resolve());
  const active = useRef(true);
  const zh = language === "zh-CN";

  useEffect(() => {
    active.current = true;
    const initial = revision.current;
    void readPaletteSize().then(value => {
      if (active.current && revision.current === initial) {
        committed.current = value;
        setSize(value);
      }
    });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (!active.current || area !== "local" || !Object.hasOwn(changes, PALETTE_SIZE_KEY)) return;
      storageRevision.current++;
      committed.current = normalizePaletteSize(changes[PALETTE_SIZE_KEY]?.newValue);
      if (!pending.current) {
        revision.current++;
        setSize(committed.current);
      }
    };
    chrome.storage?.onChanged?.addListener(changed);
    return () => {
      active.current = false;
      releaseChromeListener(() => chrome.storage?.onChanged?.removeListener(changed));
    };
  }, []);

  const resize = (value: number) => {
    const version = ++revision.current;
    pending.current = true;
    setSize(value);
    setSaving(true);
    setError(undefined);
    // Keep at most one write in flight and skip superseded slider values.
    queue.current = queue.current.catch(() => undefined).then(async () => {
      if (version !== revision.current) return;
      const observedStorage = storageRevision.current;
      try {
        await writePaletteSize(value);
        if (storageRevision.current === observedStorage) committed.current = value;
        if (active.current && version === revision.current) setSize(committed.current);
      } catch (cause) {
        if (active.current && version === revision.current) {
          setSize(committed.current);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (version === revision.current) {
          pending.current = false;
          if (active.current) setSaving(false);
        }
      }
    });
  };

  return <div className="pencil-size-setting">
    <label>
      <span>{zh ? "铅笔大小" : "Pencil size"} <output>{size}px</output></span>
      <input type="range" min="40" max="64" step="4" value={size}
        aria-label={zh ? "铅笔大小" : "Pencil size"}
        onChange={event => resize(Number(event.target.value))} />
    </label>
    <span className="pencil-size-preview" aria-label={zh ? "铅笔大小预览" : "Pencil size preview"}
      style={{ width: size, height: size }}>
      <Icon name="highlight" />
    </span>
    <p className="hint">{saving ? (zh ? "正在保存…" : "Saving…") : (zh ? "调整网页悬浮按钮的大小，拖动位置保持不变。" : "Resize the floating webpage button while keeping its saved position.")}</p>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
