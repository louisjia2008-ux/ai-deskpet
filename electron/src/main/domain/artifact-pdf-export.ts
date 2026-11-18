import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import type { Session } from 'electron';

export interface ArtifactPdfDocument { title: string; text: string }
const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Preserve every source character as inert text; source HTML, links and images never execute. */
export const artifactPdfHtml = ({ title, text }: ArtifactPdfDocument): string => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>@page{size:A4;margin:18mm}body{color:#17202a;font-family:"PingFang SC","Noto Sans CJK SC",Arial,sans-serif;font-size:10pt;line-height:1.5}h1{font-size:16pt;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4}</style></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(text)}</pre></body></html>`;

let pdfSession: Session | undefined;
let rendering = false;

/** Desktop-only print surface, isolated from both app profiles and browser sessions. */
export const renderArtifactPdf = async (document: ArtifactPdfDocument): Promise<Buffer> => {
  if (rendering) throw new Error('chat.artifactExportBusy');
  rendering = true;
  let window: BrowserWindow | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pdfSession ??= session.fromPartition(`artifact-pdf-${randomUUID()}`, { cache: false });
    // Keep private source bytes out of navigation URLs and Chromium load-error logs.
    const documentUrl = `deskpet-artifact-pdf://document/${randomUUID()}`;
    const html = artifactPdfHtml(document);
    pdfSession.protocol.handle('deskpet-artifact-pdf', request => request.url === documentUrl
      ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
      : new Response(null, { status: 404 }));
    pdfSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    pdfSession.setPermissionCheckHandler(() => false);
    pdfSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== documentUrl || details.resourceType !== 'mainFrame' }));
    window = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: {
      session: pdfSession, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
    } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const surface = window;
    return await Promise.race([
      (async () => {
        await surface.loadURL(documentUrl);
        return surface.webContents.printToPDF({ printBackground: false, preferCSSPageSize: true, generateTaggedPDF: true });
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('chat.artifactExportTimeout')), 30_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    pdfSession?.protocol.unhandle('deskpet-artifact-pdf');
    rendering = false;
  }
};
