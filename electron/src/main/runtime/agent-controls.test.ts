// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainRepository } from '../domain';
import type { ProviderResponseItem } from '../providers/types';
import { prepareProviderChatRequest } from '../providers/request-budget';
import { AgentLimitError, AgentRuntime } from './agent-runtime';
import type { AgentRunProgress, ModelDriver, ModelTurnMessage } from './agent-runtime';
import { EffectLedger } from './effect-ledger';
import { PermissionDeniedError, PermissionGate } from './permissions';
import { TaskEventStream } from './task-event-stream';
import { ToolFailure } from './tool-failure';
import { ToolRegistry } from './tool-registry';
import { QqWebBudget } from '../security/channel-policy';

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-agent-controls-')); roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 33) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl')); await events.initialize();
  const tools = new ToolRegistry();
  const permissions = new PermissionGate(repository);
  const effects = new EffectLedger(repository);
  const runtime = new AgentRuntime(tools, permissions, effects, events);
  const queued: ModelTurnMessage[] = [];
  const drainFollowups = async (): Promise<ModelTurnMessage[]> => queued.splice(0);
  return { repository, events, tools, permissions, effects, runtime, queued, drainFollowups };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('charges a QQ web call exactly once despite repeated in-tool authorization checks', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const beforeTool = vi.fn(), onToolExecuting = vi.fn();
  const budget = new QqWebBudget(); const runId = randomUUID(); let turn = 0;
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute: async (_input, context) => {
      for (let n = 0; n < 8; n += 1) context.assertAuthorized?.();
      return { text: 'public' };
    } });
  const result = await f.runtime.run('Read', { next: async () => ++turn === 1
    ? { type: 'tools', calls: [{ id: 'c1', toolId: 'web.read', input: {} }] }
    : { type: 'final', content: 'public' } }, runId, [], undefined, undefined, {
    beforeTool, onToolExecuting: tool => { onToolExecuting(); if (!budget.consume(runId, tool.id, 1)) throw new ToolFailure('tool.channelBlocked'); },
  });
  expect(result.status).toBe('succeeded'); expect(beforeTool.mock.calls.length).toBeGreaterThan(8);
  expect(onToolExecuting).toHaveBeenCalledOnce(); expect(budget.consume(runId, 'web.read', 1)).toBe(false);
});

it('does not charge the execution hook when an effect is replayed from the ledger', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  const execute = vi.fn(async () => ({ written: true })), onToolExecuting = vi.fn(); let turn = 0;
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({}).strict(), execute });
  await f.runtime.run('write', { next: async () => ++turn <= 2
    ? { type: 'tools', calls: [{ id: `c${turn}`, toolId: 'workspace.write', input: {}, effectKey: 'same-effect' }] }
    : { type: 'final', content: 'done' } }, randomUUID(), [], undefined, undefined, { onToolExecuting });
  expect(execute).toHaveBeenCalledOnce(); expect(onToolExecuting).toHaveBeenCalledOnce();
});

it('returns a safe read error and lets the model correct its path, preserving Responses items and call IDs', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.read', 'session');
  const execute = vi.fn(async (input: unknown) => {
    if ((input as { path: string }).path === 'wrong.txt') throw Object.assign(new Error('/private/secret fixture error'), { code: 'ENOENT' });
    return { text: 'Verified file result' };
  });
  f.tools.register({ id: 'workspace.read', title: 'Read', capabilityId: 'workspace.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ path: z.string() }).strict(), execute });
  const items: ProviderResponseItem[] = [
    { type: 'reasoning', id: 'reasoning-fixture', summary: [], encrypted_content: 'opaque-fixture' },
    { type: 'function_call', call_id: 'read-first', name: 'workspace.read', arguments: '{"path":"wrong.txt"}' },
  ];
  let turn = 0;
  const progress: AgentRunProgress[] = [];
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    turn += 1;
    if (turn === 1) return { type: 'tools', responseItems: items, calls: [{ id: 'read-first', toolId: 'workspace.read', input: { path: 'wrong.txt' } }] };
    if (turn === 2) {
      expect(progress).toContainEqual({ type: 'recovery', toolId: 'workspace.read' });
      expect(messages.find((message) => message.role === 'assistant')?.responseItems).toEqual(items);
      const failed = messages.find((message) => message.toolCallId === 'read-first')!;
      expect(failed.hostToolResult).toBe('safe-error');
      expect(JSON.parse(failed.content)).toMatchObject({ ok: false, error: { code: 'tool.fileMissing', retryable: true } });
      expect(failed.content).not.toContain('/private/secret');
      return { type: 'tools', calls: [{ id: 'read-corrected', toolId: 'workspace.read', input: { path: 'correct.txt' } }] };
    }
    expect(messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['read-first', 'read-corrected']);
    expect(messages.at(-1)?.content).toContain('Verified file result');
    expect(messages.at(-1)?.hostToolResult).toBe('success');
    return { type: 'final', content: 'Verified answer' };
  });
  const receipt = vi.fn(async () => undefined);
  expect(await f.runtime.run('Read file', { next }, randomUUID(), [], receipt, (value) => progress.push(value))).toMatchObject({ status: 'succeeded', iterations: 3 });
  expect(execute).toHaveBeenCalledTimes(2); expect(receipt).toHaveBeenCalledOnce();
  expect(progress.filter((value) => value.type === 'recovery')).toEqual([{ type: 'recovery', toolId: 'workspace.read' }]);
});

