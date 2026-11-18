// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultState, persistentStateSchema } from './domain/schemas';
import { decryptJson, encryptJson } from './persistence/encryption';
import { applyPendingProfileRestore, ProfileBackupService } from './profile-backup';
import { SafeStorageVault } from './security';

// All data and wrapping identities here are synthetic. This adapter deliberately
// does not invoke Electron safeStorage or the user's Keychain.
const testAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`SYNTHETIC_RESTORE_AUDIT:${value}`),
  decryptString: (value: Buffer) => {
    const prefix = 'SYNTHETIC_RESTORE_AUDIT:';
    if (!value.toString().startsWith(prefix)) throw new Error('audit.wrongSyntheticIdentity');
    return value.toString().slice(prefix.length);
  },
};
const roots: string[] = [];
const password = 'SYNTHETIC-restore-audit-password';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const exists = async (path: string): Promise<boolean> => {
  try { await access(path); return true; } catch { return false; }
};
const authority = (kind: 'automationTriggers' | 'usageEvents'): unknown[] => {
  const id = randomUUID();
  const at = '2026-10-30T00:00:00.000Z';
  return kind === 'automationTriggers' ? [{
    id, key: `schedule:${id}:${at}`, kind: 'schedule', sourceId: id, dueAt: at,
    policyRevision: 1, status: 'unknown', publishedAt: null, jobId: id,
    messageId: null, createdAt: at, updatedAt: at, cancelledAt: at,
    errorCode: 'SYNTHETIC_ALREADY_DISPATCHED',
  }] : [{
    requestId: id, ownerId: id, scope: 'schedule', batchId: null, providerId: randomUUID(),
    model: 'SYNTHETIC_ONLY', preparedAt: at, dispatchedAt: at, terminalAt: null,
    phase: 'fetch-invoked', outcome: null, inputEstimate: 10, maxOutputTokens: 10,
    inputTokens: null, outputTokens: null, tokenSource: 'unknown', reportedCostUSD: null,
  }];
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-automatic-restore-audit-'));
  roots.push(root);
  const profile = join(root, 'profile');
  await mkdir(profile);
  const vault = new SafeStorageVault(join(profile, 'vault'), testAdapter, 'darwin');
  const writeEnvelope = async (path: string, state: unknown): Promise<Buffer> => {
    const key = await vault.getVaultKey();
    try {
      const bytes = Buffer.from(JSON.stringify(encryptJson(state, key)));
      await writeFile(path, bytes);
      return bytes;
    } finally { key.fill(0); }
  };
  await writeEnvelope(join(profile, 'profile.enc.json'), createDefaultState());
  const service = new ProfileBackupService(profile, vault, 'synthetic-audit');
  const backup = join(root, 'empty-before-automatic-work.deskpet-backup');
  await service.create(backup, password);
  return { root, profile, vault, service, backup, writeEnvelope };
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('automatic authority must survive profile restore boundaries', () => {
  it.each(['automationTriggers', 'usageEvents'] as const)(
    'carries %s over from an authenticated quarantined profile when an old backup is restored',
    async (field) => {
      const f = await fixture();
      const live = join(f.profile, 'profile.enc.json');
      const quarantine = `${live}.corrupt-SYNTHETIC-validated-sibling-damage`;
      // A bad sibling field causes normal EncryptedJsonStore.load to quarantine
      // this authenticated envelope; its new protection authority remains valid.
      const bytes = await f.writeEnvelope(live, {
        ...createDefaultState(), chatMessages: 'SYNTHETIC_SCHEMA_DAMAGE', [field]: authority(field),
      });
      await rename(live, quarantine);
      await f.service.prepareRestore(f.backup, password);
      await applyPendingProfileRestore(f.profile);
      const key = await f.vault.getVaultKey();
      const state = JSON.parse(JSON.stringify(decryptJson(JSON.parse(await readFile(live, 'utf8')), key, persistentStateSchema))) as Record<string, unknown[]>;
      key.fill(0);
      expect(state[field]).toHaveLength(authority(field).length);
      expect(digest(await readFile(quarantine))).toBe(digest(bytes));
    },
  );

  it('restores over quarantined authority it cannot read, keeping the damaged file and starting automation empty', async () => {
    const f = await fixture();
    const live = join(f.profile, 'profile.enc.json');
    const quarantine = `${live}.corrupt-SYNTHETIC-unknown-authority`;
    const bytes = Buffer.from('SYNTHETIC_UNREADABLE_CURRENT_AUTHORITY');
    await writeFile(live, bytes);
    await rename(live, quarantine);
    await f.service.prepareRestore(f.backup, password);
    await applyPendingProfileRestore(f.profile);
    const key = await f.vault.getVaultKey();
    const state = decryptJson(JSON.parse(await readFile(live, 'utf8')), key, persistentStateSchema);
    key.fill(0);
    expect(state.automationTriggers).toEqual([]);
    expect(digest(await readFile(quarantine))).toBe(digest(bytes));
  });

  it('rejects applying-journal rollback when a third current ciphertext is outside the proof', async () => {
    const f = await fixture();
    await f.service.prepareRestore(f.backup, password);
    const journalPath = join(f.profile, 'restore-pending.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      version: 1; id: string; phase: string; originals: string[];
      automaticProtectionProof: { version: 1; currentProfileSHA256: string; incomingProfileSHA256: string };
    };
    const directory = join(f.profile, 'recovery', journal.id);
    const previous = join(directory, 'previous');
    const incoming = join(directory, 'incoming', 'profile.enc.json');
    await mkdir(previous);
    const live = join(f.profile, 'profile.enc.json');
    await rename(live, join(previous, 'profile.enc.json'));
    const protectedCurrent = await f.writeEnvelope(live, {
      ...createDefaultState(), automationTriggers: authority('automationTriggers'),
    });
    const incomingBefore = await readFile(incoming);
    const previousBefore = await readFile(join(previous, 'profile.enc.json'));
    await writeFile(journalPath, JSON.stringify({ ...journal, phase: 'applying' }));
    const journalBefore = await readFile(journalPath);
    expect(digest(protectedCurrent)).not.toBe(journal.automaticProtectionProof.currentProfileSHA256);
    expect(digest(protectedCurrent)).not.toBe(journal.automaticProtectionProof.incomingProfileSHA256);
    let rejection: unknown;
    try { await applyPendingProfileRestore(f.profile); } catch (error) { rejection = error; }
    expect.soft(rejection, 'two known ciphertexts do not authorize removal of an unexplained third ciphertext').toBeInstanceOf(Error);
    expect.soft(rejection).toMatchObject({ message: 'backup.automaticProtectionUnknown' });
    expect.soft(digest(await readFile(live)), 'current protection authority must not be overwritten').toBe(digest(protectedCurrent));
    expect.soft(await exists(journalPath), 'unknown applying journal must remain available for explicit recovery').toBe(true);
    if (await exists(journalPath)) expect.soft(await readFile(journalPath)).toEqual(journalBefore);
    expect.soft(await exists(join(previous, 'profile.enc.json')), 'original pre-restore copy must remain').toBe(true);
    if (await exists(join(previous, 'profile.enc.json'))) expect.soft(await readFile(join(previous, 'profile.enc.json'))).toEqual(previousBefore);
    expect.soft(await readFile(incoming)).toEqual(incomingBefore);
  });
});
