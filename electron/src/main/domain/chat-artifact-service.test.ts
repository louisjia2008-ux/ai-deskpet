import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainRepository } from './repository';
import { ChatService } from './chat-service';
import { ChatWorkService } from './chat-work-service';
import { ChatArtifactService } from './chat-artifact-service';
import { WorkspaceAccess } from '../tools/workspace';
import type { ChatArtifactReference } from '../../shared/chat-work';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fixture = async (renderPdf?: (input: { title: string; text: string }) => Promise<Buffer>) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-artifacts-')); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const repository = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 31) });
  await repository.initialize();
  const chat = new ChatService(repository), work = new ChatWorkService(repository), access = new WorkspaceAccess(workspace);
  const artifacts = new ChatArtifactService(repository, work, access, renderPdf ? { renderPdf } : {});
  const record = async (path: string, content: string | Buffer, title = 'Synthetic project report'): Promise<ChatArtifactReference> => {
    const session = await chat.createSession(title, 'normal');
    const message = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: 'Created this fixture.', status: 'streaming', errorCode: null });
    await repository.transaction(state => { state.chatMessages.find(item => item.id === message.id)!.contextTrace = {
      version: 1, memoryReferences: [], historyMessageIds: [], scope: { kind: 'session', sessionId: session.id }, privacy: 'cloud-allowed', lineage: 'complete',
    }; });
    const runId = randomUUID(), task = await work.begin({ sessionId: session.id, runId, assistantMessageId: message.id, goal: `Create ${title}`, privacy: 'cloud-allowed' });
    const bytes = Buffer.from(content), sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(workspace, path), bytes);
    await work.recordTool(runId, 'workspace.write', {}, { written: true, path, bytes: bytes.length, sha256 });
    await work.finish(runId, 'completed', 'Saved the fixture.');
    await repository.transaction(state => { state.chatMessages.find(item => item.id === message.id)!.status = 'complete'; });
    return { sessionId: session.id, taskId: task.id, path, sha256 };
  };
  return { root, workspace, repository, chat, work, access, artifacts, record };
};

