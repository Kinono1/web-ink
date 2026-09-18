import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('.output/chrome-mv3');
const origins = ['http://*/*', 'https://*/*'];
let context: BrowserContext;
let profile: string;
let extensionId: string;
let manager: Page;
let grantedExtensionPath: string;
let activeExtensionPath: string;

async function rpc<T = any>(page: Page, message: object): Promise<T> {
  return page.evaluate(async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error ?? 'No extension response');
    return result.data;
  }, message);
}
async function start(profilePath: string) {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${activeExtensionPath}`, `--load-extension=${activeExtensionPath}`],
    viewport: { width: 1200, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/library.html`);
}
test.beforeAll(async () => {
  // Native optional-host approval is a MANUAL release check. For functional tests,
  // use identical production JS with hosts pre-granted in a disposable manifest.
  // The real production manifest is separately tested below and never modified.
  grantedExtensionPath = await mkdtemp(path.join(tmpdir(), 'web-ink-granted-build-'));
  await cp(extensionPath, grantedExtensionPath, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(grantedExtensionPath, 'manifest.json'), 'utf8'));
  manifest.host_permissions = origins;
  await writeFile(path.join(grantedExtensionPath, 'manifest.json'), JSON.stringify(manifest));
});
test.afterAll(async () => { if (grantedExtensionPath) await rm(grantedExtensionPath, { recursive: true, force: true }); });
test.beforeEach(async ({}, info) => {
  activeExtensionPath = info.title.startsWith('production permission') ? extensionPath : grantedExtensionPath;
  profile = await mkdtemp(path.join(tmpdir(), 'web-ink-e2e-'));
  await start(profile);
});
test.afterEach(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
async function enable() {
  await expect.poll(() => manager.evaluate(origins => chrome.permissions.contains({ origins }), origins)).toBe(true);
  await rpc(manager, { type: 'permissions.enable' });
}
async function article(activate = true) {
  const page = await context.newPage(); await page.goto('http://127.0.0.1:4173/article');
  await expect(page.locator('web-ink-ui')).toHaveCount(1);
  const toggle = page.locator('.web-ink-palette-toggle');
  await expect(toggle).toBeEnabled();
  if (activate && await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
  if (activate) await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  return page;
}
async function selectAndMark(page: Page, selector = '#selection strong') {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.locator(selector).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '高亮 #facc15', exact: true }).click();
  await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(1);
  await expect(page.locator('.toast')).toContainText('已保存到本机');
}

test('production permission is optional, onboarding is reachable, and pages are untouched before grant', async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions ?? []).toEqual([]);
  expect(await manager.evaluate(origins => chrome.permissions.contains({ origins }), origins)).toBe(false);
  await expect(manager.getByRole('button', { name: '启用网页访问', exact: true })).toBeVisible();
  const page = await context.newPage(); await page.goto('http://127.0.0.1:4173/article');
  expect(await page.locator('web-ink-ui').count()).toBe(0);
  expect(await rpc(manager, { type: 'annotations.list' })).toEqual([]);
});

