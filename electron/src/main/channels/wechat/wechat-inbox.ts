import { createHash } from 'node:crypto';
import { z } from 'zod';
import { wechatInboxIdSchema, wechatInboxInputSchema, wechatInboxItemSchema, wechatInboxQuerySchema } from '../../../shared/wechat-inbox';
import type { WeChatInboxInput, WeChatInboxItem } from '../../../shared/wechat-inbox';
import { EncryptedJsonStore } from '../../persistence/encrypted-json-store';
import type { VaultKeyProvider } from '../../persistence/encrypted-json-store';

const itemLimit = 1000;
const candidateTtlMs = 24 * 60 * 60 * 1000;
const ownerLimit = 32;
const receiptLimit = 128;
const pageSize = 5;

const ownerSchema = z.strictObject({
  binding: wechatInboxIdSchema,
  migrated: z.boolean(),
  exportGrant: z.string().uuid().nullable(),
  items: z.array(wechatInboxItemSchema).max(itemLimit),
  candidate: z.strictObject({ eventId: wechatInboxIdSchema, expiresAt: z.number().int(), item: wechatInboxInputSchema }).nullable(),
  listing: z.array(wechatInboxIdSchema).max(pageSize),
  receipts: z.array(z.strictObject({ eventId: wechatInboxIdSchema, command: wechatInboxIdSchema, reply: z.string().max(500) })).max(receiptLimit),
});
const stateSchema = z.strictObject({ version: z.literal(1), owners: z.array(ownerSchema).max(ownerLimit) });
type Owner = z.infer<typeof ownerSchema>;
type State = z.infer<typeof stateSchema>;
type Options = {
  now?: () => number;
  maxItems?: number;
  candidateTtlMs?: number;
  onSaved?: (binding: string, item: WeChatInboxItem) => Promise<void>;
};
type Guard = () => Promise<void>;

type Action = { kind: 'save' } | { kind: 'list'; query: string } | { kind: 'open'; rank: number }
  | { kind: 'legacyList'; page: number } | { kind: 'legacyOpen'; id: string };

function command(text: string): Action | null {
  const value = text.trim();
  if (/^(?:存|存一下|收一下|存进收件箱|收进收件箱|收藏(?:这篇)?|\/article save)$/iu.test(value)) return { kind: 'save' };
  if (value === '收件箱') return { kind: 'list', query: '' };
  const rank = /^收件箱\s+(\d{1,4})$/u.exec(value);
  if (rank) return { kind: 'open', rank: Number(rank[1]) };
  const query = /^找\s+(.{1,160})$/u.exec(value);
  if (query) return { kind: 'list', query: query[1]!.trim() };
  const legacyList = /^(?:收藏列表|我的收藏|\/article list)(?:\s+(\d{1,3}))?$/iu.exec(value);
  if (legacyList) return { kind: 'legacyList', page: Math.max(1, Number(legacyList[1] ?? 1)) };
  const legacyOpen = /^(?:打开收藏|\/article open)\s+([a-f0-9]{8,64})$/iu.exec(value);
  return legacyOpen ? { kind: 'legacyOpen', id: legacyOpen[1]!.toLowerCase() } : null;
}

export const inboxAcceptsCommand = (text: string): boolean => command(text) !== null;

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const searchText = (value: string): string => value.normalize('NFKC').toLowerCase();
const clip = (value: string, max: number): string => value.slice(0, max).replace(/[\uD800-\uDFFF]$/u, '').trimEnd();
const line = (value: string, max: number): string => clip(value.replace(/\s+/gu, ' '), max);

function matches(items: WeChatInboxItem[], query: string): WeChatInboxItem[] {
  const words = searchText(query).split(/\s+/u).filter(Boolean);
  return items.filter(item => {
    const text = searchText([item.title, item.source, item.summary, item.url ?? ''].join(' '));
    return words.every(word => text.includes(word));
  });
}

function deduplicationKey(item: WeChatInboxInput): unknown {
  if (item.url) {
    const url = new URL(item.url);
    url.hash = '';
    if (item.kind === 'article' && url.hostname === 'mp.weixin.qq.com') {
      const ids = ['__biz', 'mid', 'idx'].map(key => url.searchParams.get(key));
      if (ids.every(Boolean)) return ['article', ...ids];
    }
    return url.href;
  }
  if (item.fileRef) return ['file', item.fileRef];
  return [item.kind, item.title, item.source, item.summary, item.at];
}

