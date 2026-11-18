import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { doctorVmStateSchema } from '../../shared/doctor';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import { planDoctorReport, reconcileDoctor } from './doctor';
import { DoctorService } from './doctor-service';
import { applyVmHealth, vmHealthDue, vmHealthFindings } from './doctor-vm';

const GB = 1024 ** 3, MB = 1024 ** 2;
const now = new Date('2026-11-17T02:00:00Z');
const good = { totalBytes: 60 * GB, freeBytes: 20 * GB, authLogBytes: 0, journalBytes: 0, uptimeSeconds: 100, wechatRunning: true };

it('enforces disk thresholds, log growth, rotation and two unreachable samples', () => {
  const empty = doctorVmStateSchema.parse({});
  expect(vmHealthDue(empty, now)).toBe(true);
  expect(vmHealthFindings(applyVmHealth(empty, { ...good, freeBytes: 4 * GB }, now))).toEqual([]);
  const low = applyVmHealth(empty, { ...good, freeBytes: 4 * GB - 1 }, now);
  expect(vmHealthFindings(low)[0]?.code).toBe('wechat.vmDiskLow');
  expect(vmHealthDue(low, new Date(+now + 29 * 60_000))).toBe(false);
  expect(vmHealthDue(low, new Date(+now + 30 * 60_000))).toBe(true);
  const critical = vmHealthFindings(applyVmHealth(empty, { ...good, freeBytes: GB }, now));
  expect(planDoctorReport(reconcileDoctor([], critical, now), true).problems[0]?.code).toBe('wechat.vmDiskCritical');
  const yesterday = applyVmHealth(empty, { ...good, authLogBytes: 10 * MB }, new Date(+now - 86_400_000));
  expect(vmHealthFindings(applyVmHealth(yesterday, { ...good, authLogBytes: 311 * MB }, now))[0]?.code).toBe('wechat.vmLogGrowth');
  expect(vmHealthFindings(applyVmHealth(yesterday, good, now))).toEqual([]); // rotated, not negative growth
  expect(vmHealthFindings(applyVmHealth(empty, { ...good, journalBytes: GB + 1 }, now))[0]?.code).toBe('wechat.vmLogGrowth');
  expect(vmHealthFindings(applyVmHealth(empty, null, now))).toEqual([]);
  expect(vmHealthFindings(applyVmHealth(applyVmHealth(empty, null, now), null, now))[0]?.code).toBe('wechat.vmUnreachable');
});

it('retains 48 byte-only samples but compares against a full day before trimming', () => {
  let state = doctorVmStateSchema.parse({});
  for (let n = 0; n <= 48; n++) state = applyVmHealth(state, { ...good, authLogBytes: n * 10 * MB }, new Date(+now + n * 30 * 60_000));
  expect(state.samples).toHaveLength(48);
  expect(state.latest?.growth24hBytes).toBe(480 * MB);
  expect(Object.keys(state.samples[0]!)).toEqual(['at', 'logBytes']);
});

it('samples once every 30 minutes, including checkups, without ever sending a self-test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-vm-'));
  try {
    let time = now;
    const vmHealth = vi.fn(async () => good), selfTest = vi.fn();
    let configured = true;
    const doctor = new DoctorService({ path: join(root, 'doctor.json'), now: () => time, inputs: async () => ({ health: { items: [], issues: 0, checkedAt: time.toISOString() },
      wechat: { configured } as WeChatChannelState }), diskFree: async () => null, vmHealth, wechatSelfTest: selfTest,
      available: () => true, sendQq: async () => true, notifyDesktop: () => true, changed: () => undefined, timeZone: 'UTC' });
    await doctor.initialize();
    for (let n = 0; n < 30; n++) {
      time = new Date(+now + n * 60_000);
      await doctor.check();
    }
    expect(vmHealth).toHaveBeenCalledTimes(1);
    expect(await doctor.checkup()).toContain('微信虚拟机：磁盘剩余 20.0 GB，日志 0 MB');
    time = new Date(+now + 30 * 60_000);
    await doctor.checkup();
    expect(vmHealth).toHaveBeenCalledTimes(2);
    expect(selfTest).not.toHaveBeenCalled();
    configured = false; // An unreadable channel-status must not blind an already configured VM monitor.
    vmHealth.mockRejectedValueOnce(new Error('PRIVATE_VM_ERROR'));
    time = new Date(+now + 60 * 60_000); await doctor.check();
    expect(vmHealth).toHaveBeenCalledTimes(3);
    expect(doctor.status().vm.failures).toBe(1);
    await doctor.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});
