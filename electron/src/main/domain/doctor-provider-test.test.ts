import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { DoctorProviderTestRecord } from '../../shared/doctor';
import type { ProviderAdapter, ProviderChatRequest } from '../providers/types';
import { DoctorModel } from './doctor-model';
import { providerTestFindings } from './doctor-provider-test';
import { DoctorService } from './doctor-service';
import { compactWeChatCheckup } from './doctor-wechat-checkup';

const cloud: ProviderConfig = { id: 'fixture', name: 'Fixture', kind: 'openai-compatible', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, supportsTools: false, secretState: 'configured' };
const record = (day: string, status: DoctorProviderTestRecord['status'] = 'failed', durationMs = 10): DoctorProviderTestRecord =>
  ({ day, at: `${day}T07:00:00.000Z`, status, code: status === 'failed' ? 'provider.authentication' : null, durationMs });

it('requires two consecutive calendar days of failure; one pass recovers', () => {
  expect(providerTestFindings([record('2026-11-17')])).toEqual([]);
  expect(providerTestFindings([record('2026-11-16'), record('2026-11-17')])[0]?.code).toBe('provider.selfTestFailed');
  expect(providerTestFindings([record('2026-11-15'), record('2026-11-17')])).toEqual([]);
  expect(providerTestFindings([record('2026-11-16'), record('2026-11-17', 'passed')])).toEqual([]);
  expect(providerTestFindings([record('2026-11-17', 'passed', 30_000)])).toEqual([]);
  expect(providerTestFindings([record('2026-11-17', 'passed', 30_001)])).toEqual([]);
  expect(providerTestFindings([record('2026-11-17', 'skipped', 40_000)])).toEqual([]);
});

it('requires adjacent local dates both strictly over 30 seconds, excluding skipped probes', () => {
  const slow = (records: DoctorProviderTestRecord[]) => providerTestFindings(records).some(item => item.code === 'provider.selfTestSlow');
  expect(slow([record('2026-11-16', 'passed', 30_001), record('2026-11-17', 'passed', 40_000)])).toBe(true);
  expect(slow([record('2026-11-16', 'failed', 40_000), record('2026-11-17', 'passed', 40_000)])).toBe(true);
  expect(slow([record('2026-11-16', 'passed', 30_000), record('2026-11-17', 'passed', 40_000)])).toBe(false);
  expect(slow([record('2026-11-16', 'passed', 40_000), record('2026-11-17', 'passed', 30_000)])).toBe(false);
  expect(slow([record('2026-11-15', 'passed', 40_000), record('2026-11-17', 'passed', 40_000)])).toBe(false);
  expect(slow([record('2026-11-17', 'passed', 40_000), record('2026-11-17', 'passed', 40_000)])).toBe(false);
  expect(slow([record('2026-11-16', 'skipped', 40_000), record('2026-11-17', 'passed', 40_000)])).toBe(false);
  expect(slow([record('2026-11-16', 'passed', 40_000), record('2026-11-17', 'skipped', 40_000)])).toBe(false);
});

it('opens a slow-provider case on the second date and recovers after the next fast daily probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-provider-slow-'));
  try {
    let now = new Date('2026-11-17T09:00:00Z'), durationMs = 40_000;
    const probe = vi.fn(async () => ({ status: 'passed' as const, code: null, durationMs }));
    const sendQq = vi.fn(async () => true);
    const doctor = new DoctorService({ path: join(root, 'doctor.json'), now: () => now, timeZone: 'UTC', available: () => true, changed: () => undefined,
      diskFree: async () => null, inputs: async () => ({ health: { items: [], issues: 0, checkedAt: now.toISOString() }, wechat: null }),
      sendQq, notifyDesktop: () => true, providerTest: probe });
    await doctor.initialize(); await doctor.check(); await doctor.check();
    expect(doctor.status().open).toBe(0);
    now = new Date('2026-11-18T09:00:00Z'); await doctor.check(); await doctor.check();
    expect(doctor.status().cases).toEqual([expect.objectContaining({ code: 'provider.selfTestSlow', reported: 'qq' })]);
    durationMs = 10; now = new Date('2026-11-19T09:00:00Z'); await doctor.check();
    expect(doctor.status().open).toBe(0);
    expect(sendQq).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(3);
    await doctor.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('probes the remote binding with a tiny history-free request and records only whitelisted failures', async () => {
  const requests: ProviderChatRequest[] = [];
  let failing = false;
  const adapter: ProviderAdapter = { listModels: async () => [], async *streamChat(request) {
    requests.push(request);
    if (failing) throw Object.assign(new Error('PRIVATE_UPSTREAM_BODY'), { code: 'provider.authentication' });
    yield { type: 'text', text: 'ok' }; yield { type: 'done', finishReason: 'stop' };
  } };
  const model = new DoctorModel({ current: () => cloud, capture: async () => ({ provider: cloud, model: cloud.model, adapter }), acquireLocal: vi.fn() });
  expect(await model.probe(new AbortController().signal)).toMatchObject({ status: 'passed', code: null });
  expect(requests[0]).toMatchObject({ executionMode: 'background-text', maxOutputTokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] });
  failing = true;
  const failed = await model.probe(new AbortController().signal);
  expect(failed).toMatchObject({ status: 'failed', code: 'provider.authentication' });
  expect(JSON.stringify(failed)).not.toContain('PRIVATE');
});

