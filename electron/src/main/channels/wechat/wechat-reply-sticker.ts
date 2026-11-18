/** Same opt-in library/replenishment policy for ordinary and scheduled private
 * replies. The drawing service owns the shared daily budget. Groups never draw. */
export async function selectReplySticker(input: {
  private: boolean; available: number; select(): Promise<string | null>; draw(): Promise<boolean> | null;
  assertCurrent(): void | Promise<void>; random?: () => number; waitMs?: number;
}): Promise<string | null> {
  let asset = await input.select();
  await input.assertCurrent();
  if (!input.private) return asset;
  if (!asset) {
    const drawing = input.draw();
    if (drawing) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (await Promise.race([drawing, new Promise<false>(resolve => { timer = setTimeout(resolve, input.waitMs ?? 45_000, false); })])) {
          await input.assertCurrent(); asset = await input.select(); await input.assertCurrent();
        }
      } finally { if (timer) clearTimeout(timer); }
    }
  } else if (input.available < 3 && (input.random?.() ?? Math.random()) < 0.3) void input.draw();
  return asset;
}
