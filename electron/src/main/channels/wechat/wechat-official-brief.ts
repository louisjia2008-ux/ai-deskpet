import type { WeChatOfficialBriefSettings } from '../../../shared/wechat-digests';
import { normalizeWeChatArticleUrl } from './wechat-article-reader';
import { wechatArticleKey } from './wechat-articles';
import type { WeChatArticleCard } from './wechat-article-state';
import { WeChatDigestFailure } from './wechat-digest-scheduler';
import type { WeChatDigestContext, WeChatDigestEntry, WeChatDigestOutput } from './wechat-digest-scheduler';
import { packWeChatDigestLines } from './wechat-group-digest';

export type WeChatOfficialArticle = WeChatArticleCard & { at: number };
export interface WeChatOfficialBriefHost {
  settings: WeChatOfficialBriefSettings;
  read(context: WeChatDigestContext): Promise<{ articles: WeChatOfficialArticle[]; truncated: boolean }>;
  summarize(article: WeChatOfficialArticle, context: WeChatDigestContext): Promise<WeChatDigestEntry | null>;
  memoryHints(): readonly string[];
  seenUrls?: readonly string[];
}

const DAY = 86_400_000;
const MAX_PUSHES = 80;
const text = (value: string, limit: number): string => value.replace(/[\p{C}\p{Z}]+/gu, ' ').trim()
  .slice(0, limit).replace(/[\uD800-\uDFFF]$/u, '').trimEnd();
const normalized = (value: string): string => value.normalize('NFKC').toLowerCase().trim();

function words(values: readonly string[], limit: number): string[] {
  return [...new Set(values.slice(0, limit).map(value => normalized(text(value, 80))).filter(Boolean))];
}

function key(url: string): string | null {
  const canonical = normalizeWeChatArticleUrl(url);
  return canonical && wechatArticleKey(canonical);
}

export async function generateWeChatOfficialBrief(host: WeChatOfficialBriefHost,
  context: WeChatDigestContext): Promise<WeChatDigestOutput> {
  if (!host.settings.enabled) return { entries: [], messages: [] };
  await context.assertCurrent();
  let source: Awaited<ReturnType<WeChatOfficialBriefHost['read']>>;
  try { source = await host.read(context); }
  catch {
    await context.assertCurrent();
    throw new WeChatDigestFailure('read');
  }
  await context.assertCurrent();

  // Local ranking uses preferences without attaching them to article requests.
  const keywords = words(host.settings.keywords, 16);
  const hints = words(host.memoryHints().slice(0, 24).flatMap(value => value.split(/[、，,。；;:：]/u)), 24);
  const count = (values: string[], title: string): number => values.filter(value => title.includes(value)).length;
  const seen = new Set((host.seenUrls ?? []).slice(0, 240).map(key).filter((value): value is string => Boolean(value)));
  const unique = new Map<string, WeChatOfficialArticle>();
  const failures: ('read' | 'model')[] = [];
  for (const article of source.articles.slice(0, MAX_PUSHES)) {
    const url = normalizeWeChatArticleUrl(article.url);
    const title = text(article.title, 160);
    if (!url || !title || !Number.isSafeInteger(article.at)) { failures.push('read'); continue; }
    if (article.at <= context.dueAt - DAY || article.at > context.dueAt) continue;
    const id = wechatArticleKey(url);
    if (seen.has(id) || (unique.get(id)?.at ?? -1) >= article.at) continue;
    unique.set(id, { url, title, account: text(article.account, 80), at: article.at });
  }
  const ranked = [...unique.values()].map(article => {
    const title = normalized(article.title + ' ' + article.account);
    return { article, explicit: count(keywords, title), remembered: count(hints, title) };
  }).sort((a, b) => b.explicit - a.explicit || b.remembered - a.remembered || b.article.at - a.article.at
    || (a.article.url < b.article.url ? -1 : Number(a.article.url > b.article.url)));

  const entries: WeChatDigestEntry[] = [];
  for (const { article } of ranked.slice(0, host.settings.limit)) {
    await context.assertCurrent();
    let result: WeChatDigestEntry | null;
    try { result = await host.summarize(article, context); }
    catch {
      await context.assertCurrent();
      failures.push('model');
      continue;
    }
    await context.assertCurrent();
    if (!result) { failures.push('read'); continue; }
    const url = normalizeWeChatArticleUrl(result.url ?? article.url);
    const title = text(result.title, 160), summary = text(result.summary, 330), detail = text(result.detail, 950);
    if (!url || !title || !summary || !detail) { failures.push('model'); continue; }
    const id = wechatArticleKey(url);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ title, summary, detail, url });
  }
  const messages = entries.length ? packWeChatDigestLines([
    '公众号简报',
    ...entries.map((entry, index) => `${index + 1}. ${text(entry.title, 100)}：${entry.summary}`),
    ...(source.truncated ? ['只整理了本机可见的一部分推送。'] : []),
    '回「收藏 1」「展开 1」或「问 1 你的问题」。',
  ]) : [];
  return { entries, messages, ...(failures.length ? { issue: failures.includes('read') ? 'read' : 'model',
    failures: Math.min(32, failures.length) } : {}) };
}
