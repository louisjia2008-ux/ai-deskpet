import { describe, expect, it } from 'vitest';
import type { ChatCronRun, ChatCronSchedule } from '../../shared/chat-cron';
import type { KnowledgeStatus } from '../../shared/knowledge';
import type { MemorySleepStatus } from '../../shared/memory-sleep';
import type { QqChannelStatus } from '../../shared/qq-channel';
import type { TelegramChannelStatus } from '../../shared/telegram-channel';
import { wechatChannelStateSchema, type WeChatChannelState } from '../../shared/wechat-channel';
import { doctorFindings } from './doctor';
import { buildHealth, proactiveHealth } from './health';
import { defaultAutomationProactive } from '../../shared/automation-schemas';
import type { AutomaticTrigger } from '../../shared/automation';
import type { HealthInputs } from './health';

const now = new Date('2026-11-14T13:00:00.000Z');
const sleep = (patch: Partial<MemorySleepStatus> = {}): MemorySleepStatus => ({ settings: { enabled: true, hour: 3, timezone: 'Asia/Shanghai' },
  running: false, lastRunAt: null, lastError: null, lastFailureAt: null, shallow: 0, deep: 0, reports: [], ...patch });
const schedule = (id: string, patch: Partial<ChatCronSchedule> = {}): ChatCronSchedule => ({ id, sessionId: 's', providerId: 'p', model: 'm', title: id, instruction: 'x',
  expression: '0 7 * * *', timezone: 'Asia/Shanghai', allowedCapabilities: [], missedPolicy: 'skip', enabled: true, revision: 1, nextRunAt: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', cancelledAt: null, ...patch });
const run = (scheduleId: string, status: ChatCronRun['status'], finishedAt: string, errorCode: string | null = null): ChatCronRun => ({ id: `${scheduleId}-${finishedAt}`,
  key: 'k', scheduleId, sessionId: 's', scheduleRevision: 1, dueAt: finishedAt, status, createdAt: finishedAt, startedAt: finishedAt, finishedAt, errorCode });
const wechat = (patch: Partial<WeChatChannelState> = {}): WeChatChannelState => ({ configured: true, groupName: null, state: 'running', stale: false, paused: false,
  privateStatus: 'ready', groupStatus: 'ready', pending: 0, uncertain: 0, groupPolicy: { mode: 'mentions', sender: null }, groups: [], groupBindingSupported: true,
  reply: { model: 'm', split: false, stickers: false }, ...patch });
const off = { enabled: false, connection: 'disabled', lastError: null, uncertainOutbox: 0 };
const inputs = (patch: Partial<HealthInputs> = {}): HealthInputs => ({ now,
  autoMemory: { enabled: true, lastSuccessAt: null, lastFailureAt: null, errorCode: null, failures: 0 }, memorySleep: sleep(), knowledge: null, schedules: [], runs: [], wechat: null,
  qq: { ...off, stopped: false, failedOutbox: 0 } as unknown as QqChannelStatus, telegram: off as unknown as TelegramChannelStatus, ...patch });
const state = (input: HealthInputs) => Object.fromEntries(buildHealth(input).items.map((entry) => [entry.feature, entry.state]));

describe('background health', () => {
  it('reports a detached, healthy, stale, missing-model and failed knowledge index using safe diagnostics', () => {
    const status: KnowledgeStatus = {
      vaultName: 'SYNTHETIC_VAULT_NAME', indexing: false, indexedNotes: 2, indexedChunks: 3, checkedNotes: 2,
      changedNotes: 0, removedNotes: 0, skippedNotes: 0, lastIndexedAt: '2026-11-13T13:00:00.000Z',
      lastIndexFailureAt: null, consecutiveIndexFailures: 0, lastError: null,
      embeddingModel: 'nomic-embed-text', embeddingStatus: 'installed', autoIndex: true,
      diarySync: { enabled: false, folder: 'SYNTHETIC_DIARY_TITLE' }, retainedInvalidDiaries: 0,
    };
    const knowledgeHealth = (patch: Partial<KnowledgeStatus>) =>
      buildHealth(inputs({ knowledge: { ...status, ...patch } })).items.find(item => item.feature === 'knowledge');
    expect(knowledgeHealth({ vaultName: null })).toMatchObject({ state: 'off', lastSuccessAt: null });
    expect(knowledgeHealth({ lastIndexedAt: null })).toMatchObject({ state: 'waiting' });
    expect(knowledgeHealth({})).toMatchObject({ state: 'ok', lastSuccessAt: '2026-11-13T13:00:00.000Z' });
    const retainedCopies = knowledgeHealth({ retainedInvalidDiaries: 2 });
    expect(retainedCopies).toMatchObject({ state: 'ok', retainedInvalidDiaries: 2, errorCode: null });
    expect(JSON.stringify(retainedCopies)).not.toMatch(/SYNTHETIC_/u);
    expect(knowledgeHealth({ retainedInvalidDiaries: -1 })).not.toHaveProperty('retainedInvalidDiaries');
    expect(knowledgeHealth({ lastIndexedAt: '2026-11-13T12:59:59.000Z' }))
      .toMatchObject({ state: 'failing', errorCode: 'knowledge.indexStale' });
    expect(knowledgeHealth({ embeddingStatus: 'missing', lastError: 'knowledge.ollamaUnavailable' }))
      .toMatchObject({ state: 'failing', errorCode: 'knowledge.embeddingModelMissing' });
    const failing = knowledgeHealth({ lastIndexFailureAt: 'SYNTHETIC_PRIVATE_PATH', lastError: 'knowledge.SyntheticPrivateTitle',
      consecutiveIndexFailures: 2 });
    expect(failing).toMatchObject({ state: 'failing', errorCode: 'knowledge.indexFailed', lastFailureAt: null, failures: 2 });
    expect(JSON.stringify(failing)).not.toMatch(/SYNTHETIC_|PrivateTitle/u);
  });

  it('does not call a committed proactive result delivered when the channel failed, and recovers on a later success', () => {
    const stamp = now.toISOString();
    const failed: AutomaticTrigger = { id: 'failed', key: 'failed', kind: 'proactive', sourceId: 'care:morning', dueAt: stamp,
      policyRevision: 1, status: 'succeeded', jobId: 'job', messageId: 'message', createdAt: stamp, updatedAt: stamp,
      cancelledAt: null, publishedAt: stamp, errorCode: 'proactive.deliveryUncertain' };
    const input = { policy: { ...defaultAutomationProactive(), enabled: true, timezone: 'UTC' }, triggers: [failed], now: now.getTime(),
      errorCode: null, lastFailureAt: null, pausedByError: false };
    expect(proactiveHealth(input)).toMatchObject({ state: 'failing', lastSuccessAt: null, lastFailureAt: stamp, remainingToday: 1 });
    const later = new Date(now.getTime() + 1000).toISOString();
    expect(proactiveHealth({ ...input, triggers: [{ ...failed, id: 'sent', updatedAt: later, publishedAt: later, errorCode: null }, failed] }))
      .toMatchObject({ state: 'ok', lastSuccessAt: later, lastFailureAt: stamp, remainingToday: 0, errorCode: null });
    expect(proactiveHealth({ ...input, triggers: [], errorCode: 'proactive.screenUnknown', lastFailureAt: stamp }))
      .toMatchObject({ state: 'failing', lastFailureAt: stamp, errorCode: 'proactive.screenUnknown' });
  });
  it('names a provider that keeps refusing auto memory, as on 2026-11-14', () => {
    const snapshot = buildHealth(inputs({ autoMemory: { enabled: true, lastSuccessAt: null, lastFailureAt: '2026-11-14T12:36:33.000Z', errorCode: 'provider.unsupportedParameter', failures: 2 } }));
    expect(snapshot.items[0]).toEqual({ feature: 'auto-memory', state: 'failing', lastSuccessAt: null, lastFailureAt: '2026-11-14T12:36:33.000Z',
      errorCode: 'provider.unsupportedParameter', failures: 2, sinceLaunch: true });
    expect(snapshot.issues).toBe(1);
  });

  it('treats a success after the failure as recovered, and nothing tried yet as waiting', () => {
    expect(state(inputs({ autoMemory: { enabled: true, lastSuccessAt: '2026-11-14T12:40:00.000Z', lastFailureAt: '2026-11-14T12:36:33.000Z', errorCode: null, failures: 0 } }))['auto-memory']).toBe('ok');
    expect(state(inputs())).toMatchObject({ 'auto-memory': 'waiting', 'memory-sleep': 'waiting', schedules: 'off', wechat: 'off', qq: 'off', telegram: 'off' });
    expect(buildHealth(inputs()).issues).toBe(0);
  });

  it('reports the nightly tidy-up from its stored last run and its last error', () => {
    expect(buildHealth(inputs({ memorySleep: sleep({ lastRunAt: '2026-11-13T19:00:00.000Z' }) })).items[1]).toMatchObject({ state: 'ok', lastSuccessAt: '2026-11-13T19:00:00.000Z' });
    expect(buildHealth(inputs({ memorySleep: sleep({ lastError: 'sleep.noProvider' }) })).items[1]).toMatchObject({ state: 'failing', errorCode: 'sleep.noProvider' });
    expect(state(inputs({ memorySleep: sleep({ settings: { enabled: false, hour: 3, timezone: 'UTC' }, lastError: 'sleep.failed' }) }))['memory-sleep']).toBe('off');
  });

  it('judges each schedule by its own latest run, and does not count a missed run against it', () => {
    const schedules = [schedule('a'), schedule('b'), schedule('gone', { cancelledAt: '2026-11-02T00:00:00.000Z' })];
    const runs = [run('a', 'succeeded', '2026-11-14T07:00:00.000Z'), run('b', 'failed', '2026-11-13T07:00:00.000Z', 'provider.timeout'),
      run('b', 'missed', '2026-11-14T07:00:00.000Z'), run('gone', 'failed', '2026-11-14T08:00:00.000Z'), run('b', 'failed', '2026-11-01T07:00:00.000Z')];
    expect(buildHealth(inputs({ schedules, runs })).items[2]).toEqual({ feature: 'schedules', state: 'failing', lastSuccessAt: '2026-11-14T07:00:00.000Z',
      lastFailureAt: '2026-11-13T07:00:00.000Z', errorCode: 'provider.timeout', failures: 1, sinceLaunch: false });
    expect(state(inputs({ schedules, runs: [...runs, run('b', 'succeeded', '2026-11-14T09:00:00.000Z')] })).schedules).toBe('ok');
  });

  it('flags a stuck WeChat listener and replies whose delivery is unconfirmed, but not a paused one', () => {
    expect(buildHealth(inputs({ wechat: wechat({ state: 'degraded', privateStatus: 'desktop_or_state_unverified' }) })).items[3])
      .toMatchObject({ state: 'failing', errorCode: 'wechat.desktop_or_state_unverified' });
    expect(buildHealth(inputs({ wechat: wechat({ stale: true }) })).items[3]).toMatchObject({ state: 'failing', errorCode: 'wechat.stale' });
    expect(buildHealth(inputs({ wechat: wechat({ dropped: 2, droppedAt: 1_794_724_000 }) })).items[3])
      .toMatchObject({ state: 'failing', errorCode: 'wechat.dropped', failures: 2, lastFailureAt: new Date(1_794_724_000_000).toISOString() });
    expect(buildHealth(inputs({ wechat: wechat({ dropped: 0, droppedAt: null }) })).items[3]).toMatchObject({ state: 'ok' });
    expect(buildHealth(inputs({ wechat: wechat({ uncertain: 1, groups: [{ id: 'g', title: 'g', policy: { mode: 'mentions', sender: null }, status: 'ready', pending: 0, uncertain: 2 }] }) })).items[3])
      .toMatchObject({ state: 'failing', errorCode: 'wechat.uncertain', failures: 3 });
    expect(state(inputs({ wechat: wechat() })).wechat).toBe('ok');
    expect(state(inputs({ wechat: wechat({ paused: true, state: 'paused' }) })).wechat).toBe('off');
  });

  it('reports a fixed WeChat send diagnosis to the doctor without accepting free-form worker text', () => {
    const diagnosed = wechat({ state: 'degraded', privateStatus: 'send_uncertain', uncertain: 1, sendReason: 'send_receipt_unconfirmed' });
    const health = buildHealth(inputs({ wechat: diagnosed }));
    expect(health.items.find(({ feature }) => feature === 'wechat'))
      .toMatchObject({ errorCode: 'wechat.send_receipt_unconfirmed', state: 'failing', failures: 1 });
    expect(doctorFindings(health, { wechat: diagnosed, diskFreeBytes: null, uncleanExitOf: null }))
      .toEqual([{ key: 'wechat:wechat.send_receipt_unconfirmed', feature: 'wechat', code: 'wechat.send_receipt_unconfirmed',
        event: false, severity: 'warning', detail: '1' }]);
    const unsafe = wechatChannelStateSchema.parse({ ...diagnosed, sendReason: 'synthetic-secret' });
    expect(unsafe.sendReason).toBeNull();
    expect(buildHealth(inputs({ wechat: { ...diagnosed, stale: true } })).items[3]?.errorCode).toBe('wechat.stale');
  });

  it('reports each WeChat friend using only an ordinal, counts, and fixed codes', () => {
    const channel = wechat({ friendStatuses: [{ status: 'friend_rate_limited', pending: 2, uncertain: 0 },
      { status: 'friend_send_uncertain', pending: 0, uncertain: 1 }, { status: 'friend_binding_invalid', pending: 0, uncertain: 0 }] });
    const health = buildHealth(inputs({ wechat: channel }));
    expect(health.items.filter(item => item.feature === 'wechat-friend-reply')).toMatchObject([
      { ordinal: 1, state: 'failing', errorCode: 'wechat.friend_rate_limited' },
      { ordinal: 2, state: 'failing', errorCode: 'wechat.friend_send_uncertain' },
      { ordinal: 3, state: 'failing', errorCode: 'wechat.friend_binding_invalid' },
    ]);
    expect(doctorFindings(health, { wechat: channel, diskFreeBytes: null, uncleanExitOf: null }).map(item => item.key)).toEqual([
      'wechat-friend-reply:1:wechat.friend_rate_limited', 'wechat-friend-reply:2:wechat.friend_send_uncertain',
      'wechat-friend-reply:3:wechat.friend_binding_invalid',
    ]);
    expect(wechatChannelStateSchema.safeParse({ ...channel, friendStatuses: [{ ...channel.friendStatuses![0], title: 'Fixture name' }] }).success).toBe(false);
  });

  it('flags a channel that is offline or holding unsent messages', () => {
    const qq = (patch: object) => ({ ...off, enabled: true, stopped: false, failedOutbox: 0, connection: 'online', ...patch }) as unknown as QqChannelStatus;
    expect(buildHealth(inputs({ qq: qq({ connection: 'offline', lastError: 'qq.gatewayClosed' }) })).items[4]).toMatchObject({ state: 'failing', errorCode: 'qq.gatewayClosed' });
    expect(buildHealth(inputs({ qq: qq({ failedOutbox: 2, uncertainOutbox: 1 }) })).items[4]).toMatchObject({ state: 'failing', errorCode: 'qq.deliveryFailed', failures: 3 });
    expect(state(inputs({ qq: qq({}) })).qq).toBe('ok');
    expect(state(inputs({ qq: qq({ stopped: true, connection: 'offline' }) })).qq).toBe('off');
  });
});