it('allows correction of invalid side-effect arguments before execution and retains the effect ledger', async () => {
  const f = await fixture(); await f.permissions.grant('timer.write', 'session');
  const execute = vi.fn(async () => ({ timerId: 'synthetic-timer' }));
  f.tools.register({ id: 'timer.create', title: 'Timer', capabilityId: 'timer.write', risk: 'medium', sideEffect: true,
    inputSchema: z.object({ seconds: z.number().positive() }).strict(), execute });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    turn += 1;
    if (turn === 1) return { type: 'tools', calls: [{ id: 'invalid', toolId: 'timer.create', input: { seconds: 'private-invalid-input' }, effectKey: 'invalid-key' }] };
    if (turn === 2) {
      expect(execute).not.toHaveBeenCalled(); expect(f.repository.snapshot().sideEffects).toHaveLength(0);
      const output = messages.find((message) => message.toolCallId === 'invalid')!;
      expect(JSON.parse(output.content)).toMatchObject({ ok: false, error: { code: 'tool.invalidArguments', retryable: true } });
      expect(output.content).not.toContain('private-invalid-input');
      return { type: 'tools', calls: [{ id: 'valid', toolId: 'timer.create', input: { seconds: 60 }, effectKey: 'valid-key' }] };
    }
    return { type: 'final', content: 'Timer created' };
  });
  await f.runtime.run('Create timer', { next });
  expect(execute).toHaveBeenCalledOnce();
  expect(f.repository.snapshot().sideEffects).toHaveLength(1);
  expect(f.repository.snapshot().sideEffects[0]?.key).toBe('valid-key');
});

it('validates the entire batch before any earlier valid side effect and returns every call ID for replanning', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  const execute = vi.fn(async () => ({ written: true }));
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({ path: z.string() }).strict(), execute });
  const consume = vi.spyOn(f.permissions, 'consume');
  const authorizeTool = vi.fn(async () => undefined);
  const receipt = vi.fn(async () => undefined);
  const items: ProviderResponseItem[] = [
    { type: 'function_call', call_id: 'valid-before', name: 'workspace.write', arguments: '{"path":"first.txt"}' },
    { type: 'function_call', call_id: 'invalid', name: 'workspace.write', arguments: '{"path":42}' },
    { type: 'function_call', call_id: 'valid-after', name: 'workspace.write', arguments: '{"path":"third.txt"}' },
  ];
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', responseItems: items, calls: [
      { id: 'valid-before', toolId: 'workspace.write', input: { path: 'first.txt' }, effectKey: 'first' },
      { id: 'invalid', toolId: 'workspace.write', input: { path: 42 }, effectKey: 'second' },
      { id: 'valid-after', toolId: 'workspace.write', input: { path: 'third.txt' }, effectKey: 'third' },
    ] };
    expect(execute).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled(); expect(authorizeTool).not.toHaveBeenCalled();
    expect(f.repository.snapshot().sideEffects).toHaveLength(0);
    expect(messages.find((message) => message.role === 'assistant')?.responseItems).toEqual(items);
    const outputs = messages.filter((message) => message.role === 'tool');
    expect(outputs.map((message) => message.toolCallId)).toEqual(['valid-before', 'invalid', 'valid-after']);
    expect(outputs.map((message) => message.hostToolResult)).toEqual(['skipped', 'safe-error', 'skipped']);
    expect(JSON.parse(outputs[1]!.content)).toMatchObject({ ok: false, error: { code: 'tool.invalidArguments', retryable: true } });
    for (const output of [outputs[0]!, outputs[2]!]) expect(JSON.parse(output.content)).toMatchObject({ ok: false, skipped: true, error: { code: 'tool.batchReplan' } });
    return { type: 'final', content: 'No changes made; the batch needs a corrected plan.' };
  });
  expect((await f.runtime.run('Write three files', { next }, randomUUID(), [], receipt, undefined, { authorizeTool })).status).toBe('succeeded');
  expect(execute).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(2);
});

it('skips all later calls after a recoverable read failure so an old batch cannot write using a failed premise', async () => {
  const f = await fixture();
  await f.permissions.grant('workspace.read', 'session'); await f.permissions.grant('workspace.write', 'session');
  const read = vi.fn(async () => { throw Object.assign(new Error('SYNTHETIC_PRIVATE_RAW_ERROR'), { code: 'ENOENT' }); });
  const write = vi.fn(async () => ({ written: true }));
  f.tools.register({ id: 'workspace.read', title: 'Read', capabilityId: 'workspace.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ path: z.string() }).strict(), execute: read });
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({ path: z.string() }).strict(), execute: write });
  const consume = vi.spyOn(f.permissions, 'consume');
  const receipt = vi.fn(async () => undefined);
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', calls: [
      { id: 'failed-read', toolId: 'workspace.read', input: { path: 'missing.txt' } },
      { id: 'old-write', toolId: 'workspace.write', input: { path: 'output.txt' }, effectKey: 'old-write' },
      { id: 'old-read', toolId: 'workspace.read', input: { path: 'another.txt' } },
    ] };
    expect(write).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce(); expect(f.repository.snapshot().sideEffects).toHaveLength(0);
    const outputs = messages.filter((message) => message.role === 'tool');
    expect(outputs.map((message) => message.toolCallId)).toEqual(['failed-read', 'old-write', 'old-read']);
    expect(outputs.map((message) => message.hostToolResult)).toEqual(['safe-error', 'skipped', 'skipped']);
    expect(JSON.parse(outputs[0]!.content)).toMatchObject({ ok: false, error: { code: 'tool.fileMissing', retryable: true } });
    expect(outputs[0]!.content).not.toContain('SYNTHETIC_PRIVATE_RAW_ERROR');
    for (const output of outputs.slice(1)) expect(JSON.parse(output.content)).toMatchObject({ ok: false, skipped: true, error: { code: 'tool.batchReplan' } });
    return { type: 'final', content: 'The input is missing, so no files were changed.' };
  });
  expect((await f.runtime.run('Read then write', { next }, randomUUID(), [], receipt)).status).toBe('succeeded');
  expect(consume).toHaveBeenCalledExactlyOnceWith('workspace.read');
  expect(receipt).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(2);
});

