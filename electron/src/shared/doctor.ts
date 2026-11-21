import { z } from 'zod';
import type { ModelBindingIssue } from './model-bindings';
import { describeWeChatSendDiagnostics } from './wechat-send-diagnostics';

/** One problem the doctor noticed. Codes, counts and times only: never message content, names or who sent anything. */
export const doctorCaseSchema = z.object({
  /** Stable identity while the problem lasts; one-off events carry their own time. */
  key: z.string().min(1).max(200),
  feature: z.string().min(1).max(40),
  code: z.string().min(1).max(80),
  severity: z.enum(['error', 'warning']),
  /** A one-off event (a dropped message, an abnormal exit) has no "recovered" notice. */
  event: z.boolean(),
  detail: z.string().max(200).nullable(),
  openedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  /** Consecutive checks that saw it while open. */
  seen: z.number().int().min(1),
  /** held: noticed during quiet hours, reported in the morning. */
  reported: z.enum(['qq', 'desktop', 'held', 'failed']).nullable(),
  reportedAt: z.iso.datetime().nullable(),
  recoveryReported: z.boolean(),
  /** Closed by the owner, not by observed recovery. */
  acknowledged: z.literal(true).optional(),
}).strict();
export type DoctorCase = z.infer<typeof doctorCaseSchema>;

/** A diagnosis is display-only; reject the entire text rather than trying to redact instructions. */
export const safeDoctorDiagnosis = (text: string): boolean => {
  if (!text.trim() || [...text].length > 200 || /[\p{Cc}\p{Cf}`\\/|;&<>$]/u.test(text)) return false;
  const normalized = text.normalize('NFKC');
  if (/[\p{Cc}\p{Cf}`\\/|;&<>$]/u.test(normalized)) return false;
  return !/(?:https?:|www\.|\b[\w-]+\.[a-z]{2,}\b|[A-Za-z]:|~|--[a-z]|\b(?:sudo|su|ssh|curl|wget|chmod|chown|bash|zsh|sh|fish|powershell|python\d?|node|rm|kill|launchctl|osascript|ls|cat|df|du|ps|top|grep|find|mkdir|mv|cp|touch|git|npm|pip\d?|brew)\b|终端|命令行|执行命令|运行命令|删[除掉]|清空|格式化|(?:关闭|停用|禁用|解除).{0,8}(?:防火墙|安全|保护)|(?:修改|更改|禁用).{0,8}安全|(?:清理|移除|移走|抹掉|擦除|重置).{0,12}(?:文件|目录|日志|磁盘|记录|安全|权限)|(?:降低|放宽|取消|绕过).{0,8}(?:安全|防护|校验|保护|权限)|wxid[_-]|api[_ -]?key\s*[:=]|\bsk-[a-z0-9]|\d{11,})/iu.test(normalized);
};
export const doctorDiagnosisSchema = z.strictObject({ at: z.iso.datetime(), source: z.enum(['cloud', 'local']), text: z.string().refine(safeDoctorDiagnosis) });
export type DoctorDiagnosis = z.infer<typeof doctorDiagnosisSchema>;
export interface DoctorRunbookEntry { causes: string[]; actions: string[] }

export const DOCTOR_SELF_TEST_STAGES = ['lock', 'open', 'title', 'paste', 'click', 'ocrReceipt', 'dbReceipt'] as const;
export const DOCTOR_SELF_TEST_STAGE_LABELS: Record<typeof DOCTOR_SELF_TEST_STAGES[number], string> = {
  lock: '桌面锁', open: '打开会话', title: '目标标题', paste: '粘贴', click: '点击发送', ocrReceipt: '界面回执', dbReceipt: '数据库回执',
};
export const doctorSelfTestResultSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'uncertain', 'busy', 'paused', 'skipped']),
  code: z.enum(['self_test_target', 'self_test_db_unavailable', 'self_test_db_unconfirmed', 'self_test_conflict',
    'self_test_settings_changed', 'self_test_send', 'self_test_payload']).nullable(),
  stages: z.strictObject({ lock: z.boolean(), open: z.boolean(), title: z.boolean(), paste: z.boolean(), click: z.boolean(), ocrReceipt: z.boolean(), dbReceipt: z.boolean() }),
  durationMs: z.number().int().nonnegative(),
}).refine(result => result.status !== 'passed' || ['lock', 'open', 'title', 'paste', 'click', 'dbReceipt'].every(stage => result.stages[stage as keyof typeof result.stages]),
  { message: 'A passed self-test requires the complete send chain and a database receipt.' });
