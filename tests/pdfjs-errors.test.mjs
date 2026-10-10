import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchPdfjsRenderErrors } from '../scripts/pdfjs-render-errors.ts';
import { fixturePdf } from './pdf-fixture.ts';

test('real PDF.js rejects incomplete operator lists while healthy pages remain readable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-ink-pdfjs-errors-'));
  const tasks = [];
  try {
    const source = await readFile('node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'utf8');
    const modulePath = path.join(directory, 'pdf.mjs');
    await writeFile(modulePath, patchPdfjsRenderErrors(source));
    const api = await import(pathToFileURL(modulePath).href);
    api.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    for (const oversizedImage of [true, false]) {
      const task = api.getDocument({
        data: new Uint8Array(fixturePdf(1, 'Image resource gate', { oversizedImage })),
        standardFontDataUrl: `${path.resolve('node_modules/pdfjs-dist/standard_fonts')}/`,
        stopAtErrors: true, maxImageSize: 16777216, verbosity: api.VerbosityLevel.ERRORS,
      });
      tasks.push(task);
      const page = await (await task.promise).getPage(1);
      if (oversizedImage) {
        await assert.rejects(page.getOperatorList(), /Image exceeded maximum allowed size/);
        assert.equal(page.cleanup(), true, 'failed operator-list task must release page resources');
      } else {
        const operators = await page.getOperatorList();
        assert.ok(operators.fnArray.length > 0);
        assert.equal(operators.lastChunk, true);
      }
    }
    assert.throws(() => patchPdfjsRenderErrors(`${source}\n// changed upstream`), /PDF.js source changed/);
  } finally {
    await Promise.all(tasks.map(task => task.destroy()));
    await rm(directory, { recursive: true, force: true });
  }
});
