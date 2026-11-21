import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { WECHAT_REPLY_FRIEND_LIMIT, wechatChannelStateSchema, wechatFriendIdSchema, wechatFriendRosterIdSchema, wechatModelSchema, wechatWindowSchema } from '../../../shared/wechat-channel';
import type { WeChatChannelAPI, WeChatChannelState, WeChatGroupUpdate, WeChatReply, WeChatReplyFriend, WeChatReplyGroupCandidate, WeChatWindow } from '../../../shared/wechat-channel';
import { wechatDigestGroupIdSchema, wechatOfficialAccountIdSchema } from '../../../shared/wechat-digests';
import { WECHAT_MOMENT_WINDOW_FAILURES } from './wechat-moments';
import type { MomentAnswerContext, MomentPostOutcome, MomentPreviewOutcome } from './wechat-moments';
import type { WeChatDigestKind } from './wechat-context';
import { wechatFollowupEvidenceReadSchema } from './wechat-followup-evidence';
import { appOutageSchema, doctorSelfTestResultSchema, doctorVmHealthSchema, type AppOutage, type DoctorSelfTestResult, type DoctorVmHealth } from '../../../shared/doctor';

const unavailable: WeChatChannelState = {
  configured: false, groupName: null, state: 'stopped', stale: false, paused: false,
  privateStatus: null, groupStatus: null, pending: 0, uncertain: 0, groupPolicy: { mode: 'mentions', sender: null },
  groups: [], groupBindingSupported: false, reply: { model: 'qwen3.5:0.8b', split: false, stickers: false },
};

const errors = {
  busy: 'busy', invalid_policy: 'invalidPolicy', not_paused: 'notPaused', group_unverified: 'groupUnverified',
  group_limit: 'groupLimit', group_not_found: 'groupNotFound', model_unavailable: 'modelUnavailable',
  invalid_group: 'groupNotFound', group_title_ambiguous: 'groupTitleAmbiguous', send_target_ambiguous: 'targetSearchAmbiguous',
  title_mismatch: 'targetTitleMismatch', group_conversation_mismatch: 'groupConversationMismatch',
  reply_targets_worker_upgrade_required: 'replyTargetsWorkerUpgradeRequired',
  invalid_friend: 'friendNotFound', friend_not_found: 'friendNotFound', friend_limit: 'friendLimit',
  friend_title_ambiguous: 'friendTitleAmbiguous', friend_conversation_mismatch: 'friendConversationMismatch', friend_unverified: 'friendUnverified',
} as const;
const python = '/opt/homebrew/bin/python3';
const viewer = 'http://127.0.0.1:15939/vnc.html?autoconnect=1&resize=scale';

const replyFriendSchema = z.strictObject({ id: wechatFriendIdSchema, title: z.string().min(1).max(256) });
const friendRosterEntrySchema = replyFriendSchema.extend({ id: wechatFriendRosterIdSchema });

export class WeChatChannel implements Omit<WeChatChannelAPI, 'getCloud' | 'configureCloud' | 'configureFriendCloud' | 'configureAssistant' | 'configureGroupRule'> {
  constructor(private readonly root: string, private readonly script: string,
    private readonly openViewer: ((url: string) => Promise<void>) | null,
    private readonly platform: NodeJS.Platform = process.platform) {}

  async getState(): Promise<WeChatChannelState> {
    if (this.platform !== 'darwin') return unavailable;
    try {
      await this.requirePrivateRoot();
      return wechatChannelStateSchema.parse(await this.run(['channel-status']));
    } catch {
      return unavailable;
    }
  }

  async canRestartListener(): Promise<boolean> {
    // A development or packaged test profile must never control the installed LaunchAgent.
    if (!this.openViewer || this.platform !== 'darwin') return false;
    const state = await this.getState();
    return state.configured && !state.paused && state.state !== 'paused' &&
      (state.stale || state.state === 'stopped' || state.state === 'degraded');
  }

  async restartListener(allowed: () => boolean): Promise<'skipped' | 'failed' | 'recovered'> {
    if (!allowed() || !await this.canRestartListener() || !allowed()) return 'skipped';
    const until = Date.now() + 60_000;
    const start = z.discriminatedUnion('started', [
      z.strictObject({ started: z.literal(false) }),
      z.strictObject({ started: z.literal(true), after: z.number().positive(), pid: z.number().int().positive().nullable() }),
    ]).parse(await this.run(['restart-listener'], undefined, 1024, 22_000));
    if (!start.started) return 'skipped';
    const heartbeat = z.object({ state: z.string(), heartbeat_at: z.number().positive().nullable(),
      pid: z.number().int().positive().nullable(), paused: z.boolean(), stale: z.boolean() });
    while (allowed() && Date.now() < until) {
      const current = heartbeat.safeParse(await this.run(['status'], undefined, 16_384, 3500).catch(() => null));
      if (current.success) {
        const state = current.data;
        if (state.state === 'running' && !state.paused && !state.stale && state.pid !== null && state.pid !== start.pid &&
          state.heartbeat_at !== null && state.heartbeat_at >= start.after && Date.now() <= until) return 'recovered';
      }
      await delay(750);
    }
    return 'failed';
  }

