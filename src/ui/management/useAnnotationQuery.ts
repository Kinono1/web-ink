import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { request } from "../../core/client";
import type {
  Annotation,
  AnnotationPage,
  AnnotationQuery,
} from "../../core/model";
import type { FilterKind, Mode } from "./types";

type QueryOptions = {
  mode: Mode;
  pageUrl?: string;
  kind: FilterKind;
  color: string;
  tag: string;
  query: string;
};
/** One owner for query lifetime. Debouncing delays the next read, never cancellation. */
export function useAnnotationQuery(
  options: QueryOptions,
  onError: (message: string) => void,
  onFirstPage: (items: Annotation[]) => void,
) {
  const [records, setRecords] = useState<Annotation[]>([]);
  const [nextCursor, setNextCursor] = useState<AnnotationPage["nextCursor"]>();
  const [loading, setLoading] = useState(false);
  const active = useRef<string | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;
  const callbacks = useRef({ onError, onFirstPage });
  callbacks.current = { onError, onFirstPage };
  const key = JSON.stringify(options);
  const currentKey = useRef(key);
  currentKey.current = key;
  const cancel = useCallback(() => {
    const id = active.current;
    active.current = undefined;
    if (id)
      void request({ type: "annotations.query.cancel", requestId: id }).catch(
        () => undefined,
      );
  }, []);
  const loadRecords = useCallback(
    async (append = false, cursor?: AnnotationPage["nextCursor"]) => {
      cancel();
      const value = latest.current,
        requestKey = currentKey.current;
      if (value.mode === "sidepanel" && !value.pageUrl) {
        setRecords([]);
        setNextCursor(undefined);
        setLoading(false);
        return;
      }
      const requestId = crypto.randomUUID();
      active.current = requestId;
      setLoading(true);
      const query: AnnotationQuery = {
        ...(value.mode === "sidepanel" ? { pageUrl: value.pageUrl } : {}),
        ...(value.kind === "all" ? {} : { kind: value.kind }),
        ...(value.color ? { color: value.color } : {}),
        ...(value.tag ? { tag: value.tag } : {}),
        ...(value.query.trim() ? { text: value.query.trim() } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 50,
        requestId,
      };
      try {
        const page = await request<AnnotationPage>({
          type: "annotations.query",
          query,
        });
        if (
          active.current !== requestId ||
          currentKey.current !== requestKey ||
          page.cancelled
        )
          return;
        setRecords((old) =>
          append
            ? [
                ...old,
                ...page.items.filter(
                  (item) => !old.some((record) => record.id === item.id),
                ),
              ]
            : page.items,
        );
        setNextCursor(page.nextCursor);
        if (!append) callbacks.current.onFirstPage(page.items);
      } catch (cause) {
        if (active.current === requestId && currentKey.current === requestKey)
          callbacks.current.onError(
            cause instanceof Error ? cause.message : String(cause),
          );
      } finally {
        if (active.current === requestId) {
          active.current = undefined;
          setLoading(false);
        }
      }
    },
    [cancel],
  );
  useLayoutEffect(() => {
    cancel();
    setLoading(true);
    const timer = setTimeout(
      () => {
        void loadRecords();
      },
      options.query.trim() ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [key, cancel, loadRecords]);
  return { records, setRecords, nextCursor, loading, loadRecords, cancel };
}
