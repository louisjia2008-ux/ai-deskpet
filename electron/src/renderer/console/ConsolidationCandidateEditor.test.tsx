import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConsolidationCandidate, ConsolidationSource } from '../../shared/consolidation';
import { ConsolidationCandidateEditor } from './ConsolidationCandidateEditor';

afterEach(cleanup);
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const source = (id: string, text: string) => ({ id, text } as ConsolidationSource);
const candidate: ConsolidationCandidate = { segments: [{ text: 'Likes jasmine tea', sourceIds: [a] }], coveredMemoryIds: [a], uncoveredMemoryIds: [b], conflicts: [] };

it('edits the candidate as readable memories and sources, never as ids', () => {
  const onChange = vi.fn();
  render(<ConsolidationCandidateEditor value={JSON.stringify(candidate)} sources={[source(a, 'Prefers jasmine tea'), source(b, 'Drinks tea at night')]} disabled={false} zh={false} onChange={onChange} />);
  expect(screen.queryByText(a)).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Memory 1' }), { target: { value: '' } });
  expect(JSON.parse(onChange.mock.lastCall![0] as string).segments[0].text).toBe('');
  fireEvent.click(screen.getAllByRole('checkbox', { name: 'Drinks tea at night' })[0]!);
  expect(JSON.parse(onChange.mock.lastCall![0] as string).segments[0].sourceIds).toEqual([a, b]);
  // The last remaining source cannot be unticked: a memory always rests on something.
  onChange.mockClear();
  fireEvent.click(screen.getAllByRole('checkbox', { name: 'Prefers jasmine tea' })[0]!);
  expect(onChange).not.toHaveBeenCalled();
  const concerns = screen.getByRole('textbox', { name: 'Open concerns (one per line)' });
  fireEvent.change(concerns, { target: { value: 'first\n' } });
  expect(concerns).toHaveValue('first\n');
  fireEvent.blur(concerns, { target: { value: 'first\n second ' } });
  expect(JSON.parse(onChange.mock.lastCall![0] as string).conflicts).toEqual(['first', 'second']);
});
