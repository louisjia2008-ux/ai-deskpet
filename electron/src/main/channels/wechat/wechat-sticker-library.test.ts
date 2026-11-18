// @vitest-environment node
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainRepository } from '../../domain/repository';
import { MediaLibraryService } from '../../media/media-library';
import { WeChatStickerLibrary } from './wechat-sticker-library';

const { encode, png } = vi.hoisted(() => ({
  encode: vi.fn(),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64'),
}));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({
  isEmpty: () => false,
  getSize: () => ({ width: 120, height: 80 }),
  toPNG: encode,
}) } }));

const roots: string[] = [];
afterEach(async () => { encode.mockReset(); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const fixture = async () => {
  encode.mockReturnValue(png);
  const root = await mkdtemp(join(tmpdir(), 'deskpet-wechat-sticker-')); roots.push(root);
  const runtime = join(root, 'listener'); await mkdir(runtime, { mode: 0o700 });
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 34) });
  await repository.initialize();
  const media = new MediaLibraryService(repository, join(root, 'managed'));
  const source = join(root, '问候_招手.png');
  await writeFile(source, png);
  const [asset] = (await media.importFiles([source])).imported;
  const stickers = new WeChatStickerLibrary(runtime, media);
  const spool = join(runtime, 'sticker-spool');
  return { asset: asset!, media, root, stickers, spool };
};
const request = { target: 'private', groupId: null, eventId: 'b'.repeat(64), text: '/sticker', reply: '收到表情请求。' } as const;
const digest = createHash('sha256').update(png).digest('hex');
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
};

describe('WeChat sticker library', () => {
  it('isolates QQ, owner private and explicitly granted exact WeChat group identities', async () => {
    const { asset, media, stickers, spool } = await fixture();
    expect(await stickers.select(request)).toBeNull();
    await media.update({ id: asset.id, allowQq: true });
    expect(await stickers.select(request)).toBeNull();
    await media.update({ id: asset.id, allowWechat: true });
    expect(await stickers.select(request)).toBe(digest);
    const path = join(spool, `${request.eventId}.${digest}.png`);
    expect(await readFile(path)).toEqual(png);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(spool)).mode & 0o777).toBe(0o700);
    const group = { ...request, target: 'group', groupId: 'legacy', eventId: 'c'.repeat(64), text: '@桌宠 /sticker' } as const;
    expect(await stickers.select(group)).toBeNull();
    await media.update({ id: asset.id, allowWechat: false, allowWechatGroups: ['legacy'] });
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stickers.select(request)).toBeNull();
    expect(await stickers.select(group)).toBe(digest);
    expect(await stickers.select({ ...group, groupId: 'a'.repeat(32) })).toBeNull();
    await media.remove(asset.id);
    await expect(lstat(join(spool, `${group.eventId}.${digest}.png`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows an untagged image for an explicit library command in its approved chat', async () => {
    const { asset, media, stickers } = await fixture();
    await media.update({ id: asset.id, title: 'Fixture asset', tags: [], allowWechat: true, allowWechatGroups: ['legacy'] });
    expect(await stickers.select({ ...request, text: '/sticker library extra' })).toBeNull();
    expect(await stickers.select({ ...request, text: '/sticker library' })).toBe(digest);
    const group = { ...request, target: 'group', eventId: 'c'.repeat(64), text: '@桌宠 /sticker library' } as const;
    expect(await stickers.select({ ...group, groupId: 'legacy' })).toBe(digest);
    expect(await stickers.select({ ...group, groupId: 'a'.repeat(32) })).toBeNull();
  });

  it('fails closed if approval is revoked during asset read or the spool is a symlink', async () => {
    const { asset, media, root, stickers, spool } = await fixture();
    await media.update({ id: asset.id, allowWechat: true });
    const read = media.read.bind(media);
    const deferred = gate();
    const reading = gate();
    const spy = vi.spyOn(media, 'read').mockImplementation(async id => {
      reading.resolve();
      await deferred.promise;
      return read(id);
    });
    const stale = stickers.select(request);
    await reading.promise;
    await media.update({ id: asset.id, allowWechat: false });
    deferred.resolve();
    await expect(stale).rejects.toThrow('media.wechatNotAllowed');
    spy.mockRestore();
    await media.update({ id: asset.id, allowWechat: true });
    const other = join(root, 'other');
    await mkdir(other, { mode: 0o700 });
    await symlink(other, spool);
    await expect(stickers.select(request)).rejects.toThrow('media.invalidStorage');
  });

  it('awaits the asynchronous channel authority and clears a stale staged copy', async () => {
    const { asset, media, stickers, spool } = await fixture();
    await media.update({ id: asset.id, allowWechat: true });
    const authority = vi.fn().mockResolvedValue(undefined).mockRejectedValueOnce(Error('wechat.unavailable'));
    await expect(stickers.select({ ...request, assertCurrent: authority })).rejects.toThrow('wechat.unavailable');
    await expect(lstat(spool)).rejects.toMatchObject({ code: 'ENOENT' });
    authority.mockReset().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('wechat.unavailable'));
    await expect(stickers.select({ ...request, assertCurrent: authority })).rejects.toThrow('wechat.unavailable');
    await expect(lstat(join(spool, `${request.eventId}.${digest}.png`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
