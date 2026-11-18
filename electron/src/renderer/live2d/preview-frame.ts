export interface PixelBounds { x: number; y: number; width: number; height: number }

/** Only model-canvas pixels enter this path; overlay DOM is never sampled. */
export const visiblePixelBounds = (pixels: Uint8ClampedArray, width: number, height: number): PixelBounds | null => {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((pixels[(y * width + x) * 4 + 3] ?? 0) < 24) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
};

/** A centred head-and-shoulders view of the fitted, transparent full body. */
export const portraitRegion = (width: number, height: number): PixelBounds => {
  const side = Math.max(1, Math.min(width, height * 0.46));
  return { x: (width - side) / 2, y: Math.min(height - side, height * 0.025), width: side, height: side };
};
