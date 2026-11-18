// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DomainRepository } from '../domain';
import type { ProviderResponseItem } from '../providers/types';
import { QqWebBudget } from '../security/channel-policy';
import { AgentLimitError, AgentRuntime } from './agent-runtime';
import type { AgentRunControls, ModelDriver, ToolCall } from './agent-runtime';
import { EffectLedger } from './effect-ledger';
import { PermissionGate } from './permissions';
import { TaskEventStream } from './task-event-stream';
import { ToolFailure } from './tool-failure';
import { ToolRegistry } from './tool-registry';
import type { ToolDefinition } from './tool-registry';

const roots: string[] = [];
const sourceUrl = (id: number): string => `https://sources.example.test/page-${id}`;
const readCall = (id: number): ToolCall => ({ id: `read-${id}`, toolId: 'web.read', input: { url: sourceUrl(id) } });

const fixture = async (limit = 2) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-web-budget-runtime-'));
  roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 39) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl'));
  await events.initialize();
  const tools = new ToolRegistry();
  const permissions = new PermissionGate(repository);
  await permissions.grant('web.read', 'session');
  await permissions.grant('web.search', 'session');
  const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repository), events);
  const budget = new QqWebBudget();
  const beforeTool = vi.fn();
  const controls = (runId: string, wrapUpOnLimit = true): AgentRunControls => ({
    wrapUpOnLimit,
    beforeTool,
    onToolExecuting: (tool) => {
      if (!budget.consume(runId, tool.id, limit)) throw new ToolFailure('tool.webBudgetExceeded');
    },
  });
  const registerRead = (execute: ToolDefinition['execute']): void => tools.register({
    id: 'web.read', title: 'Read a public page', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.string().url() }).strict(), execute,
  });
  return { repository, events, tools, runtime, budget, permissions, beforeTool, controls, registerRead };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('stops a four-call batch after two actual reads and preserves the full tool protocol for one tool-free report', async () => {
  const f = await fixture(2);
  const execute = vi.fn<ToolDefinition['execute']>(async (input, context) => {
    for (let check = 0; check < 8; check += 1) context.assertAuthorized?.();
    return { url: (input as { url: string }).url, text: 'Verified fixture page content.' };
  });
  f.registerRead(execute);
  const calls = [1, 2, 3, 4].map(readCall);
  const responseItems: ProviderResponseItem[] = [
    { type: 'reasoning', id: 'budget-reasoning', summary: [], encrypted_content: 'opaque-budget-reasoning' },
    ...calls.map(call => ({ type: 'function_call' as const, call_id: call.id, name: call.toolId, arguments: JSON.stringify(call.input) })),
  ];
  const receipt = vi.fn(async () => undefined);
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ tools, messages, wrapUp }) => {
    if (++turn === 1) return { type: 'tools', calls, responseItems };
    expect(wrapUp).toBe(true);
    expect(tools).toEqual([]);
    const assistant = messages.find(message => message.role === 'assistant' && message.toolCalls);
    expect(assistant?.responseItems).toEqual(responseItems);
    expect(assistant?.toolCalls?.map(call => call.id)).toEqual(calls.map(call => call.id));
    const results = messages.filter(message => message.role === 'tool');
    expect(results.map(message => message.toolCallId)).toEqual(calls.map(call => call.id));
    expect(results.map(message => message.hostToolResult)).toEqual(['success', 'success', 'safe-error', 'skipped']);
    expect(JSON.parse(results[2]!.content)).toMatchObject({ ok: false, error: { code: 'tool.webBudgetExceeded', retryable: false } });
    expect(JSON.parse(results[3]!.content)).toMatchObject({ ok: false, skipped: true, error: { retryable: false } });
    expect(results.filter(message => message.hostToolResult === 'success').map(message => JSON.parse(message.content).url))
      .toEqual([sourceUrl(1), sourceUrl(2)]);
    return { type: 'final', content: 'Only two pages were verified. The web-call limit prevented the remaining comparison.' };
  });

  const runId = randomUUID();
  const result = await f.runtime.run('Compare four public pages.', { next }, runId, [], receipt, undefined, f.controls(runId));

  expect(result).toMatchObject({ status: 'succeeded', limitReached: true, webBudgetExceeded: true });
  expect(next).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.map(([input]) => input)).toEqual([calls[0]!.input, calls[1]!.input]);
  expect(f.beforeTool.mock.calls.length).toBeGreaterThan(16);
  expect(receipt).toHaveBeenCalledTimes(2);
  expect(receipt.mock.calls).toEqual([
    ['web.read', { url: sourceUrl(1), text: 'Verified fixture page content.' }, calls[0]!.input],
    ['web.read', { url: sourceUrl(2), text: 'Verified fixture page content.' }, calls[1]!.input],
  ]);
  expect((await f.events.readAll()).some(event => event.type === 'error' && event.summary === 'tool.channelBlocked')).toBe(false);
  expect(f.runtime.activeRuns).toBe(0);
});

