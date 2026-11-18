import { expect, it, vi } from 'vitest';
import { selectReplySticker } from './wechat-reply-sticker';

it('replenishes a missing private scene once and rechecks authority before selecting the new asset', async () => {
  const select = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('spool.png'), draw = vi.fn(async () => true), assertCurrent = vi.fn();
  expect(await selectReplySticker({ private: true, available: 0, select, draw, assertCurrent })).toBe('spool.png');
  expect(draw).toHaveBeenCalledOnce(); expect(assertCurrent).toHaveBeenCalledTimes(3);
});
it('never spends the image budget in groups or when daily budget disallows drawing, and bounds a slow drawing', async () => {
  const draw = vi.fn(() => null), select = async () => null, assertCurrent = () => undefined;
  expect(await selectReplySticker({ private: false, available: 0, select, draw, assertCurrent })).toBeNull(); expect(draw).not.toHaveBeenCalled();
  expect(await selectReplySticker({ private: true, available: 0, select, draw, assertCurrent })).toBeNull();
  expect(await selectReplySticker({ private: true, available: 0, select, draw: () => new Promise(() => undefined), assertCurrent, waitMs: 1 })).toBeNull();
});
it('does not publish a replenished image after binding revocation', async () => {
  let current = true;
  await expect(selectReplySticker({ private: true, available: 0, select: async () => null,
    draw: async () => { current = false; return true; }, assertCurrent: () => { if (!current) throw Error('revoked'); } })).rejects.toThrow('revoked');
});
