import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatMessage, ContextPrivacy } from '../../shared';
import type {
  ChatHistoryReadInput, ChatHistoryReadPage, ChatHistorySearchInput, ChatHistorySearchPage,
  ChatWorkBegin, ChatWorkContext, ChatWorkListOptions, ChatWorkPage, ChatWorkStatus, ChatWorkTask, ChatWorkUpdate,
  ChatArtifactEntry, ChatArtifactReference, ChatWorkArtifact,
} from '../../shared/chat-work';
import type { DomainRepository } from './repository';
import type { PersistentState } from './schemas';
import { contextPrivacyAllows } from './chat-context-policy';
import type { DiaryHistoryValidator } from './chat-context-policy';
import { createHistoryLookupResolver, historyLookupReference } from './chat-history-lineage';
import type { HistoryLookupReference } from './chat-history-lineage';
import { textPage } from '../tools/text-page';
import { chatMcpReturnsAuthenticatedData, chatMcpTool, isCustomChatTool } from '../tools/chat-mcp-tools';
import { NOTES_TOOL_IDS } from '../tools/notes-tools';
import {
  chatHistoryReadSchema, chatHistorySearchSchema, chatWorkArtifactSchema, chatWorkBeginSchema,
  chatWorkListSchema, chatWorkSourceSchema, chatWorkStatusSchema, chatWorkUpdateSchema, chatArtifactReferenceSchema,
} from './chat-work-schemas';

const uuid = z.string().uuid();
const contextSchema = z.object({ sessionId: uuid, destination: z.enum(['local', 'remote', 'unknown']) }).strict();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const published = (state: PersistentState, message: ChatMessage): boolean => message.automationTriggerId === undefined
  || state.automationTriggers.some((trigger) => trigger.id === message.automationTriggerId && trigger.status === 'succeeded' && trigger.publishedAt != null);

/** Durable bookkeeping and literal history reads. No model-controlled identity or evidence writes. */
export class ChatWorkService {
  constructor(private readonly repository: DomainRepository, private readonly options: { changed?: () => void; diaryRetained?: DiaryHistoryValidator } = {}) {}

  #notify(): void { try { this.options.changed?.(); } catch { /* Durable state remains authoritative. */ } }
  current(runId: string): ChatWorkTask | null {
    const task = this.repository.snapshot().chatWorkTasks.find((item) => item.runId === runId);
    return task ? structuredClone(task) : null;
  }

