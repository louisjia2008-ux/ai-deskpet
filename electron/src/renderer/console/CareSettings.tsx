import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { proactiveMode } from '../../shared/automation';
import type { AutomationAPI, ProactiveMode, ProactivePolicy } from '../../shared/automation';
import { providerIsLocal } from './provider-locality';
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
    cloud: '问候时参考记忆和日记摘要（会发给云端模型；标为仅本机的内容不会发出）',
    toggle: '让她主动关心我', frequency: '频率', rare: '少（每天最多 1 次）', normal: '正常（每天最多 2 次）', often: '多（每天最多 3 次）', model: '使用的模型',
    now: '现在问候一次', sent: '已让她准备问候，写好后会出现在桌面（或你选的渠道）。', failed: '没有成功。请确认已配置模型，并允许了权限。', noProvider: '请先配置模型。',
  },
} as const;

const frequencyOf = (policy: ProactivePolicy): Frequency => policy.dailyLimit <= 1 ? 'rare' : policy.dailyLimit >= 3 ? 'often' : 'normal';

export const CareSettings = ({ api, providers, activeProviderId, locale, requestPermission, refreshKey = 0, onSaved }: {
  api: AutomationAPI; providers: readonly ProviderConfig[]; activeProviderId: string | null; locale: 'en' | 'zh-CN'; requestPermission(): Promise<unknown>;
  /** Changes when the advanced rules were saved, so this card reads the policy again. */
  refreshKey?: number; onSaved?: () => void;
}): JSX.Element => {
  const t = copy[locale];
  const zh = locale === 'zh-CN';
  const [policy, setPolicy] = useState<ProactivePolicy | null>(null);
  const [status, setStatus] = useState<'sent' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = providers.filter((provider) => provider.enabled);
  const provider = usable.find((item) => item.id === policy?.providerId) ?? usable.find((item) => item.id === activeProviderId) ?? usable[0];
  useEffect(() => { void api.snapshot().then((snapshot) => setPolicy(snapshot.proactivePolicy)).catch(() => setStatus('failed')); }, [api, refreshKey]);
  const mode: ProactiveMode = policy === null ? 'off' : proactiveMode(policy);
  const on = mode === 'auto';
  // Each control changes only its own fields; events, quiet hours, topics and time zone stay as saved.
  const apply = async (patch: { mode?: ProactiveMode; frequency?: Frequency; provider?: ProviderConfig | undefined; privacy?: ProactivePolicy['privacy']; model?: string | null }): Promise<void> => {
    if (policy === null) return;
    const nextMode = patch.mode ?? mode;
    const chosen = 'provider' in patch ? patch.provider : provider;
    if (nextMode === 'auto' && chosen === undefined) return;
    setBusy(true); setStatus(null);
    try {
      if (nextMode === 'auto' && mode !== 'auto') await requestPermission();
      const { revision, ...input } = policy; void revision;
      const model = 'model' in patch ? patch.model ?? null : chosen?.id === policy.providerId ? policy.model : null;
      setPolicy(await api.configureProactive({ ...input, enabled: nextMode === 'auto', mode: nextMode,
        eventKinds: input.eventKinds.length ? input.eventKinds : ['task-completed', 'focus-completed', 'explicit-check-in'],
        timezone: input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(patch.frequency ? FREQUENCIES[patch.frequency] : {}),
        privacy: patch.privacy ?? input.privacy,
        providerId: chosen?.id ?? input.providerId, model }));
      onSaved?.();
    } catch { setStatus('failed'); }
    finally { setBusy(false); }
  };
  const checkInNow = async (): Promise<void> => {
    setBusy(true); setStatus(null);
    try { await api.explicitCheckIn({ operationId: globalThis.crypto.randomUUID() }); setStatus('sent'); }
    catch { setStatus('failed'); }
    finally { setBusy(false); }
  };
  const modes: Array<[ProactiveMode, string]> = [['off', zh ? '关闭' : 'Off'], ['auto', zh ? '主动问候' : 'Check in on me'], ['observe', zh ? '只记录，不打扰' : 'Record only, never interrupt']];
  return <section className="panel persona-settings" aria-label={t.title}>
    <div><h2>{t.title}</h2><p>{t.intro}</p></div>
    <p className="muted">{t.detail}</p>
    {usable.length === 0 && mode !== 'auto' && <p role="status">{t.noProvider}</p>}
    <div className="memory-tabs" role="radiogroup" aria-label={t.toggle}>{modes.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={mode === value}
      disabled={busy || policy === null || (value === 'auto' && mode !== 'auto' && usable.length === 0)}
      onClick={() => { if (value !== mode) void apply({ mode: value }); }}>{label}</button>)}</div>
    {mode === 'observe' && <p className="muted">{zh ? '只在本机记下“本来会在什么时候问候、为什么”，不调用模型，也不会出现在桌面。记录在下方「高级」里。' : 'Only records locally when and why a check-in would have happened. No model calls, nothing on screen. Records are under Advanced below.'}</p>}
    {on && policy && provider && !providerIsLocal(provider) && <label className="check-row"><input type="checkbox" checked={policy.privacy === 'cloud-allowed'} disabled={busy} onChange={e => void apply({ privacy: e.target.checked ? 'cloud-allowed' : 'local-only' })} />{t.cloud}</label>}
    {on && policy && <div className="persona-row">
      <label>{t.frequency}<select value={frequencyOf(policy)} disabled={busy} onChange={(event) => void apply({ frequency: event.target.value as Frequency })}>
        {(['rare', 'normal', 'often'] as const).map((value) => <option key={value} value={value}>{t[value]}</option>)}</select></label>
      <label>{t.model}<select value={provider?.id ?? ''} disabled={busy} onChange={(event) => void apply({ provider: usable.find((item) => item.id === event.target.value) })}>
        {usable.map((item) => <option key={item.id} value={item.id}>{item.name} · {(item.id === policy.providerId && policy.model) || item.model}</option>)}</select></label>
      {provider && policy.model && <button type="button" className="secondary" disabled={busy}
        onClick={() => void apply({ model: null })}>
        {zh ? '跟随服务默认模型' : 'Follow service default'} ({provider.model})
      </button>}
    </div>}
    {on && <div className="persona-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void checkInNow()}>{t.now}</button></div>}
    {status && <p role={status === 'failed' ? 'alert' : 'status'}>{t[status]}</p>}
  </section>;
};
