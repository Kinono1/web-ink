import { useEffect, useRef, useState } from "react";
import type { PdfAnnotation, SelectionTarget } from "../../core/pdf-types";
import type { ReaderActionsRef, ReaderSnapshot } from "./contracts";

export function useVersionRecovery(state: Pick<ReaderSnapshot,
  "documentSession" | "documentSessionRef" | "focusMode" | "setArea" | "setError" | "setSelection"
>, actions: ReaderActionsRef<"copyPrevious" | "exitFocus">) {
  const { documentSession, documentSessionRef, focusMode, setArea, setError, setSelection } = state;
  const [open, setOpen] = useState(false);
  const [recovery, setRecovery] = useState<{ record: PdfAnnotation; session: number }>();
  const [area, setRecoveryArea] = useState<SelectionTarget>();
  const [busy, setBusy] = useState(false);
  const [requestedSearch, setRequestedSearch] = useState<{ id: number; text: string }>();
  const searchId = useRef(0);
  const writing = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setOpen(false);
    setRecovery(undefined);
    setRecoveryArea(undefined);
    setRequestedSearch(undefined);
  }, [documentSession]);
  const active = recovery?.session === documentSession && recovery.session === documentSessionRef.current
    ? recovery.record : undefined;
  function review() {
    trigger.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function cancel() {
    setRecovery(undefined);
    setRecoveryArea(undefined);
    setRequestedSearch(undefined);
    setSelection(undefined);
    setArea(false);
  }
  function choose(record: PdfAnnotation) {
    setOpen(false);
    setRecovery({ record, session: documentSession });
    setRecoveryArea(undefined);
    setSelection(undefined);
    setArea(record.kind === "pdf-area");
    if (focusMode) actions.current.exitFocus();
    setRequestedSearch(record.kind === "pdf-text"
      ? { id: ++searchId.current, text: record.target.exact.slice(0, 200).replace(/[\uD800-\uDBFF]$/, "").trim() }
      : undefined);
  }
  async function restore(target: SelectionTarget) {
    if (!active || writing.current) return;
    writing.current = true;
    setBusy(true);
    try {
      await actions.current.copyPrevious(active, target);
      if (documentSessionRef.current === documentSession) cancel();
    } catch (cause) {
      if (documentSessionRef.current === documentSession)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  function selectArea(target: SelectionTarget) {
    setRecoveryArea(target);
    setArea(false);
  }
  return { open, active, area, busy, requestedSearch, review, close, cancel, choose, restore, selectArea };
}
