import { createHash } from 'node:crypto';
import type { MemoryItem } from '../../shared';
import type { ContextDestination } from './chat-context-policy';
import type { MemoryRecallMode, MemoryRecallReason, MemoryRecallUnavailableReason } from '../../shared/memory-recall';

/** Host-generated hints, never an authorization to use a memory. No text or
 * vectors cross into the renderer or a provider through this structure. */
export interface MemoryRecallHints {
  sessionId: string;
  destination: ContextDestination;
  queryDigest: string;
  corpusDigest: string;
  mode: MemoryRecallMode;
  reason: MemoryRecallReason;
  unavailableReason?: MemoryRecallUnavailableReason;
  consideredCount: number;
  eligibleCount: number;
  matches: ReadonlyArray<{ id: string; revision: number; digest: string; similarity: number }>;
}
export const recallTextDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const memoryRecallDigest = (memory: MemoryItem): string => {
  const meta = memory.contextMetadata;
  return recallTextDigest(JSON.stringify([memory.text, memory.tags, meta ? {
    version: meta.version, trust: meta.trust, origin: meta.origin, revision: meta.revision,
    scope: meta.scope, privacy: meta.privacy, sourceReferences: meta.sourceReferences,
    expiresAt: meta.expiresAt, overridesMemory: meta.overridesMemory, identity: meta.identity,
    reviewReason: meta.reviewReason, qqAllowed: meta.qqAllowed, telegramAllowed: meta.telegramAllowed, wechatAllowed: meta.wechatAllowed,
  } : null]));
};
export const memoryRecallCorpusDigest = (memories: readonly MemoryItem[]): string => recallTextDigest(JSON.stringify(
  memories.map(memory => [memory.id, memoryRecallDigest(memory)]).sort(([a], [b]) => a!.localeCompare(b!)),
));
export const MIN_MEMORY_SIMILARITY = 0.78;

