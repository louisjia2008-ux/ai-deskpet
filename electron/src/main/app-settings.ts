import { modelRoutingSchema, type ModelRouting } from '../shared/model-routing';
import { z } from 'zod';

import type { Locale, Theme } from '../shared';
import { AtomicJsonStore } from './persistence';
import { defaultHotkeyForPlatform } from '../shared';
import { defaultPluginSettings, pluginSettingsSchema } from '../shared/plugins';
import type { PluginSettings } from '../shared/plugins';

export const settingsSchema = z
  .object({
    locale: z.enum(['system', 'en', 'zh-CN']),
    theme: z.enum(['system', 'light', 'dark']),
    hotkey: z.string().min(1).max(128),
    autoLaunch: z.boolean(),
    overlayVisible: z.boolean(),
    activeProviderId: z.string().uuid().nullable().default(null),
    modelRouting: modelRoutingSchema.optional(),
    plugins: pluginSettingsSchema.default(defaultPluginSettings),
  })
  .strict();

export type AppSettings = z.infer<typeof settingsSchema>;

export class AppSettingsService {
  readonly #store: AtomicJsonStore<AppSettings>;
  #settings: AppSettings | null = null;
  #updates: Promise<void> = Promise.resolve();

  constructor(path: string, platform: NodeJS.Platform = process.platform) {
    this.#store = new AtomicJsonStore({
      path,
      schemaVersion: 1,
      schema: settingsSchema,
      defaultValue: () => ({ locale: 'system', theme: 'system', hotkey: defaultHotkeyForPlatform(platform), autoLaunch: false, overlayVisible: true, activeProviderId: null, plugins: defaultPluginSettings() }),
    });
  }

  async initialize(): Promise<void> {
    this.#settings ??= await this.#store.load();
  }

  get(): AppSettings {
    if (this.#settings === null) throw new Error('Settings are not initialized.');
    return structuredClone(this.#settings);
  }

  async update(patch: Partial<{ locale: Locale; theme: Theme; hotkey: string; autoLaunch: boolean; overlayVisible: boolean; activeProviderId: string | null; plugins: PluginSettings; modelRouting: ModelRouting }>): Promise<AppSettings> {
    // Freeze the caller's intent now; merge it with the latest committed state
    // only when this update reaches the front of the queue.
    const frozen = structuredClone(patch);
    const write = async (): Promise<AppSettings> => {
      const next = settingsSchema.parse({ ...this.get(), ...frozen });
      await this.#store.save(next);
      this.#settings = next;
      return this.get();
    };
    const result = this.#updates.then(write, write);
    this.#updates = result.then(() => undefined, () => undefined);
    return result;
  }
}
