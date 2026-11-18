import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { settingsSchema } from './app-settings';
import { syncConsolidations } from './domain/consolidation-state';
import { persistentStateSchema } from './domain/schemas';
import { decryptBytes, encryptedEnvelopeSchema } from './persistence/encryption';
import { boundedChildEnvironment } from './security/child-environment';
import type { SafeStorageAdapter } from './security/safe-storage-vault';

export type ProfileInspectionFailureCode =
  | 'inspection.invalidPath' | 'inspection.linkedInput' | 'inspection.missingInput'
  | 'inspection.inputUnavailable' | 'inspection.inputTooLarge' | 'inspection.sourceLocked'
  | 'inspection.credentialNamespaceUnavailable' | 'inspection.invalidEnvelope'
  | 'inspection.keyUnavailable' | 'inspection.authenticationFailed'
  | 'inspection.invalidSchema' | 'inspection.invalidSettings' | 'inspection.sourceChanged';

/** Deliberately excludes raw I/O, crypto and schema errors from diagnostics. */
export class ProfileInspectionError extends Error {
  constructor(readonly code: ProfileInspectionFailureCode) {
    super(code);
    this.name = 'ProfileInspectionError';
  }
}

const fail = (code: ProfileInspectionFailureCode): never => { throw new ProfileInspectionError(code); };
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const settingsEnvelopeSchema = z.object({ schemaVersion: z.literal(1), data: settingsSchema }).strict();

/**
 * The existing non-MAS Darwin namespace must exist before safeStorage is used.
 * OSCrypt can otherwise create a new namespace item even on a decrypt attempt.
 * This fixed metadata query requests no password, and discards both streams.
 */
export const assertExistingMacCredentialNamespace = async (applicationName: string): Promise<void> => {
  if (process.platform !== 'darwin' || !['DeskPet Electron', 'DeskPet Electron Candidate'].includes(applicationName)) {
    fail('inspection.credentialNamespaceUnavailable');
  }
  const found = await new Promise<boolean>((resolveLookup) => {
    const child = spawn('/usr/bin/security', [
      'find-generic-password', '-s', `${applicationName} Safe Storage`, '-a', `${applicationName} Key`,
    ], { stdio: 'ignore', env: boundedChildEnvironment(), windowsHide: true });
    let settled = false;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveLookup(success);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(false); }, 5_000);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  }).catch(() => false);
  if (!found) fail('inspection.credentialNamespaceUnavailable');
};

const existing = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return fail('inspection.inputUnavailable');
  }
};

const checkedDirectory = async (path: string): Promise<string> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return fail('inspection.linkedInput');
    if (!info.isDirectory()) return fail('inspection.invalidPath');
    return await realpath(path);
  } catch (error) {
    if (error instanceof ProfileInspectionError) throw error;
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'inspection.missingInput' : 'inspection.inputUnavailable');
  }
};

/** Open only an existing regular file; no creation, quarantine, rename or save. */
const readExistingFile = async (path: string, maximum: number): Promise<Buffer> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return fail('inspection.linkedInput');
    if (!info.isFile()) return fail('inspection.invalidPath');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile()) return fail('inspection.invalidPath');
      if (opened.size > maximum) return fail('inspection.inputTooLarge');
      const bytes = await file.readFile();
      if (bytes.length > maximum) return fail('inspection.inputTooLarge');
      return bytes;
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ProfileInspectionError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return fail('inspection.linkedInput');
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'inspection.missingInput' : 'inspection.inputUnavailable');
  }
};

export interface ExistingProfileInspectionOptions {
  profilePath: string;
  safeStorage: Pick<SafeStorageAdapter, 'decryptString'>;
  assertCredentialNamespace: () => Promise<void>;
  now?: Date;
}

