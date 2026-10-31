import { DEFAULT_SETTINGS, type Settings } from "../../core/model";
import { validateSettings } from "../../core/validation";

const SETTINGS_KEY = "settings";

export async function readSettings(): Promise<Settings> {
  const result = (await chrome.storage.local.get(SETTINGS_KEY)) as Record<string, unknown>;
  if (result[SETTINGS_KEY] === undefined) return structuredClone(DEFAULT_SETTINGS);
  try {
    return validateSettings(result[SETTINGS_KEY]);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
