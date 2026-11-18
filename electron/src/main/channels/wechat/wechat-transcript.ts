import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatMessage } from '../../../shared';
import type { DomainRepository } from '../../domain/repository';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const title = z.string().min(1).max(360).refine(value => value.trim().length > 0 && [...value].length <= 180
  && !/[\p{Cc}\p{Bidi_Control}]/u.test(value));
const sender = z.string().min(1).max(160).refine(value => value.trim().length > 0 && [...value].length <= 80
  && !/[\p{Cc}\p{Bidi_Control}]/u.test(value));
const itemSchema = z.object({
  id: digest, binding: digest, scope: z.enum(['private', 'group', 'friend']), title,
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(1_000).refine(value => value.trim().length > 0 && [...value].length <= 500),
  at: z.number().min(0).max(253_402_300_799).nullable(),
  sender: sender.nullable().optional(),
  wechatDigest: z.literal(true).optional(),
  wechatFriend: z.literal(true).optional(),
}).strict().refine(value => (!value.wechatDigest || (value.role === 'assistant' && value.scope === 'private' && value.at !== null))
  && (value.scope === 'friend') === (value.wechatFriend === true));
const pageSchema = z.object({
  version: z.literal(1), entries: z.array(itemSchema).max(50), more: z.boolean(),
}).strict().refine(value => !value.more || value.entries.length > 0);
const ackSchema = z.object({ ok: z.literal(true) }).strict();

type Item = z.infer<typeof itemSchema>;
type Acknowledgement = { version: 1; entries: Array<Pick<Item, 'id' | 'role'>> };

const uuid = (namespace: string, identity: string): string => {
  const bytes = createHash('sha256').update(`deskpet/wechat/${namespace}/v1\0${identity}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const wechatSessionId = (binding: string): string => uuid('session', digest.parse(binding));
export const wechatChannelBindingId = (binding: string): string => uuid('binding', digest.parse(binding));
/** Candidate assistant conversations for one owner binding, in order. An
 * archived or deleted conversation gives way to the next candidate. */
export const wechatAssistantSessionIds = (binding: string): string[] =>
  Array.from({ length: 64 }, (_, index) => uuid('assistant-session', `${digest.parse(binding)}:${index}`));
const wechatMessageId = ({ id, binding, role }: Item): string => uuid('message', `${binding}:${id}:${role}`);

interface TranscriptSource {
  readTranscript(): Promise<unknown>;
  acknowledgeTranscript(input: Acknowledgement): Promise<unknown>;
}

interface TranscriptHost {
  available(): boolean;
  locale(): 'en' | 'zh-CN';
  changed(): void;
  /** Entries already recorded elsewhere (the assistant conversation) are acknowledged without import. */
  skip?(entry: { id: string; scope: Item['scope'] }): boolean;
}

export class WeChatTranscript {
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> | null = null;
  #stopped = false;

  constructor(
    private readonly repository: DomainRepository,
    private readonly source: TranscriptSource,
    private readonly host: TranscriptHost,
  ) {}

  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.sync().catch(() => undefined);
    this.#timer = setInterval(() => { void this.sync().catch(() => undefined); }, 5_000);
    this.#timer.unref();
  }

  dispose(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async drain(): Promise<void> { await this.#pending?.catch(() => undefined); }

  sync(): Promise<void> {
    if (!this.#available()) return Promise.resolve();
    this.#pending ??= this.#sync().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  #available(): boolean { return !this.#stopped && this.host.available(); }

  async #sync(): Promise<void> {
    for (let pageNumber = 0; pageNumber < 4 && this.#available(); pageNumber++) {
      const page = pageSchema.parse(await this.source.readTranscript());
      if (page.entries.length === 0 || !this.#available()) return;
      const importedAt = new Date().toISOString();
      const locale = this.host.locale();
      const changed = await this.repository.transaction(state => {
        if (!this.#available()) throw new Error('wechat.transcriptUnavailable');
        const sessions = new Map(state.chatSessions.map(session => [session.id, session]));
        const messages = new Map(state.chatMessages.map(message => [message.id, message]));
        let changed = false;
        for (const entry of page.entries) {
          if (this.host.skip?.(entry)) continue;
          const sessionId = wechatSessionId(entry.binding);
          const channelBindingId = wechatChannelBindingId(entry.binding);
          const id = wechatMessageId(entry);
          const existing = messages.get(id);
          const createdAt = entry.at === null ? importedAt : new Date(entry.at * 1_000).toISOString();
          let session = sessions.get(sessionId);
          if (session && (session.wechatTranscript !== entry.scope || session.channelBindingId !== channelBindingId)) {
            throw new Error('wechat.transcriptConflict');
          }
          if (existing) {
            if (existing.sessionId !== sessionId || existing.role !== entry.role || existing.content !== entry.text
              || existing.wechatDigest !== entry.wechatDigest || existing.wechatFriend !== entry.wechatFriend) {
              throw new Error('wechat.transcriptConflict');
            }
            continue;
          }
          if (!session) {
            const label = locale === 'zh-CN'
              ? (entry.scope === 'private' ? '微信私聊' : entry.scope === 'friend' ? '微信好友' : '微信群')
              : (entry.scope === 'private' ? 'WeChat direct' : entry.scope === 'friend' ? 'WeChat friend' : 'WeChat group');
            const labelWithTitle = `${label} · ${entry.title}`;
            session = { id: sessionId, channelBindingId, title: labelWithTitle.slice(0, 240).trim(), kind: 'normal',
              createdAt, updatedAt: createdAt, wechatTranscript: entry.scope, historyPrivacy: 'local-only' };
            sessions.set(sessionId, session);
            state.chatSessions.push(session);
          }
          const message: ChatMessage = { id, sessionId, role: entry.role, content: entry.text, createdAt, status: 'complete', errorCode: null };
          if (entry.role === 'user' && entry.sender) message.wechatSender = entry.sender;
          if (entry.wechatDigest) message.wechatDigest = entry.wechatDigest;
          if (entry.wechatFriend) message.wechatFriend = entry.wechatFriend;
          messages.set(id, message);
          state.chatMessages.push(message);
          if (createdAt > session.updatedAt) session.updatedAt = createdAt;
          changed = true;
        }
        return changed;
      });
      if (changed) this.host.changed();
      // If the helper exits before acknowledging, the next sync replays the same IDs.
      ackSchema.parse(await this.source.acknowledgeTranscript({ version: 1, entries: page.entries.map(({ id, role }) => ({ id, role })) }));
      if (!page.more) return;
    }
  }
}
