import { defaultNightlyStore } from '../shared/nightly-memory';
import { withAutomationAuthority } from './domain/automation-protection';
import { syncConsolidations } from './domain/consolidation-state';
import { syncDelegations } from './domain/delegation-state';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { z } from 'zod';

import { persistentStateSchema } from './domain/schemas';
import { createDefaultState } from './domain/schemas';
import { quarantineRestoredMemories, reconcileMemoryProtection } from './domain/memory-commit';
import { settingsSchema } from './app-settings';
import { parseZipCentralDirectory } from './live2d/zip-central-directory';
import { atomicWriteFile } from './persistence/atomic-file';
import { decryptJson, encryptJson } from './persistence/encryption';
import type { SafeStorageVault } from './security';
import { CRAWL4AI_SECRET_ID } from './plugins/credentials';

// Chromium caches, locks, and the separately managed Minecraft runtime/data
// are deliberately outside this snapshot and restore transaction.
// The dedicated Minecraft world and its rotating snapshots live in their own
// user-data root and must stay out of profile archives and restore swaps.
export const PROFILE_ROOTS = ['profile.enc.json', 'settings.json', 'managed', 'vault', 'events', 'workspace', 'migration'] as const;
const MAGIC = Buffer.from('DESKPET-BACKUP-1\n');
const MAX_BYTES = 768 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const deriveKey = promisify(scrypt);
const portableSchema = z.object({
  version: z.literal(1), createdAt: z.iso.datetime(), appVersion: z.string().max(80),
  vaultKey: z.string().base64().length(44),
  providerSecrets: z.record(z.string().uuid(), z.string().min(1).max(16_384)),
}).strict();
const journalSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), phase: z.enum(['prepared', 'applying', 'complete']),
  originals: z.array(z.enum(PROFILE_ROOTS)),
  automaticProtectionProof: z.object({ version:z.literal(1), currentProfileSHA256:z.string().regex(/^[a-f0-9]{64}$/u).nullable(), incomingProfileSHA256:z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
}).strict();

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const validPath = (name: string): boolean => {
  const parts = name.split('/');
  return name.length < 2_048 && !name.includes('\\') && !name.includes('\0')
    && parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes(':'))
    && PROFILE_ROOTS.includes(parts[0] as typeof PROFILE_ROOTS[number])
    && !parts.includes('.staging');
};

export const collectProfileFiles = async (root: string): Promise<Map<string, Buffer>> => {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (relative: string): Promise<void> => {
    const path = join(root, relative);
    if (!(await exists(path))) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('backup.error.symlink');
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name === '.staging') continue;
        await walk(`${relative}/${name}`);
      }
    } else if (info.isFile()) {
      if (!validPath(relative) || info.size > MAX_FILE_BYTES || files.size >= 10_000 || total + info.size > MAX_BYTES) throw new Error('backup.error.size');
      const contents = await readFile(path);
      total += contents.length;
      if (total > MAX_BYTES) throw new Error('backup.error.size');
      files.set(relative, contents);
    } else throw new Error('backup.error.symlink');
  };
  for (const name of PROFILE_ROOTS) await walk(name);
  return files;
};

export const encryptBackup = async (contents: Buffer, password: string): Promise<Buffer> => {
  if (password.length < 12 || password.length > 256) throw new Error('backup.error.passwordLength');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(password, salt, 32) as Buffer;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([cipher.update(contents), cipher.final()]);
    return Buffer.concat([MAGIC, salt, nonce, cipher.getAuthTag(), encrypted]);
  } finally { key.fill(0); }
};

export const decryptBackup = async (contents: Buffer, password: string): Promise<Buffer> => {
  if (contents.length > MAX_BYTES || contents.length < MAGIC.length + 45 || !contents.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('backup.error.invalid');
  const offset = MAGIC.length;
  const key = await deriveKey(password, contents.subarray(offset, offset + 16), 32) as Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, contents.subarray(offset + 16, offset + 28));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(contents.subarray(offset + 28, offset + 44));
    return Buffer.concat([decipher.update(contents.subarray(offset + 44)), decipher.final()]);
  } catch { throw new Error('backup.error.authentication'); }
  finally { key.fill(0); }
};

export class ProfileBackupService {
  constructor(private readonly root: string, private readonly vault: SafeStorageVault, private readonly appVersion: string) {}

