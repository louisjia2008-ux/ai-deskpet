import { useCallback, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { ChatSession } from '../../shared';
import type { ChatCronSchedule } from '../../shared/chat-cron';
import type { TelegramChannelAPI, TelegramChannelStatus } from '../../shared/telegram-channel';
import type { QqChannelAPI, QqChannelStatus } from '../../shared/qq-channel';
import type { ChatWorkPanelApi } from '../../shared/chat-work-api';

const copy = {
  en: {
    telegram: 'Send results to my paired Telegram account', pairFirst: 'Pair Telegram in Settings to receive results here.',
    qq: 'Send results to my QQ private chat', qqBindFirst: 'Bind QQ in Settings to receive results there.',
    title: 'Schedules', detail: 'Tasks that run on their own and report back in the conversation that made them. They run while DeskPet is open.',
    empty: 'No schedules yet. Just ask in chat, for example: "Every morning at 7, tell me the weather and what to wear."',
    active: 'Running', paused: 'Paused', next: 'Next run', none: 'None', from: 'Conversation', tools: 'Can use', noTools: 'Text only', open: 'Open conversation',
    pause: 'Pause', resume: 'Resume', cancel: 'Cancel schedule', confirm: 'Confirm cancellation', keep: 'Keep', instruction: 'Instruction', failed: 'That did not work. Refresh and try again.',
    text: 'Text-only schedules (advanced)', daily: (time: string) => `Every day at ${time}`, weekly: (day: string, time: string) => `Every ${day} at ${time}`, hourly: (minute: string) => `Every hour at :${minute}`,
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },
  'zh-CN': {
    telegram: '将结果发送到我配对的 Telegram 账号', pairFirst: '请先在设置中配对 Telegram 账号，再选择要推送的任务。',
    qq: '将结果发送到我的 QQ 私聊', qqBindFirst: '请先在设置中绑定 QQ，再选择要推送的任务。',
    title: '定时任务', detail: '到点自动执行，结果发回创建它的对话。DeskPet 打开时才会运行。',
    empty: '还没有定时任务。在聊天里说一句就行，比如：“每天早上 7 点告诉我天气和穿衣建议。”',
    active: '运行中', paused: '已暂停', next: '下次执行', none: '无', from: '所属对话', tools: '可用工具', noTools: '仅文字', open: '打开对话',
    pause: '暂停', resume: '恢复', cancel: '取消任务', confirm: '确认取消', keep: '保留', instruction: '指令', failed: '操作没有成功，请刷新后重试。',
    text: '纯文本定时任务（高级）', daily: (time: string) => `每天 ${time}`, weekly: (day: string, time: string) => `每${day} ${time}`, hourly: (minute: string) => `每小时第 ${minute} 分`,
    days: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  },
} as const;

/** Plain words for the common cron shapes; anything else stays as written. */
export const describeCron = (expression: string, locale: 'en' | 'zh-CN'): string => {
  const t = copy[locale], parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') return expression;
  const [minute, hour, , , weekday] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/u.test(minute)) return expression;
  const paddedMinute = minute.padStart(2, '0');
  if (hour === '*' && weekday === '*') return t.hourly(paddedMinute);
  if (!/^\d{1,2}$/u.test(hour)) return expression;
  const time = `${hour.padStart(2, '0')}:${paddedMinute}`;
  if (weekday === '*') return t.daily(time);
  return /^[0-6]$/u.test(weekday) ? t.weekly(t.days[Number(weekday)]!, time) : expression;
};

type Row = ChatCronSchedule & { sessionId: string; sessionTitle: string; desktopSession: boolean };

