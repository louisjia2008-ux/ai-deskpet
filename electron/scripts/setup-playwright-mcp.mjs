import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'playwright-mcp-runtime');
// The service worker does not inherit this variable, so the browser must land
// in Playwright's default cache where the worker will look for it.
delete process.env.PLAYWRIGHT_BROWSERS_PATH;
const check = process.argv.includes('--check');
if (!check) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error('Could not install the pinned Playwright MCP runtime.');
  const browser = spawnSync(process.execPath, [join(root, 'node_modules', 'playwright-core', 'cli.js'), 'install', '--only-shell', 'chromium'], { stdio: 'inherit', shell: false });
  if (browser.status !== 0) throw new Error('Could not install the Playwright headless browser.');
}
const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const name of ['@playwright/mcp', '@modelcontextprotocol/sdk']) {
  const actual = JSON.parse(await readFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
  if (actual.version !== expected.dependencies[name]) throw new Error('Playwright MCP runtime version mismatch: ' + name);
}
await access(join(root, 'server.cjs'), constants.R_OK);
// Resolve the same headless shell that server.cjs launches.
const { registry } = createRequire(join(root, 'package.json'))('playwright-core/lib/coreBundle');
const browserPath = registry.registry.findExecutable('chromium-headless-shell')?.executablePath();
const browserPresent = !!browserPath && existsSync(browserPath);
console.log(JSON.stringify({ runtime: '@playwright/mcp', version: expected.dependencies['@playwright/mcp'], pinnedDependencies: true, browserPresent, browser: 'Playwright headless shell in a separate context; the installed Chrome and its profiles are not used.' }));
if (!browserPresent) console.warn('Run npm run prepare:playwright-mcp to install the Playwright headless browser.');
