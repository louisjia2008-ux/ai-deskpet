import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { AutoMemoryAPI } from '../../shared/auto-memory';

const copy = {
  en: { label: 'Learn about me from conversations', detail: 'A few minutes after a conversation goes quiet, the model that answered reads what you said and keeps lasting facts and preferences here. Each one can be edited or deleted; a deleted one is not learned again.' },
  'zh-CN': { label: '从对话中自动记住我的信息和偏好', detail: '对话停下几分钟后，由刚才回答的那个模型读一遍你说过的话，把长期有用的事实和偏好记在这里。每条都可以修改或删除，删除后不会再被重新记住。' },
};

export const AutoMemoryToggle = ({ api, locale }: { api: AutoMemoryAPI; locale: 'en' | 'zh-CN' }): JSX.Element | null => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.status().then(status => setEnabled(status.enabled)).catch(() => undefined); }, [api]);
  if (enabled === null) return null;
  const t = copy[locale];
  return <div className="panel">
    <label className="check-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => {
      setBusy(true);
      void api.configure({ enabled: event.target.checked }).then(status => setEnabled(status.enabled)).catch(() => undefined).finally(() => setBusy(false));
    }} />{t.label}</label>
    <small>{t.detail}</small>
  </div>;
};
