export const PALETTE_SIZE_KEY = "ui.paletteSize" as const;
export const DEFAULT_PALETTE_SIZE = 40;

export function isPaletteSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 40 &&
    value <= 64 &&
    Number.isInteger(value) &&
    (value - 40) % 4 === 0
  );
}

export function normalizePaletteSize(value: unknown): number {
  return isPaletteSize(value) ? value : DEFAULT_PALETTE_SIZE;
}

export async function readPaletteSize(): Promise<number> {
  try {
    const values = await chrome.storage.local.get(PALETTE_SIZE_KEY);
    return normalizePaletteSize(values[PALETTE_SIZE_KEY]);
  } catch {
    return DEFAULT_PALETTE_SIZE;
  }
}

export async function writePaletteSize(value: number): Promise<void> {
  if (!isPaletteSize(value)) {
    throw Error("Palette size must be 40 to 64 pixels in steps of 4.");
  }

  await chrome.storage.local.set({ [PALETTE_SIZE_KEY]: value });
}
