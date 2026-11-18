import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeTelegram } from './support/fake-telegram';

// Only wall time, native dialogs/notifications, and network endpoints are synthetic.
// The host creates the schedule through an actual desktop chat tool approval,
// reserves each occurrence in its normal timer, and checks the delivery grant at POST.
// eslint-disable-next-line no-empty-pattern
test('desktop cron delivers only its opted-in occurrence and suppresses its queued result after revocation', async ({}) => {
  test.setTimeout(110_000);
  const f = await fakeTelegram({ cron: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-telegram-cron-')));
  const entry = join(root, 'boot.cjs');
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  await writeFile(
    entry,
    [
      "const {dialog,net,Notification}=require('electron');",
      'dialog.showMessageBox=async()=>({response:1,checkboxChecked:false}); Notification.prototype.show=function(){};',
      'const nativeFetch=net.fetch.bind(net);',
      "net.fetch=(input,opts)=>{const url=new URL(input);if(url.protocol==='file:')return nativeFetch(input,opts);if(url.origin==='https://api.telegram.org')return nativeFetch(" +
        JSON.stringify(f.base) +
        '+url.pathname,opts);if(url.origin===' +
        JSON.stringify(f.base) +
        ")return nativeFetch(input,opts);throw Error('Unexpected network destination');};",
      "const OriginalDate=Date;let clockDelta=OriginalDate.parse('2026-11-04T02:00:10Z')-OriginalDate.now();const clock=()=>OriginalDate.now()+clockDelta;global.__fixtureCronClock=ms=>{clockDelta=ms-OriginalDate.now();};",
      "global.Date=new Proxy(OriginalDate,{construct:(t,args)=>Reflect.construct(t,args.length?args:[clock()]),get:(t,k)=>k==='now'?clock:Reflect.get(t,k)});",
      'const interval=global.setInterval;global.setInterval=(cb,ms,...args)=>interval(cb,ms===15000?250:ms,...args);',
      'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
    ].join('\n'),
  );
  let app: ElectronApplication | undefined;
  try {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[k]) env[k] = process.env[k]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some((w) => w.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find((w) => w.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
    const provider = await page.evaluate(
      (baseUrl) =>
        window.deskpet.providers.upsert({
          id: crypto.randomUUID(),
          kind: 'lm-studio',
          name: 'Scheduled fixture',
          baseUrl,
          model: 'controlled',
          enabled: true,
          supportsTools: true,
          localExecutionConfirmed: true,
        }),
      f.base + '/v1',
    );
    await page.evaluate((input) => window.deskpet.telegram.configure(input), {
      enabled: true,
      token: f.token,
      providerId: provider.id,
      model: provider.model,
    });
    const { code } = await page.evaluate(() => window.deskpet.telegram.startPairing());
    f.message('/pair ' + code);
    const status = () => page.evaluate(() => window.deskpet.telegram.getState());
    await expect.poll(async () => (await status()).pairingCandidate?.id).toBeTruthy();
    const candidate = (await status()).pairingCandidate!;
    const paired = await page.evaluate((id) => window.deskpet.telegram.confirmPairing(id), candidate.id);
    const session = await page.evaluate(() =>
      window.deskpet.chat.createSession({ kind: 'normal', title: 'Desktop scheduler test' }),
    );
    await page.evaluate((input) => window.deskpet.chat.send(input), {
      sessionId: session.id,
      providerId: provider.id,
      content: 'Create fixture recurring check',
    });
    const interaction = () => page.evaluate((id) => window.deskpet.chat.getInteraction(id), session.id);
    await expect.poll(async () => (await interaction())?.approval?.toolId).toBe('cron.create');
    const approval = (await interaction())!.approval!;
    await page.evaluate((input) => window.deskpet.chat.resolveApproval(input), {
      runId: approval.runId,
      approvalId: approval.id,
      sessionId: session.id,
      decision: 'allow-once' as const,
    });
    const schedules = () => page.evaluate((id) => window.deskpet.chatWork.listCron(id), session.id);
    await expect.poll(async () => (await schedules()).length).toBe(1);
    const schedule = (await schedules())[0]!;
    expect(schedule.telegramDelivery).toBeUndefined();
    const setDelivery = (enabled: boolean) =>
      page.evaluate((input) => window.deskpet.telegram.setCronDelivery(input), {
        scheduleId: schedule.id,
        expectedRevision: schedule.revision,
        expectedBindingId: paired.bindingId,
        enabled,
      });
    const runNext = async (n: number) => {
      const due = (await schedules())[0]!.nextRunAt!;
      await app!.evaluate(
        (_, ms) => (globalThis as unknown as { __fixtureCronClock: (time: number) => void }).__fixtureCronClock(ms),
        Date.parse(due) + 1000,
      );
      await expect
        .poll(
          async () =>
            page.evaluate(
              ({ id, answer }) =>
                window.deskpet.chat
                  .listMessages(id)
                  .then((messages) =>
                    messages.some((m) => m.role === 'assistant' && m.status === 'complete' && m.content === answer),
                  ),
              { id: session.id, answer: 'Fixture scheduled result ' + n },
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
    };
    const delivered = (n: number) => f.posts.filter((p) => p.text === 'Fixture scheduled result ' + n);
    await expect.poll(async () => !(await interaction())).toBe(true);
    await runNext(1);
    await setDelivery(true);
    expect((await schedules())[0]!.telegramDelivery?.bindingId).toBe(paired.bindingId);
    await runNext(2);
    await expect.poll(() => delivered(2).length, { timeout: 12_000 }).toBe(1);
    expect(delivered(2)[0]!.chat_id).toBe(String(f.owner));
    expect(delivered(1)).toHaveLength(0);
    f.online(false);
    await expect.poll(async () => (await status()).connection).toBe('offline');
    await runNext(3);
    await expect.poll(async () => (await status()).pendingOutbox).toBeGreaterThan(0);
    await setDelivery(false);
    expect((await schedules())[0]!.telegramDelivery).toBeUndefined();
    f.online(true);
    await expect.poll(status, { timeout: 15_000 }).toMatchObject({ connection: 'online', pendingOutbox: 0 });
    expect(delivered(1)).toHaveLength(0);
    expect(delivered(2)).toHaveLength(1);
    expect(delivered(3)).toHaveLength(0);
  } finally {
    await app?.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
