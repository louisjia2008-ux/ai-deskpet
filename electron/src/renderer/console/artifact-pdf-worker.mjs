/* global Worker, URL */
// Keep import.meta in this ESM helper: the main-process TypeScript target is CommonJS.
// Webpack emits this worker next to the renderer bundle, under the existing self CSP.
export const createArtifactPdfWorker = () => new Worker(
  new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
  { type: 'module' },
);
