import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { WorkspaceAccess } from '../../tools/workspace';

export const WECHAT_INBOX_VAULT_FOLDER = 'DeskPet 收件箱';

export interface InboxVaultGrant { id: string; path: string; dev: number; ino: number }
export interface InboxVaultItem {
  id: string;
  kind: 'article' | 'link' | 'file' | 'image' | 'forward' | 'quote';
  title: string;
  source: string;
  at: number;
  summary: string;
  url?: string | undefined;
}

const labels: Record<InboxVaultItem['kind'], string> = {
  article: '文章', link: '链接', file: '文件', image: '图片', forward: '合并转发', quote: '引用',
};
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const owns = (file: Stats): boolean => process.getuid === undefined || file.uid === process.getuid();
const same = (a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>): boolean => a.dev === b.dev && a.ino === b.ino;
function existing(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if (!missing(error)) throw error; return undefined; }
}

function literal(value: string, maximum: number): string {
  const clean = [...value].slice(0, maximum).join('').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return clean.replace(/[\\`*_{}[\]()#+.!|>~<&-]/gu, '\\$&');
}

function markdown(item: InboxVaultItem): string {
  if (!/^[0-9a-f]{64}$/u.test(item.id) || !Object.hasOwn(labels, item.kind)
    || !Number.isSafeInteger(item.at) || item.at < 0 || item.at > 253_402_300_799_999
    || typeof item.title !== 'string' || typeof item.source !== 'string' || typeof item.summary !== 'string') {
    throw new Error('wechat.inboxExportInvalid');
  }
  const url = item.url === undefined ? null : URL.parse(item.url);
  if (item.url !== undefined && (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)) {
    throw new Error('wechat.inboxExportInvalid');
  }
  return [
    `# ${literal(item.title, 160) || labels[item.kind]}`, '',
    `- 类型 ${labels[item.kind]}`,
    `- 来源 ${literal(item.source, 160) || '微信'}`,
    `- 时间 ${new Date(item.at).toISOString()}`,
    ...(url ? [`- 链接 ${literal(url.href, 500)}`] : []),
    '',
    ...item.summary.slice(0, 4_000).split(/\r?\n/u).map(line => `> ${literal(line, 4_000)}`),
    '',
  ].join('\n');
}

/** The caller supplies consent for the currently selected directory and rechecks it
 * via assertCurrent before the vault directory is created and each file is published. */
export async function exportInboxItem(grant: InboxVaultGrant, item: InboxVaultItem, assertCurrent: () => void): Promise<'created' | 'exists'> {
  const content = markdown(item);
  if (!isAbsolute(grant.path)) throw new Error('wechat.inboxExportUnsafe');
  const directory = join(grant.path, WECHAT_INBOX_VAULT_FOLDER);
  const relative = join(WECHAT_INBOX_VAULT_FOLDER, `${item.id}.md`);
  const path = join(grant.path, relative);
  let folder: Stats | undefined;
  const verify = (): void => {
    assertCurrent();
    const root = existing(grant.path);
    if (!root?.isDirectory() || !same(root, grant) || !owns(root) || (root.mode & 0o022) !== 0
      || realpathSync(grant.path) !== grant.path) throw new Error('wechat.inboxExportUnsafe');
    const candidate = existing(directory);
    if (!candidate && !folder) return;
    if (!candidate?.isDirectory() || !owns(candidate) || (candidate.mode & 0o077) !== 0
      || (folder && !same(candidate, folder)) || realpathSync(directory) !== directory) {
      throw new Error('wechat.inboxExportUnsafe');
    }
    folder = candidate;
  };
  try {
    verify();
    if (!folder) {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    verify();
    if (!folder) throw new Error('wechat.inboxExportUnsafe');
    const access = new WorkspaceAccess(grant.path, grant);
    const bytes = Buffer.from(content);
    const observeExisting = async (prior: Stats): Promise<'exists'> => {
      if (!prior.isFile() || prior.nlink !== 1 || !owns(prior) || (prior.mode & 0o077) !== 0 || prior.size !== bytes.length) {
        throw new Error('wechat.inboxExportConflict');
      }
      const known = await access.readBytes(relative, bytes.length, undefined, verify);
      verify();
      const current = existing(path);
      if (!current || !same(current, prior) || current.nlink !== 1 || !known.equals(bytes)) {
        throw new Error('wechat.inboxExportConflict');
      }
      return 'exists';
    };
    const prior = existing(path);
    if (prior) return await observeExisting(prior);
    try {
      await access.writeHostMarkdown(relative, content, verify);
      return 'created';
    } catch (error) {
      verify();
      // Concurrent saves with identical content are idempotent. A different
      // preexisting file remains untouched.
      const current = existing(path);
      if (current) return await observeExisting(current);
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && /^wechat\.inboxExport(?:Invalid|Unsafe|Conflict|Revoked)$/u.test(error.message)) throw error;
    throw new Error('wechat.inboxExportFailed');
  }
}