  async configureGroup({ groupId, policy }: WeChatGroupUpdate): Promise<WeChatChannelState> {
    await this.requireCurrentWorker();
    await this.run(['group-policy', '--group', groupId, '--set'], policy);
    return this.requireConfigured();
  }

  async setPaused(paused: boolean): Promise<WeChatChannelState> {
    await this.requireConfigured();
    await this.run([paused ? 'pause' : 'resume']);
    return this.requireConfigured();
  }

  async bindSelectedGroup(): Promise<WeChatChannelState> {
    await this.requireCurrentWorker();
    if (!this.openViewer) throw new Error('wechat.unavailable');
    await this.run(['group-bind', '--selected']);
    return this.requireConfigured();
  }

  async listReplyGroups(): Promise<WeChatReplyGroupCandidate[]> {
    if (!this.openViewer) throw new Error('wechat.unavailable');
    return (await this.digestGroups()).filter(group => !group.replying).map(({ id, title }) => ({ id, title }));
  }

  async addReplyGroup(id: string): Promise<WeChatChannelState> {
    if (!this.openViewer) throw new Error('wechat.unavailable');
    const current = await this.requireCurrentWorker();
    if (!current.replyTargetBindingSupported) throw new Error('wechat.replyTargetsWorkerUpgradeRequired');
    await this.run(['bind-reply-group', '--roster-id', wechatDigestGroupIdSchema.parse(id)], undefined, 16_384, 180_000);
    return this.requireConfigured();
  }

  async getReplyFriends(): Promise<WeChatReplyFriend[]> {
    await this.requireFriendWorker();
    return z.strictObject({ friends: z.array(replyFriendSchema).max(WECHAT_REPLY_FRIEND_LIMIT) })
      .parse(await this.run(['list-reply-friends'])).friends;
  }

  async listReplyFriends(): Promise<WeChatReplyFriend[]> {
    await this.requireFriendWorker();
    return z.strictObject({ friends: z.array(friendRosterEntrySchema).max(250) })
      .parse(await this.run(['reply-friend-roster'], undefined, 96_000, 35_000)).friends;
  }

  async addReplyFriend(id: string): Promise<WeChatReplyFriend[]> {
    await this.requireFriendWorker();
    replyFriendSchema.parse(await this.run(['bind-reply-friend', '--roster-id', wechatFriendRosterIdSchema.parse(id)], undefined, 16_384, 180_000));
    return this.getReplyFriends();
  }

  async removeReplyFriend(id: string): Promise<WeChatReplyFriend[]> {
    await this.requireFriendWorker();
    z.strictObject({ removed: z.literal(true) }).parse(await this.run(['remove-reply-friend', '--friend', wechatFriendIdSchema.parse(id)], undefined, 16_384, 120_000));
    return this.getReplyFriends();
  }

  async removeGroup(id: string): Promise<WeChatChannelState> {
    await this.requireCurrentWorker();
    await this.run(['group-remove', '--group', id], undefined, 16_384, 90_000);
    return this.requireConfigured();
  }

  async getModels(): Promise<string[]> {
    await this.requireConfigured();
    return z.array(wechatModelSchema).max(32).parse(await this.run(['reply-models']));
  }

  async configureReply(input: WeChatReply): Promise<WeChatChannelState> {
    await this.requireCurrentWorker();
    await this.run(['reply-settings', '--set'], input);
    return this.requireConfigured();
  }

  async recoverWindow(): Promise<WeChatWindow> {
    await this.requireConfigured();
    if (!this.openViewer) throw new Error('wechat.unavailable');
    return wechatWindowSchema.parse(await this.run(['recover-window'], undefined, 4096, 95_000));
  }

  async openVirtualMachine(): Promise<void> {
    await this.requireConfigured();
    if (!this.openViewer) throw new Error('wechat.unavailable');
    const result = z.object({ url: z.literal(viewer) }).strict().parse(await this.run(['open-viewer']));
    await this.openViewer(result.url + '&bell=off');
  }

  async cloudBindings(): Promise<Record<string, string>> {
    await this.requireCurrentWorker();
    return z.record(z.string().regex(/^(?:private|legacy|(?:friend:)?[a-f0-9]{32})$/u), z.string().regex(/^[a-f0-9]{64}$/u))
      .parse(await this.run(['cloud-bindings']));
  }

