// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { AgentRuntime } from './agent-runtime';
import { ToolRegistry } from './tool-registry';
import type { PermissionGate } from './permissions';
import type { EffectLedger } from './effect-ledger';
import type { TaskEventStream } from './task-event-stream';

it('clears the active run even when the initial event cannot be saved', async () => {
  const events = { emit: vi.fn(async () => { throw new Error('Fixture disk failure'); }) };
  const runtime = new AgentRuntime(new ToolRegistry(), {} as PermissionGate, {} as EffectLedger, events as unknown as TaskEventStream);
  const next = vi.fn();
  await expect(runtime.run('Synthetic question', { next })).rejects.toThrow('Fixture disk failure');
  expect(next).not.toHaveBeenCalled(); expect(runtime.activeRuns).toBe(0);
});
