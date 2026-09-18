import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { toMarkdown } from '../core/backup';
import { request } from '../core/client';
import { COLORS, DEFAULT_SETTINGS, type AnchorState, type Annotation, type BackupEnvelope, type ImportPreview, type Language, type Settings } from '../core/model';
import { isWebPage, pageKey } from '../core/url';
import './management.css';
import { StoragePanel } from './StoragePanel';

type Mode = 'sidepanel' | 'library';
type TabContext = { id?: number; url?: string; title?: string };
type Draft = { note: string; tags: string; color: string; base: Annotation };

const COPY = {
  'zh-CN': {
    title: 'Web Ink', current: '当前页面', library: '资料库', openLibrary: '打开资料库', refresh: '刷新', settings: '设置', language: '语言', chinese: '中文', english: 'English', defaultColor: '默认颜色', pause: '暂停此网站', resume: '恢复此网站', paused: '此网站已暂停，现有标注不会显示。',
    permission: '启用网页访问', permissionText: '请允许 Web Ink 访问 HTTP(S) 网页，才能显示和保存标注。', unsupported: '当前标签页不支持', unsupportedText: '请打开一个 HTTP(S) 网页后再使用 Web Ink。', empty: '这个页面还没有标注', emptyText: '选中网页文字，或使用图片绘制工具开始。', search: '搜索文字、笔记、网址或标签', all: '全部', text: '文字', image: '图片', located: '已定位', pending: '等待加载', unresolved: '未定位', unsupportedStatus: '不支持', focus: '定位', source: '打开来源', rebind: '重新定位', draw: '绘制', save: '保存', delete: '删除', note: '笔记', tags: '标签（以逗号分隔）', cancel: '取消', updated: '已保存', conflict: '该标注已在其他窗口更新。你的草稿仍已保留。', loadLatest: '载入最新版本', deleteConfirm: '删除这条标注？此操作无法撤销。', backup: '备份与导入', downloadJson: '下载 JSON', downloadMarkdown: '下载 Markdown', import: '导入备份', chooseFile: '选择 JSON 文件', preview: '预览导入', overwrite: '覆盖同 ID 的冲突记录', importSettings: '导入文件中的设置不会覆盖本地设置。', importSummary: (p: ImportPreview) => `共 ${p.total} 条：新增 ${p.added}，相同 ${p.identical}，冲突 ${p.conflicts}`, importing: '正在导入', importDone: '导入完成', noResults: '没有匹配的标注', page: '页面', unknownPage: '无法读取当前页面', actionUnavailable: '此操作需要当前网页标签页。',
  },
  en: {
    title: 'Web Ink', current: 'Current page', library: 'Library', openLibrary: 'Open library', refresh: 'Refresh', settings: 'Settings', language: 'Language', chinese: '中文', english: 'English', defaultColor: 'Default color', pause: 'Pause this site', resume: 'Resume this site', paused: 'This site is paused; existing annotations are hidden.',
    permission: 'Enable page access', permissionText: 'Allow Web Ink to access HTTP(S) pages to show and save annotations.', unsupported: 'This tab is not supported', unsupportedText: 'Open an HTTP(S) page to use Web Ink.', empty: 'No annotations on this page', emptyText: 'Select text on a page or use the image drawing tool to begin.', search: 'Search text, notes, URLs, or tags', all: 'All', text: 'Text', image: 'Image', located: 'Located', pending: 'Loading', unresolved: 'Unresolved', unsupportedStatus: 'Unsupported', focus: 'Focus', source: 'Open source', rebind: 'Rebind', draw: 'Draw', save: 'Save', delete: 'Delete', note: 'Note', tags: 'Tags (comma separated)', cancel: 'Cancel', updated: 'Saved', conflict: 'This annotation changed in another window. Your draft is still here.', loadLatest: 'Load latest version', deleteConfirm: 'Delete this annotation? This cannot be undone.', backup: 'Backup & import', downloadJson: 'Download JSON', downloadMarkdown: 'Download Markdown', import: 'Import backup', chooseFile: 'Choose JSON file', preview: 'Preview import', overwrite: 'Overwrite conflicting IDs', importSettings: 'Settings in an import never replace local settings.', importSummary: (p: ImportPreview) => `${p.total} total: ${p.added} new, ${p.identical} identical, ${p.conflicts} conflicts`, importing: 'Importing', importDone: 'Import complete', noResults: 'No matching annotations', page: 'Page', unknownPage: 'Cannot read the active page', actionUnavailable: 'This action needs an active web tab.',
  },
} as const;

