import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ensureDownload } from './dedicated-artifacts';

const URL = 'https://example.invalid/fixture.jar';
const contents = 'verified';
const checksum = createHash('sha256').update(contents).digest('hex');

test('retries a transient HTTP failure and interrupted body, then publishes checked bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deskpet-download-test-'));
  const file = join(directory, 'fixture.jar');
  const interrupted = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('ver')); },
    pull(controller) { controller.error(new Error('connection closed')); },
  });
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(interrupted))
    .mockResolvedValueOnce(new Response(contents));
  vi.stubGlobal('fetch', fetch);
  try {
    await ensureDownload(file, URL, 'sha256', checksum, new AbortController().signal, contents.length);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readFile(file, 'utf8')).toBe(contents);
    expect(await readdir(directory)).toEqual(['fixture.jar']);
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ['permanent HTTP response', () => new Response(null, { status: 404 }), /HTTP 404/u],
  ['insecure redirect', () => new Response(null, { status: 302, headers: { Location: 'http://example.invalid/fixture.jar' } }), /requires HTTPS/u],
  ['oversized body', () => new Response(contents + '!'), /download limit/u],
  ['checksum mismatch', () => new Response('modified'), /SHA256 verification failed/u],
] as const)('rejects a %s without retry or a cached file', async (_name, response, error) => {
  const directory = await mkdtemp(join(tmpdir(), 'deskpet-download-test-'));
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(ensureDownload(join(directory, 'fixture.jar'), URL, 'sha256', checksum, new AbortController().signal, contents.length)).rejects.toThrow(error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
