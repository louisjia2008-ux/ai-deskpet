import { net } from 'electron';

type Row = Record<string, unknown>;
const row = (input: unknown): Row => (typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Row) : {});
const id = (input: unknown): string | null =>
  typeof input === 'string' && input.length > 0 ? input : Number.isSafeInteger(input) ? String(input) : null;

export type TelegramUpdate = { updateId: number } & (
  | { kind: 'message'; userId: string; chatId: string; name: string; text: string; noteIntentAllowed?: true }
  | { kind: 'callback'; userId: string; chatId: string; queryId: string; data: string }
  | { kind: 'rejected'; type: string; field: string }
);

const messageCarriesOwnerText = (message: Row): boolean => {
  // Reply/quote previews are separate fields. Only the sender's text enters the chat.
  const forwarded = ['forward_origin', 'forward_date', 'forward_from', 'forward_from_chat', 'forward_sender_name',
    'forward_from_message_id', 'is_automatic_forward'].some(key => Object.hasOwn(message, key));
  const quoted = Array.isArray(message.entities) && message.entities.some(entity => {
    const { type } = row(entity);
    return type === 'blockquote' || type === 'expandable_blockquote';
  });
  return !forwarded && !quoted;
};

/** Expose only locally chosen event and field names, never untrusted keys or payloads. */
export function parseTelegramUpdate(input: unknown): TelegramUpdate {
  const raw = row(input);
  const updateId = raw.update_id;
  if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId) || updateId < 0)
    throw new TelegramApiError('telegram.invalidUpdateId');
  const type = raw.callback_query ? 'callback_query' : raw.message ? 'message' : 'unsupported';
  const rejected = (field: string): TelegramUpdate => ({ updateId, kind: 'rejected', type, field });
  if (type === 'unsupported') return rejected('update.type');
  const callback = row(raw.callback_query);
  const message = row(type === 'message' ? raw.message : callback.message);
  const from = row(type === 'message' ? message.from : callback.from);
  const chat = row(message.chat);
  if (chat.type !== 'private') return rejected('chat.type');
  if (from.is_bot !== false) return rejected('from.is_bot');
  const userId = id(from.id),
    chatId = id(chat.id);
  if (!userId) return rejected('from.id');
  if (!chatId || userId !== chatId) return rejected('chat.id');
  if (type === 'message') {
    if (typeof message.text !== 'string' || !message.text.trim()) return rejected('message.text');
    return {
      kind: 'message',
      updateId,
      userId,
      chatId,
      text: message.text,
      ...(messageCarriesOwnerText(message) ? { noteIntentAllowed: true as const } : {}),
      name:
        [from.first_name, from.last_name]
          .filter((part): part is string => typeof part === 'string')
          .join(' ')
          .trim()
          .slice(0, 120) || userId,
    };
  }
  const queryId = id(callback.id);
  if (!queryId) return rejected('callback_query.id');
  if (typeof callback.data !== 'string') return rejected('callback_query.data');
  return { kind: 'callback', updateId, userId, chatId, queryId, data: callback.data };
}

export class TelegramApiError extends Error {
  constructor(
    readonly code: string,
    readonly definitive = false,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}

export interface TelegramApi {
  getMe(token: string, signal: AbortSignal): Promise<string>;
  poll(token: string, offset: number | null, signal: AbortSignal): Promise<TelegramUpdate[]>;
  send(token: string, chatId: string, content: string, buttons: { id: string } | null, signal: AbortSignal): Promise<void>;
  answer(token: string, queryId: string, signal: AbortSignal): Promise<void>;
}

export class TelegramBotApi implements TelegramApi {
  async #post(token: string, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!/^[a-zA-Z0-9:_-]+$/u.test(token)) throw new TelegramApiError('telegram.invalidCredential', true);
    signal.throwIfAborted();
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 38_000 : 15_000)]);
    try {
      const response = await net.fetch('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: callSignal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new TelegramApiError('telegram.invalidResponse');
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 4_194_304) throw new TelegramApiError('telegram.responseTooLarge');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const json = row(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (json.ok !== true || !response.ok) {
        const status =
          typeof json.error_code === 'number' && Number.isSafeInteger(json.error_code) ? json.error_code : response.status;
        const delay = row(json.parameters).retry_after;
        // Telegram's explicit 4xx rejection proves no message was accepted. A
        // gateway 5xx, malformed result or network failure leaves a POST uncertain.
        throw new TelegramApiError(
          'telegram.http' + status,
          json.ok === false && status >= 400 && status < 500,
          status === 429 && typeof delay === 'number' && Number.isFinite(delay)
            ? Math.min(86_400_000, Math.max(1000, delay * 1000))
            : 0,
        );
      }
      return json.result;
    } catch (error) {
      if (signal.aborted) throw new TelegramApiError('telegram.cancelled');
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError(callSignal.aborted ? 'telegram.timeout' : 'telegram.network');
    }
  }
  async getMe(token: string, signal: AbortSignal): Promise<string> {
    const bot = row(await this.#post(token, 'getMe', {}, signal)),
      botId = id(bot.id);
    if (!botId || bot.is_bot !== true) throw new TelegramApiError('telegram.invalidBot');
    return botId;
  }
  async poll(token: string, offset: number | null, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const updates = await this.#post(
      token,
      'getUpdates',
      { ...(offset === null ? {} : { offset }), timeout: 25, limit: 10, allowed_updates: ['message', 'callback_query'] },
      signal,
    );
    if (!Array.isArray(updates)) throw new TelegramApiError('telegram.invalidUpdates');
    return updates.map(parseTelegramUpdate);
  }
  async send(token: string, chatId: string, content: string, buttons: { id: string } | null, signal: AbortSignal): Promise<void> {
    const receipt = row(
      await this.#post(
        token,
        'sendMessage',
        {
          chat_id: chatId,
          text: content,
          link_preview_options: { is_disabled: true },
          ...(buttons
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '允许一次', callback_data: 'yes:' + buttons.id },
                      { text: '拒绝', callback_data: 'no:' + buttons.id },
                    ],
                  ],
                },
              }
            : {}),
        },
        signal,
      ),
    );
    // POST has already crossed the network. An inconsistent success envelope
    // is ambiguous, even if it carries HTTP 200; never replay it automatically.
    const sentId = id(receipt.message_id),
      chat = row(receipt.chat);
    if (
      !sentId?.trim() ||
      (typeof receipt.message_id === 'number' && receipt.message_id < 0) ||
      chat.type !== 'private' ||
      id(chat.id) !== chatId
    )
      throw new TelegramApiError('telegram.unconfirmedReceipt');
  }
  async answer(token: string, queryId: string, signal: AbortSignal): Promise<void> {
    await this.#post(token, 'answerCallbackQuery', { callback_query_id: queryId }, signal);
  }
}
