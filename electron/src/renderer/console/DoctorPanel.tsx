import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AttentionAPI } from '../../shared/attention';
import { DOCTOR_REPAIR_ACTIONS, DOCTOR_SELF_TEST_STAGES, DOCTOR_SELF_TEST_STAGE_LABELS, describeDoctorCase, type DoctorCase, type DoctorStatus } from '../../shared/doctor';
import './attention-center.css';
import { ModelBindingIssues } from './ModelBindingIssues';

type Locale = 'en' | 'zh-CN';
const copy = {
  en: {
    title: 'Doctor', intro: 'The doctor checks her background services and reports problems on QQ or through a desktop notification. Send 「体检」 in your QQ or WeChat private chat for a checkup.',
    repair: 'Automatic repairs', repairHint: 'Restart stalled services, reconnect channels and reindex the knowledge vault.',
    repairHistory: 'Recent repairs', noRepairs: 'No repairs recorded yet.',
    results: { running: 'Checking recovery', recovered: 'Recovered', failed: 'Still failing' },
    pausedUntil: (until: string) => `Needs your attention. Paused until ${until}.`,
    enabled: 'Doctor on', check: 'Check now', loading: 'Loading…', readFailed: 'Could not read the doctor. Try again.',
    lastCheck: 'Last check: ', never: 'not yet', open: (n: number) => n ? `${n} open` : 'Nothing open', alerts: (n: number, limit: number) => `QQ reports today: ${n}/${limit}`,
    empty: 'No problems recorded yet.', openState: 'Open', resolved: 'Recovered', since: 'Noticed ', until: ' · recovered ',
    acknowledged: 'Acknowledged', acknowledgedAt: ' · acknowledged ',
    reported: { qq: 'Told you on QQ', desktop: 'Desktop notification', held: 'Held for the morning', failed: 'Could not tell you' } satisfies Record<NonNullable<DoctorCase['reported']>, string>,
    waiting: 'Waiting for the next check before reporting',
  },
  'zh-CN': {
    title: '医生', intro: '医生会检查后台服务，通过 QQ 或桌面通知报告异常。在 QQ 或微信主人私聊发送「体检」可查看当前状态。',
    repair: '自动修复', repairHint: '重启停住的服务、重连渠道、重新索引知识库。',
    repairHistory: '最近的修复记录', noRepairs: '还没有修复记录。',
    results: { running: '正在验证', recovered: '已恢复', failed: '尚未恢复' },
    pausedUntil: (until: string) => `修不好，需要你看看。暂停至 ${until}。`,
    enabled: '医生开启', check: '立即检查', loading: '正在读取…', readFailed: '读取医生状态失败，请重试。',
    lastCheck: '上次检查：', never: '还没有', open: (n: number) => n ? `${n} 个问题未恢复` : '没有未恢复的问题', alerts: (n: number, limit: number) => `今天 QQ 已报告 ${n}/${limit} 次`,
    empty: '还没有记录到问题。', openState: '未恢复', resolved: '已恢复', since: '发现于 ', until: ' · 恢复于 ',
    acknowledged: '已知道', acknowledgedAt: ' · 确认于 ',
    reported: { qq: '已在 QQ 告诉你', desktop: '已发桌面通知', held: '深夜记录，早上汇总', failed: '没能通知到你' } satisfies Record<NonNullable<DoctorCase['reported']>, string>,
    waiting: '等下一次检查确认后再报告',
  },
};

