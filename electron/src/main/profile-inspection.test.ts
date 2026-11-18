// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultState } from './domain/schemas';
import type { PersistentState } from './domain/schemas';
import { encryptJson } from './persistence/encryption';
import { assertExistingMacCredentialNamespace, inspectExistingProfile, ProfileInspectionError } from './profile-inspection';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const roots: string[] = [];
const now = new Date('2026-10-29T08:00:00.000Z');
const past = '2026-10-29T07:00:00.000Z';
const privateText = 'PRIVATE_INSPECTION_CONTENT_MUST_NOT_ESCAPE';
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const snapshot = async (root: string): Promise<Array<[string, string]>> => {
  const values: Array<[string, string]> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [relative, sha] of await snapshot(path)) values.push([`${entry.name}/${relative}`, sha]);
    else if (entry.isFile()) values.push([entry.name, digest(await readFile(path))]);
  }
  return values.sort(([a], [b]) => a.localeCompare(b));
};

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-inspection-')));
  roots.push(root);
  await mkdir(join(root, 'vault', 'provider-secrets'), { recursive: true });
  const key = randomBytes(32), providerId = randomUUID(), jobId = randomUUID(), operationId = randomUUID();
  const state = createDefaultState();
  const provider = { id: providerId, kind: 'ollama' as const, name: privateText, baseUrl: 'http://127.0.0.1:9', model: privateText,
    enabled: true, supportsTools: false, secretState: 'configured' as const, localExecutionConfirmed: true };
  state.providers.push(provider);
  state.providerCredentialRefs[providerId] = randomUUID();
  state.backgroundJobs.push({
    id: jobId, profileId: state.profileId, operationId, specDigest: 'a'.repeat(64), attemptId: randomUUID(), origin: 'background-jobs', resultOwner: jobId,
    instruction: privateText, material: privateText, source: { kind: 'explicit-paste', actionId: operationId, privacy: 'local-only' },
    binding: { provider, model: provider.model, digest: 'b'.repeat(64), credentialRef: state.providerCredentialRefs[providerId]!, destination: 'local',
      limits: { maxOutputTokens: 128, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 4096, safetyMarginTokens: 256, capacitySource: 'configured' } } },
    status: 'queued', executionOwner: null, cancelRequestedAt: null, createdAt: past, updatedAt: past, completionReason: null, result: null, request: null,
    receipts: [{ operationId, kind: 'accepted', committedAt: past, status: 'queued' }],
  });
  state.schedules.push({ id: randomUUID(), title: privateText, enabled: true, kind: 'agent', rrule: 'FREQ=MINUTELY;INTERVAL=1', timezone: 'UTC',
    payload: { instruction: privateText, providerId }, nextRunAt: past, lastRunStatus: 'never' });
  state.automationSchedules.push({id:randomUUID(),title:privateText,instruction:privateText,material:privateText,privacy:'local-only',providerId,model:privateText,rule:{kind:'daily',time:'00:00'},timezone:'UTC',missedPolicy:'skip',enabled:true,revision:1,createdAt:past,updatedAt:past,nextRunAt:past,cancelledAt:null});
  state.proactivePolicy={...state.proactivePolicy,enabled:true,eventKinds:['explicit-check-in'],providerId,model:privateText};
  state.proactiveEvents.push({id:'synthetic-event',kind:'explicit-check-in',occurredAt:past,summary:privateText,status:'pending',reason:null});
  state.automationTriggers.push({id:randomUUID(),key:'synthetic-trigger',kind:'schedule',sourceId:randomUUID(),dueAt:past,policyRevision:1,status:'reserved',jobId:null,messageId:null,createdAt:past,updatedAt:past,cancelledAt:null,errorCode:null});
  state.proactive = { enabled: true, frequency: 'frequent', nextAt: past, lastAttemptAt: null, day: '2026-10-29', attemptsToday: 0, sessionId: null, lastMessageAt: null };
  state.timers.push({ id: randomUUID(), label: privateText, dueAt: past, createdAt: past, status: 'pending', completedAt: null });
  const sessionId = randomUUID();
  state.chatSessions.push({ id: sessionId, title: privateText, kind: 'normal', createdAt: past, updatedAt: past });
  state.chatMessages.push({ id: randomUUID(), sessionId, role: 'assistant', content: privateText, createdAt: past, status: 'streaming', errorCode: null });
  const persist = async (value: unknown = state): Promise<void> => {
    await writeFile(join(root, 'profile.enc.json'), JSON.stringify(encryptJson(value, key)));
  };
  await persist();
  await writeFile(join(root, 'vault', 'vault-key.safe'), 'SYNTHETIC_WRAPPED_KEY');
  await writeFile(join(root, 'vault', 'provider-secrets', 'not-opened.safe'), 'DO_NOT_READ_PROVIDER_SECRET');
  await writeFile(join(root, 'settings.json'), JSON.stringify({ schemaVersion: 1, data: { locale: 'en', theme: 'system', hotkey: 'Alt+Space', autoLaunch: true, overlayVisible: true, activeProviderId: providerId } }));
  const safeStorage = { decryptString: vi.fn(() => key.toString('base64')) };
  const namespace = vi.fn(async () => undefined);
  return { root, key, state, persist, safeStorage, namespace, options: { profilePath: root, safeStorage, assertCredentialNamespace: namespace, now } };
};

