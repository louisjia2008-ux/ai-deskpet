// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DomainRepository } from '../../domain/repository';
import { matchWeChatOwnerCommand, WECHAT_SCHEDULED_TASK_LIMITS, WECHAT_SCHEDULED_TASK_TOOLS, WeChatOwnerCommands } from './wechat-owner-commands';
import type { WeChatOwnerDelivery, WeChatOwnerHost, WeChatScheduledTaskAuthority } from './wechat-owner-commands';
import { sameWeChatScheduledTaskAuthority, wechatScheduledTaskAuthoritySchema } from './wechat-owner-command-schema';

const roots: string[] = [];
const vault = { getVaultKey: async () => Buffer.alloc(32, 32) };
const owner = 'a'.repeat(64);
const formerOwner = 'b'.repeat(64);
const start = Date.parse('2026-11-13T00:58:00.000Z');
const event = (text: string, eventKey = text, binding = owner) => ({
  binding, text, eventId: createHash('sha256').update(eventKey).digest('hex'),
});
const newId = (reply: string | null) => reply?.match(/[a-f0-9]{8}/u)?.[0];
const confirmCode = (reply: string | null): string => reply?.match(/\/confirm ([a-f0-9]{12})$/u)?.[1] ?? '';
const authority: WeChatScheduledTaskAuthority = {
  providerId: 'ddab65bc-bba5-4bf7-9a36-f1db33194340', credentialRef: '34c72dbf-d92b-43aa-bcd3-944a47b944ef',
  model: 'fixture-model', destination: 'remote', providerDigest: 'c'.repeat(64),
  routeFingerprint: 'd'.repeat(64), permissionFingerprint: 'e'.repeat(64),
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-wechat-commands-')); roots.push(root);
  const path = join(root, 'profile.enc.json');
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen();
  let binding: string | null = owner;
  let now = start;
  const host = {
    available: vi.fn(() => true),
    currentBinding: vi.fn(async () => binding),
    status: vi.fn(async () => '已连接'),
    model: vi.fn(async () => 'Fixture model'),
    checkup: vi.fn(async () => '【医生】体检结果\n没有发现异常。\n微信虚拟机：磁盘剩余 20.0 GB，日志 1 MB。\n医生的看法：当前采样正常。'),
    deliver: vi.fn<WeChatOwnerHost['deliver']>(async () => 'sent'),
    now: () => now,
    timezone: () => 'Asia/Shanghai',
    scheduledTask: {
      capture: vi.fn<NonNullable<WeChatOwnerHost['scheduledTask']>['capture']>(async () => authority),
      run: vi.fn<NonNullable<WeChatOwnerHost['scheduledTask']>['run']>(async () => 'Fixture result'),
    },
  };
  const commands = new WeChatOwnerCommands(repository, host);
  return { repository, path, commands, host, reopen, setBinding: (value: string | null) => { binding = value; }, setNow: (value: number) => { now = value; } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('matches the live provider authority after profile decoding orders the fields differently', () => {
  const live = { ...authority };
  const orderedByHost = {
    model: live.model, routeFingerprint: live.routeFingerprint, providerDigest: live.providerDigest,
    permissionFingerprint: live.permissionFingerprint, credentialRef: live.credentialRef,
    destination: live.destination, providerId: live.providerId,
  };
  const persisted = wechatScheduledTaskAuthoritySchema.parse(orderedByHost);
  expect(Object.keys(orderedByHost)).not.toEqual(Object.keys(persisted));
  expect(sameWeChatScheduledTaskAuthority(orderedByHost, persisted)).toBe(true);
  expect(sameWeChatScheduledTaskAuthority({ ...orderedByHost, credentialRef: '349b98e5-e499-4760-87fd-cdd6125df67a' }, persisted)).toBe(false);
});

it('answers exact owner commands and rejects other bindings and altered event replays', async () => {
  const f = await fixture();
  expect(await f.commands.handle(event('/ping'))).toContain('在呢');
  expect(await f.commands.handle(event('/status'))).toContain('已连接');
  expect(await f.commands.handle(event('/model'))).toContain('Fixture model');
  expect(await f.commands.handle(event('/help'))).toContain('/cron');
  expect(await f.commands.handle(event('/other'))).toContain('/ping');
  expect(await f.commands.handle(event('普通消息'))).toBeNull();
  expect(await f.commands.handle(event('例如十分钟后提醒我喝水'))).toBeNull();
  await expect(f.commands.handle(event('/status', 'other-binding', formerOwner))).rejects.toThrow('wechat.ownerBindingChanged');
  await expect(f.commands.handle(event('/status', '/ping'))).rejects.toThrow('wechat.ownerCommandConflict');
  expect(f.host.status).toHaveBeenCalledTimes(1);
  expect(f.host.model).toHaveBeenCalledTimes(1);
  expect(f.host.deliver).not.toHaveBeenCalled();
  expect(matchWeChatOwnerCommand('给大家提醒一下')).toBeNull();
});

it('handles exact width-normalized checkups only for the bound owner, replaying without another check', async () => {
  const f = await fixture();
  for (const text of ['体检', '  /checkup  ', '　／ＣＨＥＣＫＵＰ　']) {
    expect(matchWeChatOwnerCommand(text)).toEqual({ kind: 'checkup' });
    const reply = await f.commands.handle(event(text));
    expect(reply).toContain('微信虚拟机');
    expect(reply).toContain('医生的看法');
    expect([...(reply ?? '')].length).toBeLessThanOrEqual(500);
    expect(await f.commands.handle(event(text))).toBe(reply);
  }
  expect(f.host.checkup).toHaveBeenCalledTimes(3);
  await expect(f.commands.handle(event('体检', 'foreign', formerOwner))).rejects.toThrow('wechat.ownerBindingChanged');
  expect(f.host.checkup).toHaveBeenCalledTimes(3);
  expect(await f.commands.handle(event('/help'))).toContain('体检（/checkup）');
  expect(matchWeChatOwnerCommand('帮我体检一下')).toBeNull();
  expect(f.host.deliver).not.toHaveBeenCalled();
});

it('rechecks the owner binding after a checkup and never commits a reply after rebinding', async () => {
  const f = await fixture();
  f.host.checkup.mockImplementationOnce(async () => { f.setBinding(formerOwner); return '【医生】体检结果'; });
  await expect(f.commands.handle(event('体检'))).rejects.toThrow('wechat.ownerBindingChanged');
  expect(f.repository.read('wechatOwnerCommands').receipts).toEqual([]);
});

it('persists natural reminders exactly once and catches up to one confirmed delivery', async () => {
  const f = await fixture();
  const input = event('十分钟后提醒我喝水');
  const reply = await f.commands.handle(input);
  expect(reply).toContain('提醒你「喝水」');
  const reopened = await f.reopen();
  const worker = new WeChatOwnerCommands(reopened, f.host);
  f.setNow(start + 60_000);
  expect(await worker.handle(input)).toBe(reply);
  expect(reopened.read('wechatOwnerCommands').reminders).toHaveLength(1);
  expect(await worker.handle(event('我的提醒'))).toContain(newId(reply));
  f.setNow(start + 10 * 60_000);
  await Promise.all([worker.tick(), worker.tick()]);
  await worker.tick();
  expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith({
    binding: owner, deliveryId: expect.stringMatching(/^[a-f0-9]{64}$/u), text: '微信提醒：喝水',
  });
  expect((await f.reopen()).read('wechatOwnerCommands').reminders[0]?.state).toBe('sent');
  expect(await readFile(f.path, 'utf8')).not.toContain('喝水');
});

it('runs a recurring reminder through owner command handling and stops immediately after cancellation', async () => {
  const f = await fixture();
  expect(await f.commands.handle(event('/cron add * * * * * -- 不可发送'))).toContain('间隔少于 15 分钟');
  const reply = await f.commands.handle(event('/cron add 0 9 * * 1-5 -- Fixture A'));
  const id = newId(reply);
  expect(id).toBeDefined();
  expect(reply).toContain('09:00:00（Asia/Shanghai）');
  expect(await f.commands.handle(event('/cron list'))).toContain('Fixture A');
  f.setNow(start + 2 * 60_000);
  await f.commands.tick();
  const delivery = f.host.deliver.mock.calls[0]?.[0];
  expect(delivery).toMatchObject({ binding: owner, text: '周期提醒：Fixture A' });
  expect(f.repository.read('wechatOwnerCommands').reminders[0]?.dueAt).toBe(Date.parse('2026-11-16T01:00:00.000Z'));
  expect(await f.commands.handle(event(`/cron cancel ${id}`))).toContain('已取消');
  f.setNow(Date.parse('2026-11-16T01:00:01.000Z'));
  await f.commands.tick();
  expect(f.host.deliver).toHaveBeenCalledTimes(1);
});

it('does not cross owner generations and replays interrupted transport with the same delivery ID', async () => {
  const f = await fixture();
  await f.commands.handle(event('/remind 25s fixture notice'));
  f.setNow(start + 30_000);
  f.setBinding(formerOwner);
  await f.commands.tick();
  expect(f.host.deliver).not.toHaveBeenCalled();
  f.setBinding(owner);
  f.host.deliver.mockRejectedValueOnce(new Error('transport interrupted'));
  await f.commands.tick();
  const first = f.host.deliver.mock.calls[0]?.[0];
  expect(first).toBeDefined();
  const reopened = await f.reopen();
  const worker = new WeChatOwnerCommands(reopened, f.host);
  f.host.deliver.mockResolvedValueOnce('uncertain');
  await worker.tick();
  await worker.tick();
  expect(f.host.deliver.mock.calls.map((call: [WeChatOwnerDelivery]) => call[0])).toEqual([first, first]);
  expect(await worker.handle(event('/reminders'))).toContain('送达未确认');
});

it('accepts cancellation after a verified preflight retry and leaves due sends pending while paused', async () => {
  const f = await fixture();
  await f.commands.handle(event('/remind 25s fixture notice'));
  f.setNow(start + 25_000);
  f.host.available.mockReturnValue(false);
  await f.commands.tick();
  expect(f.host.deliver).not.toHaveBeenCalled();
  f.host.available.mockReturnValue(true);
  f.host.deliver.mockResolvedValueOnce('retry');
  await f.commands.tick();
  expect(await f.commands.handle(event('取消刚才那条提醒'))).toContain('已取消');
  await f.commands.tick();
  expect(f.host.deliver).toHaveBeenCalledTimes(1);
});

it('requires the exact owner confirmation before running one model task and reuses the delivery identity after restart', async () => {
  const f = await fixture();
  const input = event('/cron once 40s -- 查一下测试地区的天气');
  const proposal = await f.commands.handle(input);
  expect(proposal).toContain('云端 fixture-model');
  expect(proposal).toContain('搜索/网页/计算/时间');
  expect(proposal).toContain('查一下测试地区的天气');
  expect(await f.commands.handle(input)).toBe(proposal);
  expect(f.repository.read('wechatOwnerCommands').tasks).toHaveLength(0);
  f.setNow(start + 5_000);
  const code = confirmCode(proposal);
  expect(code).toMatch(/^[a-f0-9]{12}$/u);
  await expect(f.commands.handle(event(`/confirm ${code}`, 'other', formerOwner))).rejects.toThrow('wechat.ownerBindingChanged');
  expect(await f.commands.handle(event('/confirm 000000000000'))).toContain('无效');
  const confirmation = event(`/confirm ${code}`);
  expect(await f.commands.handle(confirmation)).toContain('已确认');
  expect(await f.commands.handle(confirmation)).toContain('已确认');
  expect(f.repository.read('wechatOwnerCommands').tasks).toHaveLength(1);
  f.setNow(start + 44_999);
  await f.commands.tickScheduledTasks();
  expect(f.host.scheduledTask.run).not.toHaveBeenCalled();
  f.setNow(start + 45_000);
  f.host.scheduledTask.run.mockImplementationOnce(async input => {
    await input.assertCurrent();
    return 'Fixture answer\nwith whitespace';
  });
  await Promise.all([f.commands.tickScheduledTasks(), f.commands.tickScheduledTasks()]);
  expect(f.host.scheduledTask.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    binding: owner, authority, instruction: '查一下测试地区的天气', allowedTools: WECHAT_SCHEDULED_TASK_TOOLS,
    limits: WECHAT_SCHEDULED_TASK_LIMITS, signal: expect.any(AbortSignal),
  }));
  expect(f.host.deliver).not.toHaveBeenCalled();
  f.host.deliver.mockRejectedValueOnce(new Error('interrupted after dispatch'));
  await f.commands.tickScheduledTasks();
  const delivery = f.host.deliver.mock.calls[0]?.[0];
  expect(delivery?.text).toContain('Fixture answer with whitespace');
  const repository = await f.reopen();
  const restarted = new WeChatOwnerCommands(repository, f.host);
  await restarted.tickScheduledTasks();
  await restarted.tickScheduledTasks();
  expect(f.host.deliver.mock.calls.map(call => call[0])).toEqual([delivery, delivery]);
  expect(f.host.scheduledTask.run).toHaveBeenCalledTimes(1);
  expect(repository.read('wechatOwnerCommands').tasks[0]).toMatchObject({ state: 'completed', outcome: 'sent', run: null });
  expect(await readFile(f.path, 'utf8')).not.toContain('Fixture answer');
});

