import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minecraftCompanionChatModel } from '../support/minecraft-companion-chat-model';

// Real desktop controller and permission UI, synthetic loopback model only.
// No connection/start command is sent; the Minecraft helper must remain absent.
// eslint-disable-next-line no-empty-pattern
test('chat discovers basic Minecraft tools and reads real idle host status in an isolated profile', async ({}) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-minecraft-chat-')));
  const model = await minecraftCompanionChatModel();
  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
    const boot = join(root, 'boot.cjs');
    await writeFile(boot, [
      "const {dialog,Notification,net}=require('electron');",
      'dialog.showMessageBox=async()=>({response:1,checkboxChecked:false}); Notification.prototype.show=function(){};',
      'const originalFetch=net.fetch.bind(net);',
      'net.fetch=(input,options)=>{const u=new URL(input); if(u.protocol===\'file:\' || u.origin===' + JSON.stringify(model.base)
        + ')return originalFetch(input,options); throw Error(\'Unexpected network destination\');};',
      "const cp=require('node:child_process');const spawn=cp.spawn;globalThis.minecraftForbiddenSpawns=[];",
      "cp.spawn=function(command,args,options){if(/(?:^|[/\\\\])java$/.test(String(command)) || (args||[]).some(arg=>/minecraft-runtime|minecraft-companion-runtime/.test(String(arg)))){globalThis.minecraftForbiddenSpawns.push({command,args});throw Error('Minecraft/Java process forbidden in status-only fixture');}return spawn.call(this,command,args,options);};",
      "require('node:module').syncBuiltinESMExports();",
      'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
    ].join('\n'));
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    app = await electron.launch({ args: [boot, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
    await page.evaluate(async base => {
      await window.deskpet.app.setLocale('en');
      const provider = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio',
        name: 'Minecraft chat fixture', baseUrl: base + '/v1', model: 'minecraft-chat-fixture', enabled: true,
        supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 16384, maxOutputTokens: 512 });
      await window.deskpet.providers.select(provider.id);
    }, model.base);
    await page.reload();
    await page.locator('nav').getByRole('button', { name: 'New conversation', exact: true }).click();
    const permissions = await page.evaluate(() => window.deskpet.permissions.list());
    for (const capabilityId of ['minecraft.connect', 'minecraft.control', 'minecraft.read']) {
      expect(permissions.find(item => item.capabilityId === capabilityId)).toMatchObject({ capabilityId, state: 'not-requested' });
    }
    const composer = page.locator('.composer textarea');
    await composer.fill('Inspect Minecraft Companion status only. Do not connect or start a task.');
    await composer.press('Enter');
    const card = page.getByRole('region', { name: 'This step needs your approval', exact: true });
    await expect(card).toBeVisible();
    const sessionId = await page.locator('.session-control select').inputValue();
    const interaction = await page.evaluate(id => window.deskpet.chat.getInteraction(id), sessionId);
    expect(interaction?.approval).toMatchObject({ toolId: 'minecraft.status', capabilityId: 'minecraft.read' });
    expect(model.wires).toHaveLength(2);
    expect(model.wires[0]!.tools?.some(tool => tool.function.description.startsWith('Read Minecraft task status.'))).toBe(false);
    const discovered = model.wires[1]!.tools ?? [];
    for (const title of ['Connect Minecraft Companion.', 'Start a basic Minecraft task.', 'Read Minecraft task status.',
      'Cancel the current Minecraft task.', 'Disconnect Minecraft Companion.']) {
      expect(discovered.some(tool => tool.function.description.startsWith(title))).toBe(true);
    }
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    const latest = page.locator('.message.assistant').last();
    await expect(latest).toHaveAttribute('data-status', 'complete');
    await expect(latest).toContainText('Observed Minecraft runtime=stopped; connection=disconnected; task=none.');
    expect(model.wires).toHaveLength(3);
    expect(model.errors).toEqual([]);
    await composer.fill('停止Minecraft');
    await composer.press('Enter');
    await expect(latest).toContainText(/no active Minecraft task to cancel/i);
    await expect(latest).toHaveAttribute('data-status', 'complete');
    expect(await page.locator('.session-control select').inputValue()).toBe(sessionId);
    expect(model.wires).toHaveLength(3);
    expect(model.errors).toEqual([]);
    expect(await app.evaluate(() => (globalThis as unknown as { minecraftForbiddenSpawns: unknown[] }).minecraftForbiddenSpawns)).toEqual([]);
    const after = await page.evaluate(() => window.deskpet.permissions.list());
    expect(after).toEqual(permissions);
    for (const capabilityId of ['minecraft.connect', 'minecraft.control', 'minecraft.read']) {
      expect(after.find(item => item.capabilityId === capabilityId)).toMatchObject({ state: 'not-requested' });
    }
  } finally {
    await app?.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
