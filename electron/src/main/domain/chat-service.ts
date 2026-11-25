import { messageDigest } from './rolling-context';
import { chatImageAttachmentSchema } from '../../shared/media';
import type { ChatImageAttachment } from '../../shared/media';
import { consolidationDependenciesCurrent } from './consolidation-state';
import { randomUUID } from 'node:crypto';

import type { ChatMessage, ChatModelSelection, ChatRequestPreparation, ChatRequestReceipt, ChatSession, ChatSessionListOptions, ContextTrace, ProviderRequestObservation, TimerReceipt } from '../../shared';
import type { DomainRepository } from './repository';
import { chatRequestPreparationSchema, providerRequestObservationSchema } from './schemas';
import type { PersistentState } from './schemas';
import { isWeChatExcludedFromMemory, memoryInSession, sourceUserBefore } from './context-provenance';
import { createHistoryLookupResolver } from './chat-history-lineage';
import { memoDiaryHistory } from './chat-context-policy';

import { recentTraceAllowed } from './companion-recent-state';

const receiptConflict = (): never => { throw new Error('chat.contextReceiptConflict'); };
const sameJSON = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Validate the complete selected lineage again against the current committed snapshot. */
type DiaryReference = NonNullable<ContextTrace['diaryReferences']>[number];
interface DiaryValidation {
  current(reference: DiaryReference, state: PersistentState, destination: 'local' | 'remote'): boolean;
  retained(reference: DiaryReference, state: PersistentState): boolean;
}
const assertTraceCurrent = (state: PersistentState, sessionId: string, trace: ContextTrace, suppressed: ReadonlySet<string>, forbiddenHistory: ReadonlySet<string> = new Set(), diary?: DiaryValidation, knowledgeCurrent?: (token: string) => boolean, retained = false): void => {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session || session.deletedAt || session.archivedAt || trace.lineage !== 'complete') throw new Error('chat.contextStale');
  if (trace.scope.kind === 'session' && trace.scope.sessionId !== sessionId) throw new Error('chat.contextStale');
  const digestExpiry = Date.parse(trace.wechatDigestUntil ?? '');
  if (trace.wechatDigestUntil !== undefined && (trace.scope.kind !== 'session' || !(digestExpiry > Date.now()))) throw new Error('chat.contextStale');
  if (trace.historyMessageIds.length > 0 && session.historyPrivacy === 'local-only' && trace.privacy !== 'local-only') throw new Error('chat.contextStale');
  const references = new Map(trace.memoryReferences.map((reference) => [reference.id, reference.revision]));
  const destination = trace.privacy === 'local-only' ? 'local' : 'remote';
  const diaryRetained = memoDiaryHistory(reference => diary?.retained(reference, state) === true);
  const diaryCurrent = (reference: DiaryReference): boolean => diary?.current(reference, state, destination) === true;
  const lookup = createHistoryLookupResolver({ state, sessionId, destination, suppressed, forbidden: forbiddenHistory, diaryAllowed: diaryRetained });
  const assertReferences = (source: ContextTrace, diaryAllowed: (reference: DiaryReference) => boolean): void => {
    if (source.lineage !== 'complete' || (source.scope.kind === 'session' && source.scope.sessionId !== sessionId)) throw new Error('chat.contextStale');
    if (source.recentRevision !== undefined && (source.recentRevision !== trace.recentRevision
      || !recentTraceAllowed(state, source.recentRevision, destination))) throw new Error('chat.contextStale');
    if (source.knowledgePolicyToken !== undefined && (trace.knowledgePolicyToken !== source.knowledgePolicyToken
      || knowledgeCurrent?.(source.knowledgePolicyToken) !== true)) throw new Error('chat.contextStale');
    if (source.privacy === 'local-only' && trace.privacy !== 'local-only') throw new Error('chat.contextStale');
    if (source.scope.kind === 'session' && trace.scope.kind !== 'session') throw new Error('chat.contextStale');
    if (source.wechatDigestUntil !== undefined && !(digestExpiry <= Date.parse(source.wechatDigestUntil))) throw new Error('chat.contextStale');
    if ((source.historyLookupReferences ?? []).some((reference) => lookup(reference) === null)) throw new Error('chat.contextStale');
    if ((source.diaryReferences ?? []).some(reference => !diaryAllowed(reference))) throw new Error('chat.contextStale');
    for (const reference of source.summaryReferences ?? []) {
      const message = state.chatMessages.find(item => item.id === reference.messageId);
      if (!message || !source.historyMessageIds.includes(message.id) || message.sessionId !== sessionId || messageDigest(message.content) !== reference.contentSHA256) throw new Error('chat.contextStale');
    }
    for (const reference of source.representationReferences ?? []) {
      const batch = state.consolidationBatches.find((item) => item.id === reference.batchId);
      if (!batch || !batch.active || batch.status !== 'applied' || batch.candidateVersion !== reference.candidateVersion
        || !consolidationDependenciesCurrent(state, batch, trace.privacy === 'local-only' ? 'local' : 'remote', sessionId)) throw new Error('chat.contextStale');
    }
    for (const reference of source.memoryReferences) {
      const memory = state.memories.find((item) => item.id === reference.id);
      const metadata = memory?.contextMetadata;
      if (!memory || suppressed.has(memory.id) || !metadata || metadata.trust !== 'host-confirmed' || metadata.revision !== reference.revision
        || (metadata.expiresAt != null && Date.parse(metadata.expiresAt) <= Date.now())
        || references.get(reference.id) !== reference.revision || !memoryInSession(memory, sessionId)) throw new Error('chat.contextStale');
      if (metadata.privacy === 'local-only' && trace.privacy !== 'local-only') throw new Error('chat.contextStale');
      if (metadata.overridesMemory && (suppressed.has(metadata.overridesMemory.id)
        || state.memories.find((item) => item.id === metadata.overridesMemory!.id)?.contextMetadata?.revision !== metadata.overridesMemory.revision)) throw new Error('chat.contextStale');
      if (metadata.scope.kind === 'session' && trace.scope.kind !== 'session') throw new Error('chat.contextStale');
    }
  };
  assertReferences(trace, retained ? diaryRetained : diaryCurrent);
  const checked = new Set<string>(), checking = new Set<string>();
  const assertAncestor = (id: string): void => {
    if (forbiddenHistory.has(id)) throw new Error('chat.contextStale');
    if (checked.has(id)) return;
    if (checking.has(id)) throw new Error('chat.contextStale');
    const message = state.chatMessages.find((item) => item.id === id);
    if (!message || message.wechatDigest === true || message.wechatFriend === true || message.sessionId !== sessionId || message.status !== 'complete'
      || (message.role !== 'user' && message.role !== 'assistant') || !message.contextTrace) throw new Error('chat.contextStale');
    checking.add(id); assertReferences(message.contextTrace, diaryRetained);
    for (const ancestor of message.contextTrace.historyMessageIds) assertAncestor(ancestor);
    checking.delete(id); checked.add(id);
  };
  for (const id of trace.historyMessageIds) assertAncestor(id);
};

