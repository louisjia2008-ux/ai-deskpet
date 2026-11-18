// @vitest-environment node
import type { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowManager } from './window-manager';

interface NativeContents extends EventEmitter {
  id: number;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  isLoadingMainFrame: ReturnType<typeof vi.fn>;
}

interface NativeWindow extends EventEmitter {
  contents: NativeContents;
  destroyed: boolean;
  deferClosed: boolean;
  destroy: () => void;
  show: () => void;
  showInactive: () => void;
  bounds: { x: number; y: number; width: number; height: number };
  setPosition: ReturnType<typeof vi.fn>;
  visible: boolean;
  minimized: boolean;
}

interface NativeTray extends EventEmitter {
  destroyed: boolean;
  destroy: () => void;
}

const native = vi.hoisted(() => ({ windows: [] as NativeWindow[], trays: [] as NativeTray[], nextId: 1, loadingMainFrame: false, cursor: { x: 100, y: 200 } }));
const managers: WindowManager[] = [];

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    readonly id = native.nextId++;
    setWindowOpenHandler = vi.fn();
    getURL = vi.fn(() => 'deskpet://app/main_window/index.html');
    isLoadingMainFrame = vi.fn(() => native.loadingMainFrame);
    send = vi.fn();
    executeJavaScript = vi.fn(async () => 'data:image/png;base64,companion-only');
  }
  class Window extends EventEmitter {
    readonly contents = new Contents();
    destroyed = false;
    deferClosed = false;
    visible = true;
    minimized = false;
    bounds = { x: 0, y: 0, width: 420, height: 620 };
    getBounds = vi.fn(() => ({ ...this.bounds }));
    getContentBounds = vi.fn(() => ({ ...this.bounds }));
    isVisible = (): boolean => this.visible;
    isMinimized = (): boolean => this.minimized;
    setPosition = vi.fn((x: number, y: number) => { this.bounds.x = x; this.bounds.y = y; });
    constructor() { super(); native.windows.push(this); }
    // Electron has already invalidated this native getter when `closed` fires.
    get webContents(): Contents {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      return this.contents;
    }
    isDestroyed(): boolean { return this.destroyed; }
    destroy = vi.fn(() => {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      this.destroyed = true;
      if (!this.deferClosed) this.emit('closed');
    });
    show = vi.fn(() => { if (this.destroyed) throw new TypeError('Object has been destroyed'); });
    showInactive = vi.fn(() => { if (this.destroyed) throw new TypeError('Object has been destroyed'); });
    focus = vi.fn();
    hide = vi.fn();
    loadURL = vi.fn(async () => undefined);
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setIgnoreMouseEvents = vi.fn();
  }
  class Tray extends EventEmitter {
    destroyed = false;
    constructor() { super(); native.trays.push(this); }
    isDestroyed(): boolean { return this.destroyed; }
    destroy = vi.fn(() => {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      this.destroyed = true;
    });
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
  }
  return {
    nativeTheme: { shouldUseDarkColors: false },
    BrowserWindow: Window, Tray,
    screen: {
      getCursorScreenPoint: () => ({ ...native.cursor }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getDisplayMatching: () => ({ id: 7, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    nativeImage: { createFromBuffer: () => ({ setTemplateImage: vi.fn(), addRepresentation: vi.fn() }) },
    Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  };
});

afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); });

beforeEach(() => {
  native.windows.length = 0;
  native.trays.length = 0;
  native.nextId = 1;
  native.loadingMainFrame = false;
  vi.stubGlobal('MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY', '/console-preload.js');
  vi.stubGlobal('MAIN_WINDOW_WEBPACK_ENTRY', 'deskpet://app/main_window/index.html');
  vi.stubGlobal('OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY', '/overlay-preload.js');
  vi.stubGlobal('OVERLAY_WINDOW_WEBPACK_ENTRY', 'deskpet://app/overlay_window/index.html');
});

function fixture(): { manager: WindowManager; console: NativeWindow; overlay: NativeWindow } {
  const manager = new WindowManager();
  managers.push(manager);
  manager.createWindows();
  return { manager, console: native.windows[0]!, overlay: native.windows[1]! };
}