it('recognizes the OCR-compressed one-off boundary while preserving task text and requiring confirmation', async () => {
  const f = await fixture();
  const original = '用一句话解释为什么天空看起来是蓝色';
  const compressed = '/cron once 40s-' + original;
  expect(matchWeChatOwnerCommand(compressed)).toEqual({
    kind: 'task-propose', instruction: original, timing: { delayMs: 40_000 },
  });
  const draft = await f.commands.handle(event(compressed));
  expect(draft).toContain(original);
  expect(confirmCode(draft)).toMatch(/^[a-f0-9]{12}$/u);
  expect(f.repository.read('wechatOwnerCommands').tasks).toEqual([]);
  expect(f.host.scheduledTask.run).not.toHaveBeenCalled();
  expect(matchWeChatOwnerCommand('／ｃｒｏｎ　ｏｎｃｅ\n４０ｓ－用一句话解释：\n天空为什么是蓝色？')).toEqual({
    kind: 'task-propose', instruction: '用一句话解释： 天空为什么是蓝色？', timing: { delayMs: 40_000 },
  });
  expect(matchWeChatOwnerCommand('／ｃｒｏｎ　ｔａｓｋ　０　９　＊　＊　１－５　－－　原样保留：天气？')).toEqual({
    kind: 'task-propose', instruction: '原样保留：天气？', timing: { expression: '0 9 * * 1-5' },
  });
  expect(matchWeChatOwnerCommand('／ｃｏｎｆｉｒｍ\n０１２３４５６７８９ａｂ')).toEqual({ kind: 'task-confirm', code: '0123456789ab' });
  expect(matchWeChatOwnerCommand('/cron once 40s -- -1+2')).toMatchObject({ instruction: '-1+2' });
  expect(await f.commands.handle(event('/cron once 40s 用一句话解释'))).toContain('/cron once 40s -- 任务内容');
  expect(await f.commands.handle(event('/cron once 40s---用一句话解释'))).toContain('/cron once 40s -- 任务内容');
  expect(await f.commands.handle(event('/confirm 123'))).toContain('12 位确认码');
  expect(matchWeChatOwnerCommand('帮我看看\n/cron once 40s-不执行')).toBeNull();
});