export class ChatService {
  readonly #activeSessions = new Set<string>();
  readonly #suppressedMessages = new Set<string>();
  suppressMessage(id: string): void { this.#suppressedMessages.add(id); }

  constructor(private readonly repository: DomainRepository, private readonly diary?: DiaryValidation, private readonly knowledgeCurrent?: (token: string) => boolean) {}

  listSessions({ scope = 'active', query = '' }: ChatSessionListOptions = {}): ChatSession[] {
    const state = this.repository.snapshot();
    const search = query.trim().toLocaleLowerCase();
    const matchingMessages = search.length === 0 ? new Set<string>() : new Set(state.chatMessages
      .filter((message) => !this.#suppressedMessages.has(message.id) && (message.automationTriggerId === undefined || state.automationTriggers.some((t) => t.id === message.automationTriggerId && t.status === 'succeeded' && t.publishedAt != null)) && (message.role === 'user' || message.role === 'assistant') && message.content.toLocaleLowerCase().includes(search))
      .map((message) => message.sessionId));
    return state.chatSessions.filter((session) => {
      if (scope === 'deleted') return Boolean(session.deletedAt);
      if (session.deletedAt) return false;
      if (scope === 'all') return true;
      return scope === 'archived' ? Boolean(session.archivedAt) : !session.archivedAt;
    }).filter((session) => search.length === 0 || session.title.toLocaleLowerCase().includes(search) || matchingMessages.has(session.id))
      .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '') || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  listMessages(sessionId: string): ChatMessage[] {
    const state = this.repository.snapshot();
    const session = state.chatSessions.find((item) => item.id === sessionId);
    if (session === undefined || session.deletedAt) throw new Error('chat.sessionUnavailable');
    return state.chatMessages.filter((message) => message.sessionId === sessionId && !this.#suppressedMessages.has(message.id)
      && (message.automationTriggerId === undefined || state.automationTriggers.some((t) => t.id === message.automationTriggerId && t.status === 'succeeded' && t.publishedAt != null)));
  }

  /** Reserve before provider setup awaits, so management cannot race a starting turn. */
  beginTurn(sessionId: string): () => void {
    const state = this.repository.snapshot();
    const session = state.chatSessions.find((item) => item.id === sessionId);
    if (session === undefined || session.deletedAt || session.archivedAt || session.wechatTranscript) throw new Error('chat.sessionUnavailable');
    if (this.#activeSessions.has(sessionId) || state.chatMessages.some((message) => message.sessionId === sessionId && message.status === 'streaming')) throw new Error('chat.sessionBusy');
    this.#activeSessions.add(sessionId);
    let released = false;
    return () => { if (!released) { released = true; this.#activeSessions.delete(sessionId); } };
  }

  async #changeSession(id: string, update: (session: ChatSession) => void, allowDeleted = false): Promise<ChatSession> {
    return this.repository.transaction((state) => {
      const session = state.chatSessions.find((item) => item.id === id);
      if (session === undefined || (session.deletedAt && !allowDeleted)) throw new Error('chat.sessionUnavailable');
      if (this.#activeSessions.has(id) || state.chatMessages.some((message) => message.sessionId === id && message.status === 'streaming')) throw new Error('chat.sessionBusy');
      update(session);
      return structuredClone(session);
    });
  }

  /** Upgrade only the original QQ group titles from a matching host-owned binding. */
  async migrateQqGroupTitles(groups: ReadonlyArray<{ sessionId: string; bindingId: string; title: string }>): Promise<void> {
    await this.repository.transaction(state => {
      for (const group of groups) {
        const session = state.chatSessions.find(item => item.id === group.sessionId && item.channelBindingId === group.bindingId);
        if (session?.title === 'QQ') session.title = group.title;
      }
    });
  }

  renameSession(id: string, title: string): Promise<ChatSession> {
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > 240) return Promise.reject(new Error('chat.invalidTitle'));
    return this.#changeSession(id, (session) => { session.title = trimmed; });
  }

  setPinned(id: string, pinned: boolean, now = new Date()): Promise<ChatSession> {
    return this.#changeSession(id, (session) => {
      if (session.archivedAt) throw new Error('chat.sessionUnavailable');
      session.pinnedAt = pinned ? session.pinnedAt ?? now.toISOString() : null;
    });
  }

  setArchived(id: string, archived: boolean, now = new Date()): Promise<ChatSession> {
    return this.#changeSession(id, (session) => {
      session.archivedAt = archived ? session.archivedAt ?? now.toISOString() : null;
      if (archived) session.pinnedAt = null;
    });
  }

