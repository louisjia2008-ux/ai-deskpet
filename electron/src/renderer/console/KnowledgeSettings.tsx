import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import type { KnowledgeAnswer, KnowledgeDiarySync, KnowledgeFolder, KnowledgeHit, KnowledgeStatus } from '../../shared/knowledge';
import { DEFAULT_KNOWLEDGE_DIARY_FOLDER, isKnowledgeFolderName } from '../../shared/knowledge';
import { KNOWLEDGE_EMBEDDING_MODELS, type KnowledgeEmbeddingModel } from '../../shared/knowledge-embedding';
import './knowledge-settings.css';

const errorCode = (error: unknown): string =>
  error instanceof Error ? (error.message.match(/knowledge\.[A-Za-z]+/u)?.[0] ?? 'knowledge.failed') : 'knowledge.failed';

function SettingsSwitch({ label, accessibleLabel, description, checked, disabled, change }: {
  label: string; accessibleLabel?: string; description?: string | undefined; checked: boolean; disabled: boolean; change(checked: boolean): void;
}): JSX.Element {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  return <div className="setting-row">
    <div className="setting-label">
      <label htmlFor={id}>{label}</label>
      {description && <p id={descriptionId} className="muted">{description}</p>}
    </div>
    <span className="setting-control switch-row">
      <input id={id} type="checkbox" role="switch" aria-label={accessibleLabel} aria-describedby={descriptionId} checked={checked} disabled={disabled}
        onChange={event => change(event.currentTarget.checked)} />
    </span>
  </div>;
}

