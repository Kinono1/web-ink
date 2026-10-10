// Usage: node scripts/benchmark-pdf-startup.mjs <build> <report.json> <source-url> [fixture.pdf]
// Disposable preauthorized profile; 3 remote opens or 3 warmups + 30 fixture samples.
import { chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const build = process.argv[2];
const output = process.argv[3];
const source = process.argv[4];
const fixture = process.argv[5];
const mode = fixture ? 'fixture' : 'remote';
if (!build || !output || !source) throw Error('Provide build directory, report path and public HTTPS source URL.');
const temp = await mkdtemp(path.join(tmpdir(), 'web-ink-startup-'));
let context;
try {
  const extension = path.join(temp, 'extension');
  await cp(build, extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['https://*/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1280, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  if (mode === 'fixture') {
    const bytes = await readFile(fixture);
    await page.route(source, r => r.fulfill({ contentType: 'application/pdf', body: bytes }));
  }
  await page.addInitScript((source) => {
    window.__startup = [];
    const log = (phase, extra = {}) => window.__startup.push({ phase, at: performance.now(), ...extra });
    const fetchOriginal = window.fetch;
    window.fetch = async (...args) => {
      const url = String(args[0]);
      const pdf = url === source;
      if (pdf) log('download:start', { cache: args[1]?.cache });
      const response = await fetchOriginal(...args);
      if (pdf) {
        log('download:headers', { status: response.status, headers: Object.fromEntries(response.headers) });
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = (...readerArgs) => {
          const reader = getReader(...readerArgs);
          const read = reader.read.bind(reader);
          reader.read = async () => {
            const result = await read();
            if (result.done) log('download:end');
            return result;
          };
          return reader;
        };
      }
      return response;
    };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      log('hash:start');
      const result = await digest(...args);
      log('hash:end');
      return result;
    };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (...args) => {
      const type = args[0]?.type;
      log(`${type}:start`);
      const result = await send(...args);
      log(`${type}:end`);
      return result;
    };
    const observer = new MutationObserver(() => {
      if (document.querySelector('.pdf-page[data-ready=true]')) {
        log('first-page:ready'); observer.disconnect();
      }
    });
    observer.observe(document, { subtree: true, attributes: true, childList: true });
  }, source);
  const runs = [];
  const count = mode === 'fixture' ? 33 : 3;
  for (let i = 0; i < count; i++) {
    await page.goto(`chrome-extension://${id}/pdf.html?source=${encodeURIComponent(source)}&open=1`);
    await page.locator('.pdf-page[data-ready=true]').first().waitFor({ timeout: 90000 });
    runs.push(await page.evaluate(() => ({
      events: window.__startup,
      resources: performance.getEntriesByType('resource').map(r => ({ name: r.name.split('/').pop(), start: r.startTime, duration: r.duration, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize })),
      canvases: document.querySelectorAll('.pdf-page canvas').length,
    })));
    console.error(`run ${i + 1}/${count}: ${runs.at(-1).events.find(e => e.phase === 'first-page:ready')?.at.toFixed(1)}ms`);
  }
  const report = { mode, browser: await worker.evaluate(() => navigator.userAgent), build: JSON.parse(await readFile(path.join(build, 'build-info.json'), 'utf8')), runs };
  await writeFile(output, JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}
