// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { initialMinecraftCompanionSnapshot } from '../../shared/minecraft-companion';
import type { MinecraftCompanionConfig, MinecraftCompanionSnapshot } from '../../shared/minecraft-companion';
import type { ToolContext } from '../runtime/tool-registry';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerMinecraftCompanionTools } from './minecraft-companion-tools';
import type { MinecraftCompanionToolService } from './minecraft-companion-tools';

const config: MinecraftCompanionConfig = { host: '127.0.0.1', port: 25565, username: 'Companion', auth: 'offline', version: 'auto' };
const task = { name: 'gatherLogs', parameters: { count: 8 } } as const;
const ids = ['minecraft.connect', 'minecraft.start', 'minecraft.status', 'minecraft.policy', 'minecraft.cancel', 'minecraft.disconnect'];
const inputs: Record<string, unknown> = { 'minecraft.connect': config, 'minecraft.start': task, 'minecraft.policy': { risk: 'cautious' } };

const fixture = () => {
  const state = initialMinecraftCompanionSnapshot();
  const service = {
    getState: vi.fn<MinecraftCompanionToolService['getState']>(() => state),
    connect: vi.fn<MinecraftCompanionToolService['connect']>(async () => state),
    start: vi.fn<MinecraftCompanionToolService['start']>(async () => state),
    cancel: vi.fn<MinecraftCompanionToolService['cancel']>(async () => state),
    disconnect: vi.fn<MinecraftCompanionToolService['disconnect']>(async () => state),
    setPolicy: vi.fn<MinecraftCompanionToolService['setPolicy']>(async () => ({ risk: 'cautious', guard: 'self_first' })),
  };
  const registry = new ToolRegistry(), isDesktop = vi.fn(() => true);
  const controller = new AbortController(), assertAuthorized = vi.fn();
  const context: ToolContext = { runId: 'desktop-run', taskId: 'tool-call', signal: controller.signal, assertAuthorized };
  registerMinecraftCompanionTools(registry, { service, isDesktop });
  const invoke = (id: string, input: unknown = inputs[id] ?? {}) => registry.get(id).execute(input, context);
  return { registry, service, state, isDesktop, controller, assertAuthorized, invoke };
};

it('declares only the six fixed tools with separate connection, control and read permissions', () => {
  const f = fixture(), tools = f.registry.describe();
  expect(tools.map(tool => tool.id)).toEqual(ids);
  expect(tools.map(tool => [tool.id, tool.capabilityId, tool.sideEffect])).toEqual([
    ['minecraft.connect', 'minecraft.connect', true], ['minecraft.start', 'minecraft.control', true],
    ['minecraft.status', 'minecraft.read', false], ['minecraft.policy', 'minecraft.control', true], ['minecraft.cancel', 'minecraft.control', true],
    ['minecraft.disconnect', 'minecraft.connect', true],
  ]);
  expect(f.registry.get('minecraft.start').inputSchema.safeParse(task).success).toBe(true);
});

it.each(ids)('rejects %s outside an interactive desktop before contacting the service', async id => {
  const f = fixture(); f.isDesktop.mockReturnValue(false);
  await expect(f.invoke(id)).rejects.toMatchObject({ code: 'tool.channelBlocked' });
  for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled();
  expect(f.isDesktop).toHaveBeenCalledWith('desktop-run');
});

it.each(ids)('does not dispatch %s with an aborted caller or revoked lease', async id => {
  const aborted = fixture(); aborted.controller.abort(new Error('caller_cancelled'));
  await expect(aborted.invoke(id)).rejects.toThrow('caller_cancelled');
  for (const method of Object.values(aborted.service)) expect(method).not.toHaveBeenCalled();
  const revoked = fixture(); revoked.assertAuthorized.mockImplementation(() => { throw new Error('lease_revoked'); });
  await expect(revoked.invoke(id)).rejects.toThrow('lease_revoked');
  for (const method of Object.values(revoked.service)) expect(method).not.toHaveBeenCalled();
});

