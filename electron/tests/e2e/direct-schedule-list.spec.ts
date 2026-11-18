import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeTelegram } from './support/fake-telegram';

// Use the shared loopback chat-completions fixture only to create the control
// schedule. No Telegram account, channel, or delivery binding is configured.
// eslint-disable-next-line no-empty-pattern
test('desktop schedule lists require the records grant, stay in the current chat and use no model requests', async ({}) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-direct-schedules-')));
  const provider = await fakeTelegram({ cron: true });
  let app: ElectronApplication | undefined;
  try {
    const entry = join(root, 'boot.cjs');
    await writeFile(
      join(root, 'isolated-candidate.json'),
      JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }),
    );
    await writeFile(
      entry,
      [
        "const {dialog,Notification,net}=require('electron');",
        'dialog.showMessageBox=async()=>({response:1,checkboxChecked:false}); Notification.prototype.show=function(){};',
        'const nativeFetch=net.fetch.bind(net);',
        "net.fetch=(input,opts)=>{const url=new URL(input); if(url.protocol==='file:' || url.origin===" +
          JSON.stringify(provider.base) +
          ")return nativeFetch(input,opts); throw Error('Unexpected network destination');};",
        // Keep the every-minute control schedule from executing during list verification.
        // The timer which dispatches cron occurrences is exercised in telegram-cron.spec.ts.
        'const interval=global.setInterval; global.setInterval=(fn,ms,...args)=>interval(fn,ms===15000?300000:ms,...args);',
        'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
      ].join('\n'),
    );
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY'])
      if (process.env[key]) env[key] = process.env[key]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some((w) => w.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find((w) => w.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
    await page.evaluate(async (base) => {
      await window.deskpet.app.setLocale('en');
      const p = await window.deskpet.providers.upsert({
        id: crypto.randomUUID(),
        name: 'Schedule list fixture',
        kind: 'lm-studio',
        baseUrl: base + '/v1',
        model: 'controlled',
        supportsTools: true,
        localExecutionConfirmed: true,
        enabled: true,
      });
      await window.deskpet.providers.select(p.id);
    }, provider.base);
    await page.reload();

    const newChat = page.locator('nav').getByRole('button', { name: 'New conversation', exact: true });
    const latest = page.locator('.message.assistant').last();
    const card = page.getByRole('region', { name: 'This step needs your approval', exact: true });
    const propose = async (text: string, toolId: string, capabilityId: string) => {
      const composer = page.locator('.composer textarea');
      await composer.fill(text);
      await composer.press('Enter');
      await expect(card).toBeVisible();
      const sessionId = await page.locator('.session-control select').inputValue();
      const interaction = await page.evaluate((id) => window.deskpet.chat.getInteraction(id), sessionId);
      expect(interaction?.approval).toMatchObject({ sessionId, toolId, capabilityId });
      return sessionId;
    };
    const accept = async (label: 'Allow once' | 'Confirm recurring settings' = 'Allow once') => {
      await card.getByRole('button', { name: label, exact: true }).click();
      await expect(latest).toHaveAttribute('data-status', 'complete');
      await expect(newChat).toBeEnabled();
    };
    const inChat = (id: string) => page.evaluate((session) => window.deskpet.chatWork.listCron(session), id);
    const chinese = '我现在有哪些周期任务';
    const english = 'List my recurring tasks in this conversation.';
    await newChat.click();
    const hostChat = await propose('Create fixture recurring check', 'cron.create', 'chat.cron');
    await accept('Confirm recurring settings');
    const [schedule] = await inChat(hostChat);
    expect(schedule).toMatchObject({ title: 'Fixture minute check', enabled: true });
    const creationRequests = provider.wires.length;
    expect(creationRequests).toBeGreaterThan(0);

    expect(await propose(english, 'cron.list', 'task.records')).toBe(hostChat);
    await accept();
    await expect(latest).toContainText('Fixture minute check');
    await expect(latest).toContainText('active');
    expect(provider.wires).toHaveLength(creationRequests);

    await newChat.click();
    const refusalChat = await propose(chinese, 'cron.list', 'task.records');
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(latest).toHaveAttribute('data-status', 'failed');
    const failed = await page.evaluate((id) => window.deskpet.chat.listMessages(id), refusalChat);
    expect(failed.find((m) => m.role === 'assistant')?.errorCode).toBe('chat.approvalDenied');
    expect(provider.wires).toHaveLength(creationRequests);
    await newChat.click();
    const emptyChat = await propose(chinese, 'cron.list', 'task.records');
    expect(new Set([hostChat, refusalChat, emptyChat]).size).toBe(3);
    await accept();
    await expect(latest).toContainText('当前对话还没有周期任务。');
    await expect(latest).not.toContainText('Fixture minute check');
    expect(await inChat(emptyChat)).toEqual([]);
    expect(await propose(english, 'cron.list', 'task.records')).toBe(emptyChat);
    await accept();
    await expect(latest).toContainText('There are no recurring tasks in this conversation.');
    await expect(latest).not.toContainText('Fixture minute check');
    expect((await inChat(hostChat)).map((s) => s.id)).toEqual([schedule!.id]);
    expect(provider.wires).toHaveLength(creationRequests);
  } finally {
    await app?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
