import type { CharacterState } from '../shared';

type Position = CharacterState['position'];
interface Bounds { x: number; y: number; width: number; height: number }
interface Display { id: number; workArea: Bounds }
interface PositionWindow {
  isDestroyed(): boolean;
  getBounds(): Bounds;
  setPosition(x: number, y: number, animate?: boolean): void;
  on(event: 'moved' | 'closed', listener: () => void): unknown;
  removeListener(event: 'moved' | 'closed', listener: () => void): unknown;
}
interface Dependencies {
  windows: { overlayWindow(): PositionWindow | null; moveOverlayTo(x: number, y: number): Position };
  preferences: { getPosition(): Position; savePosition(position: Position): Promise<void> };
  displays: { all(): readonly Display[]; matching(bounds: Bounds): Display };
  failed(error: unknown): void;
}

/** Tracks the current native overlay only. Native moves and renderer moves join
 * one preference queue, and shutdown records the last actual native bounds. */
export class OverlayPositionCoordinator {
  #attached: PositionWindow | null = null;
  #detach: (() => void) | null = null;
  #latest: Position | undefined;
  #signature: string | null = null;
  #writes: Promise<void> = Promise.resolve();
  #generation = 0;
  #closing = false;
  #shutdown: Promise<void> | null = null;
  constructor(private readonly dependencies: Dependencies) {}

  #position(window: PositionWindow): NonNullable<Position> {
    const bounds = window.getBounds(), display = this.dependencies.displays.matching(bounds);
    return { displayId: String(display.id), x: bounds.x, y: bounds.y };
  }
  #save(position: Position): Promise<void> {
    const signature = JSON.stringify(position);
    this.#latest = structuredClone(position);
    if (signature === this.#signature) return this.#writes;
    this.#signature = signature;
    const snapshot = structuredClone(position), generation = ++this.#generation;
    // A drag asks for many positions; only the newest still waiting is written.
    const write = this.#writes.catch(() => undefined).then(() => generation === this.#generation ? this.dependencies.preferences.savePosition(snapshot) : undefined);
    this.#writes = write;
    void write.catch(() => { if (this.#signature === signature) this.#signature = null; });
    return write;
  }
  attach(): void {
    if (this.#closing) return;
    const window = this.dependencies.windows.overlayWindow();
    if (window === null || window.isDestroyed() || window === this.#attached) return;
    this.#detach?.();
    this.#attached = window;
    const saved = this.#latest === undefined ? this.dependencies.preferences.getPosition() : this.#latest;
    if (saved !== null) {
      const display = this.dependencies.displays.all().find(value => String(value.id) === saved.displayId);
      if (display !== undefined) {
        const bounds = window.getBounds(), area = display.workArea;
        window.setPosition(Math.round(Math.max(area.x, Math.min(saved.x, area.x + Math.max(0, area.width - bounds.width)))),
          Math.round(Math.max(area.y, Math.min(saved.y, area.y + Math.max(0, area.height - bounds.height)))), false);
      }
    }
    const moved = (): void => {
      if (this.#closing || window !== this.#attached || window.isDestroyed()) return;
      void this.#save(this.#position(window)).catch(error => this.dependencies.failed(error));
    };
    const closed = (): void => {
      window.removeListener('moved', moved); window.removeListener('closed', closed);
      if (this.#attached === window) { this.#attached = null; this.#detach = null; }
    };
    this.#detach = () => { window.removeListener('moved', moved); window.removeListener('closed', closed); };
    window.on('moved', moved); window.on('closed', closed);
  }
  async move(position: Position): Promise<void> {
    if (this.#closing) throw new Error('character.movementClosing');
    const actual = position === null ? null : this.dependencies.windows.moveOverlayTo(position.x, position.y);
    // The window follows the pointer at once; the disk catches up behind it, and shutdown waits for it.
    void this.#save(actual).catch(error => this.dependencies.failed(error));
  }
  shutdown(): Promise<void> {
    if (this.#shutdown !== null) return this.#shutdown;
    this.#closing = true;
    const window = this.dependencies.windows.overlayWindow();
    this.#detach?.(); this.#detach = null; this.#attached = null;
    const write = window !== null && !window.isDestroyed() ? this.#save(this.#position(window)) : this.#writes;
    this.#shutdown = write;
    return write;
  }
}
