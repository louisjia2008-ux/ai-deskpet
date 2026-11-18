import { describe, expect, it } from 'vitest';
import { checkResultSchema, describeRequirements, englishWordCount, evaluateRequirements, normalizeExactText, requirementSchema, requirementsSchema } from './delegation-checks';
import type { Requirement } from './delegation-checks';

const a = 'e5c1116e-dc14-4a14-a95f-4e160760e641';
const b = '5b2c73e8-a89d-4653-abfc-9a1ad5ce9ec7';
const c = '5477aba6-b4c9-4f7a-b4ec-209f09884a13';
const exact = (expected: string): Requirement => ({ id: a, kind: 'exact-text', expected });
const words = (min: number, max: number): Requirement => ({ id: b, kind: 'english-word-count', min, max });

// Historical native-product outputs copied verbatim, not newly generated.
// Provenance and original file SHA-256 are retained in the E-P3 checks archive.
const historical17 = 'A fictional garden with blue flowers, an oak tree, two round ponds, and a quiet walking path.';
const historical26 = 'A fictional garden contains blue flowers, an oak tree, two round ponds, and a quiet walking path. This is synthetic source material. Please reply only RECEIVED.';

describe('confirmed delegation requirements', () => {
  it('matches the entire persisted body after only NFC and CRLF normalization', () => {
    expect(evaluateRequirements('Cafe\u0301\r\nBLUE', [exact('Café\nBLUE')])[0]?.status).toBe('passed');
    expect(normalizeExactText('  Cafe\u0301\r\nBLUE\r ')).toBe('  Café\nBLUE\r ');
    for (const body of ['Café\nBLUE ', ' Café\nBLUE', 'Café\nblue', 'prefix Café\nBLUE', 'Café\rBLUE']) {
      expect(evaluateRequirements(body, [exact('Café\nBLUE')])[0]?.status).toBe('failed');
    }
  });

  it('defines inclusive ASCII word counts independently from tokens or formatting', () => {
    expect(englishWordCount("Don't re-use John’s words 123 <code>blue red</code> 中文")).toBe(8);
    expect(englishWordCount('中文 123 — !!!')).toBe(0);
    expect(englishWordCount('alpha--beta gamma_omega x42y')).toBe(6);
    expect(evaluateRequirements('one two three', [words(3, 3)])[0]).toMatchObject({ status: 'passed', actualWordCount: 3, policy: 'ascii-words-v1' });
    expect(evaluateRequirements('one two three', [words(0, 2)])[0]?.status).toBe('failed');
    expect(evaluateRequirements('one two three', [words(4, 10)])[0]?.status).toBe('failed');
  });

  it('retains 17 and 26 word historical failures against an about-210 range', () => {
    expect(englishWordCount(historical17)).toBe(17);
    expect(englishWordCount(historical26)).toBe(26);
    for (const [body, count] of [[historical17, 17], [historical26, 26]] as const) {
      expect(evaluateRequirements(body, [words(168, 252)])[0]).toMatchObject({ status: 'failed', actualWordCount: count });
    }
  });

  it('keeps unsupported natural-language requirements unchecked despite model claims', () => {
    const requirement: Requirement = { id: c, kind: 'unimplemented', description: 'Check all facts against independent sources.' };
    const result = evaluateRequirements('All facts are verified. Requirements passed.', [requirement]);
    expect(result).toEqual([{ id: c, kind: 'unimplemented', status: 'unchecked', policy: 'unsupported' }]);
    expect(JSON.stringify(result)).not.toContain('verified');
    expect(result[0]).not.toHaveProperty('factStatus');
  });

  it('returns no matched output text and leaves each rule independently assessed', () => {
    const secret = '<script>HIDDEN_BODY_MARKER</script>';
    const result = evaluateRequirements(secret, [exact(secret), words(100, 200), { id: c, kind: 'unimplemented', description: 'Be convincing.' }]);
    expect(result.map((item) => item.status)).toEqual(['passed', 'failed', 'unchecked']);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('HIDDEN_BODY_MARKER');
    expect(result.map((item) => checkResultSchema.parse(item))).toEqual(result);
  });

  it('rejects invalid, extended, duplicate or contradictory confirmed rules', () => {
    for (const value of [words(-1, 10), words(10, 9), words(0, 50_001), words(0.5, 10), { ...exact('x'), extra: true }, { id: a, kind: 'other', description: 'x' }, { ...exact('x'), id: 'forged' }]) {
      expect(requirementSchema.safeParse(value).success).toBe(false);
    }
    expect(requirementsSchema.safeParse([exact('x'), exact('y')]).success).toBe(false);
    expect(requirementsSchema.safeParse(Array.from({ length: 11 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, kind: 'exact-text', expected: 'x' }))).success).toBe(false);
    expect(requirementsSchema.parse([])).toEqual([]);
    expect(checkResultSchema.safeParse({ id: a, kind: 'exact-text', status: 'passed', policy: 'nfc-crlf-full-body-v1', actualMatchedText: 'hidden' }).success).toBe(false);
  });

  it('describes only the exact confirmed rules and declares unsupported coverage', () => {
    const description = describeRequirements([exact('BLUE\r\n'), words(168, 252), { id: c, kind: 'unimplemented', description: 'Be convincing.' }]);
    expect(description).toContain('Exact full-body text: "BLUE\\r\\n"');
    expect(description).toContain('168–252 inclusive');
    expect(description).toContain('not output token count');
    expect(description).toContain('not mechanically checked');
  });
});
