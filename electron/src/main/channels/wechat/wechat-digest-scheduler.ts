import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HealthItem } from '../../../shared/attention';
import { providerFailureCode } from '../../../shared/provider-errors';
import { nextCronOccurrence } from '../../domain/cron-expression';
import { EncryptedJsonStore } from '../../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../../persistence/encrypted-json-store';

export interface WeChatDigestSpec { revision: string; time: string; timezone: string; weekday?: number }
export interface WeChatDigestContext {
  binding: string;
  dueAt: number;
  now: number;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface WeChatDigestHost {
  feature: HealthItem['feature'];
  spec(): Promise<WeChatDigestSpec | null>;
  available(): boolean;
  ready?(): Promise<boolean>;
  quiet(now: number): boolean;
  ownerBinding(): Promise<string | null>;
  generate(context: WeChatDigestContext): Promise<WeChatDigestOutput>;
  deliverOwner(input: { binding: string; deliveryId: string; text: string }, context: WeChatDigestContext, metadata?: string): Promise<'sent' | 'retry' | 'uncertain' | 'skipped'>;
  now?(): number;
}

const issueSchema = z.enum(['read', 'model', 'delivery_failed', 'delivery_uncertain', 'interrupted', 'storage', 'configuration']);
type Issue = z.infer<typeof issueSchema>;

export class WeChatDigestFailure extends Error {
  constructor(readonly issue: 'read' | 'model') { super(`wechat.digest_${issue}`); }
}

const DAY = 86_400_000;
const MAX_RUNS = 20;
const DIGEST_TIMEOUT = 12 * 60_000;
const RETRY_DELAY = 5 * 60_000;
const MAX_RETRIES = 3;
const bindingSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.number().int().nonnegative().max(8.64e15);
const entrySchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(1800),
  detail: z.string().trim().min(1).max(4000),
  url: z.string().max(500).url().regex(/^https?:\/\//u).optional(),
});
const entriesSchema = z.array(entrySchema).max(32);
const providerErrorSchema = z.string().max(80).refine(value => providerFailureCode(new Error(value), '') !== '');
const outputSchema = z.strictObject({
  entries: entriesSchema,
  messages: z.array(z.string().min(1).max(500).refine(text => text === text.trim() &&
    !/[\p{C}\p{Zl}\p{Zp}\t\r\n]/u.test(text))).max(32),
  metadata: z.array(z.string().max(16_384)).max(32).optional(),
  issue: z.enum(['read', 'model']).optional(),
  providerError: providerErrorSchema.optional(),
  failures: z.number().int().min(0).max(32).optional(),
});
export type WeChatDigestEntry = z.infer<typeof entrySchema>;
export type WeChatDigestOutput = z.infer<typeof outputSchema>;
const runSchema = z.strictObject({
  binding: bindingSchema, dueAt: timestamp, at: timestamp, finishedAt: timestamp.nullable(),
  outcome: z.enum(['running', 'delivering', 'retrying', 'succeeded', 'failed', 'uncertain', 'interrupted']),
  delivered: z.boolean().default(false),
  issue: issueSchema.nullable(), failures: z.number().int().min(0).max(32), entries: entriesSchema,
  providerError: providerErrorSchema.optional(),
  deliveryProgress: z.strictObject({ sent: z.number().int().min(0).max(32), total: z.number().int().min(0).max(32) }).optional(),
  pending: z.strictObject({
    revision: z.string().max(256), schedule: z.string().max(256), output: outputSchema,
    index: z.number().int().min(0).max(32), sent: z.number().int().min(0).max(32),
    attempts: z.number().int().min(0).max(MAX_RETRIES), retryAt: timestamp,
  }).optional(),
});
const stateSchema = z.strictObject({
  timing: z.string().max(256).nullable(),
  nextAt: timestamp.nullable(),
  runs: z.array(runSchema).max(MAX_RUNS),
});
type Run = z.infer<typeof runSchema>;
type State = z.infer<typeof stateSchema>;
export type WeChatDigestResult = Pick<Run, 'at' | 'outcome' | 'entries' | 'delivered' | 'deliveryProgress'>;
const empty = (): State => ({ timing: null, nextAt: null, runs: [] });
const code = (issue: Issue | null): string | null => issue && `wechat.digest_${issue}`;
const iso = (time: number | undefined) => time === undefined ? null : new Date(time).toISOString();
const timing = (spec: WeChatDigestSpec): string => JSON.stringify([spec.time, spec.timezone, spec.weekday ?? null]);