  removeSession(id: string, now = new Date()): Promise<ChatSession> {
    return this.#changeSession(id, (session) => {
      session.deletedAt = session.deletedAt ?? now.toISOString();
      session.pinnedAt = null;
    }, true);
  }

  restoreSession(id: string): Promise<ChatSession> {
    return this.#changeSession(id, (session) => {
      session.deletedAt = null;
      session.archivedAt = null;
      session.pinnedAt = null;
    }, true);
  }

  retryContext(messageId: string): { message: ChatMessage; content: string; original: string; history: ChatMessage[]; userMessageIds: string[] } {
    const all = this.repository.snapshot().chatMessages;
    const message = all.find((item) => item.id === messageId);
    if (message?.role !== 'assistant' || (message.status !== 'failed' && message.status !== 'cancelled')) throw new Error('Retry requires an interrupted assistant reply.');
    const target = this.repository.snapshot().chatSessions.find((item) => item.id === message.sessionId);
    if (target === undefined || target.archivedAt || target.deletedAt) throw new Error('chat.sessionUnavailable');
    const session = all.filter((item) => item.sessionId === message.sessionId);
    const before = session.slice(0, session.findIndex((item) => item.id === messageId));
    let userIndex = before.length - 1;
    while (userIndex >= 0 && (before[userIndex]?.role !== 'user' || before[userIndex]?.followupToMessageId !== undefined)) userIndex -= 1;
    const user = before[userIndex];
    if (user === undefined) throw new Error('The original question is unavailable.');
    const additions = before.slice(userIndex + 1).filter((item) => item.followupToMessageId === message.id && item.role === 'user');
    if ([message, user, ...additions].some(item => isWeChatExcludedFromMemory(item)
      || (item.contextTrace?.knowledgePolicyToken !== undefined && this.knowledgeCurrent?.(item.contextTrace.knowledgePolicyToken) !== true))) throw new Error('chat.contextStale');
    const content = additions.length === 0 ? user.content : `${user.content}\n\nAdditional user requirements for this same task:\n${additions.map((item) => item.content).join('\n\n')}`;
    return { message, content, original: user.content, history: before.slice(0, userIndex), userMessageIds: [user.id, ...additions.map((item) => item.id)] };
  }

  async createSession(title: string, kind: ChatSession['kind'], now = new Date(), channelBindingId?: string, modelSelection?: ChatModelSelection): Promise<ChatSession> {
    const session: ChatSession = { id: randomUUID(), title, kind, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      ...(channelBindingId === undefined ? {} : { channelBindingId }), ...(modelSelection ? { modelSelection } : {}) };
    await this.repository.transaction((state) => state.chatSessions.push(session));
    return session;
  }

  /** The first candidate that is open, or a new owner conversation at the first
   * unused candidate. Channel-bound, transcript, archived and deleted ones are skipped. */
  async ensureSession(candidates: readonly string[], title: string, now = new Date()): Promise<ChatSession> {
    return this.repository.transaction((state) => {
      for (const id of candidates) {
        const existing = state.chatSessions.find((item) => item.id === id);
        if (!existing) {
          const session: ChatSession = { id, title, kind: 'normal', createdAt: now.toISOString(), updatedAt: now.toISOString(),
            historyPrivacy: 'cloud-allowed' };
          state.chatSessions.push(session);
          return structuredClone(session);
        }
        if (!existing.deletedAt && !existing.archivedAt && !existing.wechatTranscript && existing.channelBindingId === undefined
          && existing.kind === 'normal' && !existing.analysisSource) return structuredClone(existing);
      }
      throw new Error('chat.sessionUnavailable');
    });
  }

  async addMessage(
    input: Pick<ChatMessage, 'sessionId' | 'role' | 'content' | 'status' | 'errorCode' | 'attachments' | 'companionSource'>,
    now = new Date(),
  ): Promise<ChatMessage> {
    const message: ChatMessage = { id: randomUUID(), createdAt: now.toISOString(), ...input };
    await this.repository.transaction((state) => {
      const session = state.chatSessions.find((item) => item.id === input.sessionId);
      if (session === undefined || session.deletedAt || session.archivedAt || session.wechatTranscript) {
        throw new Error('Chat session does not exist.');
      }
      session.updatedAt = now.toISOString();
      message.memoryBaseRevision = state.memoryRevision;
      if (input.role === 'user') {
        message.contextTrace = { version: 1, memoryReferences: [], historyMessageIds: [],
          privacy: session.historyPrivacy ?? 'cloud-allowed', scope: { kind: 'session', sessionId: session.id }, lineage: 'complete' };
      }
      state.chatMessages.push(message);
    });
    return message;
  }

  async updateMessage(id: string, patch: Pick<ChatMessage, 'content' | 'status' | 'errorCode'>): Promise<ChatMessage> {
    return this.repository.transaction((state) => {
      const message = state.chatMessages.find((item) => item.id === id);
      if (message === undefined) {
        throw new Error('Chat message does not exist.');
      }
      Object.assign(message, patch);
      return structuredClone(message);
    });
  }

  async attachImage(id: string, attachment: ChatImageAttachment, assertCurrent: () => void = () => undefined, stickerOnly = false): Promise<ChatMessage> {
    const parsed = chatImageAttachmentSchema.parse(attachment);
    return this.repository.transaction(state => {
      assertCurrent();
      const message = state.chatMessages.find(item => item.id === id);
      const owner = state.chatSessions.find(item => item.id === message?.sessionId);
      if (!message || message.status !== 'complete' || !owner || owner.deletedAt || owner.archivedAt) throw new Error('chat.sessionUnavailable');
      if (stickerOnly) {
        if (message.role !== 'assistant' || !owner.channelBindingId || !message.content.trim()) throw new Error('chat.sessionUnavailable');
        message.content = '';
      }
      message.attachments = [parsed];
      return structuredClone(message);
    });
  }

  /** Persist an idempotent addition before acknowledging it to the composer. */
  async addFollowup(assistantId: string, operationId: string, content: string, assertAccepting: () => void, now = new Date()): Promise<ChatMessage> {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 8_000) throw new Error('chat.followupLimit');
    return this.repository.transaction((state) => {
      const existing = state.chatMessages.find((item) => item.id === operationId);
      if (existing) {
        if (existing.role !== 'user' || existing.followupToMessageId !== assistantId || existing.content !== trimmed) throw new Error('chat.followupConflict');
        return structuredClone(existing);
      }
      assertAccepting();
      const index = state.chatMessages.findIndex((item) => item.id === assistantId && item.role === 'assistant' && item.status === 'streaming');
      const assistant = state.chatMessages[index];
      const session = state.chatSessions.find((item) => item.id === assistant?.sessionId);
      if (index < 0 || !assistant || !session || session.archivedAt || session.deletedAt) throw new Error('chat.followupUnavailable');
      const additions = state.chatMessages.filter((item) => item.followupToMessageId === assistantId);
      if (additions.length >= 8 || additions.reduce((total, item) => total + item.content.length, 0) + trimmed.length > 32_000) throw new Error('chat.followupLimit');
      const message: ChatMessage = {
        id: operationId, sessionId: session.id, role: 'user', content: trimmed, status: 'complete', errorCode: null,
        createdAt: now.toISOString(), followupToMessageId: assistantId, memoryBaseRevision: state.memoryRevision,
        contextTrace: { version: 1, memoryReferences: [], historyMessageIds: [], privacy: session.historyPrivacy ?? 'cloud-allowed', scope: { kind: 'session', sessionId: session.id }, lineage: 'complete' },
      };
      // Conversation order remains user requirements followed by the answer.
      state.chatMessages.splice(index, 0, message);
      session.updatedAt = now.toISOString();
      return structuredClone(message);
    });
  }

  /** Provenance for deterministic host replies only; this is not an HTTP usage receipt. */
  async stampHostReply(assistantMessageId: string): Promise<void> {
    await this.repository.transaction((state) => {
      const assistant = state.chatMessages.find((message) => message.id === assistantMessageId && message.role === 'assistant');
      if (!assistant) throw new Error('chat.contextStale');
      if (assistant.contextTrace) return;
      const session = state.chatSessions.find((item) => item.id === assistant.sessionId);
      if (!session || session.deletedAt || session.archivedAt) throw new Error('chat.contextStale');
      const source = sourceUserBefore(state, assistant);
      const sourceTrace = source?.contextTrace;
      let valid = sourceTrace?.lineage === 'complete';
      if (valid && sourceTrace) {
        try { assertTraceCurrent(state, assistant.sessionId, sourceTrace, this.repository.memoryRecallSuppressionIds(), undefined, this.diary, this.knowledgeCurrent, true); }
        catch { valid = false; }
        if (sourceTrace.historyMessageIds.includes(assistant.id) || sourceTrace.historyMessageIds.includes(source!.id)) valid = false;
      }
      assistant.contextTrace = valid && source && sourceTrace
        ? { ...structuredClone(sourceTrace), historyMessageIds: [...new Set([source.id, ...sourceTrace.historyMessageIds])],
          privacy: session.historyPrivacy === 'local-only' ? 'local-only' : sourceTrace.privacy }
        : { version: 1, memoryReferences: [], historyMessageIds: source ? [source.id] : [], privacy: 'local-only',
          scope: { kind: 'session', sessionId: assistant.sessionId }, lineage: 'unknown' };
      if (assistant.contextTrace.privacy === 'local-only') session.historyPrivacy = 'local-only';
    });
  }

  /** Persist intent and taint before any utility request. A failed write must mean zero HTTP. */
  async prepareRequest(assistantMessageId: string, input: ChatRequestPreparation, now = new Date()): Promise<ChatRequestReceipt> {
    const preparation = chatRequestPreparationSchema.parse(input);
    return this.repository.transaction((state) => {
      const assistant = state.chatMessages.find((message) => message.id === assistantMessageId && message.role === 'assistant');
      if (!assistant || assistant.status !== 'streaming') throw new Error('chat.contextStale');
      const existingOwner = state.chatMessages.find((message) => message.requestReceipts?.some((receipt) => receipt.requestId === preparation.requestId));
      const existing = existingOwner?.requestReceipts?.find((receipt) => receipt.requestId === preparation.requestId);
      const legacyUser = preparation.userMessageId === undefined ? sourceUserBefore(state, assistant)
        : state.chatMessages.find((message) => message.id === preparation.userMessageId);
      const users = preparation.userMessageIds === undefined ? legacyUser ? [legacyUser] : []
        : preparation.userMessageIds.map((id) => {
          const user = state.chatMessages.find((message) => message.id === id);
          if (!user) throw new Error('chat.contextStale');
          return user;
        });
      if (users.some((user) => user.role !== 'user' || user.status !== 'complete' || user.sessionId !== assistant.sessionId
        || state.chatMessages.indexOf(user) >= state.chatMessages.indexOf(assistant))) throw new Error('chat.contextStale');
      if (preparation.userMessageId !== undefined && !legacyUser) throw new Error('chat.contextStale');
      if (preparation.userMessageIds !== undefined) {
        const before = state.chatMessages.slice(0, state.chatMessages.indexOf(assistant)).filter((message) => message.sessionId === assistant.sessionId);
        let start = before.length;
        while (start > 0 && before[start - 1]!.role !== 'assistant') start -= 1;
        let originalIndex = before.length - 1;
        while (originalIndex >= start && (before[originalIndex]!.role !== 'user' || before[originalIndex]!.followupToMessageId !== undefined)) originalIndex -= 1;
        const original = originalIndex >= start ? before[originalIndex] : undefined;
        // Older interrupted writes may leave an orphaned user before this
        // question. Only the latest original and its later additions belong.
        const turn = before.slice(Math.max(start, originalIndex));
        const selected = new Set(preparation.userMessageIds);
        if (!original || users[0]?.id !== original.id
          || users.some((user) => user.id !== original.id && user.followupToMessageId !== assistant.id)
          || !sameJSON(turn.filter((message) => selected.has(message.id)).map((message) => message.id), preparation.userMessageIds)
          || (preparation.userMessageId !== undefined && preparation.userMessageId !== users.at(-1)?.id)) throw new Error('chat.contextStale');
      }
      const forbiddenHistory = new Set([assistant.id, ...users.map((user) => user.id)]);
      if (preparation.contextTrace.historyMessageIds.some((id) => forbiddenHistory.has(id))) throw new Error('chat.contextStale');
      const frozen = { requestId: preparation.requestId, ...(preparation.runId === undefined ? {} : { runId: preparation.runId }), bindingDigest: preparation.bindingDigest,
        expectedBodySHA256: preparation.expectedBodySHA256, inputEstimate: preparation.inputEstimate,
        maxInputTokens: preparation.maxInputTokens, maxOutputTokens: preparation.maxOutputTokens,
        capacitySource: preparation.capacitySource, contextTrace: preparation.contextTrace,
        ...(preparation.contextBinding === undefined ? {} : { contextBinding: preparation.contextBinding }),
        ...(preparation.excludedContext === undefined ? {} : { excludedContext: preparation.excludedContext }),
        userMessageId: users.at(-1)?.id ?? null,
        ...(preparation.userMessageIds === undefined ? {} : { userMessageIds: preparation.userMessageIds }) };
      if (existing) {
        const { preparedAt: _preparedAt, phase: _phase, observations: _observations, sentCountRecorded: _sentCountRecorded, ...accepted } = existing;
        void _preparedAt; void _phase; void _observations; void _sentCountRecorded;
        if (existingOwner?.id !== assistant.id || !sameJSON(accepted, frozen)) return receiptConflict();
        assertTraceCurrent(state, assistant.sessionId, existing.contextTrace, this.repository.memoryRecallSuppressionIds(), forbiddenHistory, this.diary, this.knowledgeCurrent);
        return structuredClone(existing);
      }
      assertTraceCurrent(state, assistant.sessionId, preparation.contextTrace, this.repository.memoryRecallSuppressionIds(), forbiddenHistory, this.diary, this.knowledgeCurrent);
      const continuationHistory = new Set(preparation.contextTrace.historyMessageIds);
      const currentReferences = new Map(preparation.contextTrace.memoryReferences.map((reference) => [reference.id, reference.revision]));
      const currentSummaries = new Map((preparation.contextTrace.summaryReferences ?? []).map(ref => [ref.messageId, ref.contentSHA256]));
      const currentLookups = new Map((preparation.contextTrace.historyLookupReferences ?? []).map((reference) => [reference.messageId, reference]));
      const currentDiaries = new Map((preparation.contextTrace.diaryReferences ?? []).map(reference => [reference.date, reference]));
      for (const prior of assistant.requestReceipts ?? []) {
        if (prior.runId !== preparation.runId) continue;
        if (preparation.userMessageIds !== undefined && prior.userMessageIds?.some((id) => !preparation.userMessageIds!.includes(id))) throw new Error('chat.contextStale');
        if ((prior.contextTrace.summaryReferences ?? []).some(ref => currentSummaries.get(ref.messageId) !== ref.contentSHA256)) throw new Error('chat.contextStale');
        if ((prior.contextTrace.historyLookupReferences ?? []).some((reference) => !sameJSON(currentLookups.get(reference.messageId), reference))) throw new Error('chat.contextStale');
        if (prior.contextTrace.recentRevision !== undefined && prior.contextTrace.recentRevision !== preparation.contextTrace.recentRevision) throw new Error('chat.contextStale');
        if (prior.contextTrace.knowledgePolicyToken !== undefined &&
          preparation.contextTrace.knowledgePolicyToken !== prior.contextTrace.knowledgePolicyToken) throw new Error('chat.contextStale');
        if ((prior.contextTrace.diaryReferences ?? []).some(reference => !sameJSON(currentDiaries.get(reference.date), reference))) throw new Error('chat.contextStale');
        if (prior.contextTrace.wechatDigestUntil !== undefined &&
          !(Date.parse(preparation.contextTrace.wechatDigestUntil ?? '') <= Date.parse(prior.contextTrace.wechatDigestUntil))) throw new Error('chat.contextStale');
        if (prior.contextTrace.memoryReferences.some((reference) => currentReferences.get(reference.id) !== reference.revision)
          || (prior.contextTrace.privacy === 'local-only' && preparation.contextTrace.privacy !== 'local-only')
          || (prior.contextTrace.scope.kind === 'session' && (preparation.contextTrace.scope.kind !== 'session'
            || preparation.contextTrace.scope.sessionId !== prior.contextTrace.scope.sessionId))) throw new Error('chat.contextStale');
        // The next round still contains derived tool calls/results and the final
        // visible reply may contain earlier text. Do not wash away that lineage.
        assertTraceCurrent(state, assistant.sessionId, { ...preparation.contextTrace, historyMessageIds: prior.contextTrace.historyMessageIds, summaryReferences: prior.contextTrace.summaryReferences }, this.repository.memoryRecallSuppressionIds(), forbiddenHistory, this.diary, this.knowledgeCurrent);
        for (const id of prior.contextTrace.historyMessageIds) continuationHistory.add(id);
      }
      const receipt: ChatRequestReceipt = { ...frozen, preparedAt: now.toISOString(), phase: 'prepared', observations: [], sentCountRecorded: false };
      assistant.requestReceipts ??= [];
      assistant.requestReceipts.push(receipt);
      const session = state.chatSessions.find((item) => item.id === assistant.sessionId)!;
      // The receipt describes only the actual projection. Later reuse of either
      // message remains conservatively restricted by this conversation's history.
      const historyTrace = structuredClone(preparation.contextTrace);
      historyTrace.historyMessageIds = [...continuationHistory];
      if (session.historyPrivacy === 'local-only') historyTrace.privacy = 'local-only';
      assistant.contextTrace = historyTrace;
      for (const user of users) {
        user.contextTrace = structuredClone(historyTrace);
        // Verbatim owner input has its own source. The answer depends on the
        // rolling summary, but the current input predates exposure to it.
        delete user.contextTrace.recentRevision;
      }
      if (preparation.contextTrace.privacy === 'local-only') {
        session.historyPrivacy = 'local-only';
      }
      return structuredClone(receipt);
    });
  }

  /** Recheck a completed result immediately before a channel delivery. */
  assertMessageContextCurrent(messageId: string): void {
    const state = this.repository.snapshot(), message = state.chatMessages.find(item => item.id === messageId);
    const session = state.chatSessions.find(item => item.id === message?.sessionId);
    if (!message || message.status !== 'complete' || message.role !== 'assistant' || message.contextTrace?.lineage !== 'complete'
      || !session || session.deletedAt || session.archivedAt) throw new Error('chat.contextStale');
    assertTraceCurrent(state, message.sessionId, message.contextTrace, this.repository.memoryRecallSuppressionIds(), undefined, this.diary, this.knowledgeCurrent);
  }

  /** Last committed-snapshot guard immediately before posting to the utility process. */
  assertPreparedRequest(assistantMessageId: string, requestId: string): void {
    const state = this.repository.snapshot();
    const assistant = state.chatMessages.find((message) => message.id === assistantMessageId && message.role === 'assistant');
    const receipt = assistant?.requestReceipts?.find((item) => item.requestId === requestId);
    if (!assistant || assistant.status !== 'streaming' || !receipt || receipt.phase !== 'prepared') throw new Error('chat.contextStale');
    assertTraceCurrent(state, assistant.sessionId, receipt.contextTrace, this.repository.memoryRecallSuppressionIds(), undefined, this.diary, this.knowledgeCurrent);
  }

  async observeRequest(assistantMessageId: string, input: ProviderRequestObservation, now = new Date()): Promise<ChatRequestReceipt> {
    const observation = providerRequestObservationSchema.parse(input);
    return this.repository.transaction((state) => {
      const assistant = state.chatMessages.find((message) => message.id === assistantMessageId && message.role === 'assistant');
      const receipt = assistant?.requestReceipts?.find((item) => item.requestId === observation.requestId);
      if (!receipt || receipt.bindingDigest !== observation.bindingDigest || receipt.expectedBodySHA256 !== observation.bodySHA256
        || receipt.inputEstimate !== observation.inputEstimate) return receiptConflict();
      const previous = receipt.observations.find((item) => item.phase === observation.phase);
      if (previous) {
        const { observedAt: _observedAt, ...received } = previous; void _observedAt;
        if (!sameJSON(received, observation)) return receiptConflict();
        return structuredClone(receipt);
      }
      receipt.observations.push({ ...observation, observedAt: now.toISOString() });
      const order = { prepared: 0, 'fetch-invoked': 1, 'response-received': 2, terminal: 3 } as const;
      if (order[observation.phase] > order[receipt.phase]) receipt.phase = observation.phase;
      // A terminal notification alone might describe a pre-dispatch failure. Only a
      // fetch call or HTTP response is evidence that these sources entered transport.
      if (!receipt.sentCountRecorded && observation.phase !== 'terminal') {
        for (const reference of receipt.contextTrace.memoryReferences) {
          const metadata = state.memories.find((memory) => memory.id === reference.id)?.contextMetadata;
          // Late events never resurrect deleted data or count a newer revision as sent.
          if (metadata?.revision === reference.revision) { metadata.sentCount++; metadata.lastSentAt = now.toISOString(); }
        }
        receipt.sentCountRecorded = true;
      }
      return structuredClone(receipt);
    });
  }

  async addTimerReceipt(messageId: string, receipt: TimerReceipt): Promise<void> {
    await this.repository.transaction((state) => {
      const message = state.chatMessages.find((item) => item.id === messageId && item.role === 'assistant');
      if (message === undefined) throw new Error('Assistant message does not exist.');
      message.timerReceipts ??= [];
      if (!message.timerReceipts.some((item) => item.timerId === receipt.timerId)) message.timerReceipts.push(receipt);
    });
  }
}
