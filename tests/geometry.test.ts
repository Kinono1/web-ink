import { describe, expect, it } from 'vitest';
import { clientToImage, getImageGeometry, imageToClient } from '../src/core/geometry';

function fixture(style: string, naturalWidth = 400, naturalHeight = 200): HTMLImageElement {
  document.body.innerHTML = `<img id="image" style="${style}">`;
  const image = document.querySelector('#image') as HTMLImageElement;
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  });
  image.getBoundingClientRect = () => new DOMRect(10, 20, 200, 200);
  return image;
}

describe('image geometry', () => {
  it('maps object-fit contain through its letterbox and rejects empty bars', () => {
    const geometry = getImageGeometry(fixture('object-fit: contain; object-position: center;'));
    expect(geometry).toMatchObject({ imageRect: { x: 10, y: 70, width: 200, height: 100 }, clipRect: { x: 10, y: 70, width: 200, height: 100 } });
    expect(clientToImage(110, 120, geometry!)).toEqual({ x: 0.5, y: 0.5 });
    expect(clientToImage(110, 40, geometry!)).toBeNull();
  });

  it('maps object-fit cover through its crop and retains intrinsic-normalized coordinates', () => {
    const geometry = getImageGeometry(fixture('object-fit: cover; object-position: center;'));
    expect(geometry).toMatchObject({ imageRect: { x: -90, y: 20, width: 400, height: 200 }, clipRect: { x: 10, y: 20, width: 200, height: 200 } });
    expect(clientToImage(10, 120, geometry!)).toEqual({ x: 0.25, y: 0.5 });
    expect(imageToClient({ x: 0.75, y: 0.5 }, geometry!)).toEqual({ x: 210, y: 120 });
  });

  it('accounts for borders and padding before fitting image content', () => {
    const geometry = getImageGeometry(fixture('object-fit: fill; border: 5px solid black; padding: 10px;'));
    expect(geometry).toMatchObject({ imageRect: { x: 25, y: 35, width: 170, height: 170 } });
  });

  it('rejects a rotated image because viewport mapping is no longer axis-aligned', () => {
    expect(getImageGeometry(fixture('transform: rotate(15deg);'))).toBeNull();
  });
});
