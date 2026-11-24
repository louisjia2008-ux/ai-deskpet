import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { CloudArrowUp, Cpu } from '@phosphor-icons/react';
import { providerDefinitions } from '../../shared';
import type { ProviderConfig } from '../../shared';
import './quick-setup.css';

const copy = {
  en: {
    title: 'Connect a model to get started', detail: 'Choose one. You can add others in Settings at any time.',
    local: 'On this computer', localDetail: 'Private and free. Uses Ollama.', localLoading: 'Looking for Ollama…', localMissing: 'Could not reach Ollama. Start it and try again, or use a cloud model.', localEmpty: 'Ollama is running but has no chat model yet. Download one in Ollama (for example qwen3), then look again.', retry: 'Look again',
    cloud: 'Cloud model', cloudDetail: 'Faster, and needs an API key.', key: 'API key', connect: 'Connect', connecting: 'Connecting…', model: 'Model', start: 'Start chatting', failed: 'That did not work. Check the key and your network, then try again.',
  },
  'zh-CN': {
    title: '连接一个模型就能开始', detail: '选一个就行，之后可以在设置里随时添加别的。',
    local: '用这台电脑', localDetail: '隐私、免费，使用 Ollama。', localLoading: '正在查找 Ollama…', localMissing: '还没连上 Ollama。请启动它后重试，或者用云端模型。', localEmpty: 'Ollama 已连上，但还没有能聊天的模型。先在 Ollama 里下载一个（比如 qwen3），再重新查找。', retry: '重新查找',
    cloud: '用云端模型', cloudDetail: '更快，需要 API Key。', key: 'API Key', connect: '连接', connecting: '正在连接…', model: '模型', start: '开始聊天', failed: '没有连上。请检查 Key 和网络后重试。',
  },
} as const;

const cloudKinds = providerDefinitions.filter((item) => !item.local && item.kind !== 'openai-compatible');
const ollama = providerDefinitions.find((item) => item.kind === 'ollama')!;
// Embedding and reranker models cannot chat, so they never become the default.
const notEmbedding = (id: string): boolean => !/embed|bge-|rerank|minilm|(^|[/:-])e5-|gte-/iu.test(id);

export const QuickSetup = ({ locale, refresh }: { locale: 'en' | 'zh-CN'; refresh(): Promise<void> }): JSX.Element => {
  const t = copy[locale];
  const [local, setLocal] = useState<string[] | 'loading' | 'missing' | 'empty'>('loading');
  const [localModel, setLocalModel] = useState('');
  const [kind, setKind] = useState<ProviderConfig['kind']>(cloudKinds[0]!.kind);
  const [apiKey, setApiKey] = useState('');
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [cloudModel, setCloudModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const definition = cloudKinds.find((item) => item.kind === kind) ?? cloudKinds[0]!;

  const findLocal = async (): Promise<void> => {
    setLocal('loading');
    try {
      const models = (await window.deskpet.providers.discoverModels({ kind: 'ollama', baseUrl: ollama.defaultBaseUrl })).map((item) => item.id).filter(notEmbedding);
      setLocal(models.length > 0 ? models : 'empty'); setLocalModel(models[0] ?? '');
    } catch { setLocal('missing'); }
  };
  useEffect(() => { void findLocal(); }, []);

  const start = async (input: { kind: ProviderConfig['kind']; name: string; baseUrl: string; model: string; apiKey?: string; localExecutionConfirmed?: boolean }): Promise<void> => {
    setBusy(true); setFailed(false);
    try {
      const id = globalThis.crypto.randomUUID();
      await window.deskpet.providers.upsert({ id, enabled: true, supportsTools: true, ...input });
      await window.deskpet.providers.select(id);
      await refresh();
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const connect = async (): Promise<void> => {
    setBusy(true); setFailed(false); setCloudModels([]);
    try {
      const models = (await window.deskpet.providers.discoverModels({ kind, baseUrl: definition.defaultBaseUrl, apiKey })).map((item) => item.id);
      setCloudModels(models); setCloudModel(models[0] ?? '');
      if (models.length === 0) setFailed(true);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };

  return <div className="quick-setup">
    <h2>{t.title}</h2><p>{t.detail}</p>
    {failed && <p role="alert" className="quick-setup-error">{t.failed}</p>}
    <div className="quick-setup-options">
      <article><Cpu size={22} aria-hidden="true" /><h3>{t.local}</h3><p>{t.localDetail}</p>
        {local === 'loading' && <p role="status" className="muted">{t.localLoading}</p>}
        {(local === 'missing' || local === 'empty') && <><p role="status" className="muted">{local === 'empty' ? t.localEmpty : t.localMissing}</p><button type="button" className="secondary" onClick={() => void findLocal()}>{t.retry}</button></>}
        {Array.isArray(local) && <>
          <label>{t.model}<select value={localModel} disabled={busy} onChange={(event) => setLocalModel(event.target.value)}>{local.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <button type="button" disabled={busy || !localModel} onClick={() => void start({ kind: 'ollama', name: ollama.label, baseUrl: ollama.defaultBaseUrl, model: localModel, localExecutionConfirmed: true })}>{t.start}</button>
        </>}
      </article>
      <article><CloudArrowUp size={22} aria-hidden="true" /><h3>{t.cloud}</h3><p>{t.cloudDetail}</p>
        <select aria-label={t.cloud} value={kind} disabled={busy} onChange={(event) => { setKind(event.target.value as ProviderConfig['kind']); setCloudModels([]); setFailed(false); }}>{cloudKinds.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select>
        <label>{t.key}<input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={(event) => { setApiKey(event.target.value); setCloudModels([]); }} /></label>
        {cloudModels.length === 0
          ? <button type="button" className="secondary" disabled={busy || !apiKey.trim()} onClick={() => void connect()}>{busy ? t.connecting : t.connect}</button>
          : <><label>{t.model}<select value={cloudModel} disabled={busy} onChange={(event) => setCloudModel(event.target.value)}>{cloudModels.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
            <button type="button" disabled={busy || !cloudModel} onClick={() => void start({ kind, name: definition.label, baseUrl: definition.defaultBaseUrl, model: cloudModel, apiKey })}>{t.start}</button></>}
      </article>
    </div>
  </div>;
};
