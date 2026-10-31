import { createPreparedPdfStore, type Owner, type PreparedPdfStore } from './pdf-prepared';
import type { PreparedInfo } from '../core/prepared-contract';
import { IEEE_PREPARE_PORT, encodePdfChunk, PDF_CHUNK_BYTES } from '../core/prepared-contract';
import { readIeeePdf } from '../core/ieee-reader';
import { IeeePdfError, ieeeSourceUrl, type IeeePdfReason } from '../core/ieee-contract';
import { createIeeePdfDiagnostic, type IeeePdfDiagnostic } from '../core/ieee-contract';
import { PdfResponseError } from '../core/pdf-source';

type ProgressMessage = { type: 'pdf.preparation.changed'; tabId: number; diagnostic?: IeeePdfDiagnostic; stage?: string };
type PortMessage = {
  type?: string; token?: string; index?: number; data?: string; byteLength?: number;
  diagnostic?: IeeePdfDiagnostic; reason?: IeeePdfReason; stage?: string;
};

export function createIeeePreparation(getGeneration: () => Promise<string>) {
  let store: PreparedPdfStore | undefined;
  let storeTask: Promise<PreparedPdfStore> | undefined;
  let flight: { owner: Owner; token: string; cancel: () => void } | undefined;
  const getStore = () => storeTask ??= getGeneration().then(generation => store = createPreparedPdfStore(generation));
  const progress = (tabId: number, diagnostic: IeeePdfDiagnostic | undefined, stage?: string) => {
    const message: ProgressMessage = { type: 'pdf.preparation.changed', tabId, ...(diagnostic ? { diagnostic } : {}), ...(stage ? { stage } : {}) };
    void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  };
  const prepare = async (tabId: number, documentId: string, pageUrl: string, sourceUrl: string | undefined, guard: () => Promise<void>): Promise<PreparedInfo> => {
    const data = await getStore();
    const owner = { tabId, documentId, generation: await getGeneration() };
    const token = data.begin(owner);
    return new Promise<PreparedInfo>((resolve, reject) => {
      let ended = false, finishing = false, sourcePort: chrome.runtime.Port | undefined;
      let timeout: ReturnType<typeof setTimeout>;
      const fail = (error: Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        data.release(token, owner);
        sourcePort?.disconnect();
        if (flight?.token === token) flight = undefined;
        reject(error);
      };
      const activity = () => {
        data.touch(token, owner);
        clearTimeout(timeout);
        timeout = setTimeout(() => fail(Error('IEEE preparation became inactive. Original PDF retained.')), 60_000);
      };
      activity();
      flight = { owner, token, cancel: () => fail(new DOMException('PDF reading cancelled', 'AbortError')) };
      void (async () => {
        await guard();
        await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files: ['ieee-prepare.js'] });
        await guard();
        if (ended) return;
        activity();
        const port = chrome.tabs.connect(tabId, { name: IEEE_PREPARE_PORT, documentId });
        sourcePort = port;
        port.onDisconnect.addListener(() => { if (!ended) fail(Error('IEEE source connection closed. Original PDF retained.')); });
        port.onMessage.addListener((raw: unknown) => {
          if (ended || finishing || !raw || typeof raw !== 'object') return;
          const message = raw as PortMessage;
          if (message.token !== token) return;
          void (async () => {
            if (message.type === 'waiting') return;
            if (message.type === 'activity') { activity(); return; }
            if (message.type === 'progress') {
              const item = message.diagnostic;
              if (!item || !['identify', 'wrapper', 'file', 'validate'].includes(item.phase) || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id)) return;
              progress(tabId, createIeeePdfDiagnostic({ ...item, startedAt: 0, now: item.elapsedMs }));
              activity();
            } else if (message.type === 'chunk') {
              data.append(token, owner, message.index!, message.data!);
              activity();
              port.postMessage({ type: 'ack', index: message.index });
            } else if (message.type === 'error') {
              const reasons: IeeePdfReason[] = ['source-hidden', 'site-permission', 'login-required', 'access-restricted', 'redirect-blocked', 'not-pdf', 'network'];
              const diagnostic = message.diagnostic;
              const safe = diagnostic && /^[a-f0-9-]{36}$/.test(diagnostic.id) && ['identify', 'wrapper', 'file', 'validate'].includes(diagnostic.phase)
                ? createIeeePdfDiagnostic({ ...diagnostic, startedAt: 0, now: diagnostic.elapsedMs }) : undefined;
              const responseError = message.stage === 'size-limit' || message.stage === 'length-mismatch' ? new PdfResponseError(message.stage) : undefined;
              throw new IeeePdfError(reasons.includes(message.reason!) ? message.reason! : 'network', responseError, safe);
            } else if (message.type === 'finish') {
              finishing = true;
              const info = await data.finish(token, owner, message.byteLength!);
              await guard();
              if (ended) return;
              progress(tabId, undefined, 'opening');
              ended = true;
              clearTimeout(timeout);
              if (flight?.token === token) flight = undefined;
              port.disconnect();
              resolve(info);
            }
          })().catch(error => fail(error instanceof Error ? error : Error('IEEE preparation failed.')));
        });
        port.postMessage({ type: 'start', token, generation: owner.generation, pageUrl, ...(sourceUrl ? { sourceUrl } : {}) });
      })().catch(error => {
        // Chrome injection/connect errors can include the full signed URL.
        // Only our guarded navigation errors and cancellation are safe to return.
        if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError') fail(error);
        else if (error instanceof Error && 'code' in error && ['PAGE_CHANGED', 'FORBIDDEN', 'CONTEXT_UNAVAILABLE'].includes(String(error.code))) fail(error);
        else fail(new IeeePdfError('network'));
      });
    });
  };
  // Native PDF viewers have no injectable source document. Keep the existing
  // exact-IEEE, redirect-rejecting background read, but still prepare before
  // navigation. The caller pins the observed URL/tab loading epoch throughout.
  const prepareDirect = async (tabId: number, sourceUrl: string, guard: () => Promise<void>): Promise<PreparedInfo> => {
    const source = ieeeSourceUrl(sourceUrl);
    if (!/\.pdf$/i.test(source.pathname)) throw new IeeePdfError('source-hidden');
    const data = await getStore();
    const owner = { tabId, documentId: `protected-read:${crypto.randomUUID()}`, generation: await getGeneration() };
    const token = data.begin(owner);
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const activity = () => {
      data.touch(token, owner);
      clearTimeout(timeout);
      timeout = setTimeout(() => abort.abort(Error('IEEE read became inactive. Original PDF retained.')), 60_000);
    };
    activity();
    flight = { owner, token, cancel: () => abort.abort(new DOMException('PDF reading cancelled', 'AbortError')) };
    // Only during this transient read, keep the worker alive while receiving
    // network bytes; this is not an idle extension poll.
    const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => undefined); }, 20_000);
    try {
      await guard();
      const bytes = await readIeeePdf({ pageUrl: source.href, sourceUrl: source.href }, abort.signal, {
        onProgress: diagnostic => { activity(); progress(tabId, diagnostic); }, onActivity: activity,
      });
      abort.signal.throwIfAborted();
      for (let offset = 0, index = 0; offset < bytes.length; offset += PDF_CHUNK_BYTES, index++)
        data.append(token, owner, index, encodePdfChunk(bytes.subarray(offset, offset + PDF_CHUNK_BYTES)));
      const info = await data.finish(token, owner, bytes.length);
      await guard();
      abort.signal.throwIfAborted();
      progress(tabId, undefined, 'opening');
      return info;
    } catch (error) {
      data.release(token, owner);
      throw error;
    } finally {
      clearTimeout(timeout!);
      clearInterval(keepAlive);
      if (flight?.token === token) flight = undefined;
    }
  };
  const cancelTab = (tabId: number) => { if (flight?.owner.tabId === tabId) flight.cancel(); };
  return { prepare, prepareDirect, getStore, cancelTab, releaseTab: (tabId: number) => { cancelTab(tabId); store?.releaseTab(tabId); } };
}
