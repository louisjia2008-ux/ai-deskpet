import type { ProviderConfig } from '../../shared';

export interface ChatCommand { name: 'help' | 'model' | 'models' | 'provider'; argument: string }

/** Where a command was typed. Each place keeps its own provider and model. */
export interface ChatCommandTarget {
  /** Numbered lists are remembered per place, so "/model 2" means the list shown there. */
  key: string;
  locale: 'zh-CN' | 'en';
  /** A null provider follows the desktop provider. A null model follows that provider’s default. */
  selection(): { providerId: string | null; model: string | null };
  select(providerId: string, model: string | null): Promise<void>;
}

export interface ChatCommandHost {
  /** Enabled providers only. */
  providers(): ProviderConfig[];
  activeProvider(): ProviderConfig | undefined;
  models(providerId: string): Promise<string[]>;
}

const LISTED = 40;

/** Owner commands shared by every channel. Any other text starting with "/" stays an ordinary message. */
export const parseChatCommand = (text: string): ChatCommand | null => {
  const match = /^\/(help|models?|providers?)(?:[ \t]+(\S.{0,239}))?$/iu.exec(text.trim());
  if (!match) return null;
  const word = match[1]!.toLowerCase(), argument = match[2]?.trim() ?? '';
  if (word === 'help') return argument ? null : { name: 'help', argument: '' };
  if (word.startsWith('provider')) return { name: 'provider', argument };
  return { name: argument || word === 'model' ? 'model' : 'models', argument };
};

type Pick = { found: string } | { several: string[] } | { none: true };

/** A number from the last list, an exact name, or a part of a name that matches only one. */
const pick = (names: readonly string[], argument: string, listed: readonly string[] | undefined): Pick => {
  if (/^\d{1,3}$/u.test(argument)) {
    const numbered = (listed ?? names)[Number(argument) - 1];
    return numbered !== undefined && names.includes(numbered) ? { found: numbered } : { none: true };
  }
  const wanted = argument.toLowerCase();
  const exact = names.find(name => name.toLowerCase() === wanted);
  if (exact !== undefined) return { found: exact };
  const partial = names.filter(name => name.toLowerCase().includes(wanted));
  return partial.length === 1 ? { found: partial[0]! } : partial.length ? { several: partial.slice(0, 8) } : { none: true };
};

export class ChatCommands {
  readonly #listed = new Map<string, { providers?: string[]; models?: string[] }>();

  constructor(private readonly host: ChatCommandHost) {}

  #current(target: ChatCommandTarget): { provider: ProviderConfig | undefined; model: string | null } {
    const selection = target.selection();
    const provider = (selection.providerId === null ? undefined : this.host.providers().find(item => item.id === selection.providerId))
      ?? this.host.activeProvider();
    // A model chosen for another provider says nothing about this one.
    return { provider, model: provider === undefined ? null : provider.id === selection.providerId && selection.model ? selection.model : provider.model };
  }

  #remember(target: ChatCommandTarget, list: { providers?: string[]; models?: string[] }): void {
    this.#listed.set(target.key, { ...this.#listed.get(target.key), ...list });
  }

  async run(command: ChatCommand, target: ChatCommandTarget): Promise<string> {
    const zh = target.locale === 'zh-CN';
    const { provider, model } = this.#current(target);
    const now = provider === undefined ? (zh ? '还没有可用的模型服务。' : 'No model provider is available.')
      : (zh ? `当前：${provider.name} · ${model}` : `Now: ${provider.name} · ${model}`);
    if (command.name === 'help') {
      return zh
        ? '/model 查看当前模型\n/models 列出当前服务的模型\n/model 名称或序号 切换模型\n/provider 列出模型服务\n/provider 名称或序号 切换模型服务\n切换只影响发出指令的这个入口。'
        : '/model shows the current model\n/models lists this provider\'s models\n/model <name or number> switches model\n/provider lists providers\n/provider <name or number> switches provider\nA switch applies only where the command was sent.';
    }
    if (command.name === 'provider') {
      const providers = this.host.providers();
      if (!command.argument) {
        this.#remember(target, { providers: providers.map(item => item.id) });
        return [now, ...providers.map((item, index) => `${index + 1}. ${item.name} · ${item.model}${item.id === provider?.id ? (zh ? '（当前）' : ' (current)') : ''}`)].join('\n');
      }
      const byName = new Map(providers.map(item => [item.name, item.id]));
      const listed = this.#listed.get(target.key)?.providers;
      const chosen = /^\d{1,3}$/u.test(command.argument) ? pick(providers.map(item => item.id), command.argument, listed) : pick([...byName.keys()], command.argument, undefined);
      if ('several' in chosen) return (zh ? '有多个匹配，请写得更完整：\n' : 'Several match; be more specific:\n') + chosen.several.join('\n');
      if ('none' in chosen) return zh ? '没有这个模型服务。发送 /provider 查看列表。' : 'No such provider. Send /provider for the list.';
      const next = providers.find(item => item.id === (byName.get(chosen.found) ?? chosen.found))!;
      await target.select(next.id, null);
      this.#remember(target, { models: [] });
      return zh ? `已切换：${next.name} · ${next.model}` : `Switched: ${next.name} · ${next.model}`;
    }
    if (provider === undefined) return now;
    if (command.name === 'model' && !command.argument) return now;
    let models: string[];
    try { models = await this.host.models(provider.id); }
    catch { return zh ? `读取 ${provider.name} 的模型列表失败，没有切换。` : `Could not read the model list from ${provider.name}; nothing was switched.`; }
    if (command.name === 'models') {
      this.#remember(target, { models: models.slice(0, LISTED) });
      const more = models.length > LISTED ? [zh ? `共 ${models.length} 个，只列出前 ${LISTED} 个；其余可用 /model 加名称切换。` : `${models.length} in all, first ${LISTED} shown; switch to the rest with /model and a name.`] : [];
      return [now, ...models.slice(0, LISTED).map((id, index) => `${index + 1}. ${id}${id === model ? (zh ? '（当前）' : ' (current)') : ''}`), ...more].join('\n');
    }
    const listed = this.#listed.get(target.key)?.models;
    const chosen = pick(models, command.argument, listed?.length ? listed : undefined);
    if ('several' in chosen) return (zh ? '有多个匹配，请写得更完整：\n' : 'Several match; be more specific:\n') + chosen.several.join('\n');
    if ('none' in chosen) return zh ? `${provider.name} 没有这个模型。发送 /models 查看列表。` : `${provider.name} has no such model. Send /models for the list.`;
    await target.select(provider.id, chosen.found);
    return zh ? `已切换：${provider.name} · ${chosen.found}` : `Switched: ${provider.name} · ${chosen.found}`;
  }
}
