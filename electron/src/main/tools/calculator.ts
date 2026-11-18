// A small arithmetic grammar, with no JavaScript evaluation, property access,
// variables or function calls. Powers associate right; unary minus follows power.
export const calculate = (expression: string): { expression: string; result: number; precision: string } => {
  if (expression.length > 500) throw new RangeError('Expression is too long.');
  const source = expression.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-');
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*/%^]|\S/gu) ?? [];
  let position = 0;
  const finite = (value: number): number => { if (!Number.isFinite(value)) throw new RangeError('Result is not finite.'); return value; };
  const primary = (): number => {
    const token = tokens[position++];
    if (token === '(') {
      const value = sum();
      if (tokens[position++] !== ')') throw new RangeError('Unbalanced parentheses.');
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(token)) throw new RangeError('Expected a number.');
    return finite(Number(token));
  };
  const power = (): number => {
    const value = primary();
    if (tokens[position] !== '^') return value;
    position++; return finite(value ** unary());
  };
  const unary = (): number => {
    if (tokens[position] === '+') { position++; return unary(); }
    if (tokens[position] === '-') { position++; return -unary(); }
    return power();
  };
  const product = (): number => {
    let value = unary();
    while (['*', '/', '%'].includes(tokens[position] ?? '')) {
      const operator = tokens[position++]; const next = unary();
      if ((operator === '/' || operator === '%') && next === 0) throw new RangeError('Division by zero.');
      value = finite(operator === '*' ? value * next : operator === '/' ? value / next : value % next);
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (['+', '-'].includes(tokens[position] ?? '')) {
      const operator = tokens[position++]; const next = product();
      value = finite(operator === '+' ? value + next : value - next);
    }
    return value;
  };
  const result = sum();
  if (position !== tokens.length) throw new RangeError('Unexpected token.');
  return { expression, result: Object.is(result, -0) ? 0 : result, precision: 'IEEE 754 double precision; decimal results may be approximate.' };
};
