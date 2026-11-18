import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { EncryptedJsonStore, type VaultKeyProvider } from '../persistence/encrypted-json-store';
import { WorkspaceAccess } from '../tools/workspace';
import { DEFAULT_KNOWLEDGE_DIARY_FOLDER } from '../../shared/knowledge';
import type { KnowledgeAnswer, KnowledgeDestination, KnowledgeDiaryCopy, KnowledgeDiarySync, KnowledgeFolder, KnowledgeHit, KnowledgeNoteDraft, KnowledgeNoteSource,
  KnowledgePrivacy, KnowledgeQuestion, KnowledgeSaveResult, KnowledgeSharing, KnowledgeStatus } from '../../shared/knowledge';
import {
  DEFAULT_KNOWLEDGE_EMBEDDING_MODEL,
  KNOWLEDGE_EMBEDDING_MODELS,
  KNOWLEDGE_EMBEDDING_PREFIXES,
  type KnowledgeEmbeddingModel,
  type KnowledgeEmbeddingStatus,
} from '../../shared/knowledge-embedding';
import { KnowledgeIndexScheduler } from './index-scheduler';
import type { KnowledgeEmbeddings } from './ollama-embedding';
import { currentFolderPolicy, DEFAULT_WRITE_FOLDER, folderIdentity, folderPolicySchema, isFolderName, isShareable, noteFolder, pathMissing,
  writableFolderGrant, writablePlacement, type FolderIdentity, type FolderPolicy } from './vault-folders';
import { prepareNoteDraft, publishVaultNote } from './vault-note-write';
import { diaryFileBarrier, diarySettings, diarySyncSchema, isDiaryFolderProtected, publishDiaryCopy, removeDiaryStage,
  revokeDiaryCopy, stageDiaryCopy, type DiarySyncState, type TrackedDiaryCopy } from './vault-diary-sync';

export interface KnowledgeModelInput extends KnowledgeQuestion {
  sources: KnowledgeHit[];
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
interface Deps {
  directory: string;
  vault: VaultKeyProvider;
  embeddings: KnowledgeEmbeddings;
  answerLocal?(input: KnowledgeModelInput): Promise<string>;
}
const rootSchema = z.object({ id: z.string().uuid(), path: z.string(), dev: z.number(), ino: z.number() }).strict();
type Grant = z.infer<typeof rootSchema>;
const embeddingProfileSchema = z.object({
  generation: z.string().uuid(),
  model: z.enum(KNOWLEDGE_EMBEDDING_MODELS),
  documentPrefix: z.string(),
  queryPrefix: z.string(),
  dimension: z.number().int().positive().nullable(),
}).strict();
type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;
const newEmbeddingProfile = (model: KnowledgeEmbeddingModel): EmbeddingProfile => ({
  generation: randomUUID(), model, ...KNOWLEDGE_EMBEDDING_PREFIXES[model], dimension: null,
});
const metaSchema = z
  .object({
    root: rootSchema.nullable(),
    indexedNotes: z.number(),
    indexedChunks: z.number(),
    lastIndexedAt: z.string().nullable(),
    embeddingModel: z.enum(KNOWLEDGE_EMBEDDING_MODELS).optional(),
    embeddingProfile: embeddingProfileSchema.optional(),
    autoIndex: z.boolean().optional(),
    indexFailure: z.object({ consecutive: z.number().int().positive(), at: z.string(), code: z.string().regex(/^knowledge\.[A-Za-z]+$/u) }).strict().optional(),
    folders: folderPolicySchema.optional(),
    diary: diarySyncSchema.optional(),
  })
  .strict();
type Meta = z.infer<typeof metaSchema>;
const emptyMeta = (): Meta => ({ root: null, indexedNotes: 0, indexedChunks: 0, lastIndexedAt: null });
const defaultDiary = (): DiarySyncState => ({ enabled: false, folder: DEFAULT_KNOWLEDGE_DIARY_FOLDER, copies: [] });
const segmentSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  startLine: z.number(),
  endLine: z.number(),
  vector: z.string().base64(),
});
const noteSchema = z.object({ path: z.string(), digest: z.string(), chunks: z.array(segmentSchema) });
type Note = z.infer<typeof noteSchema>;
const shardSchema = z.array(noteSchema);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SHARDS = 64;
const shardId = (path: string) => parseInt(hash(path).slice(0, 2), 16) % SHARDS;
const baseStatus = (): KnowledgeStatus => ({
  vaultName: null,
  indexing: false,
  indexedNotes: 0,
  indexedChunks: 0,
  checkedNotes: 0,
  skippedNotes: 0,
  changedNotes: 0,
  removedNotes: 0,
  lastIndexedAt: null,
  lastError: null,
  embeddingModel: DEFAULT_KNOWLEDGE_EMBEDDING_MODEL,
  embeddingStatus: 'unknown',
  autoIndex: true,
  diarySync: diarySettings(defaultDiary()),
  retainedInvalidDiaries: 0,
  consecutiveIndexFailures: 0,
  lastIndexFailureAt: null,
});
const toBase64 = (values: number[]): string => Buffer.from(Float32Array.from(values).buffer).toString('base64');
function rank(vector: string, query: number[]): number {
  const bytes = Buffer.from(vector, 'base64');
  if (bytes.byteLength !== query.length * 4) return -1;
  let product = 0,
    length = 0,
    queryNorm = 0;
  for (let i = 0; i < query.length; i++) {
    const v = bytes.readFloatLE(i * 4);
    product += v * query[i]!;
    length += v * v;
    queryNorm += query[i]! ** 2;
  }
  return length && queryNorm ? product / Math.sqrt(length * queryNorm) : -1;
}
interface Piece {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
}
function split(text: string): Piece[] {
  const parts: Piece[] = [];
  let line = 1;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1400, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + 500) end = newline + 1;
      if (/[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--;
    }
    const slice = text.slice(start, end);
    const lines = (slice.match(/\n/gu) ?? []).length,
      endLine = line + lines - (slice.endsWith('\n') ? 1 : 0);
    if (slice.trim()) parts.push({ start, end, startLine: line, endLine, text: slice });
    start = end;
    line += lines;
  }
  return parts;
}
const publicError = (error: unknown, fallback = 'knowledge.readFailed'): string => {
  if (error instanceof Error && /^knowledge\.[A-Za-z]+$/u.test(error.message)) return error.message;
  return fallback;
};

