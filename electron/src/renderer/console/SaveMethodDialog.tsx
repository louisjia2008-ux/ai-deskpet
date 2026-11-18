import { useState } from 'react';
import type { JSX } from 'react';
import type { ChatWorkTask } from '../../shared/chat-work';
import type { DesktopExtensionsAPI, InstalledSkill } from '../../shared/desktop-extensions';
import type { ResolvedLocale } from '../../shared/contracts';

export function MethodEditor({ api, locale, initialName, initialText, skill, sourceTaskId, onSaved }: {
  api: DesktopExtensionsAPI; locale: ResolvedLocale; initialName: string; initialText: string;
  skill?: Omit<InstalledSkill, 'text'> | undefined; sourceTaskId?: string | undefined; onSaved?(): void;
}): JSX.Element {
  const zh = locale === 'zh-CN';
  const [name, setName] = useState(initialName), [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [failed, setFailed] = useState(false);
  return <form className="stack-form" onSubmit={event => {
    event.preventDefault(); if (!api.saveMethod || busy) return;
    setBusy(true); setFailed(false);
    void api.saveMethod({ name: name.trim(), text: text.trim(), ...(sourceTaskId ? { sourceTaskId } : {}),
      ...(skill ? { id: skill.id, expectedDigest: skill.digest, expectedRevision: skill.revision ?? 1 } : {}),
    }).then(() => { setSaved(true); onSaved?.(); }).catch(() => setFailed(true)).finally(() => setBusy(false));
  }}>
    <p>{zh ? '保留可复用的步骤、输入和输出格式，删去这次任务的私人内容与偶然结果。保存后仅限本地且暂不启用，可在“设置 → 技能”查看并启用；修改也需要重新启用和公开授权。' : 'Keep reusable steps, inputs and output format. Remove private details and one-off results. Saved methods start local-only and disabled; review and enable them in Settings → Skills. Changes require new enablement and public approval.'}</p>
    <label>{zh ? '方法名称' : 'Method name'}<input required maxLength={160} value={name} disabled={busy || saved} onChange={event => setName(event.target.value)} /></label>
    <label>{zh ? '审阅并编辑方法' : 'Review and edit method'}<textarea aria-label={zh ? '审阅并编辑方法' : 'Review and edit method'} required rows={12} maxLength={32000} value={text} disabled={busy || saved} onChange={event => setText(event.target.value)} /></label>
    <button type="submit" disabled={!api.saveMethod || busy || saved || !name.trim() || !text.trim()}>{busy ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存本地方法' : 'Save local method')}</button>
    {saved && <p role="status">{zh ? '方法已保存。可在设置的技能列表中启用，下次按需使用。' : 'Method saved. Enable it in Settings → Skills to reuse it.'}</p>}
    {failed && <p role="alert">{zh ? '未能确认保存。请检查技能列表是否已有相同方法，或重新打开任务核对内容。' : 'Saving was not confirmed. Check for the method in Skills or reopen the task to review its current contents.'}</p>}
  </form>;
}

export const SaveMethodDialog = ({ task, locale }: { task: ChatWorkTask; locale: ResolvedLocale }): JSX.Element | null => {
  const zh = locale === 'zh-CN';
  if (task.status !== 'completed') return null;
  const steps = task.plan.length ? task.plan.map((step, index) => `${index + 1}. ${step}`).join('\n') : (zh ? '1. 写下本次有效的步骤。' : '1. Describe the steps that worked.');
  const draft = zh ? `# 适用情境\n${task.goal}\n\n# 所需输入\n请补充下一次需要提供的材料。\n\n# 步骤\n${steps}\n\n# 输出格式\n请填写希望重复使用的格式。\n\n# 验证\n核对实际结果和来源；未完成部分应明确说明。`
    : `# When to use\n${task.goal}\n\n# Inputs\nDescribe the material needed next time.\n\n# Steps\n${steps}\n\n# Output format\nDescribe the format to reuse.\n\n# Verification\nCheck actual results and sources; identify unfinished work.`;
  return <details className="saved-method-editor"><summary>{zh ? '保存为我的做法' : 'Save as my method'}</summary>
    <MethodEditor key={task.id} api={window.deskpet.plugins.extensions} locale={locale} initialName={task.goal.slice(0, 160)} initialText={draft} sourceTaskId={task.id} />
  </details>;
};
