// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { defaultPluginSettings } from '../../shared/plugins';
import type { PluginSettings } from '../../shared/plugins';
import { PluginConfigurationService } from './configuration';

const fixture = (initialToken: string | null = 'synthetic-old-token') => {
  let plugins = defaultPluginSettings(); let token = initialToken;
  const settings = { get: () => ({ plugins: structuredClone(plugins) }), update: vi.fn(async ({ plugins: next }: { plugins: PluginSettings }) => { plugins = structuredClone(next); }) };
  const vault = { isAvailable: () => true, hasSecret: vi.fn(async () => token !== null), getSecret: vi.fn(async () => token),
    setSecret: vi.fn(async (_id: string, value: string) => { token = value; }), deleteSecret: vi.fn(async () => { token = null; }) };
  const cancelRea = vi.fn(async () => undefined); const invalidateWeb = vi.fn();
  const service = new PluginConfigurationService({ settings, vault, cancelRea, invalidateWeb });
  return { service, settings, vault, cancelRea, invalidateWeb, token: () => token, setToken: (value: string | null) => { token = value; }, commit: (value: PluginSettings) => { plugins = structuredClone(value); } };
};

describe('plugin configuration transactions', () => {
  it('restores the old token and keeps settings when persistence fails', async () => {
    const f = fixture(); const settings = defaultPluginSettings(); settings.web.enabled = true; settings.rea.enabled = false;
    f.settings.update.mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(f.service.configure({ settings, crawl4aiToken: 'synthetic-new-token' })).rejects.toThrow('plugin.saveFailed');
    expect(f.token()).toBe('synthetic-old-token');
    expect(f.settings.get().plugins).toEqual(defaultPluginSettings());
    expect(f.cancelRea).not.toHaveBeenCalled();
    expect(f.invalidateWeb).toHaveBeenCalled();
  });

  it('rolls back even if setting a secret writes before reporting failure', async () => {
    const f = fixture();
    f.vault.setSecret.mockImplementationOnce(async (_id, value) => { f.setToken(value); throw new Error('synthetic after-write failure'); });
    await expect(f.service.configure({ settings: defaultPluginSettings(), crawl4aiToken: 'synthetic-new-token' })).rejects.toThrow('plugin.saveFailed');
    expect(f.token()).toBe('synthetic-old-token'); expect(f.settings.update).not.toHaveBeenCalled();
  });

  it('restores an explicitly removed token when deletion reports an after-write failure', async () => {
    const f = fixture();
    f.vault.deleteSecret.mockImplementationOnce(async () => { f.setToken(null); throw new Error('synthetic after-delete failure'); });
    await expect(f.service.configure({ settings: defaultPluginSettings(), clearCrawl4aiToken: true })).rejects.toThrow('plugin.saveFailed');
    expect(f.token()).toBe('synthetic-old-token'); expect(f.settings.update).not.toHaveBeenCalled();
  });

  it('removes a newly staged token if there was no prior secret and settings cannot be saved', async () => {
    const f = fixture(null); f.settings.update.mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(f.service.configure({ settings: defaultPluginSettings(), crawl4aiToken: 'synthetic-new-token' })).rejects.toThrow('plugin.saveFailed');
    expect(f.token()).toBeNull(); expect((await f.service.getState()).crawl4aiTokenConfigured).toBe(false);
  });

  it('serializes configuration transactions and freezes queued renderer inputs', async () => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { entered = resolve; });
    f.settings.update.mockImplementationOnce(async ({ plugins }) => { entered(); await paused; f.commit(plugins); });
    const one = defaultPluginSettings(); one.web.searxngUrl = 'http://127.0.0.1:18080';
    const first = f.service.configure({ settings: one, crawl4aiToken: 'synthetic-first-token' });
    await saving;
    const two = defaultPluginSettings(); two.web.searxngUrl = 'http://127.0.0.1:18081';
    const second = f.service.configure({ settings: two, crawl4aiToken: 'synthetic-second-token' });
    two.web.searxngUrl = 'http://127.0.0.1:19999';
    expect(f.vault.setSecret).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]);
    expect(f.settings.get().plugins.web.searxngUrl).toBe('http://127.0.0.1:18081');
    expect(f.token()).toBe('synthetic-second-token');
  });

  it('persists REA disabled before cleanup and reports an unconfirmed close without re-enabling it', async () => {
    const f = fixture(); const settings = defaultPluginSettings(); settings.rea.enabled = false;
    f.cancelRea.mockImplementation(async () => { expect(f.settings.get().plugins.rea.enabled).toBe(false); throw new Error('synthetic close failure'); });
    const state = await f.service.configure({ settings });
    expect(state.settings.rea.enabled).toBe(false);
    expect(state.warningCode).toBe('plugin.reaCleanupUnconfirmed');
    expect(await f.service.getState()).toMatchObject({ warningCode: 'plugin.reaCleanupUnconfirmed' });
    await expect(f.service.configure({ settings: defaultPluginSettings() })).rejects.toThrow('plugin.reaCleanupUnconfirmed');
    expect(f.settings.get().plugins.rea.enabled).toBe(false);
    f.cancelRea.mockResolvedValue(undefined);
    expect(await f.service.configure({ settings: defaultPluginSettings() })).not.toHaveProperty('warningCode');
    expect(f.settings.get().plugins.rea.enabled).toBe(true);
  });

  it('honestly reports a failed credential rollback instead of reporting a successful save', async () => {
    const f = fixture(); f.settings.update.mockRejectedValueOnce(new Error('synthetic write failure'));
    f.vault.setSecret.mockImplementation(async (_id, value) => { f.setToken(value); if (value === 'synthetic-old-token') throw new Error('synthetic rollback failure'); });
    await expect(f.service.configure({ settings: defaultPluginSettings(), crawl4aiToken: 'synthetic-new-token' })).rejects.toThrow('plugin.configurationRollbackFailed');
    expect(f.cancelRea).not.toHaveBeenCalled(); expect(f.invalidateWeb).toHaveBeenCalled();
  });

  it('rejects invalid service endpoints before touching credentials or settings', async () => {
    const f = fixture(); const settings = defaultPluginSettings(); settings.web.crawl4aiUrl = 'https://remote.example.com';
    await expect(f.service.configure({ settings, crawl4aiToken: 'synthetic-token' })).rejects.toThrow();
    expect(f.vault.getSecret).not.toHaveBeenCalled(); expect(f.vault.setSecret).not.toHaveBeenCalled(); expect(f.settings.update).not.toHaveBeenCalled();
  });
});
