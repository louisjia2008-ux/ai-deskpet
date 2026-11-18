// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainRepository } from '../domain';
import { EffectLedger } from './effect-ledger';
import { PermissionGate } from './permissions';
import { ToolRegistry } from './tool-registry';
import { TaskEventStream } from './task-event-stream';
import { AgentRuntime } from './agent-runtime';
import type { AgentRunProgress } from './agent-runtime';
import { ToolFailure, classifyToolFailure } from './tool-failure';
import { toolFailureCode } from '../../shared/tool-failures';

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-tool-regression-')); roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 8) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl')); await events.initialize();
  return { repository, events, ledger: new EffectLedger(repository) };
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('reports tool progress before execution and resumes model progress only after the result is ready', async () => {
  const { repository, events, ledger } = await fixture();
  const permissions = new PermissionGate(repository); await permissions.grant('web.read', 'session');
  const tools = new ToolRegistry();
  const progress: AgentRunProgress[] = [];
  let finishRead: (() => void) | undefined;
  tools.register({ id: 'web.read', title: 'Read', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({}).strict(), execute: () => new Promise((resolve) => {
      expect(progress.at(-1)).toEqual({ type: 'tool', toolId: 'web.read' });
      finishRead = () => resolve({ text: 'Page body' });
    }) });
  const runtime = new AgentRuntime(tools, permissions, ledger, events);
  let turn = 0;
  const running = runtime.run('read', { next: async ({ messages }) => {
    if (turn++ === 0) return { type: 'tools', calls: [{ id: 'read', toolId: 'web.read', input: {} }] };
    expect(messages.at(-1)?.content).toContain('Page body');
    return { type: 'final', content: 'Read the page.' };
  } }, randomUUID(), [], undefined, (value) => progress.push(value));
  await vi.waitFor(() => expect(finishRead).toBeDefined());
  expect(progress).toEqual([{ type: 'model', iteration: 1 }, { type: 'tool', toolId: 'web.read' }]);
  finishRead?.();
  expect((await running).status).toBe('succeeded');
  expect(progress.at(-1)).toEqual({ type: 'model', iteration: 2 });
});

it('deduplicates concurrent retries and persisted retries while keeping independent actions separate', async () => {
  const { repository, ledger } = await fixture(); const runId = randomUUID();
  const operation = vi.fn(async () => ({ timerId: randomUUID() }));
  const result = await Promise.all([
    ledger.execute('message-a:0:0', runId, 'timer.create', { label: 'water', seconds: 60 }, operation),
    ledger.execute('message-a:0:0', runId, 'timer.create', { seconds: 60, label: 'water' }, operation),
  ]);
  expect(result[0]).toEqual(result[1]); expect(operation).toHaveBeenCalledOnce();
  expect(await new EffectLedger(repository).execute('message-a:0:0', randomUUID(), 'timer.create', { seconds: 60, label: 'water' }, operation)).toEqual(result[0]);
  await ledger.execute('message-b:0:0', randomUUID(), 'timer.create', { seconds: 60, label: 'water' }, operation);
  expect(operation).toHaveBeenCalledTimes(2);
});

it('rejects reused execution identity with changed input, changed tools or unverifiable legacy records', async () => {
  const { ledger } = await fixture(); const operation = vi.fn(async () => ({ written: true }));
  await ledger.execute('same-action', randomUUID(), 'workspace.write', { path: 'a.txt', content: 'one' }, operation);
  await expect(ledger.execute('same-action', randomUUID(), 'workspace.write', { path: 'a.txt', content: 'two' }, operation)).rejects.toMatchObject({ code: 'tool.effectConflict' });
  await expect(ledger.execute('same-action', randomUUID(), 'timer.create', { path: 'a.txt', content: 'one' }, operation)).rejects.toMatchObject({ code: 'tool.effectConflict' });
  await ledger.record({ key: 'legacy', runId: randomUUID(), toolId: 'workspace.write', completedAt: new Date().toISOString(), output: {} });
  await expect(ledger.execute('legacy', randomUUID(), 'workspace.write', {}, operation)).rejects.toMatchObject({ code: 'tool.effectConflict' });
  expect(operation).toHaveBeenCalledOnce();
});

it.each([
  ['denied', 'timer.create', { seconds: 60 }, 'tool.permission.timer.write'],
  ['unknown', 'not-registered', {}, 'tool.unknown'],
] as const)('returns a specific safe failure for %s without executing', async (_kind, toolId, input, code) => {
  const { repository, events, ledger } = await fixture(); const tools = new ToolRegistry();
  const execute = vi.fn(async () => ({}));
  tools.register({ id: 'timer.create', title: 'Timer', capabilityId: 'timer.write', risk: 'medium', sideEffect: true, inputSchema: z.object({ seconds: z.number() }).strict(), execute });
  const runtime = new AgentRuntime(tools, new PermissionGate(repository), ledger, events);
  const progress: AgentRunProgress[] = [];
  await expect(runtime.run('test', { next: async () => ({ type: 'tools', calls: [{ id: 'call_1', toolId, input, effectKey: 'test' }] }) }, randomUUID(), [], undefined, (value) => progress.push(value))).rejects.toMatchObject({ code });
  expect(execute).not.toHaveBeenCalled();
  expect(progress).toEqual([{ type: 'model', iteration: 1 }]);
});

it('classifies tool errors without exposing raw paths, URLs or exception bodies', () => {
  expect(classifyToolFailure(Object.assign(new Error('private request details'), { code: 'ENOTFOUND' }), 'web.read')).toMatchObject({ code: 'tool.network', message: 'tool.network' });
  expect(classifyToolFailure(new DOMException('deadline', 'TimeoutError'), 'web.read')).toMatchObject({ code: 'tool.timeout' });
  expect(classifyToolFailure(Object.assign(new Error('/private/path'), { code: 'ENOENT' }), 'workspace.read')).toMatchObject({ code: 'tool.fileMissing' });
  expect(classifyToolFailure(new RangeError('bad time zone'), 'time.current')).toMatchObject({ code: 'tool.invalidArguments' });
  expect(toolFailureCode(new ToolFailure('tool.network'))).toBe('tool.network');
  expect(toolFailureCode({ code: 'arbitrary upstream details' })).toBeUndefined();
});