it('invalidates a draft when provider authority changes and drops a generated result if consent is revoked', async () => {
  const f = await fixture();
  const propose = async (input: string) => confirmCode(await f.commands.handle(event(input)));
  const first = await propose('/task in 40s -- Fixture test A');
  f.host.scheduledTask.capture.mockResolvedValue({ ...authority, credentialRef: '93114104-2c41-4743-82df-fce47aa62ba3' });
  expect(await f.commands.handle(event(`/confirm ${first}`))).toContain('权限已变化');
  expect(f.repository.read('wechatOwnerCommands').tasks).toHaveLength(0);
  f.host.scheduledTask.capture.mockResolvedValue(authority);
  const second = await propose('/task after 40s -- Fixture test B');
  await f.commands.handle(event(`/confirm ${second}`));
  f.setNow(start + 40_000);
  await f.commands.tickScheduledTasks();
  f.host.scheduledTask.capture.mockResolvedValue(null);
  await f.commands.tickScheduledTasks();
  expect(f.host.deliver).not.toHaveBeenCalled();
  expect(f.repository.read('wechatOwnerCommands').tasks[0]).toMatchObject({ state: 'blocked', outcome: 'authority_changed', run: null });
  expect(await f.commands.handle(event('/cron list tasks'))).toContain('授权变化');
});

