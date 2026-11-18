// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerBuiltinTools } from './builtins';
import { textPage } from './text-page';
import { readableHtml, webToolContent } from './web-content';

describe('Explicit source pagination instead of oversized model tool results', () => {
  it('bounds a large weather page and reconstructs the literal source through its cursors', () => {
    const html = `<main><h1>Synthetic weather source</h1><p>${'SYNTHETIC_FORECAST_DATA '.repeat(5000)}</p><footer>FINAL_SOURCE_FACT</footer></main>`;
    const response = { url: 'https://example.com/weather', contentType: 'text/html', text: html };
    const first = webToolContent(response);
    expect(first.text.length).toBeLessThanOrEqual(8000);
    expect(first).toMatchObject({ truncated: true, offset: 0, nextOffset: 8000 });
    let offset: number | null = 0; let complete = '';
    while (offset !== null) {
      const page = webToolContent(response, 'text', { offset });
      expect(page.sourceSHA256).toBe(first.sourceSHA256); complete += page.text; offset = page.nextOffset;
    }
    expect(complete).toBe(readableHtml(html, response.url));
    expect(complete).toContain('FINAL_SOURCE_FACT');
    expect(first.sourceSHA256).toBe(createHash('sha256').update(complete).digest('hex'));
  });

  it('preserves UTF-16 surrogate pairs and handles an exhausted cursor without fabricating content', () => {
    const source = `${'a'.repeat(255)}🌧️${'b'.repeat(600)}`;
    const first = textPage(source, { maxCharacters: 256 });
    expect(first.text).toBe('a'.repeat(255)); expect(first.nextOffset).toBe(255);
    const next = textPage(source, { offset: first.nextOffset!, maxCharacters: 256 });
    expect(next.text.startsWith('🌧️')).toBe(true);
    expect(textPage(source, { offset: source.length + 100 })).toMatchObject({ text: '', nextOffset: null, totalCharacters: source.length });
  });

  it.each(['workspace.read', 'web.read'])('pages the actual %s tool contract, including an explicit next page', async id => {
    const source = 'SYNTHETIC_LITERAL_SOURCE '.repeat(1000) + 'LAST_FACT';
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { workspace: { read: async () => source }, web: { read: async () => ({ url: 'https://example.com', contentType: 'text/plain', text: source }) }, notify: vi.fn(), createTimer: vi.fn() } as unknown as Parameters<typeof registerBuiltinTools>[1]);
    const tool = registry.get(id), base = id === 'workspace.read' ? { path: 'fixture.txt' } : { url: 'https://example.com' };
    const context = { runId: 'synthetic', taskId: 'synthetic', signal: new AbortController().signal };
    const first = await tool.execute(tool.inputSchema.parse(base), context) as ReturnType<typeof textPage> & { content?: string };
    expect((first.content ?? first.text).length).toBe(8000); expect(first.truncated).toBe(true);
    const next = await tool.execute(tool.inputSchema.parse({ ...base, offset: first.nextOffset }), context) as ReturnType<typeof textPage> & { content?: string };
    expect(next.offset).toBe(8000); expect(next.sourceSHA256).toBe(first.sourceSHA256);
    expect(first.content ?? first.text).toBe(source.slice(0, 8000));
    expect(next.content ?? next.text).toBe(source.slice(8000, 16000));
    expect(tool.inputSchema.safeParse({ ...base, maxCharacters: 1_000_000 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...base, offset: -1 }).success).toBe(false);
  });
});

describe('Finding text in a long source', () => {
  const source = `${'x'.repeat(3000)}sendMessageDraft is private only${'y'.repeat(3000)}SENDMESSAGEDRAFT again${'z'.repeat(100)}`;

  it('returns excerpts and offsets for literal matches instead of a page', () => {
    const result = textPage(source, { find: 'sendMessageDraft' });
    expect(result).toMatchObject({ matchCount: 2, matchOffsets: [3000, source.lastIndexOf('SENDMESSAGEDRAFT')], truncated: true, nextOffset: null, totalCharacters: source.length });
    expect(result.text).toContain('sendMessageDraft is private only');
    expect(result.text).toContain('SENDMESSAGEDRAFT again');
    expect(result.text).toContain('[offset 3000]');
    expect(result.text.length).toBeLessThan(2300);
  });

  it('reports no match without returning a page of unrelated text', () => {
    expect(textPage(source, { find: 'missing' })).toMatchObject({ text: '', matchCount: 0, matchOffsets: [] });
  });

  it('keeps excerpts within the requested page size while still counting every match', () => {
    const repeated = Array.from({ length: 20 }, (_, index) => `${'-'.repeat(2000)}needle${index}`).join('');
    const result = textPage(repeated, { find: 'needle', maxCharacters: 2500 });
    expect(result.matchCount).toBe(20);
    expect(result.matchOffsets).toHaveLength(2);
    expect(result.text.length).toBeLessThan(2600);
  });
});
