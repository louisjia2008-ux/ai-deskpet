import { describe, expect, it } from 'vitest';
import { visiblePixelBounds, portraitRegion } from './preview-frame';

describe('model-only preview framing', () => {
  it('finds a small character near the bottom, ignores transparent RGB and faint antialiasing', () => {
    const pixels = new Uint8ClampedArray(100 * 100 * 4); pixels.fill(200);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 0;
    for (let y = 60; y < 95; y++) for (let x = 30; x < 70; x++) pixels[(y * 100 + x) * 4 + 3] = 255;
    pixels[3] = 10;
    expect(visiblePixelBounds(pixels, 100, 100)).toEqual({ x: 30, y: 60, width: 40, height: 35 });
  });
  it('returns no portrait source for an empty model frame', () => {
    expect(visiblePixelBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
  it('takes a square head-and-shoulders crop within wide and tall full-body frames', () => {
    for (const [w, h] of [[200, 500], [400, 300], [1, 1]]) {
      const crop = portraitRegion(w!, h!);
      expect(crop.width).toBe(crop.height); expect(crop.x).toBeGreaterThanOrEqual(0); expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(w!); expect(crop.y + crop.height).toBeLessThanOrEqual(h!);
    }
  });
});
