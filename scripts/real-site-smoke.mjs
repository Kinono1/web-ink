// Optional live-site check; deliberately excluded from deterministic CI.
// Uses production JS with pre-granted hosts in a temporary test-only manifest.
import { chromium } from '@playwright/test';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const build = await mkdtemp(path.join(tmpdir(), 'web-ink-sites-build-'));
const profile = await mkdtemp(path.join(tmpdir(), 'web-ink-sites-profile-'));
const reports = [];
let context;
const sites = [
  ['Wikipedia', 'https://en.wikipedia.org/wiki/Web_annotation', '#mw-content-text .mw-parser-output p:not(.mw-empty-elt)'],
  ['MDN', 'https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API', 'main article p, main p'],
  ['GitHub', 'https://github.com/wxt-dev/wxt', 'article.markdown-body p'],
];
try {
  await cp(path.resolve(process.env.WEB_INK_BUILD || '.output/chrome-mv3'), build, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`], viewport: { width: 1280, height: 960 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/library.html`);
  const rpc = message => manager.evaluate(async m => { const r = await chrome.runtime.sendMessage(m); if (!r?.ok) throw new Error(r?.error); return r.data; }, message);
  await rpc({ type: 'permissions.enable' });
  for (const [site, url, selector] of sites) {
    const page = await context.newPage();
    const entry = { site, url, checkedAt: new Date().toISOString(), result: 'not-run' };
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.locator('web-ink-ui').waitFor({ state: 'attached', timeout: 10000 });
      const toggle = page.locator('.web-ink-palette-toggle');
      if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
      await page.waitForFunction(() => document.querySelector('web-ink-ui')?.shadowRoot?.querySelector('.web-ink-palette-toggle')?.getAttribute('aria-pressed') === 'true');
      const paragraphs = page.locator(selector);
      let paragraph;
      for (let i = 0; i < Math.min(await paragraphs.count(), 20); i++) {
        const candidate = paragraphs.nth(i);
        if ((await candidate.innerText()).trim().length > 60 && await candidate.isVisible()) { paragraph = candidate; break; }
      }
      if (!paragraph) throw new Error('No suitable visible paragraph at the documented selector');
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
      await page.getByRole('button', { name: '高亮 #facc15', exact: true }).click({ timeout: 10000 });
      await page.waitForFunction(() => CSS.highlights.size > 0, { timeout: 10000 });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForFunction(() => CSS.highlights.size > 0, { timeout: 10000 });
      const records = await rpc({ type: 'annotations.list' });
      entry.records = records.filter(r => r.pageUrl.startsWith(url.split('#')[0])).length;
      entry.result = 'text-create-and-reload-pass';
    } catch (error) { entry.result = 'not-verified'; entry.error = String(error.message ?? error).slice(0, 1200); }
    reports.push(entry); console.log(JSON.stringify(entry));
    await page.close();
  }
} finally {
  await context?.close();
  await rm(build, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/real-sites.json', JSON.stringify({ browser: 'Playwright Chromium (pre-granted test manifest)', build: process.env.WEB_INK_BUILD || '.output/chrome-mv3', reports }, null, 2));
}
