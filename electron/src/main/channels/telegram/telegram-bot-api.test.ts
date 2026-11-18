// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { net } from 'electron';
import { expect, it, vi } from 'vitest';
import { TelegramBotApi } from './telegram-bot-api';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
it('accepts a send receipt for its exact recipient without bounding the platform IDs', async () => {
  const api = new TelegramBotApi(),
    chatId = '1'.repeat(900);
  vi.mocked(net.fetch).mockResolvedValueOnce(
    Response.json({ ok: true, result: { message_id: 'opaque' + 'x'.repeat(800), chat: { type: 'private', id: chatId } } }),
  );
  await expect(api.send(randomUUID(), chatId, 'hello', null, new AbortController().signal)).resolves.toBeUndefined();
});
it.each([
  { ok: true },
  { ok: true, result: { chat: { type: 'private', id: 42 } } },
  { ok: true, result: { message_id: 44, chat: { type: 'private', id: 43 } } },
])('treats an unusable successful response as ambiguous', async (envelope) => {
  vi.mocked(net.fetch).mockResolvedValueOnce(Response.json(envelope));
  await expect(new TelegramBotApi().send(randomUUID(), '42', 'hello', null, new AbortController().signal)).rejects.toMatchObject({
    code: 'telegram.unconfirmedReceipt',
    definitive: false,
  });
});
