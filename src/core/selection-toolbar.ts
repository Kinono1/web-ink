import type { TextAnnotation } from "./model";

export const SELECTION_PORT_NAME = "web-ink.web-selection.v1";
export const SELECTION_TOOLBAR_KEY = "ui.selectionToolbarEnabled";

export type WebSelectionState = {
  type: "selection";
  pageUrl: string;
  status: "ready" | "empty" | "paused" | "unsupported" | "saving";
  token?: string;
  text?: string;
};

export type WebSelectionReply = WebSelectionState | {
  type: "saved";
  requestId: string;
  annotation: TextAnnotation;
} | {
  type: "error";
  requestId: string;
  error: string;
};

export type WebSelectionCommand = {
  type: "annotate";
  token: string;
  color: string;
  requestId: string;
};

export async function readSelectionToolbarEnabled(): Promise<boolean> {
  try {
    const values = await chrome.storage.local.get(SELECTION_TOOLBAR_KEY);
    return values[SELECTION_TOOLBAR_KEY] === true;
  } catch {
    return false;
  }
}

export async function writeSelectionToolbarEnabled(value: boolean): Promise<void> {
  if (typeof value !== "boolean") throw Error("Selection toolbar preference must be boolean.");
  await chrome.storage.local.set({ [SELECTION_TOOLBAR_KEY]: value });
}