function following(spec: WeChatDigestSpec, time: number): number {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(spec.time);
  if (!match || (spec.weekday !== undefined && (!Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6)))
    throw new Error('wechat.digest_configuration');
  let result: string | null;
  try { result = nextCronOccurrence(`${Number(match[2])} ${Number(match[1])} * * ${spec.weekday ?? '*'}`, spec.timezone, time); }
  catch { throw new Error('wechat.digest_configuration'); }
  if (result === null) throw new Error('wechat.digest_configuration');
  return Date.parse(result);
}

function settled(run: Run, outcome: Run['outcome'], issue: Issue | null, time: number, failures = issue ? 1 : 0): void {
  Object.assign(run, { outcome, issue, failures, finishedAt: Math.max(run.at, time) });
  delete run.pending;
}

function deliveryFailed(run: Run, time: number): void {
  const pending = run.pending!;
  run.deliveryProgress = { sent: pending.sent, total: pending.output.messages.length };
  settled(run, 'failed', 'delivery_failed', time);
}

function trimRuns(runs: Run[], now: number): Run[] {
  return runs.filter(run => run.at > now - 30 * DAY).slice(-MAX_RUNS);
}

/** Reuses the local cron calendar and the verified private delivery ledger. */
export class WeChatDigestScheduler {
  readonly #store: EncryptedJsonStore<State>;
  #state: State | null = null;
  #loadPending: Promise<State> | null = null;
  #pending: Promise<void> | null = null;
  #execution: AbortController | null = null;
  #failure: { issue: Issue; at: number } | null = null;

  constructor(path: string, vault: VaultKeyProvider, private readonly host: WeChatDigestHost) {
    this.#store = new EncryptedJsonStore({ path, vault, schema: stateSchema, defaultValue: empty });
  }

  #now(): number { return this.host.now?.() ?? Date.now(); }

  async #load(): Promise<State> {
    if (this.#state) return this.#state;
    this.#loadPending ??= this.#store.load().then(state => this.#state = state).finally(() => { this.#loadPending = null; });
    return this.#loadPending;
  }

  async #save(state: State): Promise<void> {
    try { await this.#store.save(state); }
    catch (error) {
      // Atomic rename may have committed. Re-read the durable reservation before any further action.
      this.#state = null;
      throw error;
    }
    this.#state = structuredClone(state);
  }