beforeEach(() => { spawnMock.mockReset(); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('offline existing encrypted profile inspection', () => {
  it('reports dispatchable/automatic paths without starting work or changing any input bytes', async () => {
    const f = await fixture(); const before = await snapshot(f.root);
    const report = await inspectExistingProfile(f.options);
    expect(report.readOnly).toBe(true);
    expect(report.compatibleWithCurrentSchema).toBe(true);
    expect(report.automaticPaths).toEqual({ queuedJobs: 1, possiblyDispatchedJobs: 0, enabledSchedules: 1, dueSchedules: 1,
      enabledChatCronSchedules: 0, pendingChatCronRuns: 0, proactiveEnabled: true, proactiveDue: true, enabledTextSchedules:1,dueTextSchedules:1,eventProactiveEnabled:true,pendingAutomaticTriggers:1,pendingProactiveEvents:1,pendingTimers: 1, dueTimers: 1, loginItemRequestedInSettings: true });
    expect(report.projectionOnly).toMatchObject({ schemaDefaultsOrNormalizationWouldChange: false, streamingChatRecoveryNeeded: true, noProjectionCommitted: true });
    expect(await snapshot(f.root)).toEqual(before);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(f.namespace).toHaveBeenCalledOnce();
    expect(f.safeStorage.decryptString).toHaveBeenCalledExactlyOnceWith(Buffer.from('SYNTHETIC_WRAPPED_KEY'));
    const serialized = JSON.stringify(report);
    for (const value of [privateText, f.key.toString('base64'), 'SYNTHETIC_WRAPPED_KEY', 'DO_NOT_READ_PROVIDER_SECRET', 'http://127.0.0.1:9']) expect(serialized).not.toContain(value);
    expect(report.providerSecretValuesRead).toBe(false);
    expect((f.state.backgroundJobs[0]!).status).toBe('queued');
    f.key.fill(0);
  });

  it('detects default projection without writing a migrated representation', async () => {
    const f = await fixture(); const raw = { ...f.state } as Partial<PersistentState>;
    delete raw.timers; delete raw.memoryOperations; delete raw.consolidationSelections;
    await f.persist(raw); const before = await snapshot(f.root);
    expect((await inspectExistingProfile(f.options)).projectionOnly.schemaDefaultsOrNormalizationWouldChange).toBe(true);
    expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('detects required derived-state reconciliation only on a deep in-memory copy', async () => {
    const f = await fixture(); const missingMemoryId = randomUUID();
    f.state.consolidationBatches.push({
      id: randomUUID(), profileId: f.state.profileId, sessionId: f.state.chatSessions[0]!.id,
      previewOperationId: randomUUID(), previewDigest: 'c'.repeat(64), status: 'review',
      sources: [{ id: missingMemoryId, revision: 1, fingerprint: 'd'.repeat(64), text: privateText, tags: [],
        privacy: 'local-only', scope: { kind: 'global' }, sourceReferences: [], sourceEventIds: [], selectionVersion: 0 }],
      candidate: { segments: [{ text: privateText, sourceIds: [missingMemoryId] }], coveredMemoryIds: [missingMemoryId], uncoveredMemoryIds: [], conflicts: [] },
      candidateVersion: 1, binding: f.state.backgroundJobs[0]!.binding,
      budget: { inputEstimate: 100, maxInputTokens: 1000, maxOutputTokens: 128 },
      createdAt: past, updatedAt: past, jobId: null, invalidReason: null, active: false, receipts: [],
    });
    await f.persist(); const before = await snapshot(f.root);
    expect((await inspectExistingProfile(f.options)).projectionOnly.consolidationReconciliationWouldChange).toBe(true);
    expect(await snapshot(f.root)).toEqual(before);
    expect(f.state.consolidationBatches[0]!.status).toBe('review'); f.key.fill(0);
  });

  it('never creates a missing vault key or touches safeStorage to probe one', async () => {
    const f = await fixture(); await rm(join(f.root, 'vault', 'vault-key.safe'));
    const before = await snapshot(f.root);
    await expect(inspectExistingProfile(f.options)).rejects.toMatchObject({ code: 'inspection.missingInput' });
    expect(f.namespace).not.toHaveBeenCalled(); expect(f.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('does not touch safeStorage when the exact credential namespace is absent', async () => {
    const f = await fixture(); f.namespace.mockRejectedValue(new Error(privateText));
    const before = await snapshot(f.root);
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.credentialNamespaceUnavailable'));
    expect(f.safeStorage.decryptString).not.toHaveBeenCalled(); expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('rejects an invalid envelope before keychain access and never quarantines it', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'profile.enc.json'), privateText); const before = await snapshot(f.root);
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.invalidEnvelope'));
    expect(f.namespace).not.toHaveBeenCalled(); expect(f.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('leaves authenticated-envelope failures unchanged without leaking crypto errors', async () => {
    const f = await fixture(); const envelope = JSON.parse(await readFile(join(f.root, 'profile.enc.json'), 'utf8')) as { authenticationTag: string };
    envelope.authenticationTag = randomBytes(16).toString('base64'); await writeFile(join(f.root, 'profile.enc.json'), JSON.stringify(envelope));
    const before = await snapshot(f.root);
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.authenticationFailed'));
    expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('returns sanitized schema failure rather than body or unrecognized property values', async () => {
    const f = await fixture(); await f.persist({ ...f.state, [privateText]: privateText }); const before = await snapshot(f.root);
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.invalidSchema'));
    expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('validates settings directly without a store load or error quarantine', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'settings.json'), JSON.stringify({ schemaVersion: 1, data: { [privateText]: privateText } }));
    const before = await snapshot(f.root);
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.invalidSettings'));
    expect(f.namespace).not.toHaveBeenCalled(); expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('refuses an active or stale lock and linked input without deleting either', async () => {
    const f = await fixture(); await symlink('synthetic-host-12345', join(f.root, 'SingletonLock'));
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.sourceLocked'));
    expect((await readdir(f.root))).toContain('SingletonLock'); expect(f.namespace).not.toHaveBeenCalled();
    await rm(join(f.root, 'SingletonLock')); await rm(join(f.root, 'profile.enc.json'));
    await symlink(join(f.root, 'settings.json'), join(f.root, 'profile.enc.json'));
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.linkedInput'));
    expect(f.safeStorage.decryptString).not.toHaveBeenCalled(); f.key.fill(0);
  });

  it('detects a pending restore without reading or applying its contents', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'restore-pending.json'), privateText); const before = await snapshot(f.root);
    const report = await inspectExistingProfile(f.options);
    expect(report.projectionOnly.pendingRestorePresent).toBe(true); expect(JSON.stringify(report)).not.toContain(privateText);
    expect(await snapshot(f.root)).toEqual(before); f.key.fill(0);
  });

  it('detects target mutation during the namespace prerequisite instead of certifying a stale snapshot', async () => {
    const f = await fixture(); f.namespace.mockImplementation(async () => { await writeFile(join(f.root, 'profile.enc.json'), 'SYNTHETIC_OTHER_WRITER'); });
    await expect(inspectExistingProfile(f.options)).rejects.toEqual(new ProfileInspectionError('inspection.sourceChanged'));
    f.key.fill(0);
  });
});

describe('existing macOS credential namespace prerequisite', () => {
  it('requests only exact allowed namespace attributes and discards process output', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    spawnMock.mockImplementation(() => { void Promise.resolve().then(() => child.emit('close', 0)); return child; });
    await assertExistingMacCredentialNamespace('DeskPet Electron Candidate');
    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/security', ['find-generic-password', '-s', 'DeskPet Electron Candidate Safe Storage', '-a', 'DeskPet Electron Candidate Key'], expect.objectContaining({ stdio: 'ignore', windowsHide: true }));
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('-w'); expect(spawnMock.mock.calls[0]?.[1]).not.toContain('-g');
  });

  it('fails closed for missing item or unsupported application name', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    spawnMock.mockImplementation(() => { void Promise.resolve().then(() => child.emit('close', 44)); return child; });
    await expect(assertExistingMacCredentialNamespace('DeskPet Electron Candidate')).rejects.toEqual(new ProfileInspectionError('inspection.credentialNamespaceUnavailable'));
    spawnMock.mockClear();
    await expect(assertExistingMacCredentialNamespace(privateText)).rejects.toEqual(new ProfileInspectionError('inspection.credentialNamespaceUnavailable'));
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