function annotationText(annotation: Annotation): string {
  const target = annotation.kind === 'text' ? annotation.target.exact : `${annotation.target.alt} ${annotation.target.context} ${annotation.target.src}`;
  return `${annotation.pageTitle} ${annotation.pageUrl} ${annotation.note} ${annotation.tags.join(' ')} ${annotation.color} ${target}`.toLocaleLowerCase();
}
function tagText(tags: string[]): string { return tags.join(', '); }
function parseTags(value: string): string[] { return [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))]; }
function statusClass(status: AnchorState['status'] | undefined): string { return `status ${status ?? 'pending'}`; }

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function localDate(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function mountManagementApp(root: HTMLElement, mode: Mode): void { createRoot(root).render(<ManagementApp mode={mode} />); }

export function ManagementApp({ mode }: { mode: Mode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [records, setRecords] = useState<Annotation[]>([]);
  const [tab, setTab] = useState<TabContext>({});
  const [hasPermission, setHasPermission] = useState(true);
  const [states, setStates] = useState<Record<string, AnchorState>>({});
  const [pageEnabled, setPageEnabled] = useState(false);
  const [query, setQuery] = useState('');
  const [colorFilter, setColorFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [filter, setFilter] = useState<'all' | Annotation['kind']>('all');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<string>();
  const [conflicts, setConflicts] = useState<Record<string, true>>({});
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [overwrite, setOverwrite] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const language = settings.language;
  const t = COPY[language];
  const pageUrl = tab.url && isWebPage(tab.url) ? pageKey(tab.url) : undefined;
  const origin = pageUrl ? new URL(pageUrl).origin : undefined;
  const paused = Boolean(origin && settings.disabledOrigins.includes(origin));

  const refresh = useCallback(async () => {
    try {
      const nextTab = mode === 'sidepanel' ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] : undefined;
      const nextContext: TabContext = nextTab ? { id: nextTab.id, url: nextTab.url, title: nextTab.title } : {};
      const nextUrl = nextContext.url && isWebPage(nextContext.url) ? pageKey(nextContext.url) : undefined;
      const [nextSettings, nextRecords, permission] = await Promise.all([
        request<Settings>({ type: 'settings.get' }),
        request<Annotation[]>({ type: 'annotations.list', ...(mode === 'sidepanel' && nextUrl ? { pageUrl: nextUrl } : {}) }),
        chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }),
      ]);
      setSettings(nextSettings); setRecords(nextRecords); setTab(nextContext); setHasPermission(permission);
      if (mode === 'sidepanel' && nextContext.id !== undefined && nextUrl) {
        const result = await request<{ pageUrl?: string; states: AnchorState[]; enabled?: boolean }>({ type: 'page.state.get', tabId: nextContext.id });
        const nextStates: Record<string, AnchorState> = {};
        for (const state of result.states) nextStates[state.id] = state;
        setStates(nextStates);
        setPageEnabled(result.enabled === true);
      } else { setStates({}); setPageEnabled(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [mode]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const listener = (message: unknown) => {
      const type = typeof message === 'object' && message ? (message as { type?: string; tabId?: number }).type : undefined;
      const changedTab = typeof message === 'object' && message ? (message as { tabId?: number }).tabId : undefined;
      if (type === 'annotations.changed' || type === 'settings.changed' || type === 'page.mode.changed' || type === 'page.state.changed' && changedTab === tab.id) void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    const activated = () => { if (mode === 'sidepanel') void refresh(); };
    const updated = () => { if (mode === 'sidepanel') void refresh(); };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    return () => { chrome.runtime.onMessage.removeListener(listener); chrome.tabs.onActivated.removeListener(activated); chrome.tabs.onUpdated.removeListener(updated); };
  }, [mode, refresh, tab.id]);

  const visible = useMemo(() => records.filter(record =>
    (filter === 'all' || record.kind === filter) && (!colorFilter || record.color === colorFilter) &&
    (!tagFilter || record.tags.includes(tagFilter)) && annotationText(record).includes(query.trim().toLocaleLowerCase())),
  [records, filter, query, colorFilter, tagFilter]);
  const saveSettings = async (next: Settings) => {
    try { const saved = await request<Settings>({ type: 'settings.put', settings: next }); setSettings(saved); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const enablePermissions = async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      if (!granted) throw new Error(language === 'zh-CN' ? '未授予网页访问权限。' : 'Page access was not granted.');
      await request<boolean>({ type: 'permissions.enable' }); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const pageAction = async (action: 'focus' | 'rebind' | 'draw', id?: string) => {
    if (tab.id === undefined) { setError(t.actionUnavailable); return; }
    try { await request<boolean>({ type: 'page.action', tabId: tab.id, action, ...(id ? { id } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const toggleCurrentPage = async () => {
    if (!pageUrl) return;
    try { await request({ type: 'page.mode.put', pageUrl, enabled: !pageEnabled }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const startEdit = (record: Annotation) => {
    setEditing(record.id);
    setDrafts(current => ({ ...current, [record.id]: current[record.id] ?? { note: record.note, tags: tagText(record.tags), color: record.color, base: record } }));
  };
  const updateDraft = (id: string, patch: Pick<Partial<Draft>, 'note' | 'tags' | 'color'>) => setDrafts(current => current[id] ? ({ ...current, [id]: { ...current[id], ...patch } }) : current);
  const saveRecord = async (id: string) => {
    const draft = drafts[id]; if (!draft) return;
    try {
      const candidate: Annotation = { ...draft.base, note: draft.note, tags: parseTags(draft.tags), color: draft.color, updatedAt: new Date().toISOString() };
      const saved = await request<Annotation>({ type: 'annotations.put', annotation: candidate, expectedRevision: draft.base.revision });
      setRecords(current => current.map(item => item.id === saved.id ? saved : item));
      setDrafts(current => { const { [id]: _removed, ...rest } = current; return rest; });
      setConflicts(current => { const { [id]: _removed, ...rest } = current; return rest; });
      setEditing(undefined); setNotice(t.updated);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/changed in another tab|CONFLICT/i.test(message)) { setConflicts(current => ({ ...current, [id]: true })); setError(t.conflict); void refresh(); }
      else setError(message);
    }
  };
  const loadLatest = async (id: string) => {
    const draft = drafts[id]; if (!draft) return;
    try {
      const latest = await request<Annotation[]>({ type: 'annotations.list', ...(mode === 'sidepanel' && pageUrl ? { pageUrl } : {}) });
      const record = latest.find(item => item.id === id);
      if (!record) throw new Error(language === 'zh-CN' ? '标注已被删除。' : 'The annotation was deleted.');
      setRecords(latest);
      setDrafts(current => current[id] ? ({ ...current, [id]: { ...current[id], base: record } }) : current);
      setConflicts(current => { const { [id]: _removed, ...rest } = current; return rest; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const removeRecord = async (record: Annotation) => {
    if (!window.confirm(t.deleteConfirm)) return;
    try { await request<{ id: string; deleted: true }>({ type: 'annotations.delete', id: record.id, expectedRevision: record.revision }); setRecords(current => current.filter(item => item.id !== record.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const exportJson = async () => { try { const value = await request<BackupEnvelope>({ type: 'backup.export' }); download('web-ink-backup.json', JSON.stringify(value), 'application/json'); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const exportMarkdown = async () => { try { const value = await request<BackupEnvelope>({ type: 'backup.export' }); download('web-ink-annotations.md', toMarkdown(value.annotations), 'text/markdown;charset=utf-8'); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const readImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setError('Import file exceeds 20 MiB.'); return; }
    try { const value: unknown = JSON.parse(await file.text()); const nextPreview = await request<ImportPreview>({ type: 'backup.preview', backup: value }); setBackup(value); setPreview(nextPreview); setError(undefined); }
    catch (cause) { setBackup(undefined); setPreview(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const importBackup = async () => {
    if (!backup) return;
    setBusyImport(true);
    try { await request<ImportPreview>({ type: 'backup.import', backup, overwrite }); setNotice(t.importDone); setBackup(undefined); setPreview(undefined); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyImport(false); }
  };

  return <main className="ink-app">
    <header className="topbar"><div><p className="eyebrow">LOCAL WEB NOTES</p><h1>{t.title}</h1></div><div className="header-actions">
      {mode === 'sidepanel' ? <button className="quiet" onClick={() => window.open(chrome.runtime.getURL('library.html'))}>{t.openLibrary}</button> : null}
      <button className="icon-button" onClick={() => void refresh()} aria-label={t.refresh} title={t.refresh}>↻</button>
    </div></header>
    {error ? <p className="alert error" role="alert">{error}<button onClick={() => setError(undefined)} aria-label="Close">×</button></p> : null}
    {notice ? <p className="alert notice" role="status">{notice}<button onClick={() => setNotice(undefined)} aria-label="Close">×</button></p> : null}
    {mode === 'sidepanel' ? <section className="page-card"><p className="eyebrow">{t.current}</p><strong>{pageUrl ? (tab.title || new URL(pageUrl).host) : t.unknownPage}</strong>{pageUrl ? <span>{new URL(pageUrl).host}</span> : null}</section> : <section className="page-card"><p className="eyebrow">{t.library}</p><strong>{records.length} {language === 'zh-CN' ? '条标注' : 'annotations'}</strong></section>}
    {!hasPermission ? <section className="empty permission-empty"><span aria-hidden="true">⌁</span><h2>{t.permission}</h2><p>{t.permissionText}</p><button className="primary" onClick={() => void enablePermissions()}>{t.permission}</button></section> : null}
    {mode === 'sidepanel' && hasPermission && !pageUrl ? <Empty title={t.unsupported} text={t.unsupportedText} /> : null}
    {mode === 'sidepanel' && pageUrl && hasPermission && paused ? <section className="pause-card"><strong>{t.paused}</strong><button className="quiet" onClick={() => void saveSettings({ ...settings, disabledOrigins: settings.disabledOrigins.filter(item => item !== origin) })}>{t.resume}</button></section> : null}
    {mode === 'sidepanel' && pageUrl && hasPermission && !paused ? <div className="toolbar"><button className="quiet" onClick={() => void saveSettings({ ...settings, disabledOrigins: origin ? [...settings.disabledOrigins, origin] : settings.disabledOrigins })}>{t.pause}</button><button className="quiet" aria-pressed={pageEnabled} onClick={() => void toggleCurrentPage()}>{language === 'zh-CN' ? (pageEnabled ? '关闭本页标注' : '开启本页标注') : (pageEnabled ? 'Disable page annotations' : 'Enable page annotations')}</button><button className="primary" onClick={() => void pageAction('draw')}>{t.draw}</button></div> : null}
    {hasPermission && (mode === 'library' || pageUrl) ? <>
      <section className="filters"><label className="search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t.search} /></label><div className="chips" role="group" aria-label="Filter annotation kind">{(['all', 'text', 'image'] as const).map(value => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>{value === 'all' ? t.all : value === 'text' ? t.text : t.image}</button>)}</div></section>
      <div className="button-row filter-selects">
        <label>{language === 'zh-CN' ? '颜色' : 'Color'} <select aria-label={language === 'zh-CN' ? '按颜色筛选' : 'Filter by color'} value={colorFilter} onChange={event => setColorFilter(event.target.value)}>
          <option value="">{t.all}</option>{[...new Set(records.map(r => r.color))].sort().map(color => <option key={color} value={color}>{color}</option>)}
        </select></label>
        <label>{language === 'zh-CN' ? '标签' : 'Tag'} <select aria-label={language === 'zh-CN' ? '按标签筛选' : 'Filter by tag'} value={tagFilter} onChange={event => setTagFilter(event.target.value)}>
          <option value="">{t.all}</option>{[...new Set(records.flatMap(r => r.tags))].sort().map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select></label>
      </div>
      {!records.length && !query && mode === 'sidepanel' ? <Empty title={t.empty} text={t.emptyText} /> : null}
      {visible.length ? <section className="record-list" aria-label={t.library}>{visible.map(record => <AnnotationCard key={record.id} record={record} state={states[record.id]} language={language} t={t} mode={mode} draft={drafts[record.id]} editing={editing === record.id} conflict={Boolean(conflicts[record.id])} onEdit={() => startEdit(record)} onDraft={patch => updateDraft(record.id, patch)} onSave={() => void saveRecord(record.id)} onLoadLatest={() => void loadLatest(record.id)} onCancel={() => setEditing(undefined)} onDelete={() => void removeRecord(record)} onFocus={() => void pageAction('focus', record.id)} onRebind={() => void pageAction('rebind', record.id)} onDraw={() => void pageAction('draw', record.id)} />)}</section> : records.length ? <Empty title={t.noResults} text="" /> : null}
    </> : null}
    <StoragePanel language={language} />
    <section className="settings"><details><summary>{t.settings}</summary><div className="settings-grid"><label>{t.language}<select value={settings.language} onChange={event => void saveSettings({ ...settings, language: event.target.value as Language })}><option value="zh-CN">{t.chinese}</option><option value="en">{t.english}</option></select></label><label>{t.defaultColor}<ColorPicker value={settings.defaultColor} onChange={color => void saveSettings({ ...settings, defaultColor: color })} /></label></div></details></section>
    <section className="backup"><details><summary>{t.backup}</summary><div className="backup-body"><div className="button-row"><button className="quiet" onClick={() => void exportJson()}>{t.downloadJson}</button><button className="quiet" onClick={() => void exportMarkdown()}>{t.downloadMarkdown}</button></div><label className="file-input">{t.chooseFile}<input type="file" accept="application/json,.json" onChange={event => void readImport(event.target.files?.[0])} /></label>{preview ? <div className="import-preview"><p>{t.importSummary(preview)}</p><label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /> {t.overwrite}</label><button className="primary" disabled={busyImport} onClick={() => void importBackup()}>{busyImport ? t.importing : t.import}</button></div> : null}<p className="hint">{t.importSettings}</p></div></details></section>
  </main>;
}

function Empty({ title, text }: { title: string; text: string }) { return <section className="empty"><span aria-hidden="true">⌁</span><h2>{title}</h2>{text ? <p>{text}</p> : null}</section>; }

function ColorPicker({ value, onChange, label = 'Custom color' }: { value: string; onChange: (color: string) => void; label?: string }) { return <span className="colors">{COLORS.map(color => <button key={color} className={value === color ? 'active' : ''} onClick={() => onChange(color)} style={{ backgroundColor: color }} aria-label={color} title={color} />)}<label className="custom-color"><span>{label}</span><input type="color" value={value} onChange={event => onChange(event.target.value)} aria-label={label} /></label></span>; }

function AnnotationCard({ record, state, language, t, mode, draft, editing, conflict, onEdit, onDraft, onSave, onLoadLatest, onCancel, onDelete, onFocus, onRebind, onDraw }: { record: Annotation; state?: AnchorState; language: Language; t: typeof COPY[Language]; mode: Mode; draft?: Draft; editing: boolean; conflict: boolean; onEdit: () => void; onDraft: (patch: Pick<Partial<Draft>, 'note' | 'tags' | 'color'>) => void; onSave: () => void; onLoadLatest: () => void; onCancel: () => void; onDelete: () => void; onFocus: () => void; onRebind: () => void; onDraw: () => void }) {
  const description = record.kind === 'text' ? record.target.exact : record.target.alt || record.target.context || record.target.src;
  const label = state ? t[state.status === 'located' ? 'located' : state.status === 'pending' ? 'pending' : state.status === 'unresolved' ? 'unresolved' : 'unsupportedStatus'] : undefined;
  return <article className="record" style={{ '--record-color': record.color } as React.CSSProperties}><div className="record-head"><span className="type">{record.kind === 'text' ? 'T' : '⌑'}</span><div><p className="record-title">{description}</p><p className="record-meta">{record.pageTitle || new URL(record.pageUrl).host} · {localDate(record.updatedAt, language)}</p></div>{label ? <span className={statusClass(state?.status)} title={state?.reason}>{label}</span> : null}</div>{editing && draft ? <div className="editor"><label>{t.note}<textarea value={draft.note} onChange={event => onDraft({ note: event.target.value })} maxLength={10_000} /></label><label>{t.tags}<input value={draft.tags} onChange={event => onDraft({ tags: event.target.value })} /></label><ColorPicker value={draft.color} onChange={color => onDraft({ color })} label={t.defaultColor} />{conflict ? <p className="draft-conflict">{t.conflict} <button className="quiet" onClick={onLoadLatest}>{t.loadLatest}</button></p> : null}<div className="button-row"><button className="primary" onClick={onSave}>{t.save}</button><button className="quiet" onClick={onCancel}>{t.cancel}</button></div></div> : <>{record.note ? <p className="note">{record.note}</p> : null}{record.tags.length ? <div className="tags">{record.tags.map(tag => <span key={tag}>#{tag}</span>)}</div> : null}<div className="record-actions">{mode === 'sidepanel' ? <button onClick={onFocus}>{t.focus}</button> : <a href={record.pageUrl} target="_blank" rel="noreferrer">{t.source}</a>}{state?.status === 'unresolved' && mode === 'sidepanel' ? <button onClick={onRebind}>{t.rebind}</button> : null}{record.kind === 'image' && mode === 'sidepanel' ? <button onClick={onDraw}>{t.draw}</button> : null}<button onClick={onEdit}>{t.note}</button><button className="danger" onClick={onDelete}>{t.delete}</button></div></>}</article>;
}
