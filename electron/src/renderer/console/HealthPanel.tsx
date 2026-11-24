import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { AttentionAPI, HealthFeature, HealthItem, HealthSnapshot, HealthState } from '../../shared/attention';
import { describeWeChatSendDiagnostics } from '../../shared/wechat-send-diagnostics';
import { WECHAT_MOMENT_STAGE_LABELS } from '../../shared/wechat-moment-stages';
import './attention-center.css';
import { ModelBindingIssues } from './ModelBindingIssues';

type Locale = 'en' | 'zh-CN';
const sendDiagnostics = {
  en: describeWeChatSendDiagnostics('en'),
  'zh-CN': describeWeChatSendDiagnostics('zh-CN'),
};
const isWeChatSendDiagnostic = (code: string | null): boolean => code !== null && Object.hasOwn(sendDiagnostics.en, code);
const copy = {
  en: {
    title: 'Background status', intro: 'Features that run while you are not watching. A failure here would otherwise go unnoticed.',
    refresh: 'Refresh', loading: 'Checking…', readFailed: 'Could not read the status. Refresh to try again.',
    allGood: 'Everything that is turned on is working.', issues: (n: number) => `${n} not working`,
    onlyAcknowledged: (n: number) => `No new problems. You have already seen ${n}.`,
    vaultDetached: 'No vault linked', open: 'Open settings', lastSuccess: 'Last worked: ', lastFailure: 'Last failed: ', reason: 'Reason: ', never: 'not yet',
    fixLabel: 'What to do: ', acknowledge: 'Got it', acknowledged: 'Seen',
    acknowledgedNote: 'You marked this as seen. It comes back if it gets worse or a new problem appears.',
    acknowledgeFailed: 'The status changed before it could be marked. Look at the new status and try again.',
    failures: (feature: HealthFeature, n: number, code: string | null) => feature === 'schedules' ? `${n} failed runs in the last 7 days`
      : code === 'wechat.dropped' ? `${n} messages got no reply`
      : feature === 'wechat' || feature === 'qq' || feature === 'telegram' || feature === 'wechat-friend-reply' ? `${n} messages not confirmed as delivered` : `${n} failures in a row`,
    sinceLaunch: 'Times cover only the period since the app last started.',
    remaining: 'Remaining today: ',
    state: { ok: 'Working', failing: 'Not working', waiting: 'Not run yet', off: 'Off' } satisfies Record<HealthState, string>,
    feature: { asr: 'Local speech recognition', diary: 'Diary', knowledge: 'Knowledge vault', proactive: 'Unsolicited check-ins', 'wechat-moments': 'WeChat Moments', 'wechat-cron': 'WeChat scheduled delivery', 'wechat-group-digest': 'WeChat group digests', 'wechat-followup': 'Waiting for you', 'wechat-official-brief': 'WeChat official account brief', 'wechat-friends-moments': 'Friends’ Moments digest', 'wechat-friend-reply': 'Friend reply', 'auto-memory': 'Auto memory', 'companion-recent': 'Recent conversation summary', 'memory-sleep': 'Nightly memory tidy-up', schedules: 'Schedules', wechat: 'WeChat', qq: 'QQ', telegram: 'Telegram' } satisfies Record<HealthFeature, string>,
    about: {
      asr: 'Microphone audio is recognised on this Mac, never uploaded.', diary: 'One encrypted diary after the nightly tidy-up; only cloud-allowed owner conversations.', proactive: 'Uses the existing event policy, quiet hours and a durable daily allowance.',
      'wechat-moments': 'Draft previews and confirmed publishing; failures and uncertainty are shown here.',
      'wechat-cron': 'Sends scheduled results only to the bound owner’s private chat.',
      'wechat-group-digest': 'Summarizes the selected groups and delivers only to the owner’s private chat.',
      'wechat-followup': 'Checks selected group chats for mentions still awaiting a reply and reports them in the owner’s private chat.',
      'wechat-official-brief': 'Summarizes cached official account posts and delivers only to the owner’s private chat.',
      'wechat-friends-moments': 'Reads synced Moments from this account’s own friends and sends a private digest.',
      'wechat-friend-reply': 'Replies to incoming messages in this bound friend chat.',
      'auto-memory': 'Picks up lasting facts a few minutes after you stop chatting.',
      'companion-recent': 'Summarizes recent conversations for continuity.',
      'memory-sleep': 'Merges and sorts what was learned, once a night.',
      schedules: 'Scheduled tasks you set up in chat.',
      knowledge: 'The local index of your linked Markdown vault.',
      wechat: 'Replies in WeChat private chats and bound groups.',
      qq: 'Replies and reminders over QQ.',
      telegram: 'Remote chat over Telegram.',
    } satisfies Record<HealthFeature, string>,
    code: {
      ...sendDiagnostics.en,
      'knowledge.indexStale': 'The index has not been updated for more than 24 hours.',
      'knowledge.embeddingModelMissing': 'The selected embedding model is missing from local Ollama.',
      'asr.settings': 'Speech input settings could not be loaded.', 'asr.permission': 'Microphone permission was denied. Allow it in macOS Privacy & Security.',
      'asr.runtime': 'The offline speech folder is missing or incomplete.', 'asr.worker': 'The local speech worker stopped.',
      'asr.protocol': 'The speech worker returned invalid output.', 'asr.timeout': 'Local transcription timed out.',
      'diary.failed': 'The diary could not be written. Check the selected cloud model and privacy settings.', 'diary.schedulerFailed': 'The diary scheduler could not save its state.',
      'diary.noCloud': 'The diary needs an active cloud model service.',
      'diary.contextChanged': 'The conversation or character settings changed while the diary was being written.',
      'diary.interrupted': 'Diary writing was interrupted.', 'diary.disabled': 'The diary was turned off during writing.',
      'diary.invalid': 'The model returned an invalid diary format.', 'diary.tooLarge': 'The model’s diary output was too long.',
      'diary.incomplete': 'The model did not finish the diary.',
      'recent.failed': 'Recent conversations could not be summarized.', 'recent.incomplete': 'The model did not finish the recent summary.',
      'recent.invalidResult': 'The model’s recent summary could not be used.',
      'chat.contextStale': 'Conversation context changed during generation.',
      'diary.storage': 'The encrypted diary could not be read. It has not been overwritten; check storage and the local vault.',
      'proactive.screenUnknown': 'Fullscreen status is unknown; desktop check-ins are withheld.', 'proactive.schedulerFailed': 'The check-in scheduler failed.',
      'proactive.pausedByError': 'Check-ins are paused after repeated failures.', 'proactive.wechatUnbound': 'Bind an owner WeChat private chat first.',
      'proactive.deliveryFailed': 'The check-in was not confirmed as delivered.', 'proactive.deliveryUncertain': 'It may have been sent. Check WeChat; it will not be repeated.',
      'proactive.speechBusy': 'Speech input is active; this voice check-in was withheld.', 'proactive.privateResult': 'Local-only check-in text cannot be sent to WeChat.',
      'proactive.contextStale': 'The authorized check-in context changed during generation.',
      'proactive.eventConflict': 'Two records for the same check-in event disagreed.', 'proactive.eventCapacity': 'The check-in event log is full.',
      'proactive.triggerCapacity': 'The check-in run log is full.', 'repository.commitUncertain': 'Saving could not be confirmed. Refresh to check the stored state.',
      'automation.permissionRequired': 'Automatic execution permission is missing.', 'automation.unavailable': 'Automatic execution is temporarily unavailable.',
      'automation.cancelled': 'Automatic execution was cancelled.', 'job.privacyBlocked': 'Privacy settings prevent sending this material to the selected service.',
      'automation.publicationBlocked': 'The context or delivery permission changed before publication.', 'proactive.submitUnconfirmed': 'The model request outcome is unknown; it will not be retried.',
      'wechat.cronDeliveryFailed': 'The scheduled reply could not be delivered.', 'wechat.cronDeliveryUncertain': 'The scheduled reply may have been sent; check WeChat before retrying.',
      'wechat.momentFailed': 'The Moments request failed.',
      'wechat.momentWindowBusy': 'Another operation held the WeChat window, so the Moments operation could not finish.',
      'wechat.momentListenerPaused': 'The WeChat listener was paused, so the Moments operation could not finish.',
      'wechat.momentWindowError': 'A Moments publishing step failed.',
      'wechat.momentRestricted': 'WeChat reported a restriction on posting Moments. The draft was kept.',
      'wechat.momentUncertain': 'The Moment may already be published. Check on your phone; do not publish it again.',
      'wechat.momentPreviewFallback': 'The model preview failed; a local fallback was used.', 'wechat.momentRewriteFailed': 'The rewrite failed; the old draft was kept and not published.',
      'wechat.momentPublishUnconfirmed': 'Publishing could not be confirmed. Check on your phone; do not publish it again.',
      'provider.unsupportedParameter': 'The model rejected a request setting.',
      'provider.authentication': 'The API key was rejected.',
      'provider.quota': 'The provider account is out of credit.',
      'provider.rateLimit': 'Too many requests; the provider asked to slow down.',
      'provider.timeout': 'The model took too long to answer.',
      'provider.unavailable': 'The model service is down.',
      'provider.network': 'The model service could not be reached.',
      'provider.modelUnavailable': 'This model is not available to the account.',
      'provider.request': 'The model service refused the request.',
      'sleep.noProvider': 'No model is selected.',
      'sleep.incomplete': 'The model stopped before finishing.', 'autoMemory.incomplete': 'The model stopped before finishing.',
      'sleep.invalidResult': 'The model did not return a usable plan.', 'autoMemory.invalidResult': 'The model did not return a usable answer.',
      'wechat.digest_read': 'Could not read the authorized WeChat source.',
      'wechat.digest_model': 'The selected summary model was unavailable or returned no usable result.',
      'wechat.digest_delivery_failed': 'The summary could not be sent to the owner’s private chat.',
      'wechat.digest_delivery_uncertain': 'The summary may have been sent and will not be repeated.',
      'wechat.digest_interrupted': 'The last WeChat digest run was interrupted.',
      'wechat.digest_storage': 'Could not read or save the encrypted digest state.',
      'wechat.digest_configuration': 'Could not verify the digest settings or authorization.',
      'wechat.friend_rate_limited': 'The friend reply limit was reached and excess messages were skipped.',
      'wechat.friend_send_uncertain': 'Delivery of the friend reply is unconfirmed. It will not be sent again.',
      'wechat.friend_binding_invalid': 'Could not verify the bound friend chat.',
      'wechat.friend_database_unavailable': 'Could not read the bound friend chat.',
      'wechat.friend_reply_unavailable': 'Could not prepare or deliver the friend reply.',
      'wechat.rich_reply_unavailable': 'WeChat could not process the rich message.',
      'wechat.followup_read': 'Could not read enough recent messages to verify the selected group follow-ups.',
      'wechat.uncertain': 'Some replies may or may not have been sent; check them on the WeChat page.',
      'wechat.dropped': 'Some WeChat messages in the last day got no reply: they kept failing or waited too long, so she moved on to the next.',
      'wechat.unreadable': 'The WeChat listener status could not be read.',
      'wechat.stale': 'The WeChat listener stopped reporting.', 'wechat.degraded': 'The WeChat listener is stuck.', 'wechat.stopped': 'The WeChat listener is not running.',
      'qq.offline': 'QQ is disconnected.', 'qq.deliveryFailed': 'Some QQ messages failed to send.', 'qq.uncertain': 'Some QQ messages may not have been delivered.',
      'telegram.offline': 'Telegram is disconnected.', 'telegram.uncertain': 'Some Telegram messages may not have been delivered.',
      'cron.failed': 'The last run failed.', 'cron.interrupted': 'The last run was interrupted.',
    } as Record<string, string>,
  },
  'zh-CN': {
    title: '运行状态', intro: '这些功能在你不看的时候自己运行。出了问题，平时很难察觉，这里会写明。',
    refresh: '刷新', loading: '正在检查…', readFailed: '读取状态失败，请刷新重试。',
    allGood: '已开启的功能都在正常工作。', issues: (n: number) => `${n} 项没有正常工作`,
    onlyAcknowledged: (n: number) => `没有新问题。有 ${n} 项你已经知道了。`,
    vaultDetached: '未关联', open: '去设置', lastSuccess: '上次成功：', lastFailure: '上次失败：', reason: '原因：', never: '还没有',
    fixLabel: '怎么处理：', acknowledge: '知道了', acknowledged: '已知道',
    acknowledgedNote: '你已经标记为知道了。情况变严重或出现新问题时会重新提醒。',
    acknowledgeFailed: '状态刚刚变了，没能标记。请看一下新的状态再点。',
    failures: (feature: HealthFeature, n: number, code: string | null) => feature === 'schedules' ? `近 7 天失败 ${n} 次`
      : code === 'wechat.dropped' ? `${n} 条消息没回`
      : feature === 'wechat' || feature === 'qq' || feature === 'telegram' || feature === 'wechat-friend-reply' ? `${n} 条消息未确认送达` : `连续失败 ${n} 次`,
    sinceLaunch: '时间只统计本次启动以来。',
    remaining: '今日还可发：',
    state: { ok: '正常', failing: '异常', waiting: '尚未运行', off: '未开启' } satisfies Record<HealthState, string>,
    feature: { asr: '本地语音识别', diary: '日记', knowledge: '知识库', proactive: '主动消息', 'wechat-moments': '朋友圈', 'wechat-cron': '微信定时投递', 'wechat-group-digest': '群聊每日精华', 'wechat-followup': '等你处理', 'wechat-official-brief': '公众号简报', 'wechat-friends-moments': '好友朋友圈摘要', 'wechat-friend-reply': '好友回复', 'auto-memory': '自动记忆', 'companion-recent': '最近对话摘要', 'memory-sleep': '夜间记忆整理', schedules: '定时任务', wechat: '微信', qq: 'QQ', telegram: 'Telegram' } satisfies Record<HealthFeature, string>,
    about: {
      asr: '麦克风录音只在本机识别，不上传。', diary: '夜间整理后写一篇加密日记，只用允许云端处理的主人私聊。', proactive: '沿用事件策略、安静时段和持久化的每日限额。',
      'wechat-moments': '草稿预览和确认后的发布，失败或不确定时会写在这里。',
      'wechat-cron': '只把定时任务的结果投递到已绑定主人的私聊。',
      'wechat-group-digest': '整理选中的群，精华只发给已绑定的主人私聊。',
      'wechat-followup': '从选中的群找出还没看到主人回应的 @，汇报给主人私聊。',
      'wechat-official-brief': '整理本地已同步的公众号文章，只发给主人私聊。',
      'wechat-friends-moments': '整理此号好友已同步的朋友圈，只发给主人私聊。',
      'wechat-friend-reply': '回复这个已绑定好友发来的私聊消息。',
      'auto-memory': '聊天停下几分钟后，自动记下值得长期记住的事。',
      'companion-recent': '整理最近的对话，帮助她接续话题。',
      'memory-sleep': '每晚把白天记下的内容合并、整理一次。',
      schedules: '你在聊天里设置的定时任务。',
      knowledge: '已关联 Markdown 笔记库的本机索引。',
      wechat: '在微信私聊和绑定的群里回复。',
      qq: '通过 QQ 回复和提醒。',
      telegram: '通过 Telegram 远程聊天。',
    } satisfies Record<HealthFeature, string>,
    code: {
      ...sendDiagnostics['zh-CN'],
      'knowledge.indexStale': '索引超过 24 小时未更新。',
      'knowledge.embeddingModelMissing': '本机 Ollama 缺少选用的嵌入模型。',
      'asr.settings': '语音输入设置读取失败。', 'asr.permission': '麦克风权限被拒绝，请在系统隐私与安全性中允许。',
      'asr.runtime': '离线语音文件夹缺失或不完整。', 'asr.worker': '本地语音识别进程停止了。',
      'asr.protocol': '语音识别进程返回了无效结果。', 'asr.timeout': '本地识别超时。',
      'diary.failed': '日记写入失败，请检查当前云端模型和隐私设置。', 'diary.schedulerFailed': '日记调度状态保存失败。',
      'diary.noCloud': '日记需要当前选中的云端模型服务。',
      'diary.contextChanged': '对话或角色设置已变更，日记停止写入。',
      'diary.interrupted': '日记写入中断。', 'diary.disabled': '生成期间关闭了日记。',
      'diary.invalid': '模型返回的日记格式无效。', 'diary.tooLarge': '模型返回的日记太长。',
      'diary.incomplete': '模型未完整返回日记。',
      'recent.failed': '最近对话摘要生成失败。', 'recent.incomplete': '模型未完整返回最近对话摘要。',
      'recent.invalidResult': '模型返回的最近对话摘要无法使用。',
      'chat.contextStale': '生成期间对话资料已变更。',
      'diary.storage': '加密日记读取失败，原文件没有覆盖，请检查存储和本地密钥库。',
      'proactive.screenUnknown': '无法确认全屏状态，已暂缓桌面主动消息。', 'proactive.schedulerFailed': '主动消息调度失败。',
      'proactive.pausedByError': '主动消息多次失败，已暂停。', 'proactive.wechatUnbound': '请先绑定主人微信私聊。',
      'proactive.deliveryFailed': '主动消息未确认送达。', 'proactive.deliveryUncertain': '可能已经发了，请在微信核对，不会重复发送。',
      'proactive.speechBusy': '正在语音输入，已暂缓这条主动语音。', 'proactive.privateResult': '仅本地的主动消息不能发到微信。',
      'proactive.contextStale': '生成主动消息期间，授权资料已变更。',
      'proactive.eventConflict': '同一主动消息事件的记录不一致。', 'proactive.eventCapacity': '主动消息事件记录已满。',
      'proactive.triggerCapacity': '主动消息运行记录已满。', 'repository.commitUncertain': '尚不能确认资料是否保存，请刷新后核对。',
      'automation.permissionRequired': '自动执行权限未授予。', 'automation.unavailable': '自动执行暂不可用。',
      'automation.cancelled': '自动执行已取消。', 'job.privacyBlocked': '当前隐私设置禁止把资料发给所选模型服务。',
      'automation.publicationBlocked': '发布前上下文或投递权限已变化。', 'proactive.submitUnconfirmed': '模型请求结果不确定，不会自动重试。',
      'wechat.cronDeliveryFailed': '定时回复投递失败。', 'wechat.cronDeliveryUncertain': '定时回复可能已发送，请在微信确认后再考虑重试。',
      'wechat.momentWindowBusy': '微信窗口被其他操作占用，朋友圈操作未完成。',
      'wechat.momentListenerPaused': '微信监听已暂停，朋友圈操作未完成。',
      'wechat.momentWindowError': '朋友圈发布流程中的一个步骤未完成。',
      'wechat.momentRestricted': '微信提示账号有风险，暂时不能发朋友圈。草稿已保留。',
      'wechat.momentFailed': '朋友圈请求失败。', 'wechat.momentUncertain': '朋友圈可能已经发了，请在手机核对，不要重复发。',
      'wechat.momentPreviewFallback': '模型预览失败，已使用本地备用句。', 'wechat.momentRewriteFailed': '改写失败，保留旧草稿，没有发布。',
      'wechat.momentPublishUnconfirmed': '无法确认是否发布，请在手机核对，不要重复发。',
      'provider.unsupportedParameter': '模型不接受这次请求的参数设置。',
      'provider.authentication': 'API key 无效或已过期。',
      'provider.quota': '模型服务的额度用完了。',
      'provider.rateLimit': '请求太频繁，被模型服务限流了。',
      'provider.timeout': '模型回答超时。',
      'provider.unavailable': '模型服务暂时不可用。',
      'provider.network': '连不上模型服务。',
      'provider.modelUnavailable': '这个账号用不了这个模型。',
      'provider.request': '模型服务拒绝了请求。',
      'sleep.noProvider': '还没有选择模型。',
      'sleep.incomplete': '模型没有回答完。', 'autoMemory.incomplete': '模型没有回答完。',
      'sleep.invalidResult': '模型没有返回可用的整理方案。', 'autoMemory.invalidResult': '模型没有返回可用的结果。',
      'wechat.digest_read': '无法读取已授权的微信资料。',
      'wechat.digest_model': '摘要模型不可用或没有返回有效结果。',
      'wechat.digest_delivery_failed': '摘要未能发到主人私聊。',
      'wechat.digest_delivery_uncertain': '摘要可能已经发出，不会自动重发。',
      'wechat.digest_interrupted': '上次微信摘要运行中断。',
      'wechat.digest_storage': '无法读取或保存加密摘要状态。',
      'wechat.digest_configuration': '微信摘要设置或授权无法确认。',
      'wechat.friend_rate_limited': '已到好友回复频率上限，超出的消息已跳过。',
      'wechat.friend_send_uncertain': '好友回复目前未确认送达。不会重复发送。',
      'wechat.friend_binding_invalid': '无法确认好友会话绑定。',
      'wechat.friend_database_unavailable': '无法读取好友的已绑定会话。',
      'wechat.friend_reply_unavailable': '暂时无法生成或投递好友回复。',
      'wechat.rich_reply_unavailable': '微信暂时无法处理富消息。',
      'wechat.followup_read': '暂时读不到足够的群消息来核对待跟进事项。',
      'wechat.uncertain': '有回复不确定是否发出去了，请到微信页面核对。',
      'wechat.dropped': '最近一天有微信消息没回成：一直失败或等太久，她跳过了，先回后面的消息。',
      'wechat.unreadable': '读不到微信监听程序的状态。',
      'wechat.stale': '微信监听程序没有心跳了。', 'wechat.degraded': '微信监听程序卡住了。', 'wechat.stopped': '微信监听程序没有运行。',
      'qq.offline': 'QQ 连接断开了。', 'qq.deliveryFailed': '有 QQ 消息发送失败。', 'qq.uncertain': '有 QQ 消息不确定是否送达。',
      'telegram.offline': 'Telegram 连接断开了。', 'telegram.uncertain': '有 Telegram 消息不确定是否送达。',
      'cron.failed': '上次运行失败。', 'cron.interrupted': '上次运行被中断了。',
    } as Record<string, string>,
  },
};
const checkWeChat = { en: 'Check in WeChat on your phone whether it was really sent. If not, send it yourself; she will not send it again. Then press “Got it”.',
  'zh-CN': '去手机微信看一下有没有真的发出去。没发出去就自己补一句，她不会重发。核对完点「知道了」。' };