export interface ExistingProfileInspectionReport {
  version: 1;
  readOnly: true;
  compatibleWithCurrentSchema: true;
  profilePath: string;
  persistentSchemaVersion: 1;
  sourceUnchangedDuringRead: true;
  providerSecretValuesRead: false;
  files: {
    profile: { bytes: number; sha256: string };
    wrappedKey: { bytes: number; sha256: string };
    settings: { present: boolean; sha256: string | null };
  };
  counts: { memories: number; chatSessions: number; chatMessages: number; backgroundJobs: number; providers: number; schedules: number; timers: number };
  automaticPaths: {
    queuedJobs: number;
    possiblyDispatchedJobs: number;
    enabledSchedules: number;
    dueSchedules: number;
    proactiveEnabled: boolean;
    proactiveDue: boolean;
    enabledTextSchedules: number;
    dueTextSchedules: number;
    eventProactiveEnabled: boolean;
    pendingAutomaticTriggers: number;
    pendingProactiveEvents: number;
    enabledChatCronSchedules: number;
    pendingChatCronRuns: number;
    pendingTimers: number;
    dueTimers: number;
    loginItemRequestedInSettings: boolean;
  };
  projectionOnly: {
    schemaDefaultsOrNormalizationWouldChange: boolean;
    settingsDefaultsOrNormalizationWouldChange: boolean;
    consolidationReconciliationWouldChange: boolean;
    streamingChatRecoveryNeeded: boolean;
    orphanJobRecoveryNeeded: boolean;
    pendingRestorePresent: boolean;
    noProjectionCommitted: true;
  };
}

/**
 * A maintenance-only reader. It intentionally never constructs the repository,
 * vault, provider, task, timer, recovery, settings store or application controller.
 * The caller must select a stopped, distinct copy and an isolated runtime root.
 */
