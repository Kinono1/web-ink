import { createHash } from 'node:crypto';

// PDF.js 6.3.289, Apache-2.0. Its stream-error path completes a partial
// operator list before rejecting an already resolved render-ready promise.
// Keep this fix local to the build and fail closed when the upstream changes.
export function patchPdfjsRenderErrors(source: string): string {
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== '91e29f812c593904e8d48d022db5ddf93e3443575d4765ac9bfbb42494cfbd8d') {
    throw Error('PDF.js source changed; review the render-error patch before building.');
  }
  const original = `          for (const internalRenderTask of intentState.renderTasks) {
            internalRenderTask.operatorListChanged();
          }
          this.#tryCleanup();`;
  const replacement = `          intentState.opListReadCapability?.reject(reason);
          for (const internalRenderTask of [...intentState.renderTasks]) {
            if (internalRenderTask.cancel) {
              internalRenderTask.cancel(reason);
            } else {
              intentState.renderTasks.delete(internalRenderTask);
            }
          }
          this.#tryCleanup();`;
  if (source.split(original).length !== 2) {
    throw Error('PDF.js render-error patch target must occur exactly once.');
  }
  return source.replace(original, replacement);
}
