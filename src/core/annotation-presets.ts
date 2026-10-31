import { COLORS, type Language } from "./model";

export type AnnotationPreset = { id: string; label: string; color: string };

const STORAGE_KEY = "ui.annotationPresets";
let saveQueue: Promise<void> = Promise.resolve();

export function defaultAnnotationPresets(language: Language): AnnotationPreset[] {
  return [ { id: "important", label: language === "zh-CN" ? "重要" : "Important", color: COLORS[0] },
    { id: "question", label: language === "zh-CN" ? "疑问" : "Question", color: COLORS[2] },
    { id: "insight", label: language === "zh-CN" ? "精彩" : "Insight", color: COLORS[1] },
 ];
}

export function validateAnnotationPresets(value: unknown): AnnotationPreset[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5)
    throw new Error("Annotation presets must contain 1 to 5 entries.");

  const ids = new Set<string>();
  return Array.from(value, (entry: unknown, index) => {
    const name = `Preset ${index + 1}`;
    if (!entry || typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype)
      throw new Error(`${name} must be a plain object.`);
    const preset = entry as Record<string, unknown>;
    if (Object.keys(preset).some((key) => key !== "id" && key !== "label" && key !== "color"))
      throw new Error(`${name} contains an unknown field.`);
    if (typeof preset.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(preset.id))
      throw new Error(`${name} ID must contain 1 to 128 safe characters.`);
    if (ids.has(preset.id)) throw new Error("Annotation preset IDs must be unique.");
    ids.add(preset.id);

    if (typeof preset.label !== "string" || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(preset.label))
      throw new Error(`${name} label must be text without control characters.`);
    const label = preset.label.trim();
    if (!label || label.length > 48 || Array.from(label).length > 24)
      throw new Error(`${name} label must contain 1 to 24 characters.`);
    if (typeof preset.color !== "string" || !/^#[0-9a-f]{6}$/i.test(preset.color))
      throw new Error(`${name} color must be a six-digit HEX color, such as #facd5a.`);
    return { id: preset.id, label, color: preset.color.toLowerCase() };
  });
}

export async function readAnnotationPresets(language: Language): Promise<AnnotationPreset[]> {
  try {
    const values = await chrome.storage.local.get(STORAGE_KEY);
    return validateAnnotationPresets(values[STORAGE_KEY]);
  } catch {
    return defaultAnnotationPresets(language);
  }
}

export function saveAnnotationPresets(presets: AnnotationPreset[]): Promise<void> {
  let snapshot: AnnotationPreset[];
  try {
    snapshot = validateAnnotationPresets(presets);
  } catch (cause) {
    const rejected = Promise.reject<void>(cause);
    void rejected.catch(() => undefined);
    return rejected;
  }

  const saved = saveQueue.then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }));
  // Keep each caller's rejection, while an ignored failure cannot stall later
  // explicit saves or produce an unhandled rejection.
  saveQueue = saved.catch(() => undefined);
  return saved;
}

export function presetIndexFromKey(event: Pick<KeyboardEvent,
  "code" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "repeat"
>): number | undefined {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.isComposing || event.repeat)
    return undefined;
  if (!/^Digit[1-5]$/.test(event.code)) return undefined;
  return Number(event.code.slice(-1)) - 1;
}