// Relevance is separate from authority. Callers must first apply the existing
// scope, privacy, expiry and revision projection; this selector grants nothing.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const normalize = (text: string): string => text.normalize('NFKC').toLocaleLowerCase();
const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'do', 'does', 'for', 'from', 'give', 'have',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'tell', 'that', 'the', 'their', 'them', 'there',
  'these', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your',
  'chat', 'memory', 'remember', 'saved', 'preference', 'preferences', 'like', 'likes', 'prefer', 'prefers', 'name',
  '的', '了', '吗', '呢', '吧', '啊', '我', '你', '他', '她', '它', '是', '有', '在', '和', '与', '或', '也', '都',
  '我们', '你们', '他们', '什么', '哪些', '哪个', '怎样', '怎么', '如何', '是否', '可以', '一下', '告诉', '帮我',
  '请', '请问', '记得', '记住', '记忆', '之前', '现在', '今天', '昨天', '最近', '最新', '当前', '喜欢', '偏好', '名字',
  '爱', '喝', '哪', '种', '想', '要', '知', '知道', '了解',
]);
// Most single Han characters are grammatical noise, but these are useful
// standalone subjects and also match compound words such as 茉莉花茶.
const singleSubjects = new Set(['茶', '书', '猫', '狗', '饭']);
const terms = (text: string): string[] => {
  const result: string[] = []; let fragments: string[] = [];
  const flush = (): void => {
    // ICU can split a useful Chinese noun, e.g. 饮品, into single characters.
    // Combine only adjacent content fragments, never across grammatical words.
    for (let index = 1; index < fragments.length; index += 1) result.push(fragments[index - 1]! + fragments[index]!);
    fragments = [];
  };
  for (const part of segmenter.segment(normalize(text))) {
    if (!part.isWordLike || stopWords.has(part.segment)) { flush(); continue; }
    if (/^\p{Script=Han}$/u.test(part.segment)) {
      fragments.push(part.segment);
      if (singleSubjects.has(part.segment)) result.push(part.segment);
    } else {
      flush(); if (part.segment.length >= 2) result.push(part.segment);
    }
  }
  flush(); return [...new Set(result)].slice(0, 48);
};
const personalContext = (query: string): boolean => /我的|我(?:叫|是谁|喜欢|爱喝|偏好|习惯|住|正在|最近在)|适合我|关于我|根据我|按我|\bmy\b|\babout me\b|\bfor me\b|\bi (?:like|prefer|drink|live|am|was)\b/u.test(query);
const publicLookup = (query: string): boolean => /新闻|天气|官网|官方网站|公开资料|上网|联网|搜索|\b(?:news|weather|official|website|search|browse)\b/u.test(query);
const preferenceFact = (text: string): boolean => /喜欢|偏好|喜好|爱好|偏爱|爱喝|习惯|口味|\b(?:likes?|prefers?|preferences?|favourite|favorite)\b/u.test(text);
const userIdentityFact = (text: string): boolean => /(?:我|用户)(?:的)?(?:名字|姓名|昵称)|我叫|我是|称呼我|\b(?:my name|user'?s? name|call me|i am)\b/u.test(text);
const assistantIdentityFact = (text: string): boolean => /你叫|你的(?:名字|姓名|昵称)|桌宠(?:的)?(?:名字|昵称)|\b(?:your name|call you)\b/u.test(text);

/** A small standing preference is useful even when a new question has different
 * vocabulary. This is deliberately not fact extraction: preserve the exact
 * approved memory, reject qualified/quoted/temporary material and let the
 * current user request override it. Semantic recall below handles other topics. */
export const stableCommunicationPreference = (memory: MemoryItem): boolean => {
  const text = normalize(memory.text).trim();
  if (text.length > 320 || /[\r\n“”"‘’]|(?:今天|这次|暂时|如果|除非|假设|例如|以前|曾经|不再|\b(?:today|this time|temporarily|if|unless|example|used to|no longer)\b)/u.test(text)) return false;
  const owner = /^(?:我(?:偏好|喜欢|希望|习惯|更喜欢)|我的(?:回答|交流|表达|沟通|语言|格式)偏好|(?:i (?:prefer|like|want)|my (?:response|communication|language|format) preference))/u.test(text);
  const response = /回答|回复|解释|交流|沟通|表达|\b(?:answers?|replies|responses?|explanations?|communication)\b/u.test(text);
  const style = /简洁|简短|直接|详细|结论|重点|条目|分点|表格|中文|英文|双语|语气|正式|口语|\b(?:brief|concise|short|direct|detailed|conclusion|bullet|table|chinese|english|bilingual|tone|formal|casual)\b/u.test(text);
  return owner && response && style;
};

/** Public research must not gain unrelated personal facts merely because an
 * embedding is nearby. Keep the existing disclosure-oriented recall boundary. */
export const memoryRelevantForPublicLookup = (memory: MemoryItem, query: string): boolean => {
  const normalizedQuery = normalize(query), text = normalize(memory.text);
  return !publicLookup(normalizedQuery) || personalContext(normalizedQuery)
    || !(preferenceFact(text) || userIdentityFact(text) || assistantIdentityFact(text) || stableCommunicationPreference(memory));
};
const lexicalMatcher = (term: string): ((text: string) => boolean) => {
  if (/\p{Script=Han}/u.test(term)) return (text) => text.includes(term);
  // AI must not match "daily", nor tea match "steak". Underscores and hyphens
  // remain useful boundaries for entity names and imported identifiers.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const boundary = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
  return (text) => boundary.test(text);
};

const personalRecallScore = (query: string, text: string): number => {
  if (/你是谁|你叫什么|你的(?:名字|昵称)|\b(?:who are you|your name|call you)\b/u.test(query) && assistantIdentityFact(text)) return 5;
  if (/我是谁|我叫什么|我的(?:名字|姓名|昵称)|怎么称呼我|\b(?:who am i|my name|call me)\b/u.test(query) && userIdentityFact(text)) return 5;
  if (/(?:我(?:有)?什么(?:偏好|爱好)|我的(?:偏好|爱好)(?:是什么|有哪些)?|我(?:都)?喜欢什么)(?:吗)?[?？。!！\s]*$|\b(?:what do i (?:like|prefer)|my preferences|my interests)[?？.!！\s]*$/u.test(query) && preferenceFact(text)) return 4;
  if (/(?:记得|了解)(?:关于)?我(?:的)?(?:什么|哪些)(?:事|事情|信息|资料)?[?？。!！\s]*$|\bwhat do you (?:remember|know) about me\b/u.test(query)) return 2;
  if (!personalContext(query)) return 0;
  // Small, inspectable topic aliases support common personal questions without
  // pretending to be a semantic index or inferring an unstated personal fact.
  if (/饮品|饮料|喝什么|\b(?:beverage|drink)\b/u.test(query)
    && /饮品|饮料|茶|咖啡|牛奶|果汁|\b(?:tea|coffee|milk|juice|beverage|drink)\b/u.test(text)) return 3;
  if (/茶|\btea\b/u.test(query) && /茶|\btea\b/u.test(text)) return 3;
  if (/咖啡|\bcoffee\b/u.test(query) && /咖啡|\bcoffee\b/u.test(text)) return 3;
  return 0;
};

/** Rank only related, already-authorized memories. Recency breaks ties; it can
 * never make an unrelated memory eligible, nor establish when an event happened. */
export const rankRelevantMemories = (memories: readonly MemoryItem[], query: string, options?: {
  hints?: MemoryRecallHints;
  sessionId: string;
  destination: ContextDestination;
  includeStandingPreferences?: boolean;
  /** A chat turn carries the deep profile; a search the owner typed shows only what matches. */
  includeProfile?: boolean;
}): MemoryItem[] => {
  const normalizedQuery = normalize(query);
  const matchers = terms(query).map(lexicalMatcher);
  const explicitlyPersonal = personalContext(normalizedQuery);
  const publicOnly = publicLookup(normalizedQuery) && !explicitlyPersonal;
  const hints = options?.hints;
  const semantic = new Map(hints && hints.sessionId === options.sessionId && hints.destination === options.destination
    && hints.queryDigest === recallTextDigest(query) ? hints.matches.map(match => [match.id, match]) : []);
  const standing = new Set(options?.includeStandingPreferences !== false && !publicOnly && terms(query).length > 0
    ? memories.filter(stableCommunicationPreference).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 2).map(memory => memory.id)
    : []);
  return memories.map((memory) => {
    const text = normalize(memory.text);
    const identity = memory.contextMetadata?.identity;
    const searchable = normalize([memory.text, ...memory.tags,
      ...(identity ? [identity.entity, identity.key] : [])].join(' '));
    // A general news/weather lookup does not need a user's unrelated preferences
    // or name, even when a common topical word happens to overlap.
    if (!memoryRelevantForPublicLookup(memory, query)) return { memory, score: 0 };
    const lexical = matchers.reduce((score, matches) => score + (matches(searchable) ? 1 : 0), 0);
    const hint = semantic.get(memory.id);
    const similarity = hint && hint.revision === memory.contextMetadata?.revision && hint.digest === memoryRecallDigest(memory)
      && Number.isFinite(hint.similarity) && hint.similarity >= MIN_MEMORY_SIMILARITY && hint.similarity <= 1 ? hint.similarity : 0;
    // The standing profile accompanies every personal turn, behind anything the question actually matches.
    const profile = options?.includeProfile && memory.contextMetadata?.layer === 'deep' && !publicOnly ? 0.5 : 0;
    return { memory, score: lexical + personalRecallScore(normalizedQuery, text) + (standing.has(memory.id) ? 2 : 0) + similarity * 3 + profile };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || left.memory.id.localeCompare(right.memory.id))
    .map(({ memory }) => memory);
};
