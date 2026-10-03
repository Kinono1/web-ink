import { describe, expect, it } from 'vitest';
import {
  clampPalettePoint,
  defaultPalettePoint,
  fromPalettePosition,
  isPaletteDrag,
  readPalettePosition,
  toPalettePosition,
} from '../src/content/palette-position';

describe('palette drag position math', () => {
  it('uses straight-line displacement and starts dragging at six pixels', () => {
    expect(isPaletteDrag(4, 4)).toBe(false);
    expect(isPaletteDrag(5, 5)).toBe(true);
    expect(isPaletteDrag(6, 0)).toBe(true);
  });

  it('reads only finite normalized coordinates in the inclusive unit interval', () => {
    expect(readPalettePosition({ x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
    expect(readPalettePosition({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });

    const invalidValues: unknown[] = [
      null,
      undefined,
      {},
      { x: 0 },
      { x: '0.5', y: 0.5 },
      { x: 0.5, y: Infinity },
      { x: NaN, y: 0.5 },
      { x: -0.01, y: 0.5 },
      { x: 0.5, y: 1.01 },
    ];

    for (const value of invalidValues) {
      expect(readPalettePosition(value)).toBeUndefined();
    }
  });

  it('maps the midpoint between the hand-checked palette bounds to half ratios', () => {
    const geometry = { width: 1000, height: 800, buttonWidth: 40, buttonHeight: 40 };
    expect(toPalettePosition({ left: 480, top: 380 }, geometry)).toEqual({ x: 0.5, y: 0.5 });
    expect(fromPalettePosition({ x: 0.5, y: 0.5 }, geometry)).toEqual({ left: 480, top: 380 });
  });

  it('maps normalized corners to the 12-pixel margins and opposite bounds', () => {
    const geometry = { width: 1000, height: 800, buttonWidth: 40, buttonHeight: 40 };
    expect(fromPalettePosition({ x: 0, y: 0 }, geometry)).toEqual({ left: 12, top: 12 });
    expect(fromPalettePosition({ x: 1, y: 1 }, geometry)).toEqual({ left: 948, top: 748 });
    expect(toPalettePosition({ left: 12, top: 12 }, geometry)).toEqual({ x: 0, y: 0 });
    expect(toPalettePosition({ left: 948, top: 748 }, geometry)).toEqual({ x: 1, y: 1 });
  });

  it('clamps dragged pixels to the hand-checked bounds before storing ratios', () => {
    const geometry = { width: 1000, height: 800, buttonWidth: 40, buttonHeight: 40 };
    expect(clampPalettePoint({ left: -100, top: 2000 }, geometry)).toEqual({ left: 12, top: 748 });
    expect(toPalettePosition({ left: -100, top: 2000 }, geometry)).toEqual({ x: 0, y: 1 });
  });

  it('uses the centered five-pixel margin when a viewport leaves no travel range', () => {
    const geometry = { width: 50, height: 50, buttonWidth: 40, buttonHeight: 40 };
    expect(clampPalettePoint({ left: 0, top: 25 }, geometry)).toEqual({ left: 5, top: 5 });
    expect(fromPalettePosition({ x: 0.5, y: 0.5 }, geometry)).toEqual({ left: 5, top: 5 });
    expect(toPalettePosition({ left: 5, top: 5 }, geometry)).toEqual({ x: 0, y: 0 });
  });

  it('pins an oversized button at zero within a smaller viewport', () => {
    const geometry = { width: 30, height: 30, buttonWidth: 40, buttonHeight: 40 };
    expect(clampPalettePoint({ left: 12, top: 12 }, geometry)).toEqual({ left: 0, top: 0 });
    expect(fromPalettePosition({ x: 1, y: 1 }, geometry)).toEqual({ left: 0, top: 0 });
    expect(toPalettePosition({ left: 0, top: 0 }, geometry)).toEqual({ x: 0, y: 0 });
  });

  it('defaults to an 18-pixel right and bottom inset when that fits', () => {
    const geometry = { width: 1000, height: 800, buttonWidth: 40, buttonHeight: 40 };
    expect(defaultPalettePoint(geometry)).toEqual({ left: 942, top: 742 });
  });

  it('clamps the default right and bottom inset in small viewports', () => {
    expect(defaultPalettePoint({ width: 50, height: 50, buttonWidth: 40, buttonHeight: 40 })).toEqual({ left: 5, top: 5 });
    expect(defaultPalettePoint({ width: 30, height: 30, buttonWidth: 40, buttonHeight: 40 })).toEqual({ left: 0, top: 0 });
  });
});
