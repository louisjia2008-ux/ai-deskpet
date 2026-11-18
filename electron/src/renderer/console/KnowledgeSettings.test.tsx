import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { KnowledgeAPI, KnowledgeFolder, KnowledgeHit, KnowledgeStatus } from '../../shared/knowledge';
import { DEFAULT_KNOWLEDGE_DIARY_FOLDER } from '../../shared/knowledge';
import { KnowledgeSettings } from './KnowledgeSettings';

afterEach(cleanup);
const selected: KnowledgeStatus = {
  vaultName: 'Fixture vault',
  indexing: false,
  indexedNotes: 2,
  indexedChunks: 3,
  checkedNotes: 2,
  changedNotes: 0,
  removedNotes: 0,
  skippedNotes: 0,
  lastIndexedAt: null,
  lastIndexFailureAt: null,
  consecutiveIndexFailures: 0,
  lastError: null,
  embeddingModel: 'nomic-embed-text',
  embeddingStatus: 'installed',
  autoIndex: true,
  diarySync: { enabled: false, folder: DEFAULT_KNOWLEDGE_DIARY_FOLDER },
  retainedInvalidDiaries: 0,
};
const hit: KnowledgeHit = {
  path: 'notes/one.md', startLine: 8, endLine: 9, excerpt: '<b>untrusted text</b>', score: 0.8, revision: 'fixture',
};
const rootFolders: KnowledgeFolder[] = [
  { name: null, sharing: 'local', writable: false, diaryProtected: false },
  { name: 'Project', sharing: 'local', writable: false, diaryProtected: false },
  { name: '收集', sharing: 'local', writable: true, diaryProtected: false },
  { name: DEFAULT_KNOWLEDGE_DIARY_FOLDER, sharing: 'local', writable: false, diaryProtected: false },
];

function fixture(overrides: Partial<KnowledgeAPI> = {}) {
  let status = selected;
  let folders = rootFolders;
  const api = {
    getState: vi.fn(async () => status),
    ask: vi.fn(async () => ({ answer: 'answer', sources: [] })),
    chooseVault: vi.fn(async () => status = selected),
    reindex: vi.fn(async () => status),
    search: vi.fn(async () => [hit]),
    detach: vi.fn(async () => status = { ...selected, vaultName: null, indexedNotes: 0, indexedChunks: 0 }),
    listFolders: vi.fn(async () => folders),
    setFolderSharing: vi.fn<KnowledgeAPI['setFolderSharing']>(async ({ folder, level }) =>
      folders = folders.map(entry => entry.name === folder ? { ...entry, sharing: level } : entry)),
    setWritableFolders: vi.fn<KnowledgeAPI['setWritableFolders']>(async allowed =>
      folders = folders.map(entry => ({ ...entry, writable: entry.name !== null && allowed.includes(entry.name) }))),
    setEmbeddingModel: vi.fn<KnowledgeAPI['setEmbeddingModel']>(async model =>
      status = { ...status, embeddingModel: model, embeddingStatus: 'missing' }),
    setAutoIndex: vi.fn<KnowledgeAPI['setAutoIndex']>(async enabled => status = { ...status, autoIndex: enabled }),
    setDiarySync: vi.fn<KnowledgeAPI['setDiarySync']>(async diarySync => {
      folders = folders.map(folder => folder.name === diarySync.folder && diarySync.enabled
        ? { ...folder, diaryProtected: true, sharing: 'local', writable: false }
        : folder);
      return status = { ...status, diarySync };
    }),
    ...overrides,
  } satisfies KnowledgeAPI;
  Object.defineProperty(window, 'deskpet', {
    configurable: true,
    value: { knowledge: api, providers: { list: async () => [] } },
  });
  render(<KnowledgeSettings locale="en" />);
  return api;
}
const search = async (): Promise<void> => {
  await screen.findByText(/Fixture vault/u);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search note excerpts' }), { target: { value: 'where' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/u }));
};

