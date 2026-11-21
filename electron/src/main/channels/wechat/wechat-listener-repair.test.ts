import { expect, it, vi } from 'vitest';
import type { WeChatChannelState } from '../../../shared/wechat-channel';
import { WeChatChannel } from './wechat-channel';

const stopped: WeChatChannelState = {
  configured: true, groupName: null, state: 'stopped', stale: false, paused: false, privateStatus: null,
  groupStatus: null, pending: 0, uncertain: 0, groupPolicy: { mode: 'mentions', sender: null }, groups: [],
  groupBindingSupported: true, reply: { model: 'fixture', split: false, stickers: false },
};
type Control = { run(args: string[]): Promise<unknown> };

it('checks for a new running worker heartbeat before confirming repair', async () => {
  const bridge = new WeChatChannel('/not-used', '/not-used', async () => undefined, 'darwin');
  vi.spyOn(bridge, 'getState').mockResolvedValue(stopped);
  const after = Date.now() / 1000 - 1;
  const heartbeat = { state: 'running', heartbeat_at: after + 0.1, pid: 81, paused: false, stale: false };
  const run = vi.spyOn(bridge as unknown as Control, 'run')
    .mockResolvedValueOnce({ started: true, after, pid: 81 })
    .mockResolvedValueOnce(heartbeat)
    .mockResolvedValueOnce({ ...heartbeat, pid: 82, heartbeat_at: after - 5 })
    .mockResolvedValueOnce({ ...heartbeat, pid: 82 });
  expect(await bridge.restartListener(() => true)).toBe('recovered');
  expect(run.mock.calls.map(([args]) => args)).toEqual([['restart-listener'], ['status'], ['status'], ['status']]);
});

it('prevents a test profile or paused worker from invoking the restart helper', async () => {
  const testProfile = new WeChatChannel('/not-used', '/not-used', null, 'darwin');
  const read = vi.spyOn(testProfile, 'getState').mockResolvedValue(stopped);
  expect(await testProfile.restartListener(() => true)).toBe('skipped');
  expect(read).not.toHaveBeenCalled();
  const paused = new WeChatChannel('/not-used', '/not-used', async () => undefined, 'darwin');
  vi.spyOn(paused, 'getState').mockResolvedValue({ ...stopped, paused: true });
  const run = vi.spyOn(paused as unknown as Control, 'run');
  expect(await paused.restartListener(() => true)).toBe('skipped');
  expect(run).not.toHaveBeenCalled();
});
