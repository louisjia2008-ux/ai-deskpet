import { createHash } from 'node:crypto';
import { z } from 'zod';
import { backgroundFailureCode } from './background-failure';
import { isOwnerDiaryChannel, type ChannelContext } from '../security/execution-context';
import { companionPreferencesSchema, defaultCompanionPreferences, diaryEntrySchema } from '../../shared/companion-journal';
import type { KnowledgeDiaryCopy } from '../../shared/knowledge';
import type { CompanionPreferences, DiaryEntry } from '../../shared/companion-journal';
import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../persistence/encrypted-json-store';
import type { PersistentState } from './schemas';
import type { ContextTrace } from '../../shared';
import { projectContextMemories, selectAllowedHistory } from './chat-context-policy';
import { isExcludedFromMemory } from './context-provenance';
import { recentTraceAllowed, supersededChat } from './companion-recent-state';
import { proactiveDayKey, proactiveMinuteOfDay } from './proactive-policy';

const provenanceSchema = diaryEntrySchema.pick({ sources: true, memories: true, revision: true });
const schema = z.object({ preferences: companionPreferencesSchema, entries: z.array(diaryEntrySchema).max(366), lastDate: z.string().nullable(),
  retiredProvenance: z.record(z.string(), provenanceSchema).default({}),
  lastSuccessAt: z.string().nullable(), lastFailureAt: z.string().nullable(), errorCode: z.string().nullable() }).strict();