  async create(destination: string, password: string): Promise<{ path: string; files: number; bytes: number }> {
    const relativeDestination = relative(this.root, destination);
    if (!relativeDestination.startsWith('..') && !isAbsolute(relativeDestination)) throw new Error('backup.error.destination');
    const files = await collectProfileFiles(this.root);
    const key = await this.vault.getVaultKey();
    if (!files.has('profile.enc.json')) files.set('profile.enc.json', Buffer.from(JSON.stringify(encryptJson(createDefaultState(), key))));
    const profile = files.get('profile.enc.json');
    const secrets: Record<string, string> = {};
    try {
      if (profile !== undefined) {
        const state = decryptJson(JSON.parse(profile.toString()), key, persistentStateSchema);
        for (const provider of state.providers) {
          const secret = await this.vault.getSecret(provider.id);
          if (secret !== null) secrets[provider.id] = secret;
        }
      }
      const zip = new JSZip();
      const crawl4aiToken = await this.vault.getSecret(CRAWL4AI_SECRET_ID);
      if (crawl4aiToken !== null) secrets[CRAWL4AI_SECRET_ID] = crawl4aiToken;
      for (const [name, data] of files) zip.file(name, data);
      zip.file('backup-manifest.json', JSON.stringify({ version: 1, createdAt: new Date().toISOString(), appVersion: this.appVersion, vaultKey: key.toString('base64'), providerSecrets: secrets }));
      const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
      try {
        const encrypted = await encryptBackup(archive, password);
        if (encrypted.length > MAX_BYTES) throw new Error('backup.error.size');
        await atomicWriteFile(destination, encrypted);
        return { path: destination, files: files.size, bytes: encrypted.length };
      } finally { archive.fill(0); }
    } finally { key.fill(0); for (const id of Object.keys(secrets)) delete secrets[id]; }
  }

