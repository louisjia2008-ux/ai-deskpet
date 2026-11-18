// @vitest-environment node
// Opt-in only: prepared local services + public internet; ordinary tests skip it.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalWebPlugins } from './local-web-plugins';
import { defaultPluginSettings } from '../../shared/plugins';

it.runIf(Boolean(process.env.DESKPET_WEB_PLUGIN_LIVE_RUNTIME))('uses the real local search and crawler through the production adapter', async () => {
  const root = process.env.DESKPET_WEB_PLUGIN_LIVE_RUNTIME!;
  const settings = defaultPluginSettings(); settings.web.enabled = true; settings.web.maxCharacters = 1000;
  const service = new LocalWebPlugins({ getSettings: () => settings, getCrawl4aiToken: () => readFile(join(root, 'crawl4ai-token'), 'utf8') });
  const signal = new AbortController().signal;
  const en = await service.search('Crawl4AI quick start site:docs.crawl4ai.com', 3, signal);
  expect(en.results.length).toBeGreaterThan(0); expect(en.results.every((r) => new URL(r.url).hostname === 'docs.crawl4ai.com')).toBe(true);
  const zh = await service.search('洛杉矶 今天天气', 3, signal);
  expect(zh.results.length).toBeGreaterThan(0); expect(zh.results.some((r) => /洛杉矶|Los Angeles/iu.test(r.title + r.snippet))).toBe(true);
  const page = await service.read('https://docs.crawl4ai.com/core/quickstart/', 'text', {}, signal);
  expect(page.text.length).toBeGreaterThan(100); expect(page.text.length).toBeLessThanOrEqual(1000);
  expect(page.engine).toBe('Crawl4AI'); expect(page.text).toMatch(/Crawl4AI/iu);
  const more = page.nextOffset === null ? null : await service.read('https://docs.crawl4ai.com/core/quickstart/', 'text', { offset: page.nextOffset }, signal);
  if (more) expect(more.sourceSHA256).toBe(page.sourceSHA256);
  const receipt = {
    checkedAt: new Date().toISOString(), type: 'production-adapter-live-smoke',
    english: { engine: en.engine, count: en.results.length, samples: en.results },
    chinese: { engine: zh.engine, count: zh.results.length, samples: zh.results },
    read: { engine: page.engine, url: page.url, characters: page.text.length, totalCharacters: page.totalCharacters, sourceSHA256: page.sourceSHA256, nextOffset: page.nextOffset, secondPageSameHash: more?.sourceSHA256 === page.sourceSHA256, excerpt: page.text.slice(0, 240) },
  };
  if (process.env.DESKPET_WEB_PLUGIN_LIVE_RECEIPT) await writeFile(process.env.DESKPET_WEB_PLUGIN_LIVE_RECEIPT, JSON.stringify(receipt, null, 2));
}, 120_000);