test('real text marking, reload and browser restart keep records', async () => {
  await enable();
  const page = await article(); await selectAndMark(page);
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  await page.reload(); await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  const before = await rpc<any[]>(manager, { type: 'annotations.list' });
  const cdp = await context.newCDPSession(manager);
  await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  expect((await rpc<any[]>(manager, { type: 'annotations.list' }))[0].id).toBe(before[0].id);
  await cdp.detach();
  await context.close(); await start(profile);
  const reopened = await article(false);
  await expect(reopened.locator('.web-ink-palette-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => reopened.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  expect((await rpc<any[]>(manager, { type: 'annotations.list' }))[0].id).toBe(before[0].id);
  await manager.screenshot({ path: 'test-results/library.png', fullPage: true });
});

test('image drawing stores normalized points and follows responsive image size', async () => {
  await enable(); const page = await article();
  const tabs = await manager.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find(t => t.url === 'http://127.0.0.1:4173/article')!;
  await page.locator('#diagram').scrollIntoViewIfNeeded();
  await rpc(manager, { type: 'page.action', tabId: tab.id, action: 'draw' });
  await page.locator('#diagram').click();
  const box = await page.locator('#diagram').boundingBox();
  await page.mouse.move(box!.x + 150, box!.y + 90); await page.mouse.down();
  await page.mouse.move(box!.x + 310, box!.y + 200, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(1);
  const [record] = await rpc<any[]>(manager, { type: 'annotations.list' });
  expect(record.kind).toBe('image'); expect(record.shape.kind).toBe('rectangle');
  expect(record.shape.points[0].x).toBeGreaterThan(0); expect(record.shape.points[1].x).toBeLessThan(1);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const shape = page.locator(`g[data-annotation-id="${record.id}"] > rect`);
  const firstWidth = Number(await shape.getAttribute('width'));
  await page.locator('#diagram').evaluate(img => { (img as HTMLElement).style.width = '300px'; (img as HTMLElement).style.height = '160px'; });
  await expect.poll(async () => Number(await shape.getAttribute('width'))).toBeCloseTo(firstWidth / 2, 1);
  await page.reload(); await expect(shape).toHaveCount(1);
  await page.screenshot({ path: 'test-results/image-annotations.png' });
});

test('changed source is unresolved, backup remains complete, and stale writes fail', async () => {
  await enable(); const page = await article(); await selectAndMark(page);
  const [record] = await rpc<any[]>(manager, { type: 'annotations.list' });
  await page.locator('#selection strong').evaluate(element => { element.textContent = 'The original source has been changed completely.'; });
  const tabs = await manager.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find(t => t.url === 'http://127.0.0.1:4173/article')!;
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).states[0]?.status).toBe('unresolved');
  const updated = await rpc<any>(manager, { type: 'annotations.put', annotation: { ...record, note: 'A note saved elsewhere' }, expectedRevision: record.revision });
  expect(updated.revision).toBe(record.revision + 1);
  await expect(rpc(manager, { type: 'annotations.put', annotation: { ...record, note: 'Stale draft' }, expectedRevision: record.revision })).rejects.toThrow('changed in another tab');
  const backup = await rpc<any>(manager, { type: 'backup.export' });
  expect(backup.annotations[0].note).toBe('A note saved elsewhere');
  expect(await rpc(manager, { type: 'backup.preview', backup })).toMatchObject({ identical: 1, conflicts: 0 });
  await expect(rpc(manager, { type: 'backup.import', backup: { ...backup, schemaVersion: 999 }, overwrite: true })).rejects.toThrow();
  expect((await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(1);
});

test('all four image tools persist and session undo/redo preserves the drawing', async () => {
  await enable(); const page = await article();
  const tab = (await manager.evaluate(() => chrome.tabs.query({}))).find(t => t.url === 'http://127.0.0.1:4173/article')!;
  await page.locator('#diagram').scrollIntoViewIfNeeded();
  await rpc(manager, { type: 'page.action', tabId: tab.id, action: 'draw' });
  await page.locator('#diagram').click();
  const box = (await page.locator('#diagram').boundingBox())!;
  for (const [index, name] of ['方框', '椭圆', '箭头', '画笔'].entries()) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.mouse.move(box.x + 100 + index * 12, box.y + 100); await page.mouse.down();
    await page.mouse.move(box.x + 280 + index * 12, box.y + 180, { steps: 12 }); await page.mouse.up();
    await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(index + 1);
    await expect(page.locator('.toast')).toContainText('已保存到本机');
  }
  expect((await rpc<any[]>(manager, { type: 'annotations.list' })).map(a => a.shape.kind)).toEqual(['rectangle', 'ellipse', 'arrow', 'pen']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(3);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(4);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload(); await expect(page.locator('g[data-annotation-id]')).toHaveCount(4);
  await page.locator('#diagram').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/four-image-tools.png' });
});

test('site pause/resume and manual rebind retain the original record', async () => {
  await enable(); const page = await article(); await selectAndMark(page);
  const [before] = await rpc<any[]>(manager, { type: 'annotations.list' });
  const settings = await rpc<any>(manager, { type: 'settings.get' });
  await rpc(manager, { type: 'settings.put', settings: { ...settings, disabledOrigins: ['http://127.0.0.1:4173'] } });
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
  await rpc(manager, { type: 'settings.put', settings });
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  await page.locator('#selection strong').evaluate(el => { el.textContent = 'A revised statement selected by the reader.'; });
  const tab = (await manager.evaluate(() => chrome.tabs.query({}))).find(t => t.url === 'http://127.0.0.1:4173/article')!;
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).states[0]?.status).toBe('unresolved');
  await rpc(manager, { type: 'page.action', tabId: tab.id, action: 'rebind', id: before.id });
  await selectAndMark(page);
  await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' }))[0]?.revision).toBe(2);
  const [after] = await rpc<any[]>(manager, { type: 'annotations.list' });
  expect(after.id).toBe(before.id); expect(after.target.exact).toContain('A revised statement');
});

test('library editing, conflict preservation, JSON download and import work through the UI', async () => {
  await enable(); const page = await article(); await selectAndMark(page);
  await manager.bringToFront();
  const row = manager.locator('.annotation-row').first();
  await expect(row).toBeVisible(); await row.click();
  const detail = manager.locator('.annotation-detail').first();
  await detail.getByRole('button', { name: '笔记', exact: true }).click();
  await detail.getByRole('textbox', { name: '笔记', exact: true }).fill('我的草稿：保留到确认保存。');
  const [record] = await rpc<any[]>(manager, { type: 'annotations.list' });
  await rpc(manager, { type: 'annotations.put', annotation: { ...record, note: 'Another window' }, expectedRevision: record.revision });
  await detail.getByRole('button', { name: '保存', exact: true }).click();
  await expect(manager.getByRole('alert')).toContainText('草稿仍已保留');
  await expect(detail.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue('我的草稿：保留到确认保存。');
  await detail.getByRole('button', { name: '载入最新版本', exact: true }).click();
  await detail.getByRole('button', { name: '保存', exact: true }).click();
  await expect(detail.locator('.note')).toHaveText('我的草稿：保留到确认保存。');
  await manager.getByRole('button', { name: '设置与数据', exact: true }).click();
  const downloadEvent = manager.waitForEvent('download');
  await manager.getByRole('button', { name: '下载 JSON', exact: true }).click();
  const download = await downloadEvent;
  const backup = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(backup.annotations).toHaveLength(1);
  const latest = backup.annotations[0];
  await rpc(manager, { type: 'annotations.delete', id: latest.id, expectedRevision: latest.revision });
  await manager.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(manager.locator('.annotation-row')).toHaveCount(0);
  await manager.getByRole('button', { name: '设置与数据', exact: true }).click();
  await manager.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(manager.locator('.import-preview')).toContainText('新增 1');
  await manager.getByRole('button', { name: '导入备份', exact: true }).click();
  await manager.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(manager.locator('.annotation-row')).toHaveCount(1);
  await manager.screenshot({ path: 'test-results/library-editing.png', fullPage: true });
});

test('storage panel updates counts after create/delete and separates estimates from exact disk usage', async () => {
  await enable(); const page = await article();
  await manager.getByRole('button', { name: '设置与数据', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本地存储', exact: true });
  await expect(panel).toContainText('0 条标注');
  await selectAndMark(page);
  await expect(panel).toContainText('1 条标注'); await expect(panel).toContainText('1 个网页');
  const stats = await rpc<any>(manager, { type: 'storage.stats' });
  expect(stats.annotationCount).toBe(1); expect(stats.logicalBytes).toBeGreaterThan(0);
  await panel.getByText('占用详情', { exact: true }).click();
  await expect(panel).toContainText('浏览器估算不等于精确磁盘用量');
  const [record] = await rpc<any[]>(manager, { type: 'annotations.list' });
  await rpc(manager, { type: 'annotations.delete', id: record.id, expectedRevision: record.revision });
  await expect(panel).toContainText('0 条标注');
  await manager.screenshot({ path: 'test-results/storage-panel.png', fullPage: true });
});

test('SPA URL changes and streaming updates do not trigger cross-page errors', async () => {
  await enable(); const page = await article();
  await selectAndMark(page);
  await page.evaluate(() => {
    history.pushState({}, '', '/article?conversation=second');
    const stream = document.createElement('p'); stream.id = 'stream'; document.querySelector('main')!.append(stream);
    let count = 0;
    const timer = setInterval(() => {
      stream.textContent += ' streamed token';
      if (++count >= 8) clearInterval(timer);
    }, 80);
  });
  const tab = (await manager.evaluate(() => chrome.tabs.query({}))).find(t => t.url?.includes('conversation=second'))!;
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).pageUrl).toBe('http://127.0.0.1:4173/article?conversation=second');
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).states.length).toBe(0);
  await expect(page.locator('.toast.error')).not.toBeVisible();
  await expect(page.locator('.web-ink-palette-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '开启本页标注', exact: true }).click();
  await expect(page.locator('.web-ink-palette-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#selection strong').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '高亮 #4ade80', exact: true }).click();
  await expect.poll(async () => (await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(2);
  const records = await rpc<any[]>(manager, { type: 'annotations.list' });
  expect(records.filter(r => r.pageUrl === 'http://127.0.0.1:4173/article')).toHaveLength(1);
  expect(records.filter(r => r.pageUrl.endsWith('conversation=second'))).toHaveLength(1);
  const denied = await manager.evaluate(async tabId => {
    const result = await chrome.scripting.executeScript({ target: { tabId }, func: () =>
      chrome.runtime.sendMessage({ type: 'annotations.list', pageUrl: 'http://127.0.0.1:4173/article' }) });
    return result[0]?.result;
  }, tab.id!);
  expect(denied).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
  expect(denied.data).toBeUndefined();
  await page.evaluate(() => history.replaceState({}, '', '/article?conversation=third'));
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).pageUrl).toContain('conversation=third');
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).states.length).toBe(0);
  await page.goBack();
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).pageUrl).toBe('http://127.0.0.1:4173/article');
  await expect.poll(async () => (await rpc<any>(manager, { type: 'page.state.get', tabId: tab.id })).states[0]?.status).toBe('located');
  await expect(page.locator('.toast.error')).not.toBeVisible();
});

