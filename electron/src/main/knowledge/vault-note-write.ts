import { join } from 'node:path';
import type { KnowledgeNoteDraft, KnowledgeNoteSource } from '../../shared/knowledge';
import { WorkspaceAccess, WorkspaceOutputExists } from '../tools/workspace';
import { folderIdentity, pathMissing, type FolderIdentity } from './vault-folders';

const MAX_TITLE_BYTES = 160;
const MAX_MARKDOWN_LENGTH = 50_000;
const MAX_NAME_ATTEMPTS = 1000;

export function prepareNoteDraft(input: KnowledgeNoteDraft, source: KnowledgeNoteSource): { stem: string; content: string } {
  if (!input.markdown.trim() || input.markdown.length > MAX_MARKDOWN_LENGTH || input.markdown.includes('\0')) {
    throw new Error('knowledge.noteInvalid');
  }
  const title = input.title.normalize('NFC').replace(/[/\\:*?"<>|\p{Cc}\p{Cf}]/gu, '').replace(/^[.\s]+/u, '').trim();
  let stem = '';
  for (const character of title) {
    if (Buffer.byteLength(stem + character) > MAX_TITLE_BYTES) break;
    stem += character;
  }
  stem = stem.trimEnd();
  if (!stem) throw new Error('knowledge.noteInvalid');
  const content = `---\ncreated: ${new Date().toISOString()}\nsource: ${source}\nby: deskpet\n---\n\n${input.markdown}`;
  return { stem, content };
}

export async function publishVaultNote(
  root: FolderIdentity & { path: string }, folder: string, approved: FolderIdentity,
  draft: { stem: string; content: string }, authorize: () => void,
): Promise<string> {
  const assertRoot = () => {
    authorize();
    const identity = folderIdentity(root.path, null);
    if (identity?.dev !== root.dev || identity.ino !== root.ino) throw new Error('knowledge.rootChanged');
  };
  const assertPlacement = () => {
    assertRoot();
    const actual = folderIdentity(root.path, folder);
    if (actual?.dev !== approved.dev || actual.ino !== approved.ino) throw new Error('knowledge.folderNotWritable');
  };
  const access = new WorkspaceAccess(root.path, root);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = `${draft.stem}${attempt === 1 ? '' : ` (${attempt})`}.md`;
    const path = `${folder}/${name}`;
    assertPlacement();
    if (!pathMissing(join(root.path, path))) continue;
    try {
      // Exclusive temporary creation and atomic no-clobber publication reuse
      // the workspace guard and keep partial contents out of the vault.
      await access.writeHostMarkdown(path, draft.content, assertPlacement);
      return path;
    } catch (error) {
      assertPlacement();
      if (!(error instanceof WorkspaceOutputExists) && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('knowledge.nameUnavailable');
}