export class VaultKnowledgeService {
  readonly #metaStore: EncryptedJsonStore<Meta>;
  #meta: Meta = emptyMeta();
  #status = baseStatus();
  #lease = new AbortController();
  #authority = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #searches = new Set<AbortController>();
  #policyEpoch = 0;
  #folderMutations = 0;
  #folderStorageUncertain = false;
  #loaded = false;
  readonly #scheduler = new KnowledgeIndexScheduler(this);
  #embeddingCheck: { model: KnowledgeEmbeddingModel; expires: number; pending: Promise<KnowledgeEmbeddingStatus> } | undefined;
  #fullIndex: { signal: AbortSignal; pending: Promise<KnowledgeStatus> } | undefined;
  constructor(private readonly deps: Deps) {
    this.#metaStore = new EncryptedJsonStore({
      path: join(deps.directory, 'vault.enc.json'),
      vault: deps.vault,
      schema: metaSchema,
      defaultValue: emptyMeta,
    });
  }
  async initialize(): Promise<void> {
    try {
      const persisted = await this.#metaStore.load();
      // A pre-policy vault selection has not granted the new automatic index
      // or chat tool access. Wait for an explicit picker selection, leaving the
      // old folder and its encrypted index alone.
      this.#meta = persisted.root && persisted.folders?.grantId !== persisted.root.id
        ? { ...emptyMeta(), embeddingModel: persisted.embeddingModel, autoIndex: persisted.autoIndex }
        : persisted;
      this.#loaded = true;
      this.#sync();
    } catch {
      this.#status.lastError = 'knowledge.storageUnavailable';
    }
  }
  #sync(): void {
    const embeddingModel = this.#meta.embeddingModel ?? DEFAULT_KNOWLEDGE_EMBEDDING_MODEL;
    if (this.#status.embeddingModel !== embeddingModel) this.#status.embeddingStatus = 'unknown';
    Object.assign(this.#status, {
      embeddingModel,
      autoIndex: this.#meta.autoIndex ?? true,
      diarySync: diarySettings(this.#meta.diary ?? defaultDiary()),
      retainedInvalidDiaries: this.#meta.diary?.copies.filter(copy => copy.retainedInvalid).length ?? 0,
      consecutiveIndexFailures: this.#meta.indexFailure?.consecutive ?? 0,
      lastIndexFailureAt: this.#meta.indexFailure?.at ?? null,
      lastError: this.#meta.indexFailure?.code ?? null,
      vaultName: this.#meta.root ? basename(this.#meta.root.path) : null,
      indexedNotes: this.#meta.indexedNotes,
      indexedChunks: this.#meta.indexedChunks,
      lastIndexedAt: this.#meta.lastIndexedAt,
    });
  }
  status(): KnowledgeStatus {
    return { ...this.#status, diarySync: { ...this.#status.diarySync } };
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.#queue.then(fn, fn);
    this.#queue = job.catch(() => undefined);
    return job;
  }
  #invalidate(): number {
    this.#policyEpoch++;
    this.#lease.abort();
    this.#lease = new AbortController();
    for (const s of this.#searches) s.abort();
    return ++this.#authority;
  }
  startAutoIndex(): void {
    this.#scheduler.start();
  }
  async checkEmbeddingModel(): Promise<KnowledgeStatus> {
    const probe = this.deps.embeddings.status?.bind(this.deps.embeddings);
    if (!probe || !this.#meta.root) return this.status();
    const model = this.#status.embeddingModel;
    let check = this.#embeddingCheck;
    if (check?.model !== model || check.expires <= Date.now()) {
      check = {
        model,
        expires: Date.now() + 30_000,
        pending: probe(model, this.#lease.signal).catch(() => 'unavailable' as const),
      };
      this.#embeddingCheck = check;
    }
    const status = await check.pending;
    if (this.#embeddingCheck === check && this.#meta.root && this.#status.embeddingModel === model)
      this.#status.embeddingStatus = status;
    return this.status();
  }
  async setEmbeddingModel(model: KnowledgeEmbeddingModel): Promise<KnowledgeStatus> {
    if (!KNOWLEDGE_EMBEDDING_MODELS.includes(model)) throw new Error('knowledge.invalidEmbeddingModel');
    const changed = await this.#serial(async () => {
      this.#assertMetadataWritable();
      if (!this.#loaded) throw new Error('knowledge.storageUnavailable');
      if (model === this.#status.embeddingModel) return false;
      for (const search of this.#searches) search.abort();
      const meta = { ...this.#meta, embeddingModel: model, indexFailure: undefined };
      await this.#metaStore.save(meta);
      this.#meta = meta;
      this.#sync();
      return true;
    });
    if (changed) this.#scheduler.refresh();
    return this.status();
  }
  async setAutoIndex(enabled: boolean): Promise<KnowledgeStatus> {
    const changed = await this.#serial(async () => {
      this.#assertMetadataWritable();
      if (!this.#loaded) throw new Error('knowledge.storageUnavailable');
      if (enabled === this.#status.autoIndex) return false;
      const meta = { ...this.#meta, autoIndex: enabled };
      await this.#metaStore.save(meta);
      this.#meta = meta;
      this.#sync();
      return true;
    });
    if (changed && enabled) this.#scheduler.refresh();
    return this.status();
  }
  dispose(): void {
    this.#scheduler.dispose();
    this.#invalidate();
    this.#loaded = false;
  }
  async #ensure(grant: Grant, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.#loaded || this.#meta.root?.id !== grant.id) throw new Error('knowledge.grantExpired');
    const st = await lstat(grant.path).catch(() => null);
    if (
      !st?.isDirectory() ||
      st.isSymbolicLink() ||
      st.dev !== grant.dev ||
      st.ino !== grant.ino ||
      (await realpath(grant.path).catch(() => null)) !== grant.path
    )
      throw new Error('knowledge.rootChanged');
    signal.throwIfAborted();
  }
  policyRevision(): number {
    return this.#policyEpoch;
  }
  /** Host-only fence for provider delivery and saved tool results, including after restart. */
  policyToken(): string | null {
    const grant = this.#meta.root;
    if (!grant || !this.#loaded || this.#folderMutations || this.#folderStorageUncertain) return null;
    const root = folderIdentity(grant.path, null);
    if (root?.dev !== grant.dev || root.ino !== grant.ino) return null;
    const policy = currentFolderPolicy(this.#meta.folders, grant.id);
    const available = policy.shareable.map(({ name }) => this.#isFolderShareable(policy, grant, name));
    return hash(JSON.stringify([grant.id, policy.revision, available]));
  }
  #assertFolderEpoch(epoch: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#folderMutations || this.#folderStorageUncertain || this.#policyEpoch !== epoch) {
      throw new Error('knowledge.policyChanged');
    }
  }
  #assertMetadataWritable(): void {
    if (this.#folderStorageUncertain) throw new Error('knowledge.storageUnavailable');
  }
  async #mutateFolders<T>(operation: () => Promise<T>): Promise<T> {
    this.#policyEpoch++;
    this.#folderMutations++;
    try {
      return await this.#serial(operation);
    } finally {
      this.#folderMutations--;
    }
  }
  #isDiaryProtected(grant: Grant, name: string | null): boolean {
    return name !== null && isDiaryFolderProtected(this.#meta.diary, grant.path, name);
  }
  #isFolderShareable(policy: FolderPolicy, grant: Grant, name: string | null): boolean {
    return !this.#isDiaryProtected(grant, name) && isShareable(policy, grant.path, name);
  }
  async #listFolders(grant: Grant, signal: AbortSignal): Promise<KnowledgeFolder[]> {
    await this.#ensure(grant, signal);
    const access = new WorkspaceAccess(grant.path, grant);
    const { entries } = await access.list('.', Number.MAX_SAFE_INTEGER, signal).catch((error: unknown) => {
      throw new Error(signal.aborted ? 'knowledge.cancelled' : publicError(error));
    });
    const names = entries.filter(entry => entry.type === 'directory' && isFolderName(entry.name)).map(entry => entry.name);
    if (!names.includes(DEFAULT_WRITE_FOLDER) && pathMissing(join(grant.path, DEFAULT_WRITE_FOLDER))) names.push(DEFAULT_WRITE_FOLDER);
    const diary = this.#meta.diary;
    if (diary?.enabled && !names.includes(diary.folder) && pathMissing(join(grant.path, diary.folder))) names.push(diary.folder);
    const policy = currentFolderPolicy(this.#meta.folders, grant.id);
    return [null, ...names].map(name => {
      const diaryProtected = this.#isDiaryProtected(grant, name);
      return {
        name, diaryProtected,
        sharing: !diaryProtected && !this.#folderStorageUncertain && isShareable(policy, grant.path, name) ? 'shareable' : 'local',
        writable: name !== null && !diaryProtected && !this.#folderStorageUncertain && writablePlacement(policy, grant.path, name) !== undefined,
      };
    });
  }
  async folders(): Promise<KnowledgeFolder[]> {
    const grant = this.#meta.root;
    return grant ? this.#listFolders(grant, this.#lease.signal) : [];
  }
  async #saveFolderPolicy(policy: FolderPolicy, grant: Grant, signal: AbortSignal): Promise<void> {
    await this.#ensure(grant, signal);
    const meta = { ...this.#meta, folders: { ...policy, revision: policy.revision + 1 } };
    try {
      await this.#metaStore.save(meta);
    } catch {
      this.#folderStorageUncertain = true;
      throw new Error('knowledge.storageUnavailable');
    }
    this.#meta = meta;
    this.#folderStorageUncertain = false;
    signal.throwIfAborted();
  }
  async #editableFolderPolicy(grant: Grant, signal: AbortSignal): Promise<FolderPolicy> {
    await this.#ensure(grant, signal);
    if (this.#folderStorageUncertain) {
      const persisted = await this.#metaStore.readPersisted().catch(() => null);
      signal.throwIfAborted();
      if (persisted?.root?.id !== grant.id) throw new Error('knowledge.storageUnavailable');
      this.#meta = persisted;
      this.#sync();
    }
    return currentFolderPolicy(this.#meta.folders, grant.id);
  }
  async setFolderSharing(folder: string | null, level: KnowledgeSharing): Promise<KnowledgeFolder[]> {
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    if (folder !== null && !isFolderName(folder)) throw new Error('knowledge.invalidPath');
    const signal = this.#lease.signal;
    return this.#mutateFolders(async () => {
      const policy = await this.#editableFolderPolicy(grant, signal);
      const shareable = policy.shareable.filter(entry => entry.name !== folder);
      if (level === 'shareable') {
        if (this.#isDiaryProtected(grant, folder)) throw new Error('knowledge.diaryFolderProtected');
        const identity = folderIdentity(grant.path, folder);
        if (!identity) throw new Error('knowledge.invalidPath');
        shareable.push({ name: folder, ...identity });
      }
      await this.#saveFolderPolicy({ ...policy, shareable }, grant, signal);
      return this.#listFolders(grant, signal);
    });
  }
  async setWritableFolders(folders: string[]): Promise<KnowledgeFolder[]> {
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    const signal = this.#lease.signal;
    return this.#mutateFolders(async () => {
      const policy = await this.#editableFolderPolicy(grant, signal);
      const writable = Array.from(new Set(folders), name => {
        if (!isFolderName(name)) throw new Error('knowledge.invalidPath');
        if (this.#isDiaryProtected(grant, name)) throw new Error('knowledge.diaryFolderProtected');
        const identity = writableFolderGrant(grant.path, name);
        if (!identity) throw new Error('knowledge.invalidPath');
        return identity;
      });
      await this.#saveFolderPolicy({ ...policy, writable }, grant, signal);
      return this.#listFolders(grant, signal);
    });
  }
  async setDiarySync(input: KnowledgeDiarySync): Promise<KnowledgeStatus> {
    if (!isFolderName(input.folder)) throw new Error('knowledge.diaryFolderInvalid');
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    const signal = this.#lease.signal;
    return this.#mutateFolders(async () => {
      const policy = await this.#editableFolderPolicy(grant, signal);
      const previous = this.#meta.diary ?? defaultDiary();
      const target = input.enabled ? folderIdentity(grant.path, input.folder) : undefined;
      const diary: DiarySyncState = { ...input, target, copies: previous.copies };
      if (input.enabled) {
        if (!target && !pathMissing(join(grant.path, input.folder))) throw new Error('knowledge.diaryFolderInvalid');
        if (policy.shareable.some(({ name }) => name !== null && isDiaryFolderProtected(diary, grant.path, name))) {
          throw new Error('knowledge.diaryFolderShareable');
        }
      }
      const folders = { ...policy, revision: policy.revision + 1 };
      await this.#saveDiaryState(grant, signal, diary, folders);
      return this.status();
    });
  }
  async #saveDiaryState(grant: Grant, signal: AbortSignal, diary: DiarySyncState, folders = this.#meta.folders): Promise<void> {
    await this.#ensure(grant, signal);
    const meta = { ...this.#meta, diary, folders };
    try { await this.#metaStore.save(meta); }
    catch {
      this.#folderStorageUncertain = true;
      throw new Error('knowledge.storageUnavailable');
    }
    this.#meta = meta;
    this.#folderStorageUncertain = false;
    this.#sync();
    signal.throwIfAborted();
  }
  /** Reconcile through the grant's authority queue. The callback returns null
   * while journal provenance cannot be authenticated, so nothing is removed. */
  async syncDiaryCopies(current: () => readonly KnowledgeDiaryCopy[] | null): Promise<KnowledgeStatus> {
    const grant = this.#meta.root;
    if (!grant) return this.status();
    const signal = this.#lease.signal;
    const added: string[] = [];
    let removed = false;
    try {
      await this.#serial(async () => {
        let diary = this.#meta.diary;
        if (!diary || (!diary.enabled && !diary.copies.length)) return;
        let epoch = this.#policyEpoch;
        const assert = () => this.#assertFolderEpoch(epoch, signal);
        await this.#ensure(grant, signal);
        assert();
        const entries = current();
        if (!entries) return;
        const eligible = new Map(entries.map(entry => [entry.date, entry]));
        const reconciled: TrackedDiaryCopy[] = [];
        for (const copy of diary.copies) {
          if (copy.removed) {
            reconciled.push(copy);
            continue;
          }
          const entry = eligible.get(copy.date);
          let next = copy;
          if (copy.temporary) {
            if (entry && diary.enabled && copy.path === `${diary.folder}/${entry.date}.md` && diary.target
              && copy.parent.dev === diary.target.dev && copy.parent.ino === diary.target.ino && publishDiaryCopy(grant, copy, entry, assert)) {
              added.push(copy.path);
            }
            if (removeDiaryStage(grant, copy, assert)) next = { ...next, temporary: undefined };
          }
          const result = entry ? null : revokeDiaryCopy(grant, next, assert);
          if (result === 'removed') {
            // Keep the digest fence for a second exact copy the owner may
            // have moved under an already shared folder.
            reconciled.push({ ...next, removed: true, retainedInvalid: false, temporary: undefined });
            removed = true;
            continue;
          }
          const retainedInvalid = result === 'changed';
          reconciled.push(next.retainedInvalid === retainedInvalid ? next : { ...next, retainedInvalid });
        }
        if (reconciled.length !== diary.copies.length || reconciled.some((copy, index) => copy !== diary!.copies[index])) {
          diary = { ...diary, copies: reconciled };
          await this.#saveDiaryState(grant, signal, diary);
        }
        if (!diary.enabled || !eligible.size) return;
        assert();
        diary = await this.#ensureDiaryPlacement(grant, signal, diary);
        const known = new Set(reconciled.filter(copy => !copy.removed).map(copy => copy.path));
        const staged: TrackedDiaryCopy[] = [];
        let receiptAttempted = false;
        try {
          for (const entry of eligible.values()) {
            if (known.has(`${diary.folder}/${entry.date}.md`)) continue;
            const copy = await stageDiaryCopy(grant, diary, entry, assert);
            if (copy) staged.push(copy);
          }
          if (!staged.length) return;
          // A crash after the filesystem link leaves a durable identity
          // receipt. Startup can safely settle that publication.
          receiptAttempted = true;
          await this.#saveDiaryState(grant, signal, { ...diary, copies: [...reconciled, ...staged] });
          assert();
          // The new digests and inodes now also restrict files outside the
          // target folder. Invalidate earlier search views before publishing.
          epoch = ++this.#policyEpoch;
          const fresh = current();
          if (!fresh) return;
          const latest = new Map(fresh.map(entry => [entry.date, entry]));
          for (const copy of staged) {
            const entry = latest.get(copy.date);
            const published = entry ? publishDiaryCopy(grant, copy, entry, assert) : false;
            if (published) added.push(copy.path);
            const cleaned = removeDiaryStage(grant, copy, assert);
            if (published || !cleaned) reconciled.push(cleaned ? { ...copy, temporary: undefined } : copy);
          }
          await this.#saveDiaryState(grant, signal, { ...diary, copies: reconciled });
        } finally {
          if (!receiptAttempted) {
            for (const copy of staged) {
              try { removeDiaryStage(grant, copy, assert); } catch { /* Keep unresolved stages private. */ }
            }
          }
        }
      });
    } catch (error) {
      if (!signal.aborted) throw new Error(publicError(error, 'knowledge.diarySyncFailed'));
    } finally {
      if (!signal.aborted && (removed || added.length > 1)) void this.reindex().catch(() => undefined);
      else if (!signal.aborted && added.length === 1) void this.indexNote(added[0]!, grant.id).catch(() => undefined);
    }
    return this.status();
  }
  async #ensureDiaryPlacement(grant: Grant, signal: AbortSignal, diary: DiarySyncState): Promise<DiarySyncState> {
    const before = folderIdentity(grant.path, null);
    if (before?.dev !== grant.dev || before.ino !== grant.ino) throw new Error('knowledge.rootChanged');
    let target = folderIdentity(grant.path, diary.folder);
    if (diary.target) {
      if (!target || target.dev !== diary.target.dev || target.ino !== diary.target.ino) throw new Error('knowledge.diaryFolderInvalid');
      return diary;
    }
    const path = join(grant.path, diary.folder);
    if (!target && pathMissing(path)) {
      mkdirSync(path, { mode: 0o700 });
      target = folderIdentity(grant.path, diary.folder);
    }
    if (!target) throw new Error('knowledge.diaryFolderInvalid');
    const pinned = { ...diary, target };
    await this.#saveDiaryState(grant, signal, pinned);
    return pinned;
  }
  /** Host-only path. The renderer receives only the explicit export flag. */
  async inboxExportGrant(): Promise<(Grant & { epoch: number }) | null> {
    const grant = this.#meta.root;
    const epoch = this.#authority;
    if (!grant || !this.#loaded) return null;
    await this.#ensure(grant, this.#lease.signal);
    return { ...grant, epoch };
  }
  isInboxExportGrantCurrent(id: string, epoch: number): boolean {
    return this.#loaded && this.#authority === epoch && this.#meta.root?.id === id;
  }
  async #setRoot(root: Grant | null, epoch: number): Promise<KnowledgeStatus> {
    if (!this.#loaded || epoch !== this.#authority) throw new Error('knowledge.grantExpired');
    const old = this.#meta.root;
    const defaultWrite = root ? writableFolderGrant(root.path, DEFAULT_WRITE_FOLDER) : undefined;
    const meta = { ...emptyMeta(), root, embeddingModel: this.#meta.embeddingModel, autoIndex: this.#meta.autoIndex,
      ...(root ? { folders: { ...currentFolderPolicy(undefined, root.id), writable: defaultWrite ? [defaultWrite] : [] } } : {}) };
    try {
      await this.#metaStore.save(meta);
    } catch {
      this.#folderStorageUncertain = true;
      throw new Error('knowledge.storageUnavailable');
    }
    this.#meta = meta;
    this.#folderStorageUncertain = false;
    this.#status = baseStatus();
    this.#embeddingCheck = undefined;
    this.#sync();
    if (old && old.id !== root?.id) {
      await rm(join(this.deps.directory, old.id), { recursive: true, force: true }).catch(() => {
        throw new Error('knowledge.storageUnavailable');
      });
    }
    return this.status();
  }
  async selectRoot(path: string): Promise<KnowledgeStatus> {
    const epoch = this.#invalidate();
    const status = await this.#mutateFolders(async () => {
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('knowledge.invalidRoot');
      const canonical = await realpath(path).catch(() => null);
      if (!canonical) throw new Error('knowledge.rootChanged');
      // Refuse a replaced picker entry between lstat and realpath.
      const st = await lstat(canonical).catch(() => null);
      if (!st?.isDirectory() || st.dev !== info.dev || st.ino !== info.ino) throw new Error('knowledge.rootChanged');
      if (epoch !== this.#authority) throw new Error('knowledge.grantExpired');
      const prior = this.#meta.root;
      if (!this.#folderStorageUncertain && prior?.path === canonical && prior.dev === st.dev && prior.ino === st.ino) return this.status();
      return this.#setRoot({ id: randomUUID(), path: canonical, dev: st.dev, ino: st.ino }, epoch);
    });
    this.#scheduler.refresh();
    return status;
  }
  async detach(): Promise<KnowledgeStatus> {
    const epoch = this.#invalidate();
    return this.#mutateFolders(() => this.#setRoot(null, epoch));
  }
  #shard(root: Grant, profile: EmbeddingProfile, id: number): EncryptedJsonStore<Note[]> {
    return new EncryptedJsonStore({
      path: join(this.deps.directory, root.id, profile.generation, id + '.enc.json'),
      vault: this.deps.vault,
      schema: shardSchema,
      defaultValue: () => [],
    });
  }
  async #paths(access: WorkspaceAccess, signal: AbortSignal, assert: () => void): Promise<string[][]> {
    const directories = ['.'],
      groups = Array.from({ length: SHARDS }, () => [] as string[]);
    while (directories.length) {
      const dir = directories.pop()!;
      const entries = await access.list(dir, Number.MAX_SAFE_INTEGER, signal, assert);
      for (const e of entries.entries) {
        if (e.name.startsWith('.') || e.name.includes('\\') || e.type === 'symlink') continue;
        if (e.type === 'directory') directories.push(e.path);
        else if (e.type === 'file' && e.name.toLowerCase().endsWith('.md')) groups[shardId(e.path)]!.push(e.path);
      }
    }
    return groups;
  }
  #configuredProfile(): EmbeddingProfile | undefined {
    const profile = this.#meta.embeddingProfile;
    const model = this.#status.embeddingModel;
    const prefixes = KNOWLEDGE_EMBEDDING_PREFIXES[model];
    return profile?.model === model && profile.queryPrefix === prefixes.queryPrefix &&
      profile.documentPrefix === prefixes.documentPrefix ? profile : undefined;
  }
  async #embed(inputs: string[], model: KnowledgeEmbeddingModel, signal: AbortSignal): Promise<number[][]> {
    try {
      const vectors = await this.deps.embeddings.embed(inputs, signal, model);
      const dimension = vectors[0]?.length;
      if (!dimension || vectors.length !== inputs.length ||
        vectors.some(vector => vector.length !== dimension || vector.some(value => !Number.isFinite(value))))
        throw new Error('knowledge.invalidEmbeddingResponse');
      signal.throwIfAborted();
      this.#updateEmbeddingStatus(model, 'installed');
      return vectors;
    } catch (error) {
      if (!signal.aborted && publicError(error) === 'knowledge.embeddingModelMissing')
        this.#updateEmbeddingStatus(model, 'missing');
      throw error;
    }
  }
  #updateEmbeddingStatus(model: KnowledgeEmbeddingModel, status: KnowledgeEmbeddingStatus): void {
    if (this.#status.embeddingModel !== model) return;
    this.#status.embeddingStatus = status;
    this.#embeddingCheck = { model, expires: Date.now() + 30_000, pending: Promise.resolve(status) };
  }
  async #indexShard(grant: Grant, profile: EmbeddingProfile, id: number, paths: string[], access: WorkspaceAccess,
    signal: AbortSignal, preserveOtherNotes: boolean): Promise<{ indexedNotes: number; indexedChunks: number; addedNotes: number; addedChunks: number }> {
    const disk = this.#shard(grant, profile, id);
    const existing = await disk.load();
    const previous = new Map(existing.map(note => [note.path, note]));
    const next: Note[] = [];
    const batch: Array<{ note: Note; piece: Piece }> = [];
    let changed = false;
    const assert = () => signal.throwIfAborted();
    const flush = async () => {
      if (!batch.length) return;
      await this.#ensure(grant, signal);
      const vectors = await this.#embed(batch.map(({ piece }) => profile.documentPrefix + piece.text), profile.model, signal);
      assert();
      const dimension = vectors[0]!.length;
      if (profile.dimension !== null && dimension !== profile.dimension)
        throw new Error('knowledge.embeddingDimensionChanged');
      profile.dimension = dimension;
      for (let n = 0; n < batch.length; n++) {
        const { note, piece: { start, end, startLine, endLine } } = batch[n]!;
        note.chunks.push({ start, end, startLine, endLine, vector: toBase64(vectors[n]!) });
      }
      batch.length = 0;
    };
    for (const path of paths) {
      assert();
      const old = previous.get(path);
      previous.delete(path);
      let text: string;
      try {
        text = await access.read(path, signal, assert);
      } catch (error) {
        assert();
        if (preserveOtherNotes) throw error;
        changed ||= !!old;
        this.#status.skippedNotes++;
        continue;
      }
      this.#status.checkedNotes++;
      if (text.includes('\0')) {
        if (preserveOtherNotes) throw new Error('knowledge.invalidNote');
        changed ||= !!old;
        this.#status.skippedNotes++;
        continue;
      }
      const digest = hash(text);
      if (old?.digest === digest) {
        next.push(old);
        continue;
      }
      const note: Note = { path, digest, chunks: [] };
      for (const piece of split(text)) {
        batch.push({ note, piece });
        if (batch.length === 16) await flush();
      }
      next.push(note);
      changed = true;
      this.#status.changedNotes++;
    }
    await flush();
    assert();
    if (preserveOtherNotes) {
      next.push(...previous.values());
    } else {
      this.#status.removedNotes += previous.size;
    }
    if (changed || (!preserveOtherNotes && previous.size)) {
      await this.#ensure(grant, signal);
      await disk.save(next);
    }
    const indexedChunks = next.reduce((sum, note) => sum + note.chunks.length, 0);
    return {
      indexedNotes: next.length,
      indexedChunks,
      addedNotes: next.length - existing.length,
      addedChunks: indexedChunks - existing.reduce((sum, note) => sum + note.chunks.length, 0),
    };
  }
  async #publishIndex(grant: Grant, signal: AbortSignal, profile: EmbeddingProfile, indexedNotes: number,
    indexedChunks: number): Promise<void> {
    await this.#ensure(grant, signal);
    const old = this.#meta.embeddingProfile;
    const meta = { ...this.#meta, indexedNotes, indexedChunks, lastIndexedAt: new Date().toISOString(),
      embeddingProfile: profile, indexFailure: undefined };
    await this.#metaStore.save(meta);
    this.#meta = meta;
    this.#sync();
    if (old?.generation !== profile.generation) {
      const indexRoot = join(this.deps.directory, grant.id);
      // Remove obsolete and abandoned staging generations only after the new
      // encrypted metadata has selected a complete, compatible generation.
      const entries = await readdir(indexRoot).catch(() => [] as string[]);
      for (const entry of entries) {
        if (entry !== profile.generation && (z.uuid().safeParse(entry).success || /^\d{1,2}\.enc\.json$/u.test(entry))) {
          await rm(join(indexRoot, entry), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  }
  async #runIndex(grant: Grant, signal: AbortSignal, operation: () => Promise<void>): Promise<KnowledgeStatus> {
    this.#assertMetadataWritable();
    this.#status.indexing = true;
    Object.assign(this.#status, { checkedNotes: 0, changedNotes: 0, removedNotes: 0, skippedNotes: 0 });
    try {
      await this.#ensure(grant, signal);
      await operation();
    } catch (error) {
      if (!signal.aborted) {
        const code = publicError(error);
        const indexFailure = { consecutive: (this.#meta.indexFailure?.consecutive ?? 0) + 1,
          at: new Date().toISOString(), code };
        this.#meta = { ...this.#meta, indexFailure };
        this.#sync();
        await this.#metaStore.save(this.#meta).catch(() => undefined);
      }
    } finally {
      this.#status.indexing = false;
    }
    return this.status();
  }
  async #scanIndex(grant: Grant, signal: AbortSignal, profile: EmbeddingProfile): Promise<void> {
    const access = new WorkspaceAccess(grant.path, grant);
    const groups = await this.#paths(access, signal, () => signal.throwIfAborted());
    let indexedNotes = 0;
    let indexedChunks = 0;
    for (let id = 0; id < SHARDS; id++) {
      const counts = await this.#indexShard(grant, profile, id, groups[id]!, access, signal, false);
      indexedNotes += counts.indexedNotes;
      indexedChunks += counts.indexedChunks;
    }
    await this.#publishIndex(grant, signal, profile, indexedNotes, indexedChunks);
  }
  async reindex(force = false): Promise<KnowledgeStatus> {
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    const signal = this.#lease.signal;
    if (this.#fullIndex?.signal === signal) {
      if (!force) return this.#fullIndex.pending;
      await this.#fullIndex.pending;
      signal.throwIfAborted();
    }
    const pending = this.#serial(() => this.#runIndex(grant, signal, async () => {
      const current = this.#configuredProfile();
      if (!current || force) {
        await this.#scanIndex(grant, signal, newEmbeddingProfile(this.#status.embeddingModel));
        return;
      }
      try {
        await this.#scanIndex(grant, signal, { ...current });
      } catch (error) {
        if (publicError(error) !== 'knowledge.embeddingDimensionChanged') throw error;
        Object.assign(this.#status, { checkedNotes: 0, changedNotes: 0, removedNotes: 0, skippedNotes: 0 });
        await this.#scanIndex(grant, signal, newEmbeddingProfile(current.model));
      }
    }));
    const job = { signal, pending };
    this.#fullIndex = job;
    try {
      return await pending;
    } finally {
      if (this.#fullIndex === job) this.#fullIndex = undefined;
    }
  }
  async indexNote(path: string, expectedGrantId?: string): Promise<KnowledgeStatus> {
    const grant = this.#meta.root;
    if (!grant || (expectedGrantId !== undefined && grant.id !== expectedGrantId)) throw new Error('knowledge.grantExpired');
    const signal = this.#lease.signal;
    let needsFullIndex = false;
    const status = await this.#serial(() => this.#runIndex(grant, signal, async () => {
      const access = new WorkspaceAccess(grant.path, grant);
      const id = shardId(path);
      const update = async (current?: EmbeddingProfile) => {
        const profile = current ? { ...current } : newEmbeddingProfile(this.#status.embeddingModel);
        const counts = await this.#indexShard(grant, profile, id, [path], access, signal, true);
        await this.#publishIndex(grant, signal, profile,
          current ? this.#meta.indexedNotes + counts.addedNotes : counts.indexedNotes,
          current ? this.#meta.indexedChunks + counts.addedChunks : counts.indexedChunks);
        needsFullIndex = !current;
      };
      try {
        await update(this.#configuredProfile());
      } catch (error) {
        if (publicError(error) !== 'knowledge.embeddingDimensionChanged') throw error;
        Object.assign(this.#status, { checkedNotes: 0, changedNotes: 0 });
        await update();
      }
    }));
    if (needsFullIndex) this.#scheduler.refresh();
    return status;
  }
  async #searchEmbedding(query: string, signal: AbortSignal): Promise<{ profile: EmbeddingProfile; vector: number[] } | null> {
    const model = this.#status.embeddingModel;
    let profile = this.#configuredProfile();
    if (!profile) {
      const status = await this.reindex();
      signal.throwIfAborted();
      if (status.lastError) throw new Error(status.lastError);
      profile = this.#configuredProfile();
    }
    if (!profile?.dimension) return null;
    const [vector] = await this.#embed([profile.queryPrefix + query], model, signal);
    if (vector!.length !== profile.dimension) {
      const status = await this.reindex(true);
      signal.throwIfAborted();
      if (status.lastError) throw new Error(status.lastError);
      const rebuilt = this.#configuredProfile();
      if (!rebuilt?.dimension) return null;
      if (rebuilt.dimension !== vector!.length) throw new Error('knowledge.embeddingDimensionChanged');
      profile = rebuilt;
    }
    return { profile, vector: vector! };
  }
  async search(query: string, external?: AbortSignal): Promise<KnowledgeHit[]> {
    return (await this.searchForTool(query, 'local', external)).hits;
  }
  async searchForTool(query: string, destination: KnowledgeDestination, external?: AbortSignal): Promise<{ hits: KnowledgeHit[]; privacy: KnowledgePrivacy }> {
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    const q = query.trim();
    if (!q || q.length > 1400) throw new Error('knowledge.invalidQuery');
    if (this.#searches.size) throw new Error('knowledge.searchBusy');
    const controller = new AbortController();
    this.#searches.add(controller);
    const signal = AbortSignal.any([this.#lease.signal, controller.signal, ...(external ? [external] : [])]);
    const epoch = this.#policyEpoch;
    const assertPolicy = () => this.#assertFolderEpoch(epoch, signal);
    try {
      assertPolicy();
      await this.#ensure(grant, signal);
      const policy = currentFolderPolicy(this.#meta.folders, grant.id);
      const sharedFolders = new Set(policy.shareable.filter(({ name }) => this.#isFolderShareable(policy, grant, name)).map(({ name }) => name));
      const protectedCopy = diaryFileBarrier(this.#meta.diary, grant.path);
      const embedding = await this.#searchEmbedding(q, signal);
      assertPolicy();
      if (!embedding) return { hits: [], privacy: 'cloud-allowed' };
      const { profile, vector } = embedding;
      const assertProfile = () => {
        if (this.#configuredProfile()?.generation !== profile.generation) throw new Error('knowledge.cancelled');
      };
      const top: Array<{
        path: string;
        folder: string | null;
        digest: string;
        start: number;
        end: number;
        startLine: number;
        endLine: number;
        score: number;
      }> = [];
      for (let i = 0; i < SHARDS; i++) {
        assertPolicy();
        assertProfile();
        const notes = await this.#shard(grant, profile, i).load();
        for (const note of notes) {
          let folder: string | null;
          try { folder = noteFolder(note.path); }
          catch { continue; }
          if (destination !== 'local' && (!sharedFolders.has(folder) || protectedCopy(note.path, note.digest))) continue;
          for (const chunk of note.chunks) {
            const score = rank(chunk.vector, vector);
            if (Number.isFinite(score) && score > 0 && (top.length < 32 || score > top[top.length - 1]!.score)) {
              top.push({
                path: note.path,
                folder,
                digest: note.digest,
                start: chunk.start,
                end: chunk.end,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                score,
              });
              top.sort((a, b) => b.score - a.score);
              if (top.length > 32) top.pop();
            }
          }
        }
      }
      const hits: KnowledgeHit[] = [];
      const outputFolders = new Set<string | null>();
      let privacy: KnowledgePrivacy = 'cloud-allowed';
      const access = new WorkspaceAccess(grant.path, grant);
      for (const candidate of top) {
        const assertRead = () => {
          assertPolicy();
          if (sharedFolders.has(candidate.folder) && (!this.#isFolderShareable(policy, grant, candidate.folder)
            || (destination !== 'local' && protectedCopy(candidate.path, candidate.digest)))) {
            throw new Error('knowledge.policyChanged');
          }
        };
        assertRead();
        await this.#ensure(grant, signal);
        let text: string;
        try {
          text = await access.read(candidate.path, signal, assertRead);
        } catch {
          assertRead();
          continue;
        }
        assertRead();
        if (hash(text) !== candidate.digest) continue;
        if (protectedCopy(candidate.path, candidate.digest)) privacy = 'local-only';
        outputFolders.add(candidate.folder);
        hits.push({
          path: candidate.path,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          excerpt: text.slice(candidate.start, candidate.end),
          revision: candidate.digest,
          score: candidate.score,
        });
        if (hits.length === 5) break;
      }
      await this.#ensure(grant, signal);
      assertPolicy();
      for (const folder of outputFolders) {
        if (!sharedFolders.has(folder)) privacy = 'local-only';
        else if (!this.#isFolderShareable(policy, grant, folder)) throw new Error('knowledge.policyChanged');
      }
      assertProfile();
      return { hits, privacy };
    } catch (error) {
      throw new Error(signal.aborted ? 'knowledge.cancelled' : publicError(error));
    } finally {
      this.#searches.delete(controller);
    }
  }
  async readNote(path: string, external?: AbortSignal): Promise<{ path: string; text: string; truncated: boolean; revision: string }> {
    const { path: notePath, text, truncated, revision } = await this.readNoteForTool(path, 'local', external);
    return { path: notePath, text, truncated, revision };
  }
  /** One whole note, for a chat turn that found it by search. */
  async readNoteForTool(path: string, destination: KnowledgeDestination, external?: AbortSignal): Promise<{
    path: string; text: string; truncated: boolean; revision: string; privacy: KnowledgePrivacy;
  }> {
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    const folder = noteFolder(path);
    const signal = external ? AbortSignal.any([this.#lease.signal, external]) : this.#lease.signal;
    const epoch = this.#policyEpoch;
    try {
      this.#assertFolderEpoch(epoch, signal);
      await this.#ensure(grant, signal);
      const policy = currentFolderPolicy(this.#meta.folders, grant.id);
      const protectedCopy = diaryFileBarrier(this.#meta.diary, grant.path);
      const shareable = this.#isFolderShareable(policy, grant, folder) && !protectedCopy(path);
      if (!shareable && destination !== 'local') throw new Error('knowledge.folderPrivate');
      const assertRead = () => {
        this.#assertFolderEpoch(epoch, signal);
        if (shareable && !this.#isFolderShareable(policy, grant, folder)) throw new Error('knowledge.policyChanged');
      };
      const text = await new WorkspaceAccess(grant.path, grant).read(path, signal, assertRead);
      await this.#ensure(grant, signal);
      assertRead();
      if (text.includes('\0')) throw new Error('knowledge.readFailed');
      const revision = hash(text);
      const exportIsPrivate = protectedCopy(path, revision);
      if (exportIsPrivate && destination !== 'local') throw new Error('knowledge.folderPrivate');
      return {
        path, text: text.slice(0, 20_000), truncated: text.length > 20_000, revision,
        privacy: shareable && !exportIsPrivate ? 'cloud-allowed' : 'local-only',
      };
    } catch (error) {
      throw new Error(signal.aborted ? 'knowledge.cancelled' : publicError(error));
    }
  }
  async #resolveNotePlacement(grant: Grant, folder: string, signal: AbortSignal, authorize: () => void): Promise<FolderIdentity> {
    const readPolicy = () => currentFolderPolicy(this.#meta.folders, grant.id);
    const existing = writablePlacement(readPolicy(), grant.path, folder);
    if (existing) return existing;
    // Serialize the first default-folder claim with other metadata writers.
    // Read policy again after waiting in case another save pinned it.
    if (folder !== DEFAULT_WRITE_FOLDER) throw new Error('knowledge.folderNotWritable');
    return this.#serial(async () => {
      authorize();
      await this.#ensure(grant, signal);
      authorize();
      const policy = readPolicy();
      const placement = writablePlacement(policy, grant.path, folder);
      if (placement) return placement;
      if (placement === undefined) throw new Error('knowledge.folderNotWritable');
      const before = folderIdentity(grant.path, null);
      if (before?.dev !== grant.dev || before.ino !== grant.ino) throw new Error('knowledge.rootChanged');
      try { mkdirSync(join(grant.path, folder), { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('knowledge.folderNotWritable');
        throw error;
      }
      const identity = folderIdentity(grant.path, folder);
      const root = folderIdentity(grant.path, null);
      if (!identity || root?.dev !== grant.dev || root.ino !== grant.ino) throw new Error('knowledge.folderNotWritable');
      const pinned = { name: folder, ...identity };
      // Pin before publishing the file. This narrows the already-approved
      // placement and keeps the initiating call's policy revision current.
      const meta = { ...this.#meta, folders: { ...policy, writable: [pinned, ...(policy.writable ?? []).filter(entry => entry.name !== folder)] } };
      try { await this.#metaStore.save(meta); }
      catch {
        this.#folderStorageUncertain = true;
        throw new Error('knowledge.storageUnavailable');
      }
      this.#meta = meta;
      authorize();
      return identity;
    });
  }
  async saveNote(input: KnowledgeNoteDraft, source: KnowledgeNoteSource, destination: KnowledgeDestination,
    external?: AbortSignal, authorize?: () => void): Promise<KnowledgeSaveResult> {
    const grant = this.#meta.root;
    if (!grant) throw new Error('knowledge.noVault');
    const folder = input.folder ?? DEFAULT_WRITE_FOLDER;
    if (!isFolderName(folder)) throw new Error('knowledge.invalidPath');
    const signal = external ? AbortSignal.any([this.#lease.signal, external]) : this.#lease.signal;
    const epoch = this.#policyEpoch;
    const assertCurrent = () => {
      this.#assertFolderEpoch(epoch, signal);
      authorize?.();
    };
    try {
      assertCurrent();
      await this.#ensure(grant, signal);
      if (this.#isDiaryProtected(grant, folder)) throw new Error('knowledge.folderNotWritable');
      const draft = prepareNoteDraft(input, source);
      const placement = await this.#resolveNotePlacement(grant, folder, signal, assertCurrent);
      const policy = currentFolderPolicy(this.#meta.folders, grant.id);
      const shareable = isShareable(policy, grant.path, folder);
      const path = await publishVaultNote(grant, folder, placement, draft, assertCurrent);
      // Publish a save receipt without waiting for the shared model slot. The
      // targeted index update starts now and records its own failure, if any.
      void this.indexNote(path, grant.id).catch(() => undefined);
      await this.#ensure(grant, signal);
      assertCurrent();
      if (shareable && !isShareable(policy, grant.path, folder)) throw new Error('knowledge.policyChanged');
      if (shareable) return { path, privacy: 'cloud-allowed' };
      return destination === 'local' ? { path, privacy: 'local-only' } : { path: null, privacy: 'cloud-allowed' };
    } catch (error) {
      throw new Error(signal.aborted ? 'knowledge.cancelled' : publicError(error, 'knowledge.writeFailed'));
    }
  }
  async ask(input: KnowledgeQuestion): Promise<KnowledgeAnswer> {
    const grant = this.#meta.root,
      signal = this.#lease.signal;
    if (!grant) throw new Error('knowledge.noVault');
    if (!this.deps.answerLocal) throw new Error('knowledge.noLocalModel');
    if (!input.providerId || !input.model.trim()) throw new Error('knowledge.noLocalModel');
    const sources = await this.search(input.query);
    if (!sources.length) throw new Error('knowledge.noMatchingSources');
    const access = new WorkspaceAccess(grant.path, grant);
    const assertCurrent = async () => {
      await this.#ensure(grant, signal);
      for (const hit of sources) {
        let text: string;
        try {
          text = await access.read(hit.path, signal, () => signal.throwIfAborted());
        } catch {
          throw new Error('knowledge.sourceChanged');
        }
        if (hash(text) !== hit.revision) throw new Error('knowledge.sourceChanged');
      }
      await this.#ensure(grant, signal);
    };
    try {
      await assertCurrent();
      const answer = await this.deps.answerLocal({ ...input, sources: structuredClone(sources), signal, assertCurrent });
      await assertCurrent();
      if (!answer.trim()) throw new Error('knowledge.emptyAnswer');
      return { answer, sources };
    } catch (error) {
      throw new Error(signal.aborted ? 'knowledge.cancelled' : publicError(error));
    }
  }
}
