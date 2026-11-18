import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatArtifactEntry, ChatArtifactPreview } from '../../shared/chat-work';
import type { ChatWorkPanelApi } from '../../shared/chat-work-api';
import { ArtifactsPanel, artifactContinuationPrompt, artifactReference } from './ArtifactsPanel';
import { ArtifactPreview } from './ArtifactPreview';
import { parseArtifactCsv } from './artifact-csv';

const artifact: ChatArtifactEntry = { sessionId: 'session-one', taskId: 'task-one', path: 'reports/result.md', sha256: 'a'.repeat(64), bytes: 20,
  sessionTitle: 'A report conversation', goal: 'Compare the fixture sources', updatedAt: '2026-11-10T01:00:00Z', status: 'completed', archived: false };
const preview: ChatArtifactPreview = { artifact, kind: 'markdown', text: '# Reviewed report\n\nA **verified** result.' };
const fixture = () => {
  const api = { searchArtifacts: vi.fn(async () => ({ items: [artifact], total: 1, nextOffset: null })), previewArtifact: vi.fn(async () => preview),
    exportArtifactPdf: vi.fn(async () => ({ ...artifact, path: 'exports/report.pdf' })), openArtifact: vi.fn(async () => undefined), onChanged: vi.fn(() => () => undefined) } as unknown as ChatWorkPanelApi;
  return { api, open: vi.fn(), continue: vi.fn() };
};
afterEach(cleanup);