it('bounds transient failure corrections per run instead of retrying until the full loop limit', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async () => { throw new ToolFailure('tool.timeout'); });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute });
  let call = 0;
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: `read-${++call}`, toolId: 'web.read', input: {} }] }));
  await expect(f.runtime.run('Read', { next })).rejects.toMatchObject({ code: 'tool.timeout' });
  expect(next).toHaveBeenCalledTimes(3); expect(execute).toHaveBeenCalledTimes(3);
  expect((await f.events.readAll()).filter((event) => event.metadata.recovery !== undefined)).toHaveLength(2);
});

it('keeps researching past several unrelated page failures', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async (input: unknown) => {
    if ((input as { url: string }).url !== 'https://example.org/ok') throw new ToolFailure('tool.network');
    return { text: 'usable source' };
  });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.string() }).strict(), execute });
  const urls = ['a', 'b', 'c', 'd', 'ok'].map((path) => `https://example.org/${path}`);
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async () => {
    const url = urls[turn++];
    return url ? { type: 'tools', calls: [{ id: `read-${turn}`, toolId: 'web.read', input: { url } }] } : { type: 'final', content: 'Report, four sources unavailable.' };
  });
  const result = await new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 24).run('Research', { next });
  expect(result).toMatchObject({ status: 'succeeded', content: 'Report, four sources unavailable.' });
  expect(execute).toHaveBeenCalledTimes(5);
});

it('still ends the run when distinct failures exceed the total correction budget', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async () => { throw new ToolFailure('tool.network'); });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.string() }).strict(), execute });
  let call = 0;
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: `read-${++call}`, toolId: 'web.read', input: { url: `https://example.org/${call}` } }] }));
  await expect(new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 24).run('Research', { next })).rejects.toMatchObject({ code: 'tool.network' });
  expect(execute).toHaveBeenCalledTimes(9);
  expect((await f.events.readAll()).filter((event) => event.metadata.recovery !== undefined)).toHaveLength(8);
});

it('stops running a repeatedly failing call, tells the model, and lets it finish the rest', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async (input: unknown) => {
    if ((input as { url: string }).url === 'https://example.org/missing') throw new ToolFailure('tool.pluginResponse');
    return { text: 'usable source' };
  });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.string() }).strict(), execute });
  const urls = ['missing', 'missing', 'missing', 'ok'].map((path) => `https://example.org/${path}`);
  let turn = 0; const replies: unknown[] = [];
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (turn > 0) replies.push(JSON.parse(messages.at(-1)!.content));
    const url = urls[turn++];
    return url ? { type: 'tools', calls: [{ id: `read-${turn}`, toolId: 'web.read', input: { url } }] } : { type: 'final', content: 'One page was missing.' };
  });
  const result = await new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 24).run('Read', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true });
  expect(result).toMatchObject({ status: 'succeeded', content: 'One page was missing.' });
  expect(result.limitReached).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(3);
  expect(replies[2]).toMatchObject({ ok: false, error: { code: 'tool.repeatedFailure', retryable: false } });
});

it('reports progress instead of failing when the model will not stop repeating a failed call', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async () => { throw new ToolFailure('tool.pluginResponse'); });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute });
  let call = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp, tools }) => wrapUp
    ? (expect(tools).toEqual([]), { type: 'final', content: 'Read nothing; the page keeps failing.' })
    : { type: 'tools', calls: [{ id: `read-${++call}`, toolId: 'web.read', input: {} }] });
  const result = await new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 24).run('Read', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true });
  expect(result).toMatchObject({ status: 'succeeded', limitReached: true, failuresExhausted: true, content: 'Read nothing; the page keeps failing.' });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(next).toHaveBeenCalledTimes(5);
});

it('reports progress when distinct failures spend the correction budget and the host opts in', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async () => { throw new ToolFailure('tool.network'); });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.string() }).strict(), execute });
  let call = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp }) => wrapUp ? { type: 'final', content: 'Nothing could be read.' }
    : { type: 'tools', calls: [{ id: `read-${++call}`, toolId: 'web.read', input: { url: `https://example.org/${call}` } }] });
  const result = await new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 24).run('Read', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true });
  expect(result).toMatchObject({ limitReached: true, failuresExhausted: true, content: 'Nothing could be read.' });
  expect(execute).toHaveBeenCalledTimes(9);
});

