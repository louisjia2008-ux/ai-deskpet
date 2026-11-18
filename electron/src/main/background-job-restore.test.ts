// @vitest-environment node
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainRepository } from './domain/repository';
import { BackgroundJobService } from './domain/background-job-service';
import { ProviderService } from './providers/provider-service';
import { providerBindingFingerprint } from './providers/request-budget';
import { ProfileBackupService, applyPendingProfileRestore } from './profile-backup';
import { SafeStorageVault } from './security';
import type { BackgroundJob } from '../shared/background-jobs';
import type { ProviderConfig } from '../shared';

const evidenceRoot = '/private/tmp/deskpet/output/deskpet-electron-ep2-20261028/restore';
const password = 'SYNTHETIC_RESTORE_BACKUP_PASSWORD';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`SYNTHETIC_MACHINE:${value}`),
  decryptString: (value: Buffer) => {
    if (!value.toString().startsWith('SYNTHETIC_MACHINE:')) throw new Error('Wrong synthetic machine');
    return value.toString().slice('SYNTHETIC_MACHINE:'.length);
  },
};
const config: ProviderConfig = {
  id: 'fbac14f1-b74b-4da9-a109-0232a11fa7bb', kind: 'lm-studio', name: 'Synthetic restore provider',
  baseUrl: 'http://127.0.0.1:11994/v1', model: 'restore-text', enabled: true, supportsTools: true,
  secretState: 'missing', localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512,
};
const services: BackgroundJobService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.shutdown())); vi.unstubAllGlobals(); });

const fixture = async (label: string, terminalResult = false) => {
  const root = join(evidenceRoot, `${label}-${randomUUID()}`); const profile = join(root, 'profile'); await mkdir(profile, { recursive: true });
  const vault = new SafeStorageVault(join(profile, 'vault'), safeStorage, 'darwin');
  const repo = new DomainRepository(join(profile, 'profile.enc.json'), vault); await repo.initialize();
  const id = randomUUID(); const operationId = randomUUID(); const attemptId = randomUUID(); const credentialRef = randomUUID(); const at = '2026-10-28T00:00:00.000Z';
  const job: BackgroundJob = {
    id, profileId: repo.snapshot().profileId, operationId, specDigest: 'a'.repeat(64), attemptId,
    origin: 'background-jobs', resultOwner: id, instruction: `SYNTHETIC_RESTORE_${label}`, material: 'EXPLICIT_MATERIAL_ONLY',
    source: { kind: 'explicit-paste', actionId: operationId, privacy: 'local-only' },
    binding: { provider: config, model: config.model, digest: providerBindingFingerprint(config, config.model), credentialRef, destination: 'local',
      limits: { maxOutputTokens: 512, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 32768, safetyMarginTokens: 256, capacitySource: 'configured' } } },
    status: terminalResult ? 'succeeded' : 'queued', executionOwner: terminalResult ? randomUUID() : null,
    cancelRequestedAt: null, createdAt: at, updatedAt: at, completionReason: terminalResult ? 'stop' : null,
    result: terminalResult ? 'ALREADY_COMMITTED_RESULT' : null, request: null,
    receipts: [{ operationId, kind: 'accepted', committedAt: at, status: 'queued' }],
  };
  if (terminalResult) job.receipts.push({ operationId: `${id}:terminal`, kind: 'terminal', committedAt: at, status: 'succeeded' });
  await repo.transaction((state) => { state.providers.push(config); state.providerCredentialRefs[config.id] = credentialRef; state.backgroundJobs.push(job); });
  const backup = join(root, 'old.deskpet-backup'); const backupService = new ProfileBackupService(profile, vault, 'synthetic-test');
  await backupService.create(backup, password);
  return { root, profile, repo, vault, backup, backupService, job };
};
const runRestored = async (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(await applyPendingProfileRestore(f.profile)).toBe('restored');
  const vault = new SafeStorageVault(join(f.profile, 'vault'), safeStorage, 'darwin');
  const repo = new DomainRepository(join(f.profile, 'profile.enc.json'), vault); await repo.initialize();
  let generations = 0;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
    generations++;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'UNAUTHORIZED_RESTORED_GENERATION' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  let service: BackgroundJobService;
  const providers = new ProviderService(repo, vault, undefined, {
    prepared: (record) => service.prepare(record), observed: (observation) => service.observe(observation), beforeDispatch: (id) => service.assertDispatch(id),
  });
  service = new BackgroundJobService(repo, providers); services.push(service); await service.initialize();
  await vi.waitFor(() => expect(service.active).toBe(false));
  const fresh = new DomainRepository(join(f.profile, 'profile.enc.json'), vault); await fresh.initialize();
  const state = fresh.snapshot(); const encrypted = await readFile(join(f.profile, 'profile.enc.json'));
  await writeFile(join(f.root, 'evidence.json'), JSON.stringify({
    configuration: 'Real ProfileBackupService encrypted archive, staged restore, atomic replacement, fresh DomainRepository; synthetic safeStorage adapter and fetch stub; service initialization uses production provider hooks',
    generations, profileSHA256: createHash('sha256').update(encrypted).digest('hex'), state,
  }, null, 2));
  return { state, generations };
};

