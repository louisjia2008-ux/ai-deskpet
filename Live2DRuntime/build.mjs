import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdir,copyFile,readFile,writeFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const out=new URL('../Resources/Live2DRuntime/',import.meta.url);
const core=process.env.DESKPET_CUBISM_CORE;
if(!core)throw new Error('Set DESKPET_CUBISM_CORE to official CubismSdkForWeb-5-r.3/Core/live2dcubismcore.min.js; see README.md');
const coreData=await readFile(core);
if(createHash('sha256').update(coreData).digest('hex')!=='944988f1523c9f888afe3611b630121ff503ea6246971d2eeee76f45cbfb8004')throw new Error('Cubism Core does not match audited SDK 5-r.3 hash');
await mkdir(out,{recursive:true});
await build({entryPoints:['src/index.ts'],bundle:true,format:'iife',target:'safari17',outfile:fileURLToPath(new URL('runtime.js',out)),legalComments:'eof',metafile:true}).then(async r=>writeFile('bundle-metafile.json',JSON.stringify(r.metafile,null,2)));
await copyFile('static/index.html',new URL('index.html',out));await copyFile(core,new URL('live2dcubismcore.min.js',out));
const hashes={};for(const name of ['runtime.js','index.html','live2dcubismcore.min.js'])hashes[name]=createHash('sha256').update(await readFile(new URL(name,out))).digest('hex');
await writeFile(new URL('manifest.json',out),JSON.stringify({version:1,upstream:'00c6867b7fd8064938de1805814578db8273dafe',hashes},null,2));

const notices=new URL('Notices/',out);await mkdir(notices,{recursive:true});
for(const name of await readdir('../ThirdParty'))await copyFile('../ThirdParty/'+name,new URL(name,notices));
for(const pkg of ['pixi-live2d-display','@pixi/core','jszip'])for(const name of await readdir('node_modules/'+pkg))if(name.toLowerCase().includes('license'))await copyFile('node_modules/'+pkg+'/'+name,new URL(pkg.replace('/','_')+'_'+name,notices));
