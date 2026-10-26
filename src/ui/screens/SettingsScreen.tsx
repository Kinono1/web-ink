import { useEffect, useRef, useState } from "react";
import { toMarkdown } from "../../core/backup";
import { request } from "../../core/client";
import type { BackupEnvelope, ImportPreview } from "../../core/model";
import { readAnnotationPresets, saveAnnotationPresets, type AnnotationPreset } from "../../core/annotation-presets";
import { AnnotationPresetEditor } from "../AnnotationPresets";
import { useSettingsContext } from "../contexts/ManagementContext";
import { SettingsView } from "../management/components";
import { download } from "../management/helpers";

export function SettingsScreen({ visible }: { visible: boolean }) {
  const { preferences, loadRecords, setError, setNotice } = useSettingsContext();
  const { settings, language, t, saveSettings, selectionToolbarEnabled,
    selectionToolbarSaving, toggleSelectionToolbar } = preferences;
  const [presetEditor, setPresetEditor] = useState<AnnotationPreset[]>();
  const [presetsLoading, setPresetsLoading] = useState(false);
  const presetDraft = useRef(false);
  const presetSaving = useRef(false);
  const presetTrigger = useRef<HTMLElement | null>(null);
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [overwrite, setOverwrite] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!presetDraft.current && !presetSaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const exportJson = async () => {
    try {
      const value = await request<BackupEnvelope>({ type: "backup.export" });
      download(
        "web-ink-backup.json",
        JSON.stringify(value),
        "application/json",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const exportMarkdown = async () => {
    try {
      const value = await request<BackupEnvelope>({ type: "backup.export" });
      download(
        "web-ink-annotations.md",
        toMarkdown(value.annotations),
        "text/markdown;charset=utf-8",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const readImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setError("Import file exceeds 20 MiB.");
      return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      const nextPreview = await request<ImportPreview>({
        type: "backup.preview",
        backup: value,
      });
      setBackup(value);
      setPreview(nextPreview);
      setError(undefined);
    } catch (cause) {
      setBackup(undefined);
      setPreview(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const importBackup = async () => {
    if (!backup) return;
    setBusyImport(true);
    try {
      await request<ImportPreview>({
        type: "backup.import",
        backup,
        overwrite,
      });
      setNotice(t.importDone);
      setBackup(undefined);
      setPreview(undefined);
      await loadRecords();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyImport(false);
    }
  };
  const editPresets = () => {
    if (presetsLoading) return;
    presetTrigger.current = document.activeElement as HTMLElement;
    setPresetsLoading(true);
    void readAnnotationPresets(language)
      .then(setPresetEditor)
      .finally(() => setPresetsLoading(false));
  };
  return (
    <>
      {visible ? (
        <SettingsView
          settings={settings}
          t={t}
          language={language}
          saveSettings={saveSettings}
          exportJson={exportJson}
          exportMarkdown={exportMarkdown}
          readImport={readImport}
          preview={preview}
          overwrite={overwrite}
          setOverwrite={setOverwrite}
          busyImport={busyImport}
          importBackup={importBackup}
          presetsLoading={presetsLoading}
          selectionToolbarEnabled={selectionToolbarEnabled}
          selectionToolbarSaving={selectionToolbarSaving}
          toggleSelectionToolbar={() => void toggleSelectionToolbar()}
          onPresets={editPresets}
        />
      ) : null}
      {presetEditor && (
        <div className="dialog-backdrop">
          <AnnotationPresetEditor
            presets={presetEditor}
            language={language}
            onSave={saveAnnotationPresets}
            onDirtyChange={(dirty) => { presetDraft.current = dirty; }}
            onSavingChange={(writing) => { presetSaving.current = writing; }}
            onClose={() => {
              setPresetEditor(undefined);
              presetTrigger.current?.focus();
            }}
          />
        </div>
      )}
    </>
  );
}
