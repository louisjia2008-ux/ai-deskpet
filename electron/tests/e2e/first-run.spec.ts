import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPOSED_DOMAINS = ['app', 'attention', 'autoMemory', 'automation', 'backup', 'character', 'chat', 'chatWork', 'coding', 'companionRecent', 'consolidation', 'delegations', 'imports', 'jobs', 'journal', 'knowledge', 'media', 'memory', 'memoryRecall', 'memorySleep', 'migration', 'minecraftCompanion', 'minecraftDedicated', 'permissions', 'persona', 'plugins', 'proactive', 'providers', 'qq', 'rea', 'recovery', 'relationship', 'research', 'speech', 'tasks', 'telegram', 'timers', 'usage', 'vmSandbox', 'wechat', 'wechatDigests', 'wechatFollowup', 'wechatInbox'];


let application: ElectronApplication;
let consolePage: Page;
let profile: string;
let mainProcessOutput = '';

const launch = async (): Promise<void> => {
  application = await electron.launch({
    args: [join(process.cwd(), '.webpack', process.arch, 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile },
  });
  mainProcessOutput = '';
  const recordOutput = (chunk: Buffer | string): void => {
    mainProcessOutput = (mainProcessOutput + chunk.toString()).slice(-32_768);
  };
  application.process().stdout?.on('data', recordOutput);
  application.process().stderr?.on('data', recordOutput);
  await expect.poll(() => application.windows().map((page) => page.url())).toContain('deskpet://app/main_window/index.html');
  const selected = application.windows().find((page) => page.url() === 'deskpet://app/main_window/index.html');
  if (selected === undefined) throw new Error('DeskPet Electron console window did not open.');
  consolePage = selected;
  await consolePage.waitForLoadState('domcontentloaded');
  await expect(consolePage.locator('.app-shell')).toBeVisible();
};

const shutdown = async (): Promise<void> => {
  const child = application.process();
  const assertCleanExit = (): void => {
    expect(child.signalCode, 'Electron must exit without a termination signal').toBeNull();
    expect(child.exitCode, 'Electron must exit successfully').toBe(0);
    expect(mainProcessOutput, 'Electron main process must not report an uncaught teardown error')
      .not.toMatch(/Uncaught Exception|uncaughtException|Object has been destroyed/i);
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    assertCleanExit();
    return;
  }
  const waitForExit = once(child, 'exit');
  void application.close().catch(() => undefined);
  const graceful = await Promise.race([
    waitForExit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (graceful) {
    assertCleanExit();
    return;
  }
  child.kill('SIGTERM');
  const terminated = await Promise.race([
    waitForExit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!terminated) {
    child.kill('SIGKILL');
    await waitForExit;
  }
  throw new Error('Electron did not quit gracefully within 5 seconds; the test process was cleaned up, but shutdown failed.');
};

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'deskpet-electron-e2e-'));
  await launch();
});

