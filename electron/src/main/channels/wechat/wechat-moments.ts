import { providerFailureCode } from '../../../shared/provider-errors';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** A Moment is never posted without the owner's reply to its preview. */
const draftSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  text: z.string().min(1).max(600),
  imageIdea: z.string().min(1).max(300),
  imageAssetId: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.number().int().nonnegative(),
  previewedAt: z.number().int().nonnegative().optional(),
  status: z.enum(['awaiting', 'posting', 'posted', 'uncertain', 'discarded', 'expired', 'failed']),
  visibility: z.enum(['all', 'private']).optional(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  plan: z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), at: z.number().int().nonnegative() }).nullable(),
  draft: draftSchema.nullable(),
  posted: z.array(z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/u), text: z.string().max(600), at: z.number().int().nonnegative() })).max(30),
  hintsShown: z.boolean().default(false),
  lastPhrases: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type WeChatMomentsState = z.infer<typeof stateSchema>;
export type WeChatMomentDraft = z.infer<typeof draftSchema>;
export const WECHAT_MOMENT_WINDOW_FAILURES = ['busy', 'paused', 'window_error'] as const;
type WindowFailure = typeof WECHAT_MOMENT_WINDOW_FAILURES[number];
export type MomentPostOutcome = 'posted' | 'uncertain' | 'retry' | 'conflict' | 'invalid_payload' | WindowFailure;
export type MomentPreviewOutcome = 'sent' | 'retry' | 'uncertain' | WindowFailure;
const windowFailures = {
  busy: { code: 'wechat.momentWindowBusy', text: '微信窗口还被其他操作占着。' },
  paused: { code: 'wechat.momentListenerPaused', text: '微信监听已暂停。' },
  window_error: { code: 'wechat.momentWindowError', text: '打开微信窗口时出了错。' },
} as const;
const windowFailure = (outcome: MomentPostOutcome | MomentPreviewOutcome) =>
  WECHAT_MOMENT_WINDOW_FAILURES.find(reason => reason === outcome);

export interface WeChatMomentsHost {
  read(): Promise<string | null>;
  write(value: WeChatMomentsState): Promise<void>;
  /** Daily drafts only while the owner has turned them on. */
  enabled(): Promise<boolean>;
  now(): number;
  timezone(): string;
  compose(input: { date: string; recent: string[]; shorten?: string }): Promise<{ text: string; imageIdea: string }>;
  previewIntro?(input: { text: string; imageIdea: string }): Promise<string>;
  rewrite?(input: { text: string; imageIdea: string; instruction: string }): Promise<{ text: string; imageIdea: string }>;
  draw(imageIdea: string): Promise<{ assetId: string }>;
  image(assetId: string): Promise<{ full: Buffer; preview: Buffer }>;
  preview(input: { id: string; text: string; image: Buffer }): Promise<MomentPreviewOutcome>;
  post(input: { id: string; text: string; visibility: 'all' | 'private'; images: Buffer[] }): Promise<MomentPostOutcome>;
  notify(text: string): Promise<void>;
  record(text: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

export const WECHAT_MOMENT_TTL_MS = 24 * 3_600_000;
export const WECHAT_MOMENT_TEXT_LIMIT = 300;
const MOMENT_REPLY_WINDOW_MS = 2 * 3_600_000;
export type MomentAnswer = 'all' | 'private' | 'discard' | 'rewrite' | 'clarify' | 'unrelated';
export type MomentAnswerContext = 'before-preview' | 'later' | 'next';
/** Deliberately closed consent grammar: questions, negatives and substrings never grant permission. */
export const classifyMomentAnswer = (raw: string, next = false): MomentAnswer => {
  const text = raw.normalize('NFKC').trim().replace(/[!。.！]+$/u, '').trim();
  const draftTopic = /朋友圈|草稿/u.test(text);
  if (/^(?:(?:发|朋友圈)[,\s]*)?(?:只给我看|仅自己可见|别让别人看到|只给自己看|自己可见|私密)$/u.test(text)
    && (next || /发|朋友圈|可见/u.test(text))) return 'private';
  if (/^(?:发|发吧|发布|发出去|可以发|就这样发|嗯,?发|好,?发吧|发朋友圈吧?|发这条吧?|(?:这条)?朋友圈发吧?|post)$/iu.test(text)
    || (next && /^(?:好|好的|好呀|可以|行|嗯)$/u.test(text))) return 'all';
  if (/^(?:不发(?:了)?|别发(?:了)?|不要发|先不发|取消(?:这条)?(?:朋友圈|草稿))(?:吧)?$/u.test(text)
    || (next && /^(?:不要|算了|取消)(?:吧)?$/u.test(text))) return 'discard';
  if ((next || draftTopic) && /^(?:把.{1,200}改成.{1,200}|(?:朋友圈|草稿)?(?:改成.{1,200}|(?:再)?短一点|长一点|口语一点)|重写.{0,100})$/u.test(text)) return 'rewrite';
  const ambiguousPost = /^(?:(?:这条)?(?:发什么|发了吗|发了没|发不发|发给谁|发之前)|(?:要不要|能不能|可不可以|怎么|什么时候)发)/u.test(text);
  return draftTopic || /可见/u.test(text) || ambiguousPost ? 'clarify' : 'unrelated';
};
const phrases = {
  preview: ['我想发这条朋友圈，配图也挑好了，帮我看看好不好？', '刚想了条朋友圈，想先给你看看呀。', '这条朋友圈我挺喜欢的，你看这样行不行？'],
  posting: ['好呀，我去发，发好了回来告诉你。', '嗯，这就去发，等我一下呀。', '那我去发啦，发完跟你说。'],
  posted: ['发好啦，朋友圈里能看到了。', '朋友圈发出去啦，来跟你报个信。', '好啦，已经发到朋友圈了。'],
  failed: ['这次没发出去，草稿已经作废。想发的话我们重新来。', '没能发成呀，草稿已经作废了。'],
  uncertain: ['我没能确认，可能已经发了。请在手机上看一眼，别重复发呀。', '这次可能已经发出去了，但我没能确认。请在手机上看一眼，先别重复发。'],
  discard: ['好呀，那这条就不发了。', '嗯，听你的，这条不发啦。'],
} as const;
const hint = '可以跟我说“发 / 只给我看 / 不发 / 改成……”。';
const empty = (): WeChatMomentsState => ({ version: 1, plan: null, draft: null, posted: [], hintsShown: false, lastPhrases: {} });

const localDate = (epoch: number, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(epoch);

/** A random minute between 10:00 and 22:00 local time of that date. */
function planFor(now: number, timezone: string): { date: string; at: number } {
  const date = localDate(now, timezone);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const minute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, minute: '2-digit' }).format(now));
  const startOfDay = now - (hour * 60 + minute) * 60_000;
  const offset = (10 * 60 + Math.floor(Math.random() * 12 * 60)) * 60_000;
  return { date, at: startOfDay + offset };
}

