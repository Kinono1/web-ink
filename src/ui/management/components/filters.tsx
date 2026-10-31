import { useEffect, useState } from "react";
import type { Annotation, Language } from "../../../core/model";
import type { FilterKind } from "../types";
import type { COPY } from "../copy";

export function FilterPopover({ language, t, kind, color, tag, records,
  setKind, setColor, setTag, clear }: {
  language: Language; t: (typeof COPY)[Language]; kind: FilterKind; color: string; tag: string;
  records: Annotation[]; setKind: (value: FilterKind) => void;
  setColor: (value: string) => void; setTag: (value: string) => void; clear: () => void;
}) {
  const colors = [...new Set(records.map((record) => record.color))].sort();
  const [tagSourceRecords, setTagSourceRecords] = useState(records);
  useEffect(() => {
    // Keep the latest non-empty current result while an exact tag query is
    // pending or empty, so a prefix can still be completed from this result.
    if (!tag || records.length) setTagSourceRecords(records);
  }, [records, tag]);
  const tags = [...new Set((tag ? tagSourceRecords : records).flatMap((record) => record.tags))].sort();
  const tagSuggestions = tag
    ? tags.filter((value) => value.toLocaleLowerCase().startsWith(tag.toLocaleLowerCase()) &&
        value.toLocaleLowerCase() !== tag.toLocaleLowerCase())
    : tags;
  return (
    <section className="filter-popover" aria-label={t.filter}>
      <div className="filter-kinds" role="group" aria-label={t.filter}>
        {(["all", "text", "image", "pdf-text", "pdf-area"] as const).map((value) => (
          <button key={value} className={kind === value ? "selected" : ""} onClick={() => setKind(value)}>
            {value === "all" ? t.all : value === "pdf-text" ? t.pdfText
              : value === "pdf-area" ? t.pdfArea : value === "text" ? t.text : t.image}
          </button>
        ))}
      </div>
      <label>{t.color}
        <select value={color} onChange={(event) => setColor(event.target.value)}>
          <option value="">{t.all}</option>
          {colors.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>{t.tag}
        <input aria-label={t.tag} value={tag} onChange={(event) => setTag(event.target.value)} />
        {tagSuggestions.length ? (
          <span className="filter-tag-suggestions" aria-label={t.currentResultTags}>
            <span>{t.currentResultTags}</span>
            {tagSuggestions.map((value) => (
              <button key={value} className="quiet" type="button" onClick={() => setTag(value)}>{value}</button>
            ))}
          </span>
        ) : null}
      </label>
      <button className="quiet" onClick={clear}>{t.clearFilters}</button>
    </section>
  );
}
