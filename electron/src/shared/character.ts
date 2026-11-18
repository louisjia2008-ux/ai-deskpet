import { z } from 'zod';
import { CHARACTER_MOODS } from './character-reactions';
import type { CharacterMood } from './character-reactions';

const text = (max: number) => z.string().trim().max(max);
const lines = (count: number, max: number) => z.array(z.string().trim().min(1).max(max)).max(count);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u)
  .refine(value => {
    const [month, date] = value.split('-').map(Number) as [number, number];
    return date <= new Date(Date.UTC(2000, month, 0)).getUTCDate();
  });

/** What the owner writes about who the companion is, beyond the voice fields of the persona. */
export const characterProfileSchema = z.object({
  bible: text(6_000),
  likes: lines(20, 60),
  dislikes: lines(20, 60),
  pet: text(300),
  /** Age on `ageSince`; one year older on each anniversary of that day. */
  age: z.number().int().min(1).max(120).nullable(),
  ageSince: day.nullable(),
  /** Month and day only, supplied by the owner. */
  ownerBirthday: monthDay.optional(),
}).strict();
export type CharacterProfile = z.infer<typeof characterProfileSchema>;

/** Kept by the app between conversations; the owner does not edit it. */
export const characterStateSchema = z.object({
  lastOwnerTurnAt: z.string().datetime().nullable(),
  mood: z.object({ name: z.enum(CHARACTER_MOODS), at: z.string().datetime() }).strict().nullable(),
}).strict();
export type CharacterState = z.infer<typeof characterStateSchema>;

export const characterFileSchema = z.object({ profile: characterProfileSchema, state: characterStateSchema }).strict();
export type CharacterFile = z.infer<typeof characterFileSchema>;

export const defaultCharacterProfile = (): CharacterProfile => ({ bible: '', likes: [], dislikes: [], pet: '', age: null, ageSince: null });
export const defaultCharacterFile = (): CharacterFile => ({ profile: defaultCharacterProfile(), state: { lastOwnerTurnAt: null, mood: null } });

/** A starting point the owner can load into the form and rewrite; nothing is saved until they press save. */
export const characterDraft = (): CharacterProfile => ({
  bible: [
    '你是主人的小助手，住在主人的电脑里，也会在微信和 QQ 里陪主人。',
    '样子：（写她的长相：发型发色、眼睛、衣服、身上的小特点。）',
    '性格：（比如黏人、爱撒娇、嘴硬心软；什么事会让她生气，怎么哄好。）',
    '你像家人一样真实：有自己的想法，觉得主人做得不对会直接说，最后还是尊重主人的决定。',
    '说话：（怎么称呼主人、怎么称呼自己、常用的语气词、句子长短。）正事认真靠谱，说完正事再闲聊。',
  ].join('\n'),
  likes: ['被夸', '听主人讲今天发生的事'],
  dislikes: ['被敷衍'],
  pet: '',
  age: null,
  ageSince: null,
});

