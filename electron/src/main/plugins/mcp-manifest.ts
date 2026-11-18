import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { mcpEndpoint } from '../../shared/desktop-extensions';
import type { ManifestPreview } from '../../shared/desktop-extensions';

const entry = z.object({ url: z.string().min(1).max(2048), type: z.enum(['http','streamable-http']).optional() }).strict();

export async function readMcpManifest(file: string, existing: readonly string[]): Promise<Omit<ManifestPreview,'id'>> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 128_000) throw new Error('extensions.invalidManifest');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) { const part = await handle.read(bytes,size,bytes.length-size,size); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size !== stat.size) throw new Error('extensions.invalidManifest');
    const data = z.record(z.string(),z.unknown()).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size))));
    const entries: [string,unknown][] = Array.isArray(data.remotes) && typeof data.name === 'string'
      ? data.remotes.map(remote => [String(data.name), remote])
      : Object.entries(z.record(z.string(),z.unknown()).parse(data.mcpServers ?? data.servers));
    if (entries.length > 64) throw new Error('extensions.invalidManifest');
    const seen = new Set(existing), servers: ManifestPreview['servers'] = [];
    let skipped = 0, duplicates = 0;
    for (const [name,value] of entries) {
      const parsed = entry.safeParse(value);
      // No command, headers, env, credentials, URL templates, private URLs or
      // opaque path tokens from a manifest are copied into state or diagnostics.
      if (!parsed.success || !name.trim() || name.length > 100 || /[\p{C}]/u.test(name)) { skipped++; continue; }
      let endpoint: string;
      try {
        endpoint = mcpEndpoint(parsed.data.url);
        if (endpoint!=='https://api.githubcopilot.com/mcp/readonly' && !new URL(endpoint).pathname.split('/').filter(Boolean).every(part=>/^(?:api|v\d+|mcp|http|streamable-http|server)$/u.test(part))) throw new Error('extensions.endpoint');
      } catch { skipped++; continue; }
      if (seen.has(endpoint)) { duplicates++; continue; }
      seen.add(endpoint); servers.push({ name: name.trim(), endpoint });
    }
    if (servers.length > 32) throw new Error('extensions.invalidManifest');
    return { servers, skipped, duplicates };
  } finally { await handle.close(); }
}
