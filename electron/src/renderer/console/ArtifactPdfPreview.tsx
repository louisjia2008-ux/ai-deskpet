import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { createArtifactPdfWorker } from './artifact-pdf-worker.mjs';

/** Canvas-only PDF view: no annotations, scripts, forms, remote URLs or embedded viewer. */
export const ArtifactPdfPreview = ({ dataBase64, zh }: { dataBase64: string; zh: boolean }): JSX.Element => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const [rendering, setRendering] = useState(true);
  useEffect(() => {
    let disposed = false;
    let destroy = (): void => undefined;
    let loadingTimeout: ReturnType<typeof setTimeout> | undefined;
    setDocument(null); setPage(1); setError(false); setRendering(true);
    void import('pdfjs-dist').then(pdf => {
      if (disposed) return;
      const bytes = Uint8Array.from(window.atob(dataBase64), character => character.charCodeAt(0));
      const port = createArtifactPdfWorker();
      const worker = pdf.PDFWorker.create({ port });
      // PDF.js 6 removed the eval renderer. Its worker is bundled locally;
      // fonts are drawn as paths so the existing no-blob/no-data font CSP stays intact.
      const loading = pdf.getDocument({ data: bytes, worker, disableWorkerRendering: true, useWasm: false, useWorkerFetch: false,
        disableFontFace: true, useSystemFonts: true, isImageDecoderSupported: false, stopAtErrors: true,
        maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64_000_000 });
      let destroyed = false;
      destroy = () => {
        if (destroyed) return; destroyed = true; clearTimeout(loadingTimeout);
        // A malformed document must not retain a worker indefinitely during teardown.
        const deadline = setTimeout(() => port.terminate(), 2000);
        void loading.destroy().catch(() => undefined).finally(() => { clearTimeout(deadline); worker.destroy(); port.terminate(); });
      };
      loadingTimeout = setTimeout(() => { if (!disposed) { setError(true); setRendering(false); } destroy(); }, 15_000);
      loading.onPassword = () => { if (!disposed) { setError(true); setRendering(false); } destroy(); };
      return loading.promise.then(value => {
        clearTimeout(loadingTimeout);
        if (disposed) { destroy(); return; }
        if (value.numPages < 1 || value.numPages > 10_000) { destroy(); setError(true); setRendering(false); return; }
        setDocument(value);
      });
    }).catch(() => { if (!disposed) { setError(true); setRendering(false); } });
    return () => { disposed = true; clearTimeout(loadingTimeout); destroy(); };
  }, [dataBase64]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    const target = canvas.current;
    let disposed = false, render: RenderTask | undefined;
    setRendering(true); setError(false);
    void document.getPage(page).then(value => {
      if (disposed) return;
      const original = value.getViewport({ scale: 1 });
      if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0) throw new Error('Invalid page');
      const viewport = value.getViewport({ scale: Math.min(1.5, 1200 / original.width, 2400 / original.height) });
      target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height);
      const context = target.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      render = value.render({ canvas: target, canvasContext: context, viewport, annotationMode: 0 });
      return render.promise;
    }).then(() => { if (!disposed) setRendering(false); }).catch(() => { if (!disposed) { setError(true); setRendering(false); } });
    return () => { disposed = true; render?.cancel(); };
  }, [document, page]);
  return <div className="artifact-pdf">
    {document && <div className="artifact-pdf-toolbar"><button type="button" className="secondary" disabled={page <= 1 || rendering} onClick={() => setPage(value => value - 1)}>{zh ? '上一页' : 'Previous page'}</button><span>{page} / {document.numPages}</span><button type="button" className="secondary" disabled={page >= document.numPages || rendering} onClick={() => setPage(value => value + 1)}>{zh ? '下一页' : 'Next page'}</button></div>}
    {rendering && <p role="status">{zh ? '正在绘制 PDF…' : 'Rendering PDF…'}</p>}
    {error && <p role="alert">{zh ? '无法预览此 PDF（文件可能加密、损坏或使用了不支持的内容），可在文件夹中查看。' : 'This PDF could not be previewed. It may be encrypted, damaged, or use unsupported content. You can reveal it in its folder.'}</p>}
    <canvas ref={canvas} hidden={error || rendering} aria-label={zh ? `PDF 第 ${page} 页` : `PDF page ${page}`} />
  </div>;
};
