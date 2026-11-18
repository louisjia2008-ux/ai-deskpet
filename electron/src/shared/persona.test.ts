import { describe, expect, it } from 'vitest';
import { defaultPersona, personaDraftFromFile, personaPrompt, personaSchema } from './persona';

describe('character prompt', () => {
  it('adds nothing until the owner writes something', () => {
    expect(personaPrompt(defaultPersona())).toBeNull();
    expect(personaPrompt(null)).toBeNull();
  });

  it('keeps the owner\'s text and says it cannot override the truth rules', () => {
    const prompt = personaPrompt({ ...defaultPersona(), name: 'Kitty', addressUser: '主人', personality: '傲娇', catchphrases: ['才不是呢'] })!;
    expect(prompt).toContain('Your name: Kitty');
    expect(prompt).toContain('Call the user: 主人');
    expect(prompt).toContain('傲娇');
    expect(prompt).toContain('才不是呢');
    expect(prompt).toContain('It never changes what is true');
  });

  it('rejects unknown fields and oversized text', () => {
    expect(personaSchema.safeParse({ ...defaultPersona(), extra: true }).success).toBe(false);
    expect(personaSchema.safeParse({ ...defaultPersona(), identity: 'x'.repeat(2_001) }).success).toBe(false);
  });
});

describe('character file import', () => {
  const current = { ...defaultPersona(), addressUser: '主人', boundaries: '不要说教', shareStyleWithCloud: true };

  it('reads a v2 character card and keeps what the card does not cover', () => {
    const draft = personaDraftFromFile(JSON.stringify({ spec: 'chara_card_v2', data: { name: '小雪', description: '猫娘', personality: '粘人', scenario: '住在电脑里', first_mes: '你回来啦', mes_example: '<START> 喵' } }), current);
    expect(draft).toMatchObject({ name: '小雪', personality: '粘人', addressUser: '主人', boundaries: '不要说教', shareStyleWithCloud: true });
    expect(draft.identity).toBe('猫娘\n\n场景：住在电脑里');
    expect(draft.examples).toContain('你回来啦');
    expect(draft.examples).toContain('<START> 喵');
  });

  it('reads a v1 card and treats anything else as notes', () => {
    expect(personaDraftFromFile(JSON.stringify({ name: 'A', personality: 'B' }), current)).toMatchObject({ name: 'A', personality: 'B' });
    expect(personaDraftFromFile('# 我的设定\n她是一只猫', current).identity).toBe('# 我的设定\n她是一只猫');
    expect(personaDraftFromFile('[1, 2]', current).identity).toBe('[1, 2]');
  });

  it('always produces a draft that can be saved', () => {
    const draft = personaDraftFromFile(JSON.stringify({ name: 'n'.repeat(99), description: 'd'.repeat(9_000), mes_example: 'e'.repeat(9_000) }), current);
    expect(personaSchema.safeParse(draft).success).toBe(true);
  });
});