export const DoctorPanel = ({ api, locale }: { api: AttentionAPI; locale: string }): JSX.Element => {
  const lang: Locale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const text = copy[lang];
  const [status, setStatus] = useState<DoctorStatus | null>(null), [readFailed, setReadFailed] = useState(false), [busy, setBusy] = useState(false);
  const sequence = useRef({ value: 0 });
  const run = useCallback(async (read: () => Promise<DoctorStatus>): Promise<void> => {
    const current = ++sequence.current.value;
    setBusy(true);
    try { const next = await read(); if (sequence.current.value === current) { setStatus(next); setReadFailed(false); } }
    catch { if (sequence.current.value === current) setReadFailed(true); }
    finally { if (sequence.current.value === current) setBusy(false); }
  }, []);
  useEffect(() => {
    const current = sequence.current;
    void run(() => api.doctor!());
    const stop = api.onChanged?.(() => void run(() => api.doctor!()));
    return () => { current.value++; stop?.(); };
  }, [api, run]);
  const time = (value: string | null): string => value ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : text.never;
  const latest = status?.selfTests.at(-1), providerTest = status?.providerTests.at(-1);
  const outage = status?.appOutage;
  const epoch = (at: number) => time(new Date(at * 1000).toISOString());
  const card = (entry: DoctorCase): JSX.Element => <article key={`${entry.key}@${entry.openedAt}`} className="attention-card" data-state={entry.resolvedAt ? 'ok' : 'failing'}>
    <div className="attention-card-heading"><span className={`status-pill ${entry.acknowledged ? '' : entry.resolvedAt ? 'succeeded' : 'failed'}`}>{entry.acknowledged ? text.acknowledged : entry.resolvedAt ? text.resolved : text.openState}</span></div>
    <p>{describeDoctorCase(entry)}</p>
    {status?.runbooks[entry.code] && <details><summary>{lang === 'zh-CN' ? '常见原因与建议' : 'Possible causes and next steps'}</summary>
      <ul>{status.runbooks[entry.code]!.causes.map(cause => <li key={cause}>{cause}</li>)}</ul>
      <ul>{status.runbooks[entry.code]!.actions.map(action => <li key={action}>{action}</li>)}</ul>
    </details>}
    <p className="attention-note">{text.since}{time(entry.openedAt)}{entry.resolvedAt && <>{entry.acknowledged ? text.acknowledgedAt : text.until}{time(entry.resolvedAt)}</>}
      {!entry.acknowledged && <> · {entry.reported ? text.reported[entry.reported] : text.waiting}</>} · <code>{entry.code}</code></p>
    {entry.detail && (DOCTOR_SELF_TEST_STAGES as readonly string[]).includes(entry.detail) && <p className="attention-note">
      {lang === 'zh-CN' ? '阶段：' : 'Stage: '}{lang === 'zh-CN' ? DOCTOR_SELF_TEST_STAGE_LABELS[entry.detail as typeof DOCTOR_SELF_TEST_STAGES[number]] : entry.detail}</p>}
  </article>;
  return <section className="attention-center health-panel doctor-panel">
    <header className="page-header"><div><h1>{text.title}</h1><p>{text.intro}</p></div>
      <button type="button" disabled={busy || !status?.enabled} onClick={() => void run(() => api.checkDoctor!())}>{text.check}</button></header>
    {readFailed && <p role="alert">{text.readFailed}</p>}
    {status === null ? <p>{text.loading}</p> : <>
      {status.diagnosis && <article className="attention-card"><h2>{lang === 'zh-CN' ? '医生的看法' : 'Doctor’s view'}</h2>
        <p>{status.diagnosis.text}</p><p className="attention-note">{time(status.diagnosis.at)} · {status.diagnosis.source === 'local' ? (lang === 'zh-CN' ? '本机' : 'Local') : (lang === 'zh-CN' ? '云端' : 'Cloud')}</p></article>}
      <div className="setting-row"><div className="setting-label"><label htmlFor="doctor-enabled">{text.enabled}</label>
        <p className="muted">{text.lastCheck}{time(status.lastCheckAt)} · {text.alerts(status.alertsToday, status.dailyLimit)}</p></div>
        <span className="switch-row"><input id="doctor-enabled" type="checkbox" checked={status.enabled} disabled={busy}
          onChange={event => { const enabled = event.currentTarget.checked; setStatus({ ...status, enabled }); void run(() => api.setDoctor!(enabled)); }} /></span></div>
      <div className="setting-row"><div className="setting-label"><label htmlFor="doctor-auto-repair">{text.repair}</label>
        <p className="muted">{text.repairHint}</p></div>
        <span className="switch-row"><input id="doctor-auto-repair" type="checkbox" checked={status.autoRepair}
          disabled={busy || !api.setDoctorAutoRepair}
          onChange={event => { const enabled = event.currentTarget.checked; void run(() => api.setDoctorAutoRepair!(enabled)); }} /></span></div>
      <article className="attention-card">
        <h2>{text.repairHistory}</h2>
        {status.repairs.length ? <ul>{status.repairs.slice(0, 12).map(repair =>
          <li key={`${repair.id}@${repair.at}`}>{time(repair.at)} · {DOCTOR_REPAIR_ACTIONS[repair.id][lang]} · {text.results[repair.result]}
            {repair.circuitUntil && <> · {text.pausedUntil(time(repair.circuitUntil))}</>}
          </li>)}</ul> : <p>{text.noRepairs}</p>}
      </article>
      <div className="attention-overview"><strong>{status.open || '✓'}</strong><span>{text.open(status.open)}</span></div>
      <ModelBindingIssues issues={status.modelIssues ?? []} api={api} locale={lang} refresh={() => run(() => api.doctor!())} />
      {outage && <article className="attention-card">
        <h2>{lang === 'zh-CN' ? '最近一次桌宠无响应' : 'Latest DeskPet outage'}</h2>
        <p>{lang === 'zh-CN' ? '最后心跳：' : 'Last heartbeat: '}{epoch(outage.startedAt)}</p>
        {outage.notifiedAt !== null && <p>{lang === 'zh-CN' ? '微信提醒尝试：' : 'WeChat alert attempted: '}{epoch(outage.notifiedAt)}</p>}
        {outage.recoveredAt !== null && <p>{lang === 'zh-CN' ? '心跳已恢复：' : 'Heartbeat recovered: '}{epoch(outage.recoveredAt)}</p>}
      </article>}
      <article className="attention-card">
        <h2>{lang === 'zh-CN' ? '微信发送自检' : 'WeChat send self-test'}</h2>
        <button type="button" disabled={busy || !status.enabled || status.manualSelfTestsToday >= 5 || !api.testDoctorWeChat}
          onClick={() => void run(() => api.testDoctorWeChat!())}>{lang === 'zh-CN' ? '现在测一次微信发送' : 'Test WeChat sending now'}</button>
        <p>{lang === 'zh-CN' ? '14 天通过率：' : '14-day pass rate: '}{status.selfTestPassRate === null ? '—' : `${Math.round(status.selfTestPassRate * 100)}%`}</p>
        <p className="attention-note">{lang === 'zh-CN' ? `按有结果的每日自动自检统计；今天手动 ${status.manualSelfTestsToday}/5 次。` : `Completed automatic test days; manual tests today ${status.manualSelfTestsToday}/5.`}</p>
        {latest && <><p>{time(latest.at)} · {latest.status} · <code>{latest.code}</code>{' · '}{latest.durationMs} ms</p>
          <ul>{DOCTOR_SELF_TEST_STAGES.map(stage => <li key={stage}>{lang === 'zh-CN' ? DOCTOR_SELF_TEST_STAGE_LABELS[stage] : stage}：{latest.stages[stage] ? '✓' : '—'}</li>)}</ul></>}
      </article>
      {status.vm.latest && <article className="attention-card"><h2>{lang === 'zh-CN' ? '微信虚拟机' : 'WeChat VM'}</h2>
        <p>{lang === 'zh-CN' ? '磁盘剩余 ' : 'Disk free '}{(status.vm.latest.freeBytes / 1024 ** 3).toFixed(1)} GB · {lang === 'zh-CN' ? '日志 ' : 'Logs '}{((status.vm.latest.authLogBytes + status.vm.latest.journalBytes) / 1024 ** 2).toFixed(0)} MB</p>
        <p className="attention-note">{time(status.vm.latest.at)} · {status.vm.failures ? (lang === 'zh-CN' ? '最近采样失败' : 'Latest sample failed') : '✓'}</p></article>}
      {providerTest && <article className="attention-card"><h2>{lang === 'zh-CN' ? '聊天模型自检' : 'Chat model self-test'}</h2>
        <p>{time(providerTest.at)} · {providerTest.status} · {providerTest.durationMs} ms · <code>{providerTest.code}</code></p></article>}
      {status.cases.length ? <div className="attention-list">{status.cases.slice(0, 50).map(card)}</div>
        : !status.modelIssues?.length && <p className="muted">{text.empty}</p>}
    </>}
  </section>;
};