it('does not inspect, generate, query residency or acquire a local slot for an Ollama daily probe', async () => {
  const capture = vi.fn(), request = vi.fn(), acquireLocal = vi.fn();
  const model = new DoctorModel({ current: () => ({ ...cloud, kind: 'ollama' }), capture, fetch: request, acquireLocal });
  expect(await model.probe(new AbortController().signal)).toBeNull();
  expect(capture).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(acquireLocal).not.toHaveBeenCalled();
});

it('runs at most once per local day after 07:00, persists the day across restarts, and never probes on checkup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-provider-'));
  try {
    let now = new Date('2026-11-17T06:59:00Z');
    const probe = vi.fn(async () => ({ status: 'failed' as const, code: 'provider.authentication' as const, durationMs: 10 }));
    const deps = { path: join(root, 'doctor.json'), now: () => now, timeZone: 'UTC', available: () => true, changed: () => undefined,
      diskFree: async () => null, inputs: async () => ({ health: { items: [], issues: 0, checkedAt: now.toISOString() }, wechat: null }),
      sendQq: vi.fn(async () => true), notifyDesktop: () => true, providerTest: probe };
    const doctor = new DoctorService(deps); await doctor.initialize();
    await doctor.check(); expect(probe).not.toHaveBeenCalled();
    now = new Date('2026-11-17T10:00:00Z'); await doctor.check(); await doctor.check();
    expect(probe).toHaveBeenCalledTimes(1); expect(doctor.status().open).toBe(0);
    await doctor.shutdown();
    const restarted = new DoctorService(deps); await restarted.initialize(); await restarted.check();
    expect(probe).toHaveBeenCalledTimes(1);
    now = new Date('2026-11-18T07:00:00Z'); await restarted.check(); await restarted.check();
    expect(restarted.status().cases[0]).toMatchObject({ code: 'provider.selfTestFailed', reported: 'held' });
    await restarted.checkup(); expect(probe).toHaveBeenCalledTimes(2);
    expect(deps.sendQq).not.toHaveBeenCalled(); // held until the 08:00 digest
    now = new Date('2026-11-18T08:00:00Z'); await restarted.check();
    expect(deps.sendQq).toHaveBeenCalledOnce();
    await restarted.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('compacts long WeChat checkups while retaining VM facts, diagnosis and abnormal summary within 500 characters', () => {
  const text = ['【医生】体检结果', '异常 20 项：', ...Array.from({ length: 20 }, (_, n) => `- 异常类型 ${n}：${'合成故障'.repeat(20)}`),
    '正常：' + '合成功能'.repeat(100), '微信虚拟机：磁盘剩余 20 GB，日志 1 MB。', '医生的看法：有几个独立问题，先检查微信窗口。'].join('\n');
  const result = compactWeChatCheckup(text);
  expect([...result].length).toBeLessThanOrEqual(500);
  expect(result).toContain('异常 20 项'); expect(result).toContain('微信虚拟机'); expect(result).toContain('医生的看法');
  expect(result).not.toContain('正常：');
});
