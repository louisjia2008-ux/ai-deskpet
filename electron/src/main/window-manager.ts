import { BrowserWindow, nativeTheme, screen, shell, Tray, Menu } from 'electron';
import type { MenuItemConstructorOptions, WebContents } from 'electron';

import type { CharacterState, CompanionPointer, WindowRole } from '../shared';
import { createTrayIcon } from './tray-icon';

export interface WindowManagerActions {
  toggleOverlay(): void;
  showConsole(): void;
  showAttention?(): void;
  quit(): void;
}

export const secureWebPreferences = (preload: string): Electron.WebPreferences => ({
  preload,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  spellcheck: false,
});

export class WindowManager {
  #console: BrowserWindow | null = null;
  #overlay: BrowserWindow | null = null;
  #tray: Tray | null = null;
  readonly #roles = new Map<number, WindowRole>();
  #preview: { frame: string | null; capturedAt: number } = { frame: null, capturedAt: 0 };
  #previewCapture: Promise<string | null> | null = null;
  #pointerTimer: NodeJS.Timeout | null = null;

  roleFor(webContents: WebContents): WindowRole | null {
    return this.#roles.get(webContents.id) ?? null;
  }

  consoleWindow(): BrowserWindow | null { return this.#console; }
  overlayWindow(): BrowserWindow | null { return this.#overlay; }

  createWindows(): void {
    this.#console ??= this.#createConsole();
    this.#overlay ??= this.#createOverlay();
    if (this.#pointerTimer === null) {
      let last: CompanionPointer | null = null;
      let sentAt = 0;
      this.#pointerTimer = setInterval(() => {
        const overlay = this.#overlay;
        if (overlay === null || overlay.isDestroyed()
          || (!overlay.isVisible() && (this.#console === null || !this.#console.isVisible() || this.#console.isMinimized()))) {
          last = null;
          return;
        }
        const cursor = screen.getCursorScreenPoint();
        const bounds = overlay.getContentBounds();
        const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
        if (last?.x === point.x && last.y === point.y && Date.now() - sentAt < 1_000) return;
        last = point;
        sentAt = Date.now();
        // Fixed, one-way coordinates for this renderer only; never persist them.
        this.send('overlay', 'character:pointer', point);
      }, 50);
      this.#pointerTimer.unref();
    }
  }

  #guard(window: BrowserWindow, role: WindowRole): void {
    // `closed` fires after Electron has invalidated the native window getters.
    const webContentsId = window.webContents.id;
    this.#roles.set(webContentsId, role);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//iu.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      const current = window.webContents.getURL();
      if (url !== current) event.preventDefault();
    });
    window.on('closed', () => {
      this.#roles.delete(webContentsId);
      if (this.#console === window) this.#console = null;
      if (this.#overlay === window) this.#overlay = null;
    });
  }

  #createConsole(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 820,
      minHeight: 600,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#111927' : '#f8fbff',
      title: 'DeskPet Electron',
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } } : {}),
      webPreferences: secureWebPreferences(MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY),
    });
    this.#guard(window, 'console');
    void window.loadURL(process.env.NODE_ENV === 'development' ? MAIN_WINDOW_WEBPACK_ENTRY : 'deskpet://app/main_window/index.html');
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    return window;
  }

  #createOverlay(): BrowserWindow {
    const display = screen.getPrimaryDisplay().workArea;
    const width = 420;
    const height = 620;
    const window = new BrowserWindow({
      x: display.x + display.width - width - 28,
      y: display.y + display.height - height - 28,
      width,
      height,
      minWidth: 240,
      minHeight: 320,
      frame: false,
      transparent: true,
      resizable: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      webPreferences: secureWebPreferences(OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY),
    });
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform !== 'linux') window.setIgnoreMouseEvents(true, { forward: true });
    this.#guard(window, 'overlay');
    void window.loadURL(process.env.NODE_ENV === 'development' ? OVERLAY_WINDOW_WEBPACK_ENTRY : 'deskpet://app/overlay_window/index.html');
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive(); });
    return window;
  }

  setOverlayInteractive(interactive: boolean): void {
    if (process.platform !== 'linux') this.#overlay?.setIgnoreMouseEvents(!interactive, { forward: !interactive });
  }

  moveOverlayTo(x: number, y: number): CharacterState['position'] {
    const overlay = this.#overlay;
    if (overlay === null || overlay.isDestroyed()) return null;
    const bounds = overlay.getBounds();
    const display = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height });
    const area = display.workArea;
    overlay.setPosition(
      Math.round(Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - bounds.width)))),
      Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - bounds.height)))),
      false,
    );
    const actual = overlay.getBounds();
    return { displayId: String(display.id), x: actual.x, y: actual.y };
  }

  setOverlayVisible(visible: boolean): void {
    if (visible) this.#overlay?.showInactive();
    else this.#overlay?.hide();
  }

  async captureCompanionPreview(): Promise<string | null> {
    const overlay = this.#overlay;
    const console = this.#console;
    if (overlay === null || overlay.isDestroyed() || console === null || console.isDestroyed()
      || !console.isVisible() || console.isMinimized()) return null;
    // A single existing Live2D renderer supplies the preview. Never capture the
    // desktop, accept a caller-supplied target, or create another WebGL model.
    if (this.#previewCapture !== null) return this.#previewCapture;
    if (Date.now() - this.#preview.capturedAt < 120) return this.#preview.frame;
    const operation = (async (): Promise<string | null> => {
      try {
        // Fixed script, fixed overlay: export only its existing model canvas.
        // No caller-selected window, script, selector, URL or desktop capture.
        const frame: unknown = await overlay.webContents.executeJavaScript(`(() => {
          const request = new CustomEvent('deskpet:model-preview', { detail: { frame: null } });
          window.dispatchEvent(request);
          return request.detail.frame;
        })()`);
        if (overlay !== this.#overlay || overlay.isDestroyed()) return null;
        this.#preview = { frame: typeof frame === 'string' && frame.startsWith('data:image/png;base64,') && frame.length <= 3_000_000 ? frame : null, capturedAt: Date.now() };
        return this.#preview.frame;
      } catch {
        this.#preview = { frame: null, capturedAt: Date.now() };
        return null;
      }
    })();
    this.#previewCapture = operation;
    try { return await operation; }
    finally { if (this.#previewCapture === operation) this.#previewCapture = null; }
  }

  showConsole(): void {
    if (this.#console === null) this.#console = this.#createConsole();
    this.#console.show();
    this.#console.focus();
  }

  showAttention(): void {
    this.showConsole();
    const window = this.#console!;
    const announce = (): void => {
      if (this.#console === window && !window.isDestroyed()) window.webContents.send('attention:open-requested', undefined);
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', announce);
    else announce();
  }

  send(role: WindowRole, channel: string, value: unknown): void {
    const target = role === 'console' ? this.#console : this.#overlay;
    if (target !== null && !target.isDestroyed()) target.webContents.send(channel, value);
  }

  broadcast(channel: string, value: unknown): void {
    this.send('console', channel, value);
    this.send('overlay', channel, value);
  }

  createTray(actions: WindowManagerActions, labels: { show: string; toggle: string; quit: string; attention?: string }): void {
    if (this.#tray !== null) return;
    this.#tray = new Tray(createTrayIcon());
    const template: MenuItemConstructorOptions[] = [
      { label: labels.show, click: actions.showConsole },
      ...(actions.showAttention ? [{ label: labels.attention ?? 'Attention center', click: actions.showAttention }] : []),
      { label: labels.toggle, click: actions.toggleOverlay },
      { type: 'separator' },
      { label: labels.quit, click: actions.quit },
    ];
    this.#tray.setToolTip('DeskPet Electron');
    this.#tray.setContextMenu(Menu.buildFromTemplate(template));
    this.#tray.on('click', actions.showConsole);
  }

  dispose(): void {
    if (this.#pointerTimer !== null) clearInterval(this.#pointerTimer);
    this.#pointerTimer = null;
    const tray = this.#tray;
    const windows = [this.#console, this.#overlay];
    // Clear ownership before native destruction, whose events can reenter us.
    this.#tray = null;
    this.#console = null;
    this.#overlay = null;
    this.#roles.clear();
    this.#preview = { frame: null, capturedAt: 0 };
    if (tray !== null && !tray.isDestroyed()) tray.destroy();
    for (const window of windows) {
      if (window !== null && !window.isDestroyed()) window.destroy();
    }
  }
}
