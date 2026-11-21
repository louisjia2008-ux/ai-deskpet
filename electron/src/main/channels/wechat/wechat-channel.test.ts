import { chmod, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WeChatChannel } from './wechat-channel';

type Control = { run(args: string[], input: object, outputLimit: number, timeout: number): Promise<unknown>; requireConfigured(): Promise<unknown> };

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

it('carries the Moments worker stage and local screenshot and never passes reserved markers to the worker', async () => {
  const root = '/synthetic/worker';
  const bridge = new WeChatChannel(root, '/not-used', null, 'darwin');
  const control = bridge as unknown as Control;
  vi.spyOn(control, 'requireConfigured').mockResolvedValue({});
  const path = join(root, 'listener', 'moments-failures', '20261121T123456123456Z-paste.png');
  const run = vi.spyOn(control, 'run').mockResolvedValue({ status: 'restricted', stage: 'paste', screenshotPath: path });
  const input = { id: 'a'.repeat(64), text: '[mood:happy] Synthetic[sticker:none] caption', visibility: 'private' as const, images: [Buffer.from('synthetic image')] };
  await expect(bridge.postMoment(input)).resolves.toEqual({ status: 'restricted', stage: 'paste', screenshotPath: path });
  expect(run).toHaveBeenCalledExactlyOnceWith(['moments-post'], { ...input, text: 'Synthetic caption', images: input.images.map(item => item.toString('base64')) }, 16_384, 240_000);
  run.mockResolvedValueOnce({ status: 'restricted', stage: 'paste', screenshotPath: '/synthetic/outside/frame.png' });
  await expect(bridge.postMoment(input)).resolves.toEqual({ status: 'restricted', stage: 'paste' });
  run.mockResolvedValueOnce({ status: 'retry' });
  await expect(bridge.postMoment(input)).resolves.toEqual({ status: 'retry' });
  await expect(bridge.postMoment({ ...input, text: '[sticker:none]' })).resolves.toEqual({ status: 'invalid_payload' });
  expect(run).toHaveBeenCalledTimes(3);
});

it('lists only recent private Moments screenshot metadata from the local runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-moments-fixture-'));
  const bridge = new WeChatChannel(root, '/not-used', null, 'darwin');
  try {
    await mkdir(join(root, 'listener'), { mode: 0o700 });
    const dir = join(root, 'listener', 'moments-failures');
    await mkdir(dir, { mode: 0o700 });
    const recent = join(dir, '20261121T123456123456Z-camera.png');
    const expired = join(dir, '20261121T123456123457Z-camera.png');
    await writeFile(recent, 'synthetic', { mode: 0o600 });
    await writeFile(expired, 'synthetic', { mode: 0o600 });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(expired, eightDaysAgo, eightDaysAgo);
    await writeFile(join(dir, 'unrelated.png'), 'synthetic', { mode: 0o600 });
    const publicFile = join(dir, '20261121T123456123458Z-camera.png');
    await writeFile(publicFile, 'synthetic', { mode: 0o600 });
    await chmod(publicFile, 0o644);
    await symlink(recent, join(dir, '20261121T123456123459Z-confirm.png'));
    await expect(bridge.latestMomentFailureScreenshot()).resolves.toBe(recent);
    await rm(recent);
    await expect(bridge.latestMomentFailureScreenshot()).resolves.toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
