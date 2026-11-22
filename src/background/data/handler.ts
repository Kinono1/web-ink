import type { Result } from "../../core/model";
import { parseBackup } from "../../core/backup";
import { validateSettings } from "../../core/validation";
import { getStorageStats } from "../storage-stats";
import { fail, invalid, ok, requestFailure } from "../request-result";
import { handleAnnotationRequest, isAnnotationRequest } from "./annotation-requests";
import { exportBackup, importBackup, previewBackup } from "./backup";
import { clearLibrary } from "./clear";
import { getPageMode, putPageMode } from "./pages";
import { readSettings, writeSettings } from "./settings";
import {
  canonicalContextPage, pageKeyForMode, parseMessage, requireTrusted,
  type DataRequestContext, type KnownMessage,
} from "./validation";

type PageModeRequest = Extract<KnownMessage, { type: "page.mode.get" | "page.mode.put" }>;
type BackupRequest = Extract<KnownMessage, { type: `backup.${string}` }>;

const backupActions = {
  "backup.export": "export backups",
  "backup.preview": "preview backups",
  "backup.import": "import backups",
} satisfies Record<BackupRequest["type"], string>;

/**
 * Single storage authority for the extension service worker. `trusted` identifies the
 * extension UI; sender URLs are canonicalized before content-script data access.
 */
export async function handleDataRequest(message: unknown, context: DataRequestContext): Promise<Result<unknown>> {
  try {
    const request = parseMessage(message);
    if (!request) return invalid("Unsupported or malformed data request.");
    const ownPage = canonicalContextPage(context);
    if (isAnnotationRequest(request)) return await handleAnnotationRequest(request, context, ownPage);
    switch (request.type) {
      case "page.mode.get":
      case "page.mode.put":
        return await handlePageModeRequest(request, context, ownPage);
      case "settings.get":
        return ok(await readSettings());
      case "storage.stats": {
        const forbidden = requireTrusted(context, "read whole-library storage usage");
        if (forbidden) return forbidden;
        if (request.recalculate !== undefined && typeof request.recalculate !== "boolean")
          return invalid("recalculate must be a boolean");
        return ok(await getStorageStats(await readSettings(), request.recalculate === true));
      }
      case "settings.put": {
        const forbidden = requireTrusted(context, "change settings");
        if (forbidden) return forbidden;
        const settings = validateSettings(request.settings);
        await writeSettings(settings);
        return ok(settings);
      }
      case "backup.export":
      case "backup.preview":
      case "backup.import":
        return await handleBackupRequest(request, context);
      case "library.clear": {
        const forbidden = requireTrusted(context, "delete the library");
        if (forbidden) return forbidden;
        return ok(await clearLibrary());
      }
    }
  } catch (error) {
    return requestFailure(error, "storage request", "Storage request failed.");
  }
}

async function handlePageModeRequest(request: PageModeRequest, context: DataRequestContext, ownPage: string | undefined) {
  const requested = pageKeyForMode(request.pageUrl, "pageUrl", context.trusted);
  if (request.type === "page.mode.get") {
    if (!context.trusted && requested !== ownPage)
      return fail("Content scripts may only read their own page mode.", "FORBIDDEN");
    return ok(await getPageMode(requested));
  }
  if (typeof request.enabled !== "boolean") return invalid("enabled must be a boolean");
  if (request.selectionTools !== undefined && typeof request.selectionTools !== "boolean")
    return invalid("selectionTools must be a boolean");
  if (!context.trusted && requested !== ownPage)
    return fail("Content scripts may only change their own page mode.", "FORBIDDEN");
  return putPageMode(requested, request.enabled, request.selectionTools ?? true);
}

async function handleBackupRequest(request: BackupRequest, context: DataRequestContext) {
  const forbidden = requireTrusted(context, backupActions[request.type]);
  if (forbidden) return forbidden;
  if (request.type === "backup.export") return ok(await exportBackup());
  if (request.type === "backup.preview") return ok(await previewBackup(parseBackup(request.backup).annotations));
  if (typeof request.overwrite !== "boolean") return invalid("overwrite must be a boolean");
  // Validate the whole backup first. Local settings remain the source of disabled-origin policy.
  const backup = parseBackup(request.backup);
  return ok(await importBackup(backup.annotations, request.overwrite));
}
