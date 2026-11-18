import { ToolFailure } from '../runtime/tool-failure';
import { isQqChannel, isQqGroupChannel } from './execution-context';
import type { ChannelContext } from './execution-context';

/** Version of the fixed QQ capability ceiling. Persisted with QQ-created work so
 * a policy change can re-intersect or disable older state on load. */
export { QQ_CHANNEL_POLICY_VERSION } from '../../shared/qq-channel';

const NOTES_TOOLS = ['notes.search', 'notes.read', 'notes.save'];

/** Exact tool ids a QQ-originated run may declare or execute. Desktop keeps its
 * own permission flow. Additions require a policy review and a version bump. */
export const QQ_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'time.current',
  'math.calculate',
  'web.search',
  'web.read',
  'task.update',
  'task.list',
  'task.get',
  'cron.create',
  'cron.update',
  'cron.resume',
  'cron.pause',
  'cron.cancel',
  'cron.list',
  'cron.history',
  ...NOTES_TOOLS,
]);

/** Other members of a group can write here, so a group gets read-only research
 * and nothing that creates work or reaches the owner's records. */
export const QQ_GROUP_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['time.current', 'math.calculate', 'web.search', 'web.read']);

/** Capabilities a QQ-created recurring task may retain. `workspace.write` is
 * deliberately excluded even though desktop cron permits it. */
export const QQ_CRON_CAPABILITIES: readonly string[] = ['web.search', 'web.read', 'math.calculate', 'time.read'];

/** Per-run budget for web.* tool calls from QQ. Enforced by the host counter,
 * not by the model prompt. */
export const QQ_WEB_CALL_LIMIT_DEFAULT = 10;

/** Host-enforced per-run web.* call budget for QQ runs. `consume` returns false
 * once the run exceeds its limit; desktop runs never construct this. */
export class QqWebBudget {
  readonly #used = new Map<string, number>();
  constructor() {}
  consume(runId: string, toolId: string, limit: number = QQ_WEB_CALL_LIMIT_DEFAULT): boolean {
    if (!toolId.startsWith('web.')) return true;
    const used = (this.#used.get(runId) ?? 0) + 1;
    if (used > limit) return false;
    this.#used.set(runId, used);
    return true;
  }
  release(runId: string): void { this.#used.delete(runId); }
}

/** Capabilities the host may auto-approve for a QQ run with a one-shot
 * operation lease (read-only research and bookkeeping). QQ has no console
 * approval card; chat.cron only admits pause/cancel or a pending draft, never
 * direct creation/update/resume of a QQ schedule. */
export const QQ_AUTO_APPROVE_CAPABILITIES: ReadonlySet<string> = new Set(['web.search', 'web.read', 'math.calculate', 'time.read', 'task.records', 'chat.cron', 'notes.read', 'notes.write']);

const TELEGRAM_TOOLS: ReadonlySet<string> = new Set([
  'time.current', 'math.calculate', 'web.search', 'web.read', 'task.update', 'task.list', 'task.get',
  'workspace.list', 'workspace.search', 'workspace.read', 'workspace.write',
  ...NOTES_TOOLS,
]);

/** The owner's bound WeChat private chat: public research, the conversation's
 * own task records and recurring tasks. Files, shell, settings and credentials
 * stay on the desktop. */
export const WECHAT_TOOLS: ReadonlySet<string> = new Set([
  'time.current', 'math.calculate', 'web.search', 'web.read', 'task.update', 'task.list', 'task.get',
  'cron.create', 'cron.update', 'cron.resume', 'cron.pause', 'cron.cancel', 'cron.list', 'cron.history',
  'moments.propose',
  ...NOTES_TOOLS,
]);

/** Capabilities the host grants a WeChat run one operation at a time, without a
 * console card. Recurring tasks created here may keep only WECHAT_CRON_CAPABILITIES. */
// A Moments draft only reaches the owner's preview; posting needs their WeChat reply.
export const WECHAT_AUTO_APPROVE_CAPABILITIES: ReadonlySet<string> = new Set(['web.search', 'web.read', 'math.calculate', 'time.read', 'task.records', 'chat.cron', 'wechat.moments', 'notes.read', 'notes.write']);
export const WECHAT_CRON_CAPABILITIES: readonly string[] = QQ_CRON_CAPABILITIES;

/** A WeChat group: anyone there can write, so time and arithmetic, and public research only where the owner allowed it. */
export const WECHAT_GROUP_TOOLS: ReadonlySet<string> = new Set(['time.current', 'math.calculate']);
export const WECHAT_GROUP_WEB_TOOLS: ReadonlySet<string> = new Set(['web.search', 'web.read']);
export const WECHAT_GROUP_WEB_CALL_LIMIT = 3;

export const channelPermitsTool = (context: ChannelContext, toolId: string): boolean =>
  context.origin === 'desktop' ? true : context.origin === 'telegram' ? TELEGRAM_TOOLS.has(toolId)
    : context.origin === 'wechat' ? (context.group ? WECHAT_GROUP_TOOLS.has(toolId) || (context.group.web && WECHAT_GROUP_WEB_TOOLS.has(toolId)) : WECHAT_TOOLS.has(toolId))
      : isQqChannel(context) && (isQqGroupChannel(context) ? QQ_GROUP_ALLOWED_TOOLS.has(toolId) : QQ_ALLOWED_TOOLS.has(toolId)
        && (context.scheduleId === undefined || ['time.current', 'math.calculate', 'web.search', 'web.read', 'task.update'].includes(toolId)));

export const assertChannelToolPermitted = (context: ChannelContext, toolId: string): void => {
  if (!channelPermitsTool(context, toolId)) throw new ToolFailure('tool.channelBlocked');
};

/** Intersect a requested cron capability list with the QQ ceiling. */
export const intersectQqCronCapabilities = <Capability extends string>(capabilities: readonly Capability[]): Capability[] =>
  capabilities.filter((capability) => QQ_CRON_CAPABILITIES.includes(capability));
