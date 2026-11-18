import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HealthAcknowledge, HealthItem, HealthSnapshot } from '../../shared/attention';
import { AtomicJsonStore } from '../persistence/atomic-json-store';

const receiptSchema = z.object({
  key: z.string().regex(/^[a-z-]{1,40}:\d{1,2}$/u),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  failures: z.number().int().min(0),
  acknowledgedAt: z.string().datetime(),
}).strict();
const receiptsSchema = z.object({ receipts: z.array(receiptSchema).max(64) }).strict();
type Receipt = z.infer<typeof receiptSchema>;

export const healthKey = (item: Pick<HealthItem, 'feature' | 'ordinal'>): string => `${item.feature}:${item.ordinal ?? 0}`;

/** One problem: its code and latest failure time. A count is compared separately, so only more failures bring it back. */
export const healthFingerprint = (item: HealthItem): string =>
  createHash('sha256').update(JSON.stringify([healthKey(item), item.errorCode, item.lastFailureAt])).digest('hex');

const acknowledged = (item: HealthItem, receipt: Receipt | undefined): boolean =>
  receipt !== undefined && receipt.fingerprint === healthFingerprint(item) && item.failures <= receipt.failures;

/** Marks acknowledged problems, which no longer count as issues, and keeps only receipts for problems still shown. */
export const applyHealthReceipts = (snapshot: HealthSnapshot, receipts: readonly Receipt[]): { snapshot: HealthSnapshot; kept: Receipt[] } => {
  const byKey = new Map(receipts.map(receipt => [receipt.key, receipt]));
  const items = snapshot.items.map(item => item.state !== 'failing' ? item : {
    ...item, fingerprint: healthFingerprint(item), ...(acknowledged(item, byKey.get(healthKey(item))) ? { acknowledged: true } : {}),
  });
  // A recovered or changed problem drops its receipt, so the same code failing again is shown again.
  const kept = receipts.filter(receipt => items.some(item => item.fingerprint === receipt.fingerprint && healthKey(item) === receipt.key));
  return { snapshot: { ...snapshot, items, issues: items.filter(item => item.state === 'failing' && !item.acknowledged).length }, kept };
};

/** The owner's 「知道了」 on 运行状态. Suppresses reporting without changing the feature itself. */
export class HealthReceipts {
  readonly #store: AtomicJsonStore<{ receipts: Receipt[] }>;
  #receipts: Receipt[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.#store = new AtomicJsonStore({ path, schemaVersion: 1, schema: receiptsSchema, defaultValue: () => ({ receipts: [] }) });
  }

  apply(snapshot: HealthSnapshot): Promise<HealthSnapshot> {
    return this.#serial(async receipts => {
      const result = applyHealthReceipts(snapshot, receipts);
      if (result.kept.length !== receipts.length) await this.#save(result.kept);
      return result.snapshot;
    });
  }

  acknowledge(input: HealthAcknowledge, snapshot: HealthSnapshot): Promise<HealthSnapshot> {
    return this.#serial(async receipts => {
      const { snapshot: current, kept } = applyHealthReceipts(snapshot, receipts);
      const item = current.items.find(entry => entry.state === 'failing' && healthKey(entry) === input.key && entry.fingerprint === input.fingerprint);
      // The page showed an older revision of this problem; it must see the new one first.
      if (!item) throw new Error('health.stale');
      const next = [...kept.filter(receipt => receipt.key !== input.key),
        { key: input.key, fingerprint: input.fingerprint, failures: item.failures, acknowledgedAt: this.now().toISOString() }];
      await this.#save(next);
      return applyHealthReceipts(snapshot, next).snapshot;
    });
  }

  async #save(receipts: Receipt[]): Promise<void> {
    this.#receipts = receipts;
    await this.#store.save({ receipts });
  }

  #serial<T>(work: (receipts: Receipt[]) => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      // An unreadable file only loses acknowledgements, so problems are shown again rather than hidden.
      this.#receipts ??= (await this.#store.load().catch(() => ({ receipts: [] }))).receipts;
      return work(this.#receipts);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
