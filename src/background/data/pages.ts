import type { PageMode, PageRecord, Result, Settings } from "../../core/model";
import { readSelectionToolbarEnabled } from "../../core/selection-toolbar";
import { getDatabase } from "../database";
import { applyIncrementalStats } from "../storage-stats";
import { readSettings } from "./settings";
import { fail, ok } from "./validation";

function effectivePageMode(
  pageUrl: string,
  page: PageRecord | undefined,
  settings?: Settings,
  automatic = false,
): PageMode {
  if (pageUrl.startsWith("urn:web-ink:pdf:")) return { enabled: page?.enabled === true };
  if (settings?.disabledOrigins.includes(new URL(pageUrl).origin))
    return { enabled: false, selectionToolsEnabled: false };
  const enabled = page?.modeOverride ? page.enabled === true : automatic || page?.enabled === true;
  // Older page overrides predate the intent field; annotation-only legacy
  // records have no override and must not opt into selection reminders.
  const manualSelectionTools =
    page?.modeOverride === true && page.enabled === true && page.manualSelectionTools !== false;
  return { enabled, selectionToolsEnabled: enabled && (automatic || manualSelectionTools) };
}

export async function getPageMode(pageUrl: string): Promise<PageMode> {
  if (pageUrl.startsWith("urn:web-ink:pdf:"))
    return effectivePageMode(pageUrl, await getDatabase().pages.get(pageUrl));
  const [page, settings, automatic] = await Promise.all([
    getDatabase().pages.get(pageUrl),
    readSettings(),
    readSelectionToolbarEnabled(),
  ]);
  // Reads are deliberately side-effect free: an unopened page stays absent from pages.
  return effectivePageMode(pageUrl, page, settings, automatic);
}

export async function putPageMode(
  pageUrl: string,
  enabled: boolean,
  selectionTools: boolean,
): Promise<Result<PageMode>> {
  const pdf = pageUrl.startsWith("urn:web-ink:pdf:");
  // Chrome storage must be read before entering the Dexie transaction.
  const [settings, automatic] = pdf
    ? ([undefined, false] as const)
    : await Promise.all([readSettings(), readSelectionToolbarEnabled()]);
  if (enabled && settings?.disabledOrigins.includes(new URL(pageUrl).origin))
    return fail("This site is paused and cannot be enabled.", "FORBIDDEN");
  const db = getDatabase();
  return db.transaction("rw", db.pages, db.stats, async () => {
    const existing = await db.pages.get(pageUrl);
    // A delayed sidebar save must not revoke a switch another tab enabled.
    const manualSelectionTools =
      selectionTools ||
      (enabled && existing?.enabled === true && existing.modeOverride === true &&
        existing.manualSelectionTools !== false);
    const stored: PageRecord = {
      url: pageUrl,
      title: existing?.title ?? "",
      updatedAt: new Date().toISOString(),
      enabled,
      ...(pdf ? {} : { modeOverride: true, manualSelectionTools }),
    };
    await db.pages.put(stored);
    await applyIncrementalStats({
      ...(existing ? { beforePage: existing } : {}),
      afterPage: stored,
    });
    return ok(effectivePageMode(pageUrl, stored, settings, automatic));
  });
}