it.each([
  { name: 'netherQuartz', parameters: { count: 8 } },
  { name: 'endJourney', parameters: {} },
  { name: 'gatherLogs', parameters: { count: 65 } },
  { name: 'gatherLogs', parameters: { count: 1, command: '/give' } },
  { name: 'gatherLogs', parameters: { count: 1 }, replaceCurrent: true },
  { name: 'gatherMaterials', parameters: { requirements: [{ key: 'log', count: 1 }] } },
  { name: 'gatherMaterials', parameters: { chest: { x: 0, y: 64, z: 0 }, requirements: [{ key: 'quartz', count: 1 }] } },
  { name: 'gatherMaterials', parameters: { chest: { x: 0, y: 64, z: 0 }, requirements: Array.from({ length: 9 }, () => ({ key: 'log', count: 1 })) } },
  { name: 'farm', parameters: { plots: 17 } },
  { name: 'homestead', parameters: { anchor: { x: 0.5, y: 64, z: 0 } } },
])('rejects an unsupported or excessive Minecraft request without a service call: %j', async input => {
  const f = fixture();
  expect(f.registry.get('minecraft.start').inputSchema.safeParse(input).success).toBe(false);
  await expect(f.invoke('minecraft.start', input)).rejects.toMatchObject({ code: 'tool.invalidArguments' });
  expect(f.service.start).not.toHaveBeenCalled();
});

it.each([
  task,
  { name: 'gatherMaterials', parameters: { chest: { x: 3, y: 64, z: -2 }, requirements: [
    { key: 'log', count: 64 }, { key: 'planks', count: 8 }, { key: 'stick', count: 4 }, { key: 'cobblestone', count: 16 },
  ] } },
  { name: 'homestead', parameters: {} },
  { name: 'farm', parameters: { plots: 16, bread: 16 } },
])('passes the shared basic task schema through to the host, with dispatch-only wording: %j', async input => {
  const f = fixture();
  f.state.task = { taskId: 'actual-task', requestId: 'actual-request', name: input.name as NonNullable<MinecraftCompanionSnapshot['task']>['name'],
    status: 'accepted', paused: false, createdAt: 1, updatedAt: 1, connectionGeneration: 1, progress: null, error: null };
  const result = await f.invoke('minecraft.start', input);
  expect(result).toMatchObject({ dispatchOnly: true, snapshot: { task: { taskId: 'actual-task', status: 'accepted' } } });
  expect(result).toHaveProperty('message', expect.stringContaining('does not prove completion'));
  expect(f.service.start).toHaveBeenCalledWith(input, expect.any(Function));
  expect(f.state.task.status).toBe('accepted');
});

it.each(['connect', 'start'] as const)('hands %s a live guard that rejects cancellation after an await and before a write', async operation => {
  const f = fixture(), write = vi.fn();
  if (operation === 'connect') f.service.connect.mockImplementation(async (_input, guard) => {
    await Promise.resolve(); f.controller.abort(new Error('late_cancel')); guard?.(); write(); return f.state;
  });
  else f.service.start.mockImplementation(async (_input, guard) => {
    await Promise.resolve(); f.controller.abort(new Error('late_cancel')); guard?.(); write(); return f.state;
  });
  await expect(f.invoke(`minecraft.${operation}`)).rejects.toThrow('late_cancel');
  expect(write).not.toHaveBeenCalled();
});

it('rechecks the lease and channel inside the guard passed to the service', async () => {
  const f = fixture(), write = vi.fn();
  f.service.start.mockImplementation(async (_input, guard) => {
    await Promise.resolve(); f.isDesktop.mockReturnValue(false); guard?.(); write(); return f.state;
  });
  await expect(f.invoke('minecraft.start')).rejects.toMatchObject({ code: 'tool.channelBlocked' });
  expect(write).not.toHaveBeenCalled();
  const revoked = fixture();
  revoked.service.connect.mockImplementation(async (_input, guard) => {
    await Promise.resolve(); revoked.assertAuthorized.mockImplementation(() => { throw new Error('lease_revoked'); });
    guard?.(); write(); return revoked.state;
  });
  await expect(revoked.invoke('minecraft.connect')).rejects.toThrow('lease_revoked');
  expect(write).not.toHaveBeenCalled();
});

