import { createContext, useContext } from "react";
import type { useTabObserver } from "../hooks/useTabObserver";

type TabState = Omit<ReturnType<typeof useTabObserver>, "activeDocument" | "documentVersion">;
export const TabContext = createContext<TabState | undefined>(undefined);

export function useTabContext() {
  const value = useContext(TabContext);
  if (!value) throw new Error("Page screens require TabContext.");
  return value;
}
