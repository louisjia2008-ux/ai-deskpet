// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatCronBinding, ChatCronInput, ChatCronState, ChatCronStore } from '../../shared/chat-cron';
import { ChatCronService } from '../domain/chat-cron-service';
import { ToolRegistry, type ToolContext } from '../runtime/tool-registry';
import { registerChatCronTools } from './chat-cron-tools';

const fixture = (qq = false) => {
  const owner: ChatCronBinding = { sessionId: randomUUID(), providerId: randomUUID(), model: 'synthetic' }, other = { ...owner, sessionId: randomUUID() };
  let state: ChatCronState = { chatSessions: [{ id: owner.sessionId }, { id: other.sessionId }], chatCronSchedules: [], chatCronRuns: [] };
  let queue: Promise<unknown> = Promise.resolve();
  const store: ChatCronStore = {
    snapshot: () => structuredClone(state),
    transaction: <T>(mutation: (draft: ChatCronState) => T | Promise<T>): Promise<T> => {
      const work = queue.then(async () => { const draft = structuredClone(state), result = await mutation(draft); state = draft; return structuredClone(result); });
      queue = work.catch(() => undefined); return work;
    },
  };
  const service = new ChatCronService(store, { now: () => Date.parse('2026-11-02T08:00:00Z'), execute: async () => undefined });
  const context = vi.fn<(runId: string) => ChatCronBinding | null>(() => owner), registry = new ToolRegistry();
  const createDraft = vi.fn(async () => ({ pending: true as const, expiresAt: '2026-11-02T08:05:00.000Z' }));
  registerChatCronTools(registry, { service, context, ...(qq ? { qqConfirmation: { required: () => true, createDraft } } : {}) });
  const toolContext: ToolContext = { runId: randomUUID(), taskId: 'call-1', signal: new AbortController().signal, assertAuthorized: vi.fn() };
  const body: ChatCronInput = { title: 'Synthetic task', instruction: 'Search public material', expression: '0 9 * * *', timezone: 'UTC', allowedCapabilities: ['web.search'], missedPolicy: 'skip' };
  const call = async (id: string, input: unknown, control = toolContext): Promise<unknown> => {
    const tool = registry.get(id); return tool.execute(tool.inputSchema.parse(input), control);
  };
  return { owner, other, service, store, context, registry, toolContext, body, call, createDraft };
};

