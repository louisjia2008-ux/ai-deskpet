import type { AppState, ProviderModel } from '../../shared';
import { defaultModelRouting, routingDestination } from '../../shared/model-routing';
import type { AppSettingsService } from '../app-settings';
import type { IpcRouter } from '../ipc-router';
import type { ProviderService } from './provider-service';

interface Dependencies {
  ipc: Pick<IpcRouter, 'register'>;
  providers: Pick<ProviderService, 'list' | 'setModel' | 'upsert' | 'remove' | 'clearSecret' | 'discoverModels'>;
  settings: Pick<AppSettingsService, 'get' | 'update'>;
  routingChanged(): void;
  providersChanged(): void;
  selected(): AppState;
  listModels(id: string): Promise<ProviderModel[]>;
}

/** Provider settings routes only. IPC authentication/schema/maintenance gates
 * remain in IpcRouter; credentials and dispatch stay in ProviderService. */
export const registerProviderIpc = ({ ipc, providers, settings, routingChanged, providersChanged, selected, listModels }: Dependencies): void => {
  const consoleOnly = ['console'] as const;
  ipc.register('providers:get-routing', consoleOnly, () => settings.get().modelRouting ?? defaultModelRouting);
  ipc.register('providers:set-routing', consoleOnly, async value => {
    const available = providers.list();
    const valid = (id: string | null, kind: 'local' | 'cloud') => available.some(item => item.id === id && routingDestination(item) === kind);
    if (value.enabled && (!valid(value.localProviderId, 'local') || value.cloudProviderId && !valid(value.cloudProviderId, 'cloud'))) throw new Error('provider.unavailable');
    if (value.fallback?.enabled && value.fallback.providerIds.some(id => !available.some(provider => provider.id === id && provider.enabled))) throw new Error('provider.unavailable');
    await settings.update({ modelRouting: value }); routingChanged(); return value;
  });
  ipc.register('providers:list', consoleOnly, () => providers.list());
  ipc.register('providers:select', consoleOnly, async ({ id }) => {
    if (!providers.list().some(provider => provider.id === id && provider.enabled)) throw new Error('provider.unavailable');
    await settings.update({ activeProviderId: id }); return selected();
  });
  ipc.register('providers:set-model', consoleOnly, async ({ id, model }) => {
    const result = await providers.setModel(id, model); providersChanged(); return result;
  });
  ipc.register('providers:upsert', consoleOnly, async ({ apiKey, ...config }) => {
    const result = await providers.upsert(config, apiKey); providersChanged(); return result;
  });
  ipc.register('providers:remove', consoleOnly, async ({ id }) => { await providers.remove(id); providersChanged(); });
  ipc.register('providers:clear-secret', consoleOnly, async ({ id }) => { const result = await providers.clearSecret(id); providersChanged(); return result; });
  ipc.register('providers:test', consoleOnly, async ({ id }) => {
    const started = Date.now();
    try { await listModels(id); return { ok: true, messageCode: 'provider.test.ok', latencyMs: Date.now() - started }; }
    catch { return { ok: false, messageCode: 'provider.test.failed', latencyMs: null }; }
  });
  ipc.register('providers:list-models', consoleOnly, ({ id }) => listModels(id));
  ipc.register('providers:discover-models', consoleOnly, input => providers.discoverModels(input));
};
