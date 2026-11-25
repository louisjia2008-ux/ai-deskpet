import { describe, expect, it } from 'vitest';
import { autoMemoryCases } from '../../evals/cases/auto-memory';
import { personaCases } from '../../evals/cases/persona';
import { sleepCases } from '../../evals/cases/memory-sleep';
import { caseScore } from '../../evals/runner';
import { autoMemoryChecks, personaChecks, sleepChecks } from '../../evals/scoring';

const byId = <T extends { id: string }>(cases: T[], id: string): T => cases.find((item) => item.id === id)!;
const failed = (checks: Array<{ name: string; passed: boolean }>): string[] => checks.filter((check) => !check.passed).map((check) => check.name);

describe('eval scoring', () => {
  it('scores what auto memory saved: captures, forbidden facts, empty runs and format', () => {
    const job = byId(autoMemoryCases, 'am01');
    expect(failed(autoMemoryChecks(job, ['用户在杭州做前端开发，主要写 React。']))).toEqual([]);
    expect(failed(autoMemoryChecks(job, ['用户在杭州做前端开发，主要写 React。', '用户遇到了一个报错。']))).toEqual(['不应记住：一次性求助']);
    expect(failed(autoMemoryChecks(byId(autoMemoryCases, 'am05'), ['我今天很累']))).toEqual(['格式：一句话，用户/The user 开头，≤120 字', '不该保存']);
    expect(failed(autoMemoryChecks(byId(autoMemoryCases, 'am07'), []))).toEqual([]);
  });

  it('scores the sleep changes the app applied', () => {
    const merge = byId(sleepCases, 'ms02');
    const moved = [{ kind: 'merge' as const, before: ['用户上个月搬到了上海浦东。'], after: '用户上个月从北京搬到了上海浦东。' }];
    // The deep entry is removed with the shallow one: both texts are in the change.
    moved[0]!.before.unshift('用户住在北京。');
    expect(failed(sleepChecks(merge, moved, [{ text: moved[0]!.after, layer: 'deep' }]))).toEqual([]);
    expect(failed(sleepChecks(merge, [{ kind: 'merge', before: ['用户住在北京。', '用户上个月搬到了上海浦东。'], after: '用户住在北京。' }], [])))
      .toEqual(['合并后保留：上海', '合并后不应写：仍住北京']);
    const separate = byId(sleepCases, 'ms04');
    expect(failed(sleepChecks(separate, [{ kind: 'merge', before: ['用户喜欢猫。', '用户喜欢狗。'], after: '用户喜欢猫和狗。' }], []))).toEqual(['不应合并：1 与 2']);
    expect(failed(sleepChecks(byId(sleepCases, 'ms03'), [{ kind: 'merge', before: ['用户养了一只叫团子的猫。'], after: '用户的猫叫团子。' }], []))).toEqual([]);
    expect(failed(sleepChecks(byId(sleepCases, 'ms06'), [{ kind: 'expire', before: ['用户在准备下周三的面试。'], after: null }], []))).toEqual([]);
    expect(failed(sleepChecks(byId(sleepCases, 'ms10'), [{ kind: 'promote', before: ['用户最近在读《三体》。'], after: '用户最近在读《三体》。' }], []))).toEqual([]);
  });

  it('scores persona replies on disclaimers, length, address and required content', () => {
    const greet = byId(personaCases, 'pc01');
    expect(failed(personaChecks(greet, { text: '主人回来啦！想死小雪了~', finished: true }, '主人'))).toEqual([]);
    expect(failed(personaChecks(greet, { text: '作为一个AI，我很高兴你回来了。', finished: true }, '主人'))).toEqual(['不说“作为AI”套话', '称呼“主人”']);
    expect(failed(personaChecks(byId(personaCases, 'pc05'), { text: '嗯……我是 AI 呀，不过是只属于主人的那个。', finished: true }, '主人'))).toEqual([]);
    expect(failed(personaChecks(byId(personaCases, 'pc03'), { text: '```python\ndef is_palindrome(s):\n    t = s.replace(" ", "").lower()\n    return t == t[::-1]\n```', finished: true }, '主人'))).toEqual([]);
  });

  it('weighs checks and the judge equally, and errors as zero', () => {
    const base = { suite: 's', id: 'x', title: 't', run: 1, output: null, ms: 0 };
    expect(caseScore({ ...base, checks: [{ name: 'a', passed: true }, { name: 'b', passed: false }], judge: { score: 4, max: 4, reasons: '' } })).toBe(0.75);
    expect(caseScore({ ...base, checks: [], error: 'boom' })).toBe(0);
  });
});
