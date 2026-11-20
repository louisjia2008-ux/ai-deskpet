import type { MinecraftAutonomyRange, MinecraftDedicatedServerSnapshot } from '../../shared/minecraft-dedicated';
import type { MinecraftCompanionService } from './companion-service';

const holdsWorld = new Set(['starting', 'running', 'restarting', 'stopping']);

/** Reconciles the one Core helper against the currently running local world. */
export class MinecraftDedicatedCompanion {
  #world: MinecraftDedicatedServerSnapshot | null = null;
  #attached: string | null = null;
  #range: MinecraftAutonomyRange | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #operation: Promise<void> | null = null;
  #disposed = false;
  #error: string | null = null;

  constructor(private readonly companion: MinecraftCompanionService, private readonly dataDirectory: string, private readonly changed: () => void) {}

  ownsHelper(): boolean { return this.#attached !== null; }
  reserved(): boolean { return this.ownsHelper() || holdsWorld.has(this.#world?.status ?? ''); }
  error(): string | null { return this.#error; }

  update(world: MinecraftDedicatedServerSnapshot): void {
    const target = this.#target();
    this.#world = world;
    if (this.#target() !== target) {
      this.#error = null;
      if (this.#retry) clearTimeout(this.#retry);
      this.#retry = null;
    }
    this.sync();
  }

  #target(): string | null {
    const world = this.#world;
    if (this.#disposed || world?.status !== 'running') return null;
    return JSON.stringify([world.port, world.startedAt, world.ownerName, world.botName, world.settings.allowPlanApproval]);
  }

  #scheduleRetry(): void {
    if (this.#retry) return;
    this.#retry = setTimeout(() => { this.#retry = null; this.sync(true); }, 5_000);
    this.#retry.unref();
  }

  sync(retrying = false): void {
    if (this.#disposed || this.#operation || this.#retry) return;
    const target = this.#target();
    if (!target && !this.#attached) return;
    if (target && target === this.#attached) {
      const state = this.companion.getState();
      if (state.connectionState === 'connecting') return;
      if (state.connectionState === 'ready') {
        const range = this.#world?.settings.autonomyRange ?? 'end';
        if (range === this.#range) return;
        this.#operation = this.companion.setAutonomyRange(range).then(() => {
          this.#range = range;
          this.#error = null;
        }).catch(error => {
          this.#error = error instanceof Error ? error.message.slice(0, 500) : 'Could not update Minecraft autonomy.';
          this.#scheduleRetry();
        }).finally(() => {
          this.#operation = null;
          this.changed();
          this.sync();
        });
        return;
      }
      if (!retrying) {
        this.#error = state.lastError;
        this.#scheduleRetry();
        this.changed();
        return;
      }
    }
    this.#operation = Promise.resolve().then(async () => {
      const world = this.#world;
      const desired = this.#target();
      if (this.#attached || desired) await this.companion.disconnect();
      this.#attached = null;
      this.#range = null;
      if (!world || !desired || desired !== this.#target()) return;
      this.#attached = desired;
      this.#range = world.settings.autonomyRange ?? 'end';
      await this.companion.connect({ host: '127.0.0.1', port: world.port, username: world.botName, auth: 'offline',
        version: world.versions.minecraft, ownerName: world.ownerName }, () => {
        if (desired !== this.#target()) throw new Error('Minecraft dedicated world changed while the bot was connecting.');
      }, { dataDirectory: this.dataDirectory, execute: world.settings.allowPlanApproval && world.ownerName !== '', autonomyRange: this.#range });
      this.#error = null;
    }).catch(error => {
      if (this.#disposed || this.#target() !== target) return;
      this.#error = error instanceof Error ? error.message.slice(0, 500) : 'Minecraft bot could not connect.';
      this.#scheduleRetry();
    }).finally(() => {
      this.#operation = null;
      this.changed();
      this.sync();
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    await this.#operation;
  }
}
