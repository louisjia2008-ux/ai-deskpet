// @vitest-environment node
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { chatImageAttachmentSchema, defaultMediaSettings, mediaLibrarySchema } from '../../shared/media';
import { createDefaultState, persistentStateSchema } from '../domain/schemas';
import { DomainRepository } from '../domain/repository';
import { MediaLibraryService } from './media-library';
import { readMediaProtocolFile } from './media-file';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) } }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (fetcher?: typeof fetch) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-media-')); roots.push(root);
  const path = join(root, 'profile.enc.json'), managed = join(root, 'managed');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 62) };
  const repo = new DomainRepository(path, vault); await repo.initialize(); let now = Date.parse('2026-11-06T13:00:00.000Z');
  const library = new MediaLibraryService(repo, managed, { now: () => now, ...(fetcher ? { fetch: fetcher } : {}) });
  return { root, repo, library, managed, setNow: (value: number) => { now = value; }, reopen: async () => { const r = new DomainRepository(path, vault); await r.initialize(); return new MediaLibraryService(r, managed); } };
};

describe('managed image library', () => {
  it('reads old profiles without replacing old data and keeps attachments bounded', () => {
    const old = createDefaultState(); const { mediaLibrary, ...legacy } = old; void mediaLibrary;
    expect(persistentStateSchema.parse(legacy).mediaLibrary).toEqual({ assets: [], settings: defaultMediaSettings(), recentUses: [] });
    expect(chatImageAttachmentSchema.parse({ assetId: 'a'.repeat(64), alt: '收到' })).toEqual({ assetId: 'a'.repeat(64), alt: '收到' });
    expect(chatImageAttachmentSchema.safeParse({ assetId: '../../secret', alt: 'bad' }).success).toBe(false);
    expect(mediaLibrarySchema.safeParse({ assets: [], settings: defaultMediaSettings(), recentUses: [], arbitrary: true }).success).toBe(false);
  });

  it('imports content-addressed bytes, keeps GIF original, deduplicates and persists management across restart', async () => {
    const f = await fixture(), file = join(f.root, 'Happy_开心.png'), duplicate = join(f.root, 'copy.png'), animation = join(f.root, 'hug.gif');
    await writeFile(file, png); await writeFile(duplicate, png); await writeFile(animation, gif);
    const result = await f.library.importFiles([file, duplicate, animation]);
    expect(result.imported).toHaveLength(2); expect(result.reused).toBe(1); expect(result.skipped).toBe(0);
    const asset = result.imported[0]!; expect(asset.id).toBe(createHash('sha256').update(png).digest('hex')); expect(asset.tags).toContain('开心');
    expect(asset.allowQq).toBe(false); expect((await f.library.read(result.imported[1]!.id)).bytes).toEqual(gif);
    await f.library.update({ id: asset.id, title: '收到啦', tags: ['收到', '确认'], allowQq: true });
    const prepared = await f.library.prepareQqImage(asset.id); expect(Buffer.from(prepared.base64, 'base64')).toEqual(png);
    await f.library.remove(asset.id); await expect(f.library.prepareQqImage(asset.id)).rejects.toThrow('media.qqNotAllowed');
    expect((await f.library.read(asset.id)).bytes).toEqual(png); // History survives a reversible deletion.
    const reopened = await f.reopen(); expect((await reopened.snapshot()).assets.find(a => a.id === asset.id)?.deletedAt).not.toBeNull();
    await reopened.restore(asset.id); expect((await reopened.snapshot()).assets.find(a => a.id === asset.id)).toMatchObject({ title: '收到啦', allowQq: true, deletedAt: null });
    await reopened.update({ id: asset.id, enabled: false }); await expect(reopened.prepareQqImage(asset.id)).rejects.toThrow('media.qqNotAllowed');
    expect((await reopened.read(asset.id)).bytes).toEqual(png);
  });

  it('skips non-images and symbolic links, rejects storage substitution and serves only exact verified image hashes', async () => {
    const f = await fixture(), source = join(f.root, 'source'); await mkdir(source);
    await writeFile(join(source, 'ok.png'), png); await writeFile(join(source, 'not-image.png'), 'not an image');
    await writeFile(join(source, 'notes.txt'), 'Do not execute this text'); await symlink(join(source, 'ok.png'), join(source, 'linked.png'));
    const result = await f.library.importDirectory(source); expect(result.imported).toHaveLength(1); expect(result.skipped).toBe(1);
    const a = result.imported[0]!, local = `reply-images/${a.id}.png`;
    expect((await readMediaProtocolFile(f.managed, local))?.bytes).toEqual(png);
    expect(await readMediaProtocolFile(f.managed, `reply-images/../secret.png`)).toBeNull();
    await writeFile(join(f.managed, local), Buffer.alloc(png.length, 0));
    await expect(f.library.read(a.id)).rejects.toThrow('media.storageMismatch');
    await expect(readMediaProtocolFile(f.managed, local)).rejects.toThrow('media.storageMismatch');
    await rm(join(f.managed, local)); await symlink(join(source, 'ok.png'), join(f.managed, local));
    await expect(f.library.read(a.id)).rejects.toThrow('media.storageMismatch');
  });

  it('accepts the purchased 4960 by 7016 gift dimensions while retaining pixel, edge and byte bounds', async () => {
    const f = await fixture(), file = join(f.root, 'gift.png'); await writeFile(file, png);
    const gift = new MediaLibraryService(f.repo, f.managed, { inspectImage: () => ({ width: 4960, height: 7016 }) });
    expect((await gift.importFiles([file])).imported[0]).toMatchObject({ width: 4960, height: 7016 });
    const tooManyPixels = new MediaLibraryService(f.repo, f.managed, { inspectImage: () => ({ width: 7000, height: 6000 }) });
    expect((await tooManyPixels.importFiles([file])).skipped).toBe(1);
    const tooWide = new MediaLibraryService(f.repo, f.managed, { inspectImage: () => ({ width: 8193, height: 1 }) });
    expect((await tooWide.importFiles([file])).skipped).toBe(1);
    await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    expect((await gift.importFiles([file])).skipped).toBe(1);
  });

  it('chooses matching enabled images only, separates QQ approval and applies per-session cooldown and repetition limits', async () => {
    const f = await fixture(), file = join(f.root, '收到.png'); await writeFile(file, png); const asset = (await f.library.importFiles([file])).imported[0]!;
    expect(f.library.selectForReply('好的收到', 'desktop', 'session')).toBeNull();
    await f.library.configure({ ...defaultMediaSettings(), autoReplyDesktop: true, autoReplyQq: true, cooldownSeconds: 30 });
    expect(f.library.selectForReply('好的收到', 'desktop', 'session')?.id).toBe(asset.id);
    expect(f.library.selectForReply('好的收到', 'qq', 'session')).toBeNull(); await f.library.update({ id: asset.id, allowQq: true });
    expect(f.library.selectForReply('好的收到', 'qq', 'session')?.id).toBe(asset.id);
    await f.library.markUsed(asset.id, 'session'); expect(f.library.selectForReply('收到', 'qq', 'session')).toBeNull();
    f.setNow(Date.parse('2026-11-06T14:00:00.000Z')); expect(f.library.selectForReply('收到', 'desktop', 'session')?.id).toBe(asset.id);
    expect(f.library.selectForReply('收到', 'desktop', 'another-session')?.id).toBe(asset.id); expect(f.library.selectForReply('没有相应场景', 'desktop', 'another-session')).toBeNull();
  });

  it('generates one bounded official image request, keeps credentials outside stored metadata and rejects stale authority before saving', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }));
    const f = await fixture(fetcher), config: ProviderConfig = { id: randomUUID(), kind: 'openai', name: 'Synthetic', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', enabled: true, supportsTools: true, secretState: 'configured' };
    const input = { providerId: config.id, model: 'gpt-image-2', prompt: '画一只挥爪的小猫，中文文字“收到啦”。' };
    const asset = await f.library.generate(input, { config, apiKey: 'SYNTHETIC_MEDIA_KEY' });
    expect(asset.source.kind).toBe('generated'); expect(fetcher).toHaveBeenCalledOnce();
    const call = fetcher.mock.calls[0]!; expect(String(call[0])).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ model: 'gpt-image-2', prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png' });
    expect(JSON.stringify(f.repo.snapshot().mediaLibrary)).not.toContain('SYNTHETIC_MEDIA_KEY');
    const before = await readFile(join(f.root, 'profile.enc.json')); let checks = 0;
    await expect(f.library.generate(input, { config, apiKey: 'SYNTHETIC_MEDIA_KEY', assertCurrent: () => { if (++checks > 1) throw new Error('provider.bindingMismatch'); } })).rejects.toThrow('provider.bindingMismatch');
    expect(await readFile(join(f.root, 'profile.enc.json'))).toEqual(before);
    await expect(f.library.generate(input, { config: { ...config, baseUrl: 'https://elsewhere.invalid/v1' }, apiKey: 'SYNTHETIC_MEDIA_KEY' })).rejects.toThrow('media.providerUnavailable');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps safe API failures out of the library and rejects oversized or malformed image responses', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'insufficient_quota', message: 'PRIVATE_ERROR_CONTENT' } }, { status: 429 }));
    const f = await fixture(fetcher), config: ProviderConfig = { id: randomUUID(), kind: 'openai', name: 'Synthetic', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', enabled: true, supportsTools: true, secretState: 'configured' };
    const input = { providerId: config.id, model: 'gpt-image-2', prompt: 'Synthetic image request' };
    await expect(f.library.generate(input, { config, apiKey: 'SYNTHETIC_KEY' })).rejects.toThrow('provider.quota');
    expect((await f.library.snapshot()).assets).toEqual([]);
    fetcher.mockImplementation(async () => Response.json({ data: [{ b64_json: 'not valid base64 !' }] }));
    await expect(f.library.generate(input, { config, apiKey: 'SYNTHETIC_KEY' })).rejects.toThrow('media.invalidResponse');
    fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(26 * 1024 * 1024)); controller.close(); } })));
    await expect(f.library.generate(input, { config, apiKey: 'SYNTHETIC_KEY' })).rejects.toThrow('media.imageTooLarge');
    expect((await f.library.snapshot()).assets).toEqual([]);
  });
  it('draws a scene sticker from the tagged character reference, falls back to the description, and files it for WeChat', async () => {
    const other = Buffer.concat([png, Buffer.from('second')]);
    const replies: Response[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => replies.shift() ?? Response.json({ data: [{ b64_json: png.toString('base64') }] }));
    const f = await fixture(fetcher), config: ProviderConfig = { id: randomUUID(), kind: 'openai', name: 'Synthetic', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', enabled: true, supportsTools: true, secretState: 'configured' };
    const credentials = { config, apiKey: 'SYNTHETIC_MEDIA_KEY' };
    const input = { providerId: config.id, model: 'gpt-image-2.6-sunburst', scene: 'goodnight' as const };
    expect(f.library.autoStickerStatus('goodnight')).toEqual({ available: 0, generatedToday: 0 });

    const plain = await f.library.generateSticker(input, credentials);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as { model: string; prompt: string };
    expect(body.model).toBe('gpt-image-2.6-sunburst');
    expect(body.prompt).toMatch(/light-blue hair.*sleepy/su);
    expect(plain).toMatchObject({ tags: ['晚安', '自动表情'], allowWechat: true, enabled: true, source: { kind: 'generated', name: '自动表情' } });
    expect(f.library.autoStickerStatus('goodnight')).toEqual({ available: 1, generatedToday: 1 });

    const file = join(f.root, 'reference.png'); await writeFile(file, other);
    const [reference] = (await f.library.importFiles([file])).imported;
    await f.library.update({ id: reference!.id, tags: ['角色参考'] });
    replies.push(Response.json({ data: [{ b64_json: Buffer.concat([png, Buffer.from('edit')]).toString('base64') }] }));
    await f.library.generateSticker({ ...input, scene: 'thanks' }, credentials);
    const edit = fetcher.mock.calls[1]!;
    expect(String(edit[0])).toBe('https://api.openai.com/v1/images/edits');
    expect(String((edit[1]!.headers as Record<string, string>)['content-type'])).toMatch(/^multipart\/form-data; boundary=deskpet-/u);
    const multipart = Buffer.from(edit[1]!.body as Uint8Array);
    expect(multipart.includes(other)).toBe(true);
    expect(multipart.toString('latin1')).toContain('name="image[]"');

    replies.push(Response.json({ error: { message: 'unsupported' } }, { status: 400 }));
    replies.push(Response.json({ data: [{ b64_json: Buffer.concat([png, Buffer.from('fallback')]).toString('base64') }] }));
    const fallback = await f.library.generateSticker({ ...input, scene: 'comfort' }, credentials);
    expect(fetcher.mock.calls.slice(2).map(call => String(call[0]))).toEqual(['https://api.openai.com/v1/images/edits', 'https://api.openai.com/v1/images/generations']);
    expect(fallback.tags).toEqual(['抱抱', '自动表情']);
    expect(JSON.stringify(f.repo.snapshot().mediaLibrary)).not.toContain('SYNTHETIC_MEDIA_KEY');

    replies.push(Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
    await expect(f.library.generateSticker({ ...input, scene: 'celebrate' }, credentials)).rejects.toThrow('provider.quota');
    await expect(f.library.generateSticker({ ...input, model: 'dall-e-3' }, credentials)).rejects.toThrow('media.invalidModel');
  });
  it('offers a tagged still picture for Moments when no image service is set, Moments tag first', async () => {
    const f = await fixture();
    expect(f.library.momentsPicture()).toBeNull();
    const files = await Promise.all(['ref', 'moment', 'old'].map(async name => { const file = join(f.root, `${name}.png`); await writeFile(file, Buffer.concat([png, Buffer.from(name)])); return file; }));
    const [ref, moment, old] = (await f.library.importFiles(files)).imported;
    await f.library.update({ id: ref!.id, tags: ['角色参考'] });
    expect(f.library.momentsPicture()).toBe(ref!.id);
    await f.library.update({ id: old!.id, tags: ['朋友圈'] });
    await f.library.update({ id: moment!.id, tags: ['朋友圈'] });
    await f.library.remove(old!.id);
    expect(f.library.momentsPicture()).toBe(moment!.id);
  });
});
