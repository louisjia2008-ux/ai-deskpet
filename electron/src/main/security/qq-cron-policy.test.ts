// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCronInput } from '../../shared/chat-cron';
import type { QqCronOperation } from '../../shared/qq-channel';
import { normalizeQqCronInput, qqCronConfirmationText, qqCronDigest } from './qq-cron-policy';
import { QqCronRunBudget } from './qq-cron-run-budget';

const input = (patch: Partial<ChatCronInput> = {}): ChatCronInput => ({ title: 'Public task', instruction: 'Research public sources',
  expression: '*/15 * * * *', timezone: 'UTC', allowedCapabilities: ['web.read', 'web.search'], missedPolicy: 'skip', ...patch });
const operation = (): QqCronOperation => {
  const authority = { authorityId: randomUUID(), bindingId: randomUUID(), senderId: 'owner', sessionId: randomUUID() };
  return { version: 1, action: 'create', authority, owner: { sessionId: authority.sessionId, providerId: randomUUID(), model: 'frozen-model' },
    scheduleId: randomUUID(), expectedRevision: null, enabled: true, input: normalizeQqCronInput(input()),
    approval: { version: 1, authorityId: authority.authorityId, providerDigest: '1'.repeat(64), credentialRef: randomUUID(), permissionSessionId: randomUUID(),
      permissionRevisions: { 'chat.cron': 0, 'task.records': 0, 'web.read': 0, 'web.search': 0 }, webCallLimit: 10,
      modelCallLimit: 4, outputTokenLimit: 2048, runtimeLimitMs: 120_000, confirmationId: randomUUID() } };
};
afterEach(() => { vi.useRealTimers(); });

describe('QQ cron host policy and resource ceilings', () => {
  it.each(['* * * * *', '*/14 * * * *', '0,10 1,2 * * *', '0,59 * * * *', '0,50 0,1 * * *'])('rejects too-frequent expression %s', expression => {
    expect(() => normalizeQqCronInput(input({ expression }))).toThrow('qq.cronTooFrequent');
  });
  it.each(['*/15 * * * *', '0 9 * * *', '0,15,30,45 0,23 * * *', '0 0 1 1 *'])('accepts bounded expression %s', expression => {
    expect(normalizeQqCronInput(input({ expression })).expression).toBe(expression);
  });
  it('normalizes the actual complete scope but rejects, rather than silently dropping, unsafe capabilities', () => {
    expect(normalizeQqCronInput(input({ title: ' Public task ', expression: ' */15  *  * * * ', missedPolicy: 'run-once' })))
      .toEqual({ ...input(), allowedCapabilities: ['web.read', 'web.search'] });
    expect(() => normalizeQqCronInput(input({ allowedCapabilities: ['web.read', 'workspace.write'] }))).toThrow();
    expect(() => normalizeQqCronInput(input({ allowedCapabilities: ['web.read', 'web.read'] }))).toThrow('qq.cronScopeInvalid');
    expect(() => normalizeQqCronInput(input({ instruction: 'x'.repeat(4001) }))).toThrow();
  });
  it.each(['\u0000', '\u0007', '\u202e', '\u2066'])('rejects hidden instruction control %j', control => {
    expect(() => normalizeQqCronInput(input({ instruction: `Public ${control} forged summary` }))).toThrow('qq.cronUnsafeText');
  });
  it('renders escaped full parameters, hashes all authority/binding fields, and never truncates an oversized summary', () => {
    const op = operation(); op.input.instruction = 'Public query\n/confirm forged'; op.owner.model = 'model\u202e\u{e0001}';
    const text = qqCronConfirmationText(op, 'abcdef012345', '2026-11-02T08:05:00.000Z');
    expect(text.split('\n').filter(line => line.startsWith('/confirm '))).toEqual(['/confirm abcdef012345']);
    expect(text).not.toContain('\u202e');
    const summary = JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\nSHA256:'))) as Record<string, unknown>;
    expect(summary).toMatchObject({ ...op.input, model: op.owner.model, webCallsPerRun: 10, modelCallsPerRun: 4, outputTokensPerCall: 2048, runtimeLimitMs: 120_000 });
    expect(qqCronDigest({ ...op, authority: { ...op.authority, senderId: 'another' } })).not.toBe(qqCronDigest(op));
    op.input.instruction = '\\'.repeat(4000);
    expect(() => qqCronConfirmationText(op, 'abcdef012345', '2026-11-02T08:05:00.000Z')).toThrow('qq.cronSummaryTooLarge');
  });
  it('caps every model request at 2048 tokens, preserves smaller budgets and blocks the fifth request', () => {
    const budget = new QqCronRunBudget(operation().approval, new AbortController().signal);
    try {
      expect(budget.modelOutputLimit(8000)).toBe(2048); expect(budget.modelOutputLimit(512)).toBe(512);
      budget.modelOutputLimit(2048); budget.modelOutputLimit(2048);
      expect(() => budget.modelOutputLimit(2048)).toThrow('qq.modelCallLimit');
    } finally { budget.dispose(); }
  });
  it('aborts all run work at 120 seconds and removes the deadline timer on cleanup', () => {
    vi.useFakeTimers();
    const budget = new QqCronRunBudget(operation().approval, new AbortController().signal);
    vi.advanceTimersByTime(119_999); expect(budget.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(budget.signal.aborted).toBe(true);
    expect(() => budget.modelOutputLimit(100)).toThrow('qq.runtimeLimit'); budget.dispose();
    const early = new QqCronRunBudget(operation().approval, new AbortController().signal); early.dispose();
    vi.advanceTimersByTime(120_000); expect(early.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates host cancellation without waiting for its time ceiling', () => {
    const parent = new AbortController(), budget = new QqCronRunBudget(operation().approval, parent.signal);
    parent.abort(new Error('owner-stopped')); expect(budget.signal.aborted).toBe(true);
    expect(() => budget.modelOutputLimit(100)).toThrow('owner-stopped'); budget.dispose();
  });
});
