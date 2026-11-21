import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthItem, HealthSnapshot } from '../../shared/attention';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import {
  DISK_CRITICAL_BYTES, DOCTOR_DAILY_LIMIT, doctorFindings, formatCheckup, formatDoctorReport, isDoctorQuiet, planDoctorReport, reconcileDoctor,
} from './doctor';
import { DoctorService } from './doctor-service';
import type { DoctorServiceDeps } from './doctor-service';
import { HealthReceipts } from './health-receipts';

const TZ = 'Asia/Shanghai';
const at = (time: string): Date => new Date(`2026-11-16T${time}:00+08:00`);
const item = (feature: HealthItem['feature'], state: HealthItem['state'], errorCode: string | null = null, failures = 0): HealthItem =>
  ({ feature, state, errorCode, failures, lastSuccessAt: null, lastFailureAt: null, sinceLaunch: false });
const health = (...items: HealthItem[]): HealthSnapshot => ({ checkedAt: at('12:00').toISOString(), items, issues: items.filter(entry => entry.state === 'failing').length });
const wechat = (patch: Partial<WeChatChannelState> = {}): WeChatChannelState => ({ configured: true, groupName: null, state: 'running', stale: false, paused: false,
  privateStatus: 'ready', groupStatus: 'ready', pending: 0, uncertain: 0, groupPolicy: { mode: 'mentions', sender: null }, groups: [], groupBindingSupported: true,
  reply: { model: 'm', split: false, stickers: false }, ...patch });
const extras = (patch: Partial<Parameters<typeof doctorFindings>[1]> = {}) => ({ diskFreeBytes: 100 * 1024 ** 3, uncleanExitOf: null, wechat: null, ...patch });

describe('doctor findings', () => {
  it('turns failing health, dropped and unanswerable messages, low disk and an abnormal exit into codes only', () => {
    const findings = doctorFindings(health(item('qq', 'failing', 'qq.offline'), item('wechat', 'failing', 'wechat.dropped', 1), item('diary', 'ok'), item('telegram', 'off')),
      extras({ diskFreeBytes: DISK_CRITICAL_BYTES - 1, uncleanExitOf: at('09:00').toISOString(),
        wechat: wechat({ dropped: 1, droppedAt: 1794802842, skipped: 3, skippedAt: 1794805000, skippedKinds: ['quote', 'sticker', 'image'] }) }));
    expect(findings.map(entry => [entry.key, entry.severity, entry.event])).toEqual([
      ['qq:qq.offline', 'error', false],
      ['wechat.dropped@1794802842', 'error', true],
      ['wechat.skipped:quote', 'warning', true],
      ['wechat.skipped:image', 'warning', true],
      ['system:diskCritical', 'error', false],
      [`app.uncleanExit@${at('09:00').toISOString()}`, 'warning', true],
    ]);
  });

  it('ignores a paused listener and plenty of disk', () => {
    expect(doctorFindings(health(), extras({ wechat: wechat({ paused: true, dropped: 2, droppedAt: 1 }) }))).toEqual([]);
  });
});

