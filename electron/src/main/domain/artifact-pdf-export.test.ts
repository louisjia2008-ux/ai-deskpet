import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const session = { protocol: { handle: vi.fn(), unhandle: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } };
  const contents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), printToPDF: vi.fn() };
  const surface = { webContents: contents, loadURL: vi.fn(), destroy: vi.fn(), isDestroyed: vi.fn(() => false) };
  const construct = vi.fn();
  return { session, contents, surface, construct };
});
vi.mock('electron', () => ({ session: { fromPartition: vi.fn(() => mock.session) },
  BrowserWindow: class { constructor(options: unknown) { mock.construct(options); return mock.surface; } } }));
import { artifactPdfHtml, renderArtifactPdf } from './artifact-pdf-export';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('isolated native PDF printing', () => {
  it('keeps source markup inert and source text out of navigation URLs, while denying every other request', async () => {
    const source = '<script>PRIVATE_SENTINEL</script><img src="https://example.com/private">';
    const doc = new window.DOMParser().parseFromString(artifactPdfHtml({ title: '</title><script>title</script>', text: source }), 'text/html');
    expect(doc.querySelector('script')).toBeNull(); expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('pre')!.textContent).toBe(source);
    mock.surface.loadURL.mockResolvedValue(undefined); mock.contents.printToPDF.mockResolvedValue(Buffer.from('%PDF-1.7\nfixture'));
    await renderArtifactPdf({ title: 'report.md', text: source });
    const url = mock.surface.loadURL.mock.calls[0]![0] as string;
    expect(url).toMatch(/^deskpet-artifact-pdf:\/\/document\/[a-f\d-]+$/u);
    expect(url).not.toContain('PRIVATE_SENTINEL');
    expect(mock.construct).toHaveBeenCalledWith(expect.objectContaining({ show: false, webPreferences: expect.objectContaining({
      javascript: false, sandbox: true, nodeIntegration: false, contextIsolation: true, session: mock.session,
    }) }));
    const authorize = mock.session.webRequest.onBeforeRequest.mock.calls[0]![0] as (details: { url: string; resourceType: string }, callback: (result: { cancel: boolean }) => void) => void;
    for (const candidate of [url, 'https://example.com/private', 'file:///tmp/private', 'data:text/html,private']) {
      const callback = vi.fn(); authorize({ url: candidate, resourceType: 'mainFrame' }, callback); expect(callback).toHaveBeenCalledWith({ cancel: candidate !== url });
    }
    const frame = vi.fn(); authorize({ url, resourceType: 'subFrame' }, frame); expect(frame).toHaveBeenCalledWith({ cancel: true });
    expect(mock.surface.destroy).toHaveBeenCalledOnce(); expect(mock.session.protocol.unhandle).toHaveBeenCalledWith('deskpet-artifact-pdf');
  });

  it('destroys a stuck print surface at its deadline and refuses overlapping printing', async () => {
    vi.useFakeTimers(); mock.surface.loadURL.mockResolvedValue(undefined); mock.contents.printToPDF.mockImplementationOnce(() => new Promise(() => undefined));
    const printing = renderArtifactPdf({ title: 'report.txt', text: 'fixture' });
    const failed = expect(printing).rejects.toThrow('chat.artifactExportTimeout');
    await expect(renderArtifactPdf({ title: 'other.txt', text: 'fixture' })).rejects.toThrow('chat.artifactExportBusy');
    await vi.advanceTimersByTimeAsync(30_000); await failed;
    expect(mock.surface.destroy).toHaveBeenCalledOnce(); expect(mock.session.protocol.unhandle).toHaveBeenCalledWith('deskpet-artifact-pdf');
  });
});
