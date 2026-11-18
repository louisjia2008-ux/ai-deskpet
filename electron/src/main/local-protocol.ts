import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { readMediaProtocolFile } from './media/media-file';

const APP_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.png', '.svg', '.woff', '.woff2']);
const MODEL_EXTENSIONS = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.m4a', '.bytes']);

export const registerDeskPetScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'deskpet',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
};

const containedPath = async (root: string, pathname: string): Promise<string> => {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid local protocol path.');
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(join(canonicalRoot, decoded));
  const path = relative(canonicalRoot, candidate);
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('Local protocol path escaped its root.');
  return candidate;
};

export const installLocalProtocol = async (managedRoot: string): Promise<void> => {
  const rendererRoot = await realpath(join(__dirname, '..', 'renderer'));
  protocol.handle('deskpet', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'app') {
      const path = await containedPath(rendererRoot, url.pathname);
      if (!APP_EXTENSIONS.has(extname(path).toLowerCase())) return new Response(null, { status: 403 });
      return net.fetch(pathToFileURL(path).toString());
    }
    if (url.hostname === 'managed') {
      const root = await realpath(managedRoot);
      const mediaPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (mediaPath.startsWith('reply-images/')) {
        try {
          const media = await readMediaProtocolFile(root, mediaPath);
          if (!media) return new Response(null, { status: 404 });
          return new Response(new Uint8Array(media.bytes), { headers: { 'content-type': media.mime, 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': 'deskpet://app' } });
        } catch { return new Response(null, { status: 404 }); }
      }
      const path = await containedPath(root, url.pathname);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const isCore = relativePath === 'core/live2dcubismcore.min.js';
      const isModel = relativePath.startsWith('models/') && MODEL_EXTENSIONS.has(extname(path).toLowerCase());
      if (!isCore && !isModel) return new Response(null, { status: 403 });
      const response = await net.fetch(pathToFileURL(path).toString());
      const managed = new Response(response.body, { status: response.status, headers: response.headers });
      managed.headers.set('Access-Control-Allow-Origin', 'deskpet://app');
      return managed;
    }
    return new Response(null, { status: 404 });
  });
};