it('shows version-checked note excerpts as text, clears them after detach, and uses the native vault picker', async () => {
  const api = fixture();
  await search();
  expect(await screen.findByText('notes/one.md')).toBeInTheDocument();
  expect(screen.getByText('<b>untrusted text</b>').tagName).toBe('P');
  expect(screen.getByText('lines 8–9')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect and remove index' }));
  await screen.findByText('No vault selected');
  expect(screen.queryByText('notes/one.md')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Choose vault' }));
  await waitFor(() => expect(api.chooseVault).toHaveBeenCalledExactlyOnceWith());
});

it('sets folder sharing and write permissions independently and shows the selected missing model command', async () => {
  const api = fixture();
  const projectShare = await screen.findByRole('switch', { name: 'Allow Project to leave this computer' });
  const rootShare = screen.getByRole('switch', { name: 'Allow Notes in the vault root to leave this computer' });
  const projectWrite = screen.getByRole('switch', { name: 'Can create notes in Project' });
  const collectionWrite = screen.getByRole('switch', { name: 'Can create notes in 收集' });
  expect(rootShare).not.toBeChecked();
  expect(projectShare).not.toBeChecked();
  expect(projectWrite).not.toBeChecked();
  expect(collectionWrite).toBeChecked();
  expect(screen.queryByRole('switch', { name: 'Can create notes in Notes in the vault root' })).toBeNull();

  fireEvent.click(projectShare);
  await waitFor(() => expect(projectShare).toBeChecked());
  expect(api.setFolderSharing).toHaveBeenCalledExactlyOnceWith({ folder: 'Project', level: 'shareable' });
  expect(projectWrite).not.toBeChecked();

  fireEvent.click(projectWrite);
  await waitFor(() => expect(projectWrite).toBeChecked());
  expect(api.setWritableFolders).toHaveBeenCalledExactlyOnceWith(['收集', 'Project']);
  expect(rootShare).not.toBeChecked();

  fireEvent.change(screen.getByRole('combobox', { name: 'Embedding model' }), { target: { value: 'qwen3-embedding:0.6b' } });
  expect(await screen.findByText('ollama pull qwen3-embedding:0.6b')).toBeInTheDocument();
  expect(api.setEmbeddingModel).toHaveBeenCalledExactlyOnceWith('qwen3-embedding:0.6b');

  const auto = screen.getByRole('switch', { name: 'Automatic indexing' });
  expect(auto).toBeChecked();
  fireEvent.click(auto);
  await waitFor(() => expect(auto).not.toBeChecked());
  expect(api.setAutoIndex).toHaveBeenCalledExactlyOnceWith(false);
});

it('does not restore search excerpts from a pending response after detaching', async () => {
  let resolve!: (hits: KnowledgeHit[]) => void;
  const pending = new Promise<KnowledgeHit[]>(done => { resolve = done; });
  fixture({ search: () => pending });
  await search();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect and remove index' }));
  await screen.findByText('No vault selected');
  await act(async () => resolve([hit]));
  expect(screen.queryByText(hit.path)).toBeNull();
});


it('starts diary sync off and reserves the local-only destination while copies remain', async () => {
  const api = fixture();
  const sync = await screen.findByRole('switch', { name: 'Sync her diary' });
  const folder = screen.getByRole('textbox', { name: 'Diary folder' });
  const sharing = await screen.findByRole('switch', { name: 'Allow 日记 to leave this computer' });
  expect(sync).not.toBeChecked();
  expect(folder).toHaveValue(DEFAULT_KNOWLEDGE_DIARY_FOLDER);
  expect(sharing).toBeEnabled();
  expect(screen.getByRole('switch', { name: 'Can create notes in 日记' })).toBeVisible();

  fireEvent.click(sync);
  await waitFor(() => expect(sync).toBeChecked());
  expect(api.setDiarySync).toHaveBeenCalledExactlyOnceWith({ enabled: true, folder: DEFAULT_KNOWLEDGE_DIARY_FOLDER });
  expect(sharing).not.toBeChecked();
  expect(sharing).toBeDisabled();
  expect(screen.queryByRole('switch', { name: 'Can create notes in 日记' })).toBeNull();

  fireEvent.click(sync);
  await waitFor(() => expect(sync).not.toBeChecked());
  expect(api.setDiarySync).toHaveBeenLastCalledWith({ enabled: false, folder: DEFAULT_KNOWLEDGE_DIARY_FOLDER });
  expect(sharing).toBeDisabled();
  expect(screen.getByText(/continues checking for invalid copies until you disconnect the vault/u)).toBeVisible();
});

it('validates the top-level folder draft and gives a specific remedy for a shared destination', async () => {
  const setDiarySync = vi.fn<KnowledgeAPI['setDiarySync']>().mockRejectedValue(
    new Error('Error invoking IPC: knowledge.diaryFolderShareable'),
  );
  const api = fixture({ setDiarySync });
  const sync = await screen.findByRole('switch', { name: 'Sync her diary' });
  const folder = screen.getByRole('textbox', { name: 'Diary folder' });
  const save = screen.getByRole('button', { name: 'Save diary folder' });

  fireEvent.change(folder, { target: { value: '../outside' } });
  expect(folder).toHaveAttribute('aria-invalid', 'true');
  expect(sync).toBeDisabled();
  expect(save).toBeDisabled();
  expect(api.setDiarySync).not.toHaveBeenCalled();

  fireEvent.change(folder, { target: { value: 'Project' } });
  fireEvent.click(sync);
  expect(await screen.findByRole('alert')).toHaveTextContent('Turn off sharing for it or choose another top-level folder.');
  expect(sync).not.toBeChecked();
  expect(api.setDiarySync).toHaveBeenCalledExactlyOnceWith({ enabled: true, folder: 'Project' });
});