test('dismissed background errors stay quiet while failed saves retain retry controls', async () => {
  await enable(); const page = await article(); await selectAndMark(page);
  await expect(page.locator('.toast')).not.toBeVisible({ timeout: 5000 }); // Successful save auto-dismisses.
  const tab = (await manager.evaluate(() => chrome.tabs.query({}))).find(t => t.url === 'http://127.0.0.1:4173/article')!;
  // Fault injection exists only in this disposable isolated content-script world.
  await manager.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      (globalThis as any).__webInkSendMessage = original;
      chrome.runtime.sendMessage = ((message: any) => message?.type === 'annotations.list'
        ? Promise.resolve({ ok: false, code: 'INTERNAL', error: 'temporary recovery failure' }) : original(message)) as typeof chrome.runtime.sendMessage;
    } });
  }, tab.id!);
  await page.evaluate(() => document.querySelector('main')!.append(document.createTextNode(' change ')));
  await expect(page.locator('.toast.error')).toContainText('暂时无法恢复此页标注');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.evaluate(() => {
    const node = document.createElement('p'); document.querySelector('main')!.append(node);
    for (let i = 0; i < 8; i++) setTimeout(() => { node.textContent += ' more'; }, i * 100);
  });
  await page.waitForTimeout(1600); // Spans several actual restoration attempts.
  await expect(page.locator('.toast')).not.toBeVisible();
  await manager.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const original = (globalThis as any).__webInkSendMessage;
      chrome.runtime.sendMessage = ((message: any) => message?.type === 'annotations.put'
        ? Promise.resolve({ ok: false, code: 'INTERNAL', error: 'test storage failure' }) : original(message)) as typeof chrome.runtime.sendMessage;
    } });
  }, tab.id!);
  await page.locator('#repeat-b').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '高亮 #facc15', exact: true }).click();
  await expect(page.locator('.toast.error')).toContainText('保存失败');
  await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
  await page.waitForTimeout(4200);
  await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
  expect((await rpc<any[]>(manager, { type: 'annotations.list' })).length).toBe(1);
});