describe('recorded artifact previews', () => {
  it('searches metadata across conversations with pagination and returns to exact source identities', async () => {
    const f = await fixture();
    const first = await f.record('first.md', '# First', 'Weekly research');
    const second = await f.record('second.csv', 'name,value\nsecond,2', 'Budget');
    const page = f.artifacts.search({ limit: 1 });
    expect(page.total).toBe(2); expect(page.items).toHaveLength(1); expect(page.nextOffset).toBe(1);
    expect(f.artifacts.search({ offset: 1, limit: 1 }).items).toHaveLength(1);
    expect(f.artifacts.search({ query: 'WEEKLY' }).items).toEqual([expect.objectContaining(first)]);
    expect(f.artifacts.search({ query: 'second.csv' }).items).toEqual([expect.objectContaining(second)]);
    expect(f.artifacts.search({ sessionId: first.sessionId }).items).toEqual([expect.objectContaining(first)]);
    await f.repository.transaction(state => { state.chatSessions.find(item => item.id === first.sessionId)!.archivedAt = new Date().toISOString(); });
    expect(f.artifacts.search({ query: 'first.md' }).items[0]?.archived).toBe(true);
  });

  it('returns verified UTF-8 Markdown and CSV, and preserves binary PDF bytes exactly', async () => {
    const f = await fixture();
    const md = await f.record('summary.md', '# 中文成果\n<script>not executable</script>');
    const csv = await f.record('data.csv', '名称,值\n测试,3');
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x80, 0xff, 0x00, 0x42])]);
    const pdf = await f.record('report.pdf', pdfBytes);
    expect(await f.artifacts.preview(md)).toMatchObject({ kind: 'markdown', text: '# 中文成果\n<script>not executable</script>' });
    expect(await f.artifacts.preview(csv)).toMatchObject({ kind: 'csv', text: '名称,值\n测试,3' });
    const preview = await f.artifacts.preview(pdf);
    expect(preview.kind).toBe('pdf');
    if (preview.kind === 'pdf') expect(Buffer.from(preview.dataBase64, 'base64')).toEqual(pdfBytes);
  });

  it('rejects changed bytes, stale hashes, forged paths and mismatched source sessions', async () => {
    const f = await fixture(), reference = await f.record('report.md', 'original');
    await writeFile(join(f.workspace, 'report.md'), 'modified');
    await expect(f.artifacts.preview(reference)).rejects.toThrow('chat.artifactChanged');
    await expect(f.artifacts.preview({ ...reference, sha256: 'a'.repeat(64) })).rejects.toThrow('chat.artifactChanged');
    await expect(f.artifacts.preview({ ...reference, path: '../profile.enc.json' })).rejects.toThrow();
    await expect(f.artifacts.preview({ ...reference, path: 'unrecorded.md' })).rejects.toThrow('chat.artifactUnavailable');
    const other = await f.chat.createSession('Other conversation', 'normal');
    await expect(f.artifacts.preview({ ...reference, sessionId: other.id })).rejects.toThrow('chat.artifactUnavailable');
  });

  it('rejects symbolic and hard links even when they contain the recorded bytes', async () => {
    const f = await fixture(), reference = await f.record('report.md', 'same bytes');
    const outside = join(f.root, 'outside.md'); await writeFile(outside, 'same bytes');
    await unlink(join(f.workspace, 'report.md')); await symlink(outside, join(f.workspace, 'report.md'));
    await expect(f.artifacts.preview(reference)).rejects.toThrow('chat.artifactUnavailable');
    await unlink(join(f.workspace, 'report.md')); await link(outside, join(f.workspace, 'report.md'));
    await expect(f.artifacts.preview(reference)).rejects.toThrow('chat.artifactUnavailable');
  });

  it('excludes deleted or invalid-lineage source records and rechecks deletion after an async read', async () => {
    const f = await fixture(), reference = await f.record('report.md', 'Saved result');
    const original = f.access.readBytes.bind(f.access);
    vi.spyOn(f.access, 'readBytes').mockImplementationOnce(async (...args) => {
      const bytes = await original(...args);
      await f.repository.transaction(state => { state.chatSessions.find(item => item.id === reference.sessionId)!.deletedAt = new Date().toISOString(); });
      return bytes;
    });
    await expect(f.artifacts.preview(reference)).rejects.toThrow('chat.artifactUnavailable');
    expect(f.artifacts.search({}).items).toEqual([]);
    const other = await f.record('hidden.md', 'Hidden result');
    await f.repository.transaction(state => { const task = state.chatWorkTasks.find(item => item.id === other.taskId)!; delete state.chatMessages.find(item => item.id === task.assistantMessageId)!.contextTrace; });
    expect(f.artifacts.search({}).items).toEqual([]);
    await expect(f.artifacts.preview(other)).rejects.toThrow('chat.artifactUnavailable');
  });

  it('rejects oversized text, invalid UTF-8 and mislabeled PDFs with actionable error codes', async () => {
    const f = await fixture(), large = await f.record('large.md', Buffer.alloc(1024 * 1024 + 1, 65));
    const invalidText = await f.record('bad.csv', Buffer.from([0xff, 0xfe]));
    const invalidPdf = await f.record('not.pdf', 'This is not a PDF');
    await expect(f.artifacts.preview(large)).rejects.toThrow('chat.artifactTooLarge');
    await expect(f.artifacts.preview(invalidText)).rejects.toThrow('chat.artifactInvalid');
    await expect(f.artifacts.preview(invalidPdf)).rejects.toThrow('chat.artifactInvalid');
  });
});