describe('doctor cases and reports', () => {
  it('waits for a second check for a missing embedding model or repeated index failures', () => {
    const checks = (code: string, failures = 0) => doctorFindings(health(item('knowledge', 'failing', code, failures)), extras());
    expect(checks('knowledge.indexStale')).toEqual([]);
    expect(checks('knowledge.readFailed', 1)).toEqual([]);
    const findings = [...checks('knowledge.embeddingModelMissing'), ...checks('knowledge.readFailed', 2)];
    expect(findings.map(({ code, detail }) => [code, detail])).toEqual([
      ['knowledge.embeddingModelMissing', null], ['knowledge.indexRepeatedFailures', '2'],
    ]);
    const first = reconcileDoctor([], findings, at('12:00'));
    expect(planDoctorReport(first, false).problems).toEqual([]);
    const second = reconcileDoctor(first, findings, at('12:01'));
    expect(planDoctorReport(second, false).problems).toHaveLength(2);
  });

  const qq = doctorFindings(health(item('qq', 'failing', 'qq.offline')), extras());
  const dropped = doctorFindings(health(), extras({ wechat: wechat({ dropped: 1, droppedAt: 5 }) }));

  it('reports a lasting problem on its second check, an event at once, and a recovery only after a report', () => {
    let cases = reconcileDoctor([], [...qq, ...dropped], at('12:00'));
    let plan = planDoctorReport(cases, false);
    expect(plan.problems.map(entry => entry.key)).toEqual(['wechat.dropped@5']);
    cases = cases.map(entry => ({ ...entry, reported: 'qq' as const }));
    cases = reconcileDoctor(cases.map(entry => entry.key === 'qq:qq.offline' ? { ...entry, reported: null } : entry), [...qq, ...dropped], at('12:01'));
    plan = planDoctorReport(cases, false);
    expect(plan.problems.map(entry => entry.key)).toEqual(['qq:qq.offline']);
    cases = reconcileDoctor(cases.map(entry => ({ ...entry, reported: 'qq' as const })), [], at('12:02'));
    plan = planDoctorReport(cases, false);
    // A one-off event closes without a recovery notice.
    expect(plan.recovered.map(entry => entry.key)).toEqual(['qq:qq.offline']);
    expect(formatDoctorReport(plan, TZ)).toBe('【医生】已恢复：QQ。');
  });

  it('holds problems during quiet hours and sends them as one morning digest', () => {
    const disk = doctorFindings(health(), extras({ diskFreeBytes: 1024 ** 3 }));
    let cases = reconcileDoctor([], [...dropped, ...disk], at('02:00'));
    cases = reconcileDoctor(cases, [...dropped, ...disk], at('02:01'));
    const night = planDoctorReport(cases, isDoctorQuiet(at('02:01'), TZ));
    expect(night.problems.map(entry => entry.code)).toEqual(['system.diskCritical']);
    expect(night.held.map(entry => entry.code)).toEqual(['wechat.dropped']);
    cases = cases.map(entry => entry.code === 'wechat.dropped' ? { ...entry, reported: 'held' as const } : { ...entry, reported: 'qq' as const });
    cases = reconcileDoctor(cases, disk, at('08:05'));
    const morning = planDoctorReport(cases, isDoctorQuiet(at('08:05'), TZ));
    expect(morning.digest).toBe(true);
    expect(formatDoctorReport(morning, TZ)).toBe(['【医生】夜里记录到 1 个问题：',
      '1. 微信：最近一天有 1 条消息没回成（一直发不出去或等太久，已跳过）。（已恢复）', '建议：打开微信虚拟机窗口，确认微信已登录且没有提示框。', '详情见桌宠「动态 → 医生」。'].join('\n'));
  });

  it('describes a checkup without message content', () => {
    const text = formatCheckup(health(item('qq', 'ok'), item('wechat', 'failing', 'wechat.stale'), item('telegram', 'off')),
      doctorFindings(health(item('wechat', 'failing', 'wechat.stale')), extras()), 120 * 1024 ** 3, at('12:58'), TZ);
    expect(text).toBe(['【医生】体检结果（11/16 12:58）', '异常 1 项：', '- 微信：微信监听程序没有心跳了。', '正常：QQ', '未开启：Telegram', '系统盘剩余 120.0 GB。', '建议：打开微信虚拟机窗口，确认微信已登录且没有提示框。'].join('\n'));
  });
});

