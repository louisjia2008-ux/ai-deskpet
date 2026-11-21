// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DomainRepository } from './repository';
import { ChatService } from './chat-service';
import { ChatResponseWriter } from './chat-response-writer';

const roots: string[] = [];
const vault = { getVaultKey: async () => Buffer.alloc(32, 13) };
const writers: ChatResponseWriter[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-chat-checkpoint-')); roots.push(root);
  const path = join(root, 'profile.enc.json');
  const repository = new DomainRepository(path, vault); await repository.initialize();
  const chat = new ChatService(repository); const session = await chat.createSession('Fixture', 'normal');
  await chat.addMessage({ sessionId: session.id, role: 'user', content: 'Original question', status: 'complete', errorCode: null });
  const message = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  const writer = new ChatResponseWriter(chat, message.id, () => undefined, 10); writers.push(writer);
  return { path, repository, chat, session, message, writer };
}
afterEach(async () => { writers.splice(0).forEach((writer) => writer.stop()); vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('recovers an actually persisted partial reply as interrupted after a new repository opens it', async () => {
  const f = await fixture(); f.writer.append('Saved partial answer');
  await vi.waitFor(() => expect(f.chat.listMessages(f.session.id).at(-1)?.content).toBe('Saved partial answer'));
  f.writer.stop();
  const reopened = new DomainRepository(f.path, vault); await reopened.initialize();
  expect(new ChatService(reopened).listMessages(f.session.id).at(-1)).toMatchObject({ status: 'failed', errorCode: 'chat.interrupted', content: 'Saved partial answer' });
  const again = new DomainRepository(f.path, vault); await again.initialize();
  expect(again.snapshot().chatMessages.at(-1)?.errorCode).toBe('chat.interrupted');
});
it('waits for checkpoints and preserves the final partial reply when cancelled', async () => {
  const f = await fixture(); f.writer.append('Partial');
  await vi.waitFor(() => expect(f.chat.listMessages(f.session.id).at(-1)?.content).toBe('Partial'));
  f.writer.append(' and latest');
  await f.writer.finish('cancelled');
  expect(f.chat.listMessages(f.session.id).at(-1)).toMatchObject({ content: 'Partial and latest', status: 'cancelled' });
});
it('retries the original user question with its preceding context, never the partial assistant answer', async () => {
  const f = await fixture(); f.writer.append('An incomplete assistant answer'); await f.writer.finish('failed', 'chat.interrupted');
  const retry = f.chat.retryContext(f.message.id);
  expect(retry.content).toBe('Original question'); expect(retry.history).toEqual([]);
  expect(f.chat.listMessages(f.session.id).filter((message) => message.role === 'user')).toHaveLength(1);
  await f.chat.updateMessage(f.message.id, { content: 'Done', status: 'complete', errorCode: null });
  expect(() => f.chat.retryContext(f.message.id)).toThrow('interrupted');
});

it('guards completed desktop replies and marks control-only output as failed', async () => {
  const f = await fixture();
  f.writer.append('[mood:happy] 正文[sticker:none]。');
  expect(await f.writer.finish('complete')).toMatchObject({ content: '正文。', status: 'complete' });
  const empty = await fixture();
  empty.writer.append('[sticker:none] [mood:happy]');
  expect(await empty.writer.finish('complete')).toMatchObject({ content: '', status: 'failed', errorCode: 'chat.runFailed' });
});
