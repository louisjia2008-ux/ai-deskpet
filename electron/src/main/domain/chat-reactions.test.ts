import { describe, expect, it } from 'vitest';
import type { CharacterReaction } from '../../shared/character-reactions';
import { ChatReactions } from './chat-reactions';

describe('chat expression lifecycle', () => {
  it('reacts to user emotion before generation, follows streamed text, then releases after completion', () => {
    const events: CharacterReaction[] = [];
    const reactions = new ChatReactions('run-1', '今天很难过', (event) => events.push(event));
    reactions.start();
    expect(events).toMatchObject([{ mood: 'sad', phase: 'speaking' }]);
    reactions.append('我在这里');
    expect(events).toHaveLength(1);
    reactions.append('，给你一个抱抱。');
    expect(events.at(-1)).toMatchObject({ mood: 'affection', phase: 'speaking' });
    reactions.finish('我在这里，给你一个抱抱。');
    expect(events.at(-1)).toMatchObject({ mood: 'affection', phase: 'finished' });
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });
  it('starts on the first text for a neutral query, handles words across chunks and avoids repeated or late updates', () => {
    const events: CharacterReaction[] = [];
    const reactions = new ChatReactions('run-2', '聊聊吧', (event) => events.push(event));
    reactions.start(); expect(events).toHaveLength(0);
    reactions.append('谢'); reactions.append('谢你'); reactions.append('的陪伴');
    expect(events.map((event) => event.mood)).toEqual(['happy', 'affection']);
    reactions.finish(null); expect(events.at(-1)?.phase).toBe('clear');
    reactions.append('Wow'); reactions.finish('Wow'); expect(events).toHaveLength(3);
  });
});
