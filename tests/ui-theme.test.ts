import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../src/core/model';
import { ICON_PATHS } from '../src/ui/icons';
import { ManagementApp, pdfReaderUrl } from '../src/ui/ManagementApp';
import { CONTENT_THEME_CSS, PAGE_THEME_CSS, SCALE_TOKENS, THEME_TOKENS } from '../src/ui/theme';
import { shortDate } from '../src/ui/management/helpers';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const pdf: Annotation = {
  id: 'pdf-1', kind: 'pdf-text', pageUrl: 'urn:web-ink:pdf:abc123', pageTitle: 'Paper', color: '#facc15', note: '', tags: [],
  createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', revision: 1,
  target: { documentHash: 'abc123', fileName: 'paper.pdf', sourceUrl: 'https://example.test/paper.pdf?token=x', pageNumber: 3, rects: [{ x: .1, y: .2, width: .3, height: .1 }], exact: 'finding', prefix: '', suffix: '' },
};
const web: Annotation = {
  id: 'web-1', kind: 'text', pageUrl: 'https://example.test/article', pageTitle: 'Article', color: '#facc15', note: '', tags: [],
  createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', revision: 1,
  target: { exact: 'A removable highlight', prefix: '', suffix: '', start: 0, end: 20, rootSelector: 'body' },
};

describe('shared UI presentation contract', () => {
  it('keeps light and dark token sets usable by both React and Shadow DOM', () => {
    for (const key of ['--ink-bg', '--ink-surface', '--ink-text', '--ink-accent', '--ink-separator'] as const) {
      expect(THEME_TOKENS.light[key]).toBeTruthy(); expect(THEME_TOKENS.dark[key]).toBeTruthy();
      expect(CONTENT_THEME_CSS).toContain(`${key}:`);
    }
  });
  it('derives extension-page tokens from the same source, including the type scale', () => {
    for (const [key, value] of Object.entries(THEME_TOKENS.dark)) expect(PAGE_THEME_CSS).toContain(`${key}:${value};`);
    for (const key of Object.keys(SCALE_TOKENS)) expect(PAGE_THEME_CSS).toContain(`${key}:`);
    expect(PAGE_THEME_CSS).toContain(':root[data-theme="dark"]');
  });
  it('dates rows like mail: time today, day this year, full date before', () => {
    const now = new Date(2026, 8, 25, 18, 0);
    expect(shortDate(new Date(2026, 8, 25, 14, 52).toISOString(), 'zh-CN', now)).toBe('14:52');
    expect(shortDate(new Date(2026, 8, 3, 9, 0).toISOString(), 'zh-CN', now)).toBe('9月3日');
    expect(shortDate(new Date(2025, 11, 31, 9, 0).toISOString(), 'zh-CN', now)).toBe('2025年12月31日');
    expect(shortDate(new Date(2026, 8, 3, 9, 0).toISOString(), 'en', now)).toBe('Sep 3');
    expect(shortDate('not a date', 'en', now)).toBe('not a date');
  });
  it('ships only vector path data in the shared icon map', () => {
    expect(ICON_PATHS.pdf).toMatch(/^M/); expect(ICON_PATHS.library).toMatch(/^M/);
    expect(Object.values(ICON_PATHS).join('')).not.toContain('<svg');
  });
  it('opens a PDF record through its hash and source URL, never file content', () => {
    const url = new URL(pdfReaderUrl('chrome-extension://test/pdf.html', pdf));
    expect(url.pathname).toBe('/pdf.html'); expect(url.searchParams.get('document')).toBe('abc123');
    expect(url.searchParams.get('source')).toBe('https://example.test/paper.pdf?token=x');
    expect(url.search).not.toContain('rects'); expect(url.search).not.toContain('finding');
  });
});

