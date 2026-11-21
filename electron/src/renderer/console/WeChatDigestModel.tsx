import type { JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import type { WeChatCloudRoute, WeChatCloudState } from '../../shared/wechat-channel';

export function WeChatDigestModel({ locale, label, inherited, unavailable, value, providers, disabled, change }: {
  locale: ResolvedLocale;
  label: string;
  inherited: string;
  unavailable: string;
  value: WeChatCloudRoute | null;
  providers: WeChatCloudState['providers'];
  disabled?: boolean;
  change(route: WeChatCloudRoute | null): void;
}): JSX.Element {
  const provider = providers.find(item => item.id === value?.providerId);
  return <>
    <label>{label}<select value={value?.providerId ?? ''} disabled={disabled} onChange={event => {
      const id = event.target.value;
      change(id ? { providerId: id, model: null } : null);
    }}>
      <option value="">{inherited}</option>
      {value && !provider && <option value={value.providerId}>{unavailable}</option>}
      {providers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
    </select></label>
    {value && provider && <>
      <label className="wechat-option">
        <input type="checkbox" checked={value.model === null} disabled={disabled}
          onChange={event => change({ providerId: provider.id, model: event.target.checked ? null : provider.model })} />
        <span>{locale === 'zh-CN' ? '跟随服务默认模型' : 'Follow the service default'}</span>
      </label>
      {value.model !== null && <label>{locale === 'zh-CN' ? '模型名称' : 'Model name'}
        <input value={value.model} maxLength={240} required disabled={disabled}
          onChange={event => change({ providerId: provider.id, model: event.target.value })} />
      </label>}
    </>}
  </>;
}
