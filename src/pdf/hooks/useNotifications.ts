import { useCallback, useEffect, useRef, useState } from "react";
import type { ReaderSnapshot, ReaderActionsRef } from "./contracts";

export function useNotificationsState() {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return { error, setError, notice, setNotice, noticeTimer };
}

type Inputs = Pick<ReaderSnapshot,
  "noticeTimer" | "setNotice"
>;

export function useNotifications(state: Inputs) {
  const {
    noticeTimer, setNotice,
  } = state;

  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
  }, []);

  const tell = useCallback((message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 1800);
  }, []);
  return { tell };
}