it('returns actual cancel and disconnect snapshots without inventing a terminal result or retrying', async () => {
  const f = fixture(); f.state.runtimeState = 'ready'; f.state.connectionState = 'ready'; f.state.controlPending = 'cancel';
  f.state.task = { taskId: 'retiring', requestId: 'request', name: 'gatherLogs', status: 'running', paused: false,
    createdAt: 1, updatedAt: 2, connectionGeneration: 1, progress: { collected: 2 }, error: null };
  expect(await f.invoke('minecraft.cancel')).toBe(f.state);
  expect(f.state.task.status).toBe('running');
  f.state.controlPending = 'disconnect'; f.state.lastError = 'retirement_timeout';
  expect(await f.invoke('minecraft.disconnect')).toBe(f.state);
  expect(f.state.connectionState).toBe('ready');
  const error = Object.assign(new Error('retirement_timeout'), { code: 'retirement_timeout' });
  f.service.cancel.mockRejectedValue(error);
  await expect(f.invoke('minecraft.cancel')).rejects.toBe(error);
  expect(f.service.cancel).toHaveBeenCalledTimes(2);
});

it('reads each current host status and withholds results if authority is revoked while awaiting a call', async () => {
  const f = fixture(); expect(await f.invoke('minecraft.status')).toBe(f.state);
  f.state.connectionState = 'error'; f.state.lastError = 'actual_connection_error';
  expect(await f.invoke('minecraft.status')).toMatchObject({ connectionState: 'error', lastError: 'actual_connection_error' });
  expect(f.service.getState).toHaveBeenCalledTimes(2);
  f.service.cancel.mockImplementation(async () => {
    await Promise.resolve(); f.assertAuthorized.mockImplementation(() => { throw new Error('lease_revoked'); }); return f.state;
  });
  await expect(f.invoke('minecraft.cancel')).rejects.toThrow('lease_revoked');
  expect(f.service.cancel).toHaveBeenCalledTimes(1);
});

it('rejects extra control fields and malformed connection input before dispatch', async () => {
  const f = fixture();
  await expect(f.invoke('minecraft.cancel', { taskId: 'another-task' })).rejects.toMatchObject({ code: 'tool.invalidArguments' });
  await expect(f.invoke('minecraft.connect', { ...config, command: 'arbitrary' })).rejects.toMatchObject({ code: 'tool.invalidArguments' });
  expect(f.service.cancel).not.toHaveBeenCalled(); expect(f.service.connect).not.toHaveBeenCalled();
});

it('forwards a danger policy and rejects an empty or unknown one before the service', async () => {
  const f = fixture();
  await expect(f.invoke('minecraft.policy', { risk: 'bold', guard: 'owner_first' })).resolves.toEqual({ policy: { risk: 'cautious', guard: 'self_first' } });
  expect(f.service.setPolicy).toHaveBeenCalledWith({ risk: 'bold', guard: 'owner_first' });
  await expect(f.invoke('minecraft.policy', {})).rejects.toMatchObject({ code: 'tool.invalidArguments' });
  await expect(f.invoke('minecraft.policy', { risk: 'reckless' })).rejects.toMatchObject({ code: 'tool.invalidArguments' });
  expect(f.service.setPolicy).toHaveBeenCalledTimes(1);
});

it('reports a task refused for an owner out of sight as an answer, not a failed tool', async () => {
  const f = fixture();
  f.service.start.mockRejectedValueOnce(new Error('The owner is not in sight'));
  const input = { name: 'homestead', parameters: { nearOwner: true } };
  await expect(f.invoke('minecraft.start', input)).resolves.toMatchObject({ started: false, reason: 'The owner is not in sight' });
  // Anything else still fails the call.
  f.service.start.mockRejectedValueOnce(new Error('Companion request timed out; task outcome is unconfirmed.'));
  await expect(f.invoke('minecraft.start', input)).rejects.toBeTruthy();
});
