import { createHash } from 'node:crypto';
import type { ContextTrace, MemoryItem } from '../../shared';
import type { PersistentState } from '../domain/schemas';
import { recentTraceAllowed } from '../domain/companion-recent-state';

type DiaryReference = NonNullable<ContextTrace['diaryReferences']>[number];

/** A memory enters QQ context only when host-confirmed, global, cloud-allowed
 * and explicitly opted in for QQ by the owner. No existing memory qualifies
 * until the owner marks it, so a fresh QQ binding starts with zero memories.
 * Unverified, imported, session-scoped, expired or private facts stay out. */
const sharedMemoryAllowed = (memory: MemoryItem, channel: 'qq' | 'telegram'): boolean => {
  const metadata = memory.contextMetadata;
  return metadata !== undefined && metadata.version === 1 && metadata.trust === 'host-confirmed'
    && metadata.scope.kind === 'global' && metadata.privacy === 'cloud-allowed' && (channel === 'qq' ? metadata.qqAllowed : metadata.telegramAllowed) === true
    && (metadata.expiresAt == null || Date.parse(metadata.expiresAt) > Date.now());
};

export const qqMemoryAllowed = (memory: MemoryItem): boolean => sharedMemoryAllowed(memory, 'qq');
export const telegramMemoryAllowed = (memory: MemoryItem): boolean => sharedMemoryAllowed(memory, 'telegram');

/** QQ delivery is a distinct disclosure destination from "cloud-allowed model
 * transport". A completed turn that touched local-only material, or one whose
 * verified context trace is missing, must never be delivered to QQ. */
const assertChannelDisclosure = (
  channel: 'qq' | 'telegram',
  approvedLocalResult: boolean,
  memoryEnabled: boolean,
  message: { contextTrace?: ContextTrace | undefined },
  state?: DisclosureState,
  sessionId?: string,
  suppressed: (id: string) => boolean = () => false,
  knowledgePolicyToken?: string | null,
  qqOwnerDiaryCurrent?: (reference: DiaryReference) => boolean,
): void => {
  const blocked = (): never => { throw new Error(`${channel}.disclosureBlocked`); };
  const checked = new Set<string>(), checking = new Set<string>();
  const session = state?.chatSessions.find(item => item.id === sessionId);
  const allowedRecent = new Set<string>();
  const check = (trace: ContextTrace | undefined): void => {
    if (!trace || trace.version !== 1 || trace.lineage !== 'complete' || (!approvedLocalResult && trace.privacy !== 'cloud-allowed')
      || (trace.knowledgePolicyToken !== undefined && (trace.knowledgePolicyToken !== knowledgePolicyToken || trace.privacy === 'local-only'))
      || trace.diaryReferences?.some(ref => channel !== 'qq' || !state || !sessionId || qqOwnerDiaryCurrent?.(ref) !== true)
      || trace.representationReferences?.length || (channel === 'qq' && trace.historyLookupReferences?.length)) blocked();
    const revision = trace!.recentRevision;
    if (revision !== undefined && !allowedRecent.has(revision)) {
      if (!state || channel !== 'qq' || session?.companionScope !== 'owner' || !recentTraceAllowed(state, revision, 'remote')) blocked();
      allowedRecent.add(revision);
    }
    if (trace!.scope.kind === 'session' && sessionId !== undefined && trace!.scope.sessionId !== sessionId) blocked();
    if (!state) {
      // Without a current snapshot, only an empty lineage can be established.
      if (trace!.memoryReferences.length || trace!.historyMessageIds.length) blocked();
      return;
    }
    for (const reference of trace!.memoryReferences) {
      const memory = state.memories.find(item => item.id === reference.id);
      if (!memory || suppressed(memory.id) || !memoryEnabled || !sharedMemoryAllowed(memory, channel) || memory.contextMetadata?.revision !== reference.revision) blocked();
    }
    for (const reference of trace!.summaryReferences ?? []) {
      const source = state.chatMessages.find(item => item.id === reference.messageId);
      if (!source || !trace!.historyMessageIds.includes(source.id) || createHash('sha256').update(source.content).digest('hex') !== reference.contentSHA256) blocked();
    }
    const ancestors = new Set(trace!.historyMessageIds);
    for (const lookup of trace!.historyLookupReferences ?? []) {
      const source = state.chatMessages.find(item => item.id === lookup.messageId);
      if (channel !== 'telegram' || lookup.sessionId !== sessionId || !source || source.sessionId !== sessionId ||
        createHash('sha256').update(source.content).digest('hex') !== lookup.contentSHA256) blocked();
      ancestors.add(lookup.messageId);
    }
    for (const id of ancestors) {
      if (checked.has(id)) continue;
      if (checking.has(id) || checking.size >= 1_024) blocked();
      const ancestor = state.chatMessages.find(item => item.id === id);
      if (!ancestor || ancestor.sessionId !== sessionId || ancestor.status !== 'complete'
        || !['user', 'assistant'].includes(ancestor.role)) blocked();
      checking.add(id); check(ancestor!.contextTrace); checking.delete(id); checked.add(id);
    }
  };
  if (state) {
    if (!session || session.archivedAt || session.deletedAt || (!approvedLocalResult && session.historyPrivacy === 'local-only')) blocked();
  }
  check(message.contextTrace);
};

type DisclosureState = Pick<PersistentState, 'chatSessions' | 'chatMessages' | 'memories' | 'memoryTombstones'> & Partial<Pick<PersistentState, 'companionRecent'>>;
export const assertDeliverableToQq = (message: {contextTrace?: ContextTrace | undefined}, state?: DisclosureState,
  sessionId?: string, suppressed?: (id: string) => boolean, knowledgePolicyToken?: string | null,
  /** Only the live owner-private binding can supply a cloud-allowed, current diary reference verifier. */
  qqOwnerDiaryCurrent?: (reference: DiaryReference) => boolean): void =>
  assertChannelDisclosure('qq', false, true, message, state, sessionId, suppressed, knowledgePolicyToken, qqOwnerDiaryCurrent);

/** A single phone decision may release this result's local privacy label only.
 * Missing lineage and stale/revoked memory remain blocked on every send attempt. */
export const telegramResultNeedsApproval = (message: {contextTrace?: ContextTrace | undefined}, state: DisclosureState,
  sessionId: string, memoryEnabled: boolean, suppressed: (id: string) => boolean, knowledgePolicyToken?: string | null): boolean => {
  assertChannelDisclosure('telegram', true, memoryEnabled, message, state, sessionId, suppressed, knowledgePolicyToken);
  try {
    assertChannelDisclosure('telegram', false, memoryEnabled, message, state, sessionId, suppressed, knowledgePolicyToken);
    return false;
  } catch { return true; }
};
