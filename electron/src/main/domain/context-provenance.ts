import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContextPrivacy, ContextScope, ContextTrace, MemoryContextMetadata, MemoryItem, MemorySourceReference } from '../../shared/contracts';
import type { PersistentState } from './schemas';

export const isWeChatExcludedFromMemory = (message: ChatMessage): boolean =>
  message.wechatFriend === true || message.wechatDigest === true || message.contextTrace?.wechatDigestUntil !== undefined;

export const isExcludedFromMemory = (message: ChatMessage): boolean =>
  isWeChatExcludedFromMemory(message) || message.contextTrace?.knowledgePolicyToken !== undefined;

export const earliestWeChatDigestExpiry = (left?: string, right?: string): string | undefined =>
  left === undefined ? right : right === undefined || Date.parse(left) <= Date.parse(right) ? left : right;

export const sameContextScope = (left: ContextScope, right: ContextScope): boolean =>
  left.kind === right.kind && (left.kind === 'global' || (right.kind === 'session' && left.sessionId === right.sessionId));

export const memoryScope = (memory: MemoryItem): ContextScope => memory.contextMetadata?.scope ?? { kind: 'global' };
export const memoryPrivacy = (memory: MemoryItem): ContextPrivacy => memory.contextMetadata?.privacy ?? 'local-only';
export const memoryInSession = (memory: MemoryItem, sessionId: string): boolean => {
  const scope = memoryScope(memory);
  return scope.kind === 'global' || scope.sessionId === sessionId;
};

/** A new memory may go to any model the owner chats with. Local-only is a mark the owner sets,
 * or one inherited from a conversation that is itself local-only. */
export const DEFAULT_MEMORY_PRIVACY: ContextPrivacy = 'cloud-allowed';

/** Only host call sites construct this metadata; renderer inputs cannot supply it. */
export const confirmedMemoryMetadata = (input: {
  origin: MemoryContextMetadata['origin'];
  sourceReferences: MemorySourceReference[];
  scope?: ContextScope;
  privacy?: ContextPrivacy;
  previous?: MemoryContextMetadata;
}): MemoryContextMetadata => ({
  version: 1,
  trust: 'host-confirmed',
  origin: input.origin,
  scope: structuredClone(input.scope ?? input.previous?.scope ?? { kind: 'global' }),
  privacy: input.privacy ?? input.previous?.privacy ?? DEFAULT_MEMORY_PRIVACY,
  revision: (input.previous?.revision ?? 0) + 1,
  sourceReferences: structuredClone(input.sourceReferences),
  ...(input.previous?.protectionAcknowledgements ? { protectionAcknowledgements: [...input.previous.protectionAcknowledgements] } : {}),
  ...(input.previous?.overridesMemory ? { overridesMemory: structuredClone(input.previous.overridesMemory) } : {}),
  ...(input.previous?.identity ? { identity: structuredClone(input.previous.identity) } : {}),
  ...(input.previous?.expiresAt !== undefined ? { expiresAt: input.previous.expiresAt } : {}),
  sentCount: 0,
  lastSentAt: null,
});

export const sourceUserBefore = (state: PersistentState, assistant: ChatMessage): ChatMessage | undefined => {
  const index = state.chatMessages.findIndex((message) => message.id === assistant.id);
  if (index < 0) return undefined;
  return state.chatMessages.slice(0, index).filter((message) => message.sessionId === assistant.sessionId
    && message.role === 'user' && message.status === 'complete').at(-1);
};

/** The owner's messages for one assistant turn: the request and any requirements added to it before a retry. */
const turnUsers = (state: PersistentState, assistant: ChatMessage): ChatMessage[] => {
  const index = state.chatMessages.findIndex((message) => message.id === assistant.id);
  if (index < 0) return [];
  const before = state.chatMessages.slice(0, index).filter((message) => message.sessionId === assistant.sessionId);
  let request = before.length - 1;
  while (request >= 0 && (before[request]!.role !== 'user' || before[request]!.followupToMessageId !== undefined)) request -= 1;
  return [...(request >= 0 ? [before[request]!] : []), ...before.filter((message) => message.role === 'user' && message.followupToMessageId === assistant.id)];
};

export const chatMemorySource = (state: PersistentState, assistant: ChatMessage): {
  origin: 'chat-user' | 'manual-user'; sourceReferences: MemorySourceReference[];
} => {
  const source = sourceUserBefore(state, assistant);
  // A host invocation without a stored user message is not forged chat evidence.
  return source
    ? { origin: 'chat-user', sourceReferences: [{ kind: 'chat-user', sessionId: source.sessionId, messageId: source.id }] }
    : { origin: 'manual-user', sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }] };
};

/** A memory command that matched nothing stays out of later model context: its target can name text that left memory mid-command. */
export const withholdMemoryCommandTrace = (state: PersistentState, assistant: ChatMessage): void => {
  const trace: ContextTrace = { version: 1, memoryReferences: [], historyMessageIds: [], privacy: 'local-only',
    scope: { kind: 'session', sessionId: assistant.sessionId }, lineage: 'unknown' };
  assistant.contextTrace = structuredClone(trace);
  for (const user of new Set([sourceUserBefore(state, assistant), ...turnUsers(state, assistant)])) if (user) user.contextTrace = structuredClone(trace);
};

/** Keep source commands and receipts under the same restriction as the fact they mention. */
export const stampMemoryCommandTrace = (state: PersistentState, assistant: ChatMessage, input: MemoryItem | MemoryItem[], sourceMemory?: MemoryItem): void => {
  const memories = Array.isArray(input) ? input : [input];
  if (memories.length === 0) return;
  const session = state.chatSessions.find((item) => item.id === assistant.sessionId);
  if (!session) throw new Error('chat.sessionUnavailable');
  const privacy = session.historyPrivacy === 'local-only' || memories.some((memory) => memoryPrivacy(memory) === 'local-only') ? 'local-only' : 'cloud-allowed';
  const trace: ContextTrace = {
    version: 1,
    memoryReferences: memories.map((memory) => ({ id: memory.id, revision: memory.contextMetadata?.revision ?? 1 })),
    historyMessageIds: [],
    privacy,
    scope: { kind: 'session', sessionId: assistant.sessionId },
    lineage: memories.every((memory) => memory.contextMetadata?.trust === 'host-confirmed') ? 'complete' : 'unknown',
  };
  if (privacy === 'local-only') session.historyPrivacy = 'local-only';
  assistant.contextTrace = structuredClone(trace);
  // Every message of the turn names the same fact, including requirements added before a retry.
  for (const source of new Set([sourceUserBefore(state, assistant), ...turnUsers(state, assistant)])) {
    if (!source) continue;
    source.contextTrace = sourceMemory
      ? { ...structuredClone(trace), memoryReferences: [{ id: sourceMemory.id, revision: sourceMemory.contextMetadata?.revision ?? 1 }],
        lineage: sourceMemory.contextMetadata?.trust === 'host-confirmed' ? 'complete' : 'unknown' }
      : structuredClone(trace);
  }
};
