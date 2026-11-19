import type { Annotation, AnnotationQuery } from "./model";

/** Match a record against the same filters in IndexedDB reads and optimistic UI updates. Query text is already lowercased. */
export function matchesAnnotation(
  annotation: Annotation,
  query: Pick<AnnotationQuery, "pageUrl" | "kind" | "color" | "tag" | "text">,
): boolean {
  if (query.pageUrl && annotation.pageUrl !== query.pageUrl) return false;
  if (query.kind && annotation.kind !== query.kind) return false;
  if (query.color && annotation.color !== query.color) return false;
  if (query.tag && !annotation.tags.includes(query.tag)) return false;
  if (!query.text) return true;
  const target =
    annotation.kind === "text"
      ? annotation.target.exact
      : annotation.kind === "image"
        ? `${annotation.target.alt} ${annotation.target.context} ${annotation.target.src}`
        : `${annotation.target.fileName} ${annotation.target.sourceUrl ?? ""} ${annotation.target.exact}`;
  return `${annotation.pageTitle} ${annotation.pageUrl} ${annotation.note} ${annotation.tags.join(" ")} ${target}`
    .toLocaleLowerCase()
    .includes(query.text);
}
