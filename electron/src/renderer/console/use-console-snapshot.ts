import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, CharacterState, ChatSession, DeskTask, FocusSession, MemoryItem, PermissionDescriptor, ProviderConfig, RelationshipState } from '../../shared';
import type { AttentionSnapshot } from '../../shared/attention';

export interface ConsoleSnapshot {
  attention: AttentionSnapshot | null;
  app: AppState;
  character: CharacterState;
  sessions: ChatSession[];
  tasks: DeskTask[];
  focus: FocusSession | null;
  memories: MemoryItem[];
  relationship: RelationshipState;
  providers: ProviderConfig[];
  permissions: PermissionDescriptor[];
}
type Key = keyof ConsoleSnapshot;
const loaders: { [K in Key]: () => Promise<ConsoleSnapshot[K]> } = {
  app: () => window.deskpet.app.getState(),
  character: () => window.deskpet.character.getState(),
  sessions: () => window.deskpet.chat.listSessions({ scope: 'all' }),
  tasks: () => window.deskpet.tasks.list(),
  focus: () => window.deskpet.tasks.getFocus(),
  memories: () => window.deskpet.memory.list(),
  relationship: () => window.deskpet.relationship.get(),
  providers: () => window.deskpet.providers.list(),
  permissions: () => window.deskpet.permissions.list(),
  attention: () => window.deskpet.attention.snapshot().catch(() => null),
};
const keys = Object.keys(loaders) as Key[];

/** Payload events update one slice. Revisions prevent a slow read from
 * overwriting a newer event or read, including during initial loading. */
export const useConsoleSnapshot = () => {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [error, setError] = useState(false);
  const values = useRef<Partial<ConsoleSnapshot>>({});
  const revisions = useRef<Partial<Record<Key, number>>>({});
  const failures = useRef(new Set<Key>());
  const mounted = useRef(false);
  const update = useCallback(<K extends Key>(key: K, value: ConsoleSnapshot[K]) => {
    revisions.current[key] = (revisions.current[key] ?? 0) + 1;
    values.current[key] = value;
    failures.current.delete(key);
    if (mounted.current) {
      if (keys.every(key => Object.hasOwn(values.current, key))) setSnapshot({ ...values.current } as ConsoleSnapshot);
      setError(failures.current.size > 0);
    }
  }, []);
  const reload = useCallback(async (selected: readonly Key[]): Promise<void> => {
    await Promise.all(selected.map(async key => {
      const revision = (revisions.current[key] ?? 0) + 1;
      revisions.current[key] = revision;
      try {
        const value = await loaders[key]();
        if (mounted.current && revisions.current[key] === revision) update(key, value);
      } catch {
        if (mounted.current && revisions.current[key] === revision) { failures.current.add(key); setError(true); }
      }
    }));
  }, [update]);
  const refresh = useCallback(() => reload(keys), [reload]);
  useEffect(() => {
    mounted.current = true;
    const currentRevisions = revisions.current;
    const pending = new Set<Key>();
    const schedule = (...selected: Key[]): void => {
      const scheduled = pending.size > 0;
      selected.forEach(key => pending.add(key));
      if (!scheduled) void Promise.resolve().then(() => {
        if (!mounted.current) return;
        const selected = [...pending]; pending.clear(); void reload(selected);
      });
    };
    const unsubscribe = [
      window.deskpet.app.onChanged(value => update('app', value)),
      window.deskpet.character.onChanged(value => update('character', value)),
      window.deskpet.memory.onChanged(value => update('memories', value)),
      window.deskpet.relationship.onChanged(value => update('relationship', value)),
      window.deskpet.providers.onChanged(value => update('providers', value)),
      window.deskpet.permissions.onChanged(value => update('permissions', value)),
      window.deskpet.attention.onChanged?.(() => schedule('attention')) ?? (() => undefined),
      window.deskpet.chat.onSessionsChanged(() => schedule('sessions')),
      window.deskpet.tasks.onChanged(() => schedule('tasks', 'focus')),
    ];
    void refresh();
    return () => {
      mounted.current = false;
      keys.forEach(key => { currentRevisions[key] = (currentRevisions[key] ?? 0) + 1; });
      pending.clear(); unsubscribe.forEach(stop => stop());
    };
  }, [refresh, reload, update]);
  return { snapshot, error, refresh };
};