test.afterAll(async () => {
  try {
    if (application !== undefined) await shutdown();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('starts the sandboxed console and overlay in truthful first-run state', async () => {
  const titles = await Promise.all(application.windows().map((page) => page.title()));
  expect(titles).toContain('DeskPet Electron');
  expect(titles).toContain('DeskPet Companion');
  const security = await application.evaluate(async ({ BrowserWindow }) => Promise.all(BrowserWindow.getAllWindows().map(async (window) => ({
    title: window.getTitle(),
    globals: await window.webContents.executeJavaScript('({ hasRequire: typeof require !== "undefined", hasProcess: typeof process !== "undefined" })') as { hasRequire: boolean; hasProcess: boolean },
    url: window.webContents.getURL(),
  }))));
  expect(security).toHaveLength(2);
  expect(security.every((window) => !window.globals.hasRequire && !window.globals.hasProcess)).toBe(true);
  expect(security.every((window) => window.url.startsWith('deskpet://app/'))).toBe(true);
  await consolePage.locator('nav').getByRole('button', { name: /Companion|陪伴/ }).click();
  await expect(consolePage.getByText(/Cubism Core/).first()).toBeVisible();
});

test('switches language, surfaces capabilities, and keeps preload narrow', async () => {
  const exposed = await consolePage.evaluate(async () => {
    const api = window.deskpet;
    await api.app.setLocale('en');
    const state = await api.app.getState();
    return {
      domains: Object.keys(api).sort(),
      sleepMethods: Object.keys(api.memorySleep).sort(),
      journalMethods: Object.keys(api.journal!).sort(),
      speechMethods: Object.keys(api.speech!).sort(),
      knowledgeMethods: Object.keys(api.knowledge).sort(),
      hasGenericSend: 'send' in (api as unknown as Record<string, unknown>),
      locale: state.resolvedLocale,
      hotkeyRegistered: state.hotkeyRegistered,
      capabilities: state.capabilities,
    };
  });
  // Every domain is a deliberate part of the renderer's surface; a new one must be added here on purpose.
  expect(exposed.domains).toEqual(EXPOSED_DOMAINS);
  expect(exposed.sleepMethods).toEqual(['configure', 'runNow', 'status', 'undo']);
  expect(exposed.journalMethods).toEqual(['configure', 'edit', 'list', 'preferences', 'remove']);
  expect(exposed.speechMethods).toEqual(['cancel', 'configure', 'prepare', 'status', 'transcribe']);
  expect(exposed.knowledgeMethods).toEqual(['ask', 'chooseVault', 'detach', 'getState', 'listFolders', 'reindex', 'search',
    'setAutoIndex', 'setDiarySync', 'setEmbeddingModel', 'setFolderSharing', 'setWritableFolders']);
  const overlay = application.windows().find(page => page !== consolePage)!;
  await expect(overlay.evaluate(() => window.deskpet.knowledge.listFolders())).rejects.toThrow();
  await expect(overlay.evaluate(() => window.deskpet.knowledge.setDiarySync({ enabled: true, folder: '日记' }))).rejects.toThrow();
  await expect(overlay.evaluate(() => window.deskpet.journal!.list())).rejects.toThrow();
  await expect(overlay.evaluate(() => window.deskpet.speech!.status())).rejects.toThrow();
  expect(exposed.hasGenericSend).toBe(false);
  expect(exposed.locale).toBe('en');
  expect(typeof exposed.hotkeyRegistered).toBe('boolean');
  expect(exposed.capabilities.length).toBeGreaterThan(0);
  await expect(consolePage.getByRole('button', { name: 'Settings' })).toBeVisible();
});

test('exposes Minecraft play without connecting or enabling a model on first run', async () => {
  await consolePage.locator('nav').getByRole('button', { name: /^(Tools|工具)$/ }).click();
  await consolePage.getByRole('tab', { name: /Minecraft|陪玩/ }).click();
  const state = await consolePage.evaluate(() => window.deskpet.minecraftCompanion!.getState());
  expect(state.runtimeState).toBe('stopped');
  expect(state.connectionState).toBe('disconnected');
  expect(state.config).toBeNull();
  expect(state.auth).toBeNull();
  await expect(consolePage.locator('.minecraft-page').getByRole('button', { name: /^(Connect basic chat|连接机器人)$/ })).toBeVisible();
  const fit = await consolePage.locator('.minecraft-page').evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.width + 1);
  await mkdir(join(process.cwd(), 'evidence'), { recursive: true });
  await consolePage.screenshot({ path: join(process.cwd(), 'evidence', 'minecraft-console.png') });
  await consolePage.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
  await expect(consolePage.getByRole('tab', { name: '陪玩', exact: true })).toBeVisible();
  await consolePage.screenshot({ path: join(process.cwd(), 'evidence', 'minecraft-console-zh.png') });
  await consolePage.evaluate(() => window.deskpet.app.setLocale('en'));
  await expect(consolePage.getByLabel('Port', { exact: true })).toBeVisible();
});

test('starts the real Minecraft helper and shows a refused connection without inventing world state', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a fixture TCP port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await consolePage.getByLabel('Port', { exact: true }).fill(String(port));
  await consolePage.getByLabel('Version', { exact: true }).fill('1.21.8');
  await consolePage.getByRole('button', { name: 'Connect basic chat', exact: true }).click();
  await expect.poll(async () => (await consolePage.evaluate(() => window.deskpet.minecraftCompanion!.getState())).connectionState).toBe('error');
  const state = await consolePage.evaluate(() => window.deskpet.minecraftCompanion!.getState());
  expect(state.observation).toBeNull();
  expect(state.connectionState).toBe('error');
  expect(state.lastError).toMatch(/ECONNREFUSED/u);
  await expect(consolePage.getByRole('alert')).toBeVisible();
  await consolePage.evaluate(() => window.deskpet.minecraftCompanion!.disconnect());
  await expect.poll(async () => (await consolePage.evaluate(() => window.deskpet.minecraftCompanion!.getState())).runtimeState).toBe('stopped');
});

test('persists a task across an application restart when secure storage is available', async () => {
  const diagnostics = await consolePage.evaluate(() => window.deskpet.app.getDiagnostics());
  test.skip(diagnostics.vault.state !== 'ready', 'Secure storage is intentionally unavailable on this CI desktop.');
  const taskId = await consolePage.evaluate(async () => {
    const id = crypto.randomUUID();
    await window.deskpet.tasks.upsert({ id, title: 'E2E persisted task', notes: '', status: 'todo', dueAt: null });
    return id;
  });
  await shutdown();
  await launch();
  const tasks = await consolePage.evaluate(() => window.deskpet.tasks.list());
  expect(tasks.some((task) => task.id === taskId && task.title === 'E2E persisted task')).toBe(true);
});