  async prepareRestore(source: string, password: string): Promise<{ sessions: number; messages: number; files: number; memoryProtection: 'preserved' | 'unavailable' }> {
    if ((await stat(source)).size > MAX_BYTES) throw new Error('backup.error.size');
    const archive = await decryptBackup(await readFile(source), password);
    const id = randomUUID();
    const staging = join(this.root, 'recovery', id, 'incoming');
    let portableKey: Buffer | null = null;
    try {
      const entries = parseZipCentralDirectory(archive);
      const names = new Set<string>();
      let bytes = 0;
      for (const entry of entries) {
        if (entry.directory) continue;
        if (names.has(entry.name) || (entry.name !== 'backup-manifest.json' && !validPath(entry.name)) || entry.symlink) throw new Error('backup.error.invalid');
        names.add(entry.name); bytes += entry.uncompressedSize;
        if (entry.uncompressedSize > MAX_FILE_BYTES || bytes > MAX_BYTES || names.size > 10_001) throw new Error('backup.error.size');
      }
      const zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false });
      const manifestFile = zip.file('backup-manifest.json');
      if (manifestFile === null) throw new Error('backup.error.invalid');
      const manifest = portableSchema.parse(JSON.parse(await manifestFile.async('string')));
      const key = Buffer.from(manifest.vaultKey, 'base64'); portableKey = key;
      const profile = zip.file('profile.enc.json');
      if (profile === null) throw new Error('backup.error.invalid');
      let state = decryptJson(JSON.parse(await profile.async('string')), key, persistentStateSchema);
      // Usage, schedules, triggers and proactive rules are never rolled back by a
      // restore: the newest readable copy wins and the backup's copy is ignored. If
      // nothing is readable the restored profile starts empty, so nothing can run.
      let currentProfileSHA256: string | null = null;
      let authority: unknown = null;
      const guardedCurrent = join(this.root, 'profile.enc.json');
      const authoritySources = (await readdir(this.root)).filter((value) => value.startsWith('profile.enc.json.corrupt-')).sort().reverse();
      if (await exists(guardedCurrent)) {
        currentProfileSHA256 = createHash('sha256').update(await readFile(guardedCurrent)).digest('hex');
        authoritySources.unshift('profile.enc.json');
      }
      for (const name of authoritySources) {
        const guardKey = await this.vault.getVaultKey();
        try { authority = decryptJson(JSON.parse(await readFile(join(this.root, name), 'utf8')), guardKey, z.record(z.string(), z.unknown())); break; }
        catch { /* Unauthenticated or damaged data cannot contribute authority. */ }
        finally { guardKey.fill(0); }
      }
      state = persistentStateSchema.parse(withAutomationAuthority(state, authority));
      // A backup cannot re-enable processing, promote an old draft, or restore consent.
      state.nightlyMemory = defaultNightlyStore();
      state.autoMemory.enabled = false; state.memorySleep.settings.enabled = false; state.memorySleep.lastDay = null;
      for (const message of state.chatMessages) { delete message.nightlyEligible; delete message.nightlyAutoEligible; }
      // A bridge manifest is a grant to a live process on this machine. A portable
      // backup has no matching capability vault; require a fresh desktop import.
      state.desktopExtensions.servers = state.desktopExtensions.servers.filter(server => !server.bridgeDigest);
      // Restoring grants no new intent to run: a schedule may have been cancelled after this backup.
      for (const schedule of state.chatCronSchedules) { schedule.enabled = false; delete schedule.telegramDelivery; delete schedule.qqDelivery; }
      state.wechatOwnerCommands.taskDrafts = [];
      for (const task of state.wechatOwnerCommands.tasks) {
        if (task.state !== 'active') continue;
        task.state = 'blocked';
        task.outcome = 'restored';
        task.run = null;
      }
      let memoryProtection: 'preserved' | 'unavailable' = 'unavailable';
      const currentProfile = join(this.root, 'profile.enc.json');
      let current: ReturnType<typeof persistentStateSchema.parse> | undefined;
      try {
        const currentKey = await this.vault.getVaultKey();
        try {
          if (await exists(currentProfile)) current = decryptJson(JSON.parse(await readFile(currentProfile, 'utf8')), currentKey, persistentStateSchema);
        } finally { currentKey.fill(0); }
      } catch { /* Authentication or schema damage: salvage only independently validated guards below. */ }
      if (current) { state = reconcileMemoryProtection(state, current); memoryProtection = 'preserved'; }
      else {
        // Authentication is still required for partial records. Invalid sibling
        // records must not discard readable tombstones/receipts in that envelope.
        const partial = createDefaultState();
        const candidates = (await readdir(this.root)).filter((name) => name === 'profile.enc.json' || name.startsWith('profile.enc.json.corrupt-'));
        for (const name of candidates) {
          try {
            const currentKey = await this.vault.getVaultKey();
            let raw: Record<string, unknown>;
            try { raw = decryptJson(JSON.parse(await readFile(join(this.root, name), 'utf8')), currentKey, z.record(z.string(), z.unknown())); }
            finally { currentKey.fill(0); }
            for (const field of ['memories', 'memoryTombstones', 'memoryOperations', 'importedSourceEvents'] as const) {
              const valid: unknown[] = [...partial[field]];
              for (const record of Array.isArray(raw[field]) ? raw[field] : []) {
                const parsed = persistentStateSchema.shape[field].safeParse([record]);
                if (parsed.success) valid.push(...parsed.data);
              }
              Object.assign(partial, { [field]: valid });
            }
          } catch { /* Unauthenticated data cannot contribute authority. */ }
        }
        state = reconcileMemoryProtection(state, partial);
        quarantineRestoredMemories(state);
      }
      const settings = zip.file('settings.json');
      if (settings !== null) {
        const envelope = z.object({ schemaVersion: z.literal(1), data: settingsSchema }).strict();
        envelope.parse(JSON.parse(await settings.async('string')));
      }
      for (const provider of state.providers) {
        if (provider.secretState === 'configured' && manifest.providerSecrets[provider.id] === undefined) throw new Error('backup.error.invalid');
      }
      // Validate the entire archive before touching any live file.
      for (const entry of entries) {
        if (entry.directory || entry.name === 'backup-manifest.json') continue;
        const file = zip.file(entry.name);
        if (file === null) throw new Error('backup.error.invalid');
        const data = await file.async('nodebuffer');
        if (data.length !== entry.uncompressedSize) throw new Error('backup.error.invalid');
        await atomicWriteFile(join(staging, entry.name), data);
      }
      for (const batch of state.delegationBatches) {
        if (!batch.children.some((child) => state.backgroundJobs.some((job) => job.id === child.jobId && ['queued', 'dispatching', 'running'].includes(job.status)))) continue;
        batch.invalidatedReason = 'delegation.restoredUnknown'; batch.historicalAt ??= new Date().toISOString();
        const intent = state.delegationIntents.find((item) => item.sessionId === batch.sessionId && item.currentBatchId === batch.id);
        if (intent) { intent.version += 1; intent.currentBatchId = null; }
      }
      // Backup data cannot prove that a once-queued attempt was never sent
      // after that snapshot. Restoring it grants no new generation intent.
      for (const job of state.backgroundJobs) {
        if (!['queued', 'dispatching', 'running'].includes(job.status)) continue;
        job.status = 'interrupted'; job.result = null; job.completionReason = 'job.restoredUnknown';
        job.updatedAt = new Date().toISOString();
        const operationId = `${job.id}:terminal`;
        if (!job.receipts.some((receipt) => receipt.operationId === operationId)) job.receipts.push({
          operationId, kind: 'terminal', committedAt: job.updatedAt, status: job.status,
        });
      }
      // Readable current authority wins over the older snapshot for the same
      // consolidation/attempt. This is an operation-order merge, never mtime.
      if (current?.profileId === state.profileId) {
        for (let index = 0; index < state.consolidationBatches.length; index += 1) {
          const old = state.consolidationBatches[index]!;
          const latest = current.consolidationBatches.find((batch) => batch.id === old.id);
          if (!latest) continue;
          state.consolidationBatches[index] = structuredClone(latest);
          if (latest.jobId) {
            const job = current.backgroundJobs.find((item) => item.id === latest.jobId && item.consolidation?.batchId === latest.id);
            if (job) { state.backgroundJobs = state.backgroundJobs.filter((item) => item.id !== job.id); state.backgroundJobs.push(structuredClone(job)); }
          }
        }
        for (const latest of current.consolidationSelections) {
          const old = state.consolidationSelections.find((item) => item.memoryId === latest.memoryId);
          if (old) { old.version = Math.max(old.version, latest.version); old.batchId = null; }
          else state.consolidationSelections.push({ ...latest, batchId: null });
        }
      }
      // A restored selection cannot establish a newer confirmation intention.
      // Preserve valid candidates for review, but never re-enable or regenerate.
      for (const job of state.backgroundJobs) if (job.consolidation && ['queued','dispatching','running'].includes(job.status)) {
        job.status = 'interrupted'; job.result = null; job.completionReason = 'job.restoredUnknown'; job.updatedAt = new Date().toISOString();
        if (!job.receipts.some((receipt) => receipt.kind === 'terminal')) job.receipts.push({ operationId: `${job.id}:terminal`, kind: 'terminal', committedAt: job.updatedAt, status: 'interrupted' });
      }
      for (const batch of state.consolidationBatches) {
        batch.active = false;
        if (batch.status === 'draft') { batch.status = 'cancelled'; batch.invalidReason = 'consolidation.restoredUnknown'; }
        if (batch.status === 'applied') batch.status = 'disabled';
      }
      for (const selection of state.consolidationSelections) { selection.version += 1; selection.batchId = null; }
      syncConsolidations(state);
      syncDelegations(state);
      // The protected state and its receipts/guards cross the same staged
      // profile replacement boundary; no live file has changed yet.
      await atomicWriteFile(join(staging, 'profile.enc.json'), JSON.stringify(encryptJson(state, key)));
      await this.vault.writePortableSecrets(join(staging, 'vault'), key, manifest.providerSecrets);
      key.fill(0);
      const originals: Array<typeof PROFILE_ROOTS[number]> = [];
      for (const name of PROFILE_ROOTS) if (await exists(join(this.root, name))) originals.push(name);
      if (await exists(join(this.root, 'restore-pending.json'))) throw new Error('backup.error.pending');
      await atomicWriteFile(join(this.root, 'restore-pending.json'), JSON.stringify({ version: 1, id, phase: 'prepared', originals, automaticProtectionProof: {version:1,currentProfileSHA256,incomingProfileSHA256:createHash('sha256').update(await readFile(join(staging,'profile.enc.json'))).digest('hex')} }));
      return { sessions: state.chatSessions.length, messages: state.chatMessages.length, files: names.size - 1, memoryProtection };
    } catch (error) {
      await rm(join(this.root, 'recovery', id), { recursive: true, force: true });
      throw error;
    } finally { portableKey?.fill(0); archive.fill(0); }
  }
}

