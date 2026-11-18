import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig, ResolvedLocale } from '../../shared';
import type { DesktopExtensionsState } from '../../shared/desktop-extensions';
import { routingDestination } from '../../shared/model-routing';

export const ChatCapabilitySummary = ({ provider, privateConversation, locale, refresh }: {
  provider: ProviderConfig | undefined; privateConversation: boolean; locale: ResolvedLocale; refresh(): Promise<void>;
}): JSX.Element => {
  const zh = locale === 'zh-CN';
  const [state, setState] = useState<DesktopExtensionsState | null>(null), [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async (): Promise<void> => {
    const epoch = ++generation.current; setLoading(true); setError(false);
    try {
      const value = await window.deskpet.plugins.extensions.state();
      if (epoch === generation.current) setState(value);
      await refresh();
    } catch { if (epoch === generation.current) setError(true); }
    finally { if (epoch === generation.current) setLoading(false); }
  };
  const toolModel = !!provider?.enabled && provider.supportsTools;
  const local = !!provider && provider.kind === 'ollama' && routingDestination(provider) === 'local';
  const publicSkills = state?.skills.filter(item => item.enabled && item.exposure === 'public').length ?? 0;
  const privateSkills = state?.skills.filter(item => item.enabled && item.exposure !== 'public').length ?? 0;
  const connectors = state?.servers.filter(item => item.enabled && ['deepwiki', 'microsoft-learn', 'github'].includes(item.preset ?? '')).length ?? 0;
  const disabledModel = zh ? '当前模型未开启工具；到服务设置启用或更换模型。' : 'Tools are off for this model. Enable tools in provider settings or change models.';
  return <details className="chat-capabilities" onToggle={event => { if (event.currentTarget.open && !state && !loading) void load(); }}>
    <summary>{zh ? '能力与限制' : 'Capabilities and limits'}</summary>
    <p className="muted">{zh ? '以下反映当前配置；执行时还会核验模型、服务连接和本次权限。读取私有内容后，可用范围会收紧。' : 'These are configuration conditions. Execution checks the model, connection and permissions again. Reading private material narrows the available tools.'}</p>
    <dl>
      <dt>{zh ? '联网查资料' : 'Web research'}</dt><dd>{!toolModel ? disabledModel : privateConversation ? (zh ? '本会话含仅限本地内容。请另开对话进行公开研究。' : 'This conversation is local-only. Start another conversation for public research.') : (zh ? '可请求搜索和读取网页；按本次权限执行。' : 'Search and page reading can be requested with task permissions.')}</dd>
      <dt>{zh ? '公开方法' : 'Public methods'}</dt><dd>{!toolModel ? disabledModel : !state ? (zh ? '待读取技能配置。' : 'Waiting for skill configuration.') : publicSkills ? (zh ? `${publicSkills} 个已启用。可从聊天按需读取；本会话的隐私限制仍适用。` : `${publicSkills} enabled methods can be selected in chat. Conversation privacy still applies.`) : (zh ? '到“设置 → 技能”查看内容并批准公开使用。' : 'Review and approve a method in Settings → Skills.')}</dd>
      <dt>{zh ? '私有方法' : 'Private methods'}</dt><dd>{zh ? `${privateSkills} 个已启用。${local ? '读取前会核验本机模型；读取简介或正文后将关闭本会话的外部研究。' : '请选用经过核实的本机 Ollama 模型；读取后关闭外部研究。'}` : `${privateSkills} enabled. ${local ? 'Local execution is verified before reading. Reading summaries or text disables external research.' : 'Choose a verified local Ollama model. Reading disables external research.'}`}</dd>
      <dt>{zh ? '本地文件' : 'Local files'}</dt><dd>{!toolModel ? disabledModel : (zh ? '可按需读取授权工作区、写入文本成果。私有文件读取需要本次授权，远端模型另需明确披露决定；不能访问任意目录。' : 'Read the authorized workspace and write text artifacts with task permission. Private reads require approval, with a separate disclosure decision for remote models. Arbitrary folders are unavailable.')}</dd>
      <dt>{zh ? '聊天 MCP' : 'Chat MCP'}</dt><dd>{!toolModel ? disabledModel : privateConversation ? (zh ? '仅限本地会话不能调用外部 MCP。' : 'External MCP is unavailable in a local-only conversation.') : !local ? (zh ? '需经过核实的本机 Ollama 模型。' : 'Requires a verified local Ollama model.') : !state ? (zh ? '待读取服务配置。' : 'Waiting for server configuration.') : connectors ? (zh ? `已启用 ${connectors} 个预设服务。聊天支持 Microsoft Learn、DeepWiki 和公开仓库搜索，逐次审批。` : `${connectors} presets enabled. Chat supports Microsoft Learn, DeepWiki and public repository search, with approval per call.`) : (zh ? '到“设置 → MCP 服务”启用所需预设。' : 'Enable a preset in Settings → MCP servers.')}</dd>
      <dt>{zh ? '浏览器与其他 MCP' : 'Browser and other MCP tools'}</dt><dd>{zh ? '目前在“设置 → MCP 服务”选择工具使用，尚不支持从普通聊天自动调用。' : 'Use these from Settings → MCP servers. Ordinary chat does not automatically invoke them.'}</dd>
    </dl>
    <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? (zh ? '正在读取…' : 'Loading…') : (zh ? '刷新能力配置' : 'Refresh configuration')}</button>
    {error && <p role="alert">{zh ? '扩展配置未能读取，请重试。' : 'Could not read extension configuration. Try again.'}</p>}
  </details>;
};