  async #spec(): Promise<WeChatDigestSpec | null> {
    try { return await this.host.spec(); }
    catch { throw new Error('wechat.digest_configuration'); }
  }

  tick(): Promise<void> {
    if (this.#pending) return this.#pending;
    const controller = new AbortController();
    this.#execution = controller;
    this.#pending = this.#tick(controller.signal).then(() => { this.#failure = null; }).catch((error: unknown) => {
      const issue = error instanceof WeChatDigestFailure ? error.issue
        : error instanceof Error && error.message === 'wechat.digest_configuration' ? 'configuration' : 'storage';
      this.#failure = { issue, at: this.#now() };
    }).finally(() => { this.#pending = null; this.#execution = null; });
    return this.#pending;
  }

  revoke(): void { this.#execution?.abort(); }

  async drain(): Promise<void> {
    this.revoke();
    await this.#pending;
  }

  async #tick(signal: AbortSignal): Promise<void> {
    const now = this.#now();
    const current = await this.#load();
    let recovered = false;
    const runs = trimRuns(current.runs, now).map(run => {
      if (run.finishedAt !== null) return run;
      if (run.outcome === 'retrying' && run.pending) return structuredClone(run);
      recovered = true;
      const copy = { ...run };
      if (run.outcome === 'delivering') settled(copy, 'uncertain', 'delivery_uncertain', now);
      else settled(copy, 'interrupted', 'interrupted', now);
      return copy;
    });
    const state = { ...current, runs };
    if (recovered || runs.length !== current.runs.length) await this.#save(state);
    const spec = await this.#spec();
    const retry = runs.find(run => run.outcome === 'retrying' && run.pending);
    if (retry) {
      const pending = retry.pending!;
      const deadline = state.nextAt;
      if (!spec || spec.revision !== pending.revision || timing(spec) !== pending.schedule) {
        settled(retry, 'interrupted', 'interrupted', now);
        await this.#save(state);
      } else if (deadline !== null && deadline <= now) {
        // Retire the old retry even while the channel is paused. Keep nextAt
        // unchanged so the usual admission path can process the new slot.
        deliveryFailed(retry, now);
        await this.#save(state);
      } else {
        if (signal.aborted || pending.retryAt > now || !this.host.available() || this.host.quiet(now) ||
            (this.host.ready && !await this.host.ready())) return;
        if (this.host.quiet(this.#now())) return;
        await this.#deliver(state, retry, this.#context(retry, spec, signal, deadline), deadline);
        return;
      }
    }
    if (!spec) {
      if (state.timing !== null) await this.#save({ ...state, timing: null, nextAt: null });
      return;
    }
    const schedule = timing(spec);
    if (state.nextAt === null || state.timing !== schedule) {
      await this.#save({ ...state, timing: schedule, nextAt: following(spec, now) });
      return;
    }
    const dueAt = state.nextAt;
    if (dueAt > now) return;
    const nextAt = following(spec, dueAt);
    if (nextAt <= now) {
      await this.#save({ ...state, nextAt: following(spec, now - 1) });
      return;
    }
    // A due run can wait through quiet hours, but an older run never catches up alongside a new slot.
    if (signal.aborted || !this.host.available() || this.host.quiet(now) || (this.host.ready && !await this.host.ready())) return;
    const binding = bindingSchema.safeParse(await this.host.ownerBinding().catch(() => {
      throw new WeChatDigestFailure('read');
    }));
    if (signal.aborted || !this.host.available() || this.host.quiet(this.#now())) return;
    if (!binding.success) throw new WeChatDigestFailure('read');
    const run: Run = { binding: binding.data, dueAt, at: this.#now(), finishedAt: null, outcome: 'running', delivered: false, issue: null, failures: 0, entries: [] };
    state.runs = [...state.runs, run].slice(-MAX_RUNS);
    state.nextAt = nextAt;
    await this.#save(state);
    await this.#execute(state, run, spec, signal);
  }

  #context(run: Run, spec: WeChatDigestSpec, cancellation: AbortSignal, deadline: number | null = null): WeChatDigestContext {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(DIGEST_TIMEOUT)]);
    const started = this.#now();
    const active = () => {
      const now = this.#now();
      return (deadline === null || now < deadline) && this.host.available() && !this.host.quiet(now) && now - started < DIGEST_TIMEOUT;
    };
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted();
      if (!active()) throw new Error('wechat.digest_interrupted');
      const latest = await this.#spec();
      if (!latest || latest.revision !== spec.revision || timing(latest) !== timing(spec) ||
          await this.host.ownerBinding() !== run.binding || !active())
        throw new Error('wechat.digest_interrupted');
      signal.throwIfAborted();
    };
    return { binding: run.binding, dueAt: run.dueAt, now: run.at, signal, assertCurrent };
  }

  async #execute(state: State, run: Run, spec: WeChatDigestSpec, cancellation: AbortSignal): Promise<void> {
    const context = this.#context(run, spec, cancellation);
    const { signal, assertCurrent } = context;
    let output: WeChatDigestOutput;
    try {
      await assertCurrent();
      output = outputSchema.parse(await this.host.generate(context));
      await assertCurrent();
    } catch (error) {
      const issue = error instanceof WeChatDigestFailure ? error.issue
        : signal.aborted || (error instanceof Error && error.message === 'wechat.digest_interrupted') ? 'interrupted'
        : error instanceof Error && error.message === 'wechat.digest_configuration' ? 'configuration' : 'model';
      settled(run, issue === 'interrupted' ? 'interrupted' : 'failed', issue, this.#now());
      const providerError = issue === 'model' ? providerFailureCode(error, '') : '';
      if (providerError) run.providerError = providerError;
      await this.#save(state);
      return;
    }
    run.entries = output.entries;
    run.pending = { revision: spec.revision, schedule: timing(spec), index: 0, sent: 0, attempts: 0, retryAt: 0, output };
    await this.#deliver(state, run, context);
  }

  async #deliver(state: State, run: Run, context: WeChatDigestContext, deadline: number | null = null): Promise<void> {
    const pending = run.pending!;
    const { output } = pending;
    const resuming = run.outcome === 'retrying';
    const expired = () => deadline !== null && this.#now() >= deadline;
    const onInvalid = () => {
      if (expired()) deliveryFailed(run, this.#now());
      else if (resuming && (this.host.quiet(this.#now()) || context.signal.aborted)) run.outcome = 'retrying';
      else settled(run, 'interrupted', 'interrupted', this.#now());
    };
    while (pending.index < output.messages.length) {
      try { await context.assertCurrent(); }
      catch { onInvalid(); break; }
      // A crash after this reservation may have crossed the send boundary.
      // Only a confirmed pre-send failure is eligible for automatic retry.
      run.outcome = 'delivering';
      await this.#save(state);
      try { await context.assertCurrent(); }
      catch { onInvalid(); break; }
      if (pending.retryAt) pending.attempts++;
      pending.retryAt = 0;
      const { index } = pending;
      const deliveryId = createHash('sha256').update(JSON.stringify([this.host.feature, run.binding, run.dueAt, index])).digest('hex');
      let delivery: 'sent' | 'retry' | 'uncertain' | 'skipped';
      try {
        delivery = await this.host.deliverOwner({ binding: run.binding, deliveryId, text: output.messages[index]! }, context, output.metadata?.[index]);
      } catch { delivery = 'uncertain'; }
      if (delivery === 'retry') {
        if (pending.attempts >= MAX_RETRIES || expired()) {
          deliveryFailed(run, this.#now());
        } else {
          run.outcome = 'retrying';
          pending.retryAt = this.#now() + RETRY_DELAY;
        }
        break;
      }
      if (delivery === 'uncertain') {
        settled(run, 'uncertain', 'delivery_uncertain', this.#now());
        break;
      }
      pending.index++;
      if (delivery === 'sent') pending.sent++;
    }
    if (pending.index === output.messages.length) {
      run.delivered = pending.sent > 0;
      settled(run, output.issue ? 'failed' : 'succeeded', output.issue ?? null,
        this.#now(), output.issue ? Math.max(1, output.failures ?? 1) : 0);
      if (output.providerError) run.providerError = output.providerError;
    }
    await this.#save(state);
  }

  async results(binding: string): Promise<WeChatDigestResult[]> {
    if (!bindingSchema.safeParse(binding).success || await this.host.ownerBinding() !== binding) return [];
    const state = await this.#load();
    if (await this.host.ownerBinding() !== binding) return [];
    return trimRuns(state.runs, this.#now()).filter(run => run.binding === binding && run.entries.length > 0)
      .reverse().map(run => structuredClone({ at: run.at, outcome: run.outcome, entries: run.entries, delivered: run.delivered,
        ...(run.deliveryProgress ? { deliveryProgress: run.deliveryProgress } : {}) }));
  }

  async expand(binding: string, index: number): Promise<WeChatDigestEntry | null> {
    if (!Number.isInteger(index) || index < 1) return null;
    const latest = (await this.results(binding))[0];
    // The owner may have received part of an uncertain newer run, so even a
    // previous confirmed report would be an ambiguous numbering source.
    return latest?.delivered ? latest.entries[index - 1] ?? null : null;
  }

  async health(): Promise<HealthItem> {
    const now = this.#now();
    let spec: WeChatDigestSpec | null = null, runs: Run[] = [], failure = this.#failure;
    try {
      spec = await this.#spec();
      if (spec) runs = trimRuns((await this.#load()).runs, now);
    } catch (error) {
      failure = { issue: error instanceof Error && error.message === 'wechat.digest_configuration' ? 'configuration' : 'storage', at: now };
    }
    const completed = runs.filter(run => run.finishedAt !== null);
    const fail = completed.filter(run => run.issue !== null);
    const last = completed.at(-1);
    const issue = failure?.issue ?? last?.issue ?? null;
    return { feature: this.host.feature, state: issue ? 'failing' : !spec ? 'off' : last ? 'ok' : 'waiting',
      errorCode: (!failure && last?.providerError) || code(issue), lastFailureAt: iso(failure?.at ?? fail.at(-1)?.finishedAt ?? undefined),
      lastSuccessAt: iso(completed.filter(run => run.outcome === 'succeeded').at(-1)?.finishedAt ?? undefined),
      failures: fail.filter(run => run.at > now - 7 * DAY).reduce((sum, run) => sum + run.failures, failure ? 1 : 0),
      sinceLaunch: false, ...(issue === 'delivery_failed' && last?.deliveryProgress ? { deliveryProgress: last.deliveryProgress } : {}) };
  }
}