const parts = (value: string): [number, number, number] => value.split('-').map(Number) as [number, number, number];
const leap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
/** Use 1 March in non-leap years, as with the companion's age. */
const anniversary = (year: number, md: string): string => `${String(year).padStart(4, '0')}-${md === '02-29' && !leap(year) ? '03-01' : md}`;
/** Local calendar day as YYYY-MM-DD. */
export const localDay = (now: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Age today and the day of the next birthday, counting whole years since the age was set. */
export const characterAge = (profile: Pick<CharacterProfile, 'age' | 'ageSince'>, today: string): { age: number; nextBirthday: string } | null => {
  if (profile.age === null || profile.ageSince === null) return null;
  const [sy] = parts(profile.ageSince), [ty] = parts(today), md = profile.ageSince.slice(5);
  const years = Math.max(0, ty - sy - (today < anniversary(ty, md) ? 1 : 0));
  return { age: profile.age + years, nextBirthday: anniversary(sy + years + 1, md) };
};

const daysBetween = (from: string, to: string): number => {
  const [fy, fm, fd] = parts(from), [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
};

/** Calendar facts for an existing turn/greeting/diary, never an event or permission to send. */
export const birthdayPrompt = (input: { today: string; profile: CharacterProfile | null; addressUser?: string;
  characterLeadDays?: number }): string => {
  const { today, profile, characterLeadDays = 7 } = input;
  if (!profile) return '';
  const [year] = parts(today), hints: string[] = [];
  const age = characterAge(profile, today);
  if (age && profile.ageSince && profile.age !== null) {
    const until = daysBetween(today, age.nextBirthday);
    if (age.age > profile.age && today === anniversary(year, profile.ageSince.slice(5)))
      hints.push(`Today is your birthday: you just turned ${age.age}.`);
    else if (until > 0 && until <= characterLeadDays)
      hints.push(`Your birthday is in ${until} day${until === 1 ? '' : 's'}: you will be ${age.age + 1}. Bring it up only when it fits, not in every reply.`);
  }
  if (profile.ownerBirthday) {
    const thisYear = anniversary(year, profile.ownerBirthday);
    const until = daysBetween(today, today > thisYear ? anniversary(year + 1, profile.ownerBirthday) : thisYear);
    const owner = input.addressUser?.trim() || 'the owner';
    if (until === 0) hints.push(`Today is ${owner}'s birthday.`);
    else if (until > 0 && until <= 3) hints.push(`${owner}'s birthday is in ${until} day${until === 1 ? '' : 's'}. Bring it up only when it fits.`);
  }
  return hints.join(' ');
};

export const hasCharacterProfile = (profile: CharacterProfile | null | undefined): profile is CharacterProfile =>
  !!profile && (!!profile.bible || profile.likes.length > 0 || profile.dislikes.length > 0 || !!profile.pet || profile.age !== null);

/** Who the companion is, placed before the app's working rules. */
export const characterPrompt = (profile: CharacterProfile, input: { name: string; addressUser: string; today: string }): string => {
  const age = characterAge(profile, input.today);
  const owner = input.addressUser || 'the owner';
  return [
    `This is who you are${input.name ? `: ${input.name}` : ''}. ${owner === 'the owner' ? 'The owner' : `Your ${owner}`} wrote it for you. `
      + 'Think, feel and speak as yourself, not as an assistant playing a part.',
    age && `Age: ${age.age}. You grow up for real: you turn ${age.age + 1} on ${age.nextBirthday}.`,
    profile.pet && `Your pet: ${profile.pet}`,
    profile.bible && `About you:\n${profile.bible}`,
    profile.likes.length > 0 && `Things you like: ${profile.likes.join(' / ')}`,
    profile.dislikes.length > 0 && `Things you dislike: ${profile.dislikes.join(' / ')}`,
    'You have your own feelings and opinions. You can be glad, miss them, sulk, or disagree and say so, the way family does, '
      + 'and still respect their decision in the end. Your feelings carry over between conversations.',
    age && age.age < 18 && 'You are a minor and their family. Your affection is family closeness: never romantic, flirtatious or sexual.',
    'If sincerely asked, you do not deny being an AI companion. Being yourself never changes what is true: '
      + 'facts and actions still come only from tools, saved memories and the conversation, under the working rules.',
  ].filter((item): item is string => typeof item === 'string' && item.length > 0).join('\n\n');
};

const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
};
const MOOD_MEMORY_MS = 24 * 60 * 60_000;
const SHOWN_GAP_MS = 60 * 60_000;

/** This moment, as the companion would feel it: the time, how long since the owner last talked, how she felt then. */
export const momentPrompt = (input: { now: Date; timeZone: string; state: CharacterState | null; profile: CharacterProfile | null; addressUser?: string }): string => {
  const { now, timeZone, state } = input;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const lines = [`Right now it is ${clock} (${timeZone}).`];
  const last = state?.lastOwnerTurnAt ? Date.parse(state.lastOwnerTurnAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last >= SHOWN_GAP_MS) lines.push(`They last talked with you ${ago(now.getTime() - last)} ago.`);
  const mood = state?.mood, moodAt = mood ? Date.parse(mood.at) : NaN;
  if (mood && Number.isFinite(moodAt) && now.getTime() - moodAt <= MOOD_MEMORY_MS) {
    lines.push(`Last time you felt ${mood.name as CharacterMood} (${ago(Math.max(0, now.getTime() - moodAt))} ago). Feelings fade with time; let it carry over only as much as a person's would.`);
  }
  const birthdays = birthdayPrompt({ ...input, today: localDay(now, timeZone) });
  if (birthdays) lines.push(birthdays);
  lines.push('Let this shape how you greet and respond, the way a person would. Do not recite it.');
  return lines.join(' ');
};