describe('artifact browsing', () => {
  it('finds recent outputs, previews Markdown, returns to the source chat and stages a verified file reference', async () => {
    const f = fixture(); render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    await screen.findByRole('button', { name: artifact.path });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search artifacts' }));
    await waitFor(() => expect(f.api.searchArtifacts).toHaveBeenLastCalledWith({ query: 'report', offset: 0, limit: 30 }));
    fireEvent.click(screen.getByRole('button', { name: artifact.path }));
    await screen.findByRole('heading', { name: 'Reviewed report' });
    expect(f.api.previewArtifact).toHaveBeenLastCalledWith(artifactReference(artifact));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' })); expect(f.open).toHaveBeenCalledWith('session-one');
    fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));
    await waitFor(() => expect(f.continue).toHaveBeenCalledWith(artifactReference(artifact)));
    expect(f.api.previewArtifact).toHaveBeenCalledTimes(2);
    expect(artifactContinuationPrompt(artifact, false)).toContain(artifact.path);
    expect(artifactContinuationPrompt(artifact, false)).toContain(artifact.sha256);
    expect(artifactContinuationPrompt(artifact, false)).not.toContain('Reviewed report');
  });

  it('does not continue a changed version or allow an archived source to be edited', async () => {
    const f = fixture(); vi.mocked(f.api.previewArtifact).mockRejectedValueOnce(new Error('chat.artifactChanged'));
    const view = render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    await screen.findByRole('button', { name: 'Continue editing' }); fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('file has changed'); expect(f.continue).not.toHaveBeenCalled();
    view.unmount(); vi.mocked(f.api.searchArtifacts).mockResolvedValue({ items: [{ ...artifact, archived: true }], total: 1, nextOffset: null });
    render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    expect(await screen.findByRole('button', { name: 'Continue editing' })).toBeDisabled();
  });

  it('revalidates a derived PDF and its exact saved source before staging the source text for editing', async () => {
    const f = fixture(), pdf = { ...artifact, path: 'exports/result.pdf', sha256: 'd'.repeat(64),
      derivedFrom: { path: artifact.path, sha256: artifact.sha256, format: 'pdf-export' as const } };
    vi.mocked(f.api.searchArtifacts).mockResolvedValue({ items: [pdf], total: 1, nextOffset: null });
    vi.mocked(f.api.previewArtifact).mockResolvedValueOnce({ artifact: pdf, kind: 'pdf', dataBase64: 'JVBERg==' }).mockResolvedValueOnce(preview);
    render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit source' }));
    await waitFor(() => expect(f.continue).toHaveBeenCalledWith(artifactReference(artifact)));
    expect(f.api.previewArtifact).toHaveBeenNthCalledWith(1, artifactReference(pdf));
    expect(f.api.previewArtifact).toHaveBeenNthCalledWith(2, artifactReference(artifact));
    expect(screen.getByText('Edit the source file, then export a new PDF.')).toBeVisible();
    expect(f.api.exportArtifactPdf).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'source'] as const)('does not stage editing when a derived PDF continuation has a changed %s', async changed => {
    const f = fixture(), pdf = { ...artifact, path: 'exports/result.pdf', sha256: 'd'.repeat(64),
      derivedFrom: { path: artifact.path, sha256: artifact.sha256, format: 'pdf-export' as const } };
    vi.mocked(f.api.searchArtifacts).mockResolvedValue({ items: [pdf], total: 1, nextOffset: null });
    if (changed === 'source') vi.mocked(f.api.previewArtifact).mockResolvedValueOnce({ artifact: pdf, kind: 'pdf', dataBase64: 'JVBERg==' });
    vi.mocked(f.api.previewArtifact).mockRejectedValueOnce(new Error('chat.artifactChanged'));
    render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('file has changed');
    expect(f.continue).not.toHaveBeenCalled();
    expect(f.api.previewArtifact).toHaveBeenCalledTimes(changed === 'pdf' ? 1 : 2);
  });

  it('disables continuation of a standalone PDF and explains that it has no editable source', async () => {
    const f = fixture(); vi.mocked(f.api.searchArtifacts).mockResolvedValue({ items: [{ ...artifact, path: 'standalone.pdf' }], total: 1, nextOffset: null });
    render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    expect(await screen.findByRole('button', { name: 'Continue editing' })).toBeDisabled();
    expect(screen.getByText('This PDF has no recorded editable source file.')).toBeVisible();
    expect(f.api.previewArtifact).not.toHaveBeenCalled(); expect(f.continue).not.toHaveBeenCalled();
  });

  it('discards an old preview after a newer search', async () => {
    const f = fixture(); let resolve!: (value: ChatArtifactPreview) => void;
    vi.mocked(f.api.previewArtifact).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    fireEvent.click(await screen.findByRole('button', { name: artifact.path }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search artifacts' }));
    await act(async () => { resolve(preview); });
    expect(screen.queryByRole('heading', { name: 'Reviewed report' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue editing' })).toBeEnabled();
  });

  it('exports only the selected recorded version and reports success only after the receipt arrives', async () => {
    const f = fixture(); render(<ArtifactsPanel api={f.api} locale="en" onOpenSession={f.open} onContinue={f.continue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export PDF' }));
    expect(await screen.findByRole('status')).toHaveTextContent('PDF saved: exports/report.pdf');
    expect(f.api.exportArtifactPdf).toHaveBeenCalledWith(artifactReference(artifact));
    expect(f.continue).not.toHaveBeenCalled();
    vi.mocked(f.api.exportArtifactPdf).mockRejectedValueOnce(new Error('chat.artifactExportReceiptUncertain'));
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('PDF saved: exports/report.pdf')).not.toBeInTheDocument();
  });

  it('renders CSV as inert table cells and Markdown without executable HTML or auto-loading remote images', () => {
    const csv = { artifact, kind: 'csv' as const, text: 'Name,Value\n"A, B","line one\nline two"\n=1+1,<script>unsafe</script>' };
    const view = render(<ArtifactPreview preview={csv} zh={false} />);
    expect(screen.getByRole('cell', { name: 'A, B' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '=1+1' })).toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
    view.rerender(<ArtifactPreview preview={{ artifact, kind: 'markdown', text: '# Safe\n<script>unsafe</script>\n\n![private](https://example.com/pixel)\n\n[x](javascript:alert(1))' }} zh={false} />);
    expect(view.container.querySelector('script')).toBeNull(); expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

describe('bounded CSV parsing', () => {
  it('handles CRLF, escaped quotes, multiline fields and a trailing empty field', () => {
    expect(parseArtifactCsv('\uFEFFa,b\r\n"one ""quote""","two\nlines"\r\nlast,').rows).toEqual([['a', 'b'], ['one "quote"', 'two\nlines'], ['last', '']]);
    expect(() => parseArtifactCsv('a\n"unclosed')).toThrow();
  });
  it('states when rows, columns or cell contents are clipped', () => {
    expect(parseArtifactCsv('a,b,c\n1,2,3', 201, 2)).toEqual({ rows: [['a', 'b'], ['1', '2']], truncated: true });
    expect(parseArtifactCsv('header\nfirst\nsecond', 2)).toEqual({ rows: [['header'], ['first']], truncated: true });
    expect(parseArtifactCsv('a'.repeat(4001)).truncated).toBe(true);
  });
});
