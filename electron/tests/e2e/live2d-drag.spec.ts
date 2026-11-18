import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterState } from '../../src/shared';

type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };
type PointerSample = { type: string; id: number; clientX: number; clientY: number; screenX: number; screenY: number; trusted: boolean };
type Evidence = Record<string, unknown>;

/** Chromium input exercises the real renderer/preload/IPC/native window path.
 * It does not prove OS physical-cursor acceptance through click-through windows.
 * The cancel case intentionally supplies one controlled pointercancel event. */
const fixture = async (info: TestInfo) => {
  const executable = process.env.DESKPET_DRAG_APP;
  const syntheticStorage = process.env.DESKPET_DRAG_STORAGE === 'synthetic';
  if (executable && syntheticStorage) throw new Error('Packaged drag validation requires native safeStorage; synthetic storage is development-only.');
  const root = await mkdtemp(join(tmpdir(), 'deskpet-live2d-drag-'));
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  const compiledEntry = join(process.cwd(), '.webpack', process.arch, 'main/index.js');
  const entry = syntheticStorage ? join(root, 'synthetic-storage-entry.cjs') : compiledEntry;
  if (syntheticStorage) await writeFile(entry, `const { safeStorage } = require('electron'); safeStorage.isEncryptionAvailable = () => true; safeStorage.encryptString = value => Buffer.from('SYNTHETIC_DRAG_WRAP:' + value); safeStorage.decryptString = bytes => { const value = bytes.toString(); if (!value.startsWith('SYNTHETIC_DRAG_WRAP:')) throw new Error('Wrong synthetic wrapper'); return value.slice(20); }; require(${JSON.stringify(compiledEntry)});`);
  let application: ElectronApplication | undefined;
  let overlay!: Page;
  const errors: string[] = [];
  const evidence: Evidence = { input: 'Playwright Chromium mouse', pointerCancel: 'Controlled PointerEvent', syntheticStorage, launches: [], steps: [] };
  const bounds = async (): Promise<Bounds> => application!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/overlay_window/'));
    if (!window) throw new Error('Missing real overlay BrowserWindow.');
    return window.getContentBounds();
  });
  const state = async (): Promise<CharacterState> => overlay.evaluate(() => window.deskpet.character.getState());
  const record = (name: string, value: unknown): void => { (evidence.steps as unknown[]).push({ name, value }); };
  const launch = async (): Promise<void> => {
    application = await electron.launch({ ...(executable ? { executablePath: executable, args: [`--deskpet-isolated-profile=${root}`] }
      : { args: [entry, `--deskpet-isolated-profile=${root}`] }), env: { ...process.env, NODE_ENV: 'test' } });
    await expect.poll(() => application!.windows().some((page) => page.url().includes('/overlay_window/'))).toBe(true);
    overlay = application.windows().find((page) => page.url().includes('/overlay_window/'))!;
    await expect(overlay.locator('main.overlay-root')).toBeVisible();
    overlay.on('pageerror', (error) => errors.push(error.message));
    await overlay.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { dragQaSamples?: PointerSample[] };
      runtime.dragQaSamples = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        window.addEventListener(type, (event) => {
          const pointer = event as globalThis.PointerEvent;
          runtime.dragQaSamples!.push({ type, id: pointer.pointerId, clientX: pointer.clientX, clientY: pointer.clientY, screenX: pointer.screenX, screenY: pointer.screenY, trusted: pointer.isTrusted });
          if (runtime.dragQaSamples!.length > 100) runtime.dragQaSamples!.shift();
        }, { capture: true });
      }
    });
    const identity = await application.evaluate(({ app }) => ({ pid: process.pid, appPath: app.getAppPath(), isPackaged: app.isPackaged, userData: app.getPath('userData') }));
    expect(await realpath(identity.userData)).toBe(await realpath(join(root, 'profile')));
    (evidence.launches as unknown[]).push(identity);
  };
  const settlePosition = async (expected: Point): Promise<void> => {
    await expect.poll(async () => { const actual = await bounds(); return { x: actual.x, y: actual.y }; }).toEqual(expected);
    await expect.poll(async () => (await state()).position).toMatchObject(expected);
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(join(root, 'profile/managed/character-preferences.json'), 'utf8')) as { data: { position: Point } };
      return { x: saved.data.position.x, y: saved.data.position.y };
    }).toEqual(expected);
    // Allow the renderer's previous move acknowledgement/coalescing loop to drain.
    await overlay.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))));
  };
  const place = async (): Promise<Bounds> => {
    const area = await application!.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    const current = await bounds();
    test.skip(area.width < current.width + 120 || area.height < current.height + 96, 'The test display needs space for an unclamped drag and default-size restart.');
    const point = { x: area.x + 24, y: area.y + 24 };
    await overlay.evaluate((position) => window.deskpet.character.setPosition({ ...position, displayId: 'current' }), point);
    await settlePosition(point);
    record('initial-native-bounds', await bounds());
    return bounds();
  };
  const moveAtScreenPoint = async (point: Point): Promise<void> => {
    const current = await bounds();
    await overlay.mouse.move(point.x - current.x, point.y - current.y);
  };
  const drag = async (name: string, point: Point, delta: Point): Promise<Point> => {
    const before = await bounds();
    const screenPoint = { x: before.x + point.x + delta.x, y: before.y + point.y + delta.y };
    const expected = { x: before.x + delta.x, y: before.y + delta.y };
    await overlay.mouse.move(point.x, point.y);
    await overlay.mouse.down();
    await moveAtScreenPoint(screenPoint);
    await settlePosition(expected);
    // Chromium mouse coordinates are local to a now-moved window. Rebase them
    // to the unchanged absolute cursor before releasing, avoiding a fake second delta.
    await moveAtScreenPoint(screenPoint);
    await overlay.mouse.up();
    await settlePosition(expected);
    record(name, { before, expected, native: await bounds(), persisted: (await state()).position });
    return expected;
  };
  const unchangedDrag = async (name: string, point: Point, delta: Point): Promise<void> => {
    const before = await bounds();
    await overlay.mouse.move(point.x, point.y); await overlay.mouse.down();
    await overlay.mouse.move(point.x + delta.x, point.y + delta.y); await overlay.mouse.up();
    await overlay.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))));
    await settlePosition({ x: before.x, y: before.y });
    record(name, { before, after: await bounds() });
  };
  const restart = async (expected: Point): Promise<void> => {
    record('pointer-samples-before-restart', await overlay.evaluate(() => (globalThis as typeof globalThis & { dragQaSamples?: PointerSample[] }).dragQaSamples ?? []));
    await application!.close(); application = undefined; await launch(); await settlePosition(expected);
    record('restored-after-process-restart', { native: await bounds(), persisted: (await state()).position });
  };
  const finish = async (): Promise<void> => {
    try {
      if (application && !overlay.isClosed()) {
        evidence.pointerSamples = await overlay.evaluate(() => (globalThis as typeof globalThis & { dragQaSamples?: PointerSample[] }).dragQaSamples ?? []);
        await overlay.screenshot({ path: info.outputPath('overlay-final.png'), omitBackground: true }).catch(() => undefined);
      }
      evidence.errors = errors;
      await mkdir(info.outputDir, { recursive: true });
      await writeFile(info.outputPath('drag-evidence.json'), JSON.stringify(evidence, null, 2));
    } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
  };
  return { root, launch, place, bounds, state, record, drag, unchangedDrag, restart, settlePosition, moveAtScreenPoint, errors, finish,
    application: () => application!, overlay: () => overlay };
};