  async authorizeCloud(input: object): Promise<string> {
    const result = z.strictObject({ ok: z.literal(true), routeFingerprint: z.string().regex(/^(?:local|owner-command|read-tool|article|rich|sticker-selection|[a-f0-9]{64})$/u) })
      .parse(await this.run(['cloud-authorize'], input));
    return result.routeFingerprint;
  }

  async deliverOwner(input: { binding: string; deliveryId: string; text: string; stickerAsset?: string; voice?: boolean; recordTranscript?: false; digestKind?: WeChatDigestKind }): Promise<'sent' | 'retry' | 'uncertain'> {
    // Allow for each 30-second lock wait, including voice fallback and the separate sticker action.
    const timeout = input.voice && input.stickerAsset ? 290_000 : input.voice || input.stickerAsset ? 260_000 : 150_000;
    const result = z.strictObject({ status: z.enum(['sent', 'paused', 'busy', 'retry', 'uncertain', 'binding_invalid', 'conflict', 'invalid_payload']) })
      .parse(await this.run(['owner-deliver'], { id: input.deliveryId, binding: input.binding, text: input.text,
        ...(input.stickerAsset ? { stickerAsset: input.stickerAsset } : {}), ...(input.voice ? { voice: true } : {}),
        ...(input.recordTranscript === false ? { recordTranscript: false } : {}),
        ...(input.digestKind ? { digestKind: input.digestKind } : {}) }, 16_384, timeout));
    if (result.status === 'sent') return 'sent';
    return ['paused', 'busy', 'retry'].includes(result.status) ? 'retry' : 'uncertain';
  }

  async selfTest(input: { id: string; text: string }): Promise<DoctorSelfTestResult> {
    await this.requirePrivateRoot();
    return doctorSelfTestResultSchema.parse(await this.run(['self-test'], input, 4096, 240_000));
  }

  async vmHealth(): Promise<DoctorVmHealth> {
    await this.requirePrivateRoot();
    return doctorVmHealthSchema.parse(await this.run(['vm-health'], undefined, 4096, 25_000));
  }

  async latestAppOutage(): Promise<AppOutage | null> {
    await this.requirePrivateRoot();
    return z.strictObject({ outage: appOutageSchema.nullable() }).parse(await this.run(['app-outage-status'], undefined, 1024, 5_000)).outage;
  }

  async postMoment(input: { id: string; text: string; visibility: 'all' | 'private'; images: Buffer[] }): Promise<MomentPostOutcome> {
    await this.requireConfigured();
    const result = z.strictObject({ status: z.enum(['posted', 'uncertain', 'retry', 'conflict', 'invalid_payload', ...WECHAT_MOMENT_WINDOW_FAILURES]) })
      .parse(await this.run(['moments-post'], { id: input.id, text: input.text, visibility: input.visibility,
        images: input.images.map(image => image.toString('base64')) }, 16_384, 240_000));
    return result.status;
  }

  async previewMoment(input: { id: string; binding: string; text: string; image: Buffer }): Promise<MomentPreviewOutcome> {
    const result = z.strictObject({ status: z.enum(['sent', 'retry', 'uncertain', 'binding_invalid', 'conflict', 'invalid_payload', ...WECHAT_MOMENT_WINDOW_FAILURES]) })
      .parse(await this.run(['moments-preview'], { id: input.id, binding: input.binding, text: input.text, image: input.image.toString('base64') }, 16_384, 210_000));
    switch (result.status) {
      case 'binding_invalid':
      case 'conflict':
      case 'invalid_payload': return 'uncertain';
      default: return result.status;
    }
  }

  async momentAnswerContext(draftId: string, input: object): Promise<MomentAnswerContext> {
    const result = z.strictObject({ context: z.enum(['before-preview', 'later', 'next']) })
      .parse(await this.run(['moments-answer-context', draftId], input, 16_384, 5_000));
    return result.context;
  }

  async digestGroups(): Promise<Array<{ id: string; title: string; replying?: true | undefined }>> {
    await this.requireCurrentWorker();
    return z.strictObject({ groups: z.array(z.strictObject({ id: wechatDigestGroupIdSchema, title: z.string().min(1).max(256),
      replying: z.literal(true).optional() })).max(250) })
      .parse(await this.run(['digest-group-list'], undefined, 96_000, 35_000)).groups;
  }

  async selectDigestGroups(binding: string, ids: string[]): Promise<void> {
    await this.requireCurrentWorker();
    z.strictObject({ ok: z.literal(true) }).parse(await this.run(['digest-group-select'], { binding, ids }));
  }