describe('management mount lifecycle', () => {
  let root: Root | undefined;
  const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const confirmDescriptor = Object.getOwnPropertyDescriptor(window, 'confirm');
  afterEach(async () => {
    await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
    if (chromeDescriptor) Object.defineProperty(globalThis, 'chrome', chromeDescriptor); else Reflect.deleteProperty(globalThis, 'chrome');
    if (confirmDescriptor) Object.defineProperty(window, 'confirm', confirmDescriptor); else Reflect.deleteProperty(window, 'confirm');
  });
  it('loads settings and the first library page once after a stable mount', async () => {
    const sent = vi.fn(async (message: { type: string }) => {
      if (message.type === 'settings.get') return { ok: true, data: { language: 'zh-CN', defaultColor: '#facc15', disabledOrigins: [], theme: 'system', reduceMotion: false, reduceTransparency: false } };
      if (message.type === 'annotations.query') return { ok: true, data: { items: [] } };
      if (message.type === 'annotations.query.cancel') return { ok: true, data: true };
      return { ok: true, data: true };
    });
    const event = { addListener: vi.fn(), removeListener: vi.fn() };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
      runtime: { sendMessage: sent, onMessage: event, getURL: (path: string) => `chrome-extension://test/${path.replace(/^\//, '')}` },
      permissions: { contains: async () => true }, tabs: { query: async () => [], onActivated: event, onUpdated: event },
    } });
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(createElement(ManagementApp, { mode: 'library' })); await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(sent.mock.calls.filter(([message]) => message.type === 'settings.get')).toHaveLength(1);
    expect(sent.mock.calls.filter(([message]) => message.type === 'annotations.query')).toHaveLength(1);
  });
  it('names preference controls precisely and serializes rapid preference changes from the latest local state', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const sent = vi.fn(async (message: { type: string; settings?: Record<string, unknown> }) => {
      if (message.type === 'settings.get') return { ok: true, data: { language: 'zh-CN', defaultColor: '#facc15', disabledOrigins: [], theme: 'system', reduceMotion: false, reduceTransparency: false } };
      if (message.type === 'annotations.query') return { ok: true, data: { items: [] } };
      if (message.type === 'storage.stats') return { ok: true, data: { annotationCount: 0, textCount: 0, imageCount: 0, pdfTextCount: 0, pdfAreaCount: 0, pageCount: 0, logicalBytes: 0, backupBytes: 0, browserUsageBytes: null, browserQuotaBytes: null, backupLimitBytes: 20 * 1024 * 1024, backupRecordLimit: 50_000, storageWarningBytes: 1 } };
      if (message.type === 'settings.put') { writes.push(message.settings!); return { ok: true, data: message.settings }; }
      if (message.type === 'annotations.query.cancel') return { ok: true, data: true };
      return { ok: true, data: true };
    });
    const event = { addListener: vi.fn(), removeListener: vi.fn() };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
      runtime: { sendMessage: sent, onMessage: event, getURL: (path: string) => `chrome-extension://test/${path.replace(/^\//, '')}` },
      permissions: { contains: async () => true }, tabs: { query: async () => [], onActivated: event, onUpdated: event },
    } });
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(createElement(ManagementApp, { mode: 'library' })); await new Promise(resolve => setTimeout(resolve, 20)); });
    const settingsButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('设置与数据'))!;
    await act(async () => { settingsButton.click(); });
    const appearance = host.querySelector('select[aria-label="外观"]') as HTMLSelectElement;
    const language = host.querySelector('select[aria-label="语言"]') as HTMLSelectElement;
    expect(appearance).not.toBeNull(); expect(language).not.toBeNull();
    await act(async () => {
      appearance.value = 'dark'; appearance.dispatchEvent(new Event('change', { bubbles: true }));
      language.value = 'en'; language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ theme: 'dark', language: 'zh-CN' });
    expect(writes[1]).toMatchObject({ theme: 'dark', language: 'en' });
  });
  it('uses inline confirmation for a management delete without calling window.confirm', async () => {
    const sent = vi.fn(async (message: { type: string }) => {
      if (message.type === 'settings.get') return { ok: true, data: { language: 'zh-CN', defaultColor: '#facc15', disabledOrigins: [] } };
      if (message.type === 'annotations.query') return { ok: true, data: { items: [web] } };
      if (message.type === 'annotations.delete') return { ok: true, data: { id: web.id, deleted: true } };
      if (message.type === 'annotations.query.cancel') return { ok: true, data: true };
      return { ok: true, data: true };
    });
    const event = { addListener: vi.fn(), removeListener: vi.fn() };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
      runtime: { sendMessage: sent, onMessage: event, getURL: (path: string) => `chrome-extension://test/${path.replace(/^\//, '')}` },
      permissions: { contains: async () => true }, tabs: { query: async () => [], onActivated: event, onUpdated: event },
    } });
    const confirm = vi.fn(() => { throw new Error('native confirmation must not run'); });
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(createElement(ManagementApp, { mode: 'library' })); await new Promise(resolve => setTimeout(resolve, 20)); });
    const detail = host.querySelector('.annotation-detail')!;
    const remove = [...detail.querySelectorAll('button')].find(button => button.textContent === '删除')!;
    await act(async () => { remove.click(); });
    expect(sent.mock.calls.filter(([message]) => message.type === 'annotations.delete')).toHaveLength(0);
    const confirmDelete = [...detail.querySelectorAll('button')].find(button => button.textContent === '确认删除')!;
    await act(async () => { confirmDelete.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(confirm).not.toHaveBeenCalled();
    expect(sent.mock.calls.filter(([message]) => message.type === 'annotations.delete')).toHaveLength(1);
  });
});
