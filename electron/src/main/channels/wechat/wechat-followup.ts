import { providerFailureCode } from '../../../shared/provider-errors';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defaultWeChatFollowupSettings, wechatFollowupItemSchema, wechatFollowupSettingsSchema } from '../../../shared/wechat-followup';
import type { WeChatFollowupAction, WeChatFollowupItem, WeChatFollowupSettings } from '../../../shared/wechat-followup';
import type { WeChatPinnedCloudRoute } from '../../../shared/wechat-channel';
import { EncryptedJsonStore } from '../../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../../persistence/encrypted-json-store';
import { packWeChatDigestLines } from './wechat-group-digest';
import { WeChatDigestFailure } from './wechat-digest-scheduler';
import type { WeChatDigestContext, WeChatDigestOutput, WeChatDigestSpec } from './wechat-digest-scheduler';
import { classifyWeChatFollowup } from './wechat-followup-evidence';
import type { WeChatFollowupClassification, WeChatFollowupEvidenceRow } from './wechat-followup-evidence';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const at = z.number().int().nonnegative().max(8.64e15);
const minute = 60_000;
const historyWindow = 7 * 24 * 60 * minute;
const scanInterval = 3 * minute;
const maxSnoozeAttempts = 3;
const maxItems = 256;
const storedItem = wechatFollowupItemSchema.extend({ groupId: hash, sources: z.array(hash).min(1).max(256),
  done: z.boolean(), reportedAt: at.nullable(), snoozeExhausted: z.literal(true).optional() });
const reportLinesSchema = z.array(z.strictObject({ item: storedItem.pick({ id: true, groupId: true, summary: true,
  deadline: true, snoozedUntil: true }), text: z.string().max(500) })).min(1).max(3);
const snoozeBubbleSchema = z.union([
  z.strictObject({ lines: reportLinesSchema, attempts: z.number().int().min(0).max(maxSnoozeAttempts - 1) }),
  reportLinesSchema.transform(lines => ({ lines, attempts: 0 })), // Previously queued bubbles had no counter.
]);
const schema = z.strictObject({ binding: hash.nullable(), settings: wechatFollowupSettingsSchema,
  revision: at, since: z.record(hash, at), items: z.array(storedItem).max(maxItems),
  snoozeQueue: z.array(snoozeBubbleSchema).max(4).optional() });
type State = z.infer<typeof schema>;
type Item = z.infer<typeof storedItem>;
type ReportLine = z.infer<typeof reportLinesSchema>[number];
type SnoozeBubble = z.infer<typeof snoozeBubbleSchema>;
const empty = (): State => ({ binding: null, settings: defaultWeChatFollowupSettings(), revision: 0, since: {}, items: [] });
const shortCode = (item: WeChatFollowupItem): string => item.id.slice(0, 12);
const evidenceKey = (item: Pick<Item, 'groupId' | 'id'>): string => `${item.groupId}:${item.id}`;
const tidy = (text: string, max: number): string => [...text.replace(/[\p{C}\p{Z}]+/gu, ' ').trim()].slice(0, max)
  .join('').slice(0, max).replace(/[\uD800-\uDFFF]$/u, '').trimEnd();
const reportText = (lines: ReportLine[]): string | undefined =>
  packWeChatDigestLines(['等你处理｜群里还没看到你的回复', ...lines.map(line => line.text), '回「展开跟进 编号」查看'])[0];

export type WeChatFollowupRead = { rows: WeChatFollowupEvidenceRow[]; truncated: boolean };
export const followupCommand = /^(?:待跟进|等你处理|(?:展开|完成)\s*跟进\s+([a-f0-9]{12})|稍后\s*跟进\s+([a-f0-9]{12})(?:\s+([0-9]{1,5}))?)$/iu;

interface Host {
  available(): boolean;
  paused(): Promise<boolean>;
  quiet(now: number): boolean;
  ownerBinding(): Promise<string | null>;
  timezone(): string;
  roster(): Promise<Array<{ id: string; title: string }>>;
  read(binding: string, groupId: string, since: number, until: number): Promise<WeChatFollowupRead>;
  summarize(input: { binding: string; groupId: string; text: string; settings: WeChatFollowupSettings; guard: WeChatDigestContext }): Promise<string>;
  deliverOwner(input: { binding: string; deliveryId: string; text: string }): Promise<'sent' | 'retry' | 'uncertain'>;
  now?(): number;
}

