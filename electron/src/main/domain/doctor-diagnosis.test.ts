import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { DOCTOR_CODES, doctorVmStateSchema, safeDoctorDiagnosis, type DoctorCase } from '../../shared/doctor';
import type { ProviderChatRequest, ProviderStreamEvent } from '../providers/types';
import { doctorFindings, formatDoctorReport, planDoctorReport, reconcileDoctor, type DoctorFinding } from './doctor';
import { doctorDeadline, doctorDiagnosisInput } from './doctor-diagnosis';
import { DoctorModel } from './doctor-model';
import { DOCTOR_GROUP_RULES, DOCTOR_RUNBOOK, groupDoctorProblems } from './doctor-runbook';
import { DoctorService } from './doctor-service';

const now = new Date('2026-11-17T12:00:00Z');
const finding = (code: string): DoctorFinding => ({ key: `wechat:${code}`, feature: code.startsWith('provider.') ? 'auto-memory' : 'wechat', code,
  severity: 'error', event: false, detail: null });
const facts = (cases: DoctorCase[] = []) => ({ cases, selfTests: [], vm: doctorVmStateSchema.parse({}), diskFreeBytes: 1234, startedAt: now.toISOString(), uncleanExit: false });
const input = () => doctorDiagnosisInput(facts(), now);
const cloud: ProviderConfig = { id: 'fixture', kind: 'openai-compatible', model: 'fixture', name: 'Private configured name', baseUrl: 'https://fixture.invalid/v1', enabled: true, supportsTools: false, secretState: 'configured' };

describe('doctor runbook, grouping and privacy', () => {
  it('has fixed useful entries for every known code and covers every grouping rule', () => {
    expect(Object.keys(DOCTOR_RUNBOOK).sort()).toEqual(Object.keys(DOCTOR_CODES).sort());
    for (const entry of Object.values(DOCTOR_RUNBOOK)) {
      expect(entry.causes.length).toBeGreaterThan(0); expect(entry.causes.length).toBeLessThanOrEqual(3);
      expect(entry.actions.length).toBeGreaterThan(0); expect(entry.actions.length).toBeLessThanOrEqual(2);
    }
    for (const rule of DOCTOR_GROUP_RULES) {
      const entries = rule.include.map(code => ({ code }));
      const groups = groupDoctorProblems(entries);
      expect(groups[0]?.title).toBe(rule.title);
      expect(groups[0]?.entries).toHaveLength(entries.length);
      expect(groupDoctorProblems([{ code: rule.all[0] }])[0]?.title).toBeNull();
    }
    const cases = reconcileDoctor([], ['wechat.stale', 'wechat.vmUnreachable', 'wechat.selfTestFailed', 'provider.quota'].map(finding), now);
    const text = formatDoctorReport({ problems: cases, recovered: [], digest: false });
    expect(text).toContain('发现 2 个问题');
    expect(text).toContain('微信虚拟机可能整体不可用');
    expect(text).toContain('额度');
  });

  it('merges a new symptom with an already reported open root-cause symptom', () => {
    const cases = reconcileDoctor([], ['wechat.stale', 'wechat.vmUnreachable', 'wechat.selfTestFailed'].map(finding), now)
      .map(entry => ({ ...entry, seen: 2, reported: entry.code === 'wechat.stale' ? 'qq' as const : null }));
    const plan = planDoctorReport(cases, false);
    expect(plan.problems).toHaveLength(3);
    expect(formatDoctorReport(plan)).toContain('发现 1 个问题');
    expect(formatDoctorReport(plan)).toContain('微信虚拟机可能整体不可用');
  });

  it('projects only whitelisted fields; poisoned details, messages and paths cannot enter model facts', () => {
    const cases = reconcileDoctor([], [finding('wechat.stale')], now);
    cases[0]!.detail = 'PRIVATE_CONTACT_AND_CHAT';
    const projected = doctorDiagnosisInput({ ...facts(cases), messages: 'PRIVATE_CHAT', path: 'PRIVATE_PATH' } as ReturnType<typeof facts>, now);
    expect(Object.keys(projected)).toEqual(['open', 'closed', 'selfTests', 'vm', 'diskFreeBytes', 'startedAt', 'uncleanExit', 'runbook', 'groups']);
    expect(Object.keys(projected.open[0]!)).toEqual(['feature', 'code', 'severity', 'detail', 'openedAt', 'seen']);
    expect(projected.open[0]?.detail).toBeNull();
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_|Private configured name|binding|key|reported/u);
    const untrusted = doctorFindings({ checkedAt: now.toISOString(), issues: 1, items: [{ feature: 'wechat', state: 'failing', errorCode: 'PRIVATE_ERROR', failures: 1,
      lastSuccessAt: null, lastFailureAt: null, sinceLaunch: false }] }, { diskFreeBytes: null, uncleanExitOf: null, wechat: null });
    expect(untrusted[0]?.code).toBe('doctor.unknown');
  });

  it.each(['请运行 sudo rm -rf 文件', '请查看 /var/log/auth.log', '打开 https://example.invalid', '运行 `ls`', '打开 C:\\logs', '$ echo ok',
    '请删除日志', '关闭防火墙', '请修改安全设置', '请运行 ls 查看', '请清理日志文件', '请打开 ｈｔｔｐ：／／example.invalid',
    '请查看 ／var／log', '请打开 example.xyz', 'a'.repeat(201), '第一行\n第二行'])('rejects unsafe or overlong diagnosis: %s', text => {
    expect(safeDoctorDiagnosis(text)).toBe(false);
  });
});

