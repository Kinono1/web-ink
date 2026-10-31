import type { ImportPreview, Language, Settings } from "../../../core/model";
import type { COPY } from "../copy";
import { StoragePanel } from "../../StoragePanel";
import { BuildInfo } from "../../BuildInfo";
import { PencilSettings } from "../../PencilSettings";
import { SelectionToolbarSwitch } from "./common";
import { ColorPicker } from "./detail";

export function SettingsView({ settings, t, language, saveSettings, exportJson, exportMarkdown,
  readImport, preview, overwrite, setOverwrite, busyImport, importBackup, onPresets,
  presetsLoading = false, selectionToolbarEnabled, selectionToolbarSaving = false,
  toggleSelectionToolbar }: {
  settings: Settings; t: (typeof COPY)[Language]; language: Language;
  saveSettings: (patch: Partial<Settings>) => void;
  exportJson: () => void; exportMarkdown: () => void;
  readImport: (file: File | undefined) => void;
  preview?: ImportPreview; overwrite: boolean; setOverwrite: (value: boolean) => void;
  busyImport: boolean; importBackup: () => void;
  onPresets?: () => void; presetsLoading?: boolean;
  selectionToolbarEnabled: boolean; selectionToolbarSaving?: boolean;
  toggleSelectionToolbar: () => void;
}) {
  return (
    <section className="settings-view">
      <section className="settings-group">
        <h2>{t.preferences}</h2>
        <label>{t.theme}
          <select aria-label={t.theme} value={settings.theme ?? "system"}
            onChange={(event) => saveSettings({ theme: event.target.value as Settings["theme"] })}>
            <option value="system">{t.system}</option>
            <option value="light">{t.light}</option>
            <option value="dark">{t.dark}</option>
          </select>
        </label>
        <label>{t.language}
          <select aria-label={t.language} value={settings.language}
            onChange={(event) => saveSettings({ language: event.target.value as Language })}>
            <option value="zh-CN">{t.chinese}</option>
            <option value="en">{t.english}</option>
          </select>
        </label>
        <label className="switch-row">
          <input aria-label={t.reduceMotion} type="checkbox" checked={settings.reduceMotion === true}
            onChange={(event) => saveSettings({ reduceMotion: event.target.checked })} />{t.reduceMotion}
        </label>
        <label className="switch-row">
          <input aria-label={t.reduceTransparency} type="checkbox" checked={settings.reduceTransparency === true}
            onChange={(event) => saveSettings({ reduceTransparency: event.target.checked })} />{t.reduceTransparency}
        </label>
        <label>{t.defaultColor}
          <ColorPicker value={settings.defaultColor}
            onChange={(color) => saveSettings({ defaultColor: color })} label={t.customColor} />
        </label>
        <PencilSettings language={language} />
        <SelectionToolbarSwitch enabled={selectionToolbarEnabled} saving={selectionToolbarSaving}
          onToggle={toggleSelectionToolbar} t={t} describe />
        {onPresets && <button className="quiet" disabled={presetsLoading} onClick={onPresets}>
          {language === "zh-CN" ? "标注预设…" : "Annotation presets…"}</button>}
      </section>
      <StoragePanel language={language} />
      <section className="settings-group">
        <h2>{t.backup}</h2>
        <p className="hint">{t.localDataNotice}</p>
        <div className="detail-actions">
          <button className="quiet" onClick={exportJson}>{t.downloadJson}</button>
          <button className="quiet" onClick={exportMarkdown}>{t.downloadMarkdown}</button>
        </div>
        <label className="file-input">{t.chooseFile}
          <input type="file" accept="application/json,.json"
            onChange={(event) => void readImport(event.target.files?.[0])} />
        </label>
        {preview ? (
          <div className="import-preview">
            <p>{t.importSummary(preview)}</p>
            <label className="switch-row">
              <input type="checkbox" checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)} />{" "}
              {t.overwrite}
            </label>
            <button className="primary" disabled={busyImport} onClick={importBackup}>
              {busyImport ? t.importing : t.import}</button>
          </div>
        ) : null}
        <p className="hint">{t.importSettings}</p>
      </section>
      <BuildInfo language={language} />
    </section>
  );
}