type State = z.infer<typeof schema>;
type Provenance = z.infer<typeof provenanceSchema>;
type DiaryReference = NonNullable<ContextTrace['diaryReferences']>[number];
const initial = (): State => ({ preferences: defaultCompanionPreferences(), entries: [], retiredProvenance: {}, lastDate: null, lastSuccessAt: null, lastFailureAt: null, errorCode: null });
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const previousDate = (date: string): string => new Date(Date.parse(date + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10);

/** A cloud diary only ever sees proven owner sessions with complete, currently allowed lineage. */
export function diaryMaterial(state: PersistentState, date: string, timezone: string, suppressed: (id: string) => boolean,
  diaryAllowed?: (reference: DiaryReference) => boolean, diaryCurrent?: (reference: DiaryReference) => boolean) {
  const memories = state.memories.filter(memory => !suppressed(memory.id));
  const superseded = supersededChat(state);
  // A new diary is written only from what still stands: not a superseded message, nor anything that had one in
  // its context however indirectly, nor a reply that used a diary no longer current. Context always points back.
  const stale = new Set<string>();
  for (const message of state.chatMessages) {
    const trace = message.contextTrace;
    if (superseded.has(message.id) || (trace && (trace.historyMessageIds.some(id => stale.has(id))
      || (trace.historyLookupReferences ?? []).some(reference => stale.has(reference.messageId))
      || (diaryCurrent !== undefined && (trace.diaryReferences ?? []).some(reference => !diaryCurrent(reference)))))) stale.add(message.id);
  }
  const sources: Array<{ id: string; digest: string; text: string; role: string }> = [];
  let used = 0;
  for (const session of state.chatSessions) {
    if (session.companionScope !== 'owner' || session.deletedAt || session.archivedAt || session.analysisSource || session.historyPrivacy === 'local-only') continue;
    const history = state.chatMessages.filter(message => message.sessionId === session.id);
    const allowed = selectAllowedHistory({ sessionId: session.id, history, memories, destination: 'remote', historyPrivacy: session.historyPrivacy ?? 'cloud-allowed',
      ...(diaryAllowed ? { diaryAllowed } : {}) });
    for (const message of allowed) {
      if (proactiveDayKey(Date.parse(message.createdAt), timezone) !== date || !message.content.trim() || stale.has(message.id)
        || sources.length >= 120 || used + message.content.length > 24_000) continue;
      sources.push({ id: message.id, digest: digest(message.content + JSON.stringify(message.contextTrace)), text: message.content, role: message.role }); used += message.content.length;
    }
  }
  const known = projectContextMemories(memories, 'diary-global', 'remote').filter(memory => memory.contextMetadata?.scope.kind === 'global' && !memory.contextMetadata.reviewReason).slice(-30);
  return { sources, memories: known.map(memory => ({ id: memory.id, revision: memory.contextMetadata!.revision, text: memory.text.slice(0, 600) })) };
}

/** Housekeeping can retire a summary without retracting previously approved text. */
function sourceStatus(entry: Provenance, state: PersistentState, suppressed: (id: string) => boolean,
  resolveDiary: (reference: DiaryReference) => Provenance | undefined): 'current' | 'superseded' | 'retired' | 'withdrawn' {
  const sessions = new Map(state.chatSessions.map(session => [session.id, session]));
  const messages = new Map(state.chatMessages.map(message => [message.id, message]));
  const memories = new Map(state.memories.map(memory => [memory.id, memory]));
  const deletedMemories = new Set(state.memoryTombstones.filter(item => item.kind === 'deleted').map(item => item.memoryId));
  // Backward compatibility for cleanups recorded before the durable IDs existed.
  const recentReplacements = new Map<string, string | null>();
  for (const report of state.memorySleep.reports) {
    for (const change of report.changes) {
      if (change.undoneAt || change.kind === 'promote') continue;
      for (const item of change.removed) recentReplacements.set(item.id, change.resultId);
    }
  }
  let retired = false;
  // A later correction: the entry is no longer fed into new conversations, but it is still the owner's diary of that day.
  let corrected = false;
  // Each memory with the oldest revision any source relied on.
  const memorySources = new Map<string, number>();
  const relyOn = (id: string, revision: number): void => { memorySources.set(id, Math.min(revision, memorySources.get(id) ?? revision)); };
  for (const item of entry.memories) relyOn(item.id, item.revision);
  const superseded = supersededChat(state);
  const correctedAt = new Map<string, number>();
  for (const guard of state.memoryTombstones) {
    if (guard.kind === 'corrected') correctedAt.set(guard.memoryId, Math.max(guard.memoryRevision ?? 0, correctedAt.get(guard.memoryId) ?? 0));
  }
  const seenDiaries = new Set<Provenance>([entry]);
  const seenMessages = new Set<string>();
  const pending = entry.sources.map(source => ({ id: source.id, owner: true }));
  while (pending.length > 0) {
    const { id, owner } = pending.pop()!;
    const message = messages.get(id);
    const session = message && sessions.get(message.sessionId);
    if (!message || isExcludedFromMemory(message) || !session || session.deletedAt || session.historyPrivacy === 'local-only'
      || message.contextTrace?.privacy !== 'cloud-allowed' || (owner && session.companionScope !== 'owner')
      || (message.contextTrace.recentRevision !== undefined && !recentTraceAllowed(state, message.contextTrace.recentRevision, 'remote'))) return 'withdrawn';
    if (seenMessages.has(id)) continue;
    seenMessages.add(id);
    // A deleted memory withdraws what was written from its message; a correction only stops new use.
    const changed = superseded.get(id);
    if (changed === 'deleted') return 'withdrawn';
    if (changed === 'corrected') corrected = true;
    if (session.archivedAt || session.analysisSource) retired = true;
    for (const reference of message.contextTrace.memoryReferences) relyOn(reference.id, reference.revision);
    for (const id of message.contextTrace.historyMessageIds) pending.push({ id, owner: false });
    for (const reference of message.contextTrace.historyLookupReferences ?? []) pending.push({ id: reference.messageId, owner: false });
    for (const reference of message.contextTrace.diaryReferences ?? []) {
      const diary = resolveDiary(reference);
      if (!diary) return 'withdrawn';
      if (seenDiaries.has(diary)) continue;
      seenDiaries.add(diary);
      for (const source of diary.sources) pending.push({ id: source.id, owner: true });
      for (const memory of diary.memories) relyOn(memory.id, memory.revision);
    }
  }
  const replacementOf = (id: string): string | null | undefined => Object.hasOwn(state.memorySleep.recallReplacements, id)
    ? state.memorySleep.recallReplacements[id] : recentReplacements.get(id);
  const checkedMemories = new Set<string>();
  for (const [id, revision] of memorySources) {
    // A later correction leaves the old wording out of new conversations without retracting past replies.
    if ((correctedAt.get(id) ?? -1) >= revision) corrected = true;
    // So does a correction anywhere along what it was merged into. Walked on its own, whatever was checked first.
    for (let next = replacementOf(id), walked = new Set<string>(); typeof next === 'string' && !walked.has(next);
      walked.add(next), next = memories.has(next) ? null : replacementOf(next)) {
      if (correctedAt.has(next)) corrected = true;
    }
    let current = id;
    const seen = new Set<string>();
    while (!checkedMemories.has(current)) {
      if (seen.has(current) || suppressed(current) || deletedMemories.has(current)) return 'withdrawn';
      seen.add(current);
      const memory = memories.get(current);
      if (memory) {
        const metadata = memory.contextMetadata;
        if (!metadata || metadata.privacy !== 'cloud-allowed') return 'withdrawn';
        if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) retired = true;
        break;
      }
      const replacement = replacementOf(current);
      if (replacement === undefined) return 'withdrawn';
      if (replacement === null) { retired = true; break; }
      current = replacement;
    }
    for (const checked of seen) checkedMemories.add(checked);
  }
  return retired ? 'retired' : corrected ? 'superseded' : 'current';
}

