import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { nativeImage } from 'electron';
import type { ProviderConfig } from '../../shared';
import type { QqStickerScene } from '../../shared/qq-sticker-reply';
import { defaultMediaLibrary, MEDIA_MAX_ASSETS, MEDIA_MAX_ASSET_BYTES, mediaAssetIdSchema, mediaAssetUrl, mediaGenerateSchema, mediaSettingsSchema, mediaUpdateSchema } from '../../shared/media';
import type { MediaAsset, MediaGenerateInput, MediaImportResult, MediaSettings, MediaSnapshot, MediaUpdate } from '../../shared/media';
import type { DomainRepository } from '../domain/repository';
import { atomicWriteFile } from '../persistence/atomic-file';
import { safeProviderHttpErrorCode } from '../providers/http-errors';

const MAX_LIBRARY_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_FILES = 500;
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
type ImageInfo = Pick<MediaAsset, 'mime' | 'extension' | 'width' | 'height'>;
type ReplyCandidates = { assets: MediaAsset[]; previous: Set<string> };
export interface MediaLibraryOptions {
  now?: () => number;
  inspectImage?: (bytes: Buffer) => { width: number; height: number };
  fetch?: typeof fetch;
  changed?: () => void;
}
export interface MediaGenerationCredentials { config: ProviderConfig; apiKey: string; assertCurrent?: () => void }
const sniff = (bytes: Buffer): Pick<ImageInfo, 'mime' | 'extension'> | null => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', extension: 'gif' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  return null;
};
const classifyTags = (name: string): string[] => {
  const tags = name.replace(/\.[^.]+$/u, '').split(/[\s_-]+/u).filter(tag => tag.length > 0 && tag.length <= 40).slice(0, 12);
  const aliases: Array<[RegExp, string]> = [[/angry|怒|生气/iu, '生气'], [/happy|开心|笑/iu, '开心'], [/sad|哭|难过/iu, '安慰'], [/sleep|晚安|困/iu, '晚安'], [/thanks?|谢谢/iu, '谢谢'], [/yes|ok|收到|好哒/iu, '收到'], [/hug|抱抱/iu, '抱抱'], [/love|爱|喜欢/iu, '喜欢'], [/morning|早安/iu, '早安']];
  for (const [pattern, tag] of aliases) if (pattern.test(name)) tags.push(tag);
  return [...new Set(tags)].slice(0, 30);
};
const textIntents = (text: string): string[] => {
  const intents: string[] = [];
  const groups: Array<[RegExp, string[]]> = [
    [/早安|早上好|good\s*morning/iu, ['早安', 'morning']], [/晚安|睡觉|睡了|good\s*night/iu, ['晚安', 'sleep']],
    [/谢谢|感谢|thank/iu, ['谢谢', 'thanks']], [/好累|累了|难过|伤心|委屈|抱抱|tired|sad|hug/iu, ['安慰', '抱抱', 'hug']],
    [/完成了|搞定|成功|太棒|开心|庆祝|congrat|done|happy/iu, ['开心', '庆祝', '点赞', 'happy']],
    [/收到|明白|知道了|好哒|好的|了解|\bok\b/iu, ['收到', '确认', 'ok']], [/喜欢|爱你|love/iu, ['喜欢', '爱心', 'love']],
    [/加油|努力|鼓励|cheer/iu, ['加油', '鼓励', 'cheer']], [/疑惑|不懂|confused/iu, ['疑惑', '困惑', 'confused']],
  ];
  for (const [pattern, tags] of groups) if (pattern.test(text)) intents.push(...tags);
  return intents;
};

const stickerSceneTags: Record<QqStickerScene, readonly string[]> = {
  greeting: ['招手', '问候', '打招呼', '你好', 'greeting', 'wave'],
  noon: ['中午', '午安', '午休', 'noon'],
  goodnight: ['晚安', '睡觉', 'sleep'],
  amusement: ['偷笑', '捂脸', '大笑', '笑哭', 'laugh'],
  celebrate: ['庆祝', '开心', '点赞', 'happy'],
  comfort: ['抱抱', '安慰', 'hug'],
  thanks: ['谢谢', '感谢', 'thanks'],
  acknowledge: ['收到', '确认', '明白', 'ok'],
  encourage: ['加油', '鼓励', 'cheer'],
  affection: ['爱心', '喜欢', 'love'],
};

