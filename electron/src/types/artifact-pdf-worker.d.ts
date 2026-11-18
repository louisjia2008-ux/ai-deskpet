declare module '*artifact-pdf-worker.mjs' {
  export function createArtifactPdfWorker(): InstanceType<typeof window.Worker>;
}
