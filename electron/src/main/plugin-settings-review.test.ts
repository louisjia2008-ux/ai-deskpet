// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AppSettingsService } from './app-settings';
import { defaultPluginSettings } from '../shared/plugins';

it('retains both plugin configuration and general preferences when independent IPC updates overlap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-plugin-concurrent-settings-'));
  try {
    const path = join(root, 'settings.json');
    const service = new AppSettingsService(path);
    await service.initialize();
    const plugins = defaultPluginSettings();
    plugins.web.enabled = true;
    plugins.web.searxngUrl = 'http://127.0.0.1:18888';
    await Promise.all([service.update({ plugins }), service.update({ theme: 'dark' })]);
    expect(service.get()).toMatchObject({ theme: 'dark', plugins });
    const reloaded = new AppSettingsService(path); await reloaded.initialize();
    expect(reloaded.get()).toMatchObject({ theme: 'dark', plugins });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('freezes nested plugin settings at invocation rather than retaining mutable caller input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-plugin-frozen-settings-'));
  try {
    const service = new AppSettingsService(join(root, 'settings.json')); await service.initialize();
    const plugins = defaultPluginSettings(); plugins.web.enabled = true;
    const updating = service.update({ plugins });
    plugins.web.enabled = false; plugins.web.searxngUrl = 'http://127.0.0.1:19999';
    await updating;
    expect(service.get().plugins.web).toMatchObject({ enabled: true, searxngUrl: 'http://127.0.0.1:8080' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