it('charges a failed read and a later search to the same budget without fabricating a successful page receipt', async () => {
  const f = await fixture(2);
  const read = vi.fn<ToolDefinition['execute']>(async () => { throw new ToolFailure('tool.network'); });
  const search = vi.fn(async () => ({ results: [{ url: sourceUrl(9), snippet: 'Unverified search snippet.' }] }));
  f.registerRead(read);
  f.tools.register({
    id: 'web.search', title: 'Search', capabilityId: 'web.search', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ query: z.string() }).strict(), execute: search,
  });
  const receipt = vi.fn(async () => undefined);
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ tools, messages, wrapUp }) => {
    turn += 1;
    if (turn === 1) return { type: 'tools', calls: [readCall(1)] };
    if (turn === 2) {
      expect(wrapUp).not.toBe(true);
      expect(messages.at(-1)?.hostToolResult).toBe('safe-error');
      expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({ ok: false, error: { code: 'tool.network' } });
      return { type: 'tools', calls: [
        { id: 'search-after-failure', toolId: 'web.search', input: { query: 'public comparison' } },
        readCall(2), readCall(3),
      ] };
    }
    expect(wrapUp).toBe(true);
    expect(tools).toEqual([]);
    const results = messages.filter(message => message.role === 'tool');
    expect(results.map(message => message.toolCallId)).toEqual(['read-1', 'search-after-failure', 'read-2', 'read-3']);
    expect(results.map(message => message.hostToolResult)).toEqual(['safe-error', 'success', 'safe-error', 'skipped']);
    expect(JSON.parse(results[2]!.content)).toMatchObject({ error: { code: 'tool.webBudgetExceeded', retryable: false } });
    return { type: 'final', content: 'No page was verified. Only a search snippet is available; the comparison remains incomplete.' };
  });
  const runId = randomUUID();
  const result = await f.runtime.run('Research a comparison.', { next }, runId, [], receipt, undefined, f.controls(runId));

  expect(result).toMatchObject({ status: 'succeeded', limitReached: true, webBudgetExceeded: true });
  expect(next).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledOnce();
  expect(receipt).toHaveBeenCalledExactlyOnceWith('web.search', { results: [{ url: sourceUrl(9), snippet: 'Unverified search snippet.' }] }, { query: 'public comparison' });
});

it('gives a subsequent run its own allowance after the previous run exhausted the shared counter', async () => {
  const f = await fixture(1);
  const execute = vi.fn(async () => ({ text: 'Read succeeded.' }));
  f.registerRead(execute);
  const firstRun = randomUUID();
  const first = await f.runtime.run('First run.', { next: async ({ wrapUp }) => wrapUp
    ? { type: 'final', content: 'The first run reached its web limit.' }
    : { type: 'tools', calls: [readCall(1), readCall(2)] } }, firstRun, [], undefined, undefined, f.controls(firstRun));
  expect(first).toMatchObject({ webBudgetExceeded: true, limitReached: true });

  const secondRun = randomUUID();
  let turn = 0;
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp }) => {
    expect(wrapUp).not.toBe(true);
    return ++turn === 1 ? { type: 'tools', calls: [readCall(3)] } : { type: 'final', content: 'The second run completed its one requested read.' };
  });
  const second = await f.runtime.run('Read one new page.', { next }, secondRun, [], undefined, undefined, f.controls(secondRun));

  expect(second.status).toBe('succeeded');
  expect(second.limitReached).toBeUndefined();
  expect(second.webBudgetExceeded).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(next).toHaveBeenCalledTimes(2);
});

