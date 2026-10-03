export type PalettePosition = { x: number; y: number };
export type PalettePoint = { left: number; top: number };
export type PaletteGeometry = {
  width: number;
  height: number;
  buttonWidth: number;
  buttonHeight: number;
};

/** A drag begins at six pixels of Euclidean, straight-line displacement. */
export function isPaletteDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= 6;
}

export function readPalettePosition(value: unknown): PalettePosition | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  const candidate = value as { x?: unknown; y?: unknown };
  const { x, y } = candidate;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    return undefined;
  }

  return { x, y };
}

function axisGeometry(viewportSize: number, buttonSize: number): { margin: number; range: number } {
  const margin = Math.min(12, Math.max(0, (viewportSize - buttonSize) / 2));
  const range = Math.max(0, viewportSize - buttonSize - 2 * margin);
  return { margin, range };
}

function clampCoordinate(value: number, margin: number, range: number): number {
  return Math.min(margin + range, Math.max(margin, value));
}

export function clampPalettePoint(point: PalettePoint, geometry: PaletteGeometry): PalettePoint {
  const horizontal = axisGeometry(geometry.width, geometry.buttonWidth);
  const vertical = axisGeometry(geometry.height, geometry.buttonHeight);
  return {
    left: clampCoordinate(point.left, horizontal.margin, horizontal.range),
    top: clampCoordinate(point.top, vertical.margin, vertical.range),
  };
}

export function toPalettePosition(point: PalettePoint, geometry: PaletteGeometry): PalettePosition {
  const bounded = clampPalettePoint(point, geometry);
  const horizontal = axisGeometry(geometry.width, geometry.buttonWidth);
  const vertical = axisGeometry(geometry.height, geometry.buttonHeight);
  return {
    x: horizontal.range === 0 ? 0 : (bounded.left - horizontal.margin) / horizontal.range,
    y: vertical.range === 0 ? 0 : (bounded.top - vertical.margin) / vertical.range,
  };
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function fromPalettePosition(position: PalettePosition, geometry: PaletteGeometry): PalettePoint {
  const horizontal = axisGeometry(geometry.width, geometry.buttonWidth);
  const vertical = axisGeometry(geometry.height, geometry.buttonHeight);
  return {
    left: horizontal.margin + clampRatio(position.x) * horizontal.range,
    top: vertical.margin + clampRatio(position.y) * vertical.range,
  };
}

export function defaultPalettePoint(geometry: PaletteGeometry): PalettePoint {
  return clampPalettePoint(
    {
      left: geometry.width - geometry.buttonWidth - 18,
      top: geometry.height - geometry.buttonHeight - 18,
    },
    geometry,
  );
}
