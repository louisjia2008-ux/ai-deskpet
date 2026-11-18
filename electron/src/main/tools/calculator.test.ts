import { describe, expect, it } from 'vitest';
import { calculate } from './calculator';

describe('bounded arithmetic calculator', () => {
  it.each([
    ['(37×24−128)÷8', 95], ['2^3^2', 512], ['-2^2', -4], ['2^-3', 0.125],
    ['(-2)^2', 4], ['17%5', 2], ['1.2e3 + .5', 1200.5], ['1--2', 3], ['-(2+3)*4', -20],
  ])('evaluates %s with correct precedence', (expression, result) => {
    expect(calculate(expression)).toMatchObject({ expression, result });
  });
  it.each(['', '1/0', '5%0', '1e999', '(-1)^.5', '2^1024', '(2+3', '2(3)', '1 2', 'Math.random()', 'process.exit()', '1;2', '0x10', '*2', '2**3', '('.repeat(501)])('rejects invalid or executable input %s', (expression) => {
    expect(() => calculate(expression)).toThrow(RangeError);
  });
});