export function momentText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').split('\n').map(line => line.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim())
    .join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

/** Plans, previews and (after the owner's reply) posts at most one Moment a day. */
export class WeChatMoments {
  #busy: Promise<unknown> | null = null;
  #lastError: string | null = null;
  #lastSuccessAt: string | null = null;
  #lastFailureAt: string | null = null;
  constructor(private readonly host: WeChatMomentsHost) {}
  get lastError(): string | null { return this.#lastError; }
  attempts() { return { lastSuccessAt: this.#lastSuccessAt, lastFailureAt: this.#lastFailureAt }; }
  failed(code: string): void { this.#lastError = code; this.#lastFailureAt = new Date(this.host.now()).toISOString(); }

  #phrase(state: WeChatMomentsState, kind: keyof typeof phrases): string {
    const choices = phrases[kind], previous = state.lastPhrases[kind];
    const available = choices.map((_, index) => index).filter(index => index !== previous);
    const index = available[Math.floor(Math.random() * available.length)]!;
    state.lastPhrases[kind] = index;
    return choices[index]!;
  }

  async #preview(state: WeChatMomentsState, draft: WeChatMomentDraft): Promise<MomentPreviewOutcome> {
    let intro = '';
    try { intro = momentText(await this.host.previewIntro?.(draft) ?? '').replace(/\n/gu, ' '); }
    catch (error) { this.failed(providerFailureCode(error, 'wechat.momentPreviewFallback')); }
    if (!intro || [...intro].length > 100) intro = this.#phrase(state, 'preview');
    // The original draft is not silently truncated. The listener's text path accepts 500 printable characters.
    const notice = `${intro} ${draft.text.replace(/\n+/gu, ' / ')}${state.hintsShown ? '' : ` ${hint}`}`;
    if ([...notice].length > 500) throw new Error('wechat.momentInvalid');
    await this.host.write(state);
    const { preview } = await this.host.image(draft.imageAssetId);
    const sent = await this.host.preview({ id: draft.id, text: notice, image: preview });
    if (sent === 'sent') {
      state.hintsShown = true;
      draft.previewedAt = this.host.now();
      await this.host.write(state);
    } else {
      const reason = windowFailure(sent);
      if (reason) this.failed(windowFailures[reason].code);
    }
    return sent;
  }

  async state(): Promise<WeChatMomentsState> {
    const raw = await this.host.read();
    return raw === null ? empty() : stateSchema.parse(JSON.parse(raw));
  }

  /** Draws the picture for a draft and sends the owner its preview. */
  async propose(input: { text: string; imageIdea: string }): Promise<{ status: 'preview_sent' | 'preview_unconfirmed' | 'busy' | 'posting'; id: string | null; reason?: string }> {
    const text = momentText(input.text), imageIdea = momentText(input.imageIdea).replace(/\n/gu, ' ');
    if (!text || [...text].length > WECHAT_MOMENT_TEXT_LIMIT || !imageIdea || [...imageIdea].length > 300) throw new Error('wechat.momentInvalid');
    const current = await this.state();
    if (current.draft?.status === 'posting') return { status: 'posting', id: null };
    if (this.#busy) return { status: 'busy', id: null };
    const work = (async () => {
      const { assetId } = await this.host.draw(imageIdea);
      const id = createHash('sha256').update(`deskpet/wechat/moment/v1\0${randomUUID()}`).digest('hex');
      const draft: WeChatMomentDraft = { id, text, imageIdea, imageAssetId: assetId, createdAt: this.host.now(), status: 'awaiting' };
      const state = await this.state();
      if (state.draft?.status === 'posting') return { status: 'posting' as const, id: null };
      if (state.draft?.status === 'awaiting') state.draft.status = 'discarded';
      await this.host.write({ ...state, draft });
      const sent = await this.#preview({ ...state, draft }, draft);
      await this.host.record(`（朋友圈草稿）${text}\n配图：${imageIdea}`);
      const reason = windowFailure(sent);
      return { status: sent === 'sent' ? 'preview_sent' as const : 'preview_unconfirmed' as const, id,
        ...(reason ? { reason: windowFailures[reason].text } : {}) };
    })();
    this.#busy = work;
    try { return await work; } finally { this.#busy = null; }
  }

  /** The owner's reply to a pending preview, or null when the text is not one. */
  async answer(text: string, context: (draftId: string) => Promise<MomentAnswerContext>): Promise<string | null> {
    if (this.#busy || classifyMomentAnswer(text, true) === 'unrelated') return null;
    const work = this.#answer(text, context);
    this.#busy = work;
    try { return await work; } finally { this.#busy = null; }
  }

  async #answer(text: string, context: (draftId: string) => Promise<MomentAnswerContext>): Promise<string | null> {
    const trimmed = text.trim();
    const state = await this.state();
    const draft = state.draft;
    if (!draft || draft.status !== 'awaiting') return null;
    if (draft.previewedAt === undefined) return this.#unconfirmedPreview(state, draft, trimmed);
    const adjacency = await context(draft.id);
    if (adjacency === 'before-preview') return null;
    const elapsed = this.host.now() - draft.previewedAt;
    const answer = classifyMomentAnswer(trimmed, adjacency === 'next' && elapsed >= 0 && elapsed <= MOMENT_REPLY_WINDOW_MS);
    if (answer === 'unrelated') return null;
    if (elapsed > WECHAT_MOMENT_TTL_MS) {
      draft.status = 'expired';
      await this.host.write(state);
      return '这条朋友圈草稿已经超过一天，作废了。想发的话再跟我说一次。';
    }
    if (answer === 'clarify') return `我还没发呢，你是想发这条，还是再改改呀？${hint}`;
    if (answer === 'rewrite') {
      const target = /^把(.+?)改成/u.exec(trimmed)?.[1]?.trim();
      if (target && !/朋友圈|草稿|^(?:这句(?:话)?|开头|结尾|标题|正文)$/u.test(target) && !draft.text.includes(target)) return null;
      try {
        if (!this.host.rewrite) throw new Error('wechat.momentRewriteUnavailable');
        const revised = await this.host.rewrite({ text: draft.text, imageIdea: draft.imageIdea, instruction: trimmed });
        const value = momentText(revised.text);
        if (!value || [...value].length > WECHAT_MOMENT_TEXT_LIMIT) throw new Error('wechat.momentInvalid');
        const next = { ...draft, id: createHash('sha256').update(randomUUID()).digest('hex'), text: value, createdAt: this.host.now(), previewedAt: undefined };
        state.draft = next;
        const sent = await this.#preview(state, next);
        await this.host.record(`（修改后的朋友圈草稿）${value}`);
        const reason = windowFailure(sent);
        if (reason) return `改好啦。${windowFailures[reason].text}新的预览还没确认完整送到，我先不发。`;
        return sent === 'sent' ? '改好啦，新的草稿给你看了，等你点头再发。' : '改好了，但新的预览没确认送达，先别发，等我再给你看。';
      } catch (error) {
        this.failed(providerFailureCode(error, 'wechat.momentRewriteFailed'));
        return '这次没改好，旧草稿还留着，我没有发布。我们再试一下好不好？';
      }
    }
    if (answer === 'discard') {
      draft.status = 'discarded';
      const notice = this.#phrase(state, 'discard');
      await this.host.write(state);
      return notice;
    }
    draft.status = 'posting';
    draft.visibility = answer === 'private' ? 'private' : 'all';
    const notice = this.#phrase(state, 'posting') + (draft.visibility === 'private' ? ' 这次仅自己可见，只给你看。' : '');
    await this.host.write(state);
    void this.#publish(draft.id).catch(() => { this.failed('wechat.momentPublishUnconfirmed'); });
    return notice;
  }

  /** The owner answered a preview whose delivery was never confirmed: they may not have seen the picture,
   * so an explicit 「发」 resends the same draft's preview instead of posting or drawing a new one. */
  async #unconfirmedPreview(state: WeChatMomentsState, draft: WeChatMomentDraft, text: string): Promise<string | null> {
    const answer = classifyMomentAnswer(text);
    if (answer !== 'all' && answer !== 'private' && answer !== 'discard') return null;
    if (this.host.now() - draft.createdAt > WECHAT_MOMENT_TTL_MS) {
      draft.status = 'expired';
      await this.host.write(state);
      return '这条朋友圈草稿已经超过一天，作废了。想发的话再跟我说一次。';
    }
    if (answer === 'discard') {
      draft.status = 'discarded';
      const notice = this.#phrase(state, 'discard');
      await this.host.write(state);
      return notice;
    }
    // The delivery ledger answers the old id with its stored outcome; only a new id sends again.
    const next = { ...draft, id: createHash('sha256').update(`deskpet/wechat/moment/v1\0${randomUUID()}`).digest('hex') };
    state.draft = next;
    try {
      const sent = await this.#preview(state, next);
      const reason = windowFailure(sent);
      if (reason) return `${windowFailures[reason].text}预览还没确认完整送到，我先不发这条。`;
      return sent === 'sent' ? '刚才那份预览我没确认送到，配图可能也没发出去。我重新发了一遍，你看完图再回我「发」。'
        : '预览还是没能确认送到，我先不发。你在手机上看看收到图没有，等我再试一次。';
    } catch {
      this.failed('wechat.momentPreviewFailed');
      return '预览没发成，我先不发这条。';
    }
  }

  async #publish(id: string): Promise<void> {
    // The listener is still sending the acknowledgement; give it the desktop first.
    await this.host.wait(15_000);
    let outcome: MomentPostOutcome = 'retry';
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await this.state();
      const draft = state.draft;
      if (!draft || draft.id !== id || draft.status !== 'posting') return;
      const { full } = await this.host.image(draft.imageAssetId);
      outcome = await this.host.post({ id, text: draft.text, visibility: draft.visibility ?? 'all', images: [full] }).catch(() => 'retry' as const);
      // The worker already waited for the window. Repeating a lock timeout
      // here would make the owner wait one full lock budget for each retry.
      if (outcome !== 'retry' && outcome !== 'paused' && outcome !== 'window_error') break;
      await this.host.wait(20_000);
    }
    const state = await this.state();
    const draft = state.draft;
    if (!draft || draft.id !== id) return;
    const reason = windowFailure(outcome);
    draft.status = outcome === 'posted' ? 'posted' : reason || outcome === 'retry' ? 'failed' : 'uncertain';
    if (draft.status === 'posted') {
      state.posted = [...state.posted, { id, text: draft.text, at: this.host.now() }].slice(-30);
      this.#lastError = null;
      this.#lastSuccessAt = new Date(this.host.now()).toISOString();
    } else {
      this.failed(reason ? windowFailures[reason].code : draft.status === 'failed' ? 'wechat.momentFailed' : 'wechat.momentUncertain');
    }
    const notice = reason ? `${windowFailures[reason].text}这次没发出去，草稿已经作废了。` : this.#phrase(state, draft.status);
    await this.host.write(state);
    await this.host.notify(notice);
  }

  /** Prepares today's draft once its planned time has come. */
  async tick(): Promise<void> {
    if (this.#busy || !await this.host.enabled()) return;
    const now = this.host.now(), timezone = this.host.timezone();
    const state = await this.state();
    const today = localDate(now, timezone);
    if (state.plan?.date !== today) {
      state.plan = planFor(now, timezone);
      await this.host.write(state);
    }
    const plan = state.plan!;
    if (now < plan.at) return;
    const draftedToday = state.draft && localDate(state.draft.createdAt, timezone) === today;
    if (draftedToday || state.posted.some(item => localDate(item.at, timezone) === today)) return;
    if (state.draft?.status === 'posting') return;
    // A failed attempt waits an hour instead of retrying every tick.
    state.plan = { date: today, at: now + 3_600_000 };
    await this.host.write(state);
    const input = { date: today, recent: state.posted.slice(-10).map(item => item.text) };
    let content = await this.host.compose(input);
    const text = momentText(content.text);
    if ([...text].length > WECHAT_MOMENT_TEXT_LIMIT) content = await this.host.compose({ ...input, shorten: text });
    await this.propose(content);
  }
}
