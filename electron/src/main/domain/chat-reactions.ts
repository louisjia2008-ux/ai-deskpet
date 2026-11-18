import { reactionForReply, reactionHint } from '../../shared/character-reactions';
import type { CharacterMood, CharacterReaction } from '../../shared/character-reactions';

// Presentation only: no additional model request and no changes to chat text.
// Keep the face throughout streaming, then release it after the final reply.
export class ChatReactions {
  #sequence = 0;
  #text = '';
  #mood: CharacterMood | null = null;
  #finished = false;
  #stated: CharacterMood | null = null;

  constructor(private readonly runId: string, private readonly userText: string, private readonly send: (reaction: CharacterReaction) => void) {}

  start(): void {
    const mood = reactionHint(this.userText);
    if (mood !== null) this.#emit(mood, 'speaking');
  }

  append(text: string): void {
    if (this.#finished || !text) return;
    this.#text = (this.#text + text).slice(-8_000);
    const mood = this.#stated ?? reactionForReply(this.#text, this.userText);
    if (mood !== this.#mood) this.#emit(mood, 'speaking');
  }

  /** The model's own stated feeling outranks the keyword guess for the rest of the reply. */
  state(mood: CharacterMood): void {
    if (this.#finished) return;
    this.#stated = mood;
    if (mood !== this.#mood) this.#emit(mood, 'speaking');
  }

  finish(content: string | null): void {
    if (this.#finished) return;
    this.#finished = true;
    if (content?.trim()) this.#emit(this.#stated ?? reactionForReply(content, this.userText), 'finished');
    else if (this.#mood !== null) this.#emit(this.#mood, 'clear');
  }

  #emit(mood: CharacterMood, phase: CharacterReaction['phase']): void {
    this.#mood = mood;
    this.send({ id: `${this.runId}:${++this.#sequence}`, mood, ...(phase ? { phase } : {}) });
  }
}