describe('doctor model selection', () => {
  const fixture = (events: ProviderStreamEvent[] = [{ type: 'text', text: '可能是一个连接问题。先打开微信虚拟机窗口确认登录状态。' }, { type: 'done', finishReason: 'stop' }]) => {
    const requests: ProviderChatRequest[] = [];
    const capture = vi.fn(async () => ({ provider: cloud, model: cloud.model, adapter: { listModels: async () => [],
      async *streamChat(request: ProviderChatRequest) { requests.push(request); yield* events; } } }));
    const request = vi.fn<typeof fetch>();
    const release = vi.fn();
    const model = new DoctorModel({ current: () => cloud, capture, fetch: request, acquireLocal: async () => release });
    return { model, capture, request, requests, release };
  };

  it('uses current chat binding, text-only limits, no history, and requires a complete result', async () => {
    const f = fixture();
    expect((await f.model.diagnose(input(), false, new AbortController().signal))?.source).toBe('cloud');
    expect(f.capture).toHaveBeenCalledWith(cloud);
    expect(f.requests[0]).toMatchObject({ model: cloud.model, executionMode: 'background-text', maxOutputTokens: 360 });
    expect(f.requests[0]?.tools).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(await fixture([{ type: 'text', text: '未完成' }]).model.diagnose(input(), false, new AbortController().signal)).toBeNull();
    expect(await fixture([{ type: 'tool-call', id: 'x', name: 'x', argumentsJson: '{}' }]).model.diagnose(input(), false, new AbortController().signal)).toBeNull();
  });

  it('provider failure never touches cloud; no resident runner means no generation', async () => {
    const f = fixture();
    f.request.mockResolvedValue(Response.json({ models: [] }));
    expect(await f.model.diagnose(input(), true, new AbortController().signal)).toBeNull();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['http://127.0.0.1:11434/api/ps']);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('only reuses the already loaded completion model, checking residency again immediately before generation', async () => {
    const f = fixture();
    f.request.mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/ps') return Response.json({ models: [{ name: 'resident', context_length: 16384 }] });
      if (path === '/api/show') return Response.json({ capabilities: ['completion'] });
      return Response.json({ done: true, done_reason: 'stop', message: { content: '可能有多个独立问题，先在设置里核对模型服务额度。' } });
    });
    expect(await f.model.diagnose(input(), true, new AbortController().signal)).toMatchObject({ source: 'local' });
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(['/api/ps', '/api/show', '/api/ps', '/api/chat']);
    const body = JSON.parse(String(f.request.mock.calls.at(-1)![1]!.body));
    expect(body.model).toBe('resident');
    expect(body.options).toEqual({ num_predict: 360, num_ctx: 16384 }); // Reuse the runner's exact allocation.
    expect(body).not.toHaveProperty('keep_alive');
  });

  it('does not generate when the resident runner is an embedding model or changes during metadata reads', async () => {
    for (const capabilities of [['embedding'], ['completion']]) {
      const f = fixture(); let ps = 0;
      f.request.mockImplementation(async url => new URL(String(url)).pathname === '/api/show' ? Response.json({ capabilities })
        : Response.json({ models: [{ name: ps++ ? 'changed' : 'resident', context_length: 8192 }] }));
      expect(await f.model.diagnose(input(), true, new AbortController().signal)).toBeNull();
      expect(f.request.mock.calls.some(call => String(call[0]).endsWith('/api/chat'))).toBe(false);
    }
  });

  it('does not switch away from the selected local model just to diagnose', async () => {
    const capture = vi.fn(), request = vi.fn<typeof fetch>(async () => Response.json({ models: [{ name: 'different-resident', context_length: 8192 }] }));
    const model = new DoctorModel({ current: () => ({ ...cloud, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'unloaded-large' }),
      capture, fetch: request, acquireLocal: async () => () => undefined });
    expect(await model.diagnose(input(), false, new AbortController().signal)).toBeNull();
    expect(request).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, -1, 1.5, '8192', true])('skips local diagnosis with missing or invalid resident context: %s', async context_length => {
    const f = fixture();
    f.request.mockResolvedValue(Response.json({ models: [{ name: 'resident', context_length }] }));
    expect(await f.model.diagnose(input(), true, new AbortController().signal)).toBeNull();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('does not generate if context allocation changes before the final residency check', async () => {
    const f = fixture(); let ps = 0;
    f.request.mockImplementation(async url => new URL(String(url)).pathname === '/api/show' ? Response.json({ capabilities: ['completion'] })
      : Response.json({ models: [{ name: 'resident', context_length: ps++ ? 32768 : 8192 }] }));
    expect(await f.model.diagnose(input(), true, new AbortController().signal)).toBeNull();
    expect(f.request.mock.calls.some(call => String(call[0]).endsWith('/api/chat'))).toBe(false);
  });
});

describe('doctor diagnosis service limits', () => {
  const roots: string[] = [];
  afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it('has a hard timeout even when the dependency ignores cancellation', async () => {
    vi.useFakeTimers();
    const result = doctorDeadline(() => new Promise(() => undefined), 25_000).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toBe('timeout');
  });
  it('limits diagnoses independently to six, falls back, and persists no rejected model output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-diagnosis-')); roots.push(root);
    const diagnose = vi.fn(async () => ({ text: 'https://rejected.invalid/private', source: 'cloud' as const }));
    const doctor = new DoctorService({ path: join(root, 'doctor.json'), now: () => now, available: () => true, changed: () => undefined,
      inputs: async () => ({ health: { checkedAt: now.toISOString(), items: [], issues: 0 }, wechat: null }), diskFree: async () => null,
      sendQq: async () => true, notifyDesktop: () => true, diagnose });
    await doctor.initialize();
    for (let n = 0; n < 8; n++) expect(await doctor.checkup()).toContain('建议：');
    expect(diagnose).toHaveBeenCalledTimes(6);
    expect(doctor.status().alertsToday).toBe(0);
    expect(await readFile(join(root, 'doctor.json'), 'utf8')).not.toContain('rejected.invalid');
    expect(doctor.status().diagnosis).toBeNull();
    await doctor.shutdown();
  });
});