/** The owner marks one library image with this tag as the character to draw. */
export const CHARACTER_REFERENCE_TAG = '角色参考';
export const AUTO_STICKER_TAG = '自动表情';
const CHARACTER_DESCRIPTION = 'a chibi anime cat girl with long light-blue hair with soft pink streaks, light-blue cat ears, big blue eyes, a heart-shaped ahoge, a tiny cream hamster sitting on her head, a light-blue winter dress with white fur trim and white pom-poms, a navy bow tie, white thigh-high socks and a fluffy light-blue cat tail';
export const MOMENTS_TAG = '朋友圈';
const ILLUSTRATION_STYLE = 'Soft anime illustration with gentle lighting and a natural background, like a casual photo-diary picture; the character is clearly visible but need not be centered. No text, no letters, no watermark, no border, no other recognizable people.';
const STICKER_STYLE = 'A chat sticker: chibi proportions, expressive face, bold clean outline, flat cel shading, one character centered on a plain white background, no text, no letters, no watermark, no border.';
const stickerSceneActions: Record<QqStickerScene, string> = {
  greeting: 'waving hello with a bright smile',
  noon: 'holding a small lunch box with a cheerful midday smile',
  goodnight: 'sleepy and hugging a pillow, eyes half closed, with a small moon and stars',
  amusement: 'giggling with a paw-like hand over her mouth',
  celebrate: 'cheering with both arms raised among confetti',
  comfort: 'giving a warm gentle hug with a caring smile',
  thanks: 'bowing slightly with hands together and a grateful smile',
  acknowledge: 'giving an OK hand sign with a confident nod',
  encourage: 'doing a determined fist pump, full of energy',
  affection: 'making a heart shape with both hands and blushing',
};

/** Images are imported bytes plus encrypted metadata. No arbitrary filesystem
 * path or provider URL can become a chat/QQ attachment. */
