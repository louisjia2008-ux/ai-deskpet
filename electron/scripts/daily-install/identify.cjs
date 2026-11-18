/* global process, console */
'use strict';
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const sha = value => createHash('sha256').update(value).digest('hex');

function resourceManifest(root) {
  return Object.fromEntries(readdirSync(root).sort().map(name => {
    const file = join(root, name);
    if (!lstatSync(file).isFile() || !/^(?:[a-z][a-z0-9_]*\.(?:py|cjs)|acknowledged-cat\.png)$/u.test(name))
      throw Error('Unexpected item in the WeChat runtime resource directory.');
    return [name, sha(readFileSync(file))];
  }));
}

function verifyWeChatRuntime(bundle, project) {
  const runtime = resourceManifest(join(bundle, 'Contents/Resources/wechat-runtime'));
  if (JSON.stringify(runtime) !== JSON.stringify(resourceManifest(join(project, 'wechat-runtime'))))
    throw Error('The sealed WeChat resources do not match the reviewed source files.');
  return runtime;
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Pass the final daily app bundle path.');
  const { project, config, stage } = require('./config.cjs').context();
  const { extractFile } = require(join(project, 'node_modules/@electron/asar'));
  const bundle = realpathSync(resolve(process.argv[2]));
  const { verifyMacPackage } = await import(pathToFileURL(join(project, 'scripts/verify-mac-package.mjs')).href);
  const signature = verifyMacPackage(bundle, 'daily', config.signingIdentity);
  const asar = join(bundle, 'Contents/Resources/app.asar');
  const main = extractFile(asar, '.webpack/main/index.js');
  const source = [...new Set([...main.toString().matchAll(/sourceSHA256"?\s*:\s*"([a-f0-9]{64})"/gu)].map(match => match[1]))];
  if (source.length !== 1) throw new Error('Expected a unique build source hash in the candidate.');
  const previousAsar = join(config.installedApp, 'Contents/Resources/app.asar');
  const identity = { bundle, asarSHA256: sha(readFileSync(asar)), mainSHA256: sha(main), sourceSHA256: source[0],
    previousAppASARSHA256: sha(readFileSync(previousAsar)), signature };
  const baseline = JSON.parse(readFileSync(join(stage, 'baseline.json'), 'utf8')).asarSHA256;
  if (identity.previousAppASARSHA256 !== baseline || identity.asarSHA256 === baseline) throw new Error('Current daily identity changed or candidate is the old build.');
  identity.wechatRuntime = verifyWeChatRuntime(bundle, project);
  writeFileSync(join(stage, 'package-identity.json'), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...identity, wechatRuntime: Object.keys(identity.wechatRuntime) }));
}
module.exports = { verifyWeChatRuntime };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
