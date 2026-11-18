// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthItem, HealthSnapshot } from '../../shared/attention';
import { HealthReceipts, applyHealthReceipts, healthFingerprint } from './health-receipts';

const entry = (feature: HealthItem['feature'], state: HealthItem['state'], patch: Partial<HealthItem> = {}): HealthItem =>
  ({ feature, state, lastSuccessAt: null, lastFailureAt: null, errorCode: null, failures: 0, sinceLaunch: false, ...patch });
const snapshot = (...items: HealthItem[]): HealthSnapshot =>
  ({ checkedAt: '2026-11-16T12:00:00.000Z', items, issues: items.filter(item => item.state === 'failing').length });
const dropped = (patch: Partial<HealthItem> = {}) =>
  entry('wechat', 'failing', { errorCode: 'wechat.dropped', failures: 1, lastFailureAt: '2026-11-16T04:20:00.000Z', ...patch });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const store = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-health-'));
  roots.push(root);
  return { path: join(root, 'health-receipts.json'), receipts: new HealthReceipts(join(root, 'health-receipts.json'), () => new Date('2026-11-16T12:30:00.000Z')) };
};

describe('health acknowledgements', () => {
  it('clears the badge for the exact problem and keeps it on the page as seen', async () => {
    const f = await store();
    const first = await f.receipts.apply(snapshot(dropped(), entry('qq', 'ok')));
    expect(first.issues).toBe(1);
    const item = first.items[0]!;
    const after = await f.receipts.acknowledge({ key: 'wechat:0', fingerprint: item.fingerprint! }, snapshot(dropped(), entry('qq', 'ok')));
    expect(after.issues).toBe(0);
    expect(after.items[0]).toMatchObject({ state: 'failing', acknowledged: true });
    // Survives a restart.
    const reopened = new HealthReceipts(f.path);
    expect((await reopened.apply(snapshot(dropped()))).issues).toBe(0);
    expect(JSON.parse(await readFile(f.path, 'utf8')).data.receipts).toHaveLength(1);
  });

  it('brings the problem back when it grows, changes, or recovers and fails again', () => {
    const receipts = [{ key: 'wechat:0', fingerprint: healthFingerprint(dropped()), failures: 1, acknowledgedAt: '2026-11-16T12:30:00.000Z' }];
    expect(applyHealthReceipts(snapshot(dropped()), receipts).snapshot.issues).toBe(0);
    expect(applyHealthReceipts(snapshot(dropped({ failures: 2 })), receipts).snapshot.issues).toBe(1);
    expect(applyHealthReceipts(snapshot(dropped({ lastFailureAt: '2026-11-16T13:00:00.000Z' })), receipts).snapshot.issues).toBe(1);
    expect(applyHealthReceipts(snapshot(dropped({ errorCode: 'wechat.uncertain' })), receipts).snapshot.issues).toBe(1);
    // An older drop ageing out is not news.
    const seenTwo = [{ ...receipts[0]!, fingerprint: healthFingerprint(dropped({ failures: 2 })), failures: 2 }];
    expect(applyHealthReceipts(snapshot(dropped({ failures: 1 })), seenTwo).snapshot.issues).toBe(0);
    // Recovery forgets the receipt, so the same code failing later is shown again.
    expect(applyHealthReceipts(snapshot(entry('wechat', 'ok')), receipts).kept).toEqual([]);
  });

  it('keeps friends apart and refuses a revision the page did not show', async () => {
    const f = await store();
    const friends = snapshot(entry('wechat-friend-reply', 'failing', { ordinal: 1, errorCode: 'wechat.friend_rate_limited', failures: 1 }),
      entry('wechat-friend-reply', 'failing', { ordinal: 2, errorCode: 'wechat.friend_rate_limited', failures: 1 }));
    const shown = await f.receipts.apply(friends);
    const after = await f.receipts.acknowledge({ key: 'wechat-friend-reply:2', fingerprint: shown.items[1]!.fingerprint! }, friends);
    expect(after.items.map(item => item.acknowledged ?? false)).toEqual([false, true]);
    await expect(f.receipts.acknowledge({ key: 'wechat:0', fingerprint: shown.items[0]!.fingerprint! }, friends)).rejects.toThrow('health.stale');
    await expect(f.receipts.acknowledge({ key: 'wechat-friend-reply:1', fingerprint: 'f'.repeat(64) }, friends)).rejects.toThrow('health.stale');
  });
});
