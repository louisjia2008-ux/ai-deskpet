import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { ChatArtifactEntry, ChatArtifactPage, ChatArtifactPreview, ChatArtifactReference, ChatArtifactSearch, ChatWorkTask } from '../../shared/chat-work';
import type { DomainRepository } from './repository';
import type { ChatWorkService } from './chat-work-service';
import { chatArtifactReferenceSchema, chatArtifactSearchSchema } from './chat-work-schemas';
import type { WorkspaceAccess } from '../tools/workspace';
import type { ArtifactPdfDocument } from './artifact-pdf-export';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 16 * MAX_TEXT_BYTES;

/** Console-only artifact browsing. It cannot read arbitrary paths or grant model access. */
export class ChatArtifactService {
  #exporting = false;
  constructor(private readonly repository: DomainRepository, private readonly work: ChatWorkService, private readonly workspace: WorkspaceAccess,
    private readonly options: { renderPdf?: (document: ArtifactPdfDocument) => Promise<Buffer>; available?: () => boolean } = {}) {}

  get active(): boolean { return this.#exporting; }

  #entry(task: ChatWorkTask, path: string): ChatArtifactEntry | null {
    const artifact = task.artifacts.find(item => item.path === path);
    const session = this.repository.snapshot().chatSessions.find(item => item.id === task.sessionId && !item.deletedAt);
    if (!artifact || !session) return null;
    return { ...artifact, sessionId: task.sessionId, taskId: task.id, sessionTitle: session.title, goal: task.goal,
      updatedAt: task.updatedAt, status: task.status, archived: Boolean(session.archivedAt) };
  }

  search(input: ChatArtifactSearch): ChatArtifactPage {
    const options = chatArtifactSearchSchema.parse(input);
    const needle = (options.query ?? '').normalize('NFKC').toLocaleLowerCase();
    // Use the existing publication/provenance/privacy gate, including revoked memories.
    const items = this.work.artifactEntries(options.sessionId).filter(entry =>
      `${entry.path}\n${entry.goal}\n${entry.sessionTitle}`.normalize('NFKC').toLocaleLowerCase().includes(needle));
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId) || a.path.localeCompare(b.path));
    const offset = options.offset ?? 0, end = Math.min(items.length, offset + (options.limit ?? 30));
    return { items: items.slice(offset, end), total: items.length, nextOffset: end < items.length ? end : null };
  }

  #resolve(reference: ChatArtifactReference): ChatArtifactEntry {
    const state = this.repository.snapshot();
    if (!state.chatSessions.some(session => session.id === reference.sessionId && !session.deletedAt)) throw new Error('chat.artifactUnavailable');
    const task = this.work.get(reference.sessionId, reference.taskId);
    const entry = task ? this.#entry(task, reference.path) : null;
    if (!entry) throw new Error('chat.artifactUnavailable');
    if (entry.sha256 !== reference.sha256) throw new Error('chat.artifactChanged');
    return entry;
  }

  async preview(input: ChatArtifactReference): Promise<ChatArtifactPreview> {
    const reference = chatArtifactReferenceSchema.parse(input);
    const artifact = this.#resolve(reference);
    const extension = extname(artifact.path).toLowerCase();
    const textual = ['.md', '.markdown', '.csv', '.txt', '.json'].includes(extension);
    const maxBytes = textual ? MAX_TEXT_BYTES : MAX_PREVIEW_BYTES;
    if (artifact.bytes > maxBytes) throw new Error('chat.artifactTooLarge');
    let bytes: Buffer;
    try { bytes = await this.workspace.readBytes(artifact.path, maxBytes, undefined, () => { this.#resolve(reference); }); }
    catch (error) {
      if (error instanceof Error && /^chat\.artifact/u.test(error.message)) throw error;
      throw new Error('chat.artifactUnavailable');
    }
    this.#resolve(reference);
    if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('chat.artifactChanged');
    if (extension === '.pdf') {
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('chat.artifactInvalid');
      return { artifact, kind: 'pdf', dataBase64: bytes.toString('base64') };
    }
    if (textual) {
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('chat.artifactInvalid'); }
      if (content.includes('\0')) throw new Error('chat.artifactInvalid');
      return { artifact, kind: extension === '.csv' ? 'csv' : ['.md', '.markdown'].includes(extension) ? 'markdown' : 'text', text: content };
    }
    return { artifact, kind: 'unsupported' };
  }

  async exportPdf(input: ChatArtifactReference): Promise<ChatArtifactEntry> {
    const reference = chatArtifactReferenceSchema.parse(input);
    if (!this.options.renderPdf || this.options.available?.() === false) throw new Error('chat.artifactUnavailable');
    if (this.#exporting) throw new Error('chat.artifactExportBusy');
    this.#exporting = true;
    const profileId = this.repository.snapshot().profileId;
    const assertCurrent = (): void => {
      if (this.options.available?.() === false || this.repository.snapshot().profileId !== profileId) throw new Error('chat.artifactUnavailable');
      this.#resolve(reference);
    };
    try {
      const source = await this.preview(reference);
      if (!['.md', '.markdown', '.txt', '.csv'].includes(extname(reference.path).toLowerCase()) || !('text' in source)) throw new Error('chat.artifactExportUnsupported');
      const task = this.work.get(reference.sessionId, reference.taskId)!;
      const prior = task.artifacts.find(item => item.derivedFrom?.format === 'pdf-export' && item.derivedFrom.path === reference.path && item.derivedFrom.sha256 === reference.sha256);
      if (prior) {
        try { return (await this.preview({ ...reference, path: prior.path, sha256: prior.sha256 })).artifact; }
        catch { assertCurrent(); /* A changed or moved export can be regenerated without overwriting it. */ }
      }
      if (task.artifacts.length >= 40) throw new Error('chat.artifactCapacity');
      assertCurrent();
      const bytes = await this.options.renderPdf({ title: basename(reference.path), text: source.text });
      // Source bytes and authority may change while Chromium prints. Re-read both before publishing.
      await this.preview(reference); assertCurrent();
      const stem = basename(reference.path, extname(reference.path)).replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80) || 'artifact';
      const path = `exports/${reference.taskId}/${stem}-${reference.sha256.slice(0, 16)}-${randomUUID().slice(0, 8)}.pdf`;
      await this.workspace.writeHostPdf(path, bytes, assertCurrent);
      try {
        const written = await this.workspace.readBytes(path, MAX_PREVIEW_BYTES, undefined, assertCurrent);
        if (!written.equals(bytes)) throw new Error('chat.artifactExportReceiptUncertain');
        await this.preview(reference); assertCurrent();
        const artifact = { path, bytes: written.length, sha256: createHash('sha256').update(written).digest('hex'),
          derivedFrom: { path: reference.path, sha256: reference.sha256, format: 'pdf-export' as const } };
        await this.work.recordDerivedArtifact(reference, artifact, assertCurrent);
        return this.#resolve({ ...reference, path, sha256: artifact.sha256 });
      }
      catch { throw new Error('chat.artifactExportReceiptUncertain'); }
    } finally { this.#exporting = false; }
  }
}
