import { ollamaCloudModel } from '../../shared/model-routing';
import type { ChatMessage, ContextPrivacy, ContextScope, ContextTrace, MemoryItem, ProviderKind } from '../../shared';
import type { PersistentState } from './schemas';

import { messageDigest } from './rolling-context';

export interface ChatContextBinding {
  providerId: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  localExecutionConfirmed?: boolean;
  serviceExecution?: 'local' | 'remote' | 'unknown';
}

export type ContextDestination = 'local' | 'remote' | 'unknown';
type DiaryReference = NonNullable<ContextTrace['diaryReferences']>[number];
export type DiaryHistoryValidator = (reference: DiaryReference, state: PersistentState) => boolean;

/** Many turns can cite the same summary. Reuse its decision within a single snapshot. */
export const memoDiaryHistory = (allowed?: (reference: DiaryReference) => boolean): ((reference: DiaryReference) => boolean) => {
  const checked = new Map<string, boolean>();
  return reference => {
    const key = `${reference.date}:${reference.revision}:${reference.summarySHA256}`;
    let result = checked.get(key);
    if (result === undefined) { result = allowed?.(reference) === true; checked.set(key, result); }
    return result;
  };
};

const remoteKinds = new Set<ProviderKind>(['openai', 'openrouter', 'minimax', 'glm', 'deepseek']);

// A loopback URL establishes the first hop, not where a proxy or a cloud-backed
// model executes. The declaration is a user assertion, never an attestation.
export const resolveContextDestination = (binding?: ChatContextBinding): ContextDestination => {
  if (binding === undefined) return 'unknown';
  if (binding.serviceExecution === 'remote' || remoteKinds.has(binding.kind) || (binding.kind === 'ollama' && ollamaCloudModel(binding.model))) return 'remote';
  let endpoint: URL;
  try { endpoint = new URL(binding.baseUrl); } catch { return 'unknown'; }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return 'unknown';
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!loopback) return 'remote';
  return binding.localExecutionConfirmed === true ? 'local' : 'unknown';
};

export const contextScopeAllows = (scope: ContextScope, sessionId: string): boolean =>
  scope.kind === 'global' || (scope.kind === 'session' && scope.sessionId === sessionId);

export const contextPrivacyAllows = (privacy: ContextPrivacy, destination: ContextDestination): boolean =>
  privacy === 'cloud-allowed' || (privacy === 'local-only' && destination === 'local');

export const memoryAllowedForContext = (
  memory: MemoryItem,
  sessionId: string,
  destination: ContextDestination,
): boolean => {
  const metadata = memory.contextMetadata;
  return metadata !== undefined && metadata.version === 1 && metadata.trust === 'host-confirmed'
    && Number.isSafeInteger(metadata.revision) && metadata.revision > 0
    && (metadata.expiresAt == null || Date.parse(metadata.expiresAt) > Date.now())
    && contextScopeAllows(metadata.scope, sessionId)
    && contextPrivacyAllows(metadata.privacy, destination);
};

/** Only an explicitly targeted live session override can shadow a global fact. */
export const projectContextMemories = (memories: readonly MemoryItem[], sessionId: string, destination: ContextDestination): MemoryItem[] => {
  const current = new Map(memories.map((memory) => [memory.id, memory]));
  const eligible = memories.filter((memory) => {
    if (!memoryAllowedForContext(memory, sessionId, destination)) return false;
    const target = memory.contextMetadata?.overridesMemory;
    return !target || current.get(target.id)?.contextMetadata?.revision === target.revision;
  });
  const shadowed = new Set(eligible.flatMap((memory) => memory.contextMetadata?.scope.kind === 'session'
    && memory.contextMetadata.overridesMemory ? [memory.contextMetadata.overridesMemory.id] : []));
  return eligible.filter((memory) => !shadowed.has(memory.id));
};

export const selectAllowedHistory = (input: {
  sessionId: string;
  history: readonly ChatMessage[];
  memories: readonly MemoryItem[];
  destination: ContextDestination;
  historyPrivacy?: ContextPrivacy;
  knowledgePolicyToken?: string | null;
  /** Set only for the authenticated owner in a private WeChat turn. */
  allowWeChatDigestContext?: boolean;
  representationAllowed?: (reference: {batchId:string;candidateVersion:number}) => boolean;
  historyLookupAllowed?: (reference: NonNullable<ContextTrace['historyLookupReferences']>[number]) => boolean;
  /** Historical text is checked for withdrawal of its sources independently of the diary summary. */
  diaryAllowed?: (reference: DiaryReference) => boolean;
}): ChatMessage[] => {
  // A user's later messages can repeat a fact from an earlier private answer.
  // Protect the whole retained history once the host has marked that session.
  if (input.historyPrivacy === 'local-only' && input.destination !== 'local') return [];
  const memories = new Map(input.memories.map((memory) => [memory.id, memory]));
  const messages = new Map(input.history.map((message) => [message.id, message]));
  const checked = new Map<string, boolean>();
  const checking = new Set<string>();
  const diaryAllowed = memoDiaryHistory(input.diaryAllowed);
  const now = Date.now();
  const allowed = (message: ChatMessage): boolean => {
    const cached = checked.get(message.id);
    if (cached !== undefined) return cached;
    if (checking.has(message.id)) return false;
    checking.add(message.id);
    const trace = message.contextTrace;
    const valid = message.sessionId === input.sessionId && message.status === 'complete'
      && (message.role === 'user' || message.role === 'assistant')
      && message.wechatDigest !== true && message.wechatFriend !== true
      && trace !== undefined && trace.version === 1 && trace.lineage === 'complete'
      && (trace.knowledgePolicyToken === undefined || trace.knowledgePolicyToken === input.knowledgePolicyToken)
      && (trace.wechatDigestUntil === undefined || (input.allowWeChatDigestContext === true
        && trace.scope.kind === 'session' && Date.parse(trace.wechatDigestUntil) > now))
      && (trace.summaryReferences ?? []).every(reference => {
        const source = messages.get(reference.messageId);
        return source && trace.historyMessageIds.includes(source.id) && messageDigest(source.content) === reference.contentSHA256;
      })
      && (trace.representationReferences ?? []).every((reference) => input.representationAllowed?.(reference) === true)
      && (trace.historyLookupReferences ?? []).every((reference) => input.historyLookupAllowed?.(reference) === true)
      && (trace.diaryReferences ?? []).every(diaryAllowed)
      && contextScopeAllows(trace.scope, input.sessionId)
      && contextPrivacyAllows(trace.privacy, input.destination)
      && trace.memoryReferences.every((reference) => {
        const memory = memories.get(reference.id);
        return memory !== undefined && memory.contextMetadata?.revision === reference.revision
          && memoryAllowedForContext(memory, input.sessionId, input.destination);
      })
      && trace.historyMessageIds.every((id) => {
        const source = messages.get(id);
        return source !== undefined && source.id !== message.id && allowed(source);
      });
    checking.delete(message.id);
    checked.set(message.id, valid);
    return valid;
  };
  return input.history.filter(allowed);
};
