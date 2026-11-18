import type { DesktopExtensionsAPI } from './desktop-extensions';
import { z } from 'zod';

// Only explicitly configured loopback services are trusted plugin endpoints.
export const localPluginUrlSchema = z.url().max(2048).refine((value) => {
  try {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}, 'Use a local service origin, for example http://127.0.0.1:8080.');

export const pluginSettingsSchema = z.object({
  web: z.object({
    enabled: z.boolean().default(false),
    searxngUrl: localPluginUrlSchema.default('http://127.0.0.1:8080'),
    crawl4aiUrl: localPluginUrlSchema.default('http://127.0.0.1:11235'),
    maxCharacters: z.number().int().min(1000).max(12000).default(4000),
  }).strict().default({ enabled: false, searxngUrl: 'http://127.0.0.1:8080', crawl4aiUrl: 'http://127.0.0.1:11235', maxCharacters: 4000 }),
  rea: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
}).strict();
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
export const defaultPluginSettings = (): PluginSettings => pluginSettingsSchema.parse({});
export const pluginConfigurationSchema = z.object({
  settings: pluginSettingsSchema,
  crawl4aiToken: z.string().trim().max(16384).optional(),
  clearCrawl4aiToken: z.boolean().optional(),
}).strict().refine((value) => !(value.crawl4aiToken && value.clearCrawl4aiToken), 'Choose a token update or removal.');
export type PluginConfiguration = z.infer<typeof pluginConfigurationSchema>;
export interface PluginState { settings: PluginSettings; crawl4aiTokenConfigured: boolean; warningCode?: 'plugin.reaCleanupUnconfirmed' }
export type WebPluginKind = 'searxng' | 'crawl4ai';
export interface PluginProbe { kind: WebPluginKind; ok: boolean; code: string; checkedAt: string; resultCount?: number; excerpt?: string }
export interface PluginsAPI {
  extensions: DesktopExtensionsAPI;
  getState(): Promise<PluginState>;
  configure(input: PluginConfiguration): Promise<PluginState>;
  test(input: { kind: WebPluginKind }): Promise<PluginProbe>;
}