// eslint-disable-next-line no-empty-pattern
test('handle pointer drag moves the native overlay, stops on cancel and restores persisted position', async ({}, info) => {
  test.setTimeout(90_000);
  const f = await fixture(info);
  try {
    await f.launch(); await f.place();
    const handle = f.overlay().getByRole('button', { name: /Drag companion|拖动/, exact: false });
    const box = await handle.boundingBox(); if (!box) throw new Error('The real drag handle is not visible.');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await f.drag('handle-pointer-drag', point, { x: 36, y: 24 });
    const beforeCancel = await f.bounds();
    await f.overlay().mouse.move(point.x, point.y); await f.overlay().mouse.down();
    const pointerId = await f.overlay().evaluate(() => (globalThis as typeof globalThis & { dragQaSamples: PointerSample[] }).dragQaSamples.filter((event) => event.type === 'pointerdown').at(-1)!.id);
    const partial = { x: beforeCancel.x + 12, y: beforeCancel.y + 12 };
    const absolute = { x: beforeCancel.x + point.x + 12, y: beforeCancel.y + point.y + 12 };
    await f.moveAtScreenPoint(absolute); await f.settlePosition(partial);
    await f.overlay().locator('main.overlay-root').dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, button: 0, screenX: absolute.x + 200, screenY: absolute.y + 200 });
    await f.moveAtScreenPoint({ x: absolute.x + 20, y: absolute.y + 20 }); await f.overlay().mouse.up();
    await f.settlePosition(partial); f.record('cancel-stops-additional-movement', { native: await f.bounds(), persisted: (await f.state()).position });
    await f.unchangedDrag('transparent-pixels-do-not-drag', { x: 4, y: 80 }, { x: 12, y: 8 });
    const control = await f.overlay().locator('.setup-card').boundingBox(); if (!control) throw new Error('The isolated no-model setup control should be visible.');
    await f.unchangedDrag('setup-control-does-not-drag', { x: control.x + control.width / 2, y: control.y + control.height / 2 }, { x: 8, y: 2 });
    await f.restart(partial); expect(f.errors).toEqual([]);
  } finally { await f.finish(); }
});