it('answers a host-refused call without running it, and still runs the calls before it', async () => {
  const f = await fixture(); await f.permissions.grant('local', 'session'); await f.permissions.grant('web', 'session');
  const local = vi.fn(async () => ({ text: 'private' })); const web = vi.fn(async () => ({ text: 'public' })); const after = vi.fn(async () => ({ text: 'private' }));
  const register = (id: string, execute: () => Promise<unknown>) => f.tools.register({ id, title: id, capabilityId: id === 'web' ? 'web' : 'local', risk: 'low', sideEffect: false, inputSchema: z.object({}).strict(), execute });
  register('local', local); register('web', web); register('after', after);
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (messages.at(-1)?.role !== 'tool') return { type: 'tools', calls: ['local', 'web', 'after'].map((toolId) => ({ id: toolId, toolId, input: {} })) };
    const results = messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as Record<string, unknown>);
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'tool.contextPrivacyBlocked', retryable: false, message: 'Not sent.' } });
    expect(results[2]).toMatchObject({ skipped: true, error: { code: 'tool.batchReplan' } });
    return { type: 'final', content: 'Answered from local data.' };
  });
  const refuseCall = (call: { toolId: string }) => call.toolId === 'web' ? { failure: new ToolFailure('tool.contextPrivacyBlocked'), message: 'Not sent.' } : undefined;
  const result = await f.runtime.run('Mixed', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true, refuseCall });
  expect(result).toMatchObject({ status: 'succeeded', content: 'Answered from local data.' });
  expect(local).toHaveBeenCalledOnce(); expect(web).not.toHaveBeenCalled(); expect(after).not.toHaveBeenCalled();
  await expect(f.runtime.run('Scheduled', { next: vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: 'web', toolId: 'web', input: {} }] })) }, randomUUID(), [], undefined, undefined, { refuseCall }))
    .rejects.toMatchObject({ code: 'tool.contextPrivacyBlocked' });
  expect(web).not.toHaveBeenCalled();
});

it('repeats an interrupted model call once when the host says nothing was produced', async () => {
  const f = await fixture();
  const next = vi.fn<ModelDriver['next']>()
    .mockRejectedValueOnce(new Error('provider.streamInterrupted'))
    .mockResolvedValueOnce({ type: 'final', content: 'Recovered.' });
  const result = await f.runtime.run('Hi', { next }, randomUUID(), [], undefined, undefined, { retryModelCall: () => true });
  expect(result).toMatchObject({ status: 'succeeded', content: 'Recovered.' });
  const again = vi.fn<ModelDriver['next']>(async () => { throw new Error('provider.streamInterrupted'); });
  await expect(f.runtime.run('Hi', { next: again }, randomUUID(), [], undefined, undefined, { retryModelCall: () => true })).rejects.toThrow('provider.streamInterrupted');
  expect(again).toHaveBeenCalledTimes(2);
  const refused = vi.fn<ModelDriver['next']>(async () => { throw new Error('provider.streamInterrupted'); });
  await expect(f.runtime.run('Hi', { next: refused }, randomUUID(), [], undefined, undefined, { retryModelCall: () => false })).rejects.toThrow('provider.streamInterrupted');
  expect(refused).toHaveBeenCalledOnce();
});

it('tells the model why a page failed using only the fixed detail code', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false, inputSchema: z.object({}).strict(),
    execute: async () => { throw new ToolFailure('tool.pluginResponse', 'https://private.example/raw', 'plugin.pageNotFound'); } });
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (messages.at(-1)?.role !== 'tool') return { type: 'tools', calls: [{ id: 'read', toolId: 'web.read', input: {} }] };
    expect(messages.at(-1)!.content).toContain('HTTP 404');
    expect(messages.at(-1)!.content).not.toContain('private.example');
    return { type: 'final', content: 'Missing.' };
  });
  await expect(f.runtime.run('Read', { next })).resolves.toMatchObject({ content: 'Missing.' });
  expect((await f.events.readAll()).find((event) => event.metadata.recovery !== undefined)?.metadata.detail).toBe('plugin.pageNotFound');
});

it('reports progress with a tool-free call at the step limit when the host opts in', async () => {
  const f = await fixture();
  f.tools.register({ id: 'noop', title: 'Noop', capabilityId: 'noop', risk: 'low', sideEffect: false, inputSchema: z.object({}).strict(), execute: async () => ({ ok: true }) });
  await f.permissions.grant('noop', 'session');
  const wrapUpInputs: Array<{ tools: unknown[]; lastRole: string | undefined }> = [];
  const onFinishing = vi.fn(() => true);
  let call = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp, tools, messages }) => {
    if (wrapUp) { wrapUpInputs.push({ tools, lastRole: messages.at(-1)?.role }); return { type: 'final', content: 'Finished two steps; the third remains.' }; }
    return { type: 'tools', calls: [{ id: `step-${++call}`, toolId: 'noop', input: {} }] };
  });
  const result = await new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 2).run('Long', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true, onFinishing });
  expect(result).toMatchObject({ status: 'succeeded', content: 'Finished two steps; the third remains.', iterations: 2, limitReached: true });
  expect(next).toHaveBeenCalledTimes(3);
  expect(wrapUpInputs).toEqual([{ tools: [], lastRole: 'tool' }]);
  expect(onFinishing).toHaveBeenCalledOnce();
});

it.each([
  ['requests more tools', async () => ({ type: 'tools', calls: [] }) as const],
  ['returns empty text', async () => ({ type: 'final', content: '   ' }) as const],
])('fails with the limit error when the wrap-up call %s', async (_name, wrapUp) => {
  const f = await fixture();
  const next = vi.fn<ModelDriver['next']>(async (input) => input.wrapUp ? wrapUp() : { type: 'tools', calls: [] });
  await expect(new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 2).run('Long', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true }))
    .rejects.toBeInstanceOf(AgentLimitError);
});

