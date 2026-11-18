import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const core = process.env.DESKPET_LIVE2D_CORE;
const model = process.env.DESKPET_LIVE2D_MODEL;
// Playwright requires destructuring even when this Electron test uses no browser fixtures.
// eslint-disable-next-line no-empty-pattern
test('loads real Kitty assets, repeats its motion, scales without reload and restores its expression after restart', async ({}, testInfo) => {
  test.skip(core === undefined || model === undefined, 'Local, user-supplied Core and Kitty ZIP are required; never bundle these assets.');
  test.setTimeout(240_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-live2d-runtime-e2e-'));
  let application: ElectronApplication | undefined;
  let consolePage!: Page;
  let overlay!: Page;
  const errors: string[] = [];
  const modelRequests: string[] = [];
  const consoleModelRequests: string[] = [];
  let finishReply: (() => void) | undefined;
  let replyCount = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: {} } : { data: [{ id: 'fixture' }] })); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const content = replyCount++ === 0 ? '谢谢你喜欢 Kitty，抱抱。' : '听起来很伤心，Kitty 陪着你。';
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
      finishReply = () => response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  const launch = async (): Promise<void> => {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main', 'index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application?.windows().some((page) => page.url().includes('/overlay_window/'))).toBe(true);
    const pages = application.windows();
    const selectedConsole = pages.find((page) => page.url().includes('/main_window/'));
    const selectedOverlay = pages.find((page) => page.url().includes('/overlay_window/'));
    if (selectedConsole === undefined || selectedOverlay === undefined) throw new Error('Expected both application windows.');
    consolePage = selectedConsole; overlay = selectedOverlay;
    consolePage.on('request', (request) => { if (request.url().startsWith('deskpet://managed/')) consoleModelRequests.push(request.url()); });
    overlay.on('pageerror', (error) => errors.push(error.message));
    overlay.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    overlay.on('request', (request) => { if (request.url().endsWith('.model3.json')) modelRequests.push(request.url()); });
    await consolePage.waitForSelector('.app-shell');
  };
  const ready = async (): Promise<void> => {
    await expect(overlay.locator('main')).toHaveAttribute('data-load-state', 'ready');
    await expect.poll(async () => (await consolePage.evaluate(() => window.deskpet.character.getState())).pendingImportId).toBeNull();
  };
  try {
    await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    await launch();
    if (application === undefined || core === undefined || model === undefined) throw new Error('Missing local Live2D configuration.');
    await application.evaluate(({ dialog }, selections: string[]) => {
      // Replace only the native picker in this runtime regression. The import,
      // acknowledgement, managed protocol, WebGL and persistence remain real.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selections.shift() ?? ''] });
    }, [core, model, model]);
    await consolePage.evaluate(async () => { await window.deskpet.character.importCore(); await window.deskpet.character.importModel(); });
    await ready();
    await consolePage.locator('nav').getByRole('button', { name: /Chat|聊天/, exact: true }).click();
    await expect(consolePage.locator('.character-stage')).toHaveAttribute('data-preview-state', 'live');
    await expect(consolePage.getByRole('img', { name: /Live2D$/ })).toBeVisible();
    const firstFrame = await consolePage.locator('.live-preview-image').getAttribute('src');
    expect(firstFrame).toMatch(/^data:image\/png;base64,/);
    await expect.poll(() => consolePage.locator('.live-preview-image').getAttribute('src')).not.toBe(firstFrame);
    expect(consoleModelRequests).toEqual([]);
    const first = await consolePage.evaluate(() => window.deskpet.character.getState());
    expect(first.expressions).toContain('Watermark');
    // Replacing a loaded model previously reused a lost WebGL context.
    await consolePage.evaluate(() => window.deskpet.character.importModel());
    await ready();
    expect((await consolePage.evaluate(() => window.deskpet.character.getState())).modelUrl).not.toBe(first.modelUrl);
    const loadedRequests = modelRequests.length;
    await consolePage.evaluate(async () => {
      for (const scale of [0.5, 0.5, 0.7, 1]) await window.deskpet.character.setScale(scale);
      await window.deskpet.character.setExpression('Watermark');
      await Promise.all([window.deskpet.character.playAction('interact'), window.deskpet.character.playAction('interact')]);
    });
    await expect(overlay.locator('main')).toHaveAttribute('data-actions-played', '2');
    expect(modelRequests).toHaveLength(loadedRequests);
    const before = await consolePage.evaluate(() => window.deskpet.character.getState());
    expect(before).toMatchObject({ scale: 1, expression: 'Watermark', actionRevision: 2 });
    // Let the model expression fade and the scheduled visible-bounds fit settle.
    await overlay.waitForTimeout(1_600);
    await overlay.screenshot({ path: testInfo.outputPath('kitty-watermark-hidden.png'), omitBackground: true });
    // Exercise the production main -> preload -> overlay -> SDK gaze path,
    // including points outside the transparent window. Native mouse acceptance
    // is separate; this deterministic fixture replaces only the OS cursor read.
    const position = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/overlay_window/'))!.getContentBounds());
    const gaze = async (x: number, expected: 'left' | 'right'): Promise<void> => {
      await application!.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point; }, { x, y: position.y + 180 });
      const direction = async (): Promise<number> => Number((await overlay.locator('canvas').getAttribute('data-gaze'))?.split(',')[0] ?? 0);
      if (expected === 'left') await expect.poll(direction).toBeLessThan(-0.5);
      else await expect.poll(direction).toBeGreaterThan(0.5);
      await overlay.screenshot({ path: testInfo.outputPath(`kitty-gaze-${expected}.png`), omitBackground: true });
    };
    await gaze(position.x - 500, 'left'); await gaze(position.x + position.width + 500, 'right');
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('Missing local chat fixture.');
    await consolePage.evaluate(async (endpoint) => {
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), name: 'Kitty local QA', kind: 'ollama', model: 'fixture', baseUrl: endpoint, enabled: true, supportsTools: false });
    }, `http://127.0.0.1:${address.port}/v1`);
    const composer = consolePage.locator('.composer textarea');
    await composer.fill('Kitty，你真可爱。'); await composer.press('Enter');
    await expect(consolePage.getByText('谢谢你喜欢 Kitty，抱抱。', { exact: true })).toBeVisible();
    await expect(overlay.locator('canvas')).toHaveAttribute('data-reaction', 'love');
    await expect(consolePage.locator('.message.assistant').last()).toHaveAttribute('data-status', 'streaming');
    // The old implementation did not react before completion, and a temporary
    // face expired after 4.5 s. Hold a real SSE stream beyond both old limits.
    await overlay.waitForTimeout(7_000);
    await expect(overlay.locator('canvas')).toHaveAttribute('data-reaction', 'love');
    await overlay.screenshot({ path: testInfo.outputPath('kitty-chat-reaction-streaming.png'), omitBackground: true });
    await consolePage.screenshot({ path: testInfo.outputPath('kitty-chat-preview-streaming.png') });
    expect((await consolePage.evaluate(() => window.deskpet.character.getState())).expression).toBe('Watermark');
    finishReply?.();
    await expect(consolePage.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(overlay.locator('canvas')).not.toHaveAttribute('data-reaction', /.+/, { timeout: 9_000 });
    await composer.fill('Kitty，今天我有点伤心。'); await composer.press('Enter');
    await expect(overlay.locator('canvas')).toHaveAttribute('data-reaction', 'Cry');
    await expect(consolePage.locator('.message.assistant').last()).toContainText('Kitty 陪着你');
    await overlay.waitForTimeout(450);
    await overlay.screenshot({ path: testInfo.outputPath('kitty-chat-sad-streaming.png'), omitBackground: true });
    finishReply?.();
    await expect(consolePage.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(overlay.locator('canvas')).not.toHaveAttribute('data-reaction', /.+/, { timeout: 9_000 });
    expect((await consolePage.evaluate(() => window.deskpet.character.getState())).expression).toBe('Watermark');
    // Speech bubbles use the same main/preload path as reminders and speech.
    await consolePage.evaluate(() => window.deskpet.character.setBubble('Kitty 的提醒：这条气泡可以手动关闭。'));
    await expect(overlay.getByRole('status')).toContainText('这条气泡可以手动关闭');
    await overlay.screenshot({ path: testInfo.outputPath('kitty-bubble-close.png'), omitBackground: true });
    // Scaled down, the bubble moves over her head; filling the window, it sits under the face.
    await consolePage.evaluate(() => window.deskpet.character.setScale(0.6));
    await expect(overlay.locator('.speech-bubble')).toHaveClass(/is-above/);
    await overlay.screenshot({ path: testInfo.outputPath('kitty-bubble-small.png'), omitBackground: true });
    await consolePage.evaluate(() => window.deskpet.character.setScale(1));
    await expect(overlay.locator('.speech-bubble')).not.toHaveClass(/is-above/);
    const firstBubble = await consolePage.evaluate(() => window.deskpet.character.getState());
    await overlay.getByRole('button', { name: /Close speech bubble|关闭气泡/, exact: true }).focus();
    await overlay.keyboard.press('Enter');
    await expect(overlay.locator('.speech-bubble')).toHaveCount(0);
    await expect.poll(async () => (await consolePage.evaluate(() => window.deskpet.character.getState())).bubble).toBeNull();
    await consolePage.evaluate(() => window.deskpet.character.setBubble('Kitty 的提醒：一分钟后会自动淡出。'));
    const secondBubble = await consolePage.evaluate(() => window.deskpet.character.getState());
    await consolePage.evaluate((revision) => window.deskpet.character.dismissBubble(revision), firstBubble.bubbleRevision!);
    await expect(overlay.getByRole('status')).toContainText('一分钟后会自动淡出');
    await expect(overlay.locator('.speech-bubble')).not.toHaveClass(/is-fading/);
    await expect(overlay.locator('.speech-bubble')).toHaveClass(/is-fading/, { timeout: 62_000 });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(secondBubble.bubbleExpiresAt!));
    await expect(overlay.locator('.speech-bubble')).toHaveCount(0, { timeout: 2_000 });
    await expect.poll(async () => (await consolePage.evaluate(() => window.deskpet.character.getState())).bubble).toBeNull();
    await overlay.screenshot({ path: testInfo.outputPath('kitty-bubble-expired.png'), omitBackground: true });
    // Production can skip each 45-second idle tick (50%) and can pick different
    // facial expressions. Control the draw only in this isolated renderer while
    // observing a real idle cycle. Keep its timer, SDK loading and PIXI ticker live.
    const canvas = overlay.locator('canvas');
    await expect.poll(() => overlay.evaluate(() => document.visibilityState)).toBe('visible');
    await expect(canvas).not.toHaveAttribute('data-reaction', /.+/, { timeout: 9_000 });
    const restoreRandom = await overlay.evaluateHandle(() => {
      const original = Math.random;
      Math.random = () => 0.75; // pass the skip gate and choose the curious mood
      return () => { Math.random = original; };
    });
    try {
      await expect(canvas).toHaveAttribute('data-reaction', /^(?:Star|Blushing|surprised|惊讶)$/iu, { timeout: 65_000 });
      const idleFace = await canvas.getAttribute('data-reaction');
      expect(before.expressions).toContain(idleFace);
      await overlay.waitForTimeout(450);
      await overlay.screenshot({ path: testInfo.outputPath('kitty-idle-reaction.png'), omitBackground: true });
      await expect(canvas).not.toHaveAttribute('data-reaction', /.+/, { timeout: 9_000 });
    } finally {
      await restoreRandom.evaluate(restore => restore());
      await restoreRandom.dispose();
    }
    expect((await consolePage.evaluate(() => window.deskpet.character.getState())).expression).toBe('Watermark');
    await consolePage.evaluate(async () => { await window.deskpet.app.setTheme('light'); await window.deskpet.app.setLocale('zh-CN'); });
    await consolePage.evaluate(() => window.deskpet.chat.createSession({ title: 'Kitty 的一条很长的真实聊天标题，用来检查最近对话会正确截断并且不会出现横向滚动条', kind: 'normal' }));
    const viewportResults: unknown[] = [];
    for (const size of [{ width: 1180, height: 749 }, { width: 1440, height: 1024 }, { width: 900, height: 720 }, { width: 820, height: 620 }]) {
      await application.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/main_window/'))?.setContentSize(size.width, size.height);
      }, size);
      await expect.poll(() => consolePage.evaluate(() => window.innerWidth)).toBe(size.width);
      const fit = await consolePage.evaluate(() => ({
        width: window.innerWidth, height: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        composerBottom: document.querySelector('.composer')?.getBoundingClientRect().bottom ?? Infinity,
        recentWidth: document.querySelector('.sidebar-sessions')?.clientWidth,
        recentScrollWidth: document.querySelector('.sidebar-sessions')?.scrollWidth,
      }));
      expect(fit.scrollWidth).toBe(fit.width); expect(fit.scrollHeight).toBe(fit.height);
      expect(fit.composerBottom).toBeLessThan(fit.height);
      expect(fit.recentScrollWidth).toBe(fit.recentWidth);
      viewportResults.push(fit);
      await consolePage.screenshot({ path: testInfo.outputPath(`console-${size.width}.png`), scale: 'css' });
    }
    const toggle = consolePage.getByRole('button', { name: '展开角色区', exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const drawer = consolePage.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: '收起角色区', exact: true })).toBeFocused();
    await consolePage.keyboard.press('Shift+Tab');
    await expect(drawer.getByRole('button', { name: '管理形象', exact: true })).toBeFocused();
    await consolePage.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await writeFile(testInfo.outputPath('viewports.json'), JSON.stringify(viewportResults, null, 2));
    await application.close(); application = undefined;
    await launch(); await ready();
    expect(await consolePage.evaluate(() => window.deskpet.character.getState())).toMatchObject({ scale: 1, expression: 'Watermark', modelUrl: before.modelUrl });
    await overlay.waitForTimeout(1_600);
    await overlay.screenshot({ path: testInfo.outputPath('kitty-restored.png'), omitBackground: true });
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
