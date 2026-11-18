import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DomainRepository } from '../domain';
import { AgentLimitError, AgentRuntime } from './agent-runtime';
import { EffectLedger } from './effect-ledger';
import { PermissionDeniedError, PermissionGate } from './permissions';
import { TaskEventStream } from './task-event-stream';
import { ToolRegistry } from './tool-registry';

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-runtime-'));
  roots.push(root);
  const repository = new DomainRepository(join(root, 'domain.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 8) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl'));
  await events.initialize();
  return { root, repository, events };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PermissionGate', () => {
  const descriptors = [{ capabilityId: 'workspace.read', titleCode: 'permission.workspaceRead', detailCode: 'permission.workspaceRead.detail', risk: 'medium' as const }];
  const reopen = async (root: string): Promise<PermissionGate> => {
    const repository = new DomainRepository(join(root, 'domain.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 8) });
    await repository.initialize();
    return new PermissionGate(repository);
  };

  it('consumes one-shot grants and persists always grants', async () => {
    const { repository } = await fixture();
    const gate = new PermissionGate(repository);
    await gate.grant('notify', 'once');
    await gate.consume('notify');
    await expect(gate.consume('notify')).rejects.toBeInstanceOf(PermissionDeniedError);
    await gate.grant('workspace.read', 'always');
    await new PermissionGate(repository).consume('workspace.read');
  });

  it('upgrades a session grant immediately and keeps only the selected capability after reloading encrypted storage', async () => {
    const { root, repository } = await fixture();
    const gate = new PermissionGate(repository);
    await gate.grant('workspace.read', 'session');
    await gate.grant('time.read', 'session');
    await gate.grant('workspace.read', 'always');
    expect(gate.list(descriptors)[0]?.state).toBe('always');
    await gate.consume('workspace.read');
    const restarted = await reopen(root);
    expect(restarted.list(descriptors)[0]?.state).toBe('always');
    await restarted.consume('workspace.read');
    await expect(restarted.consume('time.read')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(restarted.consume('workspace.write')).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('downgrades an always grant to this session without reviving it after restart', async () => {
    const { root, repository } = await fixture();
    const gate = new PermissionGate(repository);
    await gate.grant('workspace.read', 'always');
    await gate.grant('time.read', 'always');
    await gate.grant('workspace.read', 'session');
    expect(gate.list(descriptors)[0]?.state).toBe('session');
    await gate.consume('workspace.read');
    const restarted = await reopen(root);
    expect(restarted.list(descriptors)[0]?.state).toBe('not-requested');
    await expect(restarted.consume('workspace.read')).rejects.toBeInstanceOf(PermissionDeniedError);
    await restarted.consume('time.read');
  });

  it('revokes a saved grant immediately and across restart', async () => {
    const { root, repository } = await fixture();
    const gate = new PermissionGate(repository);
    await gate.grant('workspace.read', 'session');
    await gate.grant('workspace.read', 'always');
    await gate.revoke('workspace.read');
    await expect(gate.consume('workspace.read')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect((await reopen(root)).consume('workspace.read')).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('preserves the previous scope when persisting a new choice fails', async () => {
    const { repository } = await fixture();
    const gate = new PermissionGate(repository);
    await gate.grant('workspace.read', 'session');
    const save = vi.spyOn(repository, 'transaction').mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(gate.grant('workspace.read', 'always')).rejects.toThrow('Storage unavailable');
    expect(gate.list(descriptors)[0]?.state).toBe('session');
    await gate.consume('workspace.read');
    save.mockRestore();
  });
});

describe('AgentRuntime', () => {
  it('passes supplied conversation context and the new input to the model without duplicating the input', async () => {
    const { repository, events } = await fixture();
    const runtime = new AgentRuntime(new ToolRegistry(), new PermissionGate(repository), new EffectLedger(repository), events);
    await runtime.run('Follow-up question', {
      next: async ({ messages }) => {
        expect(messages).toEqual([
          { role: 'system', content: 'DeskPet persona and saved memory' },
          { role: 'user', content: 'Earlier fact' },
          { role: 'assistant', content: 'Earlier response' },
          { role: 'user', content: 'Follow-up question' },
        ]);
        return { type: 'final', content: 'Remembered' };
      },
    }, randomUUID(), [
      { role: 'system', content: 'DeskPet persona and saved memory' },
      { role: 'user', content: 'Earlier fact' },
      { role: 'assistant', content: 'Earlier response' },
    ]);
  });

  it('executes an approved side effect once across retries with the same effect key', async () => {
    const { repository, events } = await fixture();
    const permissions = new PermissionGate(repository);
    await permissions.grant('timer', 'always');
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register({
      id: 'timer.create',
      title: 'Create timer',
      capabilityId: 'timer',
      risk: 'medium',
      sideEffect: true,
      inputSchema: z.object({ seconds: z.number().int().positive() }).strict(),
      execute: async () => ({ timerId: `timer-${++executions}` }),
    });
    const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repository), events);
    const effectKey = randomUUID();
    const driver = () => {
      let turn = 0;
      return {
        next: async () =>
          ++turn === 1
            ? ({ type: 'tools', calls: [{ id: randomUUID(), toolId: 'timer.create', input: { seconds: 60 }, effectKey }] } as const)
            : ({ type: 'final', content: 'done' } as const),
      };
    };
    expect((await runtime.run('start timer', driver())).status).toBe('succeeded');
    expect((await runtime.run('retry timer', driver())).status).toBe('succeeded');
    expect(executions).toBe(1);
  });

  it('enforces a bounded model loop', async () => {
    const { repository, events } = await fixture();
    const runtime = new AgentRuntime(new ToolRegistry(), new PermissionGate(repository), new EffectLedger(repository), events, 2);
    await expect(runtime.run('loop', { next: async () => ({ type: 'tools', calls: [] }) })).rejects.toBeInstanceOf(AgentLimitError);
  });

  it('gives the model JSON schemas and preserves assistant tool calls for the next turn', async () => {
    const { repository, events } = await fixture();
    const permissions = new PermissionGate(repository);
    await permissions.grant('time.read', 'always');
    const tools = new ToolRegistry();
    tools.register({
      id: 'time.current', title: 'Current time', capabilityId: 'time.read', risk: 'low', sideEffect: false,
      inputSchema: z.object({ timezone: z.string().optional() }).strict(),
      execute: async () => ({ iso: '2026-09-27T00:00:00.000Z' }),
    });
    const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repository), events);
    const turns: Array<Parameters<Parameters<AgentRuntime['run']>[1]['next']>[0]> = [];
    const callId = randomUUID();

    await runtime.run('What time is it?', {
      next: async (input) => {
        turns.push(input);
        return turns.length === 1
          ? { type: 'tools', calls: [{ id: callId, toolId: 'time.current', input: { timezone: 'UTC' } }] }
          : { type: 'final', content: 'It is midnight.' };
      },
    });

    expect(turns[0]?.tools[0]).toMatchObject({
      id: 'time.current', capabilityId: 'time.read', parameters: { type: 'object', additionalProperties: false },
    });
    expect(turns[1]?.messages).toContainEqual({
      role: 'assistant', content: '',
      toolCalls: [{ id: callId, name: 'time.current', argumentsJson: '{"timezone":"UTC"}' }],
    });
    expect(turns[1]?.messages).toContainEqual({
      role: 'tool', toolCallId: callId, hostToolResult: 'success', content: '{"iso":"2026-09-27T00:00:00.000Z"}',
    });
  });

  it('cancels an in-flight model turn', async () => {
    const { repository, events } = await fixture();
    const runtime = new AgentRuntime(new ToolRegistry(), new PermissionGate(repository), new EffectLedger(repository), events);
    const runId = randomUUID();
    const run = runtime.run(
      'wait',
      {
        next: ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ type: 'final', content: 'late' }), { once: true });
          }),
      },
      runId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.cancel(runId)).toBe(true);
    expect((await run).status).toBe('cancelled');
  });
});