export class WeChatFollowup {
  readonly #store: EncryptedJsonStore<State>;
  #state: State | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #scan: Promise<void> | null = null;
  #cancel: AbortController | null = null;
  #nextScan = 0;
  #lastFailure: { at: number; code: string } | null = null;
  #lastSuccess: number | null = null;

  constructor(path: string, vault: VaultKeyProvider, private readonly host: Host) {
    this.#store = new EncryptedJsonStore({ path, vault, schema, defaultValue: empty });
  }

  #now(): number { return this.host.now?.() ?? Date.now(); }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next;
    return next;
  }

  async #load(): Promise<State> { return this.#state ??= await this.#store.load(); }

  async #save(state: State): Promise<void> {
    try { await this.#store.save(state); this.#state = state; }
    catch (error) { this.#state = null; throw error; }
  }

  async #authority(binding: string): Promise<void> {
    if (!this.host.available() || await this.host.ownerBinding() !== binding || !this.host.available()) throw Error('wechat.authorityRevoked');
  }

  async settings(binding: string | null): Promise<WeChatFollowupSettings> {
    const current = await this.#load();
    return binding && current.binding === binding ? structuredClone(current.settings) : defaultWeChatFollowupSettings();
  }

  async modelRoute(): Promise<WeChatFollowupSettings['provider']> {
    const state = this.#state ?? await this.#store.readPersisted();
    return state?.settings.provider ?? null;
  }

  async followModel(expected: WeChatPinnedCloudRoute): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = await this.#load();
      const route = current.settings.provider;
      if (!route || route.providerId !== expected.providerId || route.model !== expected.model) return false;
      this.revoke();
      await this.#save({ ...current, revision: Math.max(this.#now(), current.revision + 1),
        settings: { ...current.settings, provider: { providerId: expected.providerId, model: null } } });
      return true;
    });
  }

  async configure(binding: string, settings: WeChatFollowupSettings, authorize: () => Promise<void>): Promise<void> {
    this.revoke();
    return this.#exclusive(async () => {
      await authorize();
      const saved = await this.#load();
      const previous = saved.binding === binding ? saved : empty();
      const since = Object.fromEntries(settings.groups.map(group => [group.id, previous.since[group.id] ?? this.#now()]));
      await this.#save({ binding, settings, since, revision: Math.max(this.#now(), saved.revision + 1),
        items: previous.items.filter(item => Object.hasOwn(since, item.groupId)) });
      this.#nextScan = 0;
      this.#lastFailure = null;
    });
  }

  revoke(): void { this.#cancel?.abort(); }
  async drain(): Promise<void> { this.revoke(); await this.#scan; await this.#queue.catch(() => undefined); this.#state = null; }

  async spec(): Promise<WeChatDigestSpec | null> {
    const state = await this.#load();
    return state.binding && state.settings.groups.length
      ? { revision: `${state.binding}:${state.revision}`, time: state.settings.time, timezone: this.host.timezone() } : null;
  }

  async list(binding: string): Promise<WeChatFollowupItem[]> {
    await this.#authority(binding);
    const state = await this.#load();
    await this.#authority(binding);
    if (state.binding !== binding) return [];
    return state.items.filter(item => !item.done && item.at > this.#now() - historyWindow)
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      .map(({ id, groupTitle, at, summary, detail, deadline, snoozedUntil }) => ({ id, groupTitle, at, summary, detail, deadline, snoozedUntil }));
  }

  async act(binding: string, action: WeChatFollowupAction, guard = () => this.#authority(binding)): Promise<void> {
    return this.#exclusive(async () => {
      await this.#authority(binding);
      const state = await this.#load();
      const item = state.binding === binding ? state.items.find(row => row.id === action.id && !row.done) : undefined;
      if (!item) throw Error('wechat.followup_not_found');
      await guard();
      await this.#authority(binding);
      const snoozedUntil = action.action === 'snooze' ? this.#now() + action.minutes * minute : null;
      await this.#save({ ...state, items: state.items.map(row => row !== item ? row :
        { ...item, done: action.action === 'done', snoozedUntil, reportedAt: null, snoozeExhausted: undefined }) });
      if (snoozedUntil !== null) this.#nextScan = Math.min(this.#nextScan, snoozedUntil);
    });
  }

  async command(binding: string, text: string, assertCurrent: () => Promise<void>): Promise<string | undefined> {
    const m = followupCommand.exec(text.trim());
    if (!m) return undefined;
    const items = await this.list(binding);
    await assertCurrent();
    const code = m[1] ?? m[2];
    if (!code) {
      if (!items.length) return '目前没有待跟进事项。';
      const lines = items.slice(0, 4).map(item => `${shortCode(item)} ${tidy(item.groupTitle, 20)} ${tidy(item.summary, 65)}`);
      return packWeChatDigestLines(['等你处理', ...lines, ...(items.length > 4 ? ['更多见桌宠动态。'] : [])])[0] ?? '目前没有待跟进事项。';
    }
    const matches = items.filter(item => shortCode(item) === code.toLowerCase());
    if (matches.length !== 1) return '这项待跟进已处理、过期或无法唯一确认。';
    const item = matches[0]!;
    if (text.trim().startsWith('展开')) return `${item.groupTitle} ${this.#formatAt(item.at)} ${item.detail || item.summary}${item.deadline ? ` 截止 ${item.deadline}` : ''}`;
    if (text.trim().startsWith('完成')) {
      await this.act(binding, { id: item.id, action: 'done' }, assertCurrent);
      return '已标为处理完成。';
    }
    const minutes = m[3] ? Number(m[3]) : 60;
    if (minutes < 5 || minutes > 10_080) return '请输入 5 至 10080 分钟。';
    await this.act(binding, { id: item.id, action: 'snooze', minutes }, assertCurrent);
    return `已延后 ${minutes} 分钟。`;
  }

  #formatAt(atMs: number): string {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: this.host.timezone(), month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false }).format(atMs);
  }

  async #collect(state: State, guard: WeChatDigestContext, only?: ReadonlySet<string>): Promise<{ state: State; verified: Set<string>; failures: number }> {
    const binding = guard.binding;
    const until = Math.floor(this.#now() / 1_000);
    const verified = new Set<string>();
    if (state.binding !== binding || !state.settings.groups.length) return { state, verified, failures: 0 };
    await guard.assertCurrent();
    if (await this.host.paused()) throw Error('wechat.followup_paused');
    const roster = new Map((await this.host.roster()).map(row => [row.id, row.title]));
    let failures = 0;
    const groups: Array<{ id: string; title: string; items: WeChatFollowupClassification[] }> = [];
    for (const group of state.settings.groups) {
      if (only && !only.has(group.id)) continue;
      await guard.assertCurrent();
      const title = roster.get(group.id);
      if (!title) { failures++; continue; }
      const start = Math.max(state.since[group.id] ?? this.#now(), this.#now() - historyWindow + 2_000);
      if (Math.ceil(start / 1_000) >= until) continue;
      try {
        const read = await this.host.read(binding, group.id, Math.ceil(start / 1_000), until);
        await guard.assertCurrent();
        if (read.truncated) { failures++; continue; }
        groups.push({ id: group.id, title, items: classifyWeChatFollowup(read.rows) });
      } catch (error) {
        await guard.assertCurrent();
        if (await this.host.paused()) throw error;
        failures++;
      }
    }
    const current = await this.#exclusive(async () => {
      await guard.assertCurrent();
      const latest = await this.#load();
      if (latest.binding !== binding || latest.revision !== state.revision) throw Error('wechat.authorityRevoked');
      let items = latest.items.filter(item => item.at > this.#now() - historyWindow);
      for (const group of groups) for (const item of group.items) {
        const previous = items.filter(row => row.groupId === group.id && row.sources.some(id => item.aliases.includes(id)));
        const kept = previous[0];
        const id = kept?.id ?? item.id;
        const sources = [...new Set([...item.aliases, ...previous.flatMap(row => row.sources)])].slice(0, 256);
        items = items.filter(row => !previous.includes(row));
        const next = { id, groupId: group.id, groupTitle: tidy(group.title, 160) || '群聊', at: kept?.at ?? item.at * 1_000,
          summary: tidy(item.summary, 140), detail: tidy(item.detail, 240), deadline: tidy(item.dueText ?? '', 100) || null,
          sources, done: item.answered || previous.some(row => row.done), snoozedUntil: kept?.snoozedUntil ?? null,
          reportedAt: previous.find(row => row.reportedAt !== null)?.reportedAt ?? null,
          ...(kept?.snoozeExhausted ? { snoozeExhausted: kept.snoozeExhausted } : {}) };
        if (next.summary) { items.push(next); verified.add(evidenceKey(next)); }
      }
      items = items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-maxItems);
      const next = { ...latest, items };
      if (JSON.stringify(latest.items) !== JSON.stringify(items)) await this.#save(next);
      return next;
    });
    return { state: current, verified, failures };
  }

  #eligible(state: State, verified: Set<string>, now: number, snoozedOnly: boolean): Item[] {
    return state.items.filter(item => verified.has(evidenceKey(item)) && !item.done && item.reportedAt === null &&
      item.at + state.settings.waitMinutes * minute <= now &&
      (snoozedOnly ? !item.snoozeExhausted && item.snoozedUntil !== null && item.snoozedUntil <= now
        : item.snoozedUntil === null || item.snoozedUntil <= now));
  }

  async #format(items: Item[], settings: WeChatFollowupSettings, guard: WeChatDigestContext) {
    const result = new Map<string, ReportLine[]>();
    let modelError: string | null = null;
    for (let start = 0; start < Math.min(items.length, 12); start += 3) {
      const batch = items.slice(start, start + 3);
      const lines: ReportLine[] = [];
      for (const { id, groupId, groupTitle, at, summary: original, deadline, snoozedUntil } of batch) {
        let summary = original;
        if (settings.groups.some(group => group.id === groupId && group.cloud)) {
          try { summary = tidy(await this.host.summarize({ binding: guard.binding, groupId, text: original, settings, guard }), 75) || summary; }
          catch (error) {
            await guard.assertCurrent();
            modelError = providerFailureCode(error, '') || modelError || 'wechat.digest_model';
          }
        }
        lines.push({ item: { id, groupId, summary: original, deadline, snoozedUntil },
          text: `${id.slice(0, 12)} ${tidy(groupTitle, 15)} ${this.#formatAt(at)} ${tidy(summary, 60)}${deadline ? ` 截止 ${tidy(deadline, 18)}` : ''}` });
      }
      const message = reportText(lines);
      if (message) result.set(message, lines);
    }
    return { messages: result, modelError };
  }

  async generate(guard: WeChatDigestContext): Promise<WeChatDigestOutput> {
    const original = await this.#load();
    const current = await this.#collect(original, guard).catch(async error => {
      await guard.assertCurrent();
      if (error instanceof Error && error.message === 'wechat.followup_paused') return null;
      throw new WeChatDigestFailure('read');
    });
    if (!current) return { entries: [], messages: [] };
    const selected = this.#eligible(current.state, current.verified, this.#now(), false);
    const { messages, modelError } = await this.#format(selected, current.state.settings, guard);
    return { entries: [], messages: [...messages.keys()],
      ...(messages.size ? { metadata: [...messages.values()].map(lines => JSON.stringify([current.state.revision, lines])) } : {}),
      ...(current.failures ? { issue: 'read' as const, failures: current.failures }
      : modelError ? { issue: 'model' as const } : {}),
      ...(modelError && modelError !== 'wechat.digest_model' ? { providerError: modelError } : {}) };
  }

  async #deliver(input: { binding: string; deliveryId: string; text: string }, revision: number, lines: ReportLine[], guard: WeChatDigestContext) {
    const original = await this.#load();
    if (original.binding !== input.binding || original.revision !== revision) return 'retry' as const;
    // A reply may arrive during model generation. Refresh each group in this message again before making a send reservation.
    const fresh = await this.#collect(original, guard, new Set(lines.map(({ item }) => item.groupId))).catch(() => null);
    if (!fresh) return 'retry' as const;
    return this.#exclusive(async () => {
      try { await guard.assertCurrent(); } catch { return 'retry' as const; }
      const state = await this.#load();
      const now = this.#now();
      if (state.binding !== input.binding || state.revision !== revision || this.host.quiet(now) || await this.host.paused()) return 'retry' as const;
      const current = lines.filter(({ item: expected }) => fresh.verified.has(evidenceKey(expected)) && state.items.some(item =>
        item.id === expected.id && item.groupId === expected.groupId && !item.done && item.reportedAt === null && item.snoozedUntil === expected.snoozedUntil &&
          item.summary === expected.summary && item.deadline === expected.deadline));
      if (!current.length) return fresh.failures ? 'retry' as const : 'skipped' as const;
      const text = reportText(current);
      if (!text) return 'skipped' as const;
      const ids = new Set(current.map(({ item }) => evidenceKey(item)));
      try { await guard.assertCurrent(); } catch { return 'retry' as const; }
      await this.#save({ ...state, items: state.items.map(item => ids.has(evidenceKey(item)) ? { ...item, reportedAt: now } : item) });
      try { await guard.assertCurrent(); }
      catch { await this.#save(state); return 'retry' as const; }
      let result: 'sent' | 'retry' | 'uncertain';
      try { result = await this.host.deliverOwner({ ...input, text }); }
      catch { result = 'uncertain'; }
      if (result === 'retry') await this.#save(state);
      return result;
    });
  }

  async deliverReport(input: { binding: string; deliveryId: string; text: string }, guard: WeChatDigestContext, metadata?: string) {
    if (!metadata || guard.binding !== input.binding) return 'retry' as const;
    const [revision, lines] = z.tuple([at, reportLinesSchema]).parse(JSON.parse(metadata));
    return this.#deliver(input, revision, lines, guard);
  }

  tick(): Promise<void> {
    if (this.#scan) return this.#scan;
    if (!this.host.available() || this.#now() < this.#nextScan) return Promise.resolve();
    this.#nextScan = this.#now() + scanInterval;
    const cancel = new AbortController();
    this.#cancel = cancel;
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(10 * minute)]);
    this.#scan = (async () => {
      const state = await this.#load();
      const binding = state.binding;
      if (!binding || !state.settings.groups.length || await this.host.paused() || await this.host.ownerBinding() !== binding) {
        this.#lastFailure = null;
        return;
      }
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await this.#authority(binding);
        if ((await this.#load()).revision !== state.revision) throw Error('wechat.authorityRevoked');
        signal.throwIfAborted();
      };
      const now = this.#now();
      const guard = { binding, now, dueAt: now, signal, assertCurrent };
      const checked = await this.#collect(state, guard);
      this.#lastSuccess = this.#now();
      this.#lastFailure = checked.failures ? { at: this.#now(), code: 'wechat.followup_read' } : null;
      if (this.host.quiet(now) || await this.host.paused()) return;
      let queue = checked.state.snoozeQueue;
      if (!queue?.length) {
        const snoozed = this.#eligible(checked.state, checked.verified, this.#now(), true);
        const { messages, modelError } = await this.#format(snoozed, state.settings, guard);
        if (modelError) this.#lastFailure = { at: this.#now(), code: modelError };
        queue = [...messages.values()].map(lines => ({ lines, attempts: 0 }));
        if (queue.length) await this.#saveSnoozeQueue(guard, queue);
      }
      for (const [i, { lines, attempts }] of queue.entries()) {
        if (this.host.quiet(this.#now()) || await this.host.paused()) break;
        const deliveryId = createHash('sha256').update(JSON.stringify(['wechat-followup-snooze', binding,
          lines.map(({ item }) => [item.id, item.snoozedUntil])])).digest('hex');
        const result = await this.#deliver({ binding, deliveryId, text: '' }, state.revision, lines, guard);
        const remaining = queue.slice(i + 1);
        if (result === 'retry') {
          if (attempts + 1 < maxSnoozeAttempts) {
            await this.#saveSnoozeQueue(guard, [{ lines, attempts: attempts + 1 }, ...remaining]);
            break;
          }
          await this.#saveSnoozeQueue(guard, remaining, lines);
          this.#lastFailure = { at: this.#now(), code: 'wechat.digest_delivery_failed' };
          continue;
        }
        await this.#saveSnoozeQueue(guard, remaining);
        if (result === 'uncertain') {
          this.#lastFailure = { at: this.#now(), code: 'wechat.digest_delivery_uncertain' };
          break;
        }
      }
    })().catch(error => {
      if (!cancel.signal.aborted && !(error instanceof Error && ['wechat.followup_paused', 'wechat.authorityRevoked'].includes(error.message)))
        this.#lastFailure = { at: this.#now(), code: 'wechat.followup_read' };
    }).finally(() => { this.#scan = null; this.#cancel = null; });
    return this.#scan;
  }

  #saveSnoozeQueue(guard: WeChatDigestContext, queue: SnoozeBubble[], exhausted?: ReportLine[]): Promise<void> {
    return this.#exclusive(async () => {
      await guard.assertCurrent();
      const state = await this.#load();
      // Drop this occurrence atomically with the queue update, not the item itself.
      // A manual re-snooze or the normal daily report can still pick up the item.
      const items = exhausted ? state.items.map(item => exhausted.some(({ item: expected }) =>
        item.id === expected.id && item.groupId === expected.groupId && item.snoozedUntil === expected.snoozedUntil)
        ? { ...item, snoozeExhausted: true as const } : item) : state.items;
      await this.#save({ ...state, items, snoozeQueue: queue });
    });
  }

  health() { return { lastFailure: this.#lastFailure, lastSuccess: this.#lastSuccess }; }
}
