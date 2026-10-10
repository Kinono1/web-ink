import { test, expect, chromium, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('v0.3.0 profile upgrade preserves every durable annotation and local preference', async () => {
  const oldBuild = process.env.WEB_INK_OLD_BUILD;
  if (!oldBuild) throw new Error('Set WEB_INK_OLD_BUILD to the verified v0.3.0 release archive');

  const candidateBuild = process.env.WEB_INK_BUILD || path.resolve('.build-output/chrome-mv3');
  const root = await mkdtemp(path.join(tmpdir(), 'webink-upgrade-'));
  const extension = path.join(root, 'extension');
  const profile = path.join(root, 'profile');
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

  const install = async (source: string, expectedVersion: string) => {
    await rm(extension, { recursive: true, force: true });
    await cp(source, extension, { recursive: true });
    const manifestPath = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.version).toBe(expectedVersion);
    manifest.host_permissions = ['https://*/*', 'http://*/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));
  };

  const start = async () => {
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/library.html`);
    return { page, id };
  };

  const rpc = async (page: Page, message: object) => page.evaluate(async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'Extension request failed');
    return response.data;
  }, message);

  const readState = async (page: Page, modeUrls: string[]) => page.evaluate(async (urls) => {
    type StoredRecord = {
      id: string;
      kind: 'text' | 'image' | 'pdf-text' | 'pdf-area';
      revision: number;
      note: string;
      tags: string[];
      [key: string]: unknown;
    };
    const rpc = async (message: object) => {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || 'Extension request failed');
      return response.data;
    };
    const records = await rpc({ type: 'annotations.list' }) as StoredRecord[];
    records.sort((left, right) => left.id.localeCompare(right.id));
    const [settings, modes, preferences, backup] = await Promise.all([
      rpc({ type: 'settings.get' }),
      Promise.all(urls.map(pageUrl => rpc({ type: 'page.mode.get', pageUrl }))),
      chrome.storage.local.get('ui.palettePosition'),
      rpc({ type: 'backup.export' }),
    ]);
    return { records, settings, modes, preferences, backup };
  }, modeUrls);

  try {
    await install(oldBuild, '0.3.0');
    let current = await start();
    const id = current.id;
    const webUrl = 'https://example.test/upgrade';
    const pausedUrl = 'https://paused.example.test/upgrade';
    const pdfHash = 'a'.repeat(64);
    const pdfUrl = `urn:web-ink:pdf:${pdfHash}`;
    const modes = [
      { pageUrl: webUrl, enabled: true },
      { pageUrl: pausedUrl, enabled: false },
      { pageUrl: pdfUrl, enabled: true },
    ];
    const modeUrls = modes.map(mode => mode.pageUrl);
    const annotations = [
      {
        id: 'upgrade-text', kind: 'text', pageUrl: webUrl, pageTitle: 'Upgrade fixture',
        note: 'Initial text note', tags: ['initial', 'text'], color: '#facc15', revision: 0,
        createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
        target: { exact: 'upgrade text', prefix: '', suffix: '', start: 0, end: 12, rootSelector: 'body' },
      },
      {
        id: 'upgrade-image', kind: 'image', pageUrl: webUrl, pageTitle: 'Upgrade fixture',
        note: 'Initial image note', tags: ['initial', 'image'], color: '#facc15', revision: 0,
        createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
        target: {
          src: 'https://example.test/image.png', sourceCandidates: ['https://example.test/image.png'],
          alt: 'Fixture image', naturalWidth: 640, naturalHeight: 480, selector: '#fixture-image',
          occurrence: 0, context: 'Upgrade image fixture',
        },
        shape: { kind: 'rectangle', points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.7 }], width: 0.01 },
      },
      {
        id: 'upgrade-pdf-text', kind: 'pdf-text', pageUrl: pdfUrl, pageTitle: 'Upgrade PDF fixture',
        note: 'Initial PDF text note', tags: ['initial', 'pdf-text'], color: '#facc15', revision: 0,
        createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
        target: {
          documentHash: pdfHash, fileName: 'upgrade-fixture.pdf', sourceUrl: 'https://example.test/upgrade-fixture.pdf',
          pageNumber: 2, rects: [{ x: 0.1, y: 0.2, width: 0.35, height: 0.05 }],
          exact: 'PDF excerpt', prefix: 'A ', suffix: ' B',
        },
      },
      {
        id: 'upgrade-pdf-area', kind: 'pdf-area', pageUrl: pdfUrl, pageTitle: 'Upgrade PDF fixture',
        note: 'Initial PDF area note', tags: ['initial', 'pdf-area'], color: '#facc15', revision: 0,
        createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
        target: {
          documentHash: pdfHash, fileName: 'upgrade-fixture.pdf', sourceUrl: 'https://example.test/upgrade-fixture.pdf',
          pageNumber: 3, rects: [{ x: 0.2, y: 0.25, width: 0.4, height: 0.3 }],
          exact: '', prefix: '', suffix: '',
        },
      },
    ];

    await current.page.evaluate(async ({ annotations, modes, palettePosition }) => {
      const rpc = async (message: object) => {
        const response = await chrome.runtime.sendMessage(message);
        if (!response?.ok) throw new Error(response?.error || 'Extension request failed');
        return response.data;
      };
      for (const [index, annotation] of annotations.entries()) {
        const inserted = await rpc({ type: 'annotations.put', annotation, expectedRevision: 0 }) as { revision: number };
        const updated = await rpc({
          type: 'annotations.put',
          annotation: {
            ...annotation,
            revision: inserted.revision,
            note: `Updated note for ${annotation.kind}`,
            tags: ['upgrade', annotation.kind],
            color: ['#38bdf8', '#c084fc', '#fb7185', '#fb923c'][index],
            updatedAt: '2026-09-20T00:00:00.000Z',
          },
          expectedRevision: inserted.revision,
        }) as { revision: number };
        if (updated.revision !== inserted.revision + 1) {
          throw new Error(`Expected an incremented revision for ${annotation.id}`);
        }
      }
      const settings = await rpc({ type: 'settings.get' }) as Record<string, unknown>;
      await rpc({
        type: 'settings.put',
        settings: {
          ...settings,
          defaultColor: '#4ade80',
          disabledOrigins: ['https://paused.example.test'],
          theme: 'dark',
          reduceMotion: true,
          reduceTransparency: true,
        },
      });
      for (const mode of modes) await rpc({ type: 'page.mode.put', ...mode });
      await chrome.storage.local.set({ 'ui.palettePosition': palettePosition });
    }, { annotations, modes, palettePosition: { x: 0.73, y: 0.28 } });

    const before = await readState(current.page, modeUrls);
    expect(before.records.map(record => record.kind).sort()).toEqual(['image', 'pdf-area', 'pdf-text', 'text']);
    expect(before.records.map(record => record.revision)).toEqual([2, 2, 2, 2]);
    expect(before.records.map(record => record.id)).toEqual(annotations.map(annotation => annotation.id).sort());
    expect(before.records.map(record => record.note)).toEqual([
      'Updated note for image',
      'Updated note for pdf-area',
      'Updated note for pdf-text',
      'Updated note for text',
    ]);
    expect(before.records.map(record => record.tags)).toEqual([
      ['upgrade', 'image'],
      ['upgrade', 'pdf-area'],
      ['upgrade', 'pdf-text'],
      ['upgrade', 'text'],
    ]);
    expect(before.records.map(record => record.color)).toEqual(['#c084fc', '#fb923c', '#fb7185', '#38bdf8']);
    expect(before.records.map(record => record.target)).toEqual(
      [...annotations].sort((left, right) => left.id.localeCompare(right.id)).map(annotation => annotation.target),
    );
    expect(before.settings).toMatchObject({
      defaultColor: '#4ade80',
      disabledOrigins: ['https://paused.example.test'],
      theme: 'dark',
      reduceMotion: true,
      reduceTransparency: true,
    });
    expect(before.modes).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }]);
    expect(before.preferences).toEqual({ 'ui.palettePosition': { x: 0.73, y: 0.28 } });
    expect(before.backup.schemaVersion).toBe(2);

    await browser?.close();
    browser = undefined;
    await install(candidateBuild, '0.3.2');
    current = await start();
    expect(current.id).toBe(id);
    expect(await current.page.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.3.2');

    const after = await readState(current.page, modeUrls);
    expect(after.records).toEqual(before.records);
    expect(after.settings).toEqual(before.settings);
    expect(after.modes).toEqual(before.modes);
    expect(after.preferences).toEqual(before.preferences);
    expect(after.backup.schemaVersion).toBe(before.backup.schemaVersion);
    expect({ ...after.backup, exportedAt: before.backup.exportedAt }).toEqual(before.backup);

    for (const backup of [before.backup, after.backup]) {
      expect(Object.keys(backup).sort()).toEqual(['annotations', 'exportedAt', 'format', 'schemaVersion', 'settings']);
      expect(backup.annotations).toEqual(backup === before.backup ? before.records : after.records);
      expect(backup.settings).toEqual(backup === before.backup ? before.settings : after.settings);
      const serialized = JSON.stringify(backup);
      expect(serialized).not.toContain('ui.palettePosition');
      expect(serialized).not.toMatch(/"(?:bytes|pdfBytes)"\s*:/);
    }

    await current.page.getByRole('button', { name: '设置与数据', exact: true }).click();
    const downloaded = current.page.waitForEvent('download');
    await current.page.getByRole('button', { name: '下载 JSON', exact: true }).click();
    const download = await downloaded;
    const saved = await download.path();
    expect(saved).toBeTruthy();
    const downloadedBackup = JSON.parse(await readFile(saved!, 'utf8'));
    expect({ ...downloadedBackup, exportedAt: after.backup.exportedAt }).toEqual(after.backup);

    const preview = await rpc(current.page, { type: 'backup.preview', backup: before.backup });
    expect(preview).toEqual({ added: 0, identical: 4, conflicts: 0, total: 4 });
    const imported = await rpc(current.page, { type: 'backup.import', backup: before.backup, overwrite: false });
    expect(imported).toEqual(preview);
    const afterImport = await readState(current.page, modeUrls);
    expect(afterImport.records).toEqual(after.records);
    expect(afterImport.settings).toEqual(after.settings);
    expect(afterImport.modes).toEqual(after.modes);
    expect(afterImport.preferences).toEqual(after.preferences);
    expect({ ...afterImport.backup, exportedAt: after.backup.exportedAt }).toEqual(after.backup);
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
