const sceneDescriptions = {
  greeting: '打招呼或问候',
  noon: '午间问候',
  goodnight: '晚安',
  amusement: '好笑或轻松逗趣',
  celebrate: '恭喜或庆祝',
  comfort: '简短安慰',
  thanks: '感谢',
  acknowledge: '收到或确认',
  encourage: '加油或鼓励',
  affection: '表达喜欢或亲昵',
} as const;

export type QqStickerScene = keyof typeof sceneDescriptions;

export type QqStickerDecision =
  | { mode: 'text' }
  | { mode: 'with-text' | 'sticker-only'; scene: QqStickerScene };

const stickerReplyInstruction = (channel: string) => `这是${channel}私聊的回复格式。继续遵循已有上下文、角色设定和对方使用的语言。请在回复的第一个字符处开始，选用且只用以下一个控制标记，然后另起一行写正文。
[sticker:none] 表示纯文字。
[sticker:with-text:场景] 表示正文配一张表情。
[sticker:only:场景] 表示若有合适表情，可以用一张表情代替正文。只在安全、简短的社交互动中使用，而且表情本身要能完整传达你的意思。
把“场景”替换为以下英文值之一：${Object.entries(sceneDescriptions).map(([scene, description]) => `${scene}（${description}）`).join('、')}。
对方要求纯文字、要求逐字输出或引用，或回答需要提供信息、解释、结果、步骤和重要提醒时，选择 [sticker:none]。不确定配图是否合适时也选纯文字。
无论选择哪个标记，都要写一段非空、自然、可以单独发送的正文。没有可用表情时，正文会直接作为回复。不要在正文里解释标记、声称已发送图片，或要求对方查看图片。`;

export const QQ_STICKER_REPLY_INSTRUCTION = stickerReplyInstruction(' QQ ');
/** WeChat always sends the text; a chosen sticker follows it as a second message. */
export const WECHAT_STICKER_REPLY_INSTRUCTION = stickerReplyInstruction('微信').replace('这是微信私聊的回复格式', '这是微信回复的格式')
  .replace(/\[sticker:only:场景\][^\n]*\n/u, '');

const PREFIX = '[sticker:';
const TEXT: QqStickerDecision = Object.freeze({ mode: 'text' });
const markers = new Map<string, QqStickerDecision>([['none', TEXT]]);
for (const scene of Object.keys(sceneDescriptions) as QqStickerScene[]) {
  markers.set(`with-text:${scene}`, Object.freeze({ mode: 'with-text', scene }));
  markers.set(`only:${scene}`, Object.freeze({ mode: 'sticker-only', scene }));
}
const MAX_HINT_LENGTH = Math.max(...Array.from(markers.keys(), marker => marker.length));

type FilterState = 'prefix' | 'hint' | 'discard-hint' | 'newline' | 'optional-lf' | 'text';

/** Consumes just the leading control line. An invalid reserved hint falls back
 * to text. Once the prefix is settled, subsequent content is never interpreted. */
export class QqStickerReplyFilter {
  #state: FilterState = 'prefix';
  #pending = '';
  #decision: QqStickerDecision | null = null;

  get decision(): QqStickerDecision | null { return this.#decision; }

  push(chunk: string): string {
    if (this.#state === 'text' || chunk === '') return chunk;
    let offset = 0;

    if (this.#state === 'prefix') {
      offset = Math.min(PREFIX.length - this.#pending.length, chunk.length);
      const candidate = this.#pending + chunk.slice(0, offset);
      if (!PREFIX.startsWith(candidate)) {
        const original = this.#pending + chunk;
        this.#pending = '';
        this.#decision = TEXT;
        this.#state = 'text';
        return original;
      }
      if (candidate.length < PREFIX.length) {
        this.#pending = candidate;
        return '';
      }
      this.#pending = '';
      this.#state = 'hint';
    }

    if (this.#state === 'hint' || this.#state === 'discard-hint') {
      let end = offset;
      while (end < chunk.length && chunk[end] !== ']' && chunk[end] !== '\n' && chunk[end] !== '\r') end++;
      if (this.#state === 'hint') {
        if (this.#pending.length + end - offset > MAX_HINT_LENGTH) {
          this.#pending = '';
          this.#state = 'discard-hint';
        } else {
          this.#pending += chunk.slice(offset, end);
        }
      }
      if (end === chunk.length) return '';

      const closed = chunk[end] === ']';
      this.#decision = closed && this.#state === 'hint' ? markers.get(this.#pending) ?? TEXT : TEXT;
      this.#pending = '';
      this.#state = 'newline';
      offset = closed ? end + 1 : end;
    }

    if (this.#state === 'newline' && offset < chunk.length) {
      if (chunk[offset] === '\r') {
        offset++;
        this.#state = 'optional-lf';
      } else {
        if (chunk[offset] === '\n') offset++;
        this.#state = 'text';
      }
    }
    if (this.#state === 'optional-lf' && offset < chunk.length) {
      if (chunk[offset] === '\n') offset++;
      this.#state = 'text';
    }
    return chunk.slice(offset);
  }

  flush(): string {
    const literal = this.#state === 'prefix' ? this.#pending : '';
    if (literal || this.#state === 'hint' || this.#state === 'discard-hint') this.#decision = TEXT;
    this.#pending = '';
    this.#state = 'text';
    return literal;
  }
}

/** Non-streaming deliveries use exactly the same reserved-prefix parser as chat. */
export const stickerReply = (content: string): { text: string; decision: QqStickerDecision } => {
  const filter = new QqStickerReplyFilter();
  const text = filter.push(content) + filter.flush();
  return { text, decision: filter.decision ?? TEXT };
};
