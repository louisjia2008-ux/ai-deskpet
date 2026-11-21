import { expect, it, vi } from 'vitest';
import { WeChatChannel } from './wechat-channel';

type Control = { run(args: string[], input: object, outputLimit: number, timeout: number): Promise<unknown> };

it.each([
  ['busy', 'busy'],
  ['paused', 'paused'],
  ['window_error', 'window_error'],
  ['binding_invalid', 'uncertain'],
  ['sent', 'sent'],
] as const)('preserves the Moments preview worker result %s as %s', async (status, expected) => {
  const bridge = new WeChatChannel('/not-used', '/not-used', null, 'darwin');
  const run = vi.spyOn(bridge as unknown as Control, 'run').mockResolvedValue({ status });
  const input = { id: 'a'.repeat(64), binding: 'b'.repeat(64), text: 'Synthetic preview', image: Buffer.from('synthetic image') };
  await expect(bridge.previewMoment(input)).resolves.toBe(expected);
  expect(run).toHaveBeenCalledExactlyOnceWith(['moments-preview'], { ...input, image: input.image.toString('base64') }, 16_384, 210_000);
});