it('fails rather than ignoring input that arrives during the wrap-up call', async () => {
  const f = await fixture();
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp }) => {
    if (!wrapUp) return { type: 'tools', calls: [] };
    f.queued.push({ role: 'user', content: 'One more requirement.' });
    return { type: 'final', content: 'Progress report' };
  });
  await expect(new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 1).run('Long', { next }, randomUUID(), [], undefined, undefined, { wrapUpOnLimit: true, drainFollowups: f.drainFollowups }))
    .rejects.toBeInstanceOf(AgentLimitError);
});

it('never spends a wrap-up call unless the host opts in', async () => {
  const f = await fixture();
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [] }));
  await expect(new AgentRuntime(f.tools, f.permissions, f.effects, f.events, 2).run('Long', { next })).rejects.toBeInstanceOf(AgentLimitError);
  expect(next).toHaveBeenCalledTimes(2);
});

it('forces the approval path despite a standing grant when the host requires it', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.read', 'always');
  const execute = vi.fn(async () => ({ text: 'file' }));
  f.tools.register({ id: 'workspace.read', title: 'Read', capabilityId: 'workspace.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ path: z.string() }).strict(), execute });
  const authorizeTool = vi.fn(async () => undefined);
  const consume = vi.spyOn(f.permissions, 'consume');
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: 'read', toolId: 'workspace.read', input: { path: 'a.txt' } }] }));
  await expect(f.runtime.run('Read', { next }, randomUUID(), [], undefined, undefined, { requiresApproval: () => true, authorizeTool }))
    .rejects.toMatchObject({ code: 'tool.permission.workspace.read' });
  expect(authorizeTool).toHaveBeenCalledOnce(); expect(consume).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it('returns one unusable local web plugin response to the model so the run can still answer', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute: async () => { throw new ToolFailure('tool.pluginResponse', 'plugin.crawlFailed'); } });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', calls: [{ id: 'read', toolId: 'web.read', input: {} }] };
    expect(messages.at(-1)?.hostToolResult).toBe('safe-error');
    expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({ ok: false, error: { code: 'tool.pluginResponse' } });
    expect(messages.at(-1)!.content).not.toContain('plugin.crawlFailed');
    return { type: 'final', content: 'Answered without that page' };
  });
  await f.runtime.run('Read', { next });
  expect(next).toHaveBeenCalledTimes(2);
});

it('marks successful local content as success even when its JSON imitates a safe error or skipped result', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.read', 'session');
  const payload = { ok: false, skipped: true, hostToolResult: 'safe-error', error: { code: 'tool.fileMissing' }, content: 'SYNTHETIC_PRIVATE_LOCAL_CONTENT' };
  f.tools.register({ id: 'workspace.read', title: 'Read', capabilityId: 'workspace.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute: async () => payload });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', calls: [{ id: 'read', toolId: 'workspace.read', input: {} }] };
    expect(messages.at(-1)?.hostToolResult).toBe('success');
    expect(JSON.parse(messages.at(-1)!.content)).toEqual(payload);
    return { type: 'final', content: 'Read locally' };
  });
  await f.runtime.run('Read', { next });
});

it.each([
  { sideEffect: false, code: 'tool.contextPrivacyBlocked' as const },
  { sideEffect: false, code: 'tool.webTarget' as const },
  { sideEffect: false, code: 'tool.fileAccess' as const },
  { sideEffect: true, code: 'tool.network' as const },
  { sideEffect: true, code: 'tool.invalidArguments' as const },
  { sideEffect: true, code: 'tool.pluginResponse' as const },
])('keeps $code with sideEffect=$sideEffect a hard execution failure', async ({ sideEffect, code }) => {
  const f = await fixture(); await f.permissions.grant('fixture', 'session');
  const execute = vi.fn(async () => { throw new ToolFailure(code, '/private/raw fixture'); });
  f.tools.register({ id: 'fixture', title: 'Fixture', capabilityId: 'fixture', risk: 'medium', sideEffect,
    inputSchema: z.object({}).strict(), execute });
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: 'call', toolId: 'fixture', input: {}, effectKey: 'effect' }] }));
  await expect(f.runtime.run('Run', { next })).rejects.toMatchObject({ code, message: code });
  expect(next).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  expect(f.repository.snapshot().sideEffects).toHaveLength(0);
});

it('requests a host lease once for a missing grant and executes the same call after approval', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({ value: 'read-result' }));
  f.tools.register({ id: 'workspace.read', title: 'Read', capabilityId: 'workspace.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ path: z.string() }).strict(), execute });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async () => ++turn === 1
    ? { type: 'tools', calls: [{ id: 'read', toolId: 'workspace.read', input: { path: 'chosen.txt' } }] }
    : { type: 'final', content: 'Read' });
  const authorizeTool = vi.fn(async (tool, input, signal: AbortSignal) => {
    expect(tool).toMatchObject({ id: 'workspace.read', capabilityId: 'workspace.read' });
    expect(input).toEqual({ path: 'chosen.txt' }); expect(signal.aborted).toBe(false);
    await f.permissions.grant('workspace.read', 'once'); return f.permissions.consume('workspace.read');
  });
  expect((await f.runtime.run('Read', { next }, randomUUID(), [], undefined, undefined, { authorizeTool })).status).toBe('succeeded');
  expect(authorizeTool).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  await expect(f.permissions.consume('workspace.read')).rejects.toBeInstanceOf(PermissionDeniedError);
});

