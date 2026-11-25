import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PersistentState } from './schemas';

const key = z.string().min(1).max(128);
const date = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const RECENT_WINDOW_MS = 36 * 60 * 60_000;
export const RECENT_TEXT_LIMIT = 800;
export const RECENT_ENTRY_LIMIT = 64;

type RecentContextState = Pick<PersistentState, 'chatSessions' | 'chatMessages' | 'companionRecent' | 'memoryTombstones'>;

type Superseded = 'deleted' | 'corrected';
const worse = (left: Superseded | undefined, right: Superseded | undefined): Superseded | undefined =>
  left === 'deleted' || right === 'deleted' ? 'deleted' : left ?? right;

/**
 * Chat messages that speak for a memory the owner later deleted or corrected: a message a memory was
 * taken from, a remember/correct/forget request whose memory has since changed, and the reply right
 * after each. Chat history keeps them; summaries that are fed into new conversations must not.
 */
export function supersededChat(state: Pick<PersistentState, 'chatMessages' | 'memoryTombstones'>): ReadonlyMap<string, Superseded> {
  const result = new Map<string, Superseded>();
  if (!state.memoryTombstones.length) return result;
  const byEvidence = new Map<string, Superseded>(), byMemory = new Map<string, Superseded>();
  for (const guard of state.memoryTombstones) {
    byMemory.set(guard.memoryId, worse(byMemory.get(guard.memoryId), guard.kind)!);
    for (const source of guard.sourceEventIds) byEvidence.set(source, worse(byEvidence.get(source), guard.kind)!);
  }
  const mark = (id: string, kind: Superseded | undefined): void => { const next = worse(result.get(id), kind); if (next) result.set(id, next); };
  // What a reply's memory request touched, including the candidates it offered (a backup may predate the choice).
  const outcome = (message: PersistentState['chatMessages'][number]): Superseded | undefined => {
    const ids = [message.memoryReceipts?.[0]?.memoryId,
      ...(message.memoryForget?.kind === 'deleted' ? [message.memoryForget.memoryId] : message.memoryForget?.kind === 'choices' ? message.memoryForget.candidates.map(item => item.id) : []),
      ...(message.memoryEdit?.kind === 'updated' ? [message.memoryEdit.memoryId] : message.memoryEdit?.kind === 'choices' ? message.memoryEdit.candidates.map(item => item.id) : [])];
    return ids.reduce<Superseded | undefined>((kind, id) => worse(kind, id === undefined ? undefined : byMemory.get(id)), undefined);
  };
  // A request is every user message since the previous reply (follow-ups sit before the reply they join).
  const requests = new Map<string, { ids: string[]; kind: Superseded | undefined }>();
  for (const message of state.chatMessages) {
    if (message.role === 'user') {
      // Matches the chat evidence ID that memory-commit records for a chat-sourced memory.
      const kind = byEvidence.get(recentDigest(`chat:${message.sessionId}:${message.id}`));
      mark(message.id, kind);
      const request = requests.get(message.sessionId) ?? { ids: [], kind: undefined };
      request.ids.push(message.id); request.kind = worse(request.kind, kind);
      requests.set(message.sessionId, request);
    } else if (message.role === 'assistant') {
      const request = requests.get(message.sessionId), result = outcome(message);
      requests.delete(message.sessionId);
      if (request && result) for (const id of request.ids) mark(id, result);
      mark(message.id, worse(request?.kind, result));
    }
  }
  return result;
}

const common = { id: key, at: date };
const entry = z.discriminatedUnion('source', [
  z.strictObject({ ...common, source: z.enum(['desktop', 'qq', 'wechat']), sessionId: key, sha: hash }),
  z.strictObject({ ...common, source: z.literal('minecraft'), text: z.string().min(1).max(800) }),
]);

const summarySchema = z.strictObject({
  text: z.string().max(RECENT_TEXT_LIMIT * 2),
  revision: hash,
  updatedAt: date,
  refs: z.array(key).min(1).max(RECENT_ENTRY_LIMIT),
  localOnly: z.boolean(),
});

export const companionRecentSchema = z.strictObject({
  entries: z.array(entry).max(RECENT_ENTRY_LIMIT),
  localOnly: z.boolean(),
  clearedAt: date.nullable(),
  summary: summarySchema.nullable(),
  sharedSummary: summarySchema.nullable().default(null),
});
export type CompanionRecentState = z.infer<typeof companionRecentSchema>;

export const defaultCompanionRecent = (): CompanionRecentState => ({
  entries: [], localOnly: false, clearedAt: null, summary: null, sharedSummary: null,
});

export const recentDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

interface RecentSource {
  id: string;
  source: CompanionRecentState['entries'][number]['source'];
  text: string;
  localOnly: boolean;
}

export function recentSources(state: RecentContextState, now: number): RecentSource[] {
  const sessions = new Map(state.chatSessions.map(session => [session.id, session]));
  const messages = new Map(state.chatMessages.map(message => [message.id, message]));
  const clearedAt = Date.parse(state.companionRecent.clearedAt ?? '');
  const superseded = supersededChat(state);
  return state.companionRecent.entries.flatMap<RecentSource>(entry => {
    const at = Date.parse(entry.at);
    if (at > now || at <= now - RECENT_WINDOW_MS || at <= clearedAt) return [];
    if (entry.source === 'minecraft') return [{ id: entry.id, source: entry.source, text: entry.text, localOnly: true }];
    const session = sessions.get(entry.sessionId), message = messages.get(entry.id);
    if (!session || session.deletedAt || session.archivedAt || session.analysisSource || session.companionScope === 'group'
      || session.wechatTranscript === 'group' || session.wechatTranscript === 'friend'
      || !message || message.sessionId !== session.id || message.role !== 'user' || message.status !== 'complete'
      || message.automationTriggerId || message.wechatFriend || message.wechatDigest || recentDigest(message.content) !== entry.sha
      || superseded.has(message.id)) return [];
    return [{ id: entry.id, source: entry.source, text: message.content,
      localOnly: session.historyPrivacy === 'local-only' || message.contextTrace?.privacy === 'local-only' }];
  });
}

function validateSummary(state: RecentContextState, summary: CompanionRecentState['summary'], now: number) {
  if (!summary) return null;
  const current = new Map(recentSources(state, now).map(source => [source.id, source]));
  if (summary.refs.some(id => !current.has(id))) return null;
  const restricted = state.companionRecent.localOnly || summary.refs.some(id => current.get(id)?.localOnly);
  // A restriction changed after summarization. Invalidate the original version
  // so replies that used it cannot carry it into a later provider request.
  if (restricted && !summary.localOnly) return null;
  return summary;
}

export function currentRecent(state: RecentContextState, now = Date.now()) {
  return validateSummary(state, state.companionRecent.summary, now);
}

/** When the full summary contains local material, a cloud request only sees
 * an independent projection produced from the shareable source messages. */
export function recentForDestination(state: RecentContextState, destination: string, now = Date.now()) {
  const summary = currentRecent(state, now);
  if (destination === 'local') return summary;
  if (state.companionRecent.localOnly) return null;
  return summary && !summary.localOnly
    ? summary : validateSummary(state, state.companionRecent.sharedSummary, now);
}

export const recentTraceAllowed = (state: Omit<RecentContextState, 'companionRecent'> & Partial<Pick<RecentContextState, 'companionRecent'>>,
  revision: string, destination: string): boolean => {
  const { companionRecent, chatSessions, chatMessages, memoryTombstones } = state;
  return companionRecent !== undefined && recentForDestination({ companionRecent, chatSessions, chatMessages, memoryTombstones }, destination)?.revision === revision;
};