export function KnowledgeSettings({ locale }: { locale: string }): JSX.Element {
  const zh = locale.startsWith('zh');
  const api = window.deskpet.knowledge;
  const [state, setState] = useState<KnowledgeStatus | null>(null);
  const [folders, setFolders] = useState<KnowledgeFolder[] | null>(null);
  const [diaryFolderDraft, setDiaryFolderDraft] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [localModels, setLocalModels] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState('');
  const selected = localModels.find((p) => p.id === providerId);
  const diarySettings = state?.diarySync ?? { enabled: false, folder: DEFAULT_KNOWLEDGE_DIARY_FOLDER };
  const diaryFolder = diaryFolderDraft ?? diarySettings.folder;
  const diaryFolderValid = isKnowledgeFolderName(diaryFolder);
  const diaryProtected = (folder: KnowledgeFolder): boolean =>
    folder.diaryProtected || (diarySettings.enabled && diarySettings.folder === folder.name);
  const lifecycle = useRef({ alive: false, revision: 0, busy: false });

  const clearResults = (): void => { setHits(null); setAnswer(''); };
  const refresh = useCallback(async (withFolders: boolean): Promise<void> => {
    const current = lifecycle.current.revision;
    const isCurrent = (): boolean => lifecycle.current.alive && lifecycle.current.revision === current;
    try {
      const status = await api.getState();
      if (!isCurrent()) return;
      setState(status);
      if (!withFolders) return;
      if (!status.vaultName) {
        setFolders(null);
        return;
      }
      const entries = await api.listFolders();
      if (isCurrent()) setFolders(entries);
    } catch (error) {
      if (isCurrent()) setError(errorCode(error));
    }
  }, [api]);
  useEffect(() => {
    const view = lifecycle.current;
    view.alive = true;
    void refresh(true);
    const timer = window.setInterval(() => {
      if (!view.busy) void refresh(true);
    }, 15_000);
    void window.deskpet.providers.list().then((items) => {
      if (!view.alive) return;
      const models = items.filter((p) => {
        if (!p.enabled || !p.localExecutionConfirmed || !p.model || p.kind !== 'ollama') return false;
        try {
          const url = new URL(p.baseUrl);
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
        } catch {
          return false;
        }
      });
      setLocalModels(models);
      setProviderId(models[0]?.id ?? '');
    }).catch(() => undefined);
    return () => {
      view.alive = false;
      view.revision++;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!state?.indexing && !busy) return;
    const timer = window.setInterval(() => void refresh(false), 900);
    return () => window.clearInterval(timer);
  }, [busy, state?.indexing, refresh]);

  const run = async <T,>(operation: () => Promise<T>, apply: (value: T) => void, detach = false): Promise<void> => {
    const view = lifecycle.current;
    if (view.busy && !detach) return;
    const current = ++view.revision;
    view.busy = true;
    setBusy(true);
    setError('');
    clearResults();
    const settle = (): boolean => {
      if (!view.alive || view.revision !== current) return false;
      view.revision++;
      view.busy = false;
      setBusy(false);
      return true;
    };
    try {
      const value = await operation();
      if (settle()) apply(value);
    } catch (error) {
      if (settle()) setError(errorCode(error));
    }
  };
  const chooseVault = async (): Promise<void> => {
    await run(() => api.chooseVault(), (status) => {
      setState(status);
      setFolders(null);
      setDiaryFolderDraft(null);
      void refresh(true);
    });
  };
  const disconnect = async (): Promise<void> => {
    await run(() => api.detach(), (status) => {
      setState(status);
      setFolders(null);
      setDiaryFolderDraft(null);
    }, true);
  };
  const writeEnabled = (name: string, enabled: boolean): void => {
    const allowed = (folders ?? []).flatMap(folder =>
      folder.writable && !diaryProtected(folder) && folder.name !== null && folder.name !== name ? [folder.name] : []);
    if (enabled) allowed.push(name);
    void run(() => api.setWritableFolders(allowed), setFolders);
  };

  const saveDiarySettings = (settings: KnowledgeDiarySync): void => {
    void run(() => api.setDiarySync(settings), status => {
      setState(status);
      setDiaryFolderDraft(null);
      void refresh(true);
    });
  };
  const code = error || state?.lastError;
  const errors: Record<string, string> = {
    'knowledge.localModelBusy': zh ? '本机 Ollama 正在使用其他模型。' : 'Local Ollama is using another model.',
    'knowledge.embeddingStillLoaded': zh ? '嵌入模型尚未卸载，已暂停本机推理。' : 'The embedding model is still loaded. Local inference is paused.',
    'knowledge.ollamaUnavailable': zh ? '无法连接本机 Ollama。' : 'Could not connect to local Ollama.',
    'knowledge.embeddingModelMissing': zh ? '本机缺少选用的嵌入模型。' : 'The selected embedding model is missing.',
    'knowledge.noMatchingSources': zh ? '没有可引用的当前笔记。' : 'No current note excerpts match this question.',
    'knowledge.sourceChanged': zh ? '回答过程中笔记已改变。请重新搜索或更新索引。' : 'A source changed while answering. Update the index and try again.',
    'knowledge.localProviderRequired': zh ? '需要已确认在本机运行并通过 GGUF 检查的 Ollama 模型。' : 'Select an Ollama model confirmed to run locally with verified GGUF metadata.',
    'knowledge.noLocalModel': zh ? '请选择已确认在本机运行的聊天模型。' : 'Select a chat model confirmed to run locally.',
    'knowledge.embeddingNotLocal': zh ? '未能确认选用的模型是本机 GGUF 嵌入模型。' : 'Could not verify the selected model as a local GGUF embedding model.',
    'knowledge.rootChanged': zh ? '笔记库目录已改变。请重新选择。' : 'The vault directory changed. Select it again.',
    'knowledge.storageUnavailable': zh ? '本机加密索引暂不可用。' : 'The encrypted local index is unavailable.',
    'knowledge.diaryFolderShareable': zh ? '这个文件夹已允许离开这台电脑。请先关闭它的共享开关，或选择另一个顶层文件夹。'
      : 'This folder is shared. Turn off sharing for it or choose another top-level folder.',
    'knowledge.diaryFolderProtected': zh ? '日记同步文件夹仅限本机，不能用来新建普通笔记。'
      : 'This local-only diary folder is unavailable for creating notes.',
    'knowledge.diaryFolderInvalid': zh ? '请选择可用的顶层文件夹，或输入新文件夹的名称。'
      : 'Choose an available top-level folder or enter a new folder name.',
    'knowledge.diarySyncFailed': zh ? '日记同步未完成。请检查笔记库及文件夹的本机权限。'
      : 'Diary sync did not complete. Check the vault and folder permissions on this computer.',
  };
  const modelStatus = {
    installed: zh ? '已安装' : 'Installed',
    missing: zh ? '未安装' : 'Not installed',
    unavailable: zh ? '无法确认本机模型' : 'Could not verify local model',
    unknown: zh ? '尚未检查' : 'Not checked yet',
  };
  const folderLabel = (folder: KnowledgeFolder): string => folder.name ?? (zh ? '根目录笔记' : 'Notes in the vault root');

  return (
    <section className="knowledge-settings" data-testid="knowledge-settings">
      <h2>{zh ? '知识库' : 'Knowledge vault'}</h2>
      {code && <p role="alert">
        {errors[code] ?? (zh ? '操作未完成，请检查目录和本机 Ollama 后重试。' : 'Check the folder and local Ollama, then try again.')}{' '}
        <code>{code}</code>
      </p>}
      <section aria-label={zh ? '笔记库关联' : 'Vault link'}>
        <div className="setting-row">
          <div className="setting-label">
            <strong>{zh ? 'Obsidian 笔记库' : 'Obsidian vault'}</strong>
            <p aria-live="polite">{state?.vaultName ?? (zh ? '尚未关联笔记库' : 'No vault selected')}</p>
          </div>
          <div className="setting-control knowledge-controls">
            <button type="button" disabled={busy || state?.indexing} onClick={() => void chooseVault()}>
              {zh ? '选择笔记库' : 'Choose vault'}
            </button>
            {state?.vaultName && <button type="button" className="secondary" onClick={() => void disconnect()}>
              {zh ? '断开并移除本地索引' : 'Disconnect and remove index'}
            </button>}
          </div>
        </div>
      </section>
      {state?.vaultName && <>
        <section aria-labelledby="knowledge-index-heading">
          <h3 id="knowledge-index-heading">{zh ? '索引' : 'Index'}</h3>
          <div className="setting-row">
            <div className="setting-label">
              <label htmlFor="knowledge-model">{zh ? '嵌入模型' : 'Embedding model'}</label>
              <p className="muted">{modelStatus[state.embeddingStatus]}</p>
              {state.embeddingStatus === 'missing' && <p><code>ollama pull {state.embeddingModel}</code></p>}
            </div>
            <select id="knowledge-model" value={state.embeddingModel} disabled={busy || state.indexing}
              onChange={(event) => {
                const model = event.currentTarget.value as KnowledgeEmbeddingModel;
                void run(() => api.setEmbeddingModel(model), setState);
              }}>
              {KNOWLEDGE_EMBEDDING_MODELS.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          </div>
          <SettingsSwitch label={zh ? '自动索引' : 'Automatic indexing'}
            description={zh ? '启动时及运行期间每两小时检查一次。新建笔记保存后立即更新。'
              : 'Checks at startup and every two hours. Newly saved notes are indexed immediately.'}
            checked={state.autoIndex} disabled={busy} change={enabled => void run(() => api.setAutoIndex(enabled), setState)} />
          <div className="setting-row">
            <div className="setting-label" aria-live="polite">
              <strong>{state.indexedNotes} {zh ? '篇笔记' : 'notes'} · {state.indexedChunks} {zh ? '段' : 'passages'}</strong>
              <p className="muted">{state.indexing
                ? zh ? '正在索引' : 'Indexing'
                : state.lastIndexedAt
                  ? (zh ? '最近索引 ' : 'Last indexed ') + new Date(state.lastIndexedAt).toLocaleString(locale)
                  : zh ? '尚未索引' : 'Not indexed yet'}</p>
              {(state.indexing || state.lastIndexedAt) && <p className="muted">
                {state.checkedNotes} {zh ? '已检查' : 'checked'} · {state.changedNotes} {zh ? '已更新' : 'updated'} ·{' '}
                {state.removedNotes} {zh ? '已删除' : 'removed'} · {state.skippedNotes} {zh ? '已跳过' : 'skipped'}
              </p>}
            </div>
            <div className="setting-control">
              <button type="button" disabled={busy || state.indexing} onClick={() => void run(() => api.reindex(), setState)}>
                {zh ? '更新索引' : 'Update index'}
              </button>
            </div>
          </div>
        </section>
        <section aria-labelledby="knowledge-diary-sync-heading">
          <h3 id="knowledge-diary-sync-heading">{zh ? '日记同步' : 'Diary sync'}</h3>
          <SettingsSwitch label={zh ? '同步她的日记' : 'Sync her diary'}
            description={zh ? '关闭后会保留已导出的文件。失效副本仍会检查，直到解除笔记库关联。'
              : 'Turning sync off keeps exported files. DeskPet continues checking for invalid copies until you disconnect the vault.'}
            checked={diarySettings.enabled} disabled={busy || (!diarySettings.enabled && !diaryFolderValid)}
            change={enabled => saveDiarySettings({ enabled, folder: enabled ? diaryFolder : diarySettings.folder })} />
          <div className="setting-row">
            <div className="setting-label">
              <label htmlFor="knowledge-diary-folder">{zh ? '日记目标文件夹' : 'Diary folder'}</label>
              <p id="knowledge-diary-folder-help" className="muted">{zh ? '填写笔记库里的一个顶层文件夹名。日记副本只在本机使用。'
                : 'Enter a top-level folder name in the vault. Diary copies stay on this computer.'}</p>
            </div>
            <div className="setting-control knowledge-controls">
              <input id="knowledge-diary-folder" aria-describedby="knowledge-diary-folder-help" aria-invalid={!diaryFolderValid}
                value={diaryFolder} maxLength={255} disabled={busy} onChange={event => setDiaryFolderDraft(event.currentTarget.value)} />
              <button type="button" disabled={busy || !diaryFolderValid || diaryFolder === diarySettings.folder}
                onClick={() => saveDiarySettings({ enabled: diarySettings.enabled, folder: diaryFolder })}>
                {zh ? '保存目标文件夹' : 'Save diary folder'}
              </button>
            </div>
          </div>
        </section>
        <section aria-labelledby="knowledge-sharing-heading">
          <h3 id="knowledge-sharing-heading">{zh ? '可以离开这台电脑' : 'Can leave this computer'}</h3>
          <p className="muted">{zh
            ? '云端模型和微信、QQ、Telegram 私聊只可使用你在这里开放的文件夹。'
            : 'Cloud models and private replies through WeChat, QQ or Telegram can use only the folders you enable here.'}</p>
          {folders?.map(folder => <SettingsSwitch key={folder.name ?? '.'} label={folderLabel(folder)}
            accessibleLabel={zh ? `允许${folderLabel(folder)}离开这台电脑` : `Allow ${folderLabel(folder)} to leave this computer`}
            description={diaryProtected(folder) ? (zh ? '日记同步文件夹仅限本机。' : 'Diary sync folder. Local only.') : undefined}
            checked={!diaryProtected(folder) && folder.sharing === 'shareable'} disabled={busy || diaryProtected(folder)}
            change={enabled => void run(() => api.setFolderSharing({ folder: folder.name, level: enabled ? 'shareable' : 'local' }), setFolders)} />)}
        </section>
        <section aria-labelledby="knowledge-write-heading">
          <h3 id="knowledge-write-heading">{zh ? '她可以写入的文件夹' : 'Folders she can write to'}</h3>
          <p className="muted">{zh ? '桌宠角色只可在已勾选的文件夹里新建笔记。' : 'DeskPet can create new notes in the selected folders.'}</p>
          {folders?.map(folder => {
            const { name, writable } = folder;
            if (name === null || diaryProtected(folder)) return null;
            return <SettingsSwitch key={name} label={name}
              accessibleLabel={zh ? `可在${name}新建笔记` : `Can create notes in ${name}`}
              checked={writable} disabled={busy} change={enabled => writeEnabled(name, enabled)} />;
          })}
        </section>
      </>}
      <section aria-labelledby="knowledge-local-heading">
        <h3 id="knowledge-local-heading">{zh ? '本机搜索与问答' : 'Local search and answers'}</h3>
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(() => api.search(query.trim()), setHits);
        }}>
          <div className="setting-row">
            <label htmlFor="knowledge-query">{zh ? '搜索笔记原文' : 'Search note excerpts'}</label>
            <div className="setting-control">
              <input id="knowledge-query" maxLength={1400} value={query} onChange={(event) => setQuery(event.target.value)} />
              <button disabled={busy || !query.trim() || !state?.indexedNotes} type="submit">{zh ? '搜索' : 'Search'}</button>
            </div>
          </div>
        </form>
        <div className="setting-row">
          <label htmlFor="knowledge-chat-model">{zh ? '回答使用的本机模型' : 'Local model for answers'}</label>
          <select id="knowledge-chat-model" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {!localModels.length && <option value="">{zh ? '未配置已确认的本机模型' : 'No confirmed local model configured'}</option>}
            {localModels.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
          </select>
        </div>
        <button type="button" disabled={busy || !selected || !state?.indexedNotes || !query.trim()}
          onClick={() => {
            if (selected) void run(() => api.ask({ query: query.trim(), providerId: selected.id, model: selected.model }),
              (value: KnowledgeAnswer) => { setAnswer(value.answer); setHits(value.sources); });
          }}>
          {zh ? '用本机模型回答' : 'Ask local model'}
        </button>
      </section>
      {answer && <section>
        <h3>{zh ? '本机模型回答' : 'Local model answer'}</h3>
        <p className="knowledge-excerpt">{answer}</p>
        <h4>{zh ? '引用的笔记' : 'Source notes'}</h4>
      </section>}
      {hits?.length === 0 && (
        <p role="status">{zh ? '没有找到仍与当前版本一致的摘录。' : 'No excerpts matched the current note revisions.'}</p>
      )}
      {hits && hits.length > 0 && (
        <ol>
          {hits.map((hit) => (
            <li key={hit.path + ':' + hit.startLine + ':' + hit.excerpt.slice(0, 20)}>
              <strong>{hit.path}</strong>{' '}
              <span>{zh ? '行' : 'lines'} {hit.startLine}–{hit.endLine}</span>
              <p className="knowledge-excerpt">{hit.excerpt}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
