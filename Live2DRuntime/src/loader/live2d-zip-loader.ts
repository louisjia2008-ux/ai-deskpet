// AIRI loader compatibility algorithms @ 00c6867; MIT. No upstream FileLoader patch.
import JSZip from 'jszip';
import { decodeZipFileName } from './decode-zip-filename';
import { ignored, normalizePath, sanitizeSettings, selectSettings, discoverUnlistedReferences } from './paths';
const activeURLs = new Set<string>();
export const activeObjectURLCount = () => activeURLs.size;
export interface ModelSource { settings: any; expressions: Map<string,unknown>; dispose(): void }
async function request(url: string, binary = false): Promise<any> {
  // XMLHttpRequest supports WKURLSchemeHandler resources on macOS WebKit.
  return new Promise((resolve,reject) => {
    const x = new XMLHttpRequest(); x.open('GET',url); x.responseType = binary ? 'arraybuffer' : 'text'; x.timeout=30000;
    x.onload=()=>x.status===200 || x.status===0 ? resolve(x.response) : reject(new Error('Resource unavailable: '+x.status));
    x.onerror=()=>reject(new Error('Model resource request failed')); x.ontimeout=()=>reject(new Error('Model request timed out')); x.send();
  });
}
export async function loadSource(source: string): Promise<ModelSource> {
  const sourceURL = new URL(source);
  if (sourceURL.protocol !== 'deskpet:' || sourceURL.hostname !== 'models') throw new Error('Only managed local models are allowed');
  const blobs: string[] = [];
  const dispose = () => { for (const url of blobs.splice(0)) { URL.revokeObjectURL(url); activeURLs.delete(url); } };
  try {
    let archivePaths:string[]=[];
    let settingsPath: string, read: (path:string)=>Promise<ArrayBuffer>;
    if (sourceURL.pathname.toLowerCase().endsWith('.zip')) {
      const data = await request(source,true);
      if (data.byteLength > 128*1024*1024) throw new Error('Model ZIP exceeds 128 MiB');
      const zip = await JSZip.loadAsync(data,{decodeFileName:decodeZipFileName});
      const entries = new Map<string,JSZip.JSZipObject>();
      let expanded = 0;
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || ignored(entry.name)) continue;
        const original = (entry as any).unsafeOriginalName ?? entry.name;
        const key = normalizePath(original);
        if (entries.has(key)) throw new Error('Ambiguous archive path');
        expanded += (entry as any)._data?.uncompressedSize ?? 0;
        if (expanded > 256*1024*1024 || entries.size >= 2048) throw new Error('Model archive exceeds limits');
        entries.set(key,entry);
      }
      archivePaths=[...entries.keys()];
      settingsPath=selectSettings(archivePaths);
      read=async path=>{ const e=entries.get(normalizePath(path)); if(!e)throw new Error('Missing model resource: '+path);return e.async('arraybuffer'); };
    } else {
      if (!sourceURL.pathname.endsWith('.model3.json')) throw new Error('Expected model3.json or ZIP');
      settingsPath=decodeURIComponent(sourceURL.pathname).replace(/^\//,'');
      read=path=>request('deskpet://models/'+normalizePath(path).split('/').map(encodeURIComponent).join('/'),true);
    }
    const root = settingsPath.slice(0,settingsPath.lastIndexOf('/')+1);
    const settings = sanitizeSettings(JSON.parse(new TextDecoder().decode(await read(settingsPath))));
    const refs = settings.FileReferences;
    // VTube Studio can keep expressions/motions beside the model without listing them.
    // AIRI also discovers exp3 entries. Only use real files within this model root.
    discoverUnlistedReferences(refs,archivePaths,root);
    const expressions = new Map<string,unknown>();
    const resolve = async (path: unknown, mime='application/octet-stream') => {
      if(typeof path !== 'string')throw new Error('Invalid resource reference');
      const data=await read(normalizePath(root+path));
      const url=URL.createObjectURL(new Blob([data],{type:mime}));blobs.push(url);activeURLs.add(url);return url;
    };
    for(const exp of refs.Expressions ?? []) {
      if(typeof exp.Name !== 'string'||expressions.has(exp.Name))throw new Error('Invalid expression name');
      expressions.set(exp.Name,JSON.parse(new TextDecoder().decode(await read(normalizePath(root+exp.File)))));
    }
    // All external references are replaced with host-approved data blobs, including optional sounds.
    refs.Moc=await resolve(refs.Moc);
    refs.Textures=await Promise.all(refs.Textures.map((p:string)=>resolve(p,'image/png')));
    for(const k of ['Physics','Pose','DisplayInfo']) if(refs[k]!==undefined)refs[k]=await resolve(refs[k],'application/json');
    for(const group of Object.values(refs.Motions ?? {}) as any[][]) for(const motion of group) {motion.File=await resolve(motion.File,'application/json');delete motion.Sound;}
    // Local expression controller is sole owner. SDK expression manager receives no expressions.
    delete refs.Expressions;
    settings.url='model.model3.json';
    return {settings,expressions,dispose};
  } catch(error) {dispose();throw error;}
}
