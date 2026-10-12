import { createPreparedPdfStore, type Owner, type PreparedInfo, type PreparedPdfStore } from './pdf-prepared';
import { IEEE_PREPARE_PORT } from '../pdf/prepared';
import { IeeePdfError, type IeeePdfReason } from '../pdf/ieee';
import { createIeeePdfDiagnostic, type IeeePdfDiagnostic } from '../pdf/ieee-diagnostics';
import { PdfResponseError } from '../pdf/source';

export function createIeeePreparation(getGeneration: () => Promise<string>) {
  let store: PreparedPdfStore | undefined;
  let storeTask: Promise<PreparedPdfStore> | undefined;
  let flight: { owner: Owner; token: string; port?: chrome.runtime.Port; cancel: () => void } | undefined;
  const getStore = () => storeTask ??= getGeneration().then(generation => store = createPreparedPdfStore(generation));
  const progress = (tabId: number, diagnostic: IeeePdfDiagnostic | undefined, stage?: string) => {
    const message = { type: 'pdf.preparation.changed', tabId, ...(diagnostic ? { diagnostic } : {}), ...(stage ? { stage } : {}) };
    void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  };
  const prepare = async (tabId: number, documentId: string, pageUrl: string, sourceUrl: string | undefined, guard: () => Promise<void>): Promise<PreparedInfo> => {
    const data = await getStore();
    const owner = { tabId, documentId, generation: await getGeneration() };
    const token = data.begin(owner);
    return new Promise<PreparedInfo>((resolve, reject) => {
      let ended = false;
      let finishing = false;
      const fail = (error: Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        data.release(token, owner);
        flight?.port?.disconnect();
        if (flight?.token === token) flight = undefined;
        reject(error);
      };
      const timeout = setTimeout(() => fail(Error('IEEE preparation timed out. Original PDF retained.')), 60_000);
      flight = { owner, token, cancel: () => fail(new DOMException('PDF reading cancelled', 'AbortError')) };
      void (async () => {
        await guard();
        await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files: ['ieee-prepare.js'] });
        await guard();
        if (ended) return;
        const port = chrome.tabs.connect(tabId, { name: IEEE_PREPARE_PORT, documentId });
        flight!.port = port;
        port.onDisconnect.addListener(() => { if (!ended) fail(Error('IEEE source connection closed. Original PDF retained.')); });
        port.onMessage.addListener((raw: unknown) => {
          if (ended || finishing || !raw || typeof raw !== 'object') return;
          const message = raw as { type?: string; token?: string; index?: number; data?: string; byteLength?: number; diagnostic?: IeeePdfDiagnostic; reason?: IeeePdfReason; stage?: string };
          if (message.token !== token) return;
          void (async () => {
            if (message.type === 'waiting') return;
            if (message.type === 'progress') {
              const item = message.diagnostic;
              if (!item || !['identify', 'wrapper', 'file', 'validate'].includes(item.phase) || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id)) return;
              const diagnostic = createIeeePdfDiagnostic({ ...item, startedAt: 0, now: item.elapsedMs });
              progress(tabId, diagnostic);
            } else if (message.type === 'chunk') {
              data.append(token, owner, message.index!, message.data!);
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
  const cancelTab = (tabId: number) => { if (flight?.owner.tabId === tabId) flight.cancel(); };
  return { prepare, getStore, cancelTab, releaseTab: (tabId: number) => { cancelTab(tabId); store?.releaseTab(tabId); } };
}