it('never executes a tool requested by the model during the tool-free budget report', async () => {
  const f = await fixture(1);
  const execute = vi.fn(async () => ({ text: 'Only this page was read.' }));
  f.registerRead(execute);
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp, tools }) => {
    if (wrapUp) {
      expect(tools).toEqual([]);
      return { type: 'tools', calls: [readCall(99)] };
    }
    return { type: 'tools', calls: [readCall(1), readCall(2)] };
  });
  const runId = randomUUID();
  await expect(f.runtime.run('Research.', { next }, runId, [], undefined, undefined, f.controls(runId)))
    .rejects.toBeInstanceOf(AgentLimitError);
  expect(execute).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledTimes(2);
  expect(f.runtime.activeRuns).toBe(0);
});

it('keeps scheduled runs fatal at the web limit without spending an extra model call', async () => {
  const f = await fixture(1);
  const execute = vi.fn(async () => ({ text: 'Read before the limit.' }));
  f.registerRead(execute);
  const next = vi.fn<ModelDriver['next']>(async ({ wrapUp }) => {
    expect(wrapUp).not.toBe(true);
    return { type: 'tools', calls: [readCall(1), readCall(2), readCall(3)] };
  });
  const runId = randomUUID();
  await expect(f.runtime.run('Scheduled research.', { next }, runId, [], undefined, undefined, f.controls(runId, false)))
    .rejects.toMatchObject({ code: 'tool.webBudgetExceeded' });
  expect(execute).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledOnce();
  expect(f.runtime.activeRuns).toBe(0);
});

it('does not reinterpret a real channel denial as recoverable budget exhaustion', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({ text: 'Must never execute.' }));
  f.registerRead(execute);
  const next = vi.fn<ModelDriver['next']>(async () => ({ type: 'tools', calls: [readCall(1)] }));
  await expect(f.runtime.run('Blocked action.', { next }, randomUUID(), [], undefined, undefined, {
    wrapUpOnLimit: true,
    onToolExecuting: () => { throw new ToolFailure('tool.channelBlocked'); },
  })).rejects.toMatchObject({ code: 'tool.channelBlocked' });
  expect(execute).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  expect(f.runtime.activeRuns).toBe(0);
});

it('waits for owner consent before resuming the same tool call and does not replay completed reads', async () => {
  const f = await fixture(1);
  const executed: string[] = [];
  f.registerRead(async input => { executed.push((input as {url:string}).url); return {text:'Verified'}; });
  let allow!: () => void, waiting!: () => void;
  const consent = new Promise<void>(resolve => {allow = resolve;});
  const paused = new Promise<void>(resolve => {waiting = resolve;});
  const runId = randomUUID(); let limit = 1, turns = 0;
  const run = f.runtime.run('Research.', {next:async () => ++turns === 1
    ? {type:'tools',calls:[readCall(1),readCall(2),readCall(3)]}
    : {type:'final',content:'All three sources read.'}}, runId, [], undefined, undefined, {
    wrapUpOnLimit:true,
    onToolExecuting:async tool => {
      if (f.budget.consume(runId,tool.id,limit)) return;
      waiting(); await consent; limit += 20;
      expect(f.budget.consume(runId,tool.id,limit)).toBe(true);
    },
  });
  await paused;
  expect(executed).toEqual([sourceUrl(1)]); expect(turns).toBe(1);
  allow();
  expect(await run).toMatchObject({status:'succeeded',content:'All three sources read.'});
  expect(executed).toEqual([sourceUrl(1),sourceUrl(2),sourceUrl(3)]); expect(turns).toBe(2);
});

it('rechecks a revoked lease after an asynchronous owner-budget wait', async () => {
  const f = await fixture(); const execute = vi.fn(async () => ({text:'Must not read'}));
  f.registerRead(execute);
  let allow!: () => void, waiting!: () => void;
  const consent = new Promise<void>(resolve => {allow = resolve;});
  const paused = new Promise<void>(resolve => {waiting = resolve;});
  const run = f.runtime.run('Research.', {next:async () => ({type:'tools',calls:[readCall(1)]})},randomUUID(),[],undefined,undefined,{
    wrapUpOnLimit:true,onToolExecuting:async () => {waiting(); await consent;},
  });
  const failed = expect(run).rejects.toMatchObject({code:'tool.permission.web.read'});
  await paused; await f.permissions.revoke('web.read'); allow();
  await failed; expect(execute).not.toHaveBeenCalled(); expect(f.runtime.activeRuns).toBe(0);
});