export const ScheduleOverview = ({ api, telegram, qq, sessions, locale, onOpenSession, timers, children }: {
  api: ChatWorkPanelApi; telegram?: Pick<TelegramChannelAPI, 'getState' | 'setCronDelivery'>; qq?: Pick<QqChannelAPI, 'getState' | 'setCronDelivery'>; sessions: readonly ChatSession[]; locale: 'en' | 'zh-CN'; onOpenSession(id: string): void; timers?: ReactNode; children: ReactNode;
}): JSX.Element => {
  const t = copy[locale];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [target, setTarget] = useState<TelegramChannelStatus | null>(null);
  const [qqTarget, setQqTarget] = useState<QqChannelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const forSession = async (session: ChatSession): Promise<Row[]> => {
      try {
        return (await api.listCron(session.id)).map(item => ({ ...item, sessionId: session.id, sessionTitle: session.title, desktopSession: !session.channelBindingId }));
      } catch { return []; }
    };
    const [current, qqCurrent, lists] = await Promise.all([
      telegram?.getState().catch(() => null),
      qq?.getState().catch(() => null),
      Promise.all(sessions.filter(session => !session.deletedAt).map(forSession)),
    ]);
    setTarget(current ?? null); setQqTarget(qqCurrent ?? null);
    setRows(lists.flat().filter((item) => !item.cancelledAt));
  }, [api, sessions, telegram, qq]);
  useEffect(() => { void load(); return api.onChanged(() => { void load(); }); }, [api, load]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setFailed(false);
    try { await operation(); await load(); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const qqReady = !!qqTarget?.enabled && !qqTarget.stopped && !!qqTarget.privateBindingId;
  const date = (value: string, timezone: string): string => {
    try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value)); }
    catch { return value; }
  };
  return <section className="schedule-overview">
    <header className="page-header"><h1>{t.title}</h1><p>{t.detail}</p></header>
    {failed && <p role="alert" className="error-banner">{t.failed}</p>}
    {rows !== null && rows.length === 0 && <div className="panel schedule-empty"><p>{t.empty}</p></div>}
    <div className="schedule-list">{rows?.map((item) => <article className="panel schedule-card" key={item.id} data-cron-id={item.id}>
      <div className="schedule-card-heading"><div><h2>{item.title}</h2><p title={item.expression}>{describeCron(item.expression, locale)} · {item.timezone}</p></div>
        <span className={`status-pill ${item.enabled ? 'succeeded' : ''}`}>{item.enabled ? t.active : t.paused}</span></div>
      <dl>
        <dt>{t.next}</dt><dd>{item.enabled && item.nextRunAt ? <time dateTime={item.nextRunAt}>{date(item.nextRunAt, item.timezone)}</time> : t.none}</dd>
        <dt>{t.from}</dt><dd>{item.sessionTitle}</dd>
        <dt>{t.tools}</dt><dd>{item.allowedCapabilities.length > 0 ? item.allowedCapabilities.join(', ') : t.noTools}</dd>
      </dl>
      <details className="settings-more"><summary>{t.instruction}</summary><p>{item.instruction}</p></details>
      {telegram && item.desktopSession && !item.channel && <div>
        <label className="check-row"><input type="checkbox" disabled={busy || !target?.enabled || !target.bindingId}
          checked={!!target?.enabled && !!target.bindingId && item.telegramDelivery?.bindingId === target.bindingId && item.telegramDelivery.revision === item.revision}
          onChange={event => {
            const enabled = event.target.checked;
            void perform(() => telegram.setCronDelivery({ scheduleId: item.id, expectedRevision: item.revision, expectedBindingId: target?.bindingId ?? null, enabled }));
          }} />{t.telegram}{target?.bindingDisplayName ? ` · ${target.bindingDisplayName}` : ''}</label>
        {(!target?.enabled || !target.bindingId) && <small>{t.pairFirst}</small>}
      </div>}
      {qq && item.desktopSession && !item.channel && <div>
        <label className="check-row"><input type="checkbox" disabled={busy || !qqReady}
          checked={qqReady && item.qqDelivery?.bindingId === qqTarget?.privateBindingId && item.qqDelivery?.revision === item.revision}
          onChange={event => {
            const enabled = event.target.checked;
            void perform(() => qq.setCronDelivery({ scheduleId: item.id, expectedRevision: item.revision, expectedBindingId: qqTarget?.privateBindingId ?? null, enabled }));
          }} />{t.qq}{qqTarget?.bindingDisplayName ? ` · ${qqTarget.bindingDisplayName}` : ''}</label>
        {!qqReady && <small>{t.qqBindFirst}</small>}
      </div>}
      <div className="button-row">
        <button type="button" className="secondary" disabled={busy} onClick={() => onOpenSession(item.sessionId)}>{t.open}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => item.enabled ? api.pauseCron({ sessionId: item.sessionId, id: item.id })
          : api.resumeCron({ sessionId: item.sessionId, id: item.id, expectedRevision: item.revision, allowedCapabilities: [...item.allowedCapabilities] }))}>{item.enabled ? t.pause : t.resume}</button>
        {cancelId === item.id
          ? <><button type="button" disabled={busy} onClick={() => void perform(async () => { await api.cancelCron({ sessionId: item.sessionId, id: item.id }); setCancelId(null); })}>{t.confirm}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setCancelId(null)}>{t.keep}</button></>
          : <button type="button" className="text-button" disabled={busy} onClick={() => setCancelId(item.id)}>{t.cancel}</button>}
      </div>
    </article>)}</div>
    {timers}
    <details className="settings-more schedule-text"><summary>{t.text}</summary>{children}</details>
  </section>;
};
