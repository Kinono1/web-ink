/** Reuse an existing reader without replacing its document or unsaved notes. */
export async function openPdfTab(url: string): Promise<void> {
  const target = new URL(url);
  const requestedSource = target.searchParams.get("source");
  const requestedDocument = target.searchParams.get("document");
  // Extension contexts expose our own reader URLs without broad tabs access.
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const tabs = contexts.map(context => ({ id: context.tabId, windowId: context.windowId, url: context.documentUrl }));
  const existing = tabs.find((tab) => {
    if (!tab.url || tab.id < 0) return false;
    const candidate = new URL(tab.url);
    if (candidate.protocol !== target.protocol || candidate.host !== target.host || candidate.pathname !== target.pathname) return false;
    // A generic PDF entry brings back a reader; choosing a specific record or
    // source must never silently open a different document.
    return (!requestedSource && !requestedDocument) ||
      (candidate.searchParams.get("source") === requestedSource && candidate.searchParams.get("document") === requestedDocument);
  });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}
