import type { RuntimeHealth } from "../core/model";

const GENERATION_KEY = "ui.runtimeGeneration";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One promise per worker; storage.session carries ownership across worker wakes. */
export async function initializeRuntime(
  onNewLifecycle: () => void,
): Promise<RuntimeHealth> {
  const stored = (await chrome.storage.session.get(GENERATION_KEY))[GENERATION_KEY];
  const existing = typeof stored === "string" && UUID.test(stored);
  const generation = existing ? stored : crypto.randomUUID();
  if (!existing) {
    await chrome.storage.session.set({ [GENERATION_KEY]: generation });
    onNewLifecycle();
  }
  const version = chrome.runtime.getManifest().version;
  try {
    const response = await fetch(chrome.runtime.getURL("build-info.json"));
    if (!response.ok) throw new Error("Build identity unavailable");
    const build = await response.json();
    if (
      build?.version === version &&
      typeof build.commit === "string" &&
      build.commit.length > 0 &&
      typeof build.dirty === "boolean"
    )
      return { generation, version, commit: build.commit, dirty: build.dirty };
  } catch {
    // Development output may not have build-info.json. Never claim a clean commit.
  }
  return { generation, version, commit: "unknown", dirty: true };
}