export class MediaLibraryService {
  readonly #now: () => number;
  readonly #inspect: (bytes: Buffer) => { width: number; height: number };
  readonly #fetch: typeof fetch;
  #wechatMutating = 0;
  readonly #wechatChanged = new Set<() => Promise<void>>();
  constructor(private readonly repository: DomainRepository, private readonly managedRoot: string, private readonly options: MediaLibraryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#inspect = options.inspectImage ?? (bytes => { const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw new Error('media.invalidImage'); return image.getSize(); });
    this.#fetch = options.fetch ?? fetch;
  }
  #state() { return this.repository.snapshot().mediaLibrary ?? defaultMediaLibrary(); }
  #changed(): void { this.options.changed?.(); }
  onWechatChanged(listener: () => Promise<void>): () => void {
    this.#wechatChanged.add(listener);
    return () => { this.#wechatChanged.delete(listener); };
  }
  async #changeWechat<T>(change: () => Promise<T>): Promise<T> {
    this.#wechatMutating++;
    try {
      await Promise.all([...this.#wechatChanged].map(listener => listener()));
      return await change();
    } finally { this.#wechatMutating--; }
  }
  async snapshot(): Promise<MediaSnapshot> {
    await this.repository.flush(); await this.repository.recoverAuthority();
    const state = this.#state(); return { assets: state.assets.map(asset => ({ ...asset, url: mediaAssetUrl(asset) })), settings: state.settings };
  }
  snapshotSettings(): MediaSettings { return structuredClone(this.#state().settings); }
  /** A still picture the owner tagged for Moments, else the character reference; least used first. */
  momentsPicture(): string | null {
    const still = this.#state().assets.filter(asset => !asset.deletedAt && asset.enabled && asset.mime !== 'image/gif');
    for (const tag of [MOMENTS_TAG, CHARACTER_REFERENCE_TAG]) {
      const tagged = still.filter(asset => asset.tags.includes(tag)).sort((a, b) => a.useCount - b.useCount || a.id.localeCompare(b.id));
      if (tagged.length) return tagged[0]!.id;
    }
    return null;
  }
  async configure(raw: MediaSettings): Promise<MediaSettings> {
    const input = mediaSettingsSchema.parse(raw);
    await this.repository.transaction(state => { state.mediaLibrary.settings = input; }); this.#changed(); return input;
  }
  async #directory(): Promise<string> {
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    const directory = join(this.managedRoot, 'reply-images'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('media.invalidStorage');
    const root = await realpath(this.managedRoot), canonical = await realpath(directory);
    if (relative(root, canonical) !== 'reply-images') throw new Error('media.invalidStorage');
    return canonical;
  }
  #info(bytes: Buffer): ImageInfo {
    if (bytes.length === 0 || bytes.length > MEDIA_MAX_ASSET_BYTES) throw new Error('media.imageTooLarge');
    const format = sniff(bytes); if (!format) throw new Error('media.invalidImage');
    let size: { width: number; height: number };
    try { size = this.#inspect(bytes); } catch { throw new Error('media.invalidImage'); }
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || size.width * size.height > 40_000_000) throw new Error('media.invalidDimensions');
    return { ...format, ...size };
  }
  async #readImport(path: string): Promise<Buffer> {
    if (!isAbsolute(path) || !extensions.has(extname(path).toLowerCase())) throw new Error('media.unsupportedFile');
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > MEDIA_MAX_ASSET_BYTES) throw new Error('media.invalidFile');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const opened = await file.stat(); if (!opened.isFile() || opened.size > MEDIA_MAX_ASSET_BYTES) throw new Error('media.invalidFile');
      const buffer = Buffer.alloc(opened.size + 1), read = await file.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== opened.size) throw new Error('media.invalidFile'); return buffer.subarray(0, read.bytesRead);
    }
    finally { await file.close(); }
  }
  async #save(bytes: Buffer, name: string, source: MediaAsset['source'], assertCurrent?: () => void): Promise<{ asset: MediaAsset; reused: boolean }> {
    const info = this.#info(bytes), id = digest(bytes), before = this.#state();
    const existing = before.assets.find(asset => asset.id === id);
    if (!existing && (before.assets.length >= MEDIA_MAX_ASSETS || before.assets.reduce((n, a) => n + a.bytes, 0) + bytes.length > MAX_LIBRARY_BYTES)) throw new Error('media.libraryFull');
    const directory = await this.#directory(), filePath = join(directory, `${id}.${info.extension}`);
    // A caller-controlled filename never reaches storage. Refuse links, then
    // verify an existing hash before reuse rather than trusting metadata alone.
    const fileInfo = await lstat(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (fileInfo) {
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== bytes.length || digest(await readFile(filePath)) !== id) throw new Error('media.storageMismatch');
    } else { assertCurrent?.(); await atomicWriteFile(filePath, bytes); }
    assertCurrent?.();
    const at = new Date(this.#now()).toISOString();
    const asset: MediaAsset = existing ?? { id, sha256: id, title: name.replace(/\.[^.]+$/u, '').slice(0, 160).trim() || '图片', tags: classifyTags(name), enabled: true, allowQq: false,
      ...info, bytes: bytes.length, source, createdAt: at, updatedAt: at, deletedAt: null, lastUsedAt: null, useCount: 0 };
    return this.repository.transaction(state => {
      assertCurrent?.();
      const duplicate = state.mediaLibrary.assets.find(item => item.id === id); if (duplicate) return { asset: structuredClone(duplicate), reused: true };
      if (state.mediaLibrary.assets.length >= MEDIA_MAX_ASSETS || state.mediaLibrary.assets.reduce((n, a) => n + a.bytes, 0) + bytes.length > MAX_LIBRARY_BYTES) throw new Error('media.libraryFull');
      state.mediaLibrary.assets.push(asset);
      return { asset, reused: false };
    });
  }
  async importFiles(paths: string[]): Promise<MediaImportResult> {
    if (!Array.isArray(paths) || paths.length > MAX_IMPORT_FILES) throw new Error('media.importLimit');
    const result: MediaImportResult = { imported: [], reused: 0, skipped: 0 };
    for (const path of [...new Set(paths)]) {
      try { const saved = await this.#save(await this.#readImport(path), basename(path), { kind: 'imported', name: basename(path).slice(0, 240) });
        if (saved.reused) result.reused++; else result.imported.push(saved.asset);
      } catch (error) {
        if (error instanceof Error && ['media.libraryFull', 'media.invalidStorage', 'media.storageMismatch'].includes(error.message)) throw error;
        result.skipped++;
      }
    }
    this.#changed(); return result;
  }
  async importDirectory(path: string): Promise<MediaImportResult> {
    if (!isAbsolute(path)) throw new Error('media.invalidDirectory');
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('media.invalidDirectory');
    const files: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6) throw new Error('media.importLimit');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const candidate = join(directory, entry.name);
        if (entry.isDirectory()) await visit(candidate, depth + 1);
        else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) { files.push(candidate); if (files.length > MAX_IMPORT_FILES) throw new Error('media.importLimit'); }
      }
    };
    await visit(path, 0); return this.importFiles(files);
  }
  async update(raw: MediaUpdate): Promise<MediaAsset> {
    const input = mediaUpdateSchema.parse(raw), { id, ...patch } = input;
    const change = () => this.repository.transaction(state => {
      const asset = state.mediaLibrary.assets.find(item => item.id === id); if (!asset) throw new Error('media.unavailable');
      Object.assign(asset, patch, { updatedAt: new Date(this.#now()).toISOString() }); if (patch.tags) asset.tags = [...new Set(patch.tags)]; return structuredClone(asset);
    });
    const saved = patch.allowWechat !== undefined || patch.allowWechatGroups !== undefined || patch.enabled === false
      ? await this.#changeWechat(change) : await change();
    this.#changed(); return saved;
  }
  async remove(id: string): Promise<void> {
    mediaAssetIdSchema.parse(id);
    await this.#changeWechat(() => this.repository.transaction(state => { const asset = state.mediaLibrary.assets.find(item => item.id === id); if (!asset) throw new Error('media.unavailable'); asset.deletedAt = new Date(this.#now()).toISOString(); asset.updatedAt = asset.deletedAt; })); this.#changed();
  }
  async restore(id: string): Promise<MediaAsset> {
    mediaAssetIdSchema.parse(id);
    const saved = await this.repository.transaction(state => { const asset = state.mediaLibrary.assets.find(item => item.id === id); if (!asset) throw new Error('media.unavailable'); asset.deletedAt = null; asset.updatedAt = new Date(this.#now()).toISOString(); return structuredClone(asset); }); this.#changed(); return saved;
  }
  async read(id: string, controls: { forQq?: boolean } = {}): Promise<{ asset: MediaAsset; bytes: Buffer }> {
    mediaAssetIdSchema.parse(id); const asset = this.#state().assets.find(item => item.id === id); if (!asset) throw new Error('media.unavailable');
    if (controls.forQq && (!asset.enabled || !asset.allowQq || asset.deletedAt)) throw new Error('media.qqNotAllowed');
    const directory = await this.#directory(), target = join(directory, `${asset.id}.${asset.extension}`), info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes || info.size > MEDIA_MAX_ASSET_BYTES) throw new Error('media.storageMismatch');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
    try { const buffer = Buffer.alloc(asset.bytes + 1), part = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, part.bytesRead); } finally { await handle.close(); }
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256 || sniff(bytes)?.mime !== asset.mime) throw new Error('media.storageMismatch');
    return { asset, bytes };
  }
  async prepareQqImage(id: string): Promise<{ assetId: string; sha256: string; mime: MediaAsset['mime']; base64: string }> {
    const { asset, bytes } = await this.read(id, { forQq: true }); return { assetId: id, sha256: asset.sha256, mime: asset.mime, base64: bytes.toString('base64') };
  }
  assertQqAllowed(id: string, sha256: string): void {
    const asset = this.#state().assets.find(item => item.id === id);
    if (!asset || asset.sha256 !== sha256 || asset.deletedAt || !asset.enabled || !asset.allowQq) throw new Error('media.qqNotAllowed');
  }
  #wechatAllowed(asset: MediaAsset, groupId: string | null): boolean {
    return !this.#wechatMutating && asset.enabled && !asset.deletedAt
      && (groupId === null ? asset.allowWechat === true : asset.allowWechatGroups?.includes(groupId) === true);
  }
  assertWechatAllowed(id: string, groupId: string | null): void {
    const asset = this.#state().assets.find(item => item.id === id);
    if (!asset || !this.#wechatAllowed(asset, groupId)) throw new Error('media.wechatNotAllowed');
  }
  selectWechatSticker(text: string, groupId: string | null, accepts: (asset: MediaAsset) => boolean, explicit: boolean, scene?: QqStickerScene): MediaAsset | null {
    const state = this.#state();
    const assets = state.assets.filter(asset => this.#wechatAllowed(asset, groupId) && accepts(asset));
    if (!assets.length) return null;
    const candidates = { assets, previous: new Set<string>() };
    // A scene the model chose is matched by tags only; no match means no sticker.
    if (scene) return this.#rankReplyAssets(candidates, stickerSceneTags[scene])
      ?? (scene === 'noon' ? this.#rankReplyAssets(candidates, stickerSceneTags.greeting) : null);
    const intents = textIntents(text);
    if (/你好|哈喽|您好|问候|打招呼|greet/iu.test(text)) intents.push(...stickerSceneTags.greeting);
    const ranked = this.#rankReplyAssets(candidates, intents);
    return ranked ?? (explicit ? assets[0]!
      : assets.find(asset => /开心|表情|问候|招手|庆祝|happy|greet|wave/iu.test(`${asset.title} ${asset.tags.join(' ')}`)) ?? null);
  }
  #replyCandidates(channel: 'desktop' | 'qq', sessionId: string, accepts?: (asset: MediaAsset) => boolean): ReplyCandidates | null {
    const state = this.#state(), enabled = channel === 'desktop' ? state.settings.autoReplyDesktop : state.settings.autoReplyQq;
    if (!enabled) return null;
    const recent = state.recentUses.filter(use => use.sessionId === sessionId), newest = recent.at(-1);
    if (newest && this.#now() - Date.parse(newest.at) < state.settings.cooldownSeconds * 1000) return null;
    const assets = state.assets.filter(asset => asset.enabled && !asset.deletedAt && (channel !== 'qq' || asset.allowQq) && (!accepts || accepts(asset)));
    return { assets, previous: new Set(recent.slice(-3).map(use => use.assetId)) };
  }

  #rankReplyAssets(candidates: ReplyCandidates, intents: readonly string[]): MediaAsset | null {
    const { assets, previous } = candidates;
    const scored = assets.map(asset => {
      const names = `${asset.title} ${asset.tags.join(' ')}`.toLocaleLowerCase();
      return { asset, score: intents.reduce((n, tag) => n + (names.includes(tag.toLocaleLowerCase()) ? 3 : 0), 0) };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || Number(previous.has(a.asset.id)) - Number(previous.has(b.asset.id)) || a.asset.useCount - b.asset.useCount || a.asset.id.localeCompare(b.asset.id));
    return scored[0]?.asset ?? null;
  }

  selectForReply(text: string, channel: 'desktop' | 'qq', sessionId: string, accepts?: (asset: MediaAsset) => boolean): MediaAsset | null {
    const intents = textIntents(text);
    if (!intents.length) return null;
    const candidates = this.#replyCandidates(channel, sessionId, accepts);
    return candidates ? this.#rankReplyAssets(candidates, intents) : null;
  }

  canSelectQqSticker(sessionId: string, accepts: (asset: MediaAsset) => boolean): boolean {
    return !!this.#replyCandidates('qq', sessionId, accepts)?.assets.length;
  }

  selectQqSticker(scene: QqStickerScene, sessionId: string, accepts: (asset: MediaAsset) => boolean): MediaAsset | null {
    const candidates = this.#replyCandidates('qq', sessionId, accepts);
    if (!candidates) return null;
    return this.#rankReplyAssets(candidates, stickerSceneTags[scene]) ??
      (scene === 'noon' ? this.#rankReplyAssets(candidates, stickerSceneTags.greeting) : null);
  }
  async markUsed(id: string, sessionId: string): Promise<void> {
    mediaAssetIdSchema.parse(id); if (!sessionId || sessionId.length > 160) throw new Error('media.invalidSession');
    await this.repository.transaction(state => { const asset = state.mediaLibrary.assets.find(item => item.id === id); if (!asset || asset.deletedAt || !asset.enabled) throw new Error('media.unavailable');
      const at = new Date(this.#now()).toISOString(); asset.useCount++; asset.lastUsedAt = at; state.mediaLibrary.recentUses.push({ assetId: id, sessionId, at }); state.mediaLibrary.recentUses = state.mediaLibrary.recentUses.slice(-300);
    }); this.#changed();
  }
  async generate(raw: MediaGenerateInput, credentials: MediaGenerationCredentials, signal?: AbortSignal): Promise<MediaAsset> {
    const input = mediaGenerateSchema.parse(raw);
    this.#assertImageProvider(input, credentials);
    const bytes = await this.#requestImage('generations', 'application/json',
      JSON.stringify({ model: input.model, prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png' }), credentials, signal);
    const saved = await this.#save(bytes, input.prompt.slice(0, 60), { kind: 'generated', name: 'API 生成', model: input.model, prompt: input.prompt }, credentials.assertCurrent);
    this.#changed(); return saved.asset;
  }

  #assertImageProvider(input: { providerId: string; model: string }, credentials: MediaGenerationCredentials): void {
    const provider = credentials.config, endpoint = new URL(provider.baseUrl);
    if (provider.id !== input.providerId || provider.kind !== 'openai' || !provider.enabled || endpoint.origin !== 'https://api.openai.com'
      || endpoint.pathname.replace(/\/+$/u, '') !== '/v1' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !credentials.apiKey) throw new Error('media.providerUnavailable');
    if (!/^gpt-image-(?:2|2\.[56]-(?:sunburst|flare))(?:-\d{4}-\d{2}-\d{2})?$/u.test(input.model)) throw new Error('media.invalidModel');
  }

  async #requestImage(kind: 'generations' | 'edits', contentType: string, body: string | Buffer, credentials: MediaGenerationCredentials, signal?: AbortSignal): Promise<Buffer> {
    credentials.assertCurrent?.();
    const response = await this.#fetch(`https://api.openai.com/v1/images/${kind}`, { method: 'POST',
      headers: { 'content-type': contentType, authorization: `Bearer ${credentials.apiKey}` }, credentials: 'omit', redirect: 'error', body: typeof body === 'string' ? body : new Uint8Array(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
    if (!response.body) throw new Error('media.emptyResponse');
    const chunks: Uint8Array[] = []; let total = 0; const reader = response.body.getReader();
    while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > MEDIA_MAX_ASSET_BYTES * 1.5 + 32768) { await reader.cancel(); throw new Error('media.imageTooLarge'); } chunks.push(part.value); }
    let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('media.invalidResponse'); }
    if (!response.ok) throw Object.assign(new Error(safeProviderHttpErrorCode(response.status, parsed)), { status: response.status });
    if (signal?.aborted) throw new Error('media.cancelled'); credentials.assertCurrent?.();
    const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : null;
    const encoded = Array.isArray(data) && data.length === 1 && data[0] && typeof data[0] === 'object' && 'b64_json' in data[0] ? data[0].b64_json : null;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MEDIA_MAX_ASSET_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('media.invalidResponse');
    return Buffer.from(encoded, 'base64');
  }

  /** Scenes with a ready WeChat sticker, and stickers this library generated today. */
  autoStickerStatus(scene: QqStickerScene): { available: number; generatedToday: number } {
    const state = this.#state(), today = new Date(this.#now()).toDateString();
    const live = state.assets.filter(asset => asset.enabled && !asset.deletedAt);
    return {
      available: live.filter(asset => asset.allowWechat === true && stickerSceneTags[scene].some(tag => `${asset.title} ${asset.tags.join(' ')}`.toLocaleLowerCase().includes(tag.toLocaleLowerCase()))).length,
      generatedToday: state.assets.filter(asset => asset.tags.includes(AUTO_STICKER_TAG) && new Date(asset.createdAt).toDateString() === today).length,
    };
  }

  /** Draws one chat sticker for a scene. Only the scene and the character reach the
   * image service, never conversation text. The result joins the library for WeChat. */
  generateSticker(input: { providerId: string; model: string; scene: QqStickerScene }, credentials: MediaGenerationCredentials, signal?: AbortSignal): Promise<MediaAsset> {
    const tag = stickerSceneTags[input.scene][0]!;
    return this.#drawCharacter(input, `She is ${stickerSceneActions[input.scene]}. ${STICKER_STYLE}`,
      { title: `表情 ${tag}`, tags: [tag, AUTO_STICKER_TAG], name: '自动表情' }, credentials, signal);
  }

  /** A picture for a Moments post: the character in the described scene. */
  generateIllustration(input: { providerId: string; model: string; idea: string }, credentials: MediaGenerationCredentials, signal?: AbortSignal): Promise<MediaAsset> {
    const idea = input.idea.replace(/[\p{C}]/gu, ' ').trim().slice(0, 300);
    if (!idea) throw new Error('media.invalidPrompt');
    return this.#drawCharacter(input, `Scene: ${idea}. ${ILLUSTRATION_STYLE}`,
      { title: `朋友圈 ${idea}`.slice(0, 60), tags: [MOMENTS_TAG], name: '朋友圈配图' }, credentials, signal);
  }

  async #drawCharacter(input: { providerId: string; model: string }, scene: string, label: { title: string; tags: string[]; name: string },
    credentials: MediaGenerationCredentials, signal?: AbortSignal): Promise<MediaAsset> {
    this.#assertImageProvider(input, credentials);
    const reference = this.#state().assets.find(asset => !asset.deletedAt && asset.tags.includes(CHARACTER_REFERENCE_TAG) && (asset.mime === 'image/png' || asset.mime === 'image/jpeg' || asset.mime === 'image/webp'));
    let bytes: Buffer | null = null, prompt = '';
    if (reference) {
      prompt = `Draw the exact character in the reference image: keep her face, hair, ears, eyes, outfit and colors identical, and ignore the reference background. ${scene}`;
      const { bytes: image } = await this.read(reference.id);
      const boundary = `deskpet-${randomUUID()}`;
      const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      const body = Buffer.concat([
        field('model', input.model), field('prompt', prompt), field('n', '1'), field('quality', 'low'), field('size', '1024x1024'), field('output_format', 'png'),
        Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="image[]"; filename="reference.${reference.extension}"\r\ncontent-type: ${reference.mime}\r\n\r\n`),
        image, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      try { bytes = await this.#requestImage('edits', `multipart/form-data; boundary=${boundary}`, body, credentials, signal); }
      catch (error) {
        // A model that cannot take a reference image falls back to the written description.
        if ((error as { status?: number }).status !== 400) throw error;
      }
    }
    if (!bytes) {
      prompt = `Draw ${CHARACTER_DESCRIPTION}. ${scene}`;
      bytes = await this.#requestImage('generations', 'application/json',
        JSON.stringify({ model: input.model, prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png' }), credentials, signal);
    }
    const saved = await this.#save(bytes, label.title, { kind: 'generated', name: label.name, model: input.model, prompt: prompt.slice(0, 4000) }, credentials.assertCurrent);
    const asset = await this.repository.transaction(state => {
      const current = state.mediaLibrary.assets.find(item => item.id === saved.asset.id);
      if (!current || current.deletedAt) throw new Error('media.unavailable');
      if (!saved.reused) {
        current.title = label.title.slice(0, 160);
        current.tags = label.tags;
        if (label.tags.includes(AUTO_STICKER_TAG)) current.allowWechat = true;
        current.updatedAt = new Date(this.#now()).toISOString();
      }
      return structuredClone(current);
    });
    this.#changed(); return asset;
  }
}
