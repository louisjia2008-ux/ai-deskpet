import { createHash } from 'node:crypto';
import type { ChatMessage, ContextPrivacy, ContextTrace } from '../../shared';
import type { PersistentState } from './schemas';
import { contextPrivacyAllows, contextScopeAllows, memoDiaryHistory, memoryAllowedForContext, projectContextMemories } from './chat-context-policy';
import type { ContextDestination } from './chat-context-policy';
import { consolidationDependenciesCurrent } from './consolidation-state';
import { isExcludedFromMemory } from './context-provenance';

export type HistoryLookupReference = NonNullable<ContextTrace['historyLookupReferences']>[number];
export type HistoryLookupState = Pick<PersistentState, 'profileId' | 'memories' | 'chatMessages' | 'chatSessions' | 'conversationImports' | 'consolidationBatches'>
  & Partial<Pick<PersistentState, 'automationTriggers' | 'chatWorkTasks'>>;

export const historyLookupReference = (message: ChatMessage): HistoryLookupReference => ({
  sessionId: message.sessionId, messageId: message.id, contentSHA256: createHash('sha256').update(message.content).digest('hex'),
});

/** One immutable snapshot, including every lookup and ordinary history ancestor.
 * A lookup grants access to historical text, never to another session's memory.
 */
export const createHistoryLookupResolver = (input: {
  state: HistoryLookupState; sessionId: string | null; destination: ContextDestination;
  /** With no requesting session, only ordinary history can be authenticated. */
  messageAllowed?: (message:ChatMessage)=>boolean;
  /** Completed messages only require their diary sources to remain shareable. */
  diaryAllowed?: (reference: NonNullable<ContextTrace['diaryReferences']>[number]) => boolean;
  suppressed?: ReadonlySet<string>; forbidden?: ReadonlySet<string>;
}): ((reference: HistoryLookupReference) => ContextPrivacy | null) => {
  const { state, sessionId, destination } = input;
  const messages = new Map(state.chatMessages.map((message) => [message.id, message]));
  const sessions = new Map(state.chatSessions.map((session) => [session.id, session]));
  const memories = new Map((sessionId === null ? [] : projectContextMemories(state.memories.filter((memory) => !input.suppressed?.has(memory.id)), sessionId, destination)).map((memory) => [memory.id, memory]));
  const tasksByMessage = new Map<string, NonNullable<HistoryLookupState['chatWorkTasks']>>();
  for (const task of state.chatWorkTasks ?? []) {
    const group=tasksByMessage.get(task.assistantMessageId);
    if (group) group.push(task); else tasksByMessage.set(task.assistantMessageId,[task]);
  }
  const checked = new Map<string, ContextPrivacy | null>(), checking = new Set<string>();
  const diaryAllowed = memoDiaryHistory(input.diaryAllowed);
  const digest = new Map<string, string>();
  const lookup = (reference: HistoryLookupReference): ContextPrivacy | null => {
    const message = messages.get(reference.messageId);
    if (!message || message.sessionId !== reference.sessionId) return null;
    let hash = digest.get(message.id);
    if (!hash) { hash = historyLookupReference(message).contentSHA256; digest.set(message.id, hash); }
    return hash === reference.contentSHA256 ? resolve(message) : null;
  };
  const resolve = (message: ChatMessage): ContextPrivacy | null => {
    if (input.forbidden?.has(message.id) || checking.has(message.id) || checking.size >= 256 || checked.size >= 10_000) return null;
    if (checked.has(message.id)) return checked.get(message.id)!;
    const session = sessions.get(message.sessionId), trace = message.contextTrace;
    const tasks = (tasksByMessage.get(message.id) ?? []).filter(task=>task.sessionId===message.sessionId);
    const terminalTask = tasks.some((task) => task.status !== 'running');
    if (isExcludedFromMemory(message) || input.messageAllowed && !input.messageAllowed(message) || !session || session.deletedAt || session.wechatTranscript || !contextPrivacyAllows(session.historyPrivacy ?? 'cloud-allowed', destination)
      || (message.status !== 'complete' && !(terminalTask && ['failed', 'cancelled'].includes(message.status)))
      || (message.role !== 'user' && message.role !== 'assistant') || !trace || trace.version !== 1 || trace.lineage !== 'complete'
      || !contextScopeAllows(trace.scope, message.sessionId) || !contextPrivacyAllows(trace.privacy, destination)
      || (message.automationTriggerId !== undefined && !state.automationTriggers?.some((trigger) => trigger.id === message.automationTriggerId && trigger.status === 'succeeded' && trigger.publishedAt != null))) {
      checked.set(message.id, null); return null;
    }
    checking.add(message.id);
    let privacy: ContextPrivacy = session.historyPrivacy === 'local-only' || trace.privacy === 'local-only' ? 'local-only' : 'cloud-allowed';
    const accept = (value: ContextPrivacy | null): boolean => { if (value === 'local-only') privacy = 'local-only'; return value !== null; };
    const valid = trace.memoryReferences.every((reference) => {
      const memory = memories.get(reference.id);
      if (!memory || memory.contextMetadata?.revision !== reference.revision || !memoryAllowedForContext(memory, message.sessionId, destination)) return false;
      if (memory.contextMetadata.privacy === 'local-only') privacy = 'local-only';
      return true;
    }) && (trace.diaryReferences ?? []).every(diaryAllowed)
    && (trace.summaryReferences ?? []).every(reference => {
      const source = messages.get(reference.messageId);
      return source && trace.historyMessageIds.includes(source.id) && historyLookupReference(source).contentSHA256 === reference.contentSHA256;
    }) && (trace.representationReferences ?? []).every((reference) => {
      const batch = state.consolidationBatches.find((item) => item.id === reference.batchId);
      return sessionId !== null && batch?.active === true && batch.status === 'applied' && batch.candidateVersion === reference.candidateVersion
        && consolidationDependenciesCurrent(state as PersistentState, batch, destination, sessionId);
    }) && trace.historyMessageIds.every((id) => {
      const parent = messages.get(id);
      return parent?.sessionId === message.sessionId && accept(resolve(parent));
    }) && (trace.historyLookupReferences ?? []).every((reference) => accept(lookup(reference)))
      && tasks.every((task) => contextPrivacyAllows(task.privacy, destination)
        && (task.historyLookupReferences ?? []).every((reference) => accept(lookup(reference))));
    if (tasks.some((task) => task.privacy === 'local-only')) privacy = 'local-only';
    checking.delete(message.id); checked.set(message.id, valid ? privacy : null);
    return valid ? privacy : null;
  };
  return lookup;
};