  async digestGroupRead(binding: string, id: string, until: number) {
    await this.requireCurrentWorker();
    const row = z.strictObject({ text: z.string().min(1).max(800), at: z.number().int().nonnegative(),
      mentionsOwner: z.boolean().optional(), speaker: z.string().max(120).optional() });
    return z.strictObject({ rows: z.array(row).max(100), truncated: z.boolean() })
      .parse(await this.run(['digest-group-read'], { binding, id, until }, 220_000));
  }

  async selectFollowupGroups(binding: string, ids: string[]): Promise<void> {
    await this.requireCurrentWorker();
    z.strictObject({ ok: z.literal(true) }).parse(await this.run(['followup-group-select'], { binding, ids }, 16_384, 42_000));
  }

  async followupGroupRead(binding: string, id: string, since: number, until: number) {
    await this.requireCurrentWorker();
    return wechatFollowupEvidenceReadSchema.parse(await this.run(['followup-group-read'], { binding, id, since, until }, 440_000, 42_000));
  }

  async officialAccounts(): Promise<Array<{ id: string; title: string }>> {
    await this.requireCurrentWorker();
    return z.strictObject({ accounts: z.array(z.strictObject({ id: wechatOfficialAccountIdSchema, title: z.string().min(1).max(256) })).max(250) })
      .parse(await this.run(['official-list'], undefined, 96_000)).accounts;
  }

  async officialArticles(binding: string, ids: string[] | null, until: number) {
    await this.requireCurrentWorker();
    const article = z.strictObject({ url: z.string().min(1).max(500), title: z.string().min(1).max(160),
      account: z.string().max(80), at: z.number().int().nonnegative() });
    return z.strictObject({ articles: z.array(article).max(160), truncated: z.boolean() })
      .parse(await this.run(['official-read'], { binding, ids, until }, 256_000));
  }

  async friendsMoments(binding: string, days: 1 | 7, until: number) {
    await this.requireCurrentWorker();
    const post = z.strictObject({ author: z.string().min(1).max(160), text: z.string().max(1200),
      images: z.number().int().min(0).max(20), at: z.number().int().nonnegative() });
    return z.strictObject({ posts: z.array(post).max(80), truncated: z.boolean() })
      .parse(await this.run(['friends-moments-read'], { binding, days, until }, 210_000));
  }

  async readTranscript(): Promise<unknown> {
    await this.requirePrivateRoot();
    return this.run(['transcript-read'], undefined, 524_288);
  }

  async acknowledgeTranscript(input: object): Promise<unknown> {
    await this.requirePrivateRoot();
    return this.run(['transcript-ack'], input);
  }

  private async requirePrivateRoot(): Promise<void> {
    if (this.platform !== 'darwin') throw new Error('wechat.unavailable');
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) throw new Error('wechat.unavailable');
  }

  private async requireCurrentWorker(): Promise<WeChatChannelState> {
    const current = await this.requireConfigured();
    if (!current.groupBindingSupported) throw new Error('wechat.unavailable');
    return current;
  }

  private async requireFriendWorker(): Promise<void> {
    if (!this.openViewer) throw new Error('wechat.unavailable');
    const current = await this.requireCurrentWorker();
    if (!current.friendReplySupported) throw new Error('wechat.replyTargetsWorkerUpgradeRequired');
  }

  private async requireConfigured(): Promise<WeChatChannelState> {
    const current = await this.getState();
    if (!current.configured) throw new Error('wechat.unavailable');
    return current;
  }

  private run(command: readonly string[], input?: object, outputLimit = 16_384, timeout?: number): Promise<unknown> {
    const args = ['-B', this.script, '--config', join(this.root, 'targets.json'),
      '--state', join(this.root, 'listener.db'), '--runtime', join(this.root, 'listener'), ...command];
    return new Promise((resolve, reject) => {
      const child = spawn(python, args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        timeout: timeout ?? (['channel-status', 'cloud-authorize', 'cloud-bindings', 'transcript-read', 'transcript-ack'].includes(command[0] ?? '') ? 5_000 : 35_000),
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > outputLimit) child.kill();
      });
      child.stdin.on('error', () => undefined);
      child.once('error', () => reject(new Error('wechat.unavailable')));
      child.once('close', code => {
        try {
          if (output.length > outputLimit) throw new Error();
          const payload: unknown = JSON.parse(output);
          if (code === 0) { resolve(payload); return; }
          const reason = (payload as { error?: unknown } | null)?.error;
          if (typeof reason === 'string' && Object.hasOwn(errors, reason)) {
            reject(new Error(`wechat.${errors[reason as keyof typeof errors]}`)); return;
          }
        } catch { /* Unavailable or incompatible listener helper. */ }
        reject(new Error('wechat.unavailable'));
      });
      child.stdin.end(input ? JSON.stringify(input) : undefined);
    });
  }
}
