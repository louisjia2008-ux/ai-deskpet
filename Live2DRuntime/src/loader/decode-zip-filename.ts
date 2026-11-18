// Copied/adapted from AIRI @ 00c6867; MIT, see ThirdParty/AIRI_LICENSE.txt.
export function decodeZipFileName(bytes: string[] | Uint8Array): string {
  if (Array.isArray(bytes)) return bytes.join('');
  if (bytes.every(b => b < 128)) return new TextDecoder().decode(bytes);
  try { return new TextDecoder('gbk').decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}
