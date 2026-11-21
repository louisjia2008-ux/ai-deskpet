import { expect, it, vi } from 'vitest';
import type { AppState, InvokeChannel, ProviderConfig } from '../../shared';
import { defaultModelRouting } from '../../shared/model-routing';
import { defaultPluginSettings } from '../../shared/plugins';
import type { AppSettings, AppSettingsService } from '../app-settings';
import type { IpcRouter } from '../ipc-router';
import { registerProviderIpc } from './provider-ipc';

const fixture = () => {
  const handlers = new Map<InvokeChannel, (value: unknown) => unknown>();
  const register: IpcRouter['register'] = (channel, roles, handler) => {
    expect(roles).toEqual(['console']); expect(handlers.has(channel)).toBe(false);
    handlers.set(channel, handler as unknown as (value: unknown) => unknown);
  };
  const local: ProviderConfig = { id: 'local', name: 'Local', enabled: true, kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'm', supportsTools: true, secretState: 'missing', localExecutionConfirmed: true };
  const remote: ProviderConfig = { ...local, id: 'remote', name: 'Remote', kind: 'openai', baseUrl: 'https://fixture.invalid' };
  const settings: AppSettings = { locale: 'en', theme: 'dark', hotkey: 'Alt+Space', autoLaunch: false, overlayVisible: true,
    activeProviderId: null, plugins: defaultPluginSettings() };
  const providers = { list: vi.fn(() => [local, remote]), setModel: vi.fn(async () => local), upsert: vi.fn(async () => local),
    remove: vi.fn(async () => undefined), clearSecret: vi.fn(async () => local), discoverModels: vi.fn(async () => []) };
  const deps = { ipc: { register }, providers, settings: { get: () => structuredClone(settings), update: vi.fn<AppSettingsService['update']>(async patch => { Object.assign(settings, patch); return structuredClone(settings); }) },
    modelBindings: { impact: vi.fn(async () => null), change: vi.fn(async (_id, _model, _consent, save: () => Promise<ProviderConfig>) => save()) },
    routingChanged: vi.fn(), providersChanged: vi.fn(), selected: vi.fn(() => ({ activeProviderId: settings.activeProviderId }) as AppState), listModels: vi.fn(async () => []) };
  registerProviderIpc(deps);
  return { ...deps, local, remote, settingsValue: settings, call: async (channel: InvokeChannel, value: unknown = {}) => handlers.get(channel)!(value), count: handlers.size };
};

it('registers every provider route as console-only and changes selection only after a valid durable settings update', async () => {
  const f = fixture(); expect(f.count).toBe(12);
  await expect(f.call('providers:select', { id: 'missing' })).rejects.toThrow('provider.unavailable');
  expect(f.settings.update).not.toHaveBeenCalled(); expect(f.selected).not.toHaveBeenCalled();
  await expect(f.call('providers:select', { id: f.local.id })).resolves.toEqual({ activeProviderId: f.local.id });
  expect(f.settingsValue.activeProviderId).toBe(f.local.id); expect(f.selected).toHaveBeenCalledOnce();
});

it('validates routing destinations/fallbacks and advances the routing epoch only after persistence', async () => {
  const f = fixture();
  const routing = { ...defaultModelRouting, enabled: true, localProviderId: f.local.id, cloudProviderId: f.remote.id };
  await expect(f.call('providers:set-routing', { ...routing, localProviderId: f.remote.id })).rejects.toThrow('provider.unavailable');
  expect(f.routingChanged).not.toHaveBeenCalled();
  f.settings.update.mockRejectedValueOnce(new Error('fixture.save'));
  await expect(f.call('providers:set-routing', routing)).rejects.toThrow('fixture.save');
  expect(f.routingChanged).not.toHaveBeenCalled();
  await expect(f.call('providers:set-routing', routing)).resolves.toEqual(routing);
  expect(f.routingChanged).toHaveBeenCalledOnce();
});

it('publishes provider changes only on success and keeps test diagnostics generic', async () => {
  const f = fixture();
  f.providers.setModel.mockRejectedValueOnce(new Error('fixture.save'));
  await expect(f.call('providers:set-model', { id: f.local.id, model: 'other' })).rejects.toThrow('fixture.save');
  expect(f.providersChanged).not.toHaveBeenCalled();
  await f.call('providers:set-model', { id: f.local.id, model: 'other' }); expect(f.providersChanged).toHaveBeenCalledOnce();
  f.listModels.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_DIAGNOSTIC'));
  await expect(f.call('providers:test', { id: f.local.id })).resolves.toEqual({ ok: false, messageCode: 'provider.test.failed', latencyMs: null });
});
