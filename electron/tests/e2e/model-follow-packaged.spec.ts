import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PersistentScheduleInput } from '../../src/shared/automation';

const legacyDigest = '5a5608877086fad515877421f04c6d037f0c50e97422e362fb020f8331ee69eb';
const oldModel = 'gpt-6.1-sol';
const availableModel = 'gpt-6.2-sol';
const models = ['m1', 'm2', 'm3', oldModel, availableModel];
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

async function launch(executable: string, root: string, expectedDigest: string): Promise<{ app: ElectronApplication; page: Page }> {
  const resolved = await realpath(executable);
  const asar = resolve(resolved, '../../Resources/app.asar');
  expect(hash(await readFile(asar))).toBe(expectedDigest);
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ executablePath: resolved, args: [`--deskpet-isolated-profile=${root}`, '--use-mock-keychain'], env, timeout: 55_000 });
  try {
    const identity = await app.evaluate(({ app }) => ({ path: app.getPath('userData'), asar: app.getAppPath(), packaged: app.isPackaged }));
    expect(identity).toEqual({ path: join(root, 'profile'), asar, packaged: true });
    await app.evaluate(({ dialog, Notification }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      Notification.prototype.show = function show() { return undefined; };
    });
    await expect.poll(() => app.windows().some(window => window.url().includes('/main_window/')), { timeout: 30_000 }).toBe(true);
    const page = app.windows().find(window => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

// eslint-disable-next-line no-empty-pattern
test('installed-version migration, provider confirmation, and local model repair with real loopback requests', async ({}, info) => {
  const oldExecutable = process.env.DESKPET_MODEL_FOLLOW_LEGACY_APP;
  const candidate = process.env.DESKPET_PACKAGED_APP;
  const candidateDigest = process.env.DESKPET_EXPECTED_ASAR_SHA256;
  test.skip(!oldExecutable || !candidate || !candidateDigest, 'Exact legacy and candidate packages are required.');
  test.setTimeout(240_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-model-follow-')));
  const evidence = process.env.DESKPET_MODEL_FOLLOW_EVIDENCE ?? info.outputDir;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }), { mode: 0o600 });
  const requests: Array<{ model: string; response: number }> = [];
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: models.map(id => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; stream?: boolean };
      const status = input.model === oldModel ? 404 : 200;
      requests.push({ model: input.model, response: status });
      if (status === 404) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'model_not_found', message: 'fixture model retired' } }));
      } else if (input.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Synthetic model reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic model reply' }, finish_reason: 'stop' }] }));
      }
    });
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((done, failed) => server.once('error', failed).listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback port');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    let page: Page;
    ({ app, page } = await launch(oldExecutable!, root, legacyDigest));
    const providerId = randomUUID(), unavailableProvider = randomUUID();
    const legacy = await page.evaluate(async ({ baseUrl, providerId, unavailableProvider }) => {
      await window.deskpet.app.setLocale('zh-CN');
      await window.deskpet.autoMemory.configure({ enabled: false });
      const common = { kind: 'lm-studio' as const, baseUrl, enabled: true, supportsTools: false, localExecutionConfirmed: true };
      await window.deskpet.providers.upsert({ ...common, id: providerId, name: '跟随测试 P', model: 'm1' });
      await window.deskpet.providers.upsert({ ...common, id: unavailableProvider, name: '退役模型测试', model: 'gpt-6.2-sol' });
      await window.deskpet.permissions.request({ capabilityId: 'automation.text', duration: 'always' });
      return window.deskpet.providers.select(providerId);
    }, { baseUrl, providerId, unavailableProvider });
    expect(legacy.activeProviderId).toBe(providerId);
    const schedule = (title: string, provider: string, model: string | null): PersistentScheduleInput => ({
      id: randomUUID(), title, providerId: provider, model, instruction: 'Synthetic schedule instruction', material: '',
      privacy: 'local-only', rule: { kind: 'once', at: '2099-11-21T11:00:00.000Z' }, timezone: 'Asia/Shanghai',
      missedPolicy: 'skip', enabled: true,
    });
    const equal = schedule('旧版同默认', providerId, 'm1'), other = schedule('旧版自选 m2', providerId, 'm2');
    const retired = schedule('早安测试', unavailableProvider, oldModel);
    for (const input of [equal, other, retired]) await page.evaluate(input => window.deskpet.automation.scheduleUpsert(input), input);
    await page.evaluate(id => window.deskpet.qq.configure({ providerId: id, model: 'm1' }), providerId);
    const snapshot = () => page.evaluate(() => window.deskpet.automation.snapshot());
    const selectedSchedules = async () => (await snapshot()).automationSchedules.map(({ title, model }) => ({ title, model }));
    const before = await selectedSchedules();
    expect(before).toEqual([{ title: equal.title, model: 'm1' }, { title: other.title, model: 'm2' }, { title: retired.title, model: oldModel }]);
    await app.close(); app = undefined;
    const listener = join(root, 'profile', 'wechat-channel', 'listener');
    await mkdir(listener, { recursive: true, mode: 0o700 });
    const groupId = 'a'.repeat(32), friendId = 'b'.repeat(32);
    const cloudPath = join(listener, 'cloud-settings.json'), friendPath = join(listener, 'friend-cloud-settings.json');
    const privateRoute = { providerId, model: 'm1' }, groupRoute = { providerId, model: 'm2' };
    const cloudFixture = { private: privateRoute, groups: { [groupId]: groupRoute },
      destinations: { private: '5'.repeat(64), [groupId]: '6'.repeat(64) } };
    const friendFixture = { friends: { [friendId]: privateRoute }, destinations: { [`friend:${friendId}`]: '7'.repeat(64) } };
    await writeFile(cloudPath, JSON.stringify(cloudFixture), { mode: 0o600 });
    await writeFile(friendPath, JSON.stringify(friendFixture), { mode: 0o600 });
    const path = join(root, 'profile', 'profile.enc.json');
    const qqPath = join(root, 'profile', 'qq-channel-state.enc.json');
    const legacyProfileHash = hash(await readFile(path));
    ({ app, page } = await launch(candidate!, root, candidateDigest!));
    const after = await selectedSchedules();
    expect(after).toEqual([{ title: equal.title, model: null }, { title: other.title, model: 'm2' }, { title: retired.title, model: oldModel }]);
    expect(await page.evaluate(() => window.deskpet.qq.getState())).toMatchObject({ model: null });
    expect(await page.evaluate(() => window.deskpet.wechat.getCloud())).toMatchObject({ available: false });
    const cloudBytes = await readFile(cloudPath), friendBytes = await readFile(friendPath);
    expect(JSON.parse(cloudBytes.toString())).toEqual({ ...cloudFixture, private: { ...privateRoute, follow: true } });
    expect(JSON.parse(friendBytes.toString())).toEqual({ ...friendFixture, friends: { [friendId]: { ...privateRoute, follow: true } } });
    const migratedHash = hash(await readFile(path));
    const qqMigratedHash = hash(await readFile(qqPath));
    expect(migratedHash).not.toBe(legacyProfileHash);
    await app.close(); app = undefined;
    ({ app, page } = await launch(candidate!, root, candidateDigest!));
    const secondStartHash = hash(await readFile(path));
    expect(secondStartHash).toBe(migratedHash);
    expect(hash(await readFile(qqPath))).toBe(qqMigratedHash);
    expect(await readFile(cloudPath)).toEqual(cloudBytes);
    expect(await readFile(friendPath)).toEqual(friendBytes);
    expect(await selectedSchedules()).toEqual(after);

    const newFollow = schedule('新建跟随', providerId, null), pin = schedule('确认弹窗固定 m1', providerId, 'm1');
    for (const input of [newFollow, pin]) await page.evaluate(input => window.deskpet.automation.scheduleUpsert(input), input);
    const chat = await page.evaluate(() => window.deskpet.chat.createSession({ title: '跟随测试聊天', kind: 'normal' }));
    expect(chat.modelSelection).toEqual({ providerId, model: null });
    await page.reload();
    await page.locator('nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型服务', exact: true }).click();
    const service = page.getByRole('article', { name: '跟随测试 P', exact: true });
    await service.getByRole('button', { name: '更换默认模型', exact: true }).click();
    const choice = service.getByRole('combobox', { name: '跟随测试 P 模型', exact: true });
    const modal = page.getByRole('dialog', { name: '同步单独指定的模型' });
    await choice.selectOption('m3');
    await expect(modal.getByRole('checkbox', { name: /确认弹窗固定 m1/u })).toBeChecked();
    await expect(modal.getByText('日程', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'confirm-default-model.png'), scale: 'css', animations: 'disabled' });
    await modal.getByRole('button', { name: '保留', exact: true }).click();
    await expect(choice).toHaveValue('m3');
    expect((await selectedSchedules()).find(item => item.title === pin.title)?.model).toBe('m1');
    const run = async (id: string, model: string, status: 'succeeded' | 'failed') => {
      const offset = requests.length;
      const trigger = await page.evaluate(id => window.deskpet.automation.scheduleRunNow({ id, operationId: crypto.randomUUID() }), id);
      await expect.poll(async () => (await snapshot()).jobs.find(job => job.operationId === trigger.id)?.status, { timeout: 25_000 }).toBe(status);
      expect(requests.slice(offset)).toContainEqual({ model, response: status === 'succeeded' ? 200 : 404 });
    };
    await run(pin.id, 'm1', 'succeeded');
    await choice.selectOption('m1');
    await expect(choice).toHaveValue('m1');
    const impact = await page.evaluate(id => window.deskpet.providers.defaultModelImpact!(id), providerId);
    expect(impact?.followers).toBeGreaterThanOrEqual(6);
    await choice.selectOption('m3');
    await modal.getByRole('button', { name: '一起改', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /个功能会跟着使用新模型/u })).toContainText(`${impact!.followers + 1} 个功能`);
    for (const input of [equal, newFollow, pin]) await run(input.id, 'm3', 'succeeded');
    await run(other.id, 'm2', 'succeeded');
    const chatOffset = requests.length;
    await page.evaluate(sessionId => window.deskpet.chat.send({ sessionId, content: 'Synthetic follow-mode chat' }), chat.id);
    await expect.poll(() => requests.slice(chatOffset).some(request => request.model === 'm3')).toBe(true);
    await run(retired.id, oldModel, 'failed');
    const badChat = await page.evaluate(async providerId => {
      const session = await window.deskpet.chat.createSession({ title: '退役模型聊天', kind: 'normal' });
      await window.deskpet.chat.setModelSelection(session.id, { providerId, model: 'gpt-6.1-sol' });
      await window.deskpet.chat.send({ sessionId: session.id, content: 'Synthetic pinned chat' });
      return session;
    }, unavailableProvider);

    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: /^运行状态/u }).click();
    await expect(page.locator('.health-panel').getByRole('heading', { name: retired.title })).toBeVisible();
    await expect(page.locator('.health-panel').getByRole('heading', { name: badChat.title })).toBeVisible();
    await page.getByRole('tab', { name: '医生', exact: true }).click();
    const issue = page.locator('.doctor-panel article').filter({ has: page.getByRole('heading', { name: retired.title }) });
    const chatIssue = page.locator('.doctor-panel article').filter({ has: page.getByRole('heading', { name: badChat.title }) });
    await expect(issue).toContainText(oldModel);
    await expect(issue).toContainText('退役模型测试');
    await expect(chatIssue).toContainText(oldModel);
    await page.screenshot({ path: join(evidence, 'doctor-pinned-model.png'), scale: 'css', animations: 'disabled' });
    await issue.locator('..').screenshot({ path: join(evidence, 'doctor-model-cards.png'), scale: 'css', animations: 'disabled' });
    await issue.getByRole('button', { name: `改为跟随默认模型（${availableModel}）`, exact: true }).click();
    await expect(issue).toHaveCount(0);
    await run(retired.id, availableModel, 'succeeded');
    await chatIssue.getByRole('button', { name: `改为跟随默认模型（${availableModel}）`, exact: true }).click();
    await expect(chatIssue).toHaveCount(0);
    const repairedOffset = requests.length;
    await page.evaluate(sessionId => window.deskpet.chat.send({ sessionId, content: 'Synthetic repaired chat' }), badChat.id);
    await expect.poll(() => requests.slice(repairedOffset)).toContainEqual({ model: availableModel, response: 200 });
    await writeFile(join(evidence, 'migration-and-requests.json'), JSON.stringify({
      legacyDigest, candidateDigest, legacyProfileHash, migratedHash, secondStartHash, before, after,
      qqMigratedHash, listenerFilesUnchangedOnSecondStart: true, followingCount: impact!.followers + 1, requests,
    }, null, 2));
  } finally {
    await app?.close().catch(() => undefined);
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
