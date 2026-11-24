import type { JSX } from 'react';
import type { ConsolidationCandidate, ConsolidationSource } from '../../shared/consolidation';

// Read loosely while editing (an emptied text box is a normal intermediate state); saving still validates fully.
const parse = (value: string): ConsolidationCandidate | null => {
  try {
    const raw = JSON.parse(value) as Partial<ConsolidationCandidate>;
    const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string');
    return Array.isArray(raw.segments) && raw.segments.every(item => typeof item?.text === 'string' && strings(item.sourceIds))
      && strings(raw.coveredMemoryIds) && strings(raw.uncoveredMemoryIds) && strings(raw.conflicts) ? raw as ConsolidationCandidate : null;
  } catch { return null; }
};
const toggle = (list: readonly string[], id: string, on: boolean): string[] => on ? [...new Set([...list, id])] : list.filter(item => item !== id);
const short = (text: string): string => text.length > 36 ? `${text.slice(0, 36)}…` : text;

/**
 * The candidate as people read it: each proposed memory as text with the source memories it rests on,
 * which sources it covers, and open concerns. It edits the same structured candidate the review saves;
 * the raw form stays available under technical details.
 */
export function ConsolidationCandidateEditor({ value, sources, disabled, zh, onChange }: {
  value: string; sources: readonly ConsolidationSource[]; disabled: boolean; zh: boolean; onChange(next: string): void;
}): JSX.Element | null {
  const candidate = parse(value);
  if (candidate === null) return null;
  const write = (next: ConsolidationCandidate): void => onChange(JSON.stringify(next, null, 2));
  const label = (id: string): string => short(sources.find(source => source.id === id)?.text ?? id);
  return <div className="consolidation-editor">
    <h4>{zh ? '拟保存的记忆' : 'Memories to save'}</h4>
    {candidate.segments.map((segment, index) => <fieldset key={index} className="consolidation-segment">
      <legend>{zh ? `第 ${index + 1} 条` : `Memory ${index + 1}`}</legend>
      <textarea aria-label={zh ? `第 ${index + 1} 条记忆` : `Memory ${index + 1}`} value={segment.text} maxLength={6000} disabled={disabled}
        onChange={event => write({ ...candidate, segments: candidate.segments.map((item, at) => at === index ? { ...item, text: event.target.value } : item) })} />
      <div className="consolidation-sources" role="group" aria-label={zh ? '依据的原记忆' : 'Based on'}>
        <small>{zh ? '依据：' : 'Based on: '}</small>
        {sources.map(source => <label key={source.id} className="check-row"><input type="checkbox" disabled={disabled}
          checked={segment.sourceIds.includes(source.id)}
          // A memory must rest on at least one source.
          onChange={event => { const ids = toggle(segment.sourceIds, source.id, event.target.checked); if (ids.length) write({ ...candidate, segments: candidate.segments.map((item, at) => at === index ? { ...item, sourceIds: ids } : item) }); }} />{label(source.id)}</label>)}
      </div>
      {candidate.segments.length > 1 && <button type="button" className="text-button" disabled={disabled}
        onClick={() => write({ ...candidate, segments: candidate.segments.filter((_item, at) => at !== index) })}>{zh ? '去掉这条' : 'Remove this one'}</button>}
    </fieldset>)}
    <h4>{zh ? '这次概括了哪些原记忆' : 'Which originals this covers'}</h4>
    <div role="group" aria-label={zh ? '已概括的原记忆' : 'Covered originals'}>{sources.map(source => <label key={source.id} className="check-row"><input type="checkbox" disabled={disabled}
      checked={candidate.coveredMemoryIds.includes(source.id)}
      onChange={event => {
        const covered = toggle(candidate.coveredMemoryIds, source.id, event.target.checked);
        if (covered.length) write({ ...candidate, coveredMemoryIds: covered, uncoveredMemoryIds: toggle(candidate.uncoveredMemoryIds, source.id, !event.target.checked) });
      }} />{label(source.id)}</label>)}</div>
    {/* Lines are tidied when leaving the box, so typing a new line is never swallowed. */}
    <label>{zh ? '还拿不准的地方（每行一条）' : 'Open concerns (one per line)'}<textarea key={candidate.conflicts.join('\n')} defaultValue={candidate.conflicts.join('\n')} disabled={disabled}
      onBlur={event => write({ ...candidate, conflicts: event.target.value.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 20) })} /></label>
  </div>;
}