  async begin(input: ChatWorkBegin, now = new Date()): Promise<ChatWorkTask> {
    const value = chatWorkBeginSchema.parse(input);
    const task = await this.repository.transaction((state) => {
      const existing = state.chatWorkTasks.find((item) => item.runId === value.runId);
      if (existing) {
        if (existing.sessionId !== value.sessionId || existing.assistantMessageId !== value.assistantMessageId || existing.goal !== value.goal) throw new Error('chatWork.conflict');
        return structuredClone(existing);
      }
      const session = state.chatSessions.find((item) => item.id === value.sessionId && !item.deletedAt && !item.archivedAt);
      const assistant = state.chatMessages.find((item) => item.id === value.assistantMessageId && item.sessionId === value.sessionId && item.role === 'assistant' && item.status === 'streaming');
      if (!session || !assistant) throw new Error('chatWork.unavailable');
      if (state.chatWorkTasks.length >= 1000) throw new Error('chatWork.capacity');
      const task: ChatWorkTask = { ...value, id: randomUUID(), status: 'running',
        privacy: session.historyPrivacy === 'local-only' || assistant.contextTrace?.privacy === 'local-only' ? 'local-only' : value.privacy,
        plan: [], notes: '', nextStep: '', summary: '', sources: [], artifacts: [], evidenceTruncated: false, historyLookupReferences: [],
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.chatWorkTasks.push(task);
      return structuredClone(task);
    });
    this.#notify(); return task;
  }

  async update(runId: string, input: ChatWorkUpdate, assertCurrent: () => void = () => undefined, now = new Date()): Promise<ChatWorkTask> {
    uuid.parse(runId); const patch = chatWorkUpdateSchema.parse(input); assertCurrent();
    const task = await this.repository.transaction((state) => {
      assertCurrent();
      const task = state.chatWorkTasks.find((item) => item.runId === runId);
      if (!task || task.status !== 'running' || !state.chatSessions.some((item) => item.id === task.sessionId && !item.deletedAt && !item.archivedAt)) throw new Error('chatWork.unavailable');
      Object.assign(task, patch, { updatedAt: now.toISOString() });
      return structuredClone(task);
    });
    this.#notify(); return task;
  }

  async recordTool(runId: string, toolId: string, _input: unknown, output: unknown, now = new Date()): Promise<ChatWorkTask | null> {
    const current = this.current(runId);
    if (!current || current.status !== 'running' || (object(output) && (output.ok === false || output.skipped === true))) return current;
    const localRead = ['workspace.read', 'workspace.list', 'workspace.search', 'system.summary'].includes(toolId)
      || (NOTES_TOOL_IDS.includes(toolId) && (!object(output) || output.privacy !== 'cloud-allowed'))
      || (['skills.list', 'skills.read'].includes(toolId) && (!object(output) || output.privacy !== 'cloud-allowed'))
      || chatMcpReturnsAuthenticatedData(toolId)
      // The result states the privacy its grant had when the call ran.
      || (isCustomChatTool(toolId) && (!object(output) || output.privacy !== 'cloud-allowed'));
    const recordRead = ['task.get', 'task.list', 'history.read', 'history.search'].includes(toolId);
    const privateRecord = recordRead && object(output) && (output.privacy === 'local-only'
      || (Array.isArray(output.items) && output.items.some((item) => object(item) && item.privacy === 'local-only')));
    const source = toolId === 'web.read' && object(output) && typeof output.url === 'string' && typeof output.text === 'string'
      ? chatWorkSourceSchema.safeParse({ url: output.url,
        title: (typeof output.title === 'string' ? output.title : /^\s*Title:\s*(.+)$/mu.exec(output.text)?.[1] ?? output.url).slice(0, 240),
        ...(typeof output.sourceSHA256 === 'string' ? { sha256: output.sourceSHA256 } : {}) })
      : chatMcpTool(toolId)?.source && object(output) ? chatWorkSourceSchema.safeParse(output.source) : null;
    const artifact = toolId === 'workspace.write' && object(output) && output.written === true
      ? chatWorkArtifactSchema.safeParse({ path: output.path, bytes: output.bytes, sha256: output.sha256 }) : null;
    const skillRead = toolId === 'skills.list' || toolId === 'skills.read';
    if (!localRead && !recordRead && !source?.success && !artifact?.success && !skillRead) return current;
    const result = await this.repository.transaction((state) => {
      const task = state.chatWorkTasks.find((item) => item.runId === runId);
      if (!task || task.status !== 'running') return task ? structuredClone(task) : null;
      if (skillRead) {
        const values = object(output) && Array.isArray(output.skills) ? output.skills : [output];
        const skillReferences = new Map((task.skillReferences ?? []).map(item => [item.id, item]));
        for (const item of values) {
          if (!object(item)) continue;
          const currentSkill = state.desktopExtensions.skills.find(skill => skill.id === item.id && skill.enabled
            && (skill.revision ?? 1) === item.revision && (skill.digest ?? createHash('sha256').update(skill.text).digest('hex')) === item.digest);
          if (!currentSkill) throw new Error('extensions.changed');
          skillReferences.set(currentSkill.id, { id: currentSkill.id, revision: currentSkill.revision ?? 1, digest: String(item.digest) });
        }
        task.skillReferences = [...skillReferences.values()];
      }
      const lookup = createHistoryLookupResolver({ state, sessionId: task.sessionId, destination: 'local', suppressed: this.repository.memoryRecallSuppressionIds(),
        diaryAllowed: reference => this.options.diaryRetained?.(reference, state) === true, forbidden: new Set([task.assistantMessageId]) });
      const references = new Map(task.historyLookupReferences.map((reference) => [reference.messageId, reference]));
      let privateSource = false;
      const returned = object(output) && Array.isArray(output.items) ? output.items : [output];
      for (const item of recordRead ? returned : []) {
        if (!object(item)) continue;
        let reference: HistoryLookupReference | null = null;
        if (toolId.startsWith('history.') && typeof item.messageId === 'string' && typeof item.sessionId === 'string' && typeof item.sourceSHA256 === 'string') {
          reference = { messageId: item.messageId, sessionId: item.sessionId, contentSHA256: item.sourceSHA256 };
        } else if (toolId.startsWith('task.') && typeof item.id === 'string') {
          const sourceTask = state.chatWorkTasks.find((candidate) => candidate.id === item.id && candidate.sessionId === task.sessionId && candidate.id !== task.id);
          const message = sourceTask && state.chatMessages.find((candidate) => candidate.id === sourceTask.assistantMessageId);
          if (message) reference = historyLookupReference(message);
        }
        if (!reference) continue;
        const privacy = lookup(reference), prior = references.get(reference.messageId);
        if (privacy === null || (prior && (prior.sessionId !== reference.sessionId || prior.contentSHA256 !== reference.contentSHA256))) throw new Error('chat.contextStale');
        if (privacy === 'local-only') privateSource = true;
        references.set(reference.messageId, reference);
      }
      if (references.size > 256) throw new Error('chatWork.referenceLimit');
      task.historyLookupReferences = [...references.values()];
      if (localRead || privateRecord || privateSource) {
        task.privacy = 'local-only';
        const session = state.chatSessions.find((item) => item.id === task.sessionId);
        if (session) {
          session.historyPrivacy = 'local-only';
          if (localRead && NOTES_TOOL_IDS.includes(toolId)) session.knowledgeLocalOnly = true;
        }
      }
      if (source?.success) {
        const previous = task.sources.findIndex((item) => item.url === source.data.url);
        if (previous >= 0) task.sources[previous] = source.data;
        else task.sources.push(source.data);
        if (task.sources.length > 40) { task.sources.shift(); task.evidenceTruncated = true; }
      }
      if (artifact?.success) {
        const previous = task.artifacts.findIndex((item) => item.path === artifact.data.path);
        if (previous >= 0) task.artifacts[previous] = artifact.data;
        else task.artifacts.push(artifact.data);
        if (task.artifacts.length > 40) { task.artifacts.shift(); task.evidenceTruncated = true; }
      }
      task.updatedAt = now.toISOString();
      return structuredClone(task);
    });
    this.#notify(); return result;
  }

  async finish(runId: string, status: Exclude<ChatWorkStatus, 'running'>, summary: string, now = new Date()): Promise<ChatWorkTask | null> {
    uuid.parse(runId); chatWorkStatusSchema.exclude(['running']).parse(status); z.string().parse(summary);
    const task = await this.repository.transaction((state) => {
      const task = state.chatWorkTasks.find((item) => item.runId === runId);
      if (!task) return null;
      if (task.status === 'running') { task.status = status; task.summary = summary.slice(0, 8000); task.updatedAt = now.toISOString(); }
      return structuredClone(task);
    });
    this.#notify(); return task;
  }

  /** Host receipt for a derived file; it cannot complete a task or invent a message. */
  async recordDerivedArtifact(input: ChatArtifactReference, output: ChatWorkArtifact, assertCurrent: () => void, now = new Date()): Promise<void> {
    const reference = chatArtifactReferenceSchema.parse(input), artifact = chatWorkArtifactSchema.parse(output);
    if (artifact.derivedFrom?.format !== 'pdf-export' || artifact.derivedFrom.path !== reference.path || artifact.derivedFrom.sha256 !== reference.sha256
      || artifact.path === reference.path) throw new Error('chat.artifactInvalid');
    await this.repository.transaction(state => {
      assertCurrent();
      const task = state.chatWorkTasks.find(item => item.id === reference.taskId && item.sessionId === reference.sessionId);
      if (!task || !this.#taskAllowed(state, task, { sessionId: reference.sessionId, destination: 'local' })) throw new Error('chat.artifactUnavailable');
      if (!task.artifacts.some(item => item.path === reference.path && item.sha256 === reference.sha256)) throw new Error('chat.artifactChanged');
      if (task.artifacts.some(item => item.path === artifact.path)) throw new Error('chat.artifactChanged');
      if (task.artifacts.length >= 40) throw new Error('chat.artifactCapacity');
      task.artifacts.push(artifact); task.updatedAt = now.toISOString();
    });
    this.#notify();
  }

  async recoverInterrupted(now = new Date()): Promise<number> {
    if (!this.repository.snapshot().chatWorkTasks.some((task) => task.status === 'running')) return 0;
    const count = await this.repository.transaction((state) => {
      let count = 0;
      for (const task of state.chatWorkTasks) {
        if (task.status !== 'running') continue;
        task.status = 'interrupted'; task.updatedAt = now.toISOString(); count += 1;
      }
      return count;
    });
    this.#notify(); return count;
  }

  #assertSession(state: PersistentState, sessionId: string): void {
    uuid.parse(sessionId);
    if (!state.chatSessions.some((session) => session.id === sessionId && !session.deletedAt)) throw new Error('chatWork.unavailable');
  }

  #allowed(state: PersistentState, sourceSessionId: string, context: ChatWorkContext, extra?: ChatMessage): ChatMessage[] {
    const session = state.chatSessions.find((item) => item.id === sourceSessionId && !item.deletedAt);
    if (!session) return [];
    const history: ChatMessage[] = state.chatMessages.filter((message) => message.sessionId === sourceSessionId && published(state, message))
      .map((message) => message.id === extra?.id ? extra : message);
    const sourceState = extra ? { ...state, chatMessages: state.chatMessages.map((message) => message.id === extra.id ? extra : message) } : state;
    const forbidden = new Set<string>();
    // Current input is already in the required turn. Re-reading and then stamping
    // it with its own lookup reference would create a provenance cycle.
    for (const task of state.chatWorkTasks.filter((item) => item.status === 'running')) {
      const before = state.chatMessages.filter((message) => message.sessionId === task.sessionId);
      let index = before.findIndex((message) => message.id === task.assistantMessageId) - 1;
      while (index >= 0 && before[index]!.role !== 'assistant') {
        if (before[index]!.role === 'user') forbidden.add(before[index]!.id);
        index -= 1;
      }
    }
    const lookup = createHistoryLookupResolver({ state: sourceState, ...context, suppressed: this.repository.memoryRecallSuppressionIds(),
      diaryAllowed: reference => this.options.diaryRetained?.(reference, sourceState) === true, forbidden });
    return history.filter((message) => message.status === 'complete' && lookup(historyLookupReference(message)) !== null);
  }

