import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppState, CharacterState, DeskPetApi, ProviderConfig } from '../../shared';
import { useConsoleSnapshot } from './use-console-snapshot';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const fixture = () => {
  const listeners: Record<string, (value?: unknown) => void> = {};
  const on = (name: string) => (callback: (value?: unknown) => void) => { listeners[name] = callback; return () => { delete listeners[name]; }; };
  const api = {
    app: { getState: vi.fn(async () => ({ theme: 'dark' })), onChanged: on('app') },
    character: { getState: vi.fn(async () => ({ bubble: null })), onChanged: on('character') },
    chat: { listSessions: vi.fn(async () => []), onSessionsChanged: on('sessions') },
    tasks: { list: vi.fn(async () => []), getFocus: vi.fn(async () => null), listRunEvents: vi.fn(), onChanged: on('tasks') },
    memory: { list: vi.fn(async () => []), onChanged: on('memories') },
    relationship: { get: vi.fn(async () => ({ nickname: 'Fixture' })), onChanged: on('relationship') },
    providers: { list: vi.fn(async () => [] as ProviderConfig[]), onChanged: on('providers') },
    permissions: { list: vi.fn(async () => []), onChanged: on('permissions') },
    attention: { snapshot: vi.fn(async () => null), onChanged: on('attention') },
  };
  Object.defineProperty(window, 'deskpet', { value: api as unknown as DeskPetApi, configurable: true });
  return { api, listeners };
};

it('uses event payloads and coalesces slice invalidations without unrelated reads or activity logs', async () => {
  const { api, listeners } = fixture();
  const { result } = renderHook(useConsoleSnapshot);
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  const character = { bubble: 'NEW_PAYLOAD' } as unknown as CharacterState;
  act(() => { listeners.character!(character); listeners.app!({ theme: 'light' } as AppState); });
  expect(result.current.snapshot?.character).toEqual(character);
  expect(result.current.snapshot?.app.theme).toBe('light');
  expect(api.character.getState).toHaveBeenCalledTimes(1);
  act(() => { listeners.sessions!(); listeners.sessions!(); listeners.tasks!(); });
  await waitFor(() => expect(api.chat.listSessions).toHaveBeenCalledTimes(2));
  expect(api.tasks.list).toHaveBeenCalledTimes(2); expect(api.tasks.getFocus).toHaveBeenCalledTimes(2);
  expect(api.memory.list).toHaveBeenCalledTimes(1); expect(api.providers.list).toHaveBeenCalledTimes(1);
  expect(api.tasks.listRunEvents).not.toHaveBeenCalled();
});

it('does not overwrite a newer payload with an initial read or a slow explicit refresh', async () => {
  const { api, listeners } = fixture();
  let complete!: (value: ProviderConfig[]) => void;
  api.providers.list.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const { result } = renderHook(useConsoleSnapshot);
  const providers = [{ id: 'NEW' }] as ProviderConfig[];
  act(() => listeners.providers!(providers));
  await waitFor(() => expect(result.current.snapshot?.providers).toEqual(providers));
  await act(async () => { complete([]); });
  expect(result.current.snapshot?.providers).toEqual(providers);
  let refreshing!: Promise<void>;
  act(() => { refreshing = result.current.refresh(); });
  act(() => listeners.providers!([{ id: 'NEWER' }]));
  await act(async () => { complete([]); await refreshing; });
  expect(result.current.snapshot?.providers).toEqual([{ id: 'NEWER' }]);
});

it('unsubscribes and ignores pending reads after unmount', async () => {
  const { listeners } = fixture();
  const { result, unmount } = renderHook(useConsoleSnapshot);
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  unmount(); expect(Object.keys(listeners)).toEqual([]);
});
