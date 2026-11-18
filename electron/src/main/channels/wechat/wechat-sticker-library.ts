import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import type { MediaAsset } from '../../../shared/media';
import type { QqStickerScene } from '../../../shared/qq-sticker-reply';
import { wechatGroupIdSchema } from '../../../shared/wechat-channel';
import type { MediaLibraryService } from '../../media/media-library';
import { atomicWriteFile } from '../../persistence/atomic-file';

const sha = /^[a-f0-9]{64}$/u;
const spoolEntry = /^[a-f0-9]{64}\.[a-f0-9]{64}\.png$/u;
const maxAge = 60 * 60_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const allowedAsset = (asset: MediaAsset): boolean => ['image/png', 'image/jpeg'].includes(asset.mime)
  && Math.min(asset.width, asset.height) >= 32
  && Math.min(asset.width, asset.height) * 240 >= Math.max(asset.width, asset.height) * 32;

interface StickerRequest {
  target: 'private' | 'group';
  groupId: string | null;
  eventId: string;
  text: string;
  reply: string;
  /** A scene the chat model chose; selection then uses scene tags only. */
  scene?: QqStickerScene;
  assertCurrent?(): void | Promise<void>;
}

type StickerMedia = Pick<MediaLibraryService, 'onWechatChanged' | 'selectWechatSticker' | 'assertWechatAllowed' | 'read'>;

function assertStaticPng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw Error('media.invalidImage');
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    offset += size + 12;
    if (offset > bytes.length || kind === 'acTL') throw Error('media.invalidImage');
    if (kind === 'IEND' && size === 0 && offset === bytes.length) return;
  }
  throw Error('media.invalidImage');
}

function encodePng(asset: MediaAsset, bytes: Buffer): Buffer {
  if (asset.mime === 'image/png') assertStaticPng(bytes);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw Error('media.invalidImage');
  const { width, height } = image.getSize();
  if (width !== asset.width || height !== asset.height) throw Error('media.invalidImage');
  const scale = Math.min(1, 240 / Math.max(width, height));
  const widthPx = Math.round(width * scale), heightPx = Math.round(height * scale);
  if (Math.min(widthPx, heightPx) < 32) throw Error('media.invalidDimensions');
  const output = scale < 1
    ? image.resize({ width: widthPx, height: heightPx, quality: 'best' })
    : image;
  const png = output.toPNG();
  if (png.length === 0 || png.length > 2_000_000) throw Error('media.imageTooLarge');
  return png;
}

async function privateDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700)
    throw Error('media.invalidStorage');
}

export class WeChatStickerLibrary {
  readonly #spool: string;
  #revision = 0;
  #invalidating: Promise<void> | null = null;
  readonly #stageWrites = new Set<Promise<void>>();

  constructor(private readonly runtime: string, private readonly media: StickerMedia) {
    this.#spool = join(runtime, 'sticker-spool');
    media.onWechatChanged(() => this.invalidate());
  }

  async #directory(create: boolean): Promise<string> {
    await privateDirectory(this.runtime);
    if (create) await mkdir(this.#spool, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateDirectory(this.#spool);
    return this.#spool;
  }

  async #removeEntries(every: boolean): Promise<void> {
    const directory = await this.#directory(false).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!directory) return;
    await Promise.all((await readdir(directory)).filter(name => spoolEntry.test(name)).map(async name => {
      const path = join(directory, name);
      try {
        if (every || Date.now() - (await lstat(path)).mtimeMs > maxAge) await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }));
  }

  invalidate(): Promise<void> {
    this.#revision++;
    this.#invalidating ??= Promise.allSettled([...this.#stageWrites]).then(() => this.#removeEntries(true))
      .finally(() => { this.#invalidating = null; });
    return this.#invalidating;
  }

  async select(input: StickerRequest): Promise<string | null> {
    if (!sha.test(input.eventId) || (input.target === 'private' ? input.groupId !== null
      : input.target !== 'group' || !wechatGroupIdSchema.safeParse(input.groupId).success))
      throw Error('media.wechatNotAllowed');
    const revision = this.#revision;
    if (this.#invalidating) throw Error('media.wechatNotAllowed');
    const explicit = /(?:^|\s)\/sticker(?:\s+library)?\s*$/iu.test(input.text.normalize('NFKC'));
    const asset = this.media.selectWechatSticker(`${input.text} ${input.reply}`, input.groupId, allowedAsset, explicit, input.scene);
    if (!asset) return null;
    const assertCurrent = async (): Promise<void> => {
      if (revision !== this.#revision || this.#invalidating) throw Error('media.wechatNotAllowed');
      await input.assertCurrent?.();
      if (revision !== this.#revision || this.#invalidating) throw Error('media.wechatNotAllowed');
      this.media.assertWechatAllowed(asset.id, input.groupId);
    };
    await assertCurrent();
    const selected = await this.media.read(asset.id);
    await assertCurrent();
    const png = encodePng(selected.asset, selected.bytes);
    const digest = createHash('sha256').update(png).digest('hex');
    const directory = await this.#directory(true);
    await this.#removeEntries(false);
    const path = join(directory, `${input.eventId}.${digest}.png`);
    await assertCurrent();
    const write = atomicWriteFile(path, png);
    this.#stageWrites.add(write);
    try { await write; }
    finally { this.#stageWrites.delete(write); }
    try { await assertCurrent(); }
    catch (error) { await unlink(path).catch(() => undefined); throw error; }
    return digest;
  }
}
