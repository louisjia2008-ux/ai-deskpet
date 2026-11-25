// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterState } from '../shared';
import { OverlayPositionCoordinator } from './overlay-position';

type Position = CharacterState['position'];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
class NativeWindow extends EventEmitter {
  destroyed = false;
  bounds = { x: 10, y: 20, width: 420, height: 620 };
  getBounds = () => { if (this.destroyed) throw new Error('Destroyed native window'); return { ...this.bounds }; };
  isDestroyed = () => this.destroyed;
  setPosition = vi.fn((x: number, y: number) => { this.bounds.x = x; this.bounds.y = y; this.emit('moved'); });
  close(): void { this.destroyed = true; this.emit('closed'); }
}
const fixture = (initial: Position = { displayId: '7', x: 100, y: 120 }) => {
  let window: NativeWindow | null = new NativeWindow(), saved = structuredClone(initial);
  const save = vi.fn(async (position: Position) => { saved = structuredClone(position); });
  const move = vi.fn((x: number, y: number) => { window!.setPosition(x, y); return { displayId: '7', x, y }; });
  const failed = vi.fn();
  const coordinator = new OverlayPositionCoordinator({ windows: { overlayWindow: () => window, moveOverlayTo: move }, preferences: { getPosition: () => structuredClone(saved), savePosition: save },
    displays: { all: () => [{ id: 7, workArea: { x: 0, y: 0, width: 1000, height: 800 } }], matching: () => ({ id: 7, workArea: { x: 0, y: 0, width: 1000, height: 800 } }) }, failed });
  return { coordinator, save, move, failed, window: window!, saved: () => saved, replace: () => { window = new NativeWindow(); return window; }, remove: () => { window = null; } };
};

describe('native companion position lifecycle', () => {
  it('attaches once per native instance, restores a replacement and ignores the old window after close', async () => {
    const f = fixture(); f.coordinator.attach(); f.coordinator.attach();
    expect(f.window.getBounds()).toMatchObject({ x: 100, y: 120 }); expect(f.window.listenerCount('moved')).toBe(1);
    await f.coordinator.move({ displayId: 'renderer-is-not-authority', x: 200, y: 150 });
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce()); expect(f.saved()).toEqual({ displayId: '7', x: 200, y: 150 });
    f.window.close(); expect(f.window.listenerCount('moved')).toBe(0);
    const replacement = f.replace(); f.coordinator.attach(); f.coordinator.attach();
    expect(replacement.getBounds()).toMatchObject({ x: 200, y: 150 }); expect(replacement.listenerCount('moved')).toBe(1);
    f.window.emit('moved'); expect(f.save).toHaveBeenCalledOnce();
    replacement.setPosition(210, 160); await f.coordinator.shutdown();
    expect(f.saved()).toEqual({ displayId: '7', x: 210, y: 160 }); expect(f.save).toHaveBeenCalledTimes(2);
  });

  it('waits for a delayed save and the final native bounds before shutdown, rejecting later renderer movement', async () => {
    const f = fixture(), entered = deferred(), release = deferred(); f.coordinator.attach();
    f.save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const moving = f.coordinator.move({ displayId: '7', x: 200, y: 150 }); await entered.promise;
    f.window.bounds.x = 250; f.window.bounds.y = 170; // Actual native move before its notification.
    let exited = false; const shutdown = f.coordinator.shutdown().then(() => { exited = true; });
    await expect(f.coordinator.move({ displayId: '7', x: 999, y: 999 })).rejects.toThrow('character.movementClosing');
    await new Promise<void>(resolve => setTimeout(resolve, 15)); expect(exited).toBe(false);
    expect(f.move).toHaveBeenCalledOnce(); release.resolve(); await Promise.all([moving, shutdown]);
    expect(f.save).toHaveBeenLastCalledWith({ displayId: '7', x: 250, y: 170 }); expect(f.saved()).toEqual({ displayId: '7', x: 250, y: 170 });
    expect(f.window.listenerCount('moved')).toBe(0); expect(f.coordinator.shutdown()).toBeInstanceOf(Promise);
  });

  it('follows the pointer while a save is slow, writing only the newest position once it is free', async () => {
    const f = fixture(), entered = deferred(), release = deferred(); f.coordinator.attach();
    f.save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    await f.coordinator.move({ displayId: '7', x: 200, y: 150 }); await entered.promise;
    for (let x = 201; x <= 260; x += 1) await f.coordinator.move({ displayId: '7', x, y: 150 });
    expect(f.move).toHaveBeenCalledTimes(61); expect(f.window.getBounds()).toMatchObject({ x: 260 });
    release.resolve(); await f.coordinator.shutdown();
    expect(f.save).toHaveBeenCalledTimes(2); expect(f.saved()).toEqual({ displayId: '7', x: 260, y: 150 });
  });

  it('restores the latest requested position to a replacement even while its previous disk save is delayed', async () => {
    const f = fixture(), entered = deferred(), release = deferred(); f.coordinator.attach();
    f.save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const moving = f.coordinator.move({ displayId: '7', x: 220, y: 160 }); await entered.promise;
    f.window.close(); const replacement = f.replace(); f.coordinator.attach();
    expect(replacement.getBounds()).toMatchObject({ x: 220, y: 160 }); release.resolve(); await moving; await f.coordinator.shutdown();
  });

  it('clamps restored position using the current display area without inventing a fallback display identity', async () => {
    const f = fixture({ displayId: '7', x: 9999, y: 9999 }); f.coordinator.attach();
    expect(f.window.getBounds()).toMatchObject({ x: 580, y: 180 }); await f.coordinator.shutdown();
    expect(f.saved()).toEqual({ displayId: '7', x: 580, y: 180 });
    const missing = fixture({ displayId: 'unplugged', x: -9999, y: -9999 }); missing.coordinator.attach();
    expect(missing.window.setPosition).not.toHaveBeenCalled(); await missing.coordinator.shutdown();
  });

  it('does not access a destroyed window while draining pending writes', async () => {
    const f = fixture(); f.coordinator.attach(); await f.coordinator.move({ displayId: '7', x: 200, y: 150 });
    f.window.close(); f.remove(); await expect(f.coordinator.shutdown()).resolves.toBeUndefined();
    expect(f.saved()).toEqual({ displayId: '7', x: 200, y: 150 });
  });
});
