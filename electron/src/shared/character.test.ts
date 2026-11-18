import { describe, expect, it } from 'vitest';
import { birthdayPrompt, characterAge, characterProfileSchema, characterPrompt, defaultCharacterProfile, momentPrompt } from './character';
import type { CharacterState } from './character';

const profile = { bible: '她很黏人，会撒娇。', likes: ['草莓', '晴天'], dislikes: ['打雷'], pet: '团子：一只圆滚滚的小毛团。', age: 16, ageSince: '2026-11-15' };
const zone = 'Asia/Shanghai';
const at = (local: string): Date => new Date(`${local}+08:00`);

describe('her age', () => {
  it('grows by one on each anniversary of the day it was set', () => {
    expect(characterAge(profile, '2026-11-15')).toEqual({ age: 16, nextBirthday: '2027-11-15' });
    expect(characterAge(profile, '2027-11-14')).toEqual({ age: 16, nextBirthday: '2027-11-15' });
    expect(characterAge(profile, '2027-11-15')).toEqual({ age: 17, nextBirthday: '2028-11-15' });
    expect(characterAge({ age: 16, ageSince: '2028-02-29' }, '2029-03-01')).toEqual({ age: 17, nextBirthday: '2030-03-01' });
    expect(characterAge({ age: null, ageSince: null }, '2026-11-15')).toBeNull();
  });
});

describe('who she is', () => {
  it('names her, her age and pet, and keeps a minor family-only', () => {
    const text = characterPrompt(profile, { name: '桌宠角色', addressUser: '主人', today: '2026-11-15' });
    expect(text).toContain('Age: 16. You grow up for real: you turn 17 on 2027-11-15.');
    expect(text).toContain('团子');
    expect(text).toContain('Things you like: 草莓 / 晴天');
    expect(text).toContain('never romantic, flirtatious or sexual');
    expect(characterPrompt({ ...profile, age: 20 }, { name: 'X', addressUser: '', today: '2026-11-15' })).not.toContain('You are a minor');
    expect(characterPrompt(defaultCharacterProfile(), { name: '', addressUser: '', today: '2026-11-15' })).not.toContain('Age:');
  });
});

describe('shared birthday facts', () => {
  it('includes exactly the seven preceding days for the diary; proactive greetings use the day only', () => {
    const prompt = (today: string, characterLeadDays = 7) => birthdayPrompt({ today, profile, characterLeadDays });
    expect(prompt('2027-11-07')).toBe('');
    expect(prompt('2027-11-08')).toContain('Your birthday is in 7 days');
    expect(prompt('2027-11-08', 0)).toBe('');
    expect(prompt('2027-11-15', 0)).toBe('Today is your birthday: you just turned 17.');
    expect(prompt('2027-11-16')).toBe('');
  });

  it('uses February 29 in leap years and March 1 otherwise for both birthdays', () => {
    const both = { ...profile, ageSince: '2024-02-29', ownerBirthday: '02-29' };
    const prompt = (today: string) => birthdayPrompt({ today, profile: both, addressUser: '队长' });
    expect(prompt('2027-02-28')).toContain("队长's birthday is in 1 day.");
    expect(prompt('2027-03-01')).toBe("Today is your birthday: you just turned 19. Today is 队长's birthday.");
    expect(prompt('2028-02-29')).toContain('you just turned 20');
    expect(prompt('2028-03-01')).toBe('');
  });

  it('defaults to no owner birthday, respects the configured form of address, and rejects invalid dates', () => {
    const now = at('2027-12-30T09:00:00');
    const input = { now, timeZone: zone, state: null, addressUser: '队长' };
    expect(momentPrompt({ ...input, profile })).not.toContain('birthday');
    const withOwner = { ...profile, ownerBirthday: '01-02' };
    expect(momentPrompt({ ...input, profile: withOwner })).toContain("队长's birthday is in 3 days");
    expect(momentPrompt({ ...input, now: at('2027-12-29T09:00:00'), profile: withOwner })).not.toContain('birthday');
    expect(momentPrompt({ ...input, now: at('2028-01-02T09:00:00'), profile: withOwner })).toContain("Today is 队长's birthday");
    for (const ownerBirthday of ['2028-02-29', '02-30', '04-31', '1-01'])
      expect(characterProfileSchema.safeParse({ ...profile, ownerBirthday }).success).toBe(false);
    expect(characterProfileSchema.safeParse({ ...profile, ownerBirthday: '02-29' }).success).toBe(true);
  });
});

describe('this moment', () => {
  const state = (patch: Partial<CharacterState>): CharacterState => ({ lastOwnerTurnAt: null, mood: null, ...patch });
  it('says the local time, how long since he last talked, and a mood that is still fresh', () => {
    const text = momentPrompt({ now: at('2026-11-17T21:30:00'), timeZone: zone, profile,
      state: state({ lastOwnerTurnAt: at('2026-11-15T21:00:00').toISOString(), mood: { name: 'pout', at: at('2026-11-17T09:30:00').toISOString() } }) });
    expect(text).toContain('Right now it is Tuesday, 17 November 2026 at 21:30 (Asia/Shanghai).');
    expect(text).toContain('They last talked with you 2 days ago.');
    expect(text).toContain('Last time you felt pout (12 hours ago).');
    expect(text).toContain('Do not recite it.');
  });
  it('leaves out a short gap and an old mood', () => {
    const text = momentPrompt({ now: at('2026-11-17T21:30:00'), timeZone: zone, profile,
      state: state({ lastOwnerTurnAt: at('2026-11-17T21:00:00').toISOString(), mood: { name: 'sad', at: at('2026-11-15T21:00:00').toISOString() } }) });
    expect(text).not.toContain('last talked');
    expect(text).not.toContain('you felt');
  });
  it('knows when her birthday is near and when it is today', () => {
    expect(momentPrompt({ now: at('2027-11-12T10:00:00'), timeZone: zone, profile, state: null })).toContain('Your birthday is in 3 days: you will be 17. Bring it up only when it fits');
    expect(momentPrompt({ now: at('2027-11-15T10:00:00'), timeZone: zone, profile, state: null })).toContain('Today is your birthday: you just turned 17.');
    expect(momentPrompt({ now: at('2026-11-15T10:00:00'), timeZone: zone, profile, state: null })).not.toContain('birthday');
  });
});
