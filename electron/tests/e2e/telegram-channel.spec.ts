import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, realpath, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeTelegram } from './support/fake-telegram';

// Real renderer, IPC, channel store, tool runtime and Electron networking. Only
// the model and Telegram servers are doubles. Inject the network boundary at
// startup: a restored channel can poll before the first renderer is visible.
// eslint-disable-next-line no-empty-pattern
test('Telegram pairs one owner, approves individual operations and results, cancels and recovers delivery', async ({}) => {
  test.setTimeout(160_000);
  const f = await fakeTelegram();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-telegram-')));
  const compiled = join(process.cwd(), '.webpack', process.arch, 'main/index.js'),
    entry = join(root, 'isolated.cjs');
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  await mkdir(join(root, 'profile/workspace'), { recursive: true });
  await writeFile(join(root, 'profile/workspace/phone.txt'), 'LOCAL_TEST_FACT');
  await writeFile(
    entry,
    [
      "const {dialog,net} = require('electron');",
      'dialog.showMessageBox = async (...args) => ({response:args.at(-1)?.cancelId ?? 0,checkboxChecked:false});',
      'const fetchLocal = net.fetch.bind(net);',
      'net.fetch = (url,opts) => { const parsed = new URL(url);',
      "  if (parsed.protocol === 'file:') return fetchLocal(url,opts);",
      "  if (parsed.origin==='https://api.telegram.org') return fetchLocal(" +
        JSON.stringify(f.base) +
        '+parsed.pathname+parsed.search,opts);',
      '  if (parsed.origin===' + JSON.stringify(f.base) + ') return fetchLocal(url,opts);',
      "  throw Error('Unexpected network destination in isolated test'); };",
      'require(' + JSON.stringify(compiled) + ');',
    ].join('\n'),
  );
  let app: ElectronApplication | undefined, page!: Page;
  const start = async () => {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[k]) env[k] = process.env[k]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some((w) => w.url().includes('/main_window/'))).toBe(true);
    page = app.windows().find((w) => w.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
  };
  const state = () => page.evaluate(() => window.deskpet.telegram.getState());
  const safeReply = (s: string) => f.posts.some((p) => p.text === s);
  const cards = () =>
    f.posts.flatMap((p) => p.reply_markup?.inline_keyboard.flat().filter((k) => k.callback_data.startsWith('yes:')) ?? []);
  const rejected = async () => (await state()).diagnostics.filter((d) => d.outcome === 'rejected').length;
  try {
    await start();
    expect(await state()).toMatchObject({ enabled: false, bound: false });
    expect(f.polls()).toBe(0);
    const providerId = await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('en');
      const provider = await window.deskpet.providers.upsert({
        id: crypto.randomUUID(),
        kind: 'lm-studio',
        name: 'Telegram fixture',
        baseUrl,
        model: 'controlled',
        enabled: true,
        supportsTools: true,
        localExecutionConfirmed: true,
      });
      return provider.id;
    }, f.base + '/v1');
    await page.evaluate((input) => window.deskpet.telegram.configure(input), {
      enabled: true,
      token: f.token,
      providerId,
      model: 'controlled',
    });
    const { code } = await page.evaluate(() => window.deskpet.telegram.startPairing());
    f.message('/pair ' + code);
    await expect.poll(async () => (await state()).pairingCandidate?.userId).toBe(String(f.owner));
    expect(f.wires.length).toBe(0);
    const candidate = (await state()).pairingCandidate!;
    const overlay = app!.windows().find((w) => w.url().includes('/overlay_window/'))!;
    expect(
      await overlay.evaluate(async (id) => {
        try {
          await window.deskpet.telegram.confirmPairing(id);
          return true;
        } catch {
          return false;
        }
      }, candidate.id),
    ).toBe(false);
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Telegram', exact: true }).click();
    await expect(page.getByTestId('telegram-settings')).toBeVisible();
    await page.getByTestId('telegram-confirm').click();
    await expect(page.getByTestId('telegram-diagnostics')).toBeVisible();
    await expect.poll(state).toMatchObject({ bound: true, connection: 'online' });
    const bindingSession = (await state()).bindingSessionId;
    const rejectCount = await rejected();
    f.message('stranger should never reach provider', f.stranger);
    await expect.poll(rejected).toBeGreaterThan(rejectCount);
    expect(f.wires.length).toBe(0);
    expect(f.posts.some((p) => String(p.chat_id) === String(f.stranger))).toBe(false);
    f.message('fixture hold');
    await expect.poll(f.held, { timeout: 15_000 }).toBe(true);
    f.message('/append append-only fixture instruction');
    await expect.poll(() => f.posts.some((p) => p.text.includes('已追加'))).toBe(true);
    f.message('queued after cancel');
    f.message('/stop');
    await expect.poll(() => safeReply('Reply: queued after cancel'), { timeout: 15_000 }).toBe(true);
    expect((await state()).bound).toBe(true);
    f.message('fixture delayed');
    await expect.poll(f.held).toBe(true);
    f.online(false);
    await expect.poll(async () => (await state()).connection, { timeout: 15_000 }).toBe('offline');
    f.release('Deliver after reconnection');
    await expect.poll(async () => (await state()).pendingOutbox, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(safeReply('Deliver after reconnection')).toBe(false);
    await app!.close();
    app = undefined;
    f.online(true);
    await start();
    await expect.poll(() => safeReply('Deliver after reconnection'), { timeout: 20_000 }).toBe(true);
    expect(f.posts.filter((p) => p.text === 'Deliver after reconnection')).toHaveLength(1);
    expect((await state()).bindingSessionId).toBe(bindingSession);
    expect((await state()).bound).toBe(true);
    // The local server received both messages, but its contradictory success
    // replies prove neither destination nor receipt. A retry must not duplicate them.
    for (const [n, prompt] of ['fixture missing receipt', 'fixture wrong recipient'].entries()) {
      f.message(prompt);
      await expect.poll(async () => (await state()).uncertainOutbox, { timeout: 15_000 }).toBe(n + 1);
      await page.evaluate(() => window.deskpet.telegram.retryDeliveries());
      expect(f.posts.filter((p) => p.text === 'Reply: ' + prompt)).toHaveLength(1);
    }
    // A standing desktop grant cannot answer a phone operation card.
    await app!.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.evaluate(() => window.deskpet.permissions.request({ capabilityId: 'workspace.read', duration: 'session' }));
    const beforeRead = f.wires.length;
    f.message('fixture read');
    await expect.poll(() => cards().length, { timeout: 15_000 }).toBe(1);
    const readKey = cards()[0]!.callback_data;
    const priorReject = await rejected();
    f.click(readKey, f.stranger);
    await expect.poll(rejected).toBeGreaterThan(priorReject);
    expect(f.wires.length).toBe(beforeRead + 1);
    f.click(readKey);
    await expect.poll(() => cards().length, { timeout: 15_000 }).toBe(2);
    expect(f.posts.some((p) => p.text.includes('LOCAL_TEST_FACT'))).toBe(false);
    const pendingResults = await page.evaluate(() => window.deskpet.telegram.pendingResults());
    expect(pendingResults).toHaveLength(1);
    const pendingResult = pendingResults[0]!;
    expect(pendingResult).toMatchObject({ kind: 'reply', content: 'Read: LOCAL_TEST_FACT' });
    expect(
      f.posts.some((p) => p.text.includes(pendingResult.reference) && p.text.includes(pendingResult.digest.slice(0, 12))),
    ).toBe(true);
    expect(JSON.stringify(await state())).not.toContain('LOCAL_TEST_FACT');
    const privateOverlay = app!.windows().find((w) => w.url().includes('/overlay_window/'))!;
    expect(
      await privateOverlay.evaluate(() =>
        window.deskpet.telegram.pendingResults().then(
          () => false,
          () => true,
        ),
      ),
    ).toBe(true);
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Telegram', exact: true }).click();
    await page.getByRole('button', { name: 'Review pending results' }).click();
    const reviewed = page.getByTestId('telegram-settings').getByRole('article').filter({hasText:pendingResult.reference});
    await expect(reviewed.getByRole('heading',{name:pendingResult.reference,exact:true})).toBeVisible();
    await expect(reviewed.locator('pre')).toHaveText('Read: LOCAL_TEST_FACT');
    await expect(reviewed.locator('pre')).toBeVisible();
    f.click(cards()[1]!.callback_data);
    await expect.poll(() => safeReply('Read: LOCAL_TEST_FACT')).toBe(true);
    f.click(readKey);
    const diagnosticText = JSON.stringify((await state()).diagnostics);
    expect(diagnosticText.includes('LOCAL_TEST_FACT') || diagnosticText.includes(f.token)).toBe(false);
  } finally {
    await app?.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