describe('host-bound cron tools', () => {
  it('routes QQ create/update/resume only to host drafts, never directly into the domain', async () => {
    const f = fixture(true), scheduleId = randomUUID();
    for (const [action, input] of [['create', f.body], ['update', { scheduleId, title: 'Changed', allowedCapabilities: [] }],
      ['resume', { scheduleId, allowedCapabilities: ['web.search'] }]] as const) {
      expect(await f.call(`cron.${action}`, input)).toMatchObject({ pending: true });
      expect(f.createDraft).toHaveBeenLastCalledWith(f.toolContext.runId, action, input);
    }
    expect(f.service.list(f.owner.sessionId)).toEqual([]); expect(f.toolContext.assertAuthorized).toHaveBeenCalledTimes(3);
    const unauthorized = { runId: f.toolContext.runId, taskId: 'missing-lease', signal: f.toolContext.signal };
    await expect(f.call('cron.create', f.body, unauthorized)).rejects.toThrow('cron.authorizationRequired');
    expect(f.createDraft).toHaveBeenCalledTimes(3);
  });
  it('publishes strict bounded schemas and marks every mutation as a high-risk approval', () => {
    const f = fixture(), descriptors = f.registry.describe(); expect(descriptors).toHaveLength(7);
    for (const id of ['cron.create', 'cron.update', 'cron.pause', 'cron.resume', 'cron.cancel']) {
      expect(descriptors.find((tool) => tool.id === id)).toMatchObject({ capabilityId: 'chat.cron', risk: 'high', sideEffect: true });
    }
    expect(f.registry.get('cron.create').inputSchema.safeParse({ ...f.body, sessionId: f.other.sessionId }).success).toBe(false);
    expect(f.registry.get('cron.create').inputSchema.safeParse({ ...f.body, providerId: f.other.providerId }).success).toBe(false);
    expect(f.registry.get('cron.create').inputSchema.safeParse({ ...f.body, allowedCapabilities: ['workspace.read'] }).success).toBe(false);
    expect(f.registry.get('cron.create').inputSchema.safeParse({ ...f.body, allowedCapabilities: ['web.search', 'web.search'] }).success).toBe(false);
    expect(f.registry.get('cron.update').inputSchema.safeParse({ scheduleId: randomUUID(), title: 'New title' }).success).toBe(false);
  });
  it('captures the host conversation/provider and deduplicates only the same runtime call', async () => {
    const f = fixture(); const first = await f.call('cron.create', f.body);
    expect(first).toMatchObject(f.owner); expect(await f.call('cron.create', f.body)).toEqual(first);
    await f.call('cron.create', { ...f.body, title: 'Another schedule' }, { ...f.toolContext, taskId: 'call-2' });
    expect(f.service.list(f.owner.sessionId)).toHaveLength(2); expect(f.toolContext.assertAuthorized).toHaveBeenCalledTimes(6);
  });
  it('refuses missing host authorization, missing run binding and aborted operations', async () => {
    const f = fixture(), unauthorized: ToolContext = { runId: f.toolContext.runId, taskId: f.toolContext.taskId, signal: f.toolContext.signal };
    await expect(f.call('cron.create', f.body, unauthorized)).rejects.toThrow('cron.authorizationRequired');
    f.context.mockReturnValue(null); await expect(f.call('cron.create', f.body)).rejects.toThrow('cron.chatContextRequired');
    f.context.mockReturnValue(f.owner); const controller = new AbortController(); controller.abort();
    await expect(f.call('cron.create', f.body, { ...f.toolContext, signal: controller.signal })).rejects.toThrow();
    expect(f.service.list(f.owner.sessionId)).toEqual([]);
  });
  it('rechecks run binding when a mutation waits behind another transaction', async () => {
    const f = fixture(); let release!: () => void;
    const blocker = f.store.transaction(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const creation = f.call('cron.create', f.body); f.context.mockReturnValue(f.other); release(); await blocker;
    await expect(creation).rejects.toThrow('cron.chatContextRequired'); expect(f.service.list(f.owner.sessionId)).toEqual([]);
  });
  it('requires reviewed capabilities to match the schedule on resume', async () => {
    const f = fixture(), created = await f.service.create(f.owner, f.body, () => undefined); await f.service.pause(f.owner.sessionId, created.id, () => undefined);
    await expect(f.call('cron.resume', { scheduleId: created.id, allowedCapabilities: [] })).rejects.toThrow('cron.scopeChanged');
    expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(false);
    await f.call('cron.resume', { scheduleId: created.id, allowedCapabilities: ['web.search'] }); expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(true);
  });
  it('rejects resume if scope changes while its approved mutation is queued', async () => {
    const f = fixture(), created = await f.service.create(f.owner, f.body, () => undefined); await f.service.pause(f.owner.sessionId, created.id, () => undefined);
    let release!: () => void;
    const blocker = f.store.transaction(async (state) => { await new Promise<void>((resolve) => { release = resolve; }); state.chatCronSchedules[0]!.allowedCapabilities = ['workspace.write']; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const resume = f.call('cron.resume', { scheduleId: created.id, allowedCapabilities: ['web.search'] }); release(); await blocker;
    await expect(resume).rejects.toThrow('cron.scopeChanged'); expect(f.service.list(f.owner.sessionId)[0]?.enabled).toBe(false);
  });
  it('returns bounded same-session list pages and refuses foreign management/history', async () => {
    const f = fixture();
    for (let index = 0; index < 3; index++) await f.service.create(f.owner, { ...f.body, title: `Task ${index}`, instruction: 'x'.repeat(600) }, () => undefined);
    const foreign = await f.service.create(f.other, f.body, () => undefined);
    const first = await f.call('cron.list', { limit: 2 }) as { schedules: Array<{ instruction: string; instructionTruncated: boolean }>; total: number; nextOffset: number | null };
    expect(first.total).toBe(3); expect(first.nextOffset).toBe(2); expect(first.schedules).toHaveLength(2);
    expect(first.schedules[0]?.instruction).toHaveLength(500); expect(first.schedules[0]?.instructionTruncated).toBe(true);
    expect(await f.call('cron.list', { offset: 2, limit: 2 })).toMatchObject({ total: 3, nextOffset: null });
    await expect(f.call('cron.cancel', { scheduleId: foreign.id })).rejects.toThrow('cron.notFound');
    await expect(f.call('cron.history', { scheduleId: foreign.id })).rejects.toThrow('cron.notFound');
    expect(await f.call('cron.history', {})).toEqual({ runs: [], total: 0, truncated: false });
  });
  it('checks authorization again on update, pause and cancel', async () => {
    const f = fixture(), created = await f.service.create(f.owner, f.body, () => undefined);
    await f.call('cron.update', { scheduleId: created.id, instruction: 'New public task', allowedCapabilities: ['time.read'] });
    await f.call('cron.pause', { scheduleId: created.id }); await f.call('cron.cancel', { scheduleId: created.id });
    expect(f.toolContext.assertAuthorized).toHaveBeenCalledTimes(6);
    expect(f.service.list(f.owner.sessionId)[0]).toMatchObject({ enabled: false, instruction: 'New public task', allowedCapabilities: ['time.read'] });
  });
});