describe('E-P2 restored job activation boundary', () => {
  it('does not replay a queued backup job after a later authoritative cancellation', async () => {
    const f = await fixture('queued-backup-newer-cancel');
    await f.repo.transaction((state) => {
      const current = state.backgroundJobs[0]!; current.status = 'cancelled'; current.cancelRequestedAt = '2026-10-28T00:01:00.000Z';
      current.completionReason = 'job.cancelledBeforeDispatch'; current.receipts.push({ operationId: `${current.id}:cancel`, kind: 'cancel', committedAt: current.cancelRequestedAt, status: 'cancelled' });
    });
    await f.backupService.prepareRestore(f.backup, password);
    const restored = await runRestored(f);
    expect(restored.generations).toBe(0);
    expect(restored.state.backgroundJobs[0]).toMatchObject({ id: f.job.id, attemptId: f.job.attemptId, status: 'interrupted', result: null, completionReason: 'job.restoredUnknown' });
    expect(restored.state.backgroundJobs[0]?.receipts).toContainEqual(expect.objectContaining({ kind: 'terminal', status: 'interrupted' }));
  });

  it('preserves an already committed terminal result without generating again', async () => {
    const f = await fixture('terminal-result', true);
    await f.backupService.prepareRestore(f.backup, password);
    const restored = await runRestored(f);
    expect(restored.generations).toBe(0);
    expect(restored.state.backgroundJobs[0]).toMatchObject({ id: f.job.id, attemptId: f.job.attemptId, status: 'succeeded', result: 'ALREADY_COMMITTED_RESULT' });
  });

  it('counts a submission awaiting metadata as active and rechecks host maintenance before acceptance', async () => {
    const f = await fixture('submission-maintenance'); await f.repo.transaction((state) => { state.backgroundJobs = []; });
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Generation must not start during maintenance'); }); vi.stubGlobal('fetch', fetcher);
    let available = true; let entered!: () => void; let release!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const providers = new ProviderService(f.repo, f.vault); const original = providers.captureBinding.bind(providers);
    vi.spyOn(providers, 'captureBinding').mockImplementationOnce(async (...args) => { entered(); await barrier; return original(...args); });
    const service = new BackgroundJobService(f.repo, providers, () => undefined, () => available); services.push(service);
    await service.initialize(); await vi.waitFor(() => expect(service.active).toBe(false));
    const submitted = service.submit({ operationId: randomUUID(), instruction: 'SUBMISSION_DURING_MAINTENANCE', material: '', privacy: 'local-only', providerId: config.id, model: config.model });
    const rejected = expect(submitted).rejects.toThrow('job.maintenance'); await began;
    expect(service.active).toBe(true); available = false; release(); await rejected;
    await vi.waitFor(() => expect(service.active).toBe(false));
    expect(f.repo.snapshot().backgroundJobs).toHaveLength(0); expect(fetcher).not.toHaveBeenCalled();
    await writeFile(join(f.root, 'maintenance-evidence.json'), JSON.stringify({ configuration: 'Real encrypted repository and ProviderService; controlled captureBinding barrier and host availability closure', activeWhileMetadataPending: true, acceptanceRejected: 'job.maintenance', generations: fetcher.mock.calls.length, state: f.repo.snapshot() }, null, 2));
  });

  it('restores over an unreadable current profile without activating restored pending work', async () => {
    const f = await fixture('current-unreadable'); await writeFile(join(f.profile, 'profile.enc.json'), 'SYNTHETIC_UNREADABLE_CURRENT_AUTHORITY');
    await f.backupService.prepareRestore(f.backup, password);
    await applyPendingProfileRestore(f.profile);
    const repo = new DomainRepository(join(f.profile, 'profile.enc.json'), new SafeStorageVault(join(f.profile, 'vault'), safeStorage, 'darwin')); await repo.initialize();
    expect(repo.snapshot().backgroundJobs.filter((job) => ['queued', 'dispatching', 'running'].includes(job.status))).toEqual([]);
  });
});