it('skips missed recurring tasks and cancels before the next occurrence', async () => {
  const f = await fixture();
  expect(await f.commands.handle(event('/cron task * * * * * -- Fixture rejected'))).toContain('间隔少于 15 分钟');
  const draft = await f.commands.handle(event('/cron task 0 9 * * 1-5 -- Fixture scheduled'));
  const confirmation = await f.commands.handle(event(`/confirm ${confirmCode(draft)}`));
  expect(confirmation).toContain('09:00:00');
  f.setNow(start + 8 * 60_000);
  await f.commands.tickScheduledTasks();
  expect(f.host.scheduledTask.run).not.toHaveBeenCalled();
  expect(f.repository.read('wechatOwnerCommands').tasks[0]).toMatchObject({
    state: 'active', outcome: 'missed', dueAt: Date.parse('2026-11-16T01:00:00.000Z'),
  });
  expect(await f.commands.handle(event(`/cron cancel ${newId(confirmation)}`))).toContain('已取消');
  f.setNow(Date.parse('2026-11-16T01:00:00.000Z'));
  await f.commands.tickScheduledTasks();
  expect(f.host.scheduledTask.run).not.toHaveBeenCalled();
});

it('does not regenerate an interrupted persisted run or re-send an explicitly uncertain delivery', async () => {
  const f = await fixture();
  const draft = await f.commands.handle(event('/cron once 10s -- Fixture interrupted'));
  await f.commands.handle(event(`/confirm ${confirmCode(draft)}`));
  await f.repository.transaction(profile => {
    profile.wechatOwnerCommands.tasks[0]!.run = { phase: 'running', id: authority.providerId, deliveryId: '9'.repeat(64) };
  });
  f.setNow(start + 10_000);
  await f.commands.tickScheduledTasks();
  expect(f.host.scheduledTask.run).not.toHaveBeenCalled();
  expect(f.repository.read('wechatOwnerCommands').tasks[0]).toMatchObject({ state: 'completed', outcome: 'interrupted' });
  const second = await f.commands.handle(event('/cron once 10s -- Fixture uncertain'));
  await f.commands.handle(event(`/confirm ${confirmCode(second)}`));
  f.setNow(start + 20_000);
  await f.commands.tickScheduledTasks();
  f.host.deliver.mockResolvedValueOnce('uncertain');
  await f.commands.tickScheduledTasks();
  await f.commands.tickScheduledTasks();
  expect(f.host.deliver).toHaveBeenCalledTimes(1);
  expect(await f.commands.handle(event('/cron list tasks'))).toContain('送达未确认');
});