test('palette is quiet by default and remembers the page switch without deleting notes', async () => {
  await enable(); const page = await article(false);
  const toggle = page.locator('.web-ink-palette-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const select = () => page.locator('#selection strong').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await select();
  await expect(page.locator('.selection')).not.toBeVisible();
  await expect(page.locator('.toast')).not.toBeVisible();
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await selectAndMark(page);
  const stored = await rpc<any[]>(manager, { type: 'annotations.list' });
  expect(stored).toHaveLength(1);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
  await select(); await expect(page.locator('.selection')).not.toBeVisible();
  expect((await rpc<any[]>(manager, { type: 'annotations.list' }))[0].id).toBe(stored[0].id);
  await page.reload(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.toast')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/palette-off.png' });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/palette-on.png' });
  const second = await context.newPage(); await second.goto('http://127.0.0.1:4173/another-article');
  await expect(second.locator('.web-ink-palette-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('metadata changes preserve text ranges and scrolling reuses image SVG nodes', async () => {
  await enable(); const page = await article(); await selectAndMark(page);
  const [text] = await rpc<any[]>(manager, {type:'annotations.list'});
  await page.evaluate(() => { (window as any).__savedRange = [...CSS.highlights.values()][0]!.values().next().value; });
  await rpc(manager,{type:'annotations.put',annotation:{...text,note:'Metadata only'},expectedRevision:text.revision});
  await expect.poll(() => page.evaluate(() => [...CSS.highlights.values()][0]?.values().next().value === (window as any).__savedRange)).toBe(true);
  const tab = (await manager.evaluate(() => chrome.tabs.query({}))).find(t=>t.url==='http://127.0.0.1:4173/article')!;
  await rpc(manager,{type:'page.action',tabId:tab.id,action:'draw'});await page.locator('#diagram').click();
  const box=await page.locator('#diagram').boundingBox();await page.mouse.move(box!.x+100,box!.y+80);await page.mouse.down();await page.mouse.move(box!.x+230,box!.y+180,{steps:3});await page.mouse.up();
  await expect.poll(async()=>(await rpc<any[]>(manager,{type:'annotations.list'})).length).toBe(2);
  await page.getByRole('button',{name:'完成',exact:true}).click();
  const [drawing]= (await rpc<any[]>(manager,{type:'annotations.list'})).filter(r=>r.kind==='image');
  const group=page.locator(`g[data-annotation-id="${drawing.id}"]`);
  await group.evaluate(element=>{(window as any).__savedGroup=element;(window as any).__savedShape=element.querySelector(':scope > rect');});
  await page.evaluate(()=>window.scrollBy(0,60));
  await expect.poll(()=>group.evaluate(element=>element===(window as any).__savedGroup&&element.querySelector(':scope > rect')===(window as any).__savedShape)).toBe(true);
});

test('shared dark preferences and 320px layout remain usable across library and webpage', async () => {
  await enable();const page=await article();await selectAndMark(page);
  await manager.getByRole('button',{name:'设置与数据',exact:true}).click();
  await manager.getByLabel('外观',{exact:true}).selectOption('dark');
  await manager.getByLabel('减少透明效果',{exact:true}).check();
  await expect(manager.locator('.ink-app')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('web-ink-ui')).toHaveAttribute('data-web-ink-theme','dark');
  await manager.setViewportSize({width:320,height:760});
  await expect.poll(()=>manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await manager.screenshot({path:'test-results/settings-dark-narrow.png',fullPage:true});
  await manager.getByRole('button',{name:'资料库',exact:true}).click();
  await manager.locator('.annotation-row').first().click();
  await expect(manager.locator('.annotation-detail')).toBeVisible();
  await expect.poll(()=>manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await manager.screenshot({path:'test-results/library-dark-narrow.png',fullPage:true});
});
