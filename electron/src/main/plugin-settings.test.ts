// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppSettingsService } from './app-settings';
import { defaultPluginSettings, localPluginUrlSchema, pluginConfigurationSchema } from '../shared/plugins';
import { authorizeIpcRequest } from './ipc-policy';

describe('plugin settings compatibility and IPC', () => {
  it('loads old settings without changing saved preferences and persists new plugin controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-plugin-settings-'));
    try {
      const path = join(root, 'settings.json');
      const old = { locale: 'zh-CN', theme: 'dark', hotkey: 'CommandOrControl+Shift+D', autoLaunch: false, overlayVisible: true, activeProviderId: null };
      await writeFile(path, JSON.stringify({ schemaVersion: 1, data: old }));
      const service = new AppSettingsService(path); await service.initialize();
      expect(service.get()).toMatchObject({ ...old, plugins: defaultPluginSettings() });
      const plugins = defaultPluginSettings(); plugins.web.enabled = true; plugins.rea.enabled = false;
      await service.update({ plugins });
      const reloaded = new AppSettingsService(path); await reloaded.initialize();
      expect(reloaded.get()).toEqual({ ...old, plugins });
      expect(await readFile(path, 'utf8')).not.toContain('crawl4aiToken');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('accepts only explicit loopback service origins and handles malformed URLs as validation errors', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:11235/', 'https://[::1]:11235']) expect(localPluginUrlSchema.safeParse(url).success).toBe(true);
    for (const url of ['not a URL', 'http://127.0.0.1:8080/crawl', 'http://localhost:8080/?token=secret', 'http://user:pass@localhost:8080', 'https://api.example.com', 'file:///tmp/server']) expect(localPluginUrlSchema.safeParse(url).success).toBe(false);
    expect(pluginConfigurationSchema.safeParse({ settings: defaultPluginSettings(), crawl4aiToken: 'token', clearCrawl4aiToken: true }).success).toBe(false);
  });

  it('keeps plugin administration and runtime checks console-only with exact bounded inputs', () => {
    const base = { senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false };
    for (const [channel, payload] of [
      ['plugins:get-state', {}], ['plugins:configure', { settings: defaultPluginSettings() }],
      ['plugins:test', { kind: 'searxng' }], ['rea:check-runtime', {}],
    ] as const) {
      const request = { ...base, channel, envelope: { version: 1, payload } };
      expect(authorizeIpcRequest(request)).toBeDefined();
      expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow();
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...payload, command: 'arbitrary' } } })).toThrow();
    }
  });
});