const transient = { en: 'This usually recovers by itself. If it keeps happening, check the network or choose another model in settings.',
  'zh-CN': '通常会自己恢复。一直出现的话，检查网络，或在设置里换一个模型。' };
const wechatWindow = { en: 'Press “Open settings”, then “Restore WeChat window”. If that does not help, open the virtual machine and check that WeChat is logged in and no dialog covers it.',
  'zh-CN': '点「去设置」，再点「恢复微信窗口」。还不行就打开虚拟机，看看微信是否还登录着、有没有弹窗挡住。' };
const wechatDrawer = { en: 'In WeChat settings, select “Restore WeChat window”. Open the virtual machine and check the chat details panel in the bound owner chat if the error returns.',
  'zh-CN': '在微信通道设置里点「恢复微信窗口」。如果再次报错，打开虚拟机，检查已绑定主人私聊的聊天详情面板。' };
/** What the owner can do about each problem, beside why it happened. */
const fixes: Record<Locale, { code: Record<string, string>; feature: Partial<Record<HealthFeature, string>>; other: string }> = {
  en: {
    code: {
      'wechat.dropped': 'Nothing to fix. This is a record from the last 24 hours: she skipped a message she could not answer. If you want, check WeChat on your phone for a message that got no reply and answer it yourself. Press “Got it” to clear this; a new skipped message brings it back.',
      'wechat.uncertain': checkWeChat.en, 'wechat.friend_send_uncertain': checkWeChat.en, 'wechat.digest_delivery_uncertain': checkWeChat.en,
      'wechat.cronDeliveryUncertain': checkWeChat.en, 'proactive.deliveryUncertain': checkWeChat.en,
      'wechat.drawer_state_unknown': wechatDrawer.en, 'wechat.drawer_not_open': wechatDrawer.en, 'wechat.drawer_not_closed': wechatDrawer.en,
      'wechat.momentUncertain': 'Check Moments on your phone. Do not post it again if it is already there. Then press “Got it”.',
      'wechat.momentRestricted': 'Handle the notice in WeChat on your phone, then say 「再发一次」 in the owner chat.',
      'wechat.momentPublishUnconfirmed': 'Check Moments on your phone. Do not post it again if it is already there. Then press “Got it”.',
      'wechat.momentPreviewFallback': 'Nothing to fix; a built-in sentence was used instead.',
      'wechat.stopped': 'Press “Open settings”. If replies are paused, press “Resume automatic replies”. If it still does not run, restart DeskPet.',
      'wechat.stale': 'Press “Open settings”. If replies are paused, press “Resume automatic replies”. If it still does not run, restart DeskPet.',
      'wechat.degraded': wechatWindow.en, 'wechat.unreadable': wechatWindow.en,
      'wechat.friend_rate_limited': 'Nothing to fix. This friend sent more than the limit, so the extra messages got no reply. It recovers on its own.',
      'wechat.friend_binding_invalid': 'Open settings → WeChat → Reply, remove this friend and add them again.',
      'wechat.friend_database_unavailable': wechatWindow.en,
      'provider.authentication': 'Open the model settings and enter a valid API key.',
      'provider.quota': 'Top up the model service, or choose another model in settings.',
      'provider.modelUnavailable': 'Choose a model this account can use in settings.',
      'provider.rateLimit': transient.en, 'provider.timeout': transient.en, 'provider.unavailable': transient.en, 'provider.network': transient.en,
      'sleep.noProvider': 'Choose a model in settings.',
      'asr.permission': 'Open System Settings → Privacy & Security → Microphone and allow DeskPet.',
      'qq.offline': 'Press “Open settings” and reconnect QQ.', 'telegram.offline': 'Press “Open settings” and check the Telegram connection.',
      'cron.failed': 'Press “Open settings” to see which schedule failed. You can run it again by hand.',
      'cron.interrupted': 'Press “Open settings” to see which schedule was interrupted. You can run it again by hand.',
    },
    feature: {
      wechat: wechatWindow.en,
      'wechat-friend-reply': 'This usually recovers by itself. If it keeps happening, open the virtual machine and check WeChat, or check that the local model is running.',
    },
    other: 'Press “Open settings” to check this feature. If it was a one-off, press “Got it”; a new problem brings it back.',
  },
  'zh-CN': {
    code: {
      'wechat.dropped': '不用修。这是最近 24 小时的记录：有条消息她没回成，跳过了。想知道是哪条，可以去手机微信看看谁的消息没人回，需要的话自己回一句。点「知道了」就能消掉提醒，之后再有漏回会重新提醒。',
      'wechat.uncertain': checkWeChat['zh-CN'], 'wechat.friend_send_uncertain': checkWeChat['zh-CN'], 'wechat.digest_delivery_uncertain': checkWeChat['zh-CN'],
      'wechat.cronDeliveryUncertain': checkWeChat['zh-CN'], 'proactive.deliveryUncertain': checkWeChat['zh-CN'],
      'wechat.drawer_state_unknown': wechatDrawer['zh-CN'], 'wechat.drawer_not_open': wechatDrawer['zh-CN'], 'wechat.drawer_not_closed': wechatDrawer['zh-CN'],
      'wechat.momentUncertain': '去手机上看一下朋友圈，已经发了就不要再发。看完点「知道了」。',
      'wechat.momentRestricted': '在手机微信里处理提示，然后在主人私聊回复「再发一次」。',
      'wechat.momentPublishUnconfirmed': '去手机上看一下朋友圈，已经发了就不要再发。看完点「知道了」。',
      'wechat.momentPreviewFallback': '不用处理，已经用备用句代替了。',
      'wechat.stopped': '点「去设置」。如果是暂停了，点「恢复自动回复」；还是不运行就重启桌宠。',
      'wechat.stale': '点「去设置」。如果是暂停了，点「恢复自动回复」；还是不运行就重启桌宠。',
      'wechat.degraded': wechatWindow['zh-CN'], 'wechat.unreadable': wechatWindow['zh-CN'],
      'wechat.friend_rate_limited': '不用处理。这位好友发得太多，超出上限的消息没有回，过一会儿会自己恢复。',
      'wechat.friend_binding_invalid': '去「设置 → 微信通道 → 回复」，把这位好友移除后重新添加。',
      'wechat.friend_database_unavailable': wechatWindow['zh-CN'],
      'provider.authentication': '去模型设置里填一个有效的 API key。',
      'provider.quota': '去模型服务商那里充值，或在设置里换一个模型。',
      'provider.modelUnavailable': '在设置里换一个这个账号能用的模型。',
      'provider.rateLimit': transient['zh-CN'], 'provider.timeout': transient['zh-CN'], 'provider.unavailable': transient['zh-CN'], 'provider.network': transient['zh-CN'],
      'sleep.noProvider': '在设置里选一个模型。',
      'asr.permission': '打开「系统设置 → 隐私与安全性 → 麦克风」，允许 DeskPet。',
      'qq.offline': '点「去设置」重新连接 QQ。', 'telegram.offline': '点「去设置」检查 Telegram 连接。',
      'cron.failed': '点「去设置」看是哪个定时任务失败了，可以手动再运行一次。',
      'cron.interrupted': '点「去设置」看是哪个定时任务被中断了，可以手动再运行一次。',
    },
    feature: {
      wechat: wechatWindow['zh-CN'],
      'wechat-friend-reply': '通常会自己恢复。一直出现的话，打开虚拟机看看微信，或检查本机模型是否在运行。',
    },
    other: '点「去设置」看看这个功能的设置。如果只是偶尔一次，点「知道了」就行，有新问题会再提醒。',
  },
};
const fixFor = (lang: Locale, item: HealthItem): string => {
  const table = fixes[lang];
  return (item.errorCode && table.code[item.errorCode]) || table.feature[item.feature] || table.other;
};
const pill: Record<HealthState, string> = { ok: 'succeeded', failing: 'failed', waiting: '', off: '' };
// Problems first; switched-off features last.
const order: Record<HealthState, number> = { failing: 0, waiting: 1, ok: 2, off: 3 };
const rank = (item: HealthItem): number => order[item.state] + (item.acknowledged ? 0.5 : 0);
const REFRESH_MS = 60_000;
const successTracked = new Set<HealthFeature>(['auto-memory', 'memory-sleep', 'schedules', 'knowledge']);

