import { useMemo, useRef, type ComponentProps } from "react";
import type { PdfPage } from "../PdfPage";
import type { ReaderActions, ReaderSnapshot } from "./contracts";

type Inputs = Pick<ReaderSnapshot,
  "annotationWrites" | "container" | "documentSession" | "documentSessionRef" |
  "intentEpoch" | "layoutIndex" | "pendingSearchPosition" | "setError" |
  "setNativeError" | "setPicked" | "setSelection" | "unsavedRef"
>;
type Commands = Pick<ReaderActions, "mark" | "onPageDimensions" | "pagesPadding">;
type PageProps = ComponentProps<typeof PdfPage>;

// Page callbacks keep their identity across toolbar/draft updates, but read the
// current commands. Their captured session prevents a removed page from writing
// to a later document, including a replacement with the same byte hash.
export function usePdfPageBindings(state: Inputs, actions: Commands) {
  const latest = useRef({ state, actions });
  latest.current = { state, actions };
  return useMemo(() => {
    const active = state.documentSession;
    const current = () => active === latest.current.state.documentSessionRef.current
      ? latest.current : undefined;
    const shared = {
      onSelection: ((next) => {
        const value = current();
        if (value && !value.state.unsavedRef.current && !value.state.annotationWrites.current.size) {
          value.state.setSelection(next);
          value.state.setPicked(undefined);
        }
      }) satisfies PageProps["onSelection"],
      onPick: ((record) => {
        const value = current();
        if (!value) return;
        value.state.setPicked(record);
        if (!value.state.unsavedRef.current) value.state.setSelection(undefined);
      }) satisfies PageProps["onPick"],
      onArea: ((target) => current()?.actions.mark(target, "pdf-area")) satisfies PageProps["onArea"],
      onError: ((message) => {
        const value = current();
        if (!value) return;
        value.state.setError(message);
        if (/原文件|Original-file/.test(message)) value.state.setNativeError(message);
      }) satisfies PageProps["onError"],
    };
    const pages = new Map<number, Pick<PageProps, "onSearchPosition" | "onDimensions">>();
    return (number: number) => {
      let bindings = pages.get(number);
      if (!bindings) {
        bindings = {
          onDimensions: (generation, width, height) => {
            current()?.actions.onPageDimensions(number, generation, width, height);
          },
          onSearchPosition: (top) => {
            const value = current();
            if (!value) return;
            const { pendingSearchPosition, container, intentEpoch, layoutIndex } = value.state;
            const pending = pendingSearchPosition.current;
            const scroller = container.current;
            if (!pending || pending.pageNumber !== number || pending.intent !== intentEpoch.current || !scroller) return;
            pendingSearchPosition.current = undefined;
            const start = layoutIndex.current.offsetBefore(number) + value.actions.pagesPadding();
            scroller.scrollTo({ top: Math.max(start, start + top - scroller.clientHeight / 4), behavior: "instant" });
          },
        };
        pages.set(number, bindings);
      }
      return { ...shared, ...bindings };
    };
  }, [state.documentSession]);
}
