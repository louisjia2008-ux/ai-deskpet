import { join } from 'node:path';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';

import type { CharacterState } from '../shared';
import { AtomicJsonStore } from './persistence';
import { CubismCoreImporter, ModelArchiveImporter } from './live2d';
import type { PendingModelImport } from './live2d';

const preferencesSchema = z
  .object({
    scale: z.number().min(0.2).max(3),
    position: z.object({ displayId: z.string(), x: z.number(), y: z.number() }).strict().nullable(),
    expressions: z.record(z.string(), z.string().max(240).nullable()).default({}),
  })
  .strict();

type Preferences = z.infer<typeof preferencesSchema>;

export class CharacterService {
  readonly #core: CubismCoreImporter;
  readonly #models: ModelArchiveImporter;
  readonly #preferences: AtomicJsonStore<Preferences>;
  #preferenceValue: Preferences = { scale: 1, position: null, expressions: {} };
  #pending: PendingModelImport | null = null;
  #action: string | null = null;
  #actionRevision = 0;
  #bubble: string | null = null;
  #bubbleRevision = 0;
  #bubbleSessionId: string | null = null;
  #bubbleExpiresAt: string | null = null;
  #importError: Exclude<CharacterState['importError'], undefined> = null;
  #imports: Promise<unknown> = Promise.resolve();

  #serializeImport<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#imports.then(operation, operation);
    this.#imports = result.catch(() => undefined);
    return result;
  }

  constructor(managedRoot: string) {
    this.#core = new CubismCoreImporter(managedRoot);
    this.#models = new ModelArchiveImporter(managedRoot);
    this.#preferences = new AtomicJsonStore({
      path: join(managedRoot, 'character-preferences.json'),
      schemaVersion: 1,
      schema: preferencesSchema,
      defaultValue: () => ({ scale: 1, position: null, expressions: {} }),
    });
  }

  async initialize(): Promise<void> {
    await this.#models.cleanupStaging();
    this.#preferenceValue = await this.#preferences.load();
  }

  async getState(): Promise<CharacterState> {
    const action = this.#action;
    const actionRevision = this.#actionRevision;
    const core = await this.#core.status().catch(() => null);
    const config = await this.#models.getConfig();
    const modelId = this.#pending?.importId ?? config.active?.id ?? null;
    const expressions = await this.#models.expressionNames(modelId);
    const modelUrl = this.#pending === null
      ? config.active === null
        ? null
        : `deskpet://managed/models/${config.active.id}/${config.active.modelJsonRelativePath}`
      : `deskpet://managed/models/.staging/${this.#pending.importId}/${this.#pending.modelJsonRelativePath}`;
    return {
      coreState: core === null ? 'missing' : 'ready',
      modelState: this.#pending !== null ? 'loading' : config.active === null ? 'missing' : 'ready',
      coreUrl: core === null ? null : 'deskpet://managed/core/live2dcubismcore.min.js',
      modelUrl,
      pendingImportId: this.#pending?.importId ?? null,
      modelName: this.#pending?.name ?? config.active?.name ?? null,
      scale: this.#preferenceValue.scale,
      position: this.#preferenceValue.position,
      expression: modelId === null ? null : this.#preferenceValue.expressions[modelId] ?? null,
      expressions,
      action,
      actionRevision,
      bubble: this.#bubble,
      bubbleRevision: this.#bubbleRevision,
      bubbleExpiresAt: this.#bubbleExpiresAt,
      bubbleSessionId: this.#bubbleSessionId,
      importError: this.#importError,
    };
  }

  async importCore(parent: BrowserWindow | null): Promise<CharacterState> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose live2dcubismcore.min.js',
      properties: ['openFile'],
      filters: [{ name: 'Cubism Core JavaScript', extensions: ['js'] }],
    };
    const selection = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    const path = selection.filePaths[0];
    if (!selection.canceled && path !== undefined) await this.#core.import(path);
    return this.getState();
  }

  async importModel(parent: BrowserWindow | null): Promise<CharacterState> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose Live2D model ZIP',
      properties: ['openFile'],
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    };
    const selection = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    const path = selection.filePaths[0];
    if (!selection.canceled && path !== undefined) {
      return this.stageModelArchive(path);
    }
    return this.getState();
  }

  async stageModelArchive(path: string): Promise<CharacterState> {
    return this.#serializeImport(async () => {
      const pending = await this.#models.stage(path);
      if (this.#pending !== null) await this.#models.cancel(this.#pending.importId);
      this.#importError = null;
      this.#pending = pending;
      return this.getState();
    });
  }

  async acknowledgeModelLoaded(importId: string): Promise<CharacterState> {
    return this.#serializeImport(async () => {
      if (this.#pending?.importId !== importId) return this.getState();
      await this.#models.commit(importId);
      this.#pending = null;
      this.#importError = null;
      return this.getState();
    });
  }

  async modelLoadFailed(importId: string): Promise<CharacterState> {
    return this.#serializeImport(async () => {
      if (this.#pending?.importId !== importId) return this.getState();
      await this.#models.cancel(importId);
      this.#pending = null;
      this.#importError = (await this.#models.getConfig()).active === null ? 'setup.loadFailed' : 'setup.restoredModel';
      return this.getState();
    });
  }

  async cancelImport(): Promise<void> {
    await this.#serializeImport(async () => {
      if (this.#pending !== null) await this.#models.cancel(this.#pending.importId);
      this.#pending = null;
      this.#importError = null;
    });
  }

  async setScale(scale: number): Promise<CharacterState> {
    this.#preferenceValue.scale = scale;
    await this.#preferences.save(this.#preferenceValue);
    return this.getState();
  }

  getPosition(): CharacterState['position'] { return structuredClone(this.#preferenceValue.position); }

  async savePosition(position: CharacterState['position']): Promise<void> {
    this.#preferenceValue.position = structuredClone(position);
    await this.#preferences.save(this.#preferenceValue);
  }

  /** Queue one final snapshot behind every earlier preference write. */
  async flushPreferences(): Promise<void> { await this.#preferences.save(this.#preferenceValue); }

  async setPosition(position: CharacterState['position']): Promise<CharacterState> {
    await this.savePosition(position);
    return this.getState();
  }

  async setExpression(expression: string | null): Promise<void> {
    const config = await this.#models.getConfig();
    const modelId = this.#pending?.importId ?? config.active?.id ?? null;
    if (modelId === null) return;
    if (expression !== null && !(await this.#models.expressionNames(modelId)).includes(expression)) {
      throw new Error('Expression is not available in the current model.');
    }
    this.#preferenceValue.expressions[modelId] = expression;
    await this.#preferences.save(this.#preferenceValue);
  }
  setAction(action: string | null): void {
    this.#action = action;
    this.#actionRevision += 1;
  }
  setBubble(bubble: string | null, now = new Date(), sessionId: string | null = null, durationMs = 60_000): void {
    this.#bubble = bubble;
    this.#bubbleSessionId = bubble === null ? null : sessionId;
    this.#bubbleRevision += 1;
    this.#bubbleExpiresAt = bubble === null ? null : new Date(now.getTime() + durationMs).toISOString();
  }

  dismissBubble(revision: number): boolean {
    // A delayed close or expiry for an old message must not clear a new one.
    if (revision !== this.#bubbleRevision || this.#bubble === null) return false;
    this.setBubble(null);
    return true;
  }
}