/** Polls the host's background health for a count badge, without blocking the console. */
export const useHealthIssues = (api: AttentionAPI): [number, (issues: number) => void] => {
  const [issues, setIssues] = useState(0);
  useEffect(() => {
    let live = true;
    const read = (): void => { void api.health?.().then(value => { if (live) setIssues(value.issues); }).catch(() => undefined); };
    read();
    const interval = window.setInterval(read, REFRESH_MS);
    const stop = api.onChanged?.(read);
    return () => { live = false; window.clearInterval(interval); stop?.(); };
  }, [api]);
  return [issues, setIssues];
};

export const HealthPanel = ({ api, locale, onOpen, onIssues, children }: {
  api: AttentionAPI; locale: string; onOpen(feature: HealthFeature): void; onIssues?(issues: number): void; children?: ReactNode;
}): JSX.Element => {
  const lang: Locale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const text = copy[lang];
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null), [readFailed, setReadFailed] = useState(false), [busy, setBusy] = useState(false);
  const [ackFailed, setAckFailed] = useState(false);
  const shown = useRef(onIssues);
  shown.current = onIssues;
  const show = useCallback((next: HealthSnapshot): void => { setSnapshot(next); shown.current?.(next.issues); }, []);
  const sequence = useRef({ value: 0 });
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++sequence.current.value;
    setBusy(true);
    try { const next = await api.health!(); if (sequence.current.value === current) { show(next); setReadFailed(false); } }
    catch { if (sequence.current.value === current) setReadFailed(true); }
    finally { if (sequence.current.value === current) setBusy(false); }
  }, [api, show]);
  const acknowledge = async (item: HealthItem): Promise<void> => {
    if (!api.acknowledgeHealth || !item.fingerprint) return;
    const current = ++sequence.current.value;
    setBusy(true);
    setAckFailed(false);
    try {
      const next = await api.acknowledgeHealth({ key: `${item.feature}:${item.ordinal ?? 0}`, fingerprint: item.fingerprint });
      if (sequence.current.value === current) show(next);
    } catch {
      if (sequence.current.value === current) setAckFailed(true);
      void refresh();
    } finally { if (sequence.current.value === current) setBusy(false); }
  };
  useEffect(() => {
    const current = sequence.current;
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    const stop = api.onChanged?.(() => void refresh());
    return () => { current.value++; window.clearInterval(interval); stop?.(); };
  }, [api, refresh]);
  const time = (value: string | null): string => value ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : text.never;
  const card = (item: HealthItem): JSX.Element => <article key={`${item.feature}:${item.ordinal ?? 0}`} className="attention-card" data-state={item.state}>
    <div className="attention-card-heading"><span className={`status-pill ${item.acknowledged ? '' : pill[item.state]}`}>{item.acknowledged ? text.acknowledged : item.feature === 'knowledge' && item.state === 'off' ? text.vaultDetached : text.state[item.state]}</span></div>
    <h2>{item.ordinal === undefined ? text.feature[item.feature] : `${lang === 'zh-CN' ? '好友' : 'Friend'} ${item.ordinal}`}</h2>
    <p className="attention-note">{text.about[item.feature]}</p>
    {item.remainingToday !== undefined && <p>{text.remaining}{item.remainingToday}</p>}
    {item.feature === 'knowledge' && item.retainedInvalidDiaries !== undefined && item.retainedInvalidDiaries > 0 && <p className="attention-note">
      {lang === 'zh-CN'
        ? `有 ${item.retainedInvalidDiaries} 篇已失效但被你改过的日记副本。`
        : item.retainedInvalidDiaries === 1
          ? '1 invalidated diary copy was kept because you edited it.'
          : `${item.retainedInvalidDiaries} invalidated diary copies were kept because you edited them.`}
    </p>}
    {item.state === 'failing' && item.errorCode && <p role="status"><strong>{text.reason}</strong>{text.code[item.errorCode] ?? (item.feature === 'knowledge' ? '' : item.errorCode)} <code>{item.errorCode}</code></p>}
    {item.state === 'failing' && item.momentStage && <p className="attention-note">
      {lang === 'zh-CN' ? `失败步骤：${WECHAT_MOMENT_STAGE_LABELS[item.momentStage]} ` : 'Failed step: '}<code>{item.momentStage}</code></p>}
    {item.state === 'failing' && item.failures > 0 && <p>{text.failures(item.feature, item.failures, item.errorCode)}</p>}
    {item.deliveryProgress && <p>{lang === 'zh-CN'
      ? `已发 ${item.deliveryProgress.sent}/${item.deliveryProgress.total} 条`
      : `Sent ${item.deliveryProgress.sent}/${item.deliveryProgress.total} messages`}</p>}
    {item.state === 'failing' && !item.acknowledged && <p><strong>{text.fixLabel}</strong>{fixFor(lang, item)}</p>}
    {item.acknowledged && <p className="attention-note">{text.acknowledgedNote}</p>}
    {item.state !== 'off' && (item.lastSuccessAt || item.lastFailureAt || successTracked.has(item.feature)) && <p className="attention-note">
      {/* Features that never record a success show only when they failed, not a misleading “not yet”. */}
      {(item.lastSuccessAt || successTracked.has(item.feature)) && <>{text.lastSuccess}{time(item.lastSuccessAt)}</>}
      {item.lastFailureAt && <>{(item.lastSuccessAt || successTracked.has(item.feature)) && ' · '}{text.lastFailure}{time(item.lastFailureAt)}</>}
      {item.sinceLaunch && <><br />{text.sinceLaunch}</>}
    </p>}
    {item.state !== 'ok' && <div className="attention-actions">
      <button type="button" onClick={() => onOpen(item.feature === 'proactive' && isWeChatSendDiagnostic(item.errorCode) ? 'wechat' : item.feature)}>{text.open}</button>
      {item.state === 'failing' && !item.acknowledged && item.fingerprint && api.acknowledgeHealth
        && <button type="button" className="secondary" disabled={busy} onClick={() => void acknowledge(item)}>{text.acknowledge}</button>}
    </div>}
  </article>;
  const items = snapshot ? [...snapshot.items].sort((a, b) => rank(a) - rank(b)) : [];
  const seen = items.filter(item => item.acknowledged).length;
  return <section className="attention-center health-panel">
    <header className="page-header"><div><h1>{text.title}</h1><p>{text.intro}</p></div><button type="button" disabled={busy} onClick={() => void refresh()}>{text.refresh}</button></header>
    {readFailed && <p role="alert">{text.readFailed}</p>}
    {ackFailed && <p role="alert">{text.acknowledgeFailed}</p>}
    {children}
    {snapshot === null ? <p>{text.loading}</p> : <>
      <div className="attention-overview"><strong>{snapshot.issues || '✓'}</strong><span>{snapshot.issues ? text.issues(snapshot.issues) : seen ? text.onlyAcknowledged(seen) : text.allGood}</span></div>
      <ModelBindingIssues issues={snapshot.modelIssues ?? []} api={api} locale={lang} refresh={refresh} />
      <div className="attention-list">{items.map(card)}</div>
    </>}
  </section>;
};
