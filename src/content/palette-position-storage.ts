import type { PalettePosition } from "./palette-position";

/**
 * Global UI preference. A future per-origin key (`ui.palettePosition.${origin}`)
 * requires an explicit migration; none is implemented here.
 */
export const PALETTE_POSITION_KEY = "ui.palettePosition" as const;

export function createPalettePositionWriter(
  write: (position: PalettePosition) => Promise<void>,
  onError?: (cause: unknown) => void,
): { save: (position: PalettePosition) => void; dispose: () => void } {
  let writing = false;
  let disposed = false;
  let pending: PalettePosition | undefined;

  const reportError = (cause: unknown): void => {
    if (disposed || !onError) return;

    try {
      onError(cause);
    } catch {
      // Error reporting must not interrupt queue cleanup or create a rejection.
    }
  };

  const finishWrite = (): void => {
    const next = pending;
    pending = undefined;
    if (next) {
      dispatch(next);
    } else {
      writing = false;
    }
  };

  const dispatch = (snapshot: PalettePosition): void => {
    let result: Promise<void>;
    try {
      // Invoke synchronously so save() immediately starts the first write.
      result = write(snapshot);
    } catch (cause) {
      reportError(cause);
      finishWrite();
      return;
    }

    void Promise.resolve(result).then(
      () => finishWrite(),
      (cause: unknown) => {
        reportError(cause);
        finishWrite();
      },
    );
  };

  return {
    save(position) {
      if (disposed) return;

      const snapshot = { ...position };
      if (writing) {
        pending = snapshot;
        return;
      }

      writing = true;
      dispatch(snapshot);
    },
    dispose() {
      disposed = true;
      // Stop accepting gestures, but finish an already accepted position while
      // this context is alive. A real navigation can still interrupt JS execution.
    },
  };
}
