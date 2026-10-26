import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { useManagementSettings } from "../hooks/useManagementSettings";
import type { useAnnotationSync } from "../hooks/useAnnotationSync";
import type { Mode } from "../management/types";

type ManagementState = {
  mode: Mode;
  preferences: ReturnType<typeof useManagementSettings>;
  annotations: ReturnType<typeof useAnnotationSync>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
};
export const ManagementContext = createContext<ManagementState | undefined>(undefined);

export function useManagementContext() {
  const value = useContext(ManagementContext);
  if (!value) throw new Error("Management screens require ManagementContext.");
  return value;
}

// Screens subscribe only to values they display or invoke. Root alerts and
// annotation drafts must not invalidate the Settings screen, or vice versa.
export const LibraryContext = createContext<Pick<ManagementState, "annotations"> & {
  language: ManagementState["preferences"]["language"];
  t: ManagementState["preferences"]["t"];
} | undefined>(undefined);
export const SettingsContext = createContext<Pick<ManagementState, "preferences" | "setError" | "setNotice"> & {
  loadRecords: ManagementState["annotations"]["loadRecords"];
} | undefined>(undefined);
export function useLibraryContext() {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("Library screens require LibraryContext.");
  return value;
}
export function useSettingsContext() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("Settings screens require SettingsContext.");
  return value;
}