it('does not turn denial or mid-execution revocation into a new approval or a recovery', async () => {
  const f = await fixture(); await f.permissions.grant('web.read', 'session');
  const execute = vi.fn(async () => {
    await f.permissions.revoke('web.read');
    throw new Error('Transport reported a generic error after permission revocation');
  });
  f.tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute });
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: 'read', toolId: 'web.read', input: {} }] }));
  const authorizeTool = vi.fn(async () => undefined);
  await expect(f.runtime.run('Read', { next }, randomUUID(), [], undefined, undefined, { authorizeTool })).rejects.toMatchObject({ code: 'tool.permission.web.read' });
  expect(next).toHaveBeenCalledOnce(); expect(authorizeTool).not.toHaveBeenCalled();
  next.mockClear(); execute.mockClear();
  await expect(f.runtime.run('Read again', { next }, randomUUID(), [], undefined, undefined, { authorizeTool })).rejects.toMatchObject({ code: 'tool.permission.web.read' });
  expect(next).toHaveBeenCalledOnce(); expect(authorizeTool).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
});

it('finishes the active tool then skips all remaining old calls before accepting a follow-up', async () => {
  const f = await fixture(); await f.permissions.grant('fixture', 'session');
  let finishTool!: () => void;
  const order: string[] = [];
  const execute = vi.fn(async (input: unknown) => {
    const { step } = input as { step: number };
    order.push(`start-${step}`);
    await new Promise<void>((resolve) => { finishTool = resolve; });
    order.push(`finish-${step}`); return { step };
  });
  f.tools.register({ id: 'fixture', title: 'Fixture', capabilityId: 'fixture', risk: 'medium', sideEffect: true,
    inputSchema: z.object({ step: z.number() }).strict(), execute });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', calls: [1, 2, 3].map((step) => ({ id: `call-${step}`, toolId: 'fixture', input: { step }, effectKey: `effect-${step}` })) };
    const outputs = messages.filter((message) => message.role === 'tool');
    expect(outputs.map((message) => message.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);
    expect(outputs.map((message) => message.hostToolResult)).toEqual(['success', 'skipped', 'skipped']);
    expect(JSON.parse(outputs[0]!.content)).toEqual({ step: 1 });
    expect(outputs.slice(1).every((message) => JSON.parse(message.content).skipped === true)).toBe(true);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Do not perform the remaining changes.' });
    order.push('updated-model'); return { type: 'final', content: 'Only the first operation completed.' };
  });
  const running = f.runtime.run('Do three operations', { next }, randomUUID(), [], undefined, undefined, { drainFollowups: f.drainFollowups });
  await vi.waitFor(() => expect(finishTool).toBeDefined());
  f.queued.push({ role: 'user', content: 'Do not perform the remaining changes.' });
  await Promise.resolve(); expect(f.queued).toHaveLength(1); expect(next).toHaveBeenCalledOnce();
  finishTool();
  expect((await running).status).toBe('succeeded');
  expect(execute).toHaveBeenCalledOnce(); expect(order).toEqual(['start-1', 'finish-1', 'updated-model']);
  expect(f.repository.snapshot().sideEffects).toHaveLength(1);
});

it('releases a newly granted lease and skips the complete old batch when a follow-up arrived during approval', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({}));
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({}).strict(), execute });
  const release = vi.fn();
  const authorizeTool = vi.fn(async () => {
    f.queued.push({ role: 'user', content: 'Do not write; explain the changes instead.' });
    return { signal: new AbortController().signal, assertCurrent: vi.fn(), release };
  });
  const items: ProviderResponseItem[] = [
    { type: 'function_call', call_id: 'write-1', name: 'workspace.write', arguments: '{}' },
    { type: 'function_call', call_id: 'write-2', name: 'workspace.write', arguments: '{}' },
  ];
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', responseItems: items, calls: [1, 2].map((id) => ({ id: `write-${id}`, toolId: 'workspace.write', input: {}, effectKey: `write-${id}` })) };
    expect(release).toHaveBeenCalledOnce();
    expect(messages.find((message) => message.role === 'assistant')?.responseItems).toEqual(items);
    const outputs = messages.filter((message) => message.role === 'tool');
    expect(outputs.map((message) => message.toolCallId)).toEqual(['write-1', 'write-2']);
    for (const output of outputs) expect(JSON.parse(output.content)).toMatchObject({ ok: false, skipped: true, error: { code: 'tool.superseded' } });
    expect(outputs.every((output) => output.hostToolResult === 'skipped')).toBe(true);
    expect(messages.at(-1)?.content).toBe('Do not write; explain the changes instead.');
    return { type: 'final', content: 'Explanation only' };
  });
  await f.runtime.run('Write both', { next }, randomUUID(), [], undefined, undefined, { authorizeTool, drainFollowups: f.drainFollowups });
  expect(authorizeTool).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  expect(f.repository.snapshot().sideEffects).toHaveLength(0);
});