export class CompanionJournal {
  readonly #store: EncryptedJsonStore<State>;
  #state = initial(); #writes: Promise<unknown> = Promise.resolve(); #running: Promise<void> | null = null;
  #closed = false; #controller: AbortController | null = null;
  #loadFailed = false;
  constructor(path: string, vault: VaultKeyProvider) { this.#store = new EncryptedJsonStore({ path, vault, schema, defaultValue: initial }); }
  async initialize(): Promise<void> {
    try { this.#state = await this.#store.load(); }
    catch { this.#loadFailed = true; this.#state.errorCode = 'diary.storage'; this.#state.lastFailureAt = new Date().toISOString(); }
  }
  status() { return { enabled: this.#loadFailed || this.#state.preferences.diaryEnabled, running: this.#running !== null, lastSuccessAt: this.#state.lastSuccessAt, lastFailureAt: this.#state.lastFailureAt, errorCode: this.#state.errorCode }; }
  preferences(): CompanionPreferences { return structuredClone(this.#state.preferences); }
  list(): DiaryEntry[] { return structuredClone(this.#state.entries).sort((a, b) => b.date.localeCompare(a.date)); }
  #update<T>(change: (draft: State) => T): Promise<T> {
    if (this.#loadFailed) return Promise.reject(new Error('diary.storage')); // Never overwrite an unreadable encrypted diary.
    const work = this.#writes.then(async () => { const next = structuredClone(this.#state); const result = change(next); await this.#store.save(next); this.#state = next; return result; });
    this.#writes = work.catch(() => undefined); return work;
  }
  async configure(value: CompanionPreferences): Promise<CompanionPreferences> { const parsed = companionPreferencesSchema.parse(value); if (!parsed.diaryEnabled) this.#controller?.abort(); await this.#update(state => { state.preferences = parsed; }); return this.preferences(); }
  async edit(input: { date: string; revision: number; text: string }): Promise<void> {
    const text = z.string().trim().min(1).max(6000).parse(input.text);
    await this.#update(state => { const entry = state.entries.find(item => item.date === input.date); if (!entry || entry.revision !== input.revision) throw new Error('diary.stale'); entry.text = text; entry.summary = text.slice(0, 600); entry.edited = true; entry.revision++; });
  }
  async remove(input: { date: string; revision: number }): Promise<void> {
    await this.#update(state => {
      const entry = state.entries.find(item => item.date === input.date);
      if (!entry || entry.revision !== input.revision) throw new Error('diary.stale');
      state.retiredProvenance[entry.date] = provenanceSchema.parse({ sources: entry.sources, memories: entry.memories, revision: entry.revision });
      state.entries = state.entries.filter(item => item !== entry);
    });
  }
  referenceCurrent(reference: DiaryReference, state: PersistentState, destination: 'local' | 'remote', suppressed: (id: string) => boolean): boolean {
    const entry = this.#state.entries.find(item => item.date === reference.date);
    return !!entry && entry.revision === reference.revision && digest(entry.summary) === reference.summarySHA256
      && (!entry.edited || destination === 'local') && this.#sourceStatus(entry, state, suppressed) === 'current';
  }
  #provenance(reference: DiaryReference): Provenance | undefined {
    const entry = this.#state.entries.find(item => item.date === reference.date);
    const provenance = entry ?? this.#state.retiredProvenance[reference.date];
    return provenance && reference.revision <= provenance.revision
      && (!entry || entry.revision !== reference.revision || digest(entry.summary) === reference.summarySHA256)
      ? provenance : undefined;
  }
  #sourceStatus(provenance: Provenance, state: PersistentState, suppressed: (id: string) => boolean) {
    return sourceStatus(provenance, state, suppressed, reference => this.#provenance(reference));
  }
  /** Completed turns already carry their own privacy mark and can outlive the summary revision. */
  referenceRetained(reference: DiaryReference, state: PersistentState, suppressed: (id: string) => boolean): boolean {
    const provenance = this.#provenance(reference);
    return !!provenance && this.#sourceStatus(provenance, state, suppressed) !== 'withdrawn';
  }
  /** An unreadable journal cannot establish that any existing copy was withdrawn. */
  exportableCopies(state: PersistentState, suppressed: (id: string) => boolean): KnowledgeDiaryCopy[] | null {
    if (this.#loadFailed) return null;
    return this.#state.entries.filter(entry => ['current', 'superseded'].includes(this.#sourceStatus(entry, state, suppressed)))
      .map(({ date, createdAt, text }) => ({ date, createdAt, text }));
  }
  context(state: PersistentState, destination: 'local' | 'remote', suppressed: (id: string) => boolean) {
    const entries: DiaryEntry[] = [];
    for (const entry of [...this.#state.entries].sort((a, b) => b.date.localeCompare(a.date))) {
      if ((!entry.edited || destination === 'local') && this.#sourceStatus(entry, state, suppressed) === 'current') entries.push(entry);
      if (entries.length === 3) break;
    }
    return { summaries: entries.map(entry => `${entry.date}: ${entry.summary}`),
      references: entries.map(entry => ({ date: entry.date, revision: entry.revision, summarySHA256: digest(entry.summary) })),
      privacy: entries.some(entry => entry.edited) ? 'local-only' as const : 'cloud-allowed' as const };
  }

  chatContext(channel: ChannelContext, state: PersistentState, destination: 'local' | 'remote', suppressed: (id: string) => boolean) {
    if (!isOwnerDiaryChannel(channel)) return undefined;
    // QQ and WeChat delivery leaves the device even when using a local model.
    return this.context(state, channel.origin === 'desktop' ? destination : 'remote', suppressed);
  }

  async tick(input: { now: number; timezone: string; available(): boolean; state(): PersistentState; suppressed(id: string): boolean;
    complete(material: string, signal: AbortSignal, assertCurrent: () => void, date: string): Promise<{ text: string; summary: string }> }): Promise<void> {
    if (this.#closed || this.#loadFailed || this.#running || !this.#state.preferences.diaryEnabled || !input.available()) return;
    const today = proactiveDayKey(input.now, input.timezone);
    // Before 03:00 only catch up the last missed night, not yesterday's unfinished day.
    const date = previousDate(proactiveMinuteOfDay(input.now, input.timezone) >= 180 ? today : previousDate(today));
    if (this.#state.lastDate !== null && this.#state.lastDate >= date) return;
    const controller = new AbortController(); this.#controller = controller;
    this.#running = (async () => {
      await this.#update(state => { state.lastDate = date; }); // one bounded attempt, including after restart
      try {
        const collect = () => {
          const state = input.state();
          return diaryMaterial(state, date, input.timezone, input.suppressed, reference => this.referenceRetained(reference, state, input.suppressed),
            reference => this.referenceCurrent(reference, state, 'remote', input.suppressed));
        };
        const material = collect();
        if (!material.sources.length) return;
        const assertCurrent = (): void => {
          if (this.#closed || controller.signal.aborted || !this.#state.preferences.diaryEnabled || !input.available()
            || JSON.stringify(material) !== JSON.stringify(collect())) throw new Error('diary.contextChanged');
        };
        assertCurrent();
        const result = await input.complete(JSON.stringify({ date, ...material }), controller.signal, assertCurrent, date);
        if (controller.signal.aborted || !input.available()) throw new Error('diary.interrupted');
        const fresh = collect();
        if (JSON.stringify(material) !== JSON.stringify(fresh)) throw new Error('diary.contextChanged');
        const entry = diaryEntrySchema.parse({ date, ...result, revision: 1, edited: false, createdAt: new Date(input.now).toISOString(),
          sources: material.sources.map(({ id, digest }) => ({ id, digest })), memories: material.memories.map(({ id, revision }) => ({ id, revision })) });
        await this.#update(state => {
          if (!state.preferences.diaryEnabled) throw new Error('diary.disabled');
          state.entries.push(entry);
          for (const old of state.entries.splice(0, Math.max(0, state.entries.length - 366))) {
            state.retiredProvenance[old.date] = { sources: old.sources, memories: old.memories, revision: old.revision };
          }
          state.lastSuccessAt = entry.createdAt; state.errorCode = null;
        });
      } catch (error) {
        const code = backgroundFailureCode(error, 'diary.failed', [
          'diary.noCloud', 'diary.contextChanged', 'diary.interrupted', 'diary.disabled',
          'diary.invalid', 'diary.tooLarge', 'diary.incomplete',
        ]);
        await this.#update(state => { state.lastFailureAt = new Date(input.now).toISOString(); state.errorCode = code; });
      }
    })().finally(() => { this.#running = null; this.#controller = null; });
    await this.#running;
  }
  async shutdown(): Promise<void> { this.#closed = true; this.#controller?.abort(); await this.#running; await this.#writes; }
}