const role = (manager: WindowManager, id: number) => manager.roleFor({ id } as WebContents);

describe('WindowManager native lifetime', () => {
  it('waits for a recreated console to load before sending tray attention navigation', () => {
    const { manager, console } = fixture();
    console.destroy(); native.loadingMainFrame = true;
    manager.showAttention();
    const recreated = native.windows[2]!;
    expect(recreated.contents.send).not.toHaveBeenCalled();
    recreated.contents.emit('did-finish-load');
    expect(recreated.contents.send).toHaveBeenCalledWith('attention:open-requested', undefined);
    recreated.contents.send.mockClear();
    manager.showAttention(); manager.dispose();
    expect(() => recreated.contents.emit('did-finish-load')).not.toThrow();
    expect(recreated.contents.send).not.toHaveBeenCalled();
  });

  it('sends bounded, relative cursor events only to the companion and stops after disposal', () => {
    vi.useFakeTimers();
    const { manager, console, overlay } = fixture();
    overlay.bounds.x = 50; overlay.bounds.y = 80;
    vi.advanceTimersByTime(50);
    expect(overlay.contents.send).toHaveBeenLastCalledWith('character:pointer', { x: 50, y: 120 });
    vi.advanceTimersByTime(200);
    expect(overlay.contents.send).toHaveBeenCalledOnce();
    expect(console.contents.send).not.toHaveBeenCalled();
    native.cursor.x = 300; vi.advanceTimersByTime(50);
    expect(overlay.contents.send).toHaveBeenLastCalledWith('character:pointer', { x: 250, y: 120 });
    overlay.visible = false; console.visible = false;
    vi.advanceTimersByTime(2_000);
    expect(overlay.contents.send).toHaveBeenCalledTimes(2);
    overlay.visible = true; vi.advanceTimersByTime(50);
    expect(overlay.contents.send).toHaveBeenCalledTimes(3);
    manager.dispose(); vi.advanceTimersByTime(2_000);
    expect(overlay.contents.send).toHaveBeenCalledTimes(3);
  });

  it('captures only the fixed companion window, coalesces requests and rate-limits native frames', async () => {
    const { manager, console, overlay } = fixture();
    const [one, two] = await Promise.all([manager.captureCompanionPreview(), manager.captureCompanionPreview()]);
    expect(one).toBe('data:image/png;base64,companion-only');
    expect(two).toBe(one);
    expect(await manager.captureCompanionPreview()).toBe(one);
    expect(overlay.contents.executeJavaScript).toHaveBeenCalledOnce();
    expect(overlay.contents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("new CustomEvent('deskpet:model-preview'"));
    expect(overlay.contents.executeJavaScript.mock.calls[0]?.[0]).not.toMatch(/capturePage|querySelector|fetch\(/u);
    expect(console.contents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('does not capture while the console is hidden or minimized, or publish after disposal', async () => {
    const { manager, console, overlay } = fixture();
    console.visible = false;
    expect(await manager.captureCompanionPreview()).toBeNull();
    console.visible = true; console.minimized = true;
    expect(await manager.captureCompanionPreview()).toBeNull();
    expect(overlay.contents.executeJavaScript).not.toHaveBeenCalled();
    console.minimized = false;
    const pending = manager.captureCompanionPreview();
    manager.dispose();
    expect(await pending).toBeNull();
    expect(await manager.captureCompanionPreview()).toBeNull();
  });

  it('recovers from a failed native capture without leaving an in-flight request stuck', async () => {
    const { manager, overlay } = fixture();
    overlay.contents.executeJavaScript.mockRejectedValueOnce(new Error('Native window unavailable'));
    expect(await manager.captureCompanionPreview()).toBeNull();
    manager.dispose();
    manager.createWindows();
    expect(await manager.captureCompanionPreview()).toBe('data:image/png;base64,companion-only');
  });


  it('rejects non-PNG, oversized and missing renderer preview values', async () => {
    vi.useFakeTimers();
    const { manager, overlay } = fixture();
    for (const value of ['file:///private/file', 'data:image/png;base64,' + 'A'.repeat(3_000_000), null]) {
      overlay.contents.executeJavaScript.mockResolvedValueOnce(value);
      vi.advanceTimersByTime(150);
      expect(await manager.captureCompanionPreview()).toBeNull();
    }
  });

  it('moves only the companion and clamps it into the actual display work area', () => {
    const { manager, console, overlay } = fixture();
    expect(manager.moveOverlayTo(-100, 5000)).toEqual({ displayId: '7', x: 0, y: 280 });
    expect(overlay.setPosition).toHaveBeenCalledWith(0, 280, false);
    expect(console.setPosition).not.toHaveBeenCalled();
    manager.dispose();
    expect(manager.moveOverlayTo(1, 2)).toBeNull();
  });

  it('forgets a closed window without accessing its destroyed native webContents', () => {
    const { manager, console, overlay } = fixture();
    const id = console.contents.id;
    expect(role(manager, id)).toBe('console');
    expect(() => console.destroy()).not.toThrow();
    expect(manager.consoleWindow()).toBeNull();
    expect(manager.overlayWindow()).toBe(overlay);
    expect(role(manager, id)).toBeNull();
    expect(role(manager, overlay.contents.id)).toBe('overlay');
  });

  it('disposes both native windows and the tray exactly once across repeated calls', () => {
    const { manager, console, overlay } = fixture();
    manager.createTray({ toggleOverlay: vi.fn(), showConsole: vi.fn(), quit: vi.fn() },
      { show: 'Open', toggle: 'Toggle', quit: 'Quit' });
    const tray = native.trays[0]!;
    expect(() => { manager.dispose(); manager.dispose(); }).not.toThrow();
    for (const item of [console, overlay, tray]) expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(manager.consoleWindow()).toBeNull();
    expect(manager.overlayWindow()).toBeNull();
    expect(role(manager, console.contents.id)).toBeNull();
    expect(role(manager, overlay.contents.id)).toBeNull();
  });

  it('handles a synchronous closed callback reentering dispose while both windows are being destroyed', () => {
    const { manager, console, overlay } = fixture();
    console.on('closed', () => manager.dispose());
    expect(() => manager.dispose()).not.toThrow();
    expect(console.destroy).toHaveBeenCalledTimes(1);
    expect(overlay.destroy).toHaveBeenCalledTimes(1);
    expect(manager.consoleWindow()).toBeNull();
    expect(manager.overlayWindow()).toBeNull();
  });

  it('skips native objects already destroyed before their closed notification', () => {
    const { manager, console, overlay } = fixture();
    console.deferClosed = true;
    console.destroy();
    manager.createTray({ toggleOverlay: vi.fn(), showConsole: vi.fn(), quit: vi.fn() },
      { show: 'Open', toggle: 'Toggle', quit: 'Quit' });
    const tray = native.trays[0]!;
    tray.destroy();
    expect(() => manager.dispose()).not.toThrow();
    for (const item of [console, overlay, tray]) expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(role(manager, console.contents.id)).toBeNull();
  });

  it('does not show windows when a queued ready-to-show arrives after disposal', () => {
    const { manager, console, overlay } = fixture();
    manager.dispose();
    expect(() => { console.emit('ready-to-show'); overlay.emit('ready-to-show'); }).not.toThrow();
    expect(console.show).not.toHaveBeenCalled();
    expect(overlay.showInactive).not.toHaveBeenCalled();
  });

  it('keeps replacement windows when an older closed callback arrives later', () => {
    const { manager, console, overlay } = fixture();
    console.deferClosed = true;
    overlay.deferClosed = true;
    manager.dispose();
    manager.createWindows();
    const newConsole = manager.consoleWindow();
    const newOverlay = manager.overlayWindow();
    expect(() => { console.emit('closed'); overlay.emit('closed'); }).not.toThrow();
    expect(manager.consoleWindow()).toBe(newConsole);
    expect(manager.overlayWindow()).toBe(newOverlay);
    expect(role(manager, native.windows[2]!.contents.id)).toBe('console');
    expect(role(manager, native.windows[3]!.contents.id)).toBe('overlay');
  });
});
