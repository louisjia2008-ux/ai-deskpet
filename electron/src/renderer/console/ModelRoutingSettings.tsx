import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import { defaultModelFallback, defaultModelRouting, routingDestination } from '../../shared/model-routing';
import type { ModelFallback } from '../../shared/model-routing';

export function ModelRoutingSettings({providers,locale}: {providers:ProviderConfig[]; locale:'en'|'zh-CN'}): JSX.Element | null {
  const zh = locale === 'zh-CN';
  const [value,setValue] = useState(defaultModelRouting);
  const [ready,setReady] = useState(false);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [fallbackProviderId,setFallbackProviderId] = useState('');
  useEffect(() => {
    let live = true;
    void window.deskpet.providers.getRouting?.().then(result => { if (live) { setValue({...result,fallback:result.fallback ?? defaultModelFallback}); setReady(true); } })
      .catch(() => { if (live) setNotice(zh ? '无法读取模型路由设置。' : 'Could not read model routing settings.'); });
    return () => { live = false; };
  },[zh]);
  if (!ready) return notice ? <p role="alert">{notice}</p> : null;
  const choices = (kind:'local'|'cloud') => providers.filter(provider => routingDestination(provider) === kind)
    .map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>);
  const fallback = value.fallback ?? defaultModelFallback;
  const fallbackChoices = providers.filter(provider => provider.enabled && !fallback.providerIds.includes(provider.id));
  const fallbackChoice = fallbackChoices.find(provider => provider.id === fallbackProviderId) ?? fallbackChoices[0];
  const updateFallback = (patch: Partial<ModelFallback>): void => setValue(current => ({...current,fallback:{...(current.fallback ?? defaultModelFallback),...patch}}));
  const moveFallback = (index: number, direction: -1 | 1): void => {
    const ids = [...fallback.providerIds], target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index],ids[target]] = [ids[target]!,ids[index]!];
    updateFallback({providerIds:ids});
  };
  const destinationLabel = (provider: ProviderConfig): string => {
    const destination = routingDestination(provider);
    return destination === 'local' ? (zh ? '本机' : 'Local') : destination === 'cloud' ? (zh ? '云端' : 'Cloud') : (zh ? '位置未核实' : 'Location unverified');
  };
  return <details><summary>{zh ? '模型路由与故障切换' : 'Model routing and fallback'}</summary>
    <form className="stack-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setNotice('');
      try { setValue(await window.deskpet.providers.setRouting(value)); setNotice(zh ? '已保存模型路由与故障切换设置。' : 'Model routing and fallback settings saved.'); }
      catch { setNotice(zh ? '无法保存，请检查已启用的模型。' : 'Could not save. Check the enabled providers.'); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy}>
      <legend>{zh ? '本地与云端模型路由' : 'Local and cloud model routing'}</legend>
      <label><input type="checkbox" checked={value.enabled} onChange={event => setValue({...value,enabled:event.target.checked})} />
        {zh ? '桌面聊天优先使用本地模型' : 'Prefer a local model for desktop chat'}</label>
      <label>{zh ? '本地服务与模型' : 'Local provider and model'}<select value={value.localProviderId ?? ''} required={value.enabled}
        onChange={event => setValue({...value,localProviderId:event.target.value || null})}>
        <option value="">{zh ? '请选择' : 'Select'}</option>{choices('local')}</select></label>
      <label>{zh ? '复杂任务可选的云端服务' : 'Optional cloud provider for complex tasks'}<select value={value.cloudProviderId ?? ''}
        onChange={event => setValue({...value,cloudProviderId:event.target.value || null})}>
        <option value="">{zh ? '只用本地' : 'Local only'}</option>{choices('cloud')}</select></label>
      <small>{zh ? '长请求和复杂研究会在发送前询问本次是否用云端。仅限本机的会话始终使用本地模型。' :
        'Long requests and complex research ask before using the cloud. Private conversations stay local.'}</small>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{zh ? '模型故障切换' : 'Model fallback'}</legend>
        <label><input type="checkbox" checked={fallback.enabled} onChange={event => updateFallback({enabled:event.target.checked})} />
          {zh ? '模型响应前失败时尝试备用模型' : 'Try fallback models when a request fails before its first response'}</label>
        <p>{zh ? '此开关独立于本地优先路由。按以下顺序尝试最多 3 个已启用的备用模型。只在本次任务首个模型响应之前发生可恢复错误时切换；不会重放工具，也不会重新发送已经开始输出的回复。' :
          'This setting is independent of local-first routing. Try up to 3 enabled fallback models in this order. Switching is limited to recoverable failures before this task receives its first model response; tools and replies that have started are not replayed.'}</p>
        <ol aria-label={zh ? '备用模型顺序' : 'Fallback model order'}>
          {fallback.providerIds.map((id,index) => {
            const provider = providers.find(item => item.id === id);
            const label = provider ? `${provider.name} · ${provider.model}` : (zh ? '已移除的模型' : 'Removed provider');
            return <li key={id}><strong>{label}</strong>{' · '}
              <span>{provider?.enabled ? destinationLabel(provider) : (zh ? '不可用，请移除或重新启用' : 'Unavailable; remove or enable it')}</span>
              <div className="button-row">
                <button type="button" className="secondary" disabled={index === 0} aria-label={zh ? `上移 ${label}` : `Move up ${label}`} onClick={() => moveFallback(index,-1)}>{zh ? '上移' : 'Move up'}</button>
                <button type="button" className="secondary" disabled={index === fallback.providerIds.length - 1} aria-label={zh ? `下移 ${label}` : `Move down ${label}`} onClick={() => moveFallback(index,1)}>{zh ? '下移' : 'Move down'}</button>
                <button type="button" className="text-button" aria-label={zh ? `移除 ${label}` : `Remove ${label}`} onClick={() => updateFallback({providerIds:fallback.providerIds.filter(item => item !== id)})}>{zh ? '移除' : 'Remove'}</button>
              </div>
            </li>;
          })}
        </ol>
        <label>{zh ? '添加备用模型' : 'Add fallback model'}<select value={fallbackChoice?.id ?? ''} disabled={fallback.providerIds.length >= 3 || !fallbackChoices.length}
          onChange={event => setFallbackProviderId(event.target.value)}>
          {!fallbackChoices.length && <option value="">{zh ? '没有其他已启用的模型' : 'No other enabled models'}</option>}
          {fallbackChoices.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model} · {destinationLabel(provider)}</option>)}
        </select></label>
        <button type="button" className="secondary" disabled={!fallbackChoice || fallback.providerIds.length >= 3}
          onClick={() => { if (fallbackChoice) updateFallback({providerIds:[...fallback.providerIds,fallbackChoice.id]}); }}>{zh ? '加入备用顺序' : 'Add to fallback order'}</button>
        {fallback.enabled && !fallback.providerIds.length && <p role="status">{zh ? '请添加至少一个备用模型，或关闭故障切换。' : 'Add at least one fallback model, or turn fallback off.'}</p>}
        <small>{zh ? '云端请求可以切换到本机；本机请求和私密会话不会自动切换到云端，位置未核实的模型不会自动参与切换。适用于桌面聊天、QQ 普通聊天和桌面定时任务；Telegram 与带频道批准的计划暂不自动切换。' :
          'Cloud requests may fall back to this device. Local requests and private conversations never switch to the cloud automatically; models with an unverified location are skipped. Applies to desktop chat, ordinary QQ chat, and desktop scheduled jobs. Telegram and plans with channel approval do not switch automatically yet.'}</small>
      </fieldset>
      <button type="submit" disabled={busy || fallback.enabled && !fallback.providerIds.length}>{zh ? '保存路由' : 'Save routing'}</button>{notice && <p role="status">{notice}</p>}
    </form></details>;
}