export type DoctorSelfTestResult = z.infer<typeof doctorSelfTestResultSchema>;
export const doctorSelfTestRecordSchema = doctorSelfTestResultSchema.safeExtend({ at: z.iso.datetime(), source: z.enum(['auto', 'manual']) });
export type DoctorSelfTestRecord = z.infer<typeof doctorSelfTestRecordSchema>;
export const doctorSelfTestDaySchema = z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), at: z.iso.datetime(), status: z.enum(['passed', 'failed', 'uncertain']) });
export type DoctorSelfTestDay = z.infer<typeof doctorSelfTestDaySchema>;
export const doctorSelfTestScheduleSchema = z.strictObject({
  day: z.string().max(10).default(''), attempts: z.number().int().nonnegative().default(0), complete: z.boolean().default(false),
  nextAt: z.iso.datetime().nullable().default(null), failures: z.number().int().nonnegative().default(0),
  failure: z.strictObject({ status: z.enum(['failed', 'uncertain']), stage: z.enum(DOCTOR_SELF_TEST_STAGES) }).nullable().default(null),
  manualDay: z.string().max(10).default(''), manualCount: z.number().int().nonnegative().default(0),
  pending: z.strictObject({ at: z.iso.datetime(), source: z.enum(['auto', 'manual']) }).nullable().default(null),
  coverage: z.array(z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), attempts: z.number().int().nonnegative(), paused: z.boolean() })).max(14).default([]),
  lastConclusiveAt: z.iso.datetime().nullable().default(null),
});

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const doctorVmHealthSchema = z.strictObject({ totalBytes: bytes.positive(), freeBytes: bytes,
  authLogBytes: bytes, journalBytes: bytes, uptimeSeconds: bytes, wechatRunning: z.boolean() })
  .refine(result => result.freeBytes <= result.totalBytes && Number.isSafeInteger(result.authLogBytes + result.journalBytes));
export type DoctorVmHealth = z.infer<typeof doctorVmHealthSchema>;
export const doctorVmStateSchema = z.strictObject({
  attemptedAt: z.iso.datetime().nullable().default(null), failures: z.number().int().nonnegative().default(0),
  latest: doctorVmHealthSchema.safeExtend({ at: z.iso.datetime(), growth24hBytes: bytes.nullable() }).nullable().default(null),
  samples: z.array(z.strictObject({ at: z.iso.datetime(), logBytes: bytes })).max(48).default([]),
});
export const doctorProviderTestCodeSchema = z.enum(['provider.authentication', 'provider.quota', 'provider.rateLimit', 'provider.timeout',
  'provider.unavailable', 'provider.network', 'provider.modelUnavailable', 'provider.credentialsRequired', 'provider.request',
  'provider.streamInterrupted', 'provider.truncated', 'provider.failed', 'provider.bindingMismatch', 'provider.budgetExceeded',
  'provider.unsupportedParameter', 'provider.regionRestricted']);
export const doctorProviderTestResultSchema = z.strictObject({ status: z.enum(['passed', 'failed', 'skipped']),
  code: doctorProviderTestCodeSchema.nullable(), durationMs: z.number().int().nonnegative() });
export type DoctorProviderTestResult = z.infer<typeof doctorProviderTestResultSchema>;
export const doctorProviderTestRecordSchema = doctorProviderTestResultSchema.extend({ at: z.iso.datetime(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) });
export type DoctorProviderTestRecord = z.infer<typeof doctorProviderTestRecordSchema>;