/** The app re-saves its profile while quitting, after the restore was prepared but
 * with no user able to act in between. Record that final state as the expected one. */
export const refreshPendingRestoreProof = async (root: string): Promise<void> => {
  const path = join(root, 'restore-pending.json');
  if (!(await exists(path))) return;
  const journal = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (journal.phase !== 'prepared' || !journal.automaticProtectionProof) return;
  const live = join(root, 'profile.enc.json');
  const currentProfileSHA256 = await exists(live) ? createHash('sha256').update(await readFile(live)).digest('hex') : null;
  await atomicWriteFile(path, JSON.stringify({ ...journal, automaticProtectionProof: { ...journal.automaticProtectionProof, currentProfileSHA256 } }));
};

/** A prepared restore moved nothing yet, so setting it aside leaves current data intact.
 * Returns false for any other phase, where files may already have moved. */
export const abandonPendingRestore = async (root: string): Promise<boolean> => {
  const path = join(root, 'restore-pending.json');
  if (!(await exists(path))) return false;
  const journal = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (journal.phase !== 'prepared') return false;
  await rename(path, join(root, 'recovery', journal.id, 'abandoned-restore.json'));
  return true;
};

// Applied before services load. Keep a complete pre-restore snapshot and a
// durable journal; interruption on any individual rename rolls back next boot.
/** Written when a restore was applied; the next start revokes the live QQ binding before QQ may connect. */
export const QQ_REVOKE_MARKER = 'qq-revoke-after-restore';
const markQqRevoke = (root: string): Promise<void> => atomicWriteFile(join(root, QQ_REVOKE_MARKER), '1');

