// js-tiktoken 1.0.21 exports this rank module at runtime. Its package has no
// legacy-node typesVersions entry for ranks; keep the exact public BPE type.
declare module 'js-tiktoken/ranks/cl100k_base' {
  import type { TiktokenBPE } from 'js-tiktoken/lite';
  const ranks: TiktokenBPE;
  export default ranks;
}
