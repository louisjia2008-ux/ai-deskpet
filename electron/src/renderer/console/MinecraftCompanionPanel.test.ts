import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initialMinecraftCompanionSnapshot } from '../../shared/minecraft-companion';
import type { MinecraftCompanionConfig, MinecraftCompanionSnapshot, MinecraftCompanionTaskInput } from '../../shared/minecraft-companion';
import { MinecraftCompanionChatStatus, MinecraftCompanionPanel } from './MinecraftCompanionPanel';

const ready = (): MinecraftCompanionSnapshot => ({ ...initialMinecraftCompanionSnapshot(), runtimeState: 'ready', connectionState: 'ready', connectionGeneration: 1, observation: { at: 1, alive: false, health: 0, food: 0, dimension: 'overworld', position: { x: 1, y: 64, z: -2 }, inventory: { oak_log: 2 } } });
const task = (status: 'running' | 'completed' | 'cancelled' = 'running'): MinecraftCompanionSnapshot => ({ ...ready(), task: { taskId: 'task-real-1', requestId: 'req-real-1', name: 'gatherLogs', status, paused: false, createdAt: 1, updatedAt: 2, connectionGeneration: 1, progress: { current: 2, target: 4 }, error: null } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const install = (state = initialMinecraftCompanionSnapshot()) => {
  const listeners = new Set<(state: MinecraftCompanionSnapshot) => void>();
  const unsubscribe = vi.fn();
  const api = {
    getState: vi.fn(async () => state),
    connect: vi.fn(async (config: MinecraftCompanionConfig) => { void config; return ready(); }),
    start: vi.fn(async (input: MinecraftCompanionTaskInput) => { void input; return task(); }),
    cancel: vi.fn(async () => task('cancelled')),
    disconnect: vi.fn(async () => initialMinecraftCompanionSnapshot()),
    onChanged: vi.fn((listener: (state: MinecraftCompanionSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe(); }; }),
  };
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { minecraftCompanion: api } });
  return { api, unsubscribe, emit: (next: MinecraftCompanionSnapshot) => { listeners.forEach((listener) => listener(next)); } };
};
afterEach(cleanup);

describe('MinecraftCompanionPanel', () => {
  it('handles a build without the companion API without invoking legacy Minecraft', async () => {
    const legacy = vi.fn();
    Object.defineProperty(window, 'deskpet', { configurable: true, value: { minecraft: { getState: legacy } } });
    render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Minecraft Companion is unavailable in this app build.');
    expect(screen.getByRole('button', { name: 'Connect basic chat' })).toBeDisabled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('connects using explicit local defaults and does not present transport ready as world ready', async () => {
    const { api, emit } = install();
    render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    const connect = await screen.findByRole('button', { name: 'Connect basic chat' });
    await waitFor(() => expect(connect).toBeEnabled());
    expect(screen.getByLabelText('Bot username')).toHaveValue('DeskPetCore');
    fireEvent.click(connect);
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 25565, username: 'DeskPetCore', auth: 'offline', version: 'auto' }));
    act(() => emit({ ...ready(), connectionState: 'connecting', observation: null }));
    expect(screen.getByRole('button', { name: 'Start basic task' })).toBeDisabled();
    expect(screen.getByText(/does not mean the player has joined/u)).toBeInTheDocument();
  });

  it('submits bounded typed tasks and shows actual zero observation and task counters', async () => {
    const { api } = install(ready());
    render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    const start = await screen.findByRole('button', { name: 'Start basic task' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '3' } });
    fireEvent.click(start);
    await waitFor(() => expect(api.start).toHaveBeenCalledWith({ name: 'gatherLogs', parameters: { count: 3 } }));
    expect(await screen.findByText('task-real-1')).toBeInTheDocument();
    expect(screen.getByText('Health').parentElement).toHaveTextContent('0');
    expect(screen.getByText('1.0, 64.0, -2.0')).toBeInTheDocument();
    expect(screen.getByText(/"current": 2/u)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('requires explicit chest coordinates for chest materials and validates the request', async () => {
    const { api } = install(ready());
    render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start basic task' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'gatherMaterials' } });
    fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'cobblestone' } });
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Y'), { target: { value: '65' } });
    fireEvent.change(screen.getByLabelText('Z'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start basic task' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith({ name: 'gatherMaterials', parameters: { chest: { x: 12, y: 65, z: -3 }, requirements: [{ key: 'cobblestone', count: 4 }] } }));
  });

  it('keeps cancellation independent while connect is pending', async () => {
    const { api } = install();
    const pending = deferred<MinecraftCompanionSnapshot>();
    api.connect.mockImplementation(() => pending.promise);
    render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect basic chat' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Connect basic chat' }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    const cancel = screen.getByRole('button', { name: 'Cancel task' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    await act(async () => pending.resolve(ready()));
    expect(screen.getByText('cancelled')).toBeInTheDocument();
  });

  it('can cancel a pending start and does not let its late response replace newer cancelled state', async () => {
    const { api, emit } = install(ready());
    const pending = deferred<MinecraftCompanionSnapshot>();
    api.start.mockImplementation(() => pending.promise);
    render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start basic task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start basic task' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    act(() => emit(task('cancelled')));
    await act(async () => pending.resolve(task()));
    expect(screen.getByText('cancelled')).toBeInTheDocument();
    expect(screen.getByText(/Cancelling a task leaves survival safety behavior active/u)).toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
  });

  it('subscribes before initial read and keeps a newer pushed snapshot', async () => {
    const { api, emit, unsubscribe } = install();
    const pending = deferred<MinecraftCompanionSnapshot>();
    api.getState.mockImplementation(() => pending.promise);
    const view = render(createElement(MinecraftCompanionPanel, { locale: 'en' }));
    await waitFor(() => expect(api.getState).toHaveBeenCalledOnce());
    act(() => emit(task()));
    await act(async () => pending.resolve(initialMinecraftCompanionSnapshot()));
    expect(screen.getByText('task-real-1')).toBeInTheDocument();
    view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('displays rejected operations and Chinese labels without touching shared translations', async () => {
    const { api } = install(ready());
    api.start.mockRejectedValueOnce(new Error('engine:needs_supplies'));
    render(createElement(MinecraftCompanionPanel, { locale: 'zh-CN' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始基础任务' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始基础任务' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('engine:needs_supplies');
    expect(screen.getByRole('button', { name: '取消任务' })).toBeEnabled();
  });
});

describe('MinecraftCompanionChatStatus', () => {
  it('stays absent when idle, then shows progress and an independent cancel action', async () => {
    const { emit, api } = install();
    const open = vi.fn();
    render(createElement(MinecraftCompanionChatStatus, { locale: 'en', onOpenConfiguration: open }));
    await act(async () => undefined);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    act(() => emit(task()));
    expect(screen.getByRole('complementary', { name: 'Minecraft Companion' })).toHaveTextContent('Collect logs');
    expect(screen.getByText(/"current": 2/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Minecraft configuration' }));
    expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
  });

  it('keeps cancellation pending until the service confirms completion', async () => {
    const { api } = install(task());
    const pending = deferred<MinecraftCompanionSnapshot>();
    api.cancel.mockImplementation(() => pending.promise);
    render(createElement(MinecraftCompanionChatStatus, { locale: 'en' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel task' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('running');
    await act(async () => pending.resolve(task('cancelled')));
    expect(screen.getByRole('status')).toHaveTextContent('cancelled');
  });
});