it('aborts an active model task when the verified owner cancels it and suppresses a late result', async () => {
  const f = await fixture();
  const draft = await f.commands.handle(event('/cron once 10s -- Fixture cancel'));
  const confirmation = await f.commands.handle(event(`/confirm ${confirmCode(draft)}`));
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.host.scheduledTask.run.mockImplementationOnce(input => new Promise(resolve => {
    input.signal.addEventListener('abort', () => resolve('late fixture result'), { once: true });
    began();
  }));
  f.setNow(start + 10_000);
  const running = f.commands.tickScheduledTasks();
  await started;
  expect(await f.commands.handle(event(`/cron cancel ${newId(confirmation)}`))).toContain('已取消');
  await running;
  await f.commands.tickScheduledTasks();
  expect(f.host.deliver).not.toHaveBeenCalled();
  expect(f.repository.read('wechatOwnerCommands').tasks[0]).toMatchObject({ state: 'cancelled', run: null });
});

it('aborts on desktop authority revocation and durably discards drafts and queued results', async () => {
  const f = await fixture();
  const first = await f.commands.handle(event('/cron once 10s -- Fixture ready'));
  await f.commands.handle(event(`/confirm ${confirmCode(first)}`));
  const second = await f.commands.handle(event('/cron once 10s -- Fixture running'));
  await f.commands.handle(event(`/confirm ${confirmCode(second)}`));
  const draft = await f.commands.handle(event('/cron once 10s -- Fixture draft'));
  await f.commands.handle(event('/remind 25s fixed reminder'));
  f.setNow(start + 10_000);
  await f.commands.tickScheduledTasks();
  // Simulate a second scheduler slot while the first result awaits confirmation
  // from the delivery transport.
  await f.repository.transaction(profile => {
    const run = profile.wechatOwnerCommands.tasks[0]!.run;
    if (run?.phase !== 'ready') throw new Error('Fixture expected a ready result');
    run.phase = 'uncertain';
  });
  let began!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { began = resolve; });
  f.host.scheduledTask.run.mockImplementationOnce(input => new Promise(resolve => {
    input.signal.addEventListener('abort', () => resolve('late fixture result'), { once: true });
    began(input.signal);
  }));
  const running = f.commands.tickScheduledTasks();
  const signal = await started;
  const invalidation = f.commands.invalidateScheduledAuthority();
  expect(signal.aborted).toBe(true);
  await Promise.all([running, invalidation]);
  const repository = await f.reopen();
  const saved = repository.read('wechatOwnerCommands');
  expect(saved.taskDrafts).toEqual([]);
  expect(saved.tasks).toHaveLength(2);
  for (const task of saved.tasks) expect(task).toMatchObject({ state: 'blocked', outcome: 'authority_changed', run: null });
  expect(saved.reminders).toMatchObject([{ state: 'active', label: 'fixed reminder' }]);
  const restarted = new WeChatOwnerCommands(repository, f.host);
  await restarted.tickScheduledTasks();
  expect(await restarted.handle(event(`/confirm ${confirmCode(draft)}`))).toContain('无效');
  expect(f.host.deliver).not.toHaveBeenCalled();
});

it('does not let a model authority capture in flight create a draft after revocation', async () => {
  const f = await fixture();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let finish!: (value: WeChatScheduledTaskAuthority) => void;
  f.host.scheduledTask.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; began(); }));
  const proposing = f.commands.handle(event('/cron once 10s -- Fixture in flight'));
  await started;
  await f.commands.invalidateScheduledAuthority();
  finish(authority);
  expect(await proposing).toContain('授权已变化');
  expect(f.repository.read('wechatOwnerCommands').taskDrafts).toEqual([]);
});