export const inspectExistingProfile = async (options: ExistingProfileInspectionOptions): Promise<ExistingProfileInspectionReport> => {
  if (!isAbsolute(options.profilePath)) return fail('inspection.invalidPath');
  const root = await checkedDirectory(resolve(options.profilePath));
  await checkedDirectory(join(root, 'vault'));
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    if (await existing(join(root, name))) return fail('inspection.sourceLocked');
  }
  const profilePath = join(root, 'profile.enc.json');
  const keyPath = join(root, 'vault', 'vault-key.safe');
  const settingsPath = join(root, 'settings.json');
  const serialized = await readExistingFile(profilePath, 128 * 1024 * 1024);
  const wrappedKey = await readExistingFile(keyPath, 64 * 1024);
  const settingsBytes = await existing(settingsPath) ? await readExistingFile(settingsPath, 1024 * 1024) : null;
  let envelope: z.infer<typeof encryptedEnvelopeSchema>;
  try { envelope = encryptedEnvelopeSchema.parse(JSON.parse(serialized.toString('utf8'))); }
  catch { return fail('inspection.invalidEnvelope'); }

  let settings: z.infer<typeof settingsEnvelopeSchema> | null = null;
  let rawSettings: unknown = null;
  if (settingsBytes !== null) {
    try { rawSettings = JSON.parse(settingsBytes.toString('utf8')); settings = settingsEnvelopeSchema.parse(rawSettings); }
    catch { return fail('inspection.invalidSettings'); }
  }
  try { await options.assertCredentialNamespace(); }
  catch { return fail('inspection.credentialNamespaceUnavailable'); }

  let key: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    try { key = Buffer.from(options.safeStorage.decryptString(wrappedKey), 'base64'); }
    catch { return fail('inspection.keyUnavailable'); }
    if (key.byteLength !== 32) return fail('inspection.keyUnavailable');
    try { plaintext = decryptBytes(envelope, key); }
    catch { return fail('inspection.authenticationFailed'); }
    let raw: unknown;
    try { raw = JSON.parse(plaintext.toString('utf8')); }
    catch { return fail('inspection.invalidSchema'); }
    const parsed = persistentStateSchema.safeParse(raw);
    if (!parsed.success) return fail('inspection.invalidSchema');
    const state = parsed.data;
    const projected = structuredClone(state);
    try { syncConsolidations(projected); }
    catch { return fail('inspection.invalidSchema'); }
    const instant = options.now?.getTime() ?? Date.now();
    const isDue = (value: string | null): boolean => value !== null && Date.parse(value) <= instant;
    const pendingRestorePresent = await existing(join(root, 'restore-pending.json'));
    if (hash(await readExistingFile(profilePath, 128 * 1024 * 1024)) !== hash(serialized)
      || hash(await readExistingFile(keyPath, 64 * 1024)) !== hash(wrappedKey)
      || (settingsBytes === null ? await existing(settingsPath) : hash(await readExistingFile(settingsPath, 1024 * 1024)) !== hash(settingsBytes))) return fail('inspection.sourceChanged');
    return {
      version: 1, readOnly: true, compatibleWithCurrentSchema: true, profilePath: root, persistentSchemaVersion: 1,
      sourceUnchangedDuringRead: true, providerSecretValuesRead: false,
      files: { profile: { bytes: serialized.length, sha256: hash(serialized) }, wrappedKey: { bytes: wrappedKey.length, sha256: hash(wrappedKey) },
        settings: { present: settingsBytes !== null, sha256: settingsBytes === null ? null : hash(settingsBytes) } },
      counts: { memories: state.memories.length, chatSessions: state.chatSessions.length, chatMessages: state.chatMessages.length,
        backgroundJobs: state.backgroundJobs.length, providers: state.providers.length, schedules: state.schedules.length, timers: state.timers.length },
      automaticPaths: {
        queuedJobs: state.backgroundJobs.filter((job) => job.status === 'queued').length,
        possiblyDispatchedJobs: state.backgroundJobs.filter((job) => ['dispatching', 'running'].includes(job.status)).length,
        enabledSchedules: state.schedules.filter((schedule) => schedule.enabled).length,
        dueSchedules: state.schedules.filter((schedule) => schedule.enabled && isDue(schedule.nextRunAt)).length,
        proactiveEnabled: state.proactive.enabled, proactiveDue: state.proactive.enabled && isDue(state.proactive.nextAt),
        enabledTextSchedules: state.automationSchedules.filter((s)=>s.enabled&&!s.cancelledAt).length,
        dueTextSchedules: state.automationSchedules.filter((s)=>s.enabled&&!s.cancelledAt&&isDue(s.nextRunAt)).length,
        eventProactiveEnabled: state.proactivePolicy.enabled,
        pendingAutomaticTriggers: state.automationTriggers.filter((t)=>['reserved','submitted'].includes(t.status)).length,
        pendingProactiveEvents: state.proactiveEvents.filter((e)=>e.status==='pending').length,
        enabledChatCronSchedules: state.chatCronSchedules.filter(item=>item.enabled&&!item.cancelledAt).length,
        pendingChatCronRuns: state.chatCronRuns.filter(item=>['reserved','running'].includes(item.status)).length,
        pendingTimers: state.timers.filter((timer) => timer.status === 'pending').length,
        dueTimers: state.timers.filter((timer) => timer.status === 'pending' && isDue(timer.dueAt)).length,
        loginItemRequestedInSettings: settings?.data.autoLaunch ?? false,
      },
      projectionOnly: {
        schemaDefaultsOrNormalizationWouldChange: !isDeepStrictEqual(raw, state),
        settingsDefaultsOrNormalizationWouldChange: settings !== null && !isDeepStrictEqual(rawSettings, settings),
        consolidationReconciliationWouldChange: !isDeepStrictEqual(state, projected),
        streamingChatRecoveryNeeded: state.chatMessages.some((message) => message.status === 'streaming'),
        orphanJobRecoveryNeeded: state.backgroundJobs.some((job) => ['dispatching', 'running'].includes(job.status)),
        pendingRestorePresent, noProjectionCommitted: true,
      },
    };
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
};
