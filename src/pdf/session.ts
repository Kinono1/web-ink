import type { PDFDocumentLoadingTask } from "pdfjs-dist/types/src/display/api";

/** Owns the one live PDF.js loading task and its source-read AbortController. */
export class PdfSession {
  #generation = 0;
  #abort?: AbortController;
  #task?: PDFDocumentLoadingTask;
  #disposing?: Promise<void>;

  get generation(): number {
    return this.#generation;
  }
  isCurrent(token: number): boolean {
    return token === this.#generation;
  }

  async begin(): Promise<{ token: number; signal: AbortSignal }> {
    const token = ++this.#generation;
    await this.disposeCurrent();
    if (!this.isCurrent(token))
      throw new DOMException("Superseded PDF session.", "AbortError");
    const abort = new AbortController();
    this.#abort = abort;
    return { token, signal: abort.signal };
  }

  setTask(token: number, task: PDFDocumentLoadingTask): void {
    if (!this.isCurrent(token)) {
      void task.destroy();
      return;
    }
    this.#task = task;
  }

  async dispose(): Promise<void> {
    ++this.#generation;
    await this.disposeCurrent();
  }

  async disposeCurrent(): Promise<void> {
    this.#abort?.abort();
    this.#abort = undefined;
    const task = this.#task;
    this.#task = undefined;
    if (!task) return this.#disposing;
    const run = task.destroy().catch(() => undefined);
    this.#disposing = run;
    await run;
    if (this.#disposing === run) this.#disposing = undefined;
  }
}
