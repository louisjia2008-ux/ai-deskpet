import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ChatService } from '../domain/chat-service';
import { DomainRepository } from '../domain/repository';
import { assertSessionChannel, DESKTOP_CHANNEL, qqChannel } from './execution-context';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('persists the QQ session origin and rejects desktop retry or another binding after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-qq-origin-')); roots.push(root);
  const path = join(root, 'profile.enc.json'), vault = { getVaultKey: async () => Buffer.alloc(32, 84) };
  const repository = new DomainRepository(path, vault); await repository.initialize();
  const chat = new ChatService(repository), bindingId = randomUUID();
  const qq = await chat.createSession('QQ', 'normal', new Date(), bindingId);
  const desktop = await chat.createSession('Desktop', 'normal');
  const loaded = new DomainRepository(path, vault); await loaded.initialize();
  const saved = loaded.snapshot().chatSessions.find(item => item.id === qq.id)!;
  expect(saved.channelBindingId).toBe(bindingId);
  expect(() => assertSessionChannel(saved.channelBindingId, DESKTOP_CHANNEL)).toThrow('qq.sessionOriginMismatch');
  expect(() => assertSessionChannel(saved.channelBindingId, qqChannel({ bindingId: randomUUID(), senderId: 'other' }))).toThrow();
  expect(() => assertSessionChannel(saved.channelBindingId, qqChannel({ bindingId, senderId: 'owner' }))).not.toThrow();
  expect(() => assertSessionChannel(desktop.channelBindingId, qqChannel({ bindingId, senderId: 'owner' }))).toThrow();
  expect(() => assertSessionChannel(desktop.channelBindingId, DESKTOP_CHANNEL)).not.toThrow();
});