it('replans after the host dismisses an approval for a queued follow-up without inventing a lease', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({}));
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({}).strict(), execute });
  const authorizeTool = vi.fn(async () => {
    f.queued.push({ role: 'user', content: 'Keep everything unchanged; just explain.' });
    return undefined;
  });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', calls: [{ id: 'write', toolId: 'workspace.write', input: {}, effectKey: 'write' }] };
    expect(JSON.parse(messages.find((message) => message.toolCallId === 'write')!.content)).toMatchObject({ skipped: true });
    expect(messages.at(-1)?.content).toBe('Keep everything unchanged; just explain.');
    return { type: 'final', content: 'Explanation only' };
  });
  expect((await f.runtime.run('Write', { next }, randomUUID(), [], undefined, undefined, { authorizeTool, drainFollowups: f.drainFollowups })).status).toBe('succeeded');
  expect(execute).not.toHaveBeenCalled(); expect(authorizeTool).toHaveBeenCalledOnce();
  await expect(f.permissions.consume('workspace.write')).rejects.toBeInstanceOf(PermissionDeniedError);
});

it('checks a follow-up again after the effect ledger waits and before any actual mutation', async () => {
  const f = await fixture(); await f.permissions.grant('workspace.write', 'session');
  const execute = vi.fn(async () => ({ written: true }));
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({}).strict(), execute });
  let resume!: () => void;
  const originalExecute = f.effects.execute.bind(f.effects);
  vi.spyOn(f.effects, 'execute').mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => { resume = resolve; });
    return originalExecute(...args);
  });
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) return { type: 'tools', calls: [{ id: 'write', toolId: 'workspace.write', input: {}, effectKey: 'queued-write' }] };
    expect(JSON.parse(messages.find((message) => message.toolCallId === 'write')!.content)).toMatchObject({ skipped: true });
    expect(messages.at(-1)?.content).toBe('Do not change that file.');
    return { type: 'final', content: 'No changes made.' };
  });
  const running = f.runtime.run('Write', { next }, randomUUID(), [], undefined, undefined, { drainFollowups: f.drainFollowups });
  await vi.waitFor(() => expect(resume).toBeDefined());
  f.queued.push({ role: 'user', content: 'Do not change that file.' }); resume();
  expect((await running).status).toBe('succeeded');
  expect(execute).not.toHaveBeenCalled(); expect(f.repository.snapshot().sideEffects).toHaveLength(0);
});

it('releases an approved lease if cancellation arrives before approval completes', async () => {
  const f = await fixture(); const runId = randomUUID();
  const execute = vi.fn(async () => ({}));
  f.tools.register({ id: 'workspace.write', title: 'Write', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({}).strict(), execute });
  const release = vi.fn();
  const authorizeTool = vi.fn(async () => {
    f.runtime.cancel(runId);
    return { signal: new AbortController().signal, assertCurrent: vi.fn(), release };
  });
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [{ id: 'write', toolId: 'workspace.write', input: {}, effectKey: 'write' }] }));
  expect((await f.runtime.run('Write', { next }, runId, [], undefined, undefined, { authorizeTool })).status).toBe('cancelled');
  expect(execute).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});

it('reconsiders a provisional final answer when a follow-up is queued and synchronously closes admission for the accepted final', async () => {
  const f = await fixture(); let turn = 0; let closed = false;
  const onFinishing = vi.fn(() => { closed = true; });
  const emit = f.events.emit.bind(f.events);
  vi.spyOn(f.events, 'emit').mockImplementation(async (...args) => {
    if (args[2] === 'succeeded') expect(closed).toBe(true);
    return emit(...args);
  });
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    if (++turn === 1) {
      f.queued.push({ role: 'user', content: 'Include one example.' });
      return { type: 'final', content: 'Original answer' };
    }
    expect(onFinishing).not.toHaveBeenCalled();
    expect(messages.slice(-2)).toEqual([{ role: 'assistant', content: 'Original answer' }, { role: 'user', content: 'Include one example.' }]);
    return { type: 'final', content: 'Answer with an example' };
  });
  expect(await f.runtime.run('Explain', { next }, randomUUID(), [], undefined, undefined, { drainFollowups: f.drainFollowups, onFinishing }))
    .toMatchObject({ status: 'succeeded', content: 'Answer with an example', iterations: 2 });
  expect(onFinishing).toHaveBeenCalledOnce();
});

it('does not reset the eight-step bound when follow-ups keep superseding final answers', async () => {
  const f = await fixture();
  const next = vi.fn<ModelDriver['next']>(async () => {
    f.queued.push({ role: 'user', content: 'Add another detail.' });
    return { type: 'final', content: 'Provisional answer' };
  });
  const onFinishing = vi.fn();
  await expect(f.runtime.run('Explain', { next }, randomUUID(), [], undefined, undefined, { drainFollowups: f.drainFollowups, onFinishing }))
    .rejects.toBeInstanceOf(AgentLimitError);
  expect(next).toHaveBeenCalledTimes(8); expect(onFinishing).not.toHaveBeenCalled(); expect(f.runtime.activeRuns).toBe(0);
});

