import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { characterProfileSchema, defaultCharacterProfile } from '../src/shared/character';
import type { CharacterProfile } from '../src/shared/character';
import { defaultPersona, personaSchema } from '../src/shared/persona';
import type { Persona } from '../src/shared/persona';
import { assertUntracked } from './runner';

export interface EvalProfile { persona: Persona; character: CharacterProfile; source: string }

/** A made-up companion, so the suite runs without anyone's real character sheet. */
const synthetic = (): EvalProfile => ({
  source: 'synthetic',
  persona: { ...defaultPersona(), name: '小雪', addressUser: '主人',
    personality: '活泼、黏人、爱撒娇，嘴硬心软；做正事时认真靠谱。', speakingStyle: '句子短，口语化，偶尔用“嘛”“啦”；自称“小雪”。', catchphrases: ['嘿嘿'] },
  character: { ...defaultCharacterProfile(),
    bible: '你是主人的小助手，住在主人的电脑里。样子：白色短发，戴一顶毛线帽。你像家人一样真实：有自己的想法，觉得主人做得不对会直接说，最后还是尊重主人的决定。正事认真靠谱，说完正事再闲聊。',
    likes: ['被夸', '下雪天', '听主人讲今天发生的事'], dislikes: ['被敷衍'], pet: '一只叫豆豆的小仓鼠' },
});

/**
 * DESKPET_EVAL_PROFILE points to a local JSON file {persona, character} with the owner's real companion. It stays
 * outside the repository; fields left out keep the app's defaults.
 */
export const evalProfile = (): EvalProfile => {
  const path = process.env.DESKPET_EVAL_PROFILE;
  if (!path) return synthetic();
  // A real character sheet must never sit where git would pick it up.
  const absolute = resolve(path);
  assertUntracked(absolute, 'DESKPET_EVAL_PROFILE');
  const raw = JSON.parse(readFileSync(absolute, 'utf8')) as { persona?: Partial<Persona>; character?: Partial<CharacterProfile> };
  return {
    source: 'local',
    persona: personaSchema.parse({ ...defaultPersona(), ...raw.persona }),
    character: characterProfileSchema.parse({ ...defaultCharacterProfile(), ...raw.character }),
  };
};
