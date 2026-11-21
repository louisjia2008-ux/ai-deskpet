import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PersistentState } from './schemas';

const key = z.string().min(1).max(128);
const date = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const RECENT_WINDOW_MS = 36 * 60 * 60_000;
export const RECENT_TEXT_LIMIT = 800;
export const RECENT_ENTRY_LIMIT = 64;

type RecentContextState = Pick<PersistentState, 'chatSessions' | 'chatMessages' | 'companionRecent'>;

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
  return state.companionRecent.entries.flatMap<RecentSource>(entry => {
    const at = Date.parse(entry.at);
    if (at > now || at <= now - RECENT_WINDOW_MS || at <= clearedAt) return [];
    if (entry.source === 'minecraft') return [{ id: entry.id, source: entry.source, text: entry.text, localOnly: true }];
    const session = sessions.get(entry.sessionId), message = messages.get(entry.id);
    if (!session || session.deletedAt || session.archivedAt || session.analysisSource || session.companionScope === 'group'
      || session.wechatTranscript === 'group' || session.wechatTranscript === 'friend'
      || !message || message.sessionId !== session.id || message.role !== 'user' || message.status !== 'complete'
      || message.automationTriggerId || message.wechatFriend || message.wechatDigest || recentDigest(message.content) !== entry.sha) return [];
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
  const { companionRecent, chatSessions, chatMessages } = state;
  return companionRecent !== undefined && recentForDestination({ companionRecent, chatSessions, chatMessages }, destination)?.revision === revision;
};
