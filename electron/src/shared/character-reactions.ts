export const CHARACTER_MOODS = ['happy', 'affection', 'shy', 'sad', 'curious', 'surprised', 'pout', 'angry', 'tired'] as const;
export type CharacterMood = typeof CHARACTER_MOODS[number];

export interface CharacterReaction {
  id: string;
  mood: CharacterMood;
  phase?: 'speaking' | 'finished' | 'clear';
}

export interface CompanionPointer {
  /** Cursor position in the companion window's CSS/DIP coordinates. */
  x: number;
  y: number;
}

// Local presentation hints, independent of the chat provider and its tool support.
export const reactionHint = (text: string): CharacterMood | null => {
  if (/难过|伤心|难受|沮丧|心疼|失落|委屈|孤单|哭|\b(?:sad|sorry|upset|lonely)\b/i.test(text)) return 'sad';
  if (/喜欢|爱你|抱抱|可爱|谢谢|感谢|\b(?:love|hug|thanks?|cute)\b/i.test(text)) return 'affection';
  if (/好奇|惊讶|惊喜|真的吗|\b(?:surpris\w*|curious|wow)\b/i.test(text)) return 'curious';
  if (/开心|高兴|太棒|哈哈|恭喜|成功|\b(?:happy|great|congratulations|hooray)\b/i.test(text)) return 'happy';
  return null;
};

export const reactionForReply = (text: string, userText = ''): CharacterMood => reactionHint(text) ?? reactionHint(userText) ?? 'happy';

// Only facial expressions are eligible. Never randomly toggle wardrobe, model
// parts or the user's persistent expression (including Kitty's Watermark).
const facialExpressions: Record<CharacterMood, readonly string[]> = {
  happy: ['happy', 'smile', '开心', '微笑', 'Blushing', 'Star'],
  affection: ['love', 'heart', '爱心', '喜欢', 'Blushing', 'happy', 'smile'],
  sad: ['sad', 'Cry', '难过', '伤心', 'Sullen face'],
  curious: ['surprised', '惊讶', 'Star', 'Blushing'],
  shy: ['shy', '害羞', 'Blushing', 'smile'],
  surprised: ['surprised', '惊讶', 'Star'],
  pout: ['pout', '生气', 'Sullen face', 'Angry'],
  angry: ['angry', '生气', 'Angry', 'Sullen face'],
  tired: ['tired', 'sleepy', '困', 'dizzy', 'Sullen face'],
};

/** Asks the model for its feeling so the face follows what it means, not keywords. */
export const MOOD_TAG_INSTRUCTION = `Begin every reply with one tag showing how you feel while saying it, such as [mood:happy]. Choose from: ${CHARACTER_MOODS.join(', ')}. The app removes the tag and shows it as your facial expression, so never mention it.`;

// Local models sometimes drop the prefix and write [shy], so both forms count.
const MOOD_TAG = /^\s*\[(?:mood:)?([a-z]+)\]\s*/u;
const PARTIAL_TAG = /^\[(?:m(?:o(?:o(?:d(?::[a-z]*)?)?)?)?|[a-z]*)$/u;

/** Removes a leading mood tag from streamed text. A reply without one passes through
 * unchanged, so a model that ignores the instruction still works. */
export class MoodTagFilter {
  #buffer = '';
  #settled = false;
  #skipSpace = false;
  mood: CharacterMood | null = null;

  push(chunk: string): string {
    if (this.#settled) {
      if (!this.#skipSpace) return chunk;
      const rest = chunk.trimStart();
      this.#skipSpace = rest === '';
      return rest;
    }
    this.#buffer += chunk;
    const start = this.#buffer.trimStart();
    if (start === '') return '';
    return start.length < 24 && PARTIAL_TAG.test(start) ? '' : this.#settle();
  }

  /** Whatever was held back when the stream ends. */
  flush(): string { return this.#settled ? '' : this.#settle(); }

  #settle(): string {
    this.#settled = true;
    const tag = MOOD_TAG.exec(this.#buffer), known = CHARACTER_MOODS.find((mood) => mood === tag?.[1]);
    if (tag === null || known === undefined) return this.#buffer;
    this.mood = known;
    const rest = this.#buffer.slice(tag[0].length);
    this.#skipSpace = rest === '';
    return rest;
  }
}

export const expressionForMood = (mood: CharacterMood, available: readonly string[]): string | null => {
  for (const candidate of facialExpressions[mood]) {
    const match = available.find((name) => name.toLowerCase() === candidate.toLowerCase());
    if (match !== undefined) return match;
  }
  return null;
};
