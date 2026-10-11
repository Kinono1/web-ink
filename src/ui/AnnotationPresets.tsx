import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { validateAnnotationPresets, type AnnotationPreset } from "../core/annotation-presets";
import { COLORS, type Language } from "../core/model";

type ActionsProps = {
  presets: AnnotationPreset[];
  disabled: boolean;
  onChoose: (preset: AnnotationPreset) => void;
  language: Language;
};
type EditorProps = {
  presets: AnnotationPreset[];
  language: Language;
  onSave: (presets: AnnotationPreset[]) => Promise<void>;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
};

export function AnnotationPresetActions({ presets, disabled, onChoose, language }: ActionsProps) {
  return <div className="annotation-presets" role="group" aria-label={language === "zh-CN" ? "快捷标注" : "Annotation presets"}>
    {presets.map((preset, index) => <button
      key={preset.id}
      className="annotation-preset"
      type="button"
      disabled={disabled}
      title={`${preset.label} · Alt+Shift+${index + 1}`}
      aria-keyshortcuts={`Alt+Shift+${index + 1}`}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onChoose(preset)}
    >
      <span className="annotation-preset-swatch" style={{ backgroundColor: preset.color }} aria-hidden="true" />
      <span>{preset.label}</span>
    </button>)}
  </div>;
}

export function AnnotationPresetEditor({ presets, language, onSave, onClose, onDirtyChange, onSavingChange }: EditorProps) {
  const t = (zh: string, en: string) => language === "zh-CN" ? zh : en;
  // An incoming preference read must not replace this editor's unsaved input.
  const [initialPresets] = useState(() => presets.map((preset) => ({ ...preset })));
  const [drafts, setDrafts] = useState(initialPresets);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const savePending = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const lifecycleCallbacks = useRef({ onDirtyChange, onSavingChange });
  lifecycleCallbacks.current = { onDirtyChange, onSavingChange };
  const titleId = useId();
  const hintId = useId();
  const dirty = drafts.length !== initialPresets.length || drafts.some((preset, index) => {
    const original = initialPresets[index];
    return preset.id !== original?.id || preset.label !== original.label || preset.color !== original.color;
  });
  let validatedDrafts: AnnotationPreset[] | undefined;
  let validationError = "";
  try {
    validatedDrafts = validateAnnotationPresets(drafts);
  } catch (cause) {
    validationError = cause instanceof Error ? cause.message : t("请检查预设。", "Check the presets.");
  }

  useEffect(() => {
    mounted.current = true;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      mounted.current = false;
      lifecycleCallbacks.current.onDirtyChange?.(false);
      lifecycleCallbacks.current.onSavingChange?.(false);
    };
  }, []);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);

  function updatePreset(id: string, patch: Partial<Pick<AnnotationPreset, "label" | "color">>) {
    if (savePending.current) return;
    setDrafts((current) => current.map((preset) => preset.id === id ? { ...preset, ...patch } : preset));
    setSaveError("");
  }

  function addPreset() {
    if (savePending.current) return;
    setDrafts((current) => {
      if (current.length >= 5) return current;
      let number = 1;
      while (current.some((preset) => preset.id === `preset-${number}`)) number += 1;
      return [...current, { id: `preset-${number}`, label: t("新预设", "New preset"), color: COLORS[0] }];
    });
    setSaveError("");
  }

  function removePreset(id: string) {
    if (savePending.current) return;
    setDrafts((current) => current.length > 1 ? current.filter((preset) => preset.id !== id) : current);
    setSaveError("");
  }

  function cancel() {
    if (!savePending.current) onClose();
  }

  async function save() {
    if (savePending.current || !validatedDrafts) return;
    savePending.current = true;
    // A focused control can lose browser focus when disabled; hand it to the
    // stable dialog before locking the form.
    dialog.current?.focus({ preventScroll: true });
    setSaving(true);
    setSaveError("");
    let succeeded = false;
    try {
      await onSave(validatedDrafts);
      succeeded = true;
    } catch (cause) {
      if (mounted.current) {
        const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
        setSaveError(`${t("未能保存，草稿已保留。", "Could not save. Your draft has been kept.")}${detail}`);
      }
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
    if (succeeded && mounted.current) onClose();
  }

  function dialogKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!event.nativeEvent.isComposing) {
        event.preventDefault();
        cancel();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input:not([disabled]), button:not([disabled])")]
      .filter((control) => control.tabIndex >= 0);
    const first = controls[0];
    const last = controls.at(-1);
    const active = event.currentTarget.ownerDocument.activeElement;
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === event.currentTarget)) {
      event.preventDefault();
      first.focus();
    }
  }

  return <section ref={dialog} className="annotation-preset-editor dialog pdf-dialog" role="dialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={hintId} aria-busy={saving} tabIndex={-1} onKeyDown={dialogKeys}>
    <h2 id={titleId}>{t("快捷标注", "Annotation presets")}</h2>
    <p id={hintId}>{t("名称 1–24 个字符，最多 5 个预设。", "Use 1–24 characters per label, with up to 5 presets.")}</p>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="annotation-preset-list">
        {drafts.map((preset, index) => <div className="annotation-preset-row annotation-preset-editor-fields" key={preset.id}>
          <label>
            <span>{t("名称", "Label")} {index + 1}</span>
            <input type="text" value={preset.label} aria-label={`${t("名称", "Label")} ${index + 1}`}
              disabled={saving} onChange={(event) => updatePreset(preset.id, { label: event.target.value })} />
          </label>
          <label>
            <span>{t("颜色", "Color")} {index + 1}</span>
            <input type="color" value={preset.color} aria-label={`${t("颜色", "Color")} ${index + 1}`}
              disabled={saving} onChange={(event) => updatePreset(preset.id, { color: event.target.value })} />
          </label>
          <button type="button" disabled={saving || drafts.length === 1}
            aria-label={`${t("移除", "Remove")} ${preset.label || index + 1}`} onClick={() => removePreset(preset.id)}>{t("移除", "Remove")}</button>
        </div>)}
      </div>
      {(saveError || validationError) && <p className="alert error" role="alert">{saveError || validationError}</p>}
      <div className="annotation-preset-editor-actions">
        <button type="button" disabled={saving || drafts.length >= 5} onClick={addPreset}>{t("添加预设", "Add preset")}</button>
        <button type="submit" className="primary" disabled={saving || !validatedDrafts}>{saving ? t("保存中…", "Saving…") : t("保存", "Save")}</button>
        <button type="button" disabled={saving} onClick={cancel}>{t("取消", "Cancel")}</button>
      </div>
    </form>
  </section>;
}
