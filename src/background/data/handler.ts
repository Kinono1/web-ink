import type { Result } from "../../core/model";
import { parseBackup } from "../../core/backup";
import { validateAnnotation, validateSettings, ValidationError } from "../../core/validation";
import { executeAnnotationQuery, QueryTaskRegistry, validateAnnotationQuery, validQueryId } from "../query";
import { getStorageStats } from "../storage-stats";
import { deleteAnnotation, getAnnotation, listAnnotations, putAnnotation, restoreAnnotation } from "./annotations";
import { exportBackup, importBackup, previewBackup } from "./backup";
import { getPageMode, putPageMode } from "./pages";
import { readSettings, writeSettings } from "./settings";
import {
  canonicalContextPage, fail, invalid, isPdfAnnotation, ok, pageKeyForMode, parseMessage,
  queryOwner, requireTrusted, validExpectedRevision, validId, type DataRequestContext,
} from "./validation";

const queryTasks = new QueryTaskRegistry();

/**
 * Single storage authority for the extension service worker. `trusted` identifies the
 * extension UI; sender URLs are canonicalized before content-script data access.
 */
export async function handleDataRequest(message: unknown, context: DataRequestContext): Promise<Result<unknown>> {
  try {
    const request = parseMessage(message);
    if (!request) return invalid("Unsupported or malformed data request.");
    const ownPage = canonicalContextPage(context);
    switch (request.type) {
      case "annotations.get": {
        const forbidden = requireTrusted(context, "read annotations by ID");
        if (forbidden) return forbidden;
        return ok(await getAnnotation(validId(request.id)));
      }
      case "annotations.list": {
        const requested = request.pageUrl === undefined ? ownPage : pageKeyForMode(request.pageUrl, "pageUrl", context.trusted);
        if (!context.trusted && requested !== ownPage)
          return fail("Content scripts may only list their own page.", "FORBIDDEN");
        return ok(await listAnnotations(requested));
      }
      case "annotations.put": {
        const annotation = validateAnnotation(request.annotation);
        if (isPdfAnnotation(annotation) && !context.trusted)
          return fail("Content scripts cannot write PDF annotations.", "FORBIDDEN");
        if (!context.trusted && annotation.pageUrl !== ownPage)
          return fail("Content scripts may only write their own page.", "FORBIDDEN");
        return putAnnotation(annotation, validExpectedRevision(request.expectedRevision), ownPage);
      }
      case "annotations.restore": {
        const annotation = validateAnnotation(request.annotation);
        if (isPdfAnnotation(annotation) && !context.trusted)
          return fail("Content scripts cannot restore PDF annotations.", "FORBIDDEN");
        if (!context.trusted && annotation.pageUrl !== ownPage)
          return fail("Content scripts may only restore their own page.", "FORBIDDEN");
        return restoreAnnotation(annotation, ownPage);
      }
      case "annotations.delete":
        return deleteAnnotation(validId(request.id), validExpectedRevision(request.expectedRevision), ownPage);
      case "annotations.query": {
        const query = validateAnnotationQuery(request.query, context.trusted, pageKeyForMode);
        if (!context.trusted && (!query.pageUrl || query.pageUrl !== ownPage ||
          query.kind === "pdf-text" || query.kind === "pdf-area"))
          return fail("Content scripts may only query their own web page.", "FORBIDDEN");
        return ok(await executeAnnotationQuery(query, queryOwner(context), queryTasks));
      }
      case "annotations.query.cancel": {
        const requestId = validQueryId(request.requestId, "requestId");
        queryTasks.cancel(queryOwner(context), requestId);
        return ok(true);
      }
      case "page.mode.get": {
        const requested = pageKeyForMode(request.pageUrl, "pageUrl", context.trusted);
        if (!context.trusted && requested !== ownPage)
          return fail("Content scripts may only read their own page mode.", "FORBIDDEN");
        return ok(await getPageMode(requested));
      }
      case "page.mode.put": {
        const requested = pageKeyForMode(request.pageUrl, "pageUrl", context.trusted);
        if (typeof request.enabled !== "boolean") return invalid("enabled must be a boolean");
        if (request.selectionTools !== undefined && typeof request.selectionTools !== "boolean")
          return invalid("selectionTools must be a boolean");
        if (!context.trusted && requested !== ownPage)
          return fail("Content scripts may only change their own page mode.", "FORBIDDEN");
        return putPageMode(requested, request.enabled, request.selectionTools ?? true);
      }
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
      case "backup.export": {
        const forbidden = requireTrusted(context, "export backups");
        if (forbidden) return forbidden;
        return ok(await exportBackup());
      }
      case "backup.preview": {
        const forbidden = requireTrusted(context, "preview backups");
        if (forbidden) return forbidden;
        return ok(await previewBackup(parseBackup(request.backup).annotations));
      }
      case "backup.import": {
        const forbidden = requireTrusted(context, "import backups");
        if (forbidden) return forbidden;
        if (typeof request.overwrite !== "boolean") return invalid("overwrite must be a boolean");
        // parseBackup validates the entire input before any write; imported settings
        // are intentionally ignored so the local disabled-origin policy stays local.
        const backup = parseBackup(request.backup);
        return ok(await importBackup(backup.annotations, request.overwrite));
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) return invalid(error.message);
    return fail(error instanceof Error ? error.message : "Storage request failed.", "INTERNAL");
  }
}