export const doctorRepairIdSchema = z.enum(['wechat', 'qq', 'telegram', 'asr', 'knowledge', 'minecraft']);
export type DoctorRepairId = z.infer<typeof doctorRepairIdSchema>;
export const DOCTOR_REPAIR_LOG_LIMIT = 100;
export const doctorRepairSchema = z.strictObject({
  id: doctorRepairIdSchema,
  at: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  result: z.enum(['running', 'recovered', 'failed']),
  circuitUntil: z.iso.datetime().nullable(),
  heldForMorning: z.boolean(),
  reportedAt: z.iso.datetime().nullable(),
});
export type DoctorRepair = z.infer<typeof doctorRepairSchema>;
export const DOCTOR_REPAIR_ACTIONS: Record<DoctorRepairId, Record<'zh-CN' | 'en', string>> = {
  wechat: { 'zh-CN': '重启微信监听', en: 'Restart WeChat listener' },
  qq: { 'zh-CN': '重连 QQ', en: 'Reconnect QQ' },
  telegram: { 'zh-CN': '重连 Telegram', en: 'Reconnect Telegram' },
  asr: { 'zh-CN': '重启本地语音识别', en: 'Restart local speech recognition' },
  knowledge: { 'zh-CN': '重新索引知识库', en: 'Reindex knowledge vault' },
  minecraft: { 'zh-CN': '重启 Minecraft 专用服', en: 'Restart local Minecraft server' },
};

export const doctorStateSchema = z.object({
  enabled: z.boolean(),
  autoRepair: z.boolean().default(true),
  repairs: z.array(doctorRepairSchema).max(DOCTOR_REPAIR_LOG_LIMIT).default([]),
  cases: z.array(doctorCaseSchema).max(200),
  alerts: z.object({ day: z.string().max(10), count: z.number().int().min(0) }).strict(),
  /** The current run; a run that never reached shutdown ended abnormally. */
  session: z.object({ startedAt: z.iso.datetime(), cleanExit: z.boolean() }).strict().nullable(),
  selfTests: z.array(doctorSelfTestRecordSchema).max(14).default([]),
  selfTestDays: z.array(doctorSelfTestDaySchema).max(14).default([]),
  selfTestSchedule: doctorSelfTestScheduleSchema.default(() => doctorSelfTestScheduleSchema.parse({})),
  vm: doctorVmStateSchema.default(() => doctorVmStateSchema.parse({})),
  diagnosis: doctorDiagnosisSchema.nullable().default(null),
  diagnoses: z.strictObject({ day: z.string().max(10), count: z.number().int().nonnegative() }).default({ day: '', count: 0 }),
  providerTestDay: z.string().max(10).default(''),
  providerTests: z.array(doctorProviderTestRecordSchema).max(14).default([]),
}).strict();
export type DoctorState = z.infer<typeof doctorStateSchema>;

const epochSecond = z.number().int().positive().max(8.64e12);
export const appOutageSchema = z.strictObject({ startedAt: epochSecond, notifiedAt: epochSecond.nullable(),
  recoveredAt: epochSecond.nullable(), recoveryNotifiedAt: epochSecond.nullable() });
export type AppOutage = z.infer<typeof appOutageSchema>;

export interface DoctorStatus {
  enabled: boolean;
  autoRepair: boolean;
  repairs: DoctorRepair[];
  lastCheckAt: string | null;
  open: number;
  alertsToday: number;
  dailyLimit: number;
  /** Newest first. */
  cases: DoctorCase[];
  selfTests: DoctorSelfTestRecord[];
  selfTestPassRate: number | null;
  manualSelfTestsToday: number;
  vm: z.infer<typeof doctorVmStateSchema>;
  diagnosis: DoctorDiagnosis | null;
  runbooks: Record<string, DoctorRunbookEntry>;
  providerTests: DoctorProviderTestRecord[];
  appOutage?: AppOutage | null;
  modelIssues?: ModelBindingIssue[];
}

