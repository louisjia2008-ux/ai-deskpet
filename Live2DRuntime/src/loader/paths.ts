// AIRI live2d-zip-loader.ts algorithm adaptation @ 00c6867; MIT.
export function normalizePath(path: string): string {
  try { path = decodeURI(path); } catch { /* literal malformed percent escape */ }
  path = path.replaceAll('\\','/');
  if (path.startsWith('/') || /[:?#\x00-\x1f]/.test(path)) throw new Error('Unsafe model path');
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) throw new Error('Model path escapes root'); parts.pop(); }
    else parts.push(p);
  }
  return parts.join('/');
}
export function ignored(path: string) {
  return path.replaceAll('\\','/').split('/').some(p => p === '__MACOSX' || p.startsWith('._') || p === 'items_pinned_to_model.json');
}
export function selectSettings(paths: string[]) {
  const settings = paths.filter(p => !ignored(p) && p.toLowerCase().endsWith('.model3.json')).sort();
  if (settings.length !== 1) throw new Error(`Expected one model3.json, found ${settings.length}`);
  return settings[0];
}
export function sanitizeSettings(value: any) {
  if (!value || value.Version !== 3 || !value.FileReferences || typeof value.FileReferences.Moc !== 'string' || !Array.isArray(value.FileReferences.Textures) || !value.FileReferences.Textures.length) throw new Error('Invalid Cubism 3 model metadata');
  const refs = value.FileReferences;
  for (const key of ['Physics','Pose','DisplayInfo']) if (refs[key] === null) delete refs[key];
  return value;
}

// Blob URLs are opaque: Node-style url.resolve corrupts custom-origin blob URLs.
export function resolveBlobResource(path:string) {
  if(!path.startsWith('blob:'))throw new Error('Nonlocal model reference');
  return path;
}

export function discoverUnlistedReferences(refs:any, paths:string[], root:string) {
  if(!refs.Expressions)refs.Expressions=paths.filter(p=>p.startsWith(root)&&p.endsWith('.exp3.json')).sort().map(p=>({Name:p.slice(root.length).replace(/\.exp3\.json$/,''),File:p.slice(root.length)}));
  if(!refs.Motions){const files=paths.filter(p=>p.startsWith(root)&&p.endsWith('.motion3.json')).sort();if(files.length)refs.Motions={Imported:files.map(p=>({File:p.slice(root.length)}))};}
}