function storeItem(owner: Owner, item: WeChatInboxInput, limit: number): { item: WeChatInboxItem; created: boolean } {
  const id = hash([owner.binding, deduplicationKey(item)]);
  const current = owner.items.find(existing => existing.id === id);
  if (current) {
    if (item.legacyId && current.legacyId === undefined) current.legacyId = item.legacyId;
    return { item: current, created: false };
  }
  const saved = { id, ...item };
  owner.items.unshift(saved);
  owner.items.length = Math.min(owner.items.length, limit);
  return { item: saved, created: true };
}

function describe(item: WeChatInboxItem): string {
  const prefix = `《${line(item.title, 110)}》`;
  const body = line(item.summary, Math.max(0, 500 - prefix.length - (item.url?.length ?? 0) - 2));
  if (item.url && item.url.length + prefix.length + 2 > 500) return item.url;
  return [prefix, body, item.url].filter(Boolean).join(' ');
}

export class WeChatInbox {
  readonly #store: EncryptedJsonStore<State>;
  readonly #now: () => number;
  readonly #maxItems: number;
  readonly #candidateTtl: number;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(path: string, vault: VaultKeyProvider, private readonly options: Options = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxItems = z.number().int().min(1).max(itemLimit).parse(options.maxItems ?? itemLimit);
    this.#candidateTtl = z.number().int().min(1).max(candidateTtlMs).parse(options.candidateTtlMs ?? candidateTtlMs);
    this.#store = new EncryptedJsonStore({ path, vault, schema: stateSchema, defaultValue: () => ({ version: 1, owners: [] }) });
  }

  async #readOwner(binding: string): Promise<Owner | undefined> {
    wechatInboxIdSchema.parse(binding);
    await this.#writes;
    return (await this.#store.load()).owners.find(owner => owner.binding === binding);
  }

  #update<T>(binding: string, apply: (owner: Owner) => T, guard?: Guard): Promise<T> {
    wechatInboxIdSchema.parse(binding);
    const write = this.#writes.then(async () => {
      await guard?.();
      const state = await this.#store.load();
      const previous = JSON.stringify(state);
      let owner = state.owners.find(entry => entry.binding === binding);
      if (!owner) {
        if (state.owners.length >= ownerLimit) throw Error('wechat.inboxOwnerLimit');
        owner = { binding, migrated: false, exportGrant: null, items: [], candidate: null, listing: [], receipts: [] };
        state.owners.push(owner);
      }
      for (const entry of state.owners) {
        if (entry.candidate && entry.candidate.expiresAt <= this.#now()) entry.candidate = null;
      }
      const result = apply(owner);
      if (JSON.stringify(state) !== previous) {
        await guard?.();
        await this.#store.save(state);
      }
      return result;
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #export(binding: string, item: WeChatInboxItem, guard?: Guard): Promise<void> {
    const onSaved = this.options.onSaved;
    if (!onSaved) return;
    try {
      await guard?.();
      await onSaved(binding, item);
    } catch {
      // The encrypted save already committed. The export host reports failure separately.
    }
  }

  async remember(binding: string, eventId: string, item: WeChatInboxInput, guard?: Guard): Promise<void> {
    wechatInboxIdSchema.parse(eventId);
    const input = wechatInboxInputSchema.parse(item);
    await this.#update(binding, owner => {
      const current = owner.candidate;
      if (current?.eventId === eventId || (current && current.item.at > input.at)) return;
      owner.candidate = { eventId, item: input, expiresAt: this.#now() + this.#candidateTtl };
    }, guard);
  }

  async dismissArticleCandidate(binding: string, guard?: Guard): Promise<void> {
    await this.#update(binding, owner => { if (owner.candidate?.item.kind === 'article') owner.candidate = null; }, guard);
  }

  async save(binding: string, item?: WeChatInboxInput, guard?: Guard): Promise<WeChatInboxItem | null> {
    const input = item === undefined ? undefined : wechatInboxInputSchema.parse(item);
    const result = await this.#update(binding, owner => {
      const candidate = input ?? owner.candidate?.item;
      return candidate ? storeItem(owner, candidate, this.#maxItems) : null;
    }, guard);
    if (result?.created) await this.#export(binding, result.item, guard);
    return result?.item ?? null;
  }

  async list(binding: string, query = ''): Promise<WeChatInboxItem[]> {
    return matches((await this.#readOwner(binding))?.items ?? [], wechatInboxQuerySchema.parse(query));
  }

  async hasCandidate(binding: string): Promise<boolean> {
    const candidate = (await this.#readOwner(binding))?.candidate;
    return candidate !== null && candidate !== undefined && candidate.expiresAt > this.#now();
  }

  async remove(binding: string, id: string, guard?: Guard): Promise<void> {
    wechatInboxIdSchema.parse(id);
    await this.#update(binding, owner => {
      owner.items = owner.items.filter(item => item.id !== id);
      if (owner.candidate && hash([binding, deduplicationKey(owner.candidate.item)]) === id) owner.candidate = null;
      // Retain replay protection while removing titles, summaries and URLs from cached replies.
      owner.receipts = owner.receipts.map(receipt => ({ ...receipt, reply: '收件箱已更新，请重新查看。' }));
    }, guard);
  }

  async migrate(binding: string, legacyItems: WeChatInboxInput[], guard?: Guard): Promise<void> {
    const items = z.array(wechatInboxInputSchema).max(itemLimit).parse(legacyItems);
    await this.#update(binding, owner => {
      if (owner.migrated) return;
      const combined: Owner = { ...owner, items: [] };
      for (const item of items) storeItem(combined, item, itemLimit);
      const old = new Map(combined.items.map(item => [item.id, item]));
      for (const item of owner.items) {
        item.legacyId ??= old.get(item.id)?.legacyId;
        old.delete(item.id);
      }
      owner.items = [...owner.items, ...old.values()].slice(0, itemLimit);
      owner.migrated = true;
    }, guard);
  }

  async exportGrant(binding: string): Promise<string | null> {
    return (await this.#readOwner(binding))?.exportGrant ?? null;
  }

  async setExportGrant(binding: string, grantId: string | null, guard?: Guard): Promise<void> {
    const grant = z.string().uuid().nullable().parse(grantId);
    await this.#update(binding, owner => { owner.exportGrant = grant; }, guard);
  }

  async handle(binding: string, eventId: string, text: string, quoted?: WeChatInboxInput, guard?: Guard): Promise<string | null> {
    const action = command(text);
    if (!action) return null;
    wechatInboxIdSchema.parse(eventId);
    const input = quoted === undefined ? undefined : wechatInboxInputSchema.parse(quoted);
    const fingerprint = hash([text, input && { ...input, at: 0 }]);
    const result = await this.#update(binding, owner => {
      const receipt = owner.receipts.find(entry => entry.eventId === eventId);
      if (receipt) {
        if (receipt.command !== fingerprint) throw Error('wechat.inboxCommandConflict');
        return { reply: receipt.reply };
      }
      const output = this.#reply(owner, action, input);
      owner.receipts.push({ eventId, command: fingerprint, reply: output.reply });
      if (owner.receipts.length > receiptLimit) owner.receipts.shift();
      return output;
    }, guard);
    if (result.saved) await this.#export(binding, result.saved, guard);
    return result.reply;
  }

  #reply(owner: Owner, action: Action, quoted: WeChatInboxInput | undefined): { reply: string; saved?: WeChatInboxItem } {
    if (action.kind === 'save') {
      const input = quoted ?? owner.candidate?.item;
      if (!input) return { reply: '现在没有待存的内容。可以转发一条消息，或引用要存的消息回复「存」。' };
      const result = storeItem(owner, input, this.#maxItems);
      const title = line(result.item.title, 100);
      return result.created
        ? { reply: `已存进收件箱：《${title}》。回「收件箱」查看。`, saved: result.item }
        : { reply: `《${title}》已经在收件箱里。` };
    }
    if (action.kind === 'open') {
      const id = owner.listing[action.rank - 1];
      const item = id === undefined ? undefined : owner.items.find(entry => entry.id === id);
      return { reply: item ? describe(item) : '没有这个编号，回「收件箱」刷新列表。' };
    }
    const articles = owner.items.filter(item => item.kind === 'article');
    if (action.kind === 'legacyOpen') {
      const found = articles.filter(item => item.id.startsWith(action.id) || item.legacyId?.startsWith(action.id));
      const reply = found.length === 1 ? describe(found[0]!) : found.length === 0
        ? '没有找到这个编号的收藏。' : '编号匹配多篇，请发送收藏列表上的完整编号。';
      return { reply };
    }
    if (action.kind === 'legacyList') {
      const rows = articles.slice((action.page - 1) * pageSize, action.page * pageSize);
      if (!rows.length) return { reply: '这页没有收藏的公众号文章。' };
      const summary = rows.map(item => `${(item.legacyId ?? item.id).slice(0, 12)} ${line(item.title, 40)}`).join(' ｜ ');
      return { reply: `收藏列表（${action.page}/${Math.ceil(articles.length / pageSize)}） ${summary}。回「打开收藏 编号」查看。` };
    }
    const rows = matches(owner.items, action.query).slice(0, pageSize);
    owner.listing = rows.map(item => item.id);
    if (!rows.length) return { reply: action.query ? '收件箱里没有找到匹配的内容。' : '收件箱是空的。' };
    const summary = rows.map((item, index) => `${index + 1}. ${line(item.title, 45)}`).join(' ｜ ');
    return { reply: `收件箱 ${summary}。回「收件箱 编号」查看。` };
  }
}