  #taskAllowed(state: PersistentState, task: ChatWorkTask, context: ChatWorkContext): boolean {
    if (task.sessionId !== context.sessionId || !contextPrivacyAllows(task.privacy, context.destination)) return false;
    const session = state.chatSessions.find((item) => item.id === task.sessionId && !item.deletedAt);
    if (!session || !contextPrivacyAllows(session.historyPrivacy ?? 'cloud-allowed', context.destination)) return false;
    const message = state.chatMessages.find((item) => item.id === task.assistantMessageId && item.sessionId === task.sessionId && item.role === 'assistant');
    if (!message || !published(state, message)) return false;
    // A newly begun task has only the explicitly supplied goal, before any model
    // output exists. Unknown derived records are never eligible for model reuse.
    if (!message.contextTrace) return context.destination === 'local' && task.notes === '' && task.plan.length === 0 && task.nextStep === '' && task.summary === '' && task.sources.length === 0 && task.artifacts.length === 0;
    return this.#allowed(state, task.sessionId, context, { ...message, status: 'complete' }).some((item) => item.id === message.id);
  }

  list(sessionId: string, input: ChatWorkListOptions = {}): ChatWorkPage {
    const options = chatWorkListSchema.parse(input); const state = this.repository.snapshot(); this.#assertSession(state, sessionId);
    const context: ChatWorkContext = { sessionId, destination: options.destination ?? 'local' };
    const items = state.chatWorkTasks.filter((task) => (options.status === undefined || task.status === options.status) && this.#taskAllowed(state, task, context))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const offset = options.offset ?? 0, end = Math.min(items.length, offset + (options.limit ?? 20));
    return { items: structuredClone(items.slice(offset, end)), total: items.length, nextOffset: end < items.length ? end : null };
  }

  get(sessionId: string, id: string, destination: ChatWorkContext['destination'] = 'local'): ChatWorkTask | null {
    uuid.parse(id); const context = contextSchema.parse({ sessionId, destination }); const state = this.repository.snapshot(); this.#assertSession(state, sessionId);
    const task = state.chatWorkTasks.find((item) => item.id === id);
    return task && this.#taskAllowed(state, task, context) ? structuredClone(task) : null;
  }

  /** Local console output catalog; takes one snapshot instead of cloning the profile per file. */
  artifactEntries(sessionId?: string): ChatArtifactEntry[] {
    if (sessionId !== undefined) uuid.parse(sessionId);
    const state = this.repository.snapshot();
    const sessions = new Map(state.chatSessions.filter(session => !session.deletedAt).map(session => [session.id, session]));
    return state.chatWorkTasks.flatMap(task => {
      const session = sessions.get(task.sessionId);
      if (!session || task.artifacts.length === 0 || (sessionId !== undefined && task.sessionId !== sessionId)
        || !this.#taskAllowed(state, task, { sessionId: task.sessionId, destination: 'local' })) return [];
      return task.artifacts.map(artifact => ({ ...artifact, sessionId: task.sessionId, taskId: task.id, sessionTitle: session.title,
        goal: task.goal, updatedAt: task.updatedAt, status: task.status, archived: Boolean(session.archivedAt) }));
    });
  }

  #messagePrivacy(state: PersistentState, message: ChatMessage): ContextPrivacy {
    return createHistoryLookupResolver({ state, sessionId: message.sessionId, destination: 'local', suppressed: this.repository.memoryRecallSuppressionIds(),
      diaryAllowed: reference => this.options.diaryRetained?.(reference, state) === true })(historyLookupReference(message)) ?? 'local-only';
  }

  searchHistory(inputContext: ChatWorkContext, input: ChatHistorySearchInput): ChatHistorySearchPage {
    const context = contextSchema.parse(inputContext), options = chatHistorySearchSchema.parse(input);
    const state = this.repository.snapshot(); this.#assertSession(state, context.sessionId);
    const needle = options.query.toLocaleLowerCase();
    const hits = state.chatSessions.filter((session) => !session.deletedAt && (options.targetSessionId === undefined || options.targetSessionId === session.id))
      .flatMap((session) => this.#allowed(state, session.id, context).filter((message) => message.content.toLocaleLowerCase().includes(needle)).map((message) => {
        const match = message.content.toLocaleLowerCase().indexOf(needle);
        const page = textPage(message.content, { offset: Math.max(0, match - 100), maxCharacters: 480 });
        return { sessionId: session.id, sessionTitle: session.title, messageId: message.id, role: message.role as 'user' | 'assistant', createdAt: message.createdAt,
          snippet: page.text, offset: page.offset, totalCharacters: page.totalCharacters, sourceSHA256: page.sourceSHA256, privacy: this.#messagePrivacy(state, message) };
      })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.messageId.localeCompare(b.messageId));
    const offset = options.offset ?? 0, end = Math.min(hits.length, offset + (options.limit ?? 10)), items = hits.slice(offset, end);
    return { items, total: hits.length, nextOffset: end < hits.length ? end : null, privacy: items.some((item) => item.privacy === 'local-only') ? 'local-only' : 'cloud-allowed' };
  }

  readHistory(inputContext: ChatWorkContext, input: ChatHistoryReadInput): ChatHistoryReadPage | null {
    const context = contextSchema.parse(inputContext), options = chatHistoryReadSchema.parse(input);
    const state = this.repository.snapshot(); this.#assertSession(state, context.sessionId);
    const message = state.chatMessages.find((item) => item.id === options.messageId);
    if (!message || !this.#allowed(state, message.sessionId, context).some((item) => item.id === message.id)) return null;
    const session = state.chatSessions.find((item) => item.id === message.sessionId)!;
    return { sessionId: session.id, sessionTitle: session.title, messageId: message.id, role: message.role as 'user' | 'assistant', createdAt: message.createdAt,
      ...textPage(message.content, { offset: options.offset ?? 0, maxCharacters: options.maxCharacters ?? 4000 }), privacy: this.#messagePrivacy(state, message) };
  }
}
