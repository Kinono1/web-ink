import type { Result } from "../../core/model";
import { MAX_REVISION, validateAnnotation } from "../../core/validation";
import { executeAnnotationQuery, QueryTaskRegistry, validateAnnotationQuery, validQueryId } from "../query";
import { fail, observeBackgroundTask, ok } from "../request-result";
import { deleteAnnotation, getAnnotation, listAnnotations, putAnnotation, restoreAnnotation } from "./annotations";
import {
  isPdfAnnotation, pageKeyForMode, queryOwner, requireTrusted, validExpectedRevision, validId,
  type DataRequestContext, type KnownMessage,
} from "./validation";

type AnnotationRequest = Extract<KnownMessage, { type: `annotations.${string}` }>;
const queryTasks = new QueryTaskRegistry();

export function isAnnotationRequest(request: KnownMessage): request is AnnotationRequest {
  return request.type.startsWith("annotations.");
}

export async function handleAnnotationRequest(
  request: AnnotationRequest,
  context: DataRequestContext,
  ownPage: string | undefined,
): Promise<Result<unknown>> {
  switch (request.type) {
    case "annotations.get":
      return requireTrusted(context, "read annotations by ID") ?? ok(await getAnnotation(validId(request.id)));
    case "annotations.list": {
      const requested = request.pageUrl === undefined ? ownPage : pageKeyForMode(request.pageUrl, "pageUrl", context.trusted);
      if (!context.trusted && requested !== ownPage)
        return fail("Content scripts may only list their own page.", "FORBIDDEN");
      return ok(await listAnnotations(requested));
    }
    case "annotations.put":
    case "annotations.restore":
      return writeAnnotation(request, context, ownPage);
    case "annotations.delete": {
      const result = await deleteAnnotation(validId(request.id), validExpectedRevision(request.expectedRevision, MAX_REVISION), ownPage);
      if (!result.ok) return result;
      const { pageUrl, ...receipt } = result.data;
      const notify = context.annotationDeleted;
      if (notify) observeBackgroundTask(Promise.resolve().then(() => notify(pageUrl, receipt.id)), "annotation deletion notification");
      return ok(receipt);
    }
    case "annotations.query": {
      const query = validateAnnotationQuery(request.query, context.trusted, pageKeyForMode);
      if (!context.trusted && (!query.pageUrl || query.pageUrl !== ownPage ||
        query.kind === "pdf-text" || query.kind === "pdf-area"))
        return fail("Content scripts may only query their own web page.", "FORBIDDEN");
      return ok(await executeAnnotationQuery(query, queryOwner(context), queryTasks));
    }
    case "annotations.query.cancel":
      queryTasks.cancel(queryOwner(context), validQueryId(request.requestId, "requestId"));
      return ok(true);
  }
}

function writeAnnotation(
  request: Extract<AnnotationRequest, { type: "annotations.put" | "annotations.restore" }>,
  context: DataRequestContext,
  ownPage: string | undefined,
): Promise<Result<unknown>> | Result<unknown> {
  const annotation = validateAnnotation(request.annotation);
  if (!context.trusted) {
    const action = request.type === "annotations.put" ? "write" : "restore";
    if (isPdfAnnotation(annotation)) return fail(`Content scripts cannot ${action} PDF annotations.`, "FORBIDDEN");
    if (annotation.pageUrl !== ownPage) return fail(`Content scripts may only ${action} their own page.`, "FORBIDDEN");
  }
  return request.type === "annotations.put"
    ? putAnnotation(annotation, validExpectedRevision(request.expectedRevision), ownPage)
    : restoreAnnotation(annotation, ownPage);
}
