// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerResearchArtifactTools } from './research-artifact-tools';
import type { ResearchArtifactToolHost } from './research-artifact-tools';
import type { textPage } from './text-page';

const fixture = (text = 'SYNTHETIC_VERIFIED_RESEARCH '.repeat(700) + 'FINAL_FACT') => {
  const path = `research/${randomUUID()}/report.md`, controller = new AbortController();
  const receipt = { path, text, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), privacy: 'cloud-allowed' as const };
  const read = vi.fn<ResearchArtifactToolHost['read']>(async () => receipt), assertAuthorized = vi.fn();
  const registry = new ToolRegistry(); registerResearchArtifactTools(registry, { read });
  const context = { runId: randomUUID(), taskId: randomUUID(), signal: controller.signal, assertAuthorized };
  const execute = (input: unknown = { path }) => registry.get('research.read').execute(input, context) as Promise<Omit<typeof receipt, 'text'> & ReturnType<typeof textPage>>;
  return { path, controller, receipt, read, assertAuthorized, registry, context, execute };
};

describe('verified research artifact reading', () => {
  it('declares one read-only workspace capability without model-controlled ownership or authority', () => {
    const f = fixture(), definition = f.registry.describe()[0]!;
    expect(definition).toMatchObject({ id: 'research.read', capabilityId: 'workspace.read', sideEffect: false, risk: 'medium' });
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(Object.keys(definition.parameters.properties as object)).toEqual(['path', 'offset', 'maxCharacters']);
  });

  it('reconstructs exact artifact text in bounded pages, retaining host receipts and revalidating each page', async () => {
    const f = fixture();
    let offset: number | null = 0, reconstructed = '', pages = 0;
    while (offset !== null) {
      const result = await f.execute({ path: f.path, offset }); pages++;
      expect(result).toMatchObject({ path: f.path, bytes: f.receipt.bytes, sha256: f.receipt.sha256, privacy: 'cloud-allowed', sourceSHA256: f.receipt.sha256 });
      expect(result.text.length).toBeLessThanOrEqual(8_000);
      expect(result.totalCharacters).toBe(f.receipt.text.length);
      expect(result.truncated).toBe(true);
      reconstructed += result.text; offset = result.nextOffset;
    }
    expect(reconstructed).toBe(f.receipt.text); expect(reconstructed.endsWith('FINAL_FACT')).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(pages);
    expect(f.read).toHaveBeenCalledWith(f.context.runId, f.path, f.controller.signal, expect.any(Function));
    expect(f.assertAuthorized).toHaveBeenCalledTimes(pages * 2);
  });

  it('honors smaller pages, preserves surrogate pairs and returns an empty exhausted page', async () => {
    const f = fixture(`${'a'.repeat(255)}🌧️${'b'.repeat(600)}`);
    const first = await f.execute({ path: f.path, maxCharacters: 256 });
    expect(first.text).toBe('a'.repeat(255)); expect(first.nextOffset).toBe(255);
    const next = await f.execute({ path: f.path, maxCharacters: 256, offset: first.nextOffset });
    expect(next.text.startsWith('🌧️')).toBe(true); expect(next.text.length).toBeLessThanOrEqual(256);
    expect(await f.execute({ path: f.path, offset: 50_000 })).toMatchObject({ text: '', nextOffset: null, totalCharacters: f.receipt.text.length });
  });

  it.each([
    { path: '' }, { path: '/etc/secret' }, { path: '../secret' }, { path: 'research/../secret' }, { path: 'research/./report.md' },
    { path: 'research//report.md' }, { path: 'research\\report.md' }, { path: 'C:/secret' }, { path: 'research/secret\0.md' },
    { maxCharacters: 8_001 }, { maxCharacters: 255 }, { offset: -1 }, { offset: 2_000_001 }, { offset: 0.5 },
    { runId: 'spoofed' }, { sessionId: 'spoofed' }, { privacy: 'cloud-allowed' }, { approved: true }, { find: 'unbounded search' },
  ])('rejects invalid path, unbounded paging or caller authority before reading: %j', async invalid => {
    const f = fixture(); await expect(f.execute({ path: f.path, ...invalid })).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('blocks an aborted or revoked call before the host is read', async () => {
    const aborted = fixture(); aborted.controller.abort();
    await expect(aborted.execute()).rejects.toMatchObject({ name: 'AbortError' }); expect(aborted.read).not.toHaveBeenCalled();
    const revoked = fixture(); revoked.assertAuthorized.mockImplementation(() => { throw new Error('permission revoked'); });
    await expect(revoked.execute()).rejects.toThrow('permission revoked'); expect(revoked.read).not.toHaveBeenCalled();
  });

  it.each(['abort', 'revoke'] as const)('suppresses a result when authority changes during the read: %s', async change => {
    const f = fixture();
    f.read.mockImplementation(async (_runId, _path, _signal, current) => {
      current();
      if (change === 'abort') f.controller.abort();
      else f.assertAuthorized.mockImplementation(() => { throw new Error('permission revoked'); });
      return f.receipt;
    });
    await expect(f.execute()).rejects.toThrow();
  });

  it.each(['research.unavailable', 'research.artifactUnconfirmed', 'research.artifactChanged'])('preserves host refusal without exposing artifact text: %s', async code => {
    const f = fixture(); f.read.mockRejectedValue(new Error(code));
    await expect(f.execute()).rejects.toThrow(code);
  });
});