export const DOCTOR_FEATURES: Record<string, string> = {
  asr: '本地语音识别', diary: '日记', proactive: '主动消息', 'wechat-moments': '朋友圈', 'wechat-cron': '微信定时投递', 'wechat-group-digest': '群聊每日精华', 'wechat-followup': '等你处理', 'wechat-official-brief': '公众号简报', 'wechat-friends-moments': '好友朋友圈摘要', 'wechat-friend-reply': '微信好友回复',
  'auto-memory': '自动记忆', 'companion-recent': '最近对话摘要', 'memory-sleep': '夜间记忆整理', schedules: '定时任务', wechat: '微信', qq: 'QQ', telegram: 'Telegram',
  knowledge: '知识库', minecraft: 'Minecraft 专用服', system: '系统', app: '桌宠', provider: '聊天模型',
};
export const DOCTOR_CODES: Record<string, string> = {
  ...describeWeChatSendDiagnostics('zh-CN'),
  'wechat.unreadable': '读不到微信监听程序的状态。', 'wechat.stale': '微信监听程序没有心跳了。', 'wechat.degraded': '微信监听程序卡住了。', 'wechat.stopped': '微信监听程序没有运行。',
  'wechat.digest_read': '无法读取已授权的微信资料。', 'wechat.digest_model': '摘要模型不可用或没有返回有效结果。',
  'wechat.digest_delivery_failed': '摘要未能发到主人私聊。', 'wechat.digest_delivery_uncertain': '摘要可能已经发出，不会自动重发。',
  'wechat.digest_interrupted': '上次微信摘要运行中断。', 'wechat.digest_storage': '无法读取或保存加密摘要状态。',
  'wechat.digest_configuration': '微信摘要设置或授权无法确认。',
  'wechat.followup_read': '暂时无法完整核对群里的待跟进消息。',
  'wechat.friend_rate_limited': '已到好友回复频率上限，超出的消息已跳过。',
  'wechat.friend_send_uncertain': '好友回复目前未确认送达。不会重复发送。',
  'wechat.friend_binding_invalid': '无法确认好友会话绑定。',
  'wechat.friend_database_unavailable': '无法读取好友的已绑定会话。',
  'wechat.friend_reply_unavailable': '暂时无法生成或投递好友回复。',

  'wechat.rich_reply_unavailable': '微信暂时无法处理富消息。',
  'wechat.selfTestFailed': '微信发送自检连续两次失败。',
  'wechat.selfTestUncertain': '微信发送自检连续两次没有取得数据库确认，不会重复发送同一条。',
  'wechat.selfTestSkipped': '微信发送自检连续两天没能运行（一直在让路或被暂停）。',
  'wechat.vmDiskLow': '微信虚拟机磁盘剩余不足 4 GB。',
  'wechat.vmDiskCritical': '微信虚拟机磁盘剩余不足 1.5 GB，快满了，可能影响收发和保存。',
  'wechat.vmLogGrowth': '微信虚拟机日志过大或最近一天增长过快。',
  'wechat.vmUnreachable': '连续两次读不到微信虚拟机的体检数据。',
  'wechat.uncertain': '有回复不确定是否发出去了，请在微信核对。',
  'wechat.cronDeliveryFailed': '定时回复投递失败。', 'wechat.cronDeliveryUncertain': '定时回复可能已发送，请在微信确认。',
  'wechat.momentWindowBusy': '微信窗口被其他操作占用，朋友圈操作未完成。',
  'wechat.momentListenerPaused': '微信监听已暂停，朋友圈操作未完成。',
  'wechat.momentWindowError': '打开微信窗口时出错，朋友圈操作未完成。',
  'wechat.momentFailed': '朋友圈请求失败。', 'wechat.momentUncertain': '朋友圈可能已经发了，请在手机核对，不要重复发。',
  'wechat.momentPublishUnconfirmed': '无法确认朋友圈是否发布，请在手机核对。',
  'qq.offline': 'QQ 连接断开了。', 'qq.deliveryFailed': '有 QQ 消息发送失败。', 'qq.uncertain': '有 QQ 消息不确定是否送达。',
  'telegram.offline': 'Telegram 连接断开了。', 'telegram.uncertain': '有 Telegram 消息不确定是否送达。',
  'provider.authentication': 'API key 无效或已过期。', 'provider.quota': '模型服务的额度用完了。', 'provider.rateLimit': '请求太频繁，被模型服务限流了。',
  'provider.selfTestFailed': '聊天模型自检连续两天失败，请检查 API key、额度和服务状态。',
  'provider.selfTestSlow': '聊天模型自检连续两天响应超过 30 秒。',
  'provider.timeout': '模型回答超时。', 'provider.unavailable': '模型服务暂时不可用。', 'provider.network': '连不上模型服务。',
  'provider.modelUnavailable': '这个账号用不了这个模型。', 'provider.request': '模型服务拒绝了请求。',
  'cron.failed': '上次运行失败。', 'cron.interrupted': '上次运行被中断了。',
  'knowledge.embeddingModelMissing': '本机 Ollama 缺少知识库选用的嵌入模型。',
  'knowledge.indexRepeatedFailures': '知识库索引连续失败，可在运行状态查看上次错误码。',
  'diary.failed': '日记写入失败。', 'diary.storage': '加密日记读取失败（原文件没有覆盖）。',
  'diary.noCloud': '日记需要当前选中的云端模型服务。',
  'diary.contextChanged': '对话或角色设置已变更，日记停止写入。',
  'diary.interrupted': '日记写入中断。', 'diary.disabled': '生成期间关闭了日记。',
  'diary.invalid': '模型返回的日记格式无效。', 'diary.tooLarge': '模型返回的日记太长。',
  'diary.incomplete': '模型未完整返回日记。',
  'recent.failed': '最近对话摘要生成失败。', 'recent.incomplete': '模型未完整返回最近对话摘要。',
  'recent.invalidResult': '模型返回的最近对话摘要无法使用。',
  'chat.contextStale': '生成期间对话资料已变更。', 'autoMemory.invalidResult': '模型返回的自动记忆格式无效。',
  'sleep.invalidResult': '模型返回的夜间记忆整理格式无效。',
  'minecraft.gaveUp': '本地专用服重启次数用完，服务器已停止。',
  'asr.worker': '本地语音识别进程停止了。', 'asr.runtime': '离线语音文件夹缺失或不完整。', 'asr.permission': '麦克风权限被拒绝。',
  'proactive.pausedByError': '主动消息多次失败，已暂停。', 'proactive.deliveryFailed': '主动消息未确认送达。',
  'sleep.noProvider': '还没有选择模型。', 'sleep.incomplete': '模型没有回答完。', 'autoMemory.incomplete': '模型没有回答完。',
  'system.diskLow': '系统盘剩余空间偏低。', 'system.diskCritical': '系统盘快满了。',
  'app.uncleanExit': '桌宠上次没有正常退出。', 'wechat.dropped': '微信有未能完成的回复。', 'wechat.skipped': '微信出现暂不支持的消息类型。',
  'doctor.unknown': '有功能返回了未分类的错误。',
  'telegram.deliveryFailed': '有 Telegram 消息发送失败。',
  'wechat.send_friend_binding_mismatch': '当前好友会话与绑定不符。',
  'provider.credentialsRequired': '模型服务尚未配置可用的 API key。',
  'provider.failed': '模型服务请求失败。',
  'provider.cancelled': '模型请求已取消。',
  'provider.streamInterrupted': '模型回答中断了。', 'provider.truncated': '模型回答被截断了。',
  'provider.contextBudgetExceeded': '模型请求超过上下文预算。', 'provider.invalidRequestBudget': '模型请求预算无法确认。',
  'provider.bindingMismatch': '模型设置或凭据在请求期间发生变化。', 'provider.contextPrivacyBlocked': '模型请求被隐私保护拦截。',
  'provider.budgetExceeded': '模型使用预算已达到上限。', 'provider.requestRecordFailed': '无法保存模型请求记录。',
  'provider.discoveryBusy': '模型列表查询繁忙。', 'provider.discoveryFailed': '模型列表查询失败。',
  'provider.credentialEndpointChanged': '模型服务地址变化，需要重新确认凭据。', 'provider.configurationBusy': '模型设置正在更新。',
  'provider.permissionDenied': '模型服务权限不足。', 'provider.catalogInvalid': '模型列表格式不可用。',
  'provider.limitUnknown': '无法确认模型请求限制。', 'provider.unsupportedParameter': '模型服务不支持请求参数。',
  'provider.regionRestricted': '模型服务在当前地区不可用。',
  'diary.schedulerFailed': '日记调度失败。', 'autoMemory.failed': '自动记忆提取失败。',
  'proactive.screenUnknown': '暂时无法确认屏幕状态。', 'proactive.speechBusy': '语音任务繁忙，主动消息已让路。',
  'proactive.schedulerFailed': '主动消息调度失败。', 'proactive.wechatUnbound': '请先绑定主人微信私聊。',
  'proactive.privateResult': '仅本地的主动消息不能发到微信。', 'proactive.contextStale': '生成主动消息期间，授权资料已变更。',
  'proactive.deliveryUncertain': '主动消息可能已发送，请在微信核对。',
  'proactive.eventConflict': '同一主动消息事件的记录不一致。', 'proactive.eventCapacity': '主动消息事件记录已满。',
  'proactive.triggerCapacity': '主动消息运行记录已满。',
  'repository.commitUncertain': '尚不能确认资料是否保存，请刷新后核对。',
  'automation.permissionRequired': '自动执行权限未授予。', 'automation.unavailable': '自动执行暂不可用。',
  'automation.cancelled': '自动执行已取消。', 'job.privacyBlocked': '当前隐私设置禁止把资料发给所选模型服务。',
};
const KINDS: Record<string, string> = {
  text: '太长的文字', image: '图片', voice: '没转成文字的语音', card: '卡片', video: '视频', location: '位置', link: '链接',
  file: '文件', forward: '合并转发的聊天记录', miniprogram: '小程序', quote: '引用回复', transfer: '转账', redpacket: '红包', other: '未知类型',
};