describe('doctor service', () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  const service = async (patch: { qq?: boolean; desktop?: boolean; health?: () => HealthSnapshot | Promise<HealthSnapshot>; now?: () => Date;
    previous?: object; diagnose?: DoctorServiceDeps['diagnose'] } = {}) => {
    root = await mkdtemp(join(tmpdir(), 'doctor-'));
    const path = join(root, 'doctor.json');
    if (patch.previous) await writeFile(path, JSON.stringify({ schemaVersion: 1, data: patch.previous }));
    const sent: string[] = [], shown: string[] = [];
    const doctor = new DoctorService({ path, timeZone: TZ, now: patch.now ?? (() => at('12:00')), available: () => true, changed: () => undefined,
      inputs: async () => ({ health: await patch.health?.() ?? health(item('qq', 'failing', 'qq.offline')), wechat: null }), diskFree: async () => 50 * 1024 ** 3,
      ...(patch.diagnose ? { diagnose: patch.diagnose } : {}),
      sendQq: async text => { sent.push(text); return patch.qq ?? true; }, notifyDesktop: text => { shown.push(text); return patch.desktop ?? true; } });
    await doctor.initialize();
    return { doctor, sent, shown, path };
  };

  it('notices that the previous run never shut down and marks this one clean on shutdown', async () => {
    const { doctor, sent, path } = await service({ health: () => health(), previous: { enabled: true, cases: [], alerts: { day: '', count: 0 },
      session: { startedAt: at('09:00').toISOString(), cleanExit: false } } });
    await doctor.check();
    expect(sent).toEqual([`【医生】发现 1 个问题：\n1. 桌宠：上次运行（11/16 09:00 启动）没有正常退出，可能是崩溃或被强制关闭。\n建议：观察是否再次异常退出；反复出现时请维护人员检查。\n详情见桌宠「动态 → 医生」。`]);
    await doctor.shutdown();
    expect(JSON.parse(await readFile(path, 'utf8')).data.session.cleanExit).toBe(true);
  });

  it('falls back to a desktop notification when QQ cannot deliver, and records how it was told', async () => {
    const { doctor, sent, shown } = await service({ qq: false });
    await doctor.check(); await doctor.check();
    expect(sent).toHaveLength(1);
    expect(shown).toEqual(sent);
    expect(doctor.status().cases[0]).toMatchObject({ key: 'qq:qq.offline', reported: 'desktop', seen: 2 });
    expect(doctor.status().alertsToday).toBe(0);
  });

  it('stops using QQ after the daily allowance and stays silent while switched off', async () => {
    let minute = 0, failing = true;
    const { doctor, sent, shown } = await service({ now: () => new Date(at('12:00').getTime() + minute * 60_000),
      health: () => failing ? health(item('qq', 'failing', 'qq.offline')) : health() });
    await doctor.setEnabled(false);
    await doctor.check(); await doctor.check();
    expect(sent).toEqual([]);
    await doctor.setEnabled(true);
    // Each problem that lasts two checks and then recovers costs two messages.
    for (let round = 0; round < DOCTOR_DAILY_LIMIT; round++) {
      for (const state of [true, true, false]) {
        minute++; failing = state;
        await doctor.check();
      }
    }
    expect(sent).toHaveLength(DOCTOR_DAILY_LIMIT);
    expect(shown.length).toBeGreaterThan(0);
  });

  it('answers a checkup without opening cases', async () => {
    const { doctor, sent } = await service();
    expect(await doctor.checkup()).toContain('QQ：QQ 连接断开了。');
    expect(doctor.status().cases).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('acknowledged health is silent, excluded from checkup diagnosis, and a new fingerprint reports normally', async () => {
    let now = at('12:00');
    const digest = { ...item('wechat-group-digest', 'failing', 'wechat.digest_delivery_failed', 1), lastFailureAt: at('11:42').toISOString() };
    const other = { ...item('diary', 'failing', 'diary.storage', 1), lastFailureAt: at('11:43').toISOString() };
    const raw = () => health(digest, other);
    const diagnose = vi.fn<NonNullable<DoctorServiceDeps['diagnose']>>(async () => null);
    let receipts: HealthReceipts;
    const { doctor, sent } = await service({ diagnose, now: () => now, health: () => receipts.apply(raw()) });
    receipts = new HealthReceipts(join(root!, 'health-receipts.json'), () => now);
    const snapshot = await receipts.apply(raw());
    await receipts.acknowledge({ key: 'diary:0', fingerprint: snapshot.items[1]!.fingerprint! }, raw());
    await doctor.check();
    await doctor.check();
    expect(doctor.status().cases.map(entry => entry.feature)).toEqual(['wechat-group-digest']);
    expect(sent).toHaveLength(1);
    const acknowledged = await receipts.acknowledge({ key: 'wechat-group-digest:0', fingerprint: snapshot.items[0]!.fingerprint! }, raw());
    now = at('12:01');
    await doctor.acknowledgeHealth(acknowledged, null);
    expect(doctor.status().open).toBe(0);
    await doctor.check();
    expect(doctor.status().cases[0]).toMatchObject({ acknowledged: true, resolvedAt: now.toISOString() });
    expect(sent).toHaveLength(1);
    const text = await doctor.checkup();
    expect(text).toContain('已知道：群聊每日精华、日记');
    expect(text).toContain('没有发现异常');
    expect(diagnose.mock.lastCall?.[0]).toMatchObject({ open: [], closed: [] });
    now = at('12:02');
    digest.lastFailureAt = now.toISOString();
    await doctor.check();
    await doctor.check();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('群聊每日精华');
    expect(doctor.status().open).toBe(1);
    expect(diagnose.mock.lastCall?.[0]).toMatchObject({ open: [{ feature: 'wechat-group-digest' }], closed: [] });
  });

  it('silently closes a held acknowledged case on the next check', async () => {
    let now = at('02:00'), acknowledged = false;
    const { doctor, sent } = await service({ now: () => now, health: () => health({ ...item('qq', 'failing', 'qq.offline'), acknowledged }) });
    await doctor.check(); await doctor.check();
    expect(doctor.status().cases[0]?.reported).toBe('held');
    expect(sent).toEqual([]);
    acknowledged = true;
    now = at('08:00');
    await doctor.check();
    expect(doctor.status().open).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('doctor automatic repairs', () => {
  let root: string;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const prepare = async (initialTime: Date, inputs: () => HealthSnapshot, repairs: DoctorServiceDeps['repairs']) => {
    root = await mkdtemp(join(tmpdir(), 'deskpet-doctor-repairs-'));
    let now = initialTime;
    const sent: string[] = [];
    const path = join(root, 'doctor.json');
    const deps: DoctorServiceDeps = { path, timeZone: TZ, now: () => now, available: () => true, changed: () => undefined,
      inputs: async () => ({ health: inputs(), wechat: null }), diskFree: async () => 100 * 1024 ** 3,
      sendQq: async text => { sent.push(text); return true; }, notifyDesktop: () => false, ...(repairs ? { repairs } : {}) };
    const doctor = new DoctorService(deps);
    await doctor.initialize();
    return { doctor, sent, deps, jump: (ms: number) => { now = new Date(now.getTime() + ms); } };
  };

  it.each(['wechat.stopped', 'wechat.stale', 'wechat.degraded'])('verifies one restarted listener and sends one report for %s', async code => {
    let state = health(item('wechat', 'failing', code));
    const run = vi.fn(async () => { state = health(item('wechat', 'ok')); return 'recovered' as const; });
    const { doctor, sent } = await prepare(at('12:00'), () => state, { wechat: { eligible: () => true, run } });
    expect(doctor.status().autoRepair).toBe(true);
    await Promise.all([doctor.check(), doctor.check()]);
    await doctor.check();
    expect(run).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('重启微信监听，已恢复');
    expect(doctor.status().repairs).toMatchObject([{ id: 'wechat', result: 'recovered', reportedAt: expect.any(String) }]);
  });

  it('shares a rate limit and circuit across listener issue codes, including across an app restart', async () => {
    const hour = 60 * 60_000;
    let code = 'wechat.stopped';
    const run = vi.fn(async () => 'failed' as const);
    const { doctor, sent, deps, jump } = await prepare(at('12:00'), () => health(item('wechat', 'failing', code)),
      { wechat: { eligible: () => true, run } });
    await doctor.check();
    code = 'wechat.stale';
    jump(hour - 1);
    await doctor.check();
    expect(run).toHaveBeenCalledTimes(1);
    jump(1);
    await doctor.check();
    expect(run).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toContain('修不好，需要你看看');
    expect(doctor.status().repairs[0]?.circuitUntil).toBe(new Date(at('13:00').getTime() + 24 * hour).toISOString());
    await doctor.shutdown();
    const resumed = new DoctorService(deps);
    await resumed.initialize();
    jump(23 * hour);
    await resumed.check();
    expect(run).toHaveBeenCalledTimes(2);
    jump(hour);
    await resumed.check();
    expect(run).toHaveBeenCalledTimes(3);
    expect(resumed.status().repairs[0]?.circuitUntil).toBeNull();
  });

  it('automatically repairs and records at night, then reports once in the morning', async () => {
    let state = health(item('asr', 'failing', 'asr.worker'));
    const run = vi.fn(async () => { state = health(item('asr', 'ok')); return 'recovered' as const; });
    const { doctor, sent, jump } = await prepare(at('03:00'), () => state, { asr: { eligible: () => true, run } });
    await doctor.check();
    expect(run).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(doctor.status().repairs[0]).toMatchObject({ heldForMorning: true, reportedAt: null });
    jump(6 * 60 * 60_000);
    await doctor.check();
    await doctor.check();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('夜间自动修复记录');
  });

  it('keeps the doctor reporting when repairs are off and never acts on uncertain delivery by itself', async () => {
    let state = health(item('wechat', 'failing', 'wechat.stale'));
    const run = vi.fn(async () => 'failed' as const);
    const { doctor, sent } = await prepare(at('12:00'), () => state, { wechat: { eligible: () => true, run }, qq: { eligible: () => true, run } });
    await doctor.setAutoRepair(false);
    await doctor.check();
    await doctor.check();
    expect(run).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/心跳/);
    await doctor.setAutoRepair(true);
    state = health(item('wechat', 'failing', 'wechat.uncertain'), item('wechat', 'failing', 'wechat.send_receipt_unconfirmed'),
      item('wechat-group-digest', 'failing', 'wechat.digest_delivery_uncertain'), item('qq', 'failing', 'qq.uncertain'));
    await doctor.check();
    await doctor.check();
    expect(run).not.toHaveBeenCalled();
    expect(doctor.status().repairs).toEqual([]);
  });

  it('caps attempts to three per rolling day and honors the two-hour Minecraft interval', async () => {
    const run = vi.fn(async () => 'recovered' as const);
    const { doctor, jump } = await prepare(at('10:00'), () => health(),
      { minecraft: { observed: () => true, eligible: () => true, run } });
    const hour = 60 * 60_000;
    await doctor.check();
    jump(hour);
    await doctor.check();
    expect(run).toHaveBeenCalledTimes(1);
    for (const hours of [1, 2, 2]) { jump(hours * hour); await doctor.check(); }
    expect(run).toHaveBeenCalledTimes(3);
  });
});
