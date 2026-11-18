import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { SkillCatalogEntry } from '../../shared/desktop-extensions';
import { SkillToolAccess } from '../tools/skill-tools';
import { parseSkillCommand, pickSkill, skillInstruction, skillListReply } from './skill-command';

const entry = (name: string, exposure?: 'public' | 'local-only'): SkillCatalogEntry => ({
  id: randomUUID(), name, description: '', digest: 'b'.repeat(64), revision: 2, ...(exposure ? { exposure } : {}) });
const skills = [entry('中英写作与文档共创', 'public'), entry('资料归纳与证据检查'), entry('IB Economics 双语讲解与答题自检'), entry('项目复盘与发布检查')];

it('parses list and use forms and leaves other slash text alone', () => {
  expect(parseSkillCommand('/skill')).toEqual({ kind: 'list' });
  expect(parseSkillCommand(' /Skills ')).toEqual({ kind: 'list' });
  expect(parseSkillCommand('/skill 写作 帮我润色\n第二段也要')).toEqual({ kind: 'use', selector: '写作', task: '帮我润色\n第二段也要' });
  expect(parseSkillCommand('/skill 2')).toEqual({ kind: 'use', selector: '2', task: null });
  expect(parseSkillCommand('/skillful idea')).toBeNull();
  expect(parseSkillCommand('please /skill 1 x')).toBeNull();
});

it('picks by number, exact name or a unique part of a name', () => {
  expect(pickSkill(skills, '1')).toEqual({ found: skills[0] });
  expect(pickSkill(skills, '9')).toEqual({ none: true });
  expect(pickSkill(skills, 'ib')).toEqual({ found: skills[2] });
  expect(pickSkill(skills, '检查')).toEqual({ several: [skills[1], skills[3]] });
  expect(pickSkill(skills, '项目复盘与发布检查')).toEqual({ found: skills[3] });
});

it('lists skills with where each may run and frames the text as a method, not authority', () => {
  const list = skillListReply(skills, true);
  expect(list).toContain('1. 中英写作与文档共创（可配合云端模型）');
  expect(list).toContain('2. 资料归纳与证据检查（仅限本机模型）');
  expect(skillListReply([], false)).toContain('No skills are enabled');
  const instruction = skillInstruction({ ...skills[0]!, name: 'Say "hi"', text: 'STEP ONE' });
  expect(instruction).toContain('grants no permission');
  expect(instruction).toContain('<skill name="Say \'hi\'">\nSTEP ONE\n</skill>');
});

it('attaches the chosen revision with the same privacy and revocation rules as skills.read', () => {
  const privateSkill = skills[1]!, publicSkill = skills[0]!;
  const assert = vi.fn(), localDesktop = vi.fn(() => false);
  const read = vi.fn((id: string) => ({ ...skills.find(item => item.id === id)!, text: 'BODY' }));
  const access = new SkillToolAccess({ localDesktop, desktop: () => true, catalog: () => skills, assert, read });
  expect(() => access.attach('run', privateSkill)).toThrow('tool.contextPrivacyBlocked');
  expect(read).not.toHaveBeenCalled();
  expect(access.attach('run', publicSkill)).toMatchObject({ id: publicSkill.id, text: 'BODY', privacy: 'cloud-allowed', trust: 'reference-only' });
  localDesktop.mockReturnValue(true);
  expect(access.attach('local-run', privateSkill)).toMatchObject({ privacy: 'local-only' });
  expect(() => access.attach('other', { ...publicSkill, revision: 1 })).toThrow('tool.notRequested');
  assert.mockImplementation(() => { throw new Error('extensions.changed'); });
  expect(access.invalidatedRuns()).toEqual(['run', 'local-run']);
});