export const doctorClock = (iso: string, timeZone?: string): string =>
  new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));

export const describeDoctorCase = (entry: Pick<DoctorCase, 'feature' | 'code' | 'detail'>, timeZone?: string): string => {
  const feature = DOCTOR_FEATURES[safeDoctorFeature(entry.feature)] ?? '功能';
  const detail = safeDoctorDetail(entry.detail);
  switch (entry.code) {
    case 'wechat.dropped': return `微信：最近一天有 ${detail ?? 1} 条消息没回成（一直发不出去或等太久，已跳过）。`;
    case 'wechat.skipped': return `微信：你发的一条${KINDS[detail ?? 'other'] ?? '消息'}她还看不懂，没有回复。`;
    case 'system.diskLow': return `系统：系统盘只剩 ${detail ?? '未知'}。`;
    case 'system.diskCritical': return `系统：系统盘只剩 ${detail ?? '未知'}，快满了，可能会影响保存和安装。`;
    case 'app.uncleanExit': return `桌宠：上次运行（${detail && z.iso.datetime().safeParse(detail).success ? doctorClock(detail, timeZone) : '?'} 启动）没有正常退出，可能是崩溃或被强制关闭。`;
    default: return `${feature}：${DOCTOR_CODES[safeDoctorCode(entry.code)]}`;
  }
};

export const safeDoctorCode = (code: string): string => Object.hasOwn(DOCTOR_CODES, code) ? code : code.startsWith('provider.') ? 'provider.failed' : 'doctor.unknown';
export const safeDoctorFeature = (feature: string): string => Object.hasOwn(DOCTOR_FEATURES, feature) ? feature : 'app';
export const safeDoctorDetail = (detail: string | null): string | null => {
  if (detail === null) return null;
  if ((DOCTOR_SELF_TEST_STAGES as readonly string[]).includes(detail) || Object.hasOwn(KINDS, detail)) return detail;
  if (/^\d{1,16}(?:\.\d{1,3})?(?: (?:GB|MB))?$/u.test(detail)) return detail;
  return z.iso.datetime().safeParse(detail).success ? detail : null;
};