export const applyPendingProfileRestore = async (root: string): Promise<'none' | 'restored' | 'rolled-back'> => {
  const path = join(root, 'restore-pending.json');
  if (!(await exists(path))) return 'none';
  const journal = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const directory = join(root, 'recovery', journal.id);
  const incoming = join(directory, 'incoming');
  const previous = join(directory, 'previous');
  const rollback = async (): Promise<void> => {
    for (const name of PROFILE_ROOTS) {
      if (await exists(join(previous, name))) {
        await rm(join(root, name), { recursive: true, force: true });
        await rename(join(previous, name), join(root, name));
      } else if (!journal.originals.includes(name) && !(await exists(join(incoming, name)))) {
        await rm(join(root, name), { recursive: true, force: true });
      }
    }
    await rm(path);
  };
  if (journal.phase === 'complete') { await markQqRevoke(root); await rm(path); return 'restored'; }
  // Old journals have no proof that rollback preserves automatic/usage authority.
  // Preserve all files and stop rather than apply an unverifiable old state.
  const proof = journal.automaticProtectionProof;
  if (!proof) throw new Error('backup.automaticProtectionUnknown');
  const candidates = journal.phase === 'prepared' ? [join(root,'profile.enc.json'),join(incoming,'profile.enc.json')]
    : [join(previous,'profile.enc.json'),join(root,'profile.enc.json'),join(incoming,'profile.enc.json')];
  const hashes: Array<string | null> = [];
  for (const candidate of candidates) hashes.push(await exists(candidate) ? createHash('sha256').update(await readFile(candidate)).digest('hex') : null);
  if (journal.phase === 'prepared' ? hashes[0] !== proof.currentProfileSHA256 || hashes[1] !== proof.incomingProfileSHA256
    : hashes.some((value) => value !== null && value !== proof.currentProfileSHA256 && value !== proof.incomingProfileSHA256) || !hashes.includes(proof.incomingProfileSHA256) || (proof.currentProfileSHA256 !== null && !hashes.includes(proof.currentProfileSHA256))) throw new Error('backup.automaticProtectionUnknown');
  if (journal.phase === 'applying') { await rollback(); return 'rolled-back'; }
  await mkdir(previous, { recursive: true, mode: 0o700 });
  // Even a restored copy with the same profileId must pair again. Recovery-mode
  // restores never initialize channel services; revoke before the first swap.
  // The token remains in the separate vault, outside every profile archive.
  for (const name of ['telegram-channel-state.enc.json', 'knowledge', 'stdio-bridge-vault', 'mcp-auth-vault']) {
    const authority = join(root, name);
    if (await exists(authority)) await rename(authority, join(directory, 'revoked-' + name));
  }
  await atomicWriteFile(path, JSON.stringify({ ...journal, phase: 'applying' }));
  try {
    for (const name of PROFILE_ROOTS) {
      if (await exists(join(root, name))) await rename(join(root, name), join(previous, name));
      if (await exists(join(incoming, name))) await rename(join(incoming, name), join(root, name));
    }
    // The marker is written while the journal still says "applying": if it fails, the normal rollback runs.
    await markQqRevoke(root);
  } catch (error) { await rollback(); throw error; }
  // Past this point the swap is final: a failure here never rolls back; the next start finishes cleanup.
  await atomicWriteFile(path, JSON.stringify({ ...journal, phase: 'complete' }));
  await rm(path).catch(() => undefined);
  return 'restored';
};