// eslint-disable-next-line no-empty-pattern
test('opaque Live2D body pointer drag moves the native overlay and restores position without dragging controls', async ({}, info) => {
  const core = process.env.DESKPET_LIVE2D_CORE, model = process.env.DESKPET_LIVE2D_MODEL;
  test.skip(!core || !model, 'Explicit local, user-owned Core and model ZIP paths are required; never bundle them.');
  test.setTimeout(120_000);
  const f = await fixture(info);
  try {
    await f.launch(); await f.place();
    await f.application().evaluate(({ dialog }, paths: string[]) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift()!] }); }, [core!, model!]);
    const consolePage = f.application().windows().find((page) => page.url().includes('/main_window/'))!;
    await consolePage.evaluate(async () => { await window.deskpet.character.importCore(); await window.deskpet.character.importModel(); });
    await expect(f.overlay().locator('main')).toHaveAttribute('data-load-state', 'ready');
    await expect.poll(async () => (await f.state()).pendingImportId).toBeNull();
    await f.overlay().evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))));
    const rendered = await f.overlay().screenshot({ omitBackground: true, scale: 'css' });
    const point = await f.overlay().evaluate(async (png): Promise<Point> => {
      const image = new window.Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const candidates: Array<Point & { distance: number }> = [];
      for (let y = Math.round(canvas.height * 0.35); y < canvas.height * 0.85; y += 4) for (let x = Math.round(canvas.width * 0.2); x < canvas.width * 0.8; x += 4) {
        let opaque = true;
        for (const [dx, dy] of [[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4]]) if ((pixels[((y + dy!) * canvas.width + x + dx!) * 4 + 3] ?? 0) < 200) opaque = false;
        if (opaque) candidates.push({ x, y, distance: Math.hypot(x - canvas.width / 2, y - canvas.height * 0.6) });
      }
      const result = candidates.sort((left, right) => left.distance - right.distance)[0];
      if (!result) throw new Error('No sufficiently opaque model body patch was rendered.');
      return { x: result.x, y: result.y };
    }, rendered.toString('base64'));
    f.record('opaque-body-start-point', point);
    const expected = await f.drag('opaque-model-body-pointer-drag', point, { x: 36, y: 24 });
    await f.unchangedDrag('loaded-transparent-pixels-do-not-drag', { x: 4, y: 80 }, { x: 12, y: 8 });
    await consolePage.evaluate(() => window.deskpet.character.setBubble('Synthetic drag regression bubble.'));
    const close = f.overlay().getByRole('button', { name: /Close speech bubble|关闭气泡/ });
    const button = await close.boundingBox(); if (!button) throw new Error('Expected the speech bubble control.');
    await f.unchangedDrag('speech-control-does-not-drag', { x: button.x + button.width / 2, y: button.y + button.height / 2 }, { x: 3, y: 2 });
    await f.restart(expected); await expect(f.overlay().locator('main')).toHaveAttribute('data-load-state', 'ready'); expect(f.errors).toEqual([]);
  } finally { await f.finish(); }
});
