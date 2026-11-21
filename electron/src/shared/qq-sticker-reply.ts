import { CHARACTER_MOODS } from './character-reactions';
import type { CharacterMood } from './character-reactions';

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

const TEXT: QqStickerDecision = Object.freeze({ mode: 'text' });
const markers = new Map<string, QqStickerDecision>([['none', TEXT]]);
for (const scene of Object.keys(sceneDescriptions) as QqStickerScene[]) {
  markers.set(`with-text:${scene}`, Object.freeze({ mode: 'with-text', scene }));
  markers.set(`only:${scene}`, Object.freeze({ mode: 'sticker-only', scene }));
}
const controls = ['[sticker:', '[mood:'] as const;
const bareMoodTags = CHARACTER_MOODS.map(mood => `[${mood}]`);
const maxValueLength = Math.max(...Array.from(markers.keys(), value => value.length));

type ReservedControl = typeof controls[number];

/** Interprets leading controls during a stream and drops reserved tags throughout.
 * Ordinary bracketed text is released as soon as it cannot be a control. */
export class QqStickerReplyFilter {
  #buffer = '';
  #leading = true;
  #removed = false;
  #control: ReservedControl | null = null;
  #value = '';
  #overlong = false;
  #decision: QqStickerDecision | null = null;
  #stickerControl = false;
  mood: CharacterMood | null = null;

  constructor(private readonly allowBareMood = true) {}

  get decision(): QqStickerDecision | null { return this.#decision; }
  get hasStickerControl(): boolean { return this.#stickerControl; }
  get removed(): boolean { return this.#removed; }

  push(chunk: string): string {
    this.#buffer += chunk;
    let visible = '';
    while (this.#buffer !== '') {
      if (this.#control !== null) {
        const end = this.#buffer.search(/[\]\r\n]/u);
        const value = end < 0 ? this.#buffer : this.#buffer.slice(0, end);
        this.#overlong ||= this.#value.length + value.length > maxValueLength;
        if (!this.#overlong) this.#value += value;
        if (end < 0) {
          this.#buffer = '';
          break;
        }
        const closed = this.#buffer[end] === ']';
        if (this.#leading) this.#readControl(closed && !this.#overlong ? this.#value : null);
        this.#control = null;
        this.#value = '';
        this.#overlong = false;
        this.#buffer = this.#buffer.slice(end + Number(closed));
        continue;
      }

      const pending = this.#leading ? this.#buffer.trimStart() : this.#buffer;
      const opening = pending.indexOf('[');
      if (opening === 0) {
        const lower = pending.slice(0, controls[0].length).toLowerCase();
        const control = controls.find(prefix => lower.startsWith(prefix));
        if (control) {
          this.#control = control;
          this.#buffer = pending.slice(control.length);
          this.#removed = true;
          continue;
        }
        if (this.#leading && this.allowBareMood) {
          const bareMood = bareMoodTags.find(tag => pending.startsWith(tag));
          if (bareMood) {
            this.mood ??= CHARACTER_MOODS.find(mood => bareMood === `[${mood}]`) ?? null;
            this.#buffer = pending.slice(bareMood.length);
            this.#removed = true;
            continue;
          }
          if (bareMoodTags.some(tag => tag.startsWith(pending))) break;
        }
        if (controls.some(prefix => prefix.startsWith(lower))) break;
      }
      if (pending === '') break;
      // Release ordinary text up to its next opening bracket. A literal
      // opening bracket moves the cursor forward so it cannot be reprocessed.
      const length = opening === 0 ? 1 : opening < 0 ? pending.length : opening;
      const whitespace = this.#buffer.length - pending.length;
      if (!this.#removed) visible += this.#buffer.slice(0, whitespace);
      visible += pending.slice(0, length);
      this.#buffer = pending.slice(length);
      this.#leading = false;
      this.#decision ??= TEXT;
    }
    return visible;
  }

  flush(): string {
    if (this.#control !== null && this.#leading) this.#readControl(null);
    const literal = this.#leading && this.#removed ? this.#buffer.trimStart() : this.#buffer;
    if (literal !== '') this.#decision ??= TEXT;
    this.#buffer = '';
    this.#control = null;
    return literal;
  }

  #readControl(value: string | null): void {
    if (this.#control === '[sticker:') {
      this.#stickerControl = true;
      this.#decision ??= value === null ? TEXT : markers.get(value) ?? TEXT;
    } else if (value !== null) {
      const mood = value.toLowerCase();
      this.mood ??= mood === 'playful' ? 'happy' : CHARACTER_MOODS.find(candidate => candidate === mood) ?? null;
    }
  }
}

/** Final delivery guard, also for saved text that predates the streaming filter. */
export function cleanReplyText(content: string): string {
  const filter = new QqStickerReplyFilter(false);
  const text = filter.push(content) + filter.flush();
  return filter.removed ? text.trim() : text;
}

export const stickerReply = (content: string): { text: string; decision: QqStickerDecision } => {
  const filter = new QqStickerReplyFilter();
  const text = filter.push(content) + filter.flush();
  return { text, decision: filter.decision ?? TEXT };
};
