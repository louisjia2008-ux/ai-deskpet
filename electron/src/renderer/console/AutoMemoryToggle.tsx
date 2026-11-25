import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { AutoMemoryAPI, AutoMemoryStatus } from '../../shared/auto-memory';

const copy = {
  en: { label: 'Learn about me from conversations', detail: 'A few minutes after a conversation goes quiet, the model that answered reads what you said and keeps lasting facts and preferences here. Each one can be edited or deleted, and a deleted one is not learned again.',
    model: 'Model for background memory', follow: 'Same as chat (default)',
    modelDetail: 'Used to read conversations for lasting facts and for the nightly tidy-up, with the provider you chat with now. A smaller model is usually enough for this and costs less.',
    failed: 'The model could not be changed. Try again.' },
  'zh-CN': { label: '从对话中自动记住我的信息和偏好', detail: '对话停下几分钟后，由刚才回答的那个模型读一遍你说过的话，把长期有用的事实和偏好记在这里。每条都可以修改或删除，删除后不会再被重新记住。',
    model: '后台记忆用的模型', follow: '跟随聊天模型（默认）',
    modelDetail: '用于从对话里提取长期信息和夜间整理，只用你现在聊天的这家服务。这类活儿小一点的模型通常就够了，也更省钱。',
    failed: '没能切换模型，请再试一次。' },
};

/** The model picker only appears when the provider can list its models; otherwise the tasks simply follow chat. */
export const AutoMemoryToggle = ({ api, locale, listModels }: { api: AutoMemoryAPI; locale: 'en' | 'zh-CN'; listModels?: (providerId: string) => Promise<Array<{ id: string }>> }): JSX.Element | null => {
  const [status, setStatus] = useState<AutoMemoryStatus | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.status().then(setStatus).catch(() => undefined); }, [api]);
  const providerId = status?.activeProviderId ?? null;
  useEffect(() => {
    if (!providerId || !listModels || !api.setModel) { setModels(null); return; }
    let current = true;
    void listModels(providerId).then((list) => { if (current) setModels([...new Set(list.map((model) => model.id))].sort()); }).catch(() => { if (current) setModels(null); });
    return () => { current = false; };
  }, [providerId, listModels, api]);
  if (status === null) return null;
  const t = copy[locale];
  const chosen = status.model && status.model.providerId === providerId ? status.model.model : '';
  // A model chosen earlier stays visible even if the provider no longer lists it.
  const options = models === null ? [] : chosen && !models.includes(chosen) ? [chosen, ...models] : models;
  return <div className="panel">
    <label className="check-row"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={event => {
      setBusy(true);
      void api.configure({ enabled: event.target.checked }).then(setStatus).catch(() => undefined).finally(() => setBusy(false));
    }} />{t.label}</label>
    <small>{t.detail}</small>
    {providerId && api.setModel && models !== null && <label className="background-memory-model">{t.model}
      <select value={chosen} disabled={busy} onChange={event => {
        const model = event.target.value;
        setBusy(true); setFailed(false);
        void api.setModel!({ model: model ? { providerId, model } : null }).then(setStatus).catch(() => setFailed(true)).finally(() => setBusy(false));
      }}>
        <option value="">{t.follow}</option>
        {options.map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
      <small>{t.modelDetail}</small>
    </label>}
    {failed && <p className="inline-error" role="alert">{t.failed}</p>}
  </div>;
};
