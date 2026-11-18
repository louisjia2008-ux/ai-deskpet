// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainRepository } from '../domain';
import { AgentRuntime } from './agent-runtime';
import type { AgentRunControls, ModelDriver, ModelTurnMessage } from './agent-runtime';
import { EffectLedger } from './effect-ledger';
import { PermissionGate } from './permissions';
import { TaskEventStream } from './task-event-stream';
import { ToolFailure } from './tool-failure';
import { ToolRegistry } from './tool-registry';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-file-delivery-')); roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 13) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl')); await events.initialize();
  const tools = new ToolRegistry(), permissions = new PermissionGate(repository);
  await permissions.grant('web.read', 'session');
  const write = vi.fn(async (input: { path: string; content: string }) => ({ path: input.path, written: true, bytes: input.content.length, sha256: 'b'.repeat(64) }));
  tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.string() }), execute: async input => {
      if ((input as { url: string }).url.endsWith('/ok')) return { url: 'https://example.org/ok', text: 'One verified fact.' };
      throw new ToolFailure('tool.network');
    } });
  tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({ path: z.string(), content: z.string() }), execute: input => write(input as { path: string; content: string }) });
  tools.register({ id: 'task.update', title: 'Plan', capabilityId: 'task.records', risk: 'low', sideEffect: false,
    inputSchema: z.object({}), execute: async () => ({}) });
  const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repository), events, 12);
  const controls: AgentRunControls = { fileDelivery: true, wrapUpOnLimit: true };
  return { runtime, permissions, write, controls };
};
const read = (id: number) => ({ type: 'tools' as const, calls: [{ id: 'read-' + id, toolId: 'web.read', input: { url: 'https://example.org/' + (id === 1 ? 'ok' : id) } }] });
const writeCall = () => ({ type: 'tools' as const, calls: [{ id: 'write', toolId: 'workspace.write', effectKey: 'file-delivery-write', input: { path: 'reports/research.md', content: 'Verified fact. Other sources failed; further comparison is unverified.' } }] });

it('reserves an approved write after four web failures and marks the result as a partial draft', async () => {
  const f = await fixture(); let round = 0;
  const authorizeTool = vi.fn<NonNullable<AgentRunControls['authorizeTool']>>(async tool => f.permissions.authorizeOperation(tool.capabilityId, f.permissions.revision(tool.capabilityId)));
  const next = vi.fn<ModelDriver['next']>(async input => {
    round += 1;
    if (round <= 5) return read(round);
    expect(input.tools.map(tool => tool.id)).toEqual(['workspace.write', 'task.update']);
    expect(input.wrapUp).not.toBe(true);
    return round === 6 ? writeCall() : { type: 'final', content: 'The draft is saved with unresolved claims marked.' };
  });
  const result = await f.runtime.run('Research the sources and save reports/research.md.', { next }, randomUUID(), [], undefined, undefined, { ...f.controls, authorizeTool });
  expect(result).toMatchObject({ status: 'succeeded', limitReached: true, failuresExhausted: true, draftDelivered: true });
  expect(authorizeTool).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledTimes(7);
});

it('keeps the real write approval mandatory and never executes a denied closeout', async () => {
  const f = await fixture(); let round = 0;
  const authorizeTool = vi.fn(async () => undefined);
  const next: ModelDriver['next'] = async () => ++round <= 5 ? read(round) : writeCall();
  await expect(f.runtime.run('Research and save reports/research.md.', { next }, randomUUID(), [], undefined, undefined, { ...f.controls, authorizeTool })).rejects.toMatchObject({ code: 'tool.permission.workspace.write' });
  expect(authorizeTool).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
});

it('makes one bounded correction for a false final claim and reports a missing deliverable without looping', async () => {
  const f = await fixture();
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'final', content: 'Saved successfully.' }));
  const result = await f.runtime.run('Write reports/research.md.', { next }, randomUUID(), [], undefined, undefined, f.controls);
  expect(result).toMatchObject({ status: 'succeeded', limitReached: true, deliveryIncomplete: true });
  expect(next).toHaveBeenCalledTimes(2); expect(f.write).not.toHaveBeenCalled();
  expect(next.mock.calls[1]![0].tools.map(tool => tool.id)).toEqual(['workspace.write', 'task.update']);
});

it('honours a follow-up cancelling the file while approval is pending', async () => {
  const f = await fixture(); let round = 0;
  const queued: ModelTurnMessage[] = [];
  const next: ModelDriver['next'] = async input => {
    round += 1;
    if (round <= 5) return read(round);
    if (round === 6) return writeCall();
    expect(input.messages.some(message => message.role === 'user' && message.content.includes('不要写文件'))).toBe(true);
    expect(input.messages.some(message => message.content.startsWith('The host is closing'))).toBe(false);
    return { type: 'final', content: 'One verified fact. The requested file was cancelled.' };
  };
  const result = await f.runtime.run('Research and save reports/research.md.', { next }, randomUUID(), [], undefined, undefined, {
    ...f.controls, drainFollowups: async () => queued.splice(0), authorizeTool: async () => { queued.push({ role: 'user', content: '不要写文件，只告诉我读到了什么。' }); return undefined; },
  });
  expect(result).toMatchObject({ status: 'succeeded' }); expect(result.limitReached).toBeUndefined(); expect(f.write).not.toHaveBeenCalled();
});

it('does not open a file delivery phase for a read-only answer', async () => {
  const f = await fixture(); let round = 0;
  const next: ModelDriver['next'] = async input => {
    round += 1;
    if (round <= 5) return read(round);
    expect(input.tools.some(tool => tool.id === 'web.read')).toBe(true);
    return { type: 'final', content: 'One verified fact; some sources could not be read.' };
  };
  const result = await f.runtime.run('Research and answer here.', { next }, randomUUID(), [], undefined, undefined, f.controls);
  expect(result.limitReached).toBeUndefined(); expect(f.write).not.toHaveBeenCalled();
});
