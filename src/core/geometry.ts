import type { Point } from './model';

export interface ImageGeometry {
  /** Rendered image content in viewport CSS pixels; it may extend beyond its visible crop. */
  imageRect: { x: number; y: number; width: number; height: number };
  /** The visible portion of imageRect, clipped to the image content box, in viewport CSS pixels. */
  clipRect: { x: number; y: number; width: number; height: number };
}

export function getImageGeometry(image: HTMLImageElement): ImageGeometry | null {
  if (!image.naturalWidth || !image.naturalHeight || hasUnsupportedTransform(image)) return null;
  const style = image.ownerDocument.defaultView?.getComputedStyle(image);
  if (!style) return null;
  const borderBox = image.getBoundingClientRect();
  if (!(borderBox.width > 0 && borderBox.height > 0)) return null;
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const right = px(style.borderRightWidth) + px(style.paddingRight);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
  const content = { x: borderBox.x + left, y: borderBox.y + top, width: borderBox.width - left - right, height: borderBox.height - top - bottom };
  if (!(content.width > 0 && content.height > 0)) return null;

  const natural = { width: image.naturalWidth, height: image.naturalHeight };
  let fit = style.objectFit || 'fill';
  if (fit === 'scale-down') fit = natural.width <= content.width && natural.height <= content.height ? 'none' : 'contain';
  let width = content.width;
  let height = content.height;
  if (fit === 'contain' || fit === 'cover') {
    const scale = fit === 'contain'
      ? Math.min(content.width / natural.width, content.height / natural.height)
      : Math.max(content.width / natural.width, content.height / natural.height);
    width = natural.width * scale;
    height = natural.height * scale;
  } else if (fit === 'none') {
    width = natural.width;
    height = natural.height;
  } else if (fit !== 'fill') {
    return null;
  }
  const position = objectPosition(style.objectPosition || '50% 50%', content.width - width, content.height - height);
  const imageRect = { x: content.x + position.x, y: content.y + position.y, width, height };
  const clipRect = intersect(imageRect, content);
  return clipRect ? { imageRect, clipRect } : null;
}

export function clientToImage(x: number, y: number, geometry: ImageGeometry): Point | null {
  if (!inside(x, y, geometry.clipRect) || !inside(x, y, geometry.imageRect)) return null;
  const point = { x: (x - geometry.imageRect.x) / geometry.imageRect.width, y: (y - geometry.imageRect.y) / geometry.imageRect.height };
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null;
}

export function imageToClient(point: Point, geometry: ImageGeometry): Point {
  return {
    x: geometry.imageRect.x + point.x * geometry.imageRect.width,
    y: geometry.imageRect.y + point.y * geometry.imageRect.height,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  };
}

function objectPosition(value: string, dx: number, dy: number): { x: number; y: number } {
  const tokens = value.trim().split(/\s+/u);
  let xToken = tokens[0] || '50%';
  let yToken = tokens[1] || (xToken === 'top' || xToken === 'bottom' ? xToken : '50%');
  // CSS accepts both `left top` and `top left` for the common keyword form.
  if ((xToken === 'top' || xToken === 'bottom') && (yToken === 'left' || yToken === 'right')) {
    [xToken, yToken] = [yToken, xToken];
  }
  return { x: positionValue(xToken, dx, 'x'), y: positionValue(yToken, dy, 'y') };
}

function positionValue(token: string, delta: number, axis: 'x' | 'y'): number {
  if (token === 'center') return delta / 2;
  if (token === 'left' || token === 'top') return 0;
  if (token === 'right' || token === 'bottom') return delta;
  if (token.endsWith('%')) return (Number.parseFloat(token) / 100) * delta;
  const value = Number.parseFloat(token);
  if (Number.isFinite(value)) return value;
  return axis === 'x' ? delta / 2 : delta / 2;
}

function hasUnsupportedTransform(image: HTMLImageElement): boolean {
  const view = image.ownerDocument.defaultView;
  if (!view) return false;
  for (let current: Element | null = image; current; current = current.parentElement) {
    const computed = view.getComputedStyle(current);
    const transform = computed.transform;
    if ([computed.rotate, computed.scale, computed.translate].some(value => value && value !== 'none')) return true;
    if (transform && transform !== 'none' && transform !== 'matrix(1, 0, 0, 1, 0, 0)') return true;
  }
  return false;
}

function intersect(a: ImageGeometry['imageRect'], b: ImageGeometry['imageRect']): ImageGeometry['clipRect'] | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
function inside(x: number, y: number, rect: ImageGeometry['imageRect']): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
function px(value: string): number { const number = Number.parseFloat(value); return Number.isFinite(number) ? number : 0; }