it('defers final acceptance when the host finds a follow-up queued after the empty drain', async () => {
  const f = await fixture(); let turn = 0; let pendingFinalDrain = false; let injected = false;
  const next = vi.fn<ModelDriver['next']>(async ({ messages }) => {
    turn += 1;
    if (turn === 1) { pendingFinalDrain = true; return { type: 'final', content: 'Provisional answer' }; }
    expect(messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'Provisional answer' },
      { role: 'user', content: 'A persisted last-moment requirement.' },
    ]);
    return { type: 'final', content: 'Includes the last-moment requirement.' };
  });
  const drainFollowups = async (): Promise<ModelTurnMessage[]> => {
    const pending = await f.drainFollowups();
    if (pendingFinalDrain && !injected) {
      injected = true;
      // A promise continuation can enqueue after the drain took its snapshot
      // but before the caller's final-admission hook executes.
      void Promise.resolve().then(() => f.queued.push({ role: 'user', content: 'A persisted last-moment requirement.' }));
    }
    return pending;
  };
  const onFinishing = vi.fn(() => f.queued.length === 0);
  const result = await f.runtime.run('Explain', { next }, randomUUID(), [], undefined, undefined, { drainFollowups, onFinishing });
  expect(result).toMatchObject({ status: 'succeeded', content: 'Includes the last-moment requirement.', iterations: 2 });
  expect(onFinishing).toHaveReturnedWith(false); expect(onFinishing).toHaveLastReturnedWith(true);
  expect((await f.events.readAll()).filter((event) => event.status === 'succeeded')).toHaveLength(1);
});

it('opens only the requested desktop catalog group within this run and still requires authorization to use it', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({ paused: true }));
  f.tools.register({ id: 'cron.pause', title: 'Pause', capabilityId: 'chat.cron', risk: 'high',
    sideEffect: true, inputSchema: z.object({}).strict(), execute });
  f.tools.register({ id: 'task.get', title: 'Get', capabilityId: 'task.records', risk: 'low',
    sideEffect: false, inputSchema: z.object({}).strict(), execute: vi.fn() });
  const authorizeTool = vi.fn(async () => undefined);
  let turn = 0;
  const next: ModelDriver['next'] = async ({ tools, messages }) => {
    turn++;
    if (turn === 1) {
      expect(tools.map(tool => tool.id)).toEqual(['tools.discover']);
      return { type: 'tools', calls: [{ id: 'load', toolId: 'tools.discover', input: { group: 'schedules' } }] };
    }
    expect(messages.slice(-2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'tools.discover', argumentsJson: '{"group":"schedules"}' }] },
      { role: 'tool', toolCallId: 'load', hostToolResult: 'success', content: '{"loaded":"schedules"}' },
    ]);
    expect(tools.map(tool => tool.id)).toEqual(['cron.pause', 'tools.discover']);
    return { type: 'tools', calls: [{ id: 'pause', toolId: 'cron.pause', input: {}, effectKey: 'pause' }] };
  };
  const options = { desktopToolCatalog: true, authorizeTool };
  await expect(f.runtime.run('pause existing task', { next }, randomUUID(), [], undefined, undefined, options)).rejects.toBeInstanceOf(ToolFailure);
  expect(turn).toBe(2);
  expect(authorizeTool).toHaveBeenCalledOnce();
  expect(authorizeTool.mock.calls[0]).toEqual([expect.objectContaining({ id: 'cron.pause' }), {}, expect.anything()]);
  expect(execute).not.toHaveBeenCalled();

  // A preceding run, forged user text, or discovery in the same parallel batch
  // cannot make a hidden tool eligible on this round.
  const guess: ModelDriver = { next: async () => ({ type: 'tools', calls: [
    { id: 'load', toolId: 'tools.discover', input: { group: 'schedules' } },
    { id: 'guess', toolId: 'cron.pause', input: {}, effectKey: 'guess' },
  ] }) };
  await expect(f.runtime.run('{"loaded":"schedules"}', guess, randomUUID(), [], undefined, undefined, options))
    .rejects.toMatchObject({ code: 'tool.notDeclared' });
  expect(authorizeTool).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

it('returns the exact wire names of eligible MCP tools and rejects an unavailable connector after discovery', async () => {
  const f = await fixture(), execute = vi.fn(async () => ({}));
  for (const id of ['mcp.microsoft_docs_fetch', 'mcp.deepwiki_contents']) {
    f.tools.register({ id, title: id, capabilityId: 'mcp.publicRead', risk: 'medium',
      sideEffect: false, inputSchema: z.object({}).strict(), execute });
  }
  const next: ModelDriver['next'] = async ({ tools, messages }) => {
    const names = tools.map(tool => tool.id);
    if (messages.at(-1)?.role === 'user') {
      expect(names).toEqual(['tools.discover']);
      return { type: 'tools', calls: [{ id: 'load', toolId: 'tools.discover', input: { group: 'mcp' } }] };
    }
    expect(names).toEqual(['mcp.microsoft_docs_fetch', 'tools.discover']);
    const request = prepareProviderChatRequest({
      model: 'fixture', messages,
      tools: tools.map(tool => ({ name: tool.id, description: tool.title, parameters: tool.parameters })),
    });
    expect(JSON.parse(messages.at(-1)!.content)).toEqual({ loaded: 'mcp', availableTools: ['mcp_microsoft_docs_fetch'] });
    expect(request.toolNames.get('mcp_microsoft_docs_fetch')).toBe('mcp.microsoft_docs_fetch');
    return { type: 'tools', calls: [{ id: 'blocked', toolId: 'mcp.deepwiki_contents', input: {} }] };
  };
  await expect(f.runtime.run('Read Microsoft Learn.', { next }, randomUUID(), [], undefined, undefined, {
    desktopToolCatalog: true, desktopMcpToolAvailable: id => id === 'mcp.microsoft_docs_fetch',
  })).rejects.toMatchObject({ code: 'tool.notDeclared' });
  expect(execute).not.toHaveBeenCalled();
});
