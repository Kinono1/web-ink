import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('v0.3.0 profile upgrade preserves complete records, preferences, and backups', async () => {
  test.skip(!process.env.WEB_INK_OLD_BUILD, 'Set WEB_INK_OLD_BUILD to the verified v0.3.0 release archive');
  const root = await mkdtemp(path.join(tmpdir(), 'webink-upgrade-'));
  const extension = path.join(root, 'extension'), profile = path.join(root, 'profile');
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const install = async (source: string) => {
    await rm(extension, { recursive: true, force: true });
    await cp(source, extension, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['https://*/*', 'http://*/*'];
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  };
  const start = async () => {
    browser = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await browser.newPage(); await page.goto(`chrome-extension://${id}/library.html`);
    return { page, id };
  };
  try {
    await install(process.env.WEB_INK_OLD_BUILD!);
    let current = await start();
    const id = current.id;
    const row = { id: 'upgrade-fixture', kind: 'text', pageUrl: 'https://example.test/upgrade', pageTitle: 'Upgrade fixture', note: '保留这条笔记', tags: ['sample'], color: '#facc15', revision: 0, createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', target: { exact: 'preserved highlight', prefix: '', suffix: '', start: 0, end: 19, rootSelector: 'body' } };
    const before = await current.page.evaluate(async row => {
      const rpc = async (m: object) => { const r = await chrome.runtime.sendMessage(m); if (!r.ok) throw Error(r.error); return r.data; };
      await rpc({ type: 'annotations.put', annotation: row, expectedRevision: 0 });
      await rpc({ type: 'page.mode.put', pageUrl: row.pageUrl, enabled: true });
      return { records: await rpc({ type: 'annotations.list' }), mode: await rpc({ type: 'page.mode.get', pageUrl: row.pageUrl }) };
    }, row);
    await browser!.close(); browser = undefined;
    await install(path.resolve(process.env.WEB_INK_BUILD || '.output/chrome-mv3'));
    current = await start(); expect(current.id).toBe(id);
    const after = await current.page.evaluate(async pageUrl => {
      const rpc = async (m: object) => { const r = await chrome.runtime.sendMessage(m); if (!r.ok) throw Error(r.error); return r.data; };
      return { records: await rpc({ type: 'annotations.list' }), mode: await rpc({ type: 'page.mode.get', pageUrl }) };
    }, row.pageUrl);
    expect(after).toEqual(before);
    await expect(current.page.locator('.annotation-row')).toHaveCount(1);
    await current.page.getByRole('button', { name: '设置与数据', exact: true }).click();
    const downloaded = current.page.waitForEvent('download');
    await current.page.getByRole('button', { name: '下载 JSON', exact: true }).click();
    const backup = await downloaded;
    const saved = await backup.path(); expect(saved).toBeTruthy();
    const data = JSON.parse(await readFile(saved!, 'utf8'));
    expect(data.annotations).toEqual(before.records);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
