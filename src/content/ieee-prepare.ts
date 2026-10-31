import { readIeeePdf } from '../core/ieee-reader';
import { IeeePdfError } from '../core/ieee-contract';
import { IEEE_PREPARE_PORT, PDF_CHUNK_BYTES, encodePdfChunk } from '../core/prepared-contract';
import type { RuntimeHealth, Result } from '../core/model';
/** Installed only into the verified source document for an explicit PDF action. */
export function installIeeePreparation(): () => void {
  const active = new Map<chrome.runtime.Port, AbortController>();
  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== IEEE_PREPARE_PORT || port.sender?.id !== chrome.runtime.id ||
      window !== window.top || location.origin !== 'https://ieeexplore.ieee.org') return;
    const abort = new AbortController();
    active.set(port, abort);
    let started = false;
    let acknowledge: ((index: number) => void) | undefined;
    const stop = () => { abort.abort(); active.delete(port); };
    port.onDisconnect.addListener(stop);
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const input = message as { type?: string; token?: string; generation?: string; pageUrl?: string; sourceUrl?: string; index?: number };
      if (input.type === 'ack' && Number.isInteger(input.index)) { acknowledge?.(input.index!); return; }
      if (input.type === 'cancel') { stop(); return; }
      if (input.type !== 'start' || started) return;
      started = true;
      void (async () => {
        const health = await chrome.runtime.sendMessage({ type: 'runtime.health' }) as Result<RuntimeHealth>;
        if (!health?.ok || health.data.generation !== input.generation || input.pageUrl !== location.href ||
          typeof input.token !== 'string') throw Error('Source document changed');
        const token = input.token;
        let lastActivityAt = -Infinity;
        const activity = (byteLength: number) => {
          if (!byteLength || abort.signal.aborted || Date.now() - lastActivityAt < 500) return;
          lastActivityAt = Date.now();
          try { port.postMessage({ type: 'activity', token }); } catch { stop(); }
        };
        // Waiting heartbeats are diagnostic only. Body-byte activity and accepted
        // upload chunks are the events that prove preparation is progressing.
        const heartbeat = setInterval(() => {
          try { port.postMessage({ type: 'waiting', token: input.token }); } catch { stop(); }
        }, 5000);
        try {
          const bytes = await readIeeePdf({ pageUrl: input.pageUrl, ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}) }, abort.signal, {
            sourcePage: true,
            onProgress: diagnostic => port.postMessage({ type: 'progress', token: input.token, diagnostic }),
            onActivity: activity,
          });
          for (let offset = 0, index = 0; offset < bytes.length; offset += PDF_CHUNK_BYTES, index++) {
            abort.signal.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
              const cancelled = () => { acknowledge = undefined; reject(abort.signal.reason); };
              abort.signal.addEventListener('abort', cancelled, { once: true });
              acknowledge = received => {
                if (received !== index) return;
                abort.signal.removeEventListener('abort', cancelled);
                acknowledge = undefined;
                resolve();
              };
              port.postMessage({ type: 'chunk', token: input.token, index, data: encodePdfChunk(bytes.subarray(offset, offset + PDF_CHUNK_BYTES)) });
            });
          }
          abort.signal.throwIfAborted();
          port.postMessage({ type: 'finish', token: input.token, byteLength: bytes.length });
        } finally { clearInterval(heartbeat); }
      })().catch(error => {
        if (abort.signal.aborted) return;
        try {
          port.postMessage({ type: 'error', token: input.token, reason: error instanceof IeeePdfError ? error.reason : 'network',
            ...(error instanceof IeeePdfError ? { diagnostic: error.diagnostic, stage: error.stage } : {}) });
        } catch { stop(); }
      });
    });
  };
  chrome.runtime.onConnect.addListener(connect);
  const dispose = () => {
    for (const [port, abort] of active) {
      abort.abort();
      try { port.disconnect(); } catch { /* Reload already detached the port. */ }
    }
    active.clear();
    try { chrome.runtime.onConnect.removeListener(connect); } catch { /* Old context after Reload. */ }
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
