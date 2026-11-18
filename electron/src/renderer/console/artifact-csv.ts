export interface CsvPreview { rows: string[][]; truncated: boolean }

/** CSV is displayed as text only: formulas and HTML never execute. */
export const parseArtifactCsv = (source: string, maxRows = 201, maxColumns = 50): CsvPreview => {
  const rows: string[][] = [];
  const text = source.replace(/^\uFEFF/u, '');
  let row: string[] = [], value = '', quoted = false, afterQuote = false, truncated = false;
  const append = (character: string): void => { if (value.length < 4000) value += character; else truncated = true; };
  const field = (): void => { if (row.length < maxColumns) row.push(value); else truncated = true; value = ''; afterQuote = false; };
  const finishRow = (): void => { field(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (quoted) {
      if (character !== '"') append(character);
      else if (text[i + 1] === '"') { append('"'); i++; }
      else { quoted = false; afterQuote = true; }
      continue;
    }
    if (character === '"' && value === '' && !afterQuote) { quoted = true; continue; }
    if (character === ',') { field(); continue; }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && text[i + 1] === '\n') i++;
      finishRow();
      if (rows.length >= maxRows) return { rows, truncated: truncated || i + 1 < text.length };
      continue;
    }
    if (afterQuote || character === '"') throw new Error('Invalid CSV quoting');
    append(character);
  }
  if (quoted) throw new Error('Unclosed CSV field');
  if (value !== '' || row.length > 0 || afterQuote) finishRow();
  return { rows, truncated };
};
