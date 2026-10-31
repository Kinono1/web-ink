import type { AnchorState, Annotation, Language } from "../../../core/model";
import { statusClass, kindFamily, localDate, shortDate } from "../helpers";
import type { Copy } from "./types";

type AnchorProblem = AnchorState;

export function problemOf(state: AnchorState | undefined): AnchorProblem | undefined {
  return state?.status === "unresolved" || state?.status === "unsupported" ? state : undefined;
}

const statusKey = (status: AnchorState["status"]) =>
  status === "located" ? "located" : status === "pending" ? "pending"
    : status === "unresolved" ? "unresolved" : "unsupportedStatus";

export function StatusLabel({ problem, t }: { problem?: AnchorProblem; t: Copy }) {
  return problem ? (
    <span className={statusClass(problem.status)} title={problem.reason}>
      {t[statusKey(problem.status)]}
    </span>
  ) : null;
}

/** The one fact line shared by library rows and side-panel items. */
export function RecordFacts({ record, state, language, t }: {
  record: Annotation; state?: AnchorState; language: Language; t: Copy;
}) {
  const family = kindFamily(record.kind);
  return (
    <>
      {family !== "text" ? <span>{family === "image" ? t.image : t.pdf}</span> : null}
      <time dateTime={record.updatedAt} title={localDate(record.updatedAt, language)}>
        {shortDate(record.updatedAt, language)}
      </time>
      {record.tags.length ? (
        <span className="row-tags">{record.tags.map((tag) => `#${tag}`).join(" ")}</span>
      ) : null}
      <StatusLabel problem={problemOf(state)} t={t} />
    </>
  );
}
