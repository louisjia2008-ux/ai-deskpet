import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { proactiveMode } from '../../shared/automation';
import type { AutomationAPI, ProactivePolicy } from '../../shared/automation';
import type { ProviderConfig } from '../../shared';
import './persona-settings.css';

const FREQUENCIES = { rare: { cooldownMinutes: 240, dailyLimit: 1 }, normal: { cooldownMinutes: 120, dailyLimit: 2 }, often: { cooldownMinutes: 120, dailyLimit: 3 } } as const;
type Frequency = keyof typeof FREQUENCIES;
const copy = {
  en: {
    title: 'Check-ins', intro: 'Lets your companion come to you: in the morning, when you return, after a long stretch at the computer, and late at night.',
    detail: 'Uses time, idle duration and privacy-allowed memories or diary summaries, not screen content or typing. Quiet hours are preserved (23:00–08:00 by default). No greeting within two hours of a chat; no repeated unanswered greetings the same day.',
    cloud: 'Allow cloud-allowed memories and diary summaries to be sent to the chosen model (required for cloud models). Local-only data stays on this Mac.',
    toggle: 'Let it check in on me', frequency: 'How often', rare: 'Few (up to 1 a day)', normal: 'Normal (up to 2 a day)', often: 'More (up to 3 a day)', model: 'Model used',
    now: 'Check in now', sent: 'Asked for a check-in. It will appear beside the character shortly.', failed: 'That did not work. Check that a model is set up and the permission was allowed.', noProvider: 'Set up a model first.',
  },
  'zh-CN': {
    title: '主动关心', intro: '让她主动来找你：早上、你回来时、连续用电脑太久、夜深了还没睡。',
    detail: '使用时间、空闲时长及隐私允许的记忆和日记摘要，不读取屏幕内容或输入。保留已有安静时段（默认23:00–08:00）；聊完两小时内不打扰，当天未回复不连发。',
    cloud: '允许把可用于云端的记忆和日记摘要交给所选模型（云端模型需要开启）。仅本地数据仍留在本机。',
    toggle: '让她主动关心我', frequency: '频率', rare: '少（每天最多 1 次）', normal: '正常（每天最多 2 次）', often: '多（每天最多 3 次）', model: '使用的模型',
    now: '现在问候一次', sent: '已请求问候，稍后会出现在角色旁边。', failed: '没有成功。请确认已配置模型，并允许了权限。', noProvider: '请先配置模型。',
  },
} as const;

const frequencyOf = (policy: ProactivePolicy): Frequency => policy.dailyLimit <= 1 ? 'rare' : policy.dailyLimit >= 3 ? 'often' : 'normal';

export const CareSettings = ({ api, providers, activeProviderId, locale, requestPermission }: {
  api: AutomationAPI; providers: readonly ProviderConfig[]; activeProviderId: string | null; locale: 'en' | 'zh-CN'; requestPermission(): Promise<unknown>;
}): JSX.Element => {
  const t = copy[locale];
  const [policy, setPolicy] = useState<ProactivePolicy | null>(null);
  const [status, setStatus] = useState<'sent' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = providers.filter((provider) => provider.enabled);
  const provider = usable.find((item) => item.id === policy?.providerId) ?? usable.find((item) => item.id === activeProviderId) ?? usable[0];
  useEffect(() => { void api.snapshot().then((snapshot) => setPolicy(snapshot.proactivePolicy)).catch(() => setStatus('failed')); }, [api]);
  const on = policy !== null && proactiveMode(policy) === 'auto';
  const apply = async (enabled: boolean, frequency: Frequency, chosen = provider, privacy = policy?.privacy): Promise<void> => {
    if (policy === null || (enabled && chosen === undefined)) return;
    setBusy(true); setStatus(null);
    try {
      if (enabled) await requestPermission();
      const { revision, ...input } = policy; void revision;
      setPolicy(await api.configureProactive({ ...input, enabled, mode: enabled ? 'auto' : 'off', eventKinds: ['task-completed', 'focus-completed', 'explicit-check-in'],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...FREQUENCIES[frequency],
        privacy: privacy ?? input.privacy,
        providerId: chosen?.id ?? input.providerId, model: chosen?.model ?? input.model }));
    } catch { setStatus('failed'); }
    finally { setBusy(false); }
  };
  const checkInNow = async (): Promise<void> => {
    setBusy(true); setStatus(null);
    try { await api.explicitCheckIn({ operationId: globalThis.crypto.randomUUID() }); setStatus('sent'); }
    catch { setStatus('failed'); }
    finally { setBusy(false); }
  };
  return <section className="panel persona-settings" aria-label={t.title}>
    <div><h2>{t.title}</h2><p>{t.intro}</p></div>
    <p className="muted">{t.detail}</p>
    {usable.length === 0 && <p role="status">{t.noProvider}</p>}
    <label className="check-row"><input type="checkbox" checked={on} disabled={busy || policy === null || usable.length === 0} onChange={(event) => void apply(event.target.checked, policy ? frequencyOf(policy) : 'normal')} />{t.toggle}</label>
    {policy && <label className="check-row"><input type="checkbox" checked={policy.privacy === 'cloud-allowed'} disabled={busy} onChange={e => void apply(on, frequencyOf(policy), provider, e.target.checked ? 'cloud-allowed' : 'local-only')} />{t.cloud}</label>}
    {on && policy && <div className="persona-row">
      <label>{t.frequency}<select value={frequencyOf(policy)} disabled={busy} onChange={(event) => void apply(true, event.target.value as Frequency)}>
        {(['rare', 'normal', 'often'] as const).map((value) => <option key={value} value={value}>{t[value]}</option>)}</select></label>
      <label>{t.model}<select value={provider?.id ?? ''} disabled={busy} onChange={(event) => void apply(true, frequencyOf(policy), usable.find((item) => item.id === event.target.value))}>
        {usable.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
    </div>}
    {on && <div className="persona-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void checkInNow()}>{t.now}</button></div>}
    {status && <p role={status === 'failed' ? 'alert' : 'status'}>{t[status]}</p>}
  </section>;
};
