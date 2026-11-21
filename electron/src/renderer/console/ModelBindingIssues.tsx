import { useState, type JSX } from 'react';
import type { AttentionAPI } from '../../shared/attention';
import type { ModelBindingFeature, ModelBindingIssue } from '../../shared/model-bindings';

const locations: Record<ModelBindingFeature, [string, string]> = {
  schedule: ['日程', 'Schedule'],
  'chat-cron': ['日程 · 聊天定时任务', 'Schedule · Chat schedules'],
  qq: ['设置 · QQ', 'Settings · QQ'],
  telegram: ['设置 · Telegram', 'Settings · Telegram'],
  research: ['研究任务', 'Research tasks'],
  wechat: ['设置 · 微信通道', 'Settings · WeChat'],
  chat: ['聊天', 'Chat'],
  subagent: ['委派 · 子任务', 'Delegations · Child tasks'],
  proactive: ['设置 · 主动关心', 'Settings · Proactive care'],
};

export const modelBindingLocation = (feature: ModelBindingFeature, locale: string): string =>
  locations[feature][locale === 'zh-CN' ? 0 : 1];

export function ModelBindingIssues({ issues, api, locale, refresh }: {
  issues: ModelBindingIssue[]; api: AttentionAPI; locale: string; refresh(): Promise<void>;
}): JSX.Element | null {
  const [working, setWorking] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const zh = locale === 'zh-CN';
  if (!issues.length) return null;
  const follow = async ({ id, providerId, model }: ModelBindingIssue): Promise<void> => {
    if (!api.followDefaultModel || working) return;
    setWorking(id);
    setFailed(null);
    try { await api.followDefaultModel({ id, providerId, model }); await refresh(); }
    catch { setFailed(id); }
    finally { setWorking(null); }
  };
  return <div className="attention-list">{issues.map(issue => <article key={issue.id} className="attention-card" data-state="failing">
    <div className="attention-card-heading"><span className="status-pill failed">{zh ? '模型不可用' : 'Model unavailable'}</span></div>
    <h2>{issue.label}</h2>
    <p>{zh ? `模型 ${issue.model} 当前不可用。` : `${issue.model} is unavailable.`}</p>
    <p className="attention-note">{modelBindingLocation(issue.feature, locale)} · {issue.providerName} · <code>{issue.code}</code></p>
    {issue.followModel && api.followDefaultModel && <button type="button" disabled={working !== null} onClick={() => void follow(issue)}>
      {zh ? `改为跟随默认模型（${issue.followModel}）` : `Follow the default model (${issue.followModel})`}
    </button>}
    {failed === issue.id && <p role="alert">{zh ? '保存失败，请刷新后重试。' : 'Could not save. Refresh and try again.'}</p>}
  </article>)}</div>;
}
