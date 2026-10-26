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