describe('verified PDF exports', () => {
  const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC_UNIT_TEST_PDF');

  it('publishes a new derived artifact from exact source text and deduplicates a verified prior export', async () => {
    const renderPdf = vi.fn(async () => pdf), f = await fixture(renderPdf);
    const reference = await f.record('report.md', '# Original source\n中文内容');
    const taskBefore = f.work.get(reference.sessionId, reference.taskId)!;
    const messagesBefore = f.repository.snapshot().chatMessages;
    const exported = await f.artifacts.exportPdf(reference);
    expect(renderPdf).toHaveBeenCalledWith({ title: 'report.md', text: '# Original source\n中文内容' });
    expect(exported.path).toMatch(new RegExp(`^exports/${reference.taskId}/report-${reference.sha256.slice(0, 16)}-[a-f0-9]{8}\\.pdf$`));
    expect(exported).toMatchObject({ sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.length,
      derivedFrom: { path: reference.path, sha256: reference.sha256, format: 'pdf-export' } });
    expect(await readFile(join(f.workspace, exported.path))).toEqual(pdf);
    expect(await readFile(join(f.workspace, reference.path), 'utf8')).toBe('# Original source\n中文内容');
    expect(f.work.get(reference.sessionId, reference.taskId)).toMatchObject({ status: taskBefore.status, summary: taskBefore.summary });
    expect(f.repository.snapshot().chatMessages).toEqual(messagesBefore);
    expect((await f.artifacts.exportPdf(reference)).path).toBe(exported.path);
    expect(renderPdf).toHaveBeenCalledTimes(1);
    expect(f.artifacts.search({ query: '.pdf' }).items).toHaveLength(1);
  });

  it('rejects changed source bytes or deleted source authority while printing without publishing a PDF', async () => {
    let print!: () => Promise<Buffer>;
    const f = await fixture(async () => print());
    const reference = await f.record('report.txt', 'original');
    print = async () => { await writeFile(join(f.workspace, reference.path), 'modified'); return pdf; };
    await expect(f.artifacts.exportPdf(reference)).rejects.toThrow('chat.artifactChanged');
    expect(await readdir(f.workspace)).toEqual(['report.txt']);
    await writeFile(join(f.workspace, reference.path), 'original');
    print = async () => { await f.repository.transaction(state => { state.chatSessions.find(item => item.id === reference.sessionId)!.deletedAt = new Date().toISOString(); }); return pdf; };
    await expect(f.artifacts.exportPdf(reference)).rejects.toThrow('chat.artifactUnavailable');
    expect(await readdir(f.workspace)).toEqual(['report.txt']);
    expect(f.artifacts.active).toBe(false);
  });

  it('does not present an uncommitted PDF receipt as a successful artifact', async () => {
    const f = await fixture(async () => pdf), reference = await f.record('report.csv', 'label,value\noriginal,1');
    vi.spyOn(f.work, 'recordDerivedArtifact').mockRejectedValueOnce(new Error('repository.commitUncertain'));
    await expect(f.artifacts.exportPdf(reference)).rejects.toThrow('chat.artifactExportReceiptUncertain');
    expect(f.artifacts.search({}).items).toHaveLength(1);
    const files = await readdir(join(f.workspace, 'exports', reference.taskId));
    expect(files).toHaveLength(1);
    expect(await readFile(join(f.workspace, 'exports', reference.taskId, files[0]!))).toEqual(pdf);
  });

  it('rejects overlapping exports, unsupported input, invalid renderer bytes and full task records', async () => {
    let release!: (bytes: Buffer) => void;
    const f = await fixture(() => new Promise(resolve => { release = resolve; })), reference = await f.record('report.txt', 'original');
    const pending = f.artifacts.exportPdf(reference);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.artifacts.active).toBe(true);
    await expect(f.artifacts.exportPdf(reference)).rejects.toThrow('chat.artifactExportBusy');
    release(Buffer.from('not a PDF'));
    await expect(pending).rejects.toThrow('chat.artifactInvalid');
    const json = await f.record('report.json', '{}');
    await expect(f.artifacts.exportPdf(json)).rejects.toThrow('chat.artifactExportUnsupported');
    await f.repository.transaction(state => { const task = state.chatWorkTasks.find(item => item.id === reference.taskId)!; for (let index = 1; index < 40; index++) task.artifacts.push({ ...task.artifacts[0]!, path: `other-${index}.txt` }); });
    await expect(f.artifacts.exportPdf(reference)).rejects.toThrow('chat.artifactCapacity');
  });

  it('keeps PDF publication inside the workspace, refuses links and never overwrites an existing output', async () => {
    const f = await fixture(), outside = join(f.root, 'outside'); await mkdir(outside);
    await expect(f.access.writeHostPdf('../outside/escape.pdf', pdf)).rejects.toThrow();
    await symlink(outside, join(f.workspace, 'linked'));
    await expect(f.access.writeHostPdf('linked/escape.pdf', pdf)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await f.access.writeHostPdf('safe/report.pdf', pdf);
    await expect(f.access.writeHostPdf('safe/report.pdf', Buffer.from('%PDF-1.7\nchanged'))).rejects.toThrow('already exists');
    expect(await readFile(join(f.workspace, 'safe/report.pdf'))).toEqual(pdf);
    await expect(f.access.write('model.pdf', '%PDF-1.7\nmodel')).rejects.toThrow('extension is not writable');
    await expect(f.access.writeHostPdf('wrong.txt', pdf)).rejects.toThrow('chat.artifactInvalid');
    await expect(f.access.writeHostPdf('large.pdf', Buffer.concat([pdf, Buffer.alloc(16 * 1024 * 1024)]))).rejects.toThrow('chat.artifactInvalid');
  });
});
