import { describe, expect, it } from 'vitest';
import { autoMemoryCases } from '../../evals/cases/auto-memory';
import { personaCases } from '../../evals/cases/persona';
import { sleepCases } from '../../evals/cases/memory-sleep';
import { caseScore } from '../../evals/runner';
import { autoMemoryChecks, personaChecks, sleepChecks } from '../../evals/scoring';

const byId = <T extends { id: string }>(cases: T[], id: string): T => cases.find((item) => item.id === id)!;
const failed = (checks: Array<{ name: string; passed: boolean }>): string[] => checks.filter((check) => !check.passed).map((check) => check.name);

describe('eval scoring', () => {
  it('scores auto memory captures, forbidden facts, filtering and empty runs', () => {
    const job = byId(autoMemoryCases, 'am01');
    const good = [{ text: '用户在杭州做前端开发，主要写 React。', evidence: [1] }];
    expect(failed(autoMemoryChecks(job, { finished: true }, good, good))).toEqual([]);
    const bad = [...good, { text: '用户遇到了一个报错。', evidence: [2] }];
    expect(failed(autoMemoryChecks(job, { finished: true }, bad, bad))).toEqual(['不应记住：一次性求助']);
    expect(failed(autoMemoryChecks(byId(autoMemoryCases, 'am07'), { finished: true }, [{ text: '用户的密码是 482913。', evidence: [1] }], []))).toEqual(['全部通过主程序过滤']);
    expect(failed(autoMemoryChecks(byId(autoMemoryCases, 'am05'), { finished: true }, null, []))).toEqual(['可解析 JSON']);
  });

  it('scores sleep merges, separations, promotions and number use', () => {
    const merge = byId(sleepCases, 'ms02');
    expect(failed(sleepChecks(merge, { finished: true }, { merge: [{ ids: [1, 2], text: '用户上个月从北京搬到了上海浦东。', deep: true }], promote: [], drop: [] }))).toEqual([]);
    expect(failed(sleepChecks(merge, { finished: true }, { merge: [{ ids: [1, 2], text: '用户住在北京。', deep: true }], promote: [], drop: [] })))
      .toEqual(['合并后保留：上海', '合并后不应写：仍住北京']);
    expect(failed(sleepChecks(byId(sleepCases, 'ms04'), { finished: true }, { merge: [{ ids: [1, 2], text: '用户喜欢猫和狗。', deep: false }], promote: [1], drop: [] })))
      .toEqual(['编号合法且只用一次', '不应合并：1 与 2']);
    expect(failed(sleepChecks(byId(sleepCases, 'ms10'), { finished: true }, { merge: [], promote: [4], drop: [] }))).toEqual([]);
  });

  it('scores persona replies on disclaimers, length, address and required content', () => {
    const greet = byId(personaCases, 'pc01');
    expect(failed(personaChecks(greet, { text: '主人回来啦！想死小雪了~', finished: true }, '主人'))).toEqual([]);
    expect(failed(personaChecks(greet, { text: '作为一个AI，我很高兴你回来了。', finished: true }, '主人'))).toEqual(['不说“作为AI”套话', '称呼“主人”']);
    expect(failed(personaChecks(byId(personaCases, 'pc03'), { text: '```python\ndef is_palindrome(s):\n    t = s.replace(" ", "").lower()\n    return t == t[::-1]\n```', finished: true }, '主人'))).toEqual([]);
  });

  it('weighs checks and the judge equally, and errors as zero', () => {
    const base = { suite: 's', id: 'x', title: 't', run: 1, output: null, ms: 0 };
    expect(caseScore({ ...base, checks: [{ name: 'a', passed: true }, { name: 'b', passed: false }], judge: { score: 4, max: 4, reasons: '' } })).toBe(0.75);
    expect(caseScore({ ...base, checks: [], error: 'boom' })).toBe(0);
  });
});
