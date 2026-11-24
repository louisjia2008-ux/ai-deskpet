// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainRepository } from './domain/repository';
import { ChatService } from './domain/chat-service';
import { ConversationImportService } from './domain/conversation-import-service';
import { memoryAllowedForContext } from './domain/chat-context-policy';
import { decryptJson, encryptJson } from './persistence/encryption';
import { MemoryService } from './domain/memory-service';
import { ProfileBackupService, QQ_REVOKE_MARKER, abandonPendingRestore, applyPendingProfileRestore, collectProfileFiles, decryptBackup, encryptBackup } from './profile-backup';
import { SafeStorageVault } from './security';
import { CRAWL4AI_SECRET_ID } from './plugins/credentials';
import { QQ_APP_SECRET_ID } from './channels/qq/qq-credentials';
import { QqChannelStore } from './channels/qq/qq-channel-store';
import { defaultMediaSettings } from '../shared/media';
import { z } from 'zod';

const roots: string[] = [];
const password = 'fixture-only-password-2026';
const providerId = '12345678-1234-4234-8234-123456789012';
const adapter = (identity: string) => ({
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`${identity}:${value}`),
  decryptString: (value: Buffer) => {
    if (!value.toString().startsWith(`${identity}:`)) throw new Error('Wrong machine');
    return value.toString().slice(identity.length + 1);
  },
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-backup-test-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source);
  const vault = new SafeStorageVault(join(source, 'vault'), adapter('old'), 'darwin');
  const repository = new DomainRepository(join(source, 'profile.enc.json'), vault); await repository.initialize();
  await vault.setSecret(providerId, 'fixture-provider-secret');
  await repository.transaction((state) => {
    state.relationship.nickname = 'Kitty';
    state.providers.push({ id: providerId, kind: 'ollama', name: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', enabled: true, supportsTools: false, secretState: 'configured' });
  });
  await mkdir(join(source, 'managed/models/kitty'), { recursive: true });
  await writeFile(join(source, 'managed/models/kitty/texture.png'), Buffer.from([1, 2, 3, 4]));
  const service = new ProfileBackupService(source, vault, '0.1.0');
  const backup = join(root, 'test.deskpet-backup');
  return { root, source, vault, repository, service, backup };
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('encrypted full profile backup', () => {
  it('blocks restored WeChat model tasks and drafts without changing fixed reminders', async () => {
    const f = await fixture();
    const now = Date.now();
    const binding = 'a'.repeat(64);
    const task = {
      id: 'b'.repeat(64), binding, instruction: 'Fixture model task',
      timing: { kind: 'once' as const, delayMs: 40_000 },
      authority: { providerId, credentialRef: randomUUID(), model: 'fixture', providerDigest: 'c'.repeat(64),
        destination: 'local' as const, routeFingerprint: 'd'.repeat(64), permissionFingerprint: 'e'.repeat(64) },
    };
    const reminder = { id: 'f'.repeat(64), binding, label: 'Fixture fixed reminder', dueAt: now + 50_000,
      recurrence: null, delivery: null, state: 'active' as const };
    await f.repository.transaction(state => {
      state.wechatOwnerCommands.taskDrafts.push({ ...task, id: '0'.repeat(64), code: '0123456789ab', expiresAt: now + 60_000 });
      state.wechatOwnerCommands.tasks.push({ ...task, dueAt: now, state: 'active', lastFinishedAt: null, outcome: null,
        run: { id: randomUUID(), deliveryId: '1'.repeat(64), phase: 'delivering', text: 'Fixture already generated result' } });
      state.wechatOwnerCommands.tasks.push({ ...task, id: '2'.repeat(64), dueAt: now, state: 'completed', lastFinishedAt: now,
        outcome: 'sent', run: null });
      state.wechatOwnerCommands.reminders.push(reminder);
    });
    await f.service.create(f.backup, password);
    await f.service.prepareRestore(f.backup, password);
    expect(f.repository.read('wechatOwnerCommands').tasks[0]?.state).toBe('active');
    expect(await applyPendingProfileRestore(f.source)).toBe('restored');
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), f.vault);
    await restored.initialize();
    const state = restored.read('wechatOwnerCommands');
    expect(state.taskDrafts).toEqual([]);
    expect(state.tasks).toMatchObject([
      { id: task.id, state: 'blocked', outcome: 'restored', run: null },
      { id: '2'.repeat(64), state: 'completed', outcome: 'sent', run: null },
    ]);
    expect(state.reminders).toEqual([reminder]);
  });

  it('accepts a legacy portable snapshot with no WeChat command ledger', async () => {
    const f = await fixture();
    await f.service.create(f.backup, password);
    const zip = await JSZip.loadAsync(await decryptBackup(await readFile(f.backup), password));
    const manifest = JSON.parse(await zip.file('backup-manifest.json')!.async('string')) as { vaultKey: string };
    const key = Buffer.from(manifest.vaultKey, 'base64');
    const stored = decryptJson(JSON.parse(await zip.file('profile.enc.json')!.async('string')), key, z.record(z.string(), z.unknown()));
    delete stored.wechatOwnerCommands;
    zip.file('profile.enc.json', JSON.stringify(encryptJson(stored, key)));
    key.fill(0);
    await writeFile(f.backup, await encryptBackup(await zip.generateAsync({ type: 'nodebuffer' }), password));
    await f.service.prepareRestore(f.backup, password);
    expect(await applyPendingProfileRestore(f.source)).toBe('restored');
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), f.vault);
    await restored.initialize();
    expect(restored.read('wechatOwnerCommands')).toEqual({ receipts: [], reminders: [], taskDrafts: [], tasks: [] });
    expect(restored.snapshot().relationship.nickname).toBe('Kitty');
  });

  it('restores managed reply image bytes, reversible removal metadata, settings and chat attachments', async () => {
    const f = await fixture();
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const id = createHash('sha256').update(bytes).digest('hex'), at = '2026-11-06T13:00:00.000Z';
    const asset = { id, sha256: id, title: '合成抱抱表情', tags: ['抱抱'], enabled: false, allowQq: true,
      mime: 'image/gif' as const, extension: 'gif' as const, bytes: bytes.length, width: 1, height: 1,
      source: { kind: 'imported' as const, name: 'fixture.gif' }, createdAt: at, updatedAt: at, deletedAt: at,
      lastUsedAt: at, useCount: 1 };
    const settings = { ...defaultMediaSettings(), providerId, autoReplyDesktop: true, autoReplyQq: true, cooldownSeconds: 45 };
    const session = await new ChatService(f.repository).createSession('Synthetic image backup', 'normal');
    await new ChatService(f.repository).addMessage({ sessionId: session.id, role: 'user', content: asset.title,
      attachments: [{ assetId: id, alt: asset.title }], status: 'complete', errorCode: null });
    await f.repository.transaction(state => { state.mediaLibrary = { assets: [asset], settings, recentUses: [{ assetId: id, sessionId: session.id, at }] }; });
    await mkdir(join(f.source, 'managed/reply-images'), { recursive: true });
    await writeFile(join(f.source, `managed/reply-images/${id}.gif`), bytes);
    await f.service.create(f.backup, password);
    const archive = await JSZip.loadAsync(await decryptBackup(await readFile(f.backup), password));
    expect(await archive.file(`managed/reply-images/${id}.gif`)!.async('nodebuffer')).toEqual(bytes);
    const destination = join(f.root, 'media-destination'); await mkdir(destination);
    const destinationVault = new SafeStorageVault(join(destination, 'vault'), adapter('new'), 'darwin');
    await new ProfileBackupService(destination, destinationVault, '0.1.0').prepareRestore(f.backup, password);
    await applyPendingProfileRestore(destination);
    const restoredVault = new SafeStorageVault(join(destination, 'vault'), adapter('new'), 'darwin');
    const restored = new DomainRepository(join(destination, 'profile.enc.json'), restoredVault); await restored.initialize();
    expect(restored.snapshot().mediaLibrary).toEqual({ assets: [asset], settings, recentUses: [{ assetId: id, sessionId: session.id, at }] });
    expect(restored.snapshot().chatMessages[0]?.attachments).toEqual([{ assetId: id, alt: asset.title }]);
    expect(await readFile(join(destination, `managed/reply-images/${id}.gif`))).toEqual(bytes);
  });

  it('excludes the independent QQ vault and channel-state file from the actual portable archive', async () => {
    const f = await fixture();
    const qqVault = new SafeStorageVault(join(f.source, 'qq-channel-vault'), adapter('old'), 'darwin');
    await qqVault.setSecret(QQ_APP_SECRET_ID, 'QQ_SECRET_MUST_NOT_EXPORT');
    const qqStore = new QqChannelStore(join(f.source, 'qq-channel-state.enc.json'), qqVault); await qqStore.initialize();
    await qqStore.update(state => { state.config.appId = 'QQ_APP_MUST_NOT_EXPORT'; state.profileId = f.repository.snapshot().profileId;
      state.binding = { id: 'qq-binding', senderId: 'QQ_RECIPIENT_MUST_NOT_EXPORT', sessionId: randomUUID(), displayName: 'QQ', boundAt: new Date().toISOString() }; });
    const channelFile = await readFile(join(f.source, 'qq-channel-state.enc.json'));
    await f.service.create(f.backup, password);
    const zip = await JSZip.loadAsync(await decryptBackup(await readFile(f.backup), password));
    expect(Object.keys(zip.files).some(name => name.startsWith('qq-channel'))).toBe(false);
    const manifest = await zip.file('backup-manifest.json')!.async('string');
    expect(manifest).not.toContain(QQ_APP_SECRET_ID); expect(manifest).not.toContain('QQ_SECRET_MUST_NOT_EXPORT');
    for (const entry of Object.values(zip.files).filter(file => !file.dir)) {
      const content = await entry.async('nodebuffer');
      expect(content.equals(channelFile)).toBe(false);
      expect(content.includes(Buffer.from('QQ_RECIPIENT_MUST_NOT_EXPORT'))).toBe(false);
    }
  });
  it('restores state, model assets and credentials using a different machine key, preserving a pre-restore copy', async () => {
    const f = await fixture();
    await f.repository.transaction(s => { s.desktopExtensions.servers.push({id:randomUUID(),name:'Transient bridge',
      endpoint:'http://127.0.0.1:56124/',bridgeDigest:'a'.repeat(64),enabled:true,revision:1}); });
    await f.vault.setSecret(CRAWL4AI_SECRET_ID, 'fixture-local-crawl-token');
    await f.service.create(f.backup, password);
    const bytes = await readFile(f.backup);
    expect(bytes.includes(Buffer.from('fixture-provider-secret'))).toBe(false);
    expect(bytes.includes(Buffer.from('fixture-local-crawl-token'))).toBe(false);
    expect(bytes.includes(Buffer.from('Kitty'))).toBe(false);
    const destination = join(f.root, 'destination'); await mkdir(destination);
    for (const name of ['stdio-bridge-vault','knowledge','mcp-auth-vault']) {
      await mkdir(join(destination,name)); await writeFile(join(destination,name,'marker'),'local pre-restore authority');
    }
    await writeFile(join(destination,'telegram-channel-state.enc.json'),'local pre-restore binding');
    await mkdir(join(destination, 'minecraft')); await writeFile(join(destination, 'minecraft/keep'), 'untouched');
    const vault = new SafeStorageVault(join(destination, 'vault'), adapter('new'), 'darwin');
    const destinationRepository=new DomainRepository(join(destination,'profile.enc.json'),vault);await destinationRepository.initialize();await destinationRepository.transaction(()=>undefined);
    const originalDestination=await readFile(join(destination,'profile.enc.json'));
    const service = new ProfileBackupService(destination, vault, '0.1.0');
    await expect(service.prepareRestore(f.backup, password)).resolves.toMatchObject({ sessions: 0, messages: 0 });
    expect(await readFile(join(destination, 'profile.enc.json'))).toEqual(originalDestination);
    expect(await readFile(join(destination, QQ_REVOKE_MARKER)).catch(() => null)).toBeNull();
    expect(await applyPendingProfileRestore(destination)).toBe('restored');
    // Applying leaves the marker that makes the next start revoke the live QQ binding before connecting.
    expect((await readFile(join(destination, QQ_REVOKE_MARKER))).toString()).toBe('1');
    const restoredVault = new SafeStorageVault(join(destination, 'vault'), adapter('new'), 'darwin');
    const restored = new DomainRepository(join(destination, 'profile.enc.json'), restoredVault); await restored.initialize();
    expect(restored.snapshot().relationship.nickname).toBe('Kitty');
    expect(restored.snapshot().desktopExtensions.servers).toEqual([]);
    expect(await restoredVault.getSecret(providerId)).toBe('fixture-provider-secret');
    expect(await restoredVault.getSecret(CRAWL4AI_SECRET_ID)).toBe('fixture-local-crawl-token');
    expect(await readFile(join(destination, 'managed/models/kitty/texture.png'))).toEqual(Buffer.from([1, 2, 3, 4]));
    const [id] = await readdir(join(destination, 'recovery'));
    for (const name of ['stdio-bridge-vault','knowledge','mcp-auth-vault','telegram-channel-state.enc.json']) {
      expect(await readdir(destination)).not.toContain(name);
      expect(await readdir(join(destination,'recovery',id!))).toContain('revoked-'+name);
    }
    expect(await readFile(join(destination, 'recovery', id as string, 'previous/profile.enc.json'))).toEqual(originalDestination);
    expect(await readFile(join(destination, 'minecraft/keep'), 'utf8')).toBe('untouched');
  });

  it('restores chats without resuming automatic memory work', async () => {
    const f = await fixture();
    const chat = new ChatService(f.repository);
    const session = await chat.createSession('Synthetic backup','normal');
    await chat.addMessage({sessionId:session.id,role:'user',content:'我通常使用方格纸。',status:'complete',errorCode:null});
    expect(f.repository.snapshot()).toMatchObject({autoMemory:{enabled:true},memorySleep:{settings:{enabled:true}}});
    await f.service.create(f.backup,password);
    await f.service.prepareRestore(f.backup,password);
    await applyPendingProfileRestore(f.source);
    const restored = new DomainRepository(join(f.source,'profile.enc.json'),
      new SafeStorageVault(join(f.source,'vault'),adapter('old'),'darwin'));
    await restored.initialize();
    expect(restored.snapshot().chatMessages).toHaveLength(1);
    expect(restored.snapshot()).toMatchObject({autoMemory:{enabled:false},memorySleep:{settings:{enabled:false},lastDay:null}});
  });

  it('sets a prepared restore aside without touching current data or QQ', async () => {
    const f = await fixture();
    await f.service.create(f.backup, password);
    const before = await readFile(join(f.source, 'profile.enc.json'));
    await f.service.prepareRestore(f.backup, password);
    expect(await abandonPendingRestore(f.source)).toBe(true);
    expect(await applyPendingProfileRestore(f.source)).toBe('none');
    expect(await readFile(join(f.source, 'profile.enc.json'))).toEqual(before);
    expect(await readFile(join(f.source, QQ_REVOKE_MARKER)).catch(() => null)).toBeNull();
  });

  it('rejects wrong passwords and modified authentication tags without changing live data', async () => {
    const f = await fixture(); await f.service.create(f.backup, password);
    const before = await readFile(join(f.source, 'profile.enc.json'));
    await expect(f.service.prepareRestore(f.backup, 'wrong-fixture-password')).rejects.toThrow('authentication');
    const bytes = await readFile(f.backup); bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1; await writeFile(f.backup, bytes);
    await expect(f.service.prepareRestore(f.backup, password)).rejects.toThrow('authentication');
    expect(await readFile(join(f.source, 'profile.enc.json'))).toEqual(before);
  });

  it('rejects traversal in a correctly encrypted archive before creating a pending restore', async () => {
    const f = await fixture(); const zip = new JSZip(); zip.file('../escape.txt', 'escape');
    await writeFile(f.backup, await encryptBackup(await zip.generateAsync({ type: 'nodebuffer' }), password));
    await expect(f.service.prepareRestore(f.backup, password)).rejects.toThrow('invalid');
    await expect(readFile(join(f.source, 'restore-pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsupported settings before scheduling a replacement', async () => {
    const f = await fixture(); await f.service.create(f.backup, password);
    const zip = await JSZip.loadAsync(await decryptBackup(await readFile(f.backup), password));
    zip.file('settings.json', JSON.stringify({ schemaVersion: 99, data: {} }));
    await writeFile(f.backup, await encryptBackup(await zip.generateAsync({ type: 'nodebuffer' }), password));
    await expect(f.service.prepareRestore(f.backup, password)).rejects.toThrow();
    await expect(readFile(join(f.source, 'restore-pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not follow symlinks or include caches and Minecraft data', async () => {
    const f = await fixture();
    await mkdir(join(f.source, 'Cache')); await writeFile(join(f.source, 'Cache/irrelevant'), 'cache');
    await mkdir(join(f.source, 'minecraft')); await writeFile(join(f.source, 'minecraft/irrelevant'), 'keep');
    expect([...await collectProfileFiles(f.source)].some(([name]) => /Cache|minecraft/.test(name))).toBe(false);
    await symlink(join(f.root, 'outside'), join(f.source, 'workspace'));
    await expect(f.service.create(f.backup, password)).rejects.toThrow('symlink');
  });

  it('preserves an interrupted old restore without automatic-protection proof', async () => {
    const f = await fixture(); const id = randomUUID(); const previous = join(f.source, 'recovery', id, 'previous');
    await mkdir(previous, { recursive: true });
    const original = await readFile(join(f.source, 'profile.enc.json'));
    await rename(join(f.source, 'profile.enc.json'), join(previous, 'profile.enc.json'));
    await writeFile(join(f.source, 'profile.enc.json'), 'partial replacement');
    await writeFile(join(f.source, 'restore-pending.json'), JSON.stringify({ version: 1, id, phase: 'applying', originals: ['profile.enc.json', 'managed', 'vault'] }));
    await expect(applyPendingProfileRestore(f.source)).rejects.toThrow('backup.automaticProtectionUnknown');
    expect(await readFile(join(f.source, 'profile.enc.json'),'utf8')).toBe('partial replacement');
    expect(await readFile(join(previous, 'profile.enc.json'))).toEqual(original);
  });

  it('rejects backing up into its own managed tree', async () => {
    const f = await fixture(); await expect(f.service.create(join(f.source, 'workspace/loop'), password)).rejects.toThrow('destination');
  });

  it('retains newer deletion guards and receipts when formally restoring an older backup', async () => {
    const f = await fixture(); const memory = new MemoryService(f.repository);
    const fact = await memory.upsert({ id: randomUUID(), text: 'SYNTHETIC_BACKUP_REMOVAL', tags: [] });
    await f.service.create(f.backup, password);
    const operationId = randomUUID(); await memory.remove(fact.id, { expectedRevision: 1, operationId });
    const guard = f.repository.snapshot().memoryTombstones;
    const before = await readFile(join(f.source, 'profile.enc.json'));
    await expect(f.service.prepareRestore(f.backup, password)).resolves.toMatchObject({ memoryProtection: 'preserved' });
    expect(await readFile(join(f.source, 'profile.enc.json'))).toEqual(before);
    await applyPendingProfileRestore(f.source);
    const restoredVault = new SafeStorageVault(join(f.source, 'vault'), adapter('old'), 'darwin');
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), restoredVault); await restored.initialize();
    expect(restored.snapshot().memories).toEqual([]);
    expect(restored.snapshot().memoryTombstones).toEqual(guard);
    expect(restored.snapshot().memoryOperations.some((item) => item.operationId === operationId)).toBe(true);
    await expect(new MemoryService(restored).upsert({ id: fact.id, text: fact.text, tags: [] })).rejects.toThrow('memory.removed');
  });

  it('preserves a newer corrected value rather than reviving the backed-up fact', async () => {
    const f = await fixture(); const memory = new MemoryService(f.repository);
    const fact = await memory.upsert({ id: randomUUID(), text: 'SYNTHETIC_OLD_VALUE', tags: [] });
    await f.service.create(f.backup, password);
    const corrected = await memory.upsert({ id: fact.id, text: 'SYNTHETIC_CORRECTED_VALUE', tags: [], expectedRevision: 1, operationId: randomUUID() });
    await f.service.prepareRestore(f.backup, password); await applyPendingProfileRestore(f.source);
    const restoredVault = new SafeStorageVault(join(f.source, 'vault'), adapter('old'), 'darwin');
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), restoredVault); await restored.initialize();
    expect(restored.snapshot().memories).toEqual([corrected]);
    expect(restored.snapshot().memoryTombstones).toMatchObject([{ kind: 'corrected', memoryId: fact.id }]);
  });

  it('holds restored memories for review when newer deletions cannot be authenticated', async () => {
    const f = await fixture(); const service = new MemoryService(f.repository);
    const fact = await service.upsert({ id: randomUUID(), text: 'SYNTHETIC_CORRUPT_DELETE', tags: [] });
    await f.service.create(f.backup, password); await service.remove(fact.id);
    await writeFile(join(f.source, 'profile.enc.json'), 'corrupt newer authority');
    await f.service.prepareRestore(f.backup, password); await applyPendingProfileRestore(f.source);
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), new SafeStorageVault(join(f.source, 'vault'), adapter('old'), 'darwin')); await restored.initialize();
    const memory = restored.snapshot().memories.find((item) => item.id === fact.id);
    if (memory) expect(memoryAllowedForContext(memory, randomUUID(), 'local')).toBe(false);
  });

  it('salvages valid authenticated guards when a sibling record fails schema validation', async () => {
    const f = await fixture(); const memory = new MemoryService(f.repository);
    const fact = await memory.upsert({ id: randomUUID(), text: 'SYNTHETIC_READABLE_GUARD', tags: [] });
    await f.service.create(f.backup, password); await memory.remove(fact.id);
    const current = { ...f.repository.snapshot(), memories: [{ invalid: 'synthetic sibling' }] };
    const key = await f.vault.getVaultKey();
    await writeFile(join(f.source, 'profile.enc.json'), JSON.stringify(encryptJson(current, key))); key.fill(0);
    await expect(f.service.prepareRestore(f.backup, password)).resolves.toMatchObject({ memoryProtection: 'unavailable' });
    await applyPendingProfileRestore(f.source);
    const vault = new SafeStorageVault(join(f.source, 'vault'), adapter('old'), 'darwin');
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), vault); await restored.initialize();
    expect(restored.snapshot().memoryTombstones).toEqual(f.repository.snapshot().memoryTombstones);
    expect(restored.snapshot().memories).toEqual([]);
    expect(restored.snapshot().memoryOperations).toEqual(f.repository.snapshot().memoryOperations);
    expect(JSON.stringify(restored.snapshot().memoryTombstones)).not.toContain(fact.text);
  });

  it('unknown protection blocks restored pending chat/import intentions, recall and automatic promotion until explicit review', async () => {
    const f = await fixture(); const memory = new MemoryService(f.repository); const chat = new ChatService(f.repository);
    const fact = await memory.upsert({ id: randomUUID(), text: 'SYNTHETIC_UNKNOWN_AUTHORITY', tags: [] });
    const session = await chat.createSession('synthetic restored pending', 'normal');
    await chat.addMessage({ sessionId: session.id, role: 'user', content: '请记住：SYNTHETIC_UNKNOWN_AUTHORITY', status: 'complete', errorCode: null });
    const reply = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'complete', errorCode: null });
    const imports = new ConversationImportService(f.repository);
    const preview = imports.preview('synthetic.json', JSON.stringify({ platform: 'fixture', conversationId: 'only-synthetic', messages: [{ id: 'one', sender: 'u', senderName: 'Synthetic', content: fact.text }] }));
    const record = await imports.savePreview(preview.id);
    const candidateId = randomUUID(); const draftId = randomUUID();
    await f.repository.transaction((state) => { state.conversationImports[0]!.draft = { id: draftId, createdAt: new Date().toISOString(), baseMemoryRevision: state.memoryRevision,
      providerName: 'synthetic', speakerId: 'u', speaker: 'Synthetic', isUser: true, sourceMessageIds: [record.messages[0]!.id],
      style: { tone: 'neutral', length: 'brief', sentences: 'short', emoji: 'none', phrases: [] }, styleApplied: false,
      memories: [{ id: candidateId, text: fact.text, evidenceIds: [record.messages[0]!.id], savedMemoryId: null }] }; });
    await f.service.create(f.backup, password); await memory.remove(fact.id);
    const salvageKey=await f.vault.getVaultKey();
    await writeFile(join(f.source, 'profile.enc.json'),JSON.stringify(encryptJson({...f.repository.snapshot(),relationship:{invalid:'synthetic sibling'},memoryTombstones:[],memoryOperations:[],importedSourceEvents:[]},salvageKey)));salvageKey.fill(0);
    await f.service.prepareRestore(f.backup, password); await applyPendingProfileRestore(f.source);
    const restored = new DomainRepository(join(f.source, 'profile.enc.json'), new SafeStorageVault(join(f.source, 'vault'), adapter('old'), 'darwin')); await restored.initialize();
    const restoredMemory = new MemoryService(restored);
    expect(memoryAllowedForContext(restoredMemory.list()[0]!, session.id, 'local')).toBe(false);
    await expect(restoredMemory.saveFromChat(reply.id, fact.text)).rejects.toThrow('memory.editStale');
    const apply = { id: record.id, draftId, memories: [{ id: candidateId, text: fact.text }], applyStyle: false };
    await expect(new ConversationImportService(restored).apply(apply)).rejects.toThrow('imports.stale');
    await restoredMemory.upsert({ id: fact.id, text: 'SYNTHETIC_ORDINARY_CORRECTION', tags: [] });
    expect(restoredMemory.list()[0]?.contextMetadata?.trust).toBe('unverified');
    await restoredMemory.upsert({ id: fact.id, text: 'SYNTHETIC_ORDINARY_CORRECTION', tags: [], confirmForChat: true });
    expect(memoryAllowedForContext(restoredMemory.list()[0]!, session.id, 'local')).toBe(true);
  });

  it('restores over an unreadable current profile and keeps its bytes in recovery', async () => {
    const f = await fixture(); await f.service.create(f.backup, password);
    await writeFile(join(f.source, 'profile.enc.json'), 'corrupted fixture');
    await f.service.prepareRestore(f.backup, password);
    expect(await readFile(join(f.source, 'profile.enc.json'), 'utf8')).toBe('corrupted fixture');
    await applyPendingProfileRestore(f.source);
    expect(await readFile(join(f.source, 'profile.enc.json'), 'utf8')).not.toBe('corrupted fixture');
    const recovery = await readdir(join(f.source, 'recovery'));
    const kept = await Promise.all(recovery.map((id) => readFile(join(f.source, 'recovery', id, 'previous', 'profile.enc.json'), 'utf8').catch(() => '')));
    expect(kept).toContain('corrupted fixture');
  });

  it('does not claim current deletion protection when the profile was quarantined or replaced', async () => {
    const f = await fixture(); await f.service.create(f.backup, password);
    await rename(join(f.source, 'profile.enc.json'), join(f.source, 'profile.enc.json.corrupt-fixture'));
    await expect(f.service.prepareRestore(f.backup, password)).resolves.toMatchObject({ memoryProtection: 'unavailable' });
  });
});
