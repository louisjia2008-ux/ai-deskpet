import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatWorkContext, ChatWorkTask } from '../../shared/chat-work';
import type { ChatWorkService } from '../domain/chat-work-service';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerChatWorkTools } from './chat-work-tools';

const fixture = () => {
  const sessionId = randomUUID(), runId = randomUUID();
  const task: ChatWorkTask = { id: randomUUID(), sessionId, runId, assistantMessageId: randomUUID(), goal: 'A'.repeat(600), privacy: 'cloud-allowed',
    status: 'running', plan: [], notes: '', nextStep: 'B'.repeat(600), summary: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    sources: [], artifacts: [], evidenceTruncated: false, historyLookupReferences: [] };
  const service = {
    current: vi.fn(() => task), update: vi.fn(async (_runId: string, _input: unknown, assertCurrent: () => void) => { assertCurrent(); return task; }),
    list: vi.fn(() => ({ items: [task], total: 1, nextOffset: null })), get: vi.fn(() => task),
    searchHistory: vi.fn((_context: ChatWorkContext, _input: unknown) => { void _context; void _input; return { items: [], total: 0, nextOffset: null, privacy: 'cloud-allowed' }; }), readHistory: vi.fn(() => null),
  };
  let owner: ChatWorkContext | null = { sessionId, destination: 'remote' };
  const context = vi.fn(() => owner), registry = new ToolRegistry();
  registerChatWorkTools(registry, { service: service as unknown as ChatWorkService, context });
  const controller = new AbortController(), assertAuthorized = vi.fn();
  const toolContext = { runId, taskId: randomUUID(), signal: controller.signal, assertAuthorized };
  const execute = (id: string, input: unknown = {}) => registry.get(id).execute(input, toolContext);
  return { registry, service, execute, task, context, toolContext, controller, assertAuthorized, owner: (value: ChatWorkContext | null) => { owner = value; } };
};

describe('host-bound task and history tools', () => {
  it('describes bounded record capabilities without model-controlled owners or permission fields', () => {
    const f = fixture(), definitions = f.registry.describe();
    expect(definitions.map((tool) => [tool.id, tool.capabilityId, tool.sideEffect])).toEqual([
      ['task.update', 'task.records', true], ['task.list', 'task.records', false], ['task.get', 'task.records', false],
      ['history.search', 'history.read', false], ['history.read', 'history.read', false],
    ]);
    for (const definition of definitions) {
      expect(definition.parameters.additionalProperties).toBe(false);
      expect(definition.parameters.properties).not.toHaveProperty('sessionId');
      expect(definition.parameters.properties).not.toHaveProperty('destination');
      expect(definition.parameters.properties).not.toHaveProperty('approved');
    }
  });

  it('derives the task owner and provider destination from the host binding and bounds summary fields', async () => {
    const f = fixture(), result = await f.execute('task.list', { limit: 2 }) as { items: Array<Record<string, unknown>> };
    expect(f.service.list).toHaveBeenCalledWith(f.task.sessionId, { limit: 2, destination: 'remote' });
    expect(result.items[0]).toMatchObject({ goal: 'A'.repeat(300), nextStep: 'B'.repeat(300), sourceCount: 0, artifactCount: 0 });
    expect(result.items[0]).not.toHaveProperty('notes'); expect(result.items[0]).not.toHaveProperty('historyLookupReferences');
    await f.execute('task.get', { id: f.task.id }); expect(f.service.get).toHaveBeenCalledWith(f.task.sessionId, f.task.id, 'remote');
    await f.execute('history.search', { query: 'needle', targetSessionId: randomUUID() });
    expect(f.service.searchHistory.mock.calls[0]?.[0]).toEqual({ sessionId: f.task.sessionId, destination: 'remote' });
  });

  it.each([
    ['task.update', { plan: ['one'], status: 'completed' }], ['task.list', { destination: 'local' }], ['task.get', { id: randomUUID(), sessionId: randomUUID() }],
    ['history.search', { query: 'needle', sessionId: randomUUID() }], ['history.read', { messageId: randomUUID(), maxCharacters: 100_000 }],
  ])('rejects spoofed or unbounded arguments for %s', async (tool, input) => {
    const f = fixture(); await expect(f.execute(tool, input)).rejects.toThrow();
    expect(f.service.update).not.toHaveBeenCalled(); expect(f.service.list).not.toHaveBeenCalled(); expect(f.service.get).not.toHaveBeenCalled();
    expect(f.service.searchHistory).not.toHaveBeenCalled(); expect(f.service.readHistory).not.toHaveBeenCalled();
  });

  it('refuses absent run ownership, abort and revoked authorization before data access', async () => {
    const f = fixture(); f.owner(null); await expect(f.execute('task.list')).rejects.toThrow('chatWork.unavailable');
    f.owner({ sessionId: f.task.sessionId, destination: 'remote' });
    f.assertAuthorized.mockImplementation(() => { throw new Error('permission revoked'); });
    await expect(f.execute('history.search', { query: 'needle' })).rejects.toThrow('permission revoked');
    f.assertAuthorized.mockReset(); f.controller.abort(); await expect(f.execute('task.get', { id: f.task.id })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.service.list).not.toHaveBeenCalled(); expect(f.service.searchHistory).not.toHaveBeenCalled(); expect(f.service.get).not.toHaveBeenCalled();
  });

  it('rejects a task update when the run record belongs to another conversation', async () => {
    const f = fixture(); f.service.current.mockReturnValue({ ...f.task, sessionId: randomUUID() });
    await expect(f.execute('task.update', { notes: 'Wrong owner.' })).rejects.toThrow('chatWork.unavailable');
    expect(f.service.update).not.toHaveBeenCalled();
  });

  it('rechecks the current host binding after a read and before a queued update commits', async () => {
    const f = fixture();
    f.service.list.mockImplementation(() => { f.owner({ sessionId: f.task.sessionId, destination: 'local' }); return { items: [f.task], total: 1, nextOffset: null }; });
    await expect(f.execute('task.list')).rejects.toThrow('chatWork.unavailable');
    f.owner({ sessionId: f.task.sessionId, destination: 'remote' });
    f.service.update.mockImplementation(async (_runId, _input, assertCurrent) => { f.owner(null); assertCurrent(); return f.task; });
    await expect(f.execute('task.update', { nextStep: 'Revoked while queued.' })).rejects.toThrow('chatWork.unavailable');
  });
});
