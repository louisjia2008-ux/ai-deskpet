import { cleanReplyText } from '../../shared/qq-sticker-reply';
import type { ChatMessage } from '../../shared';
import type { ChatService } from './chat-service';

// At most one disk write is in flight. A terminal write always follows it, so
// an older streaming checkpoint can never overwrite a completed reply.
export class ChatResponseWriter {
  #text = '';
  #saved = '';
  #pending: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #failed = false;

  constructor(private readonly chat: ChatService, private readonly id: string, private readonly fail: () => void, private readonly intervalMs = 1_000) {}
  get text(): string { return this.#text; }

  append(text: string): void {
    if (this.#text.length + text.length > 256_000) throw new Error('provider.request');
    this.#text += text;
    if (this.#timer === null) {
      this.#timer = setInterval(() => this.#checkpoint(), this.intervalMs);
      this.#timer.unref?.();
    }
  }

  #checkpoint(): void {
    if (this.#pending !== null || this.#text === this.#saved || this.#failed) return;
    const content = this.#text;
    this.#pending = this.chat.updateMessage(this.id, { content, status: 'streaming', errorCode: null })
      .then(() => { this.#saved = content; })
      .catch(() => { this.#failed = true; this.fail(); })
      .finally(() => { this.#pending = null; });
  }

  stop(): void { if (this.#timer !== null) clearInterval(this.#timer); this.#timer = null; }

  async finish(status: ChatMessage['status'], errorCode: string | null = null): Promise<ChatMessage> {
    this.stop();
    await this.#pending;
    const content = cleanReplyText(this.#text);
    const emptyReply = status === 'complete' && !content.trim() && content !== this.#text;
    return this.chat.updateMessage(this.id, { content, status: this.#failed || emptyReply ? 'failed' : status,
      errorCode: this.#failed ? 'chat.persistenceFailed' : emptyReply ? 'chat.runFailed' : errorCode });
  }
}
