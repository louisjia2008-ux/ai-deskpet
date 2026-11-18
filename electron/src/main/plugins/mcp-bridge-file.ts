import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

const document = z.object({version:z.literal(1),kind:z.literal('deskpet-stdio-bridge'),name:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/iu),endpoint:z.string()}).strict();
export const bridgeEndpoint = (value: string): { origin:string; token:string } => {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/mcp\/([a-f0-9]{64})$/u.exec(value);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('extensions.invalidBridge');
  return {origin:'http://127.0.0.1:'+match[1],token:match[2]!};
};
export const isBridgeEndpoint = (value: string): boolean => {
  try { bridgeEndpoint(value); return true; } catch { return false; }
};
export const bridgeDigest = (name: string, endpoint: string): string => createHash('sha256').update(JSON.stringify([name,endpoint])).digest('hex');
export const displayBridge = (origin: string): string => new URL(origin).origin + '/…';
export const blockBridgeEcho = (value: unknown, token: string): void => {
  if (JSON.stringify(value).includes(token)) throw new Error('extensions.privateBridge');
};
export async function readBridgeFile(file: string): Promise<{name:string;endpoint:string;digest:string;origin:string}> {
  const reject = () => { throw new Error('extensions.invalidBridge'); };
  const root = await realpath(tmpdir()), directory = dirname(file), uid = process.getuid?.();
  if (uid === undefined || basename(file) !== 'bridge.json' || !/^deskpet-mcp-bridge-[a-zA-Z0-9]{6}$/u.test(basename(directory))
    || directory !== join(root,basename(directory)) || await realpath(file) !== file) reject();
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777)!==0o700) reject();
  const handle = await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await handle.stat();
    if (!stat.isFile() || stat.nlink!==1 || stat.uid!==uid || (stat.mode&0o7777)!==0o600 || stat.size<2 || stat.size>2048) reject();
    const buffer=Buffer.alloc(stat.size+1);
    let size=0;
    while(size<buffer.length){ const read=await handle.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead; }
    if (size!==stat.size) reject();
    const end=await lstat(file), dirEnd=await lstat(directory);
    if (end.dev!==stat.dev || end.ino!==stat.ino || end.mode!==stat.mode || end.nlink!==1 || end.uid!==uid ||
      end.size!==stat.size || end.ctimeMs!==stat.ctimeMs || dirEnd.dev!==parent.dev || dirEnd.ino!==parent.ino || dirEnd.mode!==parent.mode ||
      dirEnd.uid!==uid || await realpath(file)!==file) reject();
    const {name,endpoint}=document.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size))));
    const {origin,token}=bridgeEndpoint(endpoint);blockBridgeEcho(name,token);
    return {name,endpoint,origin,digest:bridgeDigest(name,endpoint)};
  } catch { throw new Error('extensions.invalidBridge'); }
  finally { await handle.close(); }
}
