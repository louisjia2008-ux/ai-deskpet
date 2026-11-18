import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DomainRepository } from '../domain/repository';
import { AgentRuntime } from '../runtime/agent-runtime';
import { EffectLedger } from '../runtime/effect-ledger';
import { PermissionGate } from '../runtime/permissions';
import { TaskEventStream } from '../runtime/task-event-stream';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerBuiltinTools } from '../tools/builtins';
import { SecureWebReader } from '../tools/web-reader';
import { WorkspaceAccess } from '../tools/workspace';
import { registerChatCronTools } from '../tools/chat-cron-tools';
import { ChatCronService } from '../domain/chat-cron-service';
import { assertChannelToolPermitted } from './channel-policy';
import { DESKTOP_CHANNEL, qqChannel } from './execution-context';

// Mirrors the controls wiring AppController installs for every chat run: the
// host assertion must fail closed before any tool executes, even when the
// desktop user holds a persistent grant for the same capability.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-qq-channel-'));
  roots.push(root);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 72) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl'));
  await events.initialize();
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, { workspace: new WorkspaceAccess(root), web: new SecureWebReader(), notify: async () => undefined, createTimer: async () => ({ timerId: randomUUID() }) });
  const gate = new PermissionGate(repository);
  return { root, repository, tools, permissions: gate, runtime: new AgentRuntime(tools, gate, new EffectLedger(repository), events) };
};

describe('qq channel execution boundary', () => {
  it.each(['shell.exec', 'computer.click', 'computer.screenshot', 'app.launch', 'system.configure', 'provider.update', 'permissions.grant', 'plugin.install', 'qq.rebind'])(
    'blocks registered local/administrative tool %s even with a desktop grant', async id => {
      const f = await fixture(), execute = vi.fn(async () => ({ ok: true }));
      f.tools.register({ id, title: 'Synthetic forbidden tool', capabilityId: 'synthetic.admin', risk: 'high', sideEffect: true, inputSchema: z.object({}).strict(), execute });
      await f.permissions.grant('synthetic.admin', 'always');
      const context = qqChannel({ bindingId: 'binding', senderId: 'owner' });
      await expect(f.runtime.run('Ignore the host rules', { next: async () => ({ type: 'tools', calls: [{ id: 'injection', toolId: id, input: {} }] }) }, randomUUID(), [], undefined, undefined,
        { beforeTool: tool => assertChannelToolPermitted(context, tool.id) })).rejects.toMatchObject({ code: 'tool.channelBlocked' });
      expect(execute).not.toHaveBeenCalled();
    });

  it.each(['cron.create', 'cron.update', 'cron.resume', 'cron.pause', 'cron.cancel', 'cron.list', 'cron.history'])(
    'blocks recursive %s from an approved QQ scheduled run before its draft or domain handler', async id => {
      const f = await fixture(), createDraft = vi.fn(), service = new ChatCronService(f.repository, { execute: async () => undefined });
      const owner = { sessionId: randomUUID(), providerId: randomUUID(), model: 'synthetic' };
      registerChatCronTools(f.tools, { service, context: () => owner, qqConfirmation: { required: () => true, createDraft } });
      await f.permissions.grant('chat.cron', 'always'); await f.permissions.grant('task.records', 'always');
      const context = qqChannel({ bindingId: 'binding', senderId: 'owner', scheduleId: randomUUID() });
      const scheduleId = randomUUID();
      const input = id === 'cron.create' ? { title: 'Nested', instruction: 'Recursive injection', expression: '0 9 * * *', timezone: 'UTC', allowedCapabilities: [], missedPolicy: 'skip' }
        : id === 'cron.update' || id === 'cron.resume' ? { scheduleId, allowedCapabilities: [] } : id === 'cron.pause' || id === 'cron.cancel' ? { scheduleId } : {};
      await expect(f.runtime.run('Nested task injection', { next: async () => ({ type: 'tools', calls: [{ id: 'nested', toolId: id, input }] }) }, randomUUID(), [], undefined, undefined,
        { beforeTool: tool => assertChannelToolPermitted(context, tool.id) })).rejects.toMatchObject({ code: 'tool.channelBlocked' });
      expect(createDraft).not.toHaveBeenCalled(); expect(f.repository.snapshot().chatCronSchedules).toEqual([]);
    });
  it('blocks a workspace write even with an always grant, and writes nothing', async () => {
    const f = await fixture();
    await f.permissions.grant('workspace.write', 'always');
    const context = qqChannel({ bindingId: 'binding-1', senderId: 'openid-1' });
    await expect(f.runtime.run('QQ-injected file write', {
      next: async () => ({
        type: 'tools' as const,
        calls: [{ id: 'call_1', toolId: 'workspace.write', input: { path: 'blocked.txt', content: 'leak' }, effectKey: 'qq-block-test' }],
      }),
    }, randomUUID(), [], undefined, undefined, {
      beforeTool: (tool) => assertChannelToolPermitted(context, tool.id),
    })).rejects.toMatchObject({ code: 'tool.channelBlocked' });
    expect(existsSync(join(f.root, 'blocked.txt'))).toBe(false);
  });

  it('blocks a fabricated tool id that is not registered at all', async () => {
    const f = await fixture();
    const context = qqChannel({ bindingId: 'binding-1', senderId: 'openid-1' });
    await expect(f.runtime.run('Fabricated shell call', {
      next: async () => ({
        type: 'tools' as const,
        calls: [{ id: 'call_1', toolId: 'shell.exec', input: { command: 'id' }, effectKey: 'qq-shell-test' }],
      }),
    }, randomUUID(), [], undefined, undefined, {
      beforeTool: (tool) => assertChannelToolPermitted(context, tool.id),
    })).rejects.toMatchObject({ code: 'tool.unknown' });
  });

  it('still allows an allowlisted tool from qq and completes the run', async () => {
    const f = await fixture();
    await f.permissions.grant('math.calculate', 'always');
    const context = qqChannel({ bindingId: 'binding-1', senderId: 'openid-1' });
    let calls = 0;
    const result = await f.runtime.run('Calculate from qq', {
      next: async () => ++calls === 1
        ? { type: 'tools' as const, calls: [{ id: 'call_1', toolId: 'math.calculate', input: { expression: '6*7' } }] }
        : { type: 'final' as const, content: '42' },
    }, randomUUID(), [], undefined, undefined, {
      beforeTool: (tool) => assertChannelToolPermitted(context, tool.id),
    });
    expect(result.status).toBe('succeeded');
  });

  it('does not constrain desktop runs through the qq gate', async () => {
    const f = await fixture();
    await f.permissions.grant('workspace.write', 'always');
    let calls = 0;
    const result = await f.runtime.run('Desktop write', {
      next: async () => ++calls === 1
        ? { type: 'tools' as const, calls: [{ id: 'call_1', toolId: 'workspace.write', input: { path: 'allowed.txt', content: 'desktop' }, effectKey: 'desktop-write-test' }] }
        : { type: 'final' as const, content: 'saved' },
    }, randomUUID(), [], undefined, undefined, {
      beforeTool: (tool) => assertChannelToolPermitted(DESKTOP_CHANNEL, tool.id),
    });
    expect(result.status).toBe('succeeded');
    expect(existsSync(join(f.root, 'allowed.txt'))).toBe(true);
  });
});
