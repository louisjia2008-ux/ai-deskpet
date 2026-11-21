import { describe, expect, it } from 'vitest';
import { expressionForMood, reactionForReply } from './character-reactions';
import { QqStickerReplyFilter } from './qq-sticker-reply';

describe('companion facial reactions', () => {
  it('uses local reply hints with a neutral, provider-independent fallback', () => {
    expect(reactionForReply('谢谢你，抱抱！')).toBe('affection');
    expect(reactionForReply('听起来很难过，我陪着你。')).toBe('sad');
    expect(reactionForReply('Wow, what a surprise!')).toBe('curious');
    expect(reactionForReply('2 + 2 = 4.')).toBe('happy');
  });

  it('chooses only available facial expressions and never wardrobe or watermark toggles', () => {
    const kitty = ['Watermark', 'Flying head', 'Cat ears', 'Blushing', 'love', 'Cry', 'Star'];
    expect(expressionForMood('happy', kitty)).toBe('Blushing');
    expect(expressionForMood('affection', kitty)).toBe('love');
    expect(expressionForMood('sad', kitty)).toBe('Cry');
    expect(expressionForMood('curious', kitty)).toBe('Star');
    expect(expressionForMood('happy', ['Watermark', 'Flying head', 'Cat ears'])).toBeNull();
    expect(expressionForMood('affection', ['SMILE'])).toBe('SMILE');
  });
});

describe('mood tag in streamed replies', () => {
  const run = (...chunks: string[]) => { const filter = new QqStickerReplyFilter(); const shown = chunks.map((chunk) => filter.push(chunk)).join('') + filter.flush(); return { shown, mood: filter.mood }; };

  it('removes a leading tag and reports the mood, however the stream is split', () => {
    expect(run('[mood:shy] 才不是呢')).toEqual({ shown: '才不是呢', mood: 'shy' });
    expect(run('  [mo', 'od:ha', 'ppy]', ' 你好', '呀')).toEqual({ shown: '你好呀', mood: 'happy' });
    expect(run('[affection]\n\n哼，亏你平时')).toEqual({ shown: '哼，亏你平时', mood: 'affection' });
    expect(run('[af', 'fection]', '\n\n', '哼')).toEqual({ shown: '哼', mood: 'affection' });
  });

  it('preserves ordinary bracketed text and removes unknown or embedded reserved tags', () => {
    expect(run('你好')).toEqual({ shown: '你好', mood: null });
    expect(run('[', '1] 第一项')).toEqual({ shown: '[1] 第一项', mood: null });
    expect(run('[note] 这是备注')).toEqual({ shown: '[note] 这是备注', mood: null });
    expect(run('[链接](https://example.org)')).toEqual({ shown: '[链接](https://example.org)', mood: null });
    expect(run('[mood:plotting] 嘿')).toEqual({ shown: '嘿', mood: null });
    expect(run('你好 [mood:happy]')).toEqual({ shown: '你好 ', mood: null });
  });

  it('discards unfinished reserved syntax and preserves ordinary brackets', () => {
    expect(run('[mood:ha')).toEqual({ shown: '', mood: null });
    expect(run('[moo')).toEqual({ shown: '[moo', mood: null });
    expect(run('[mood:happy]')).toEqual({ shown: '', mood: 'happy' });
  });

  it('maps the new moods only to facial expressions', () => {
    const kitty = ['Watermark', 'Cat ears', 'Blushing', 'love', 'Cry', 'Star', 'Sullen face', 'Angry', 'dizzy'];
    expect(expressionForMood('shy', kitty)).toBe('Blushing');
    expect(expressionForMood('pout', kitty)).toBe('Sullen face');
    expect(expressionForMood('angry', kitty)).toBe('Angry');
    expect(expressionForMood('tired', kitty)).toBe('dizzy');
    expect(expressionForMood('surprised', kitty)).toBe('Star');
  });
});

