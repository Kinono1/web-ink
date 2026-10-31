import type { AnchorState, TextAnnotation } from "../core/model";
import type { createView } from "./view-lite";
import { AnnotationController } from "./engine/AnnotationController";
export interface ContentEngine {
  stop: () => void;
  dispatch: (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
  ) => void;
  snapshot: () => { pageUrl: string; states: AnchorState[]; enabled: boolean };
  canStop: () => boolean;
  annotateSelection: (range: Range, color: string, isCurrent: () => boolean) => Promise<TextAnnotation>;
}
/** Heavy DOM work lives in engine.js. The bootstrap owns the host and palette. */
export function startEngine(view: ReturnType<typeof createView>): ContentEngine {
  const engine = new AnnotationController(view);
  return {
    stop: engine.stop,
    dispatch: engine.dispatch,
    snapshot: () => ({
      pageUrl: engine.currentUrl,
      states: engine.store.states,
      enabled: engine.enabled(),
    }),
    canStop: engine.canStop,
    annotateSelection: engine.save.annotateSelection,
  };
}
