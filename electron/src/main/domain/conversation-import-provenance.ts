import { createHash } from 'node:crypto';
import type { ImportedMessage } from '../../shared/conversation-import';
import type { PersistentState } from './schemas';
import { importedMessageSourceEventId, importedSourceCollectionId } from './conversation-import-parser';

type SourceEvent = PersistentState['importedSourceEvents'][number];
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

export const importedSourceEvents = (messages: ImportedMessage[]): SourceEvent[] => {
  const collectionId = importedSourceCollectionId(messages);
  return messages.map((message, index) => ({ sourceEventId: importedMessageSourceEventId(messages, index), collectionId,
    eventFingerprint: digest([normalize(message.speakerId), message.time === null ? null : normalize(message.time), normalize(message.text)]),
    native: message.sourceIdentity === 'native' }));
};

/** Retain hashes after raw-record removal. This is an ambiguity guard, never
 * evidence that matching text identifies the same real-world event. */
export const registerImportedSourceEvents = (state: PersistentState, messages: ImportedMessage[]): void => {
  const key = (event: SourceEvent): string => JSON.stringify([event.sourceEventId, event.eventFingerprint, event.collectionId]);
  const known = new Set(state.importedSourceEvents.map(key));
  for (const event of importedSourceEvents(messages)) {
    if (known.has(key(event))) continue;
    if (state.importedSourceEvents.length >= 100_000) throw new Error('imports.sourceLimit');
    state.importedSourceEvents.push(event); known.add(key(event));
  }
};

export const hasAmbiguousImportedSource = (state: PersistentState, event: SourceEvent, committedSources: Set<string>): boolean => {
  if (committedSources.has(event.sourceEventId)) return false;
  return state.importedSourceEvents.some((known) => known.eventFingerprint === event.eventFingerprint
    && known.sourceEventId !== event.sourceEventId
    // Native IDs distinguish independent events. A legacy/fallback identity
    // cannot establish whether a matching native event is old or independent.
    && (event.native ? !known.native : known.collectionId !== event.collectionId || known.native));
};
