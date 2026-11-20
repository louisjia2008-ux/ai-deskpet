/* global process, Buffer, __dirname, setTimeout, clearTimeout, WebSocket */
'use strict';
// Local evidence helpers only. Never launch the interactive product branch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const check = (value, code) => { if (!value) throw Error(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function digest(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(256 * 1024), result = crypto.createHash('sha256');
  try { let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) result.update(buffer.subarray(0, count)); return result.digest('hex'); }
  finally { buffer.fill(0); fs.closeSync(descriptor); }
}
const canonicalDirectory = value => path.isAbsolute(value) && value === path.resolve(value)
  && !fs.lstatSync(value).isSymbolicLink() && fs.lstatSync(value).isDirectory() && fs.realpathSync(value) === value;
const stopped = root => {
  check(canonicalDirectory(root), 'invalid-stopped-directory');
  check(!fs.readdirSync(root).some(name => ['SingletonLock','SingletonCookie','SingletonSocket','restore-pending.json','recovery','.staging'].includes(name) || name.includes('.corrupt-')), 'writer-or-unresolved-recovery');
};
function inventory(root) {
  stopped(root); const rows = [];
  const visit = relative => {
    const file = path.join(root, relative), info = fs.lstatSync(file);
    check(!info.isSymbolicLink() && fs.realpathSync(file) === file, 'linked-profile-entry');
    if (info.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    else { check(info.isFile(), 'irregular-profile-entry'); rows.push([relative, info.size, digest(file)]); }
  };
  for (const name of fs.readdirSync(root).sort()) visit(name);
  return rows;
}
function loadConfiguration() {
  check(process.argv.length === 2, 'unexpected-arguments');
  const output = fs.realpathSync(__dirname), paths = JSON.parse(fs.readFileSync(path.join(output,'paths.json'),'utf8'));
  const identity = JSON.parse(fs.readFileSync(path.join(output,'package-identity.json'),'utf8'));
  check(paths.output === output && canonicalDirectory(paths.work) && paths.work === require('./config.cjs').context().stage, 'invalid-evidence-paths');
  check(paths.before === path.join(paths.work,'before') && paths.postclose === path.join(paths.work,'postclose')
    && paths.maintenance === path.join(paths.work,'maintenance'), 'invalid-copy-layout');
  const {config} = require('./config.cjs').context();
  check(paths.data === config.profileRoot && paths.daily === config.installedApp, 'unexpected-daily-path');
  check(['asarSHA256','mainSHA256','sourceSHA256','previousAppASARSHA256'].every(name => /^[a-f0-9]{64}$/u.test(identity[name])), 'invalid-package-identity');
  check(canonicalDirectory(identity.bundle) && !identity.bundle.startsWith(paths.data+'/'), 'invalid-accepted-bundle');
  return { output, paths, identity };
}
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value,null,2)+'\n', {flag:'wx',mode:0o600});
const deadline = (promise, code, milliseconds = 300_000) => {
  let timer; return Promise.race([promise,new Promise((_, reject) => { timer=setTimeout(()=>reject(Error(code)),milliseconds); })]).finally(()=>clearTimeout(timer));
};
function validateBootstrap(report, identity, profile) {
  check(report.verdict === 'PASS' && report.operation === 'read-only-profile-inspection' && report.readOnly === true
    && report.profilePath === profile && report.artifactMode === 'daily' && report.runtimeName === 'DeskPet Electron'
    && report.appASARSHA256 === identity.asarSHA256 && report.providerSecretValuesRead === false
    && report.sourceUnchangedDuringRead === true && report.compatibleWithCurrentSchema === true
    && report.projectionOnly?.pendingRestorePresent === false && report.projectionOnly?.noProjectionCommitted === true
    && report.runtimeIdentity?.isPackaged === true && report.runtimeIdentity?.mainBundleSHA256 === identity.mainSHA256
    && report.runtimeIdentity?.build?.sourceSHA256 === identity.sourceSHA256, 'bootstrap-inspection-rejected');
}
/** Hold only the maintenance reader's exit, evaluate a local comparison against
 * stopped copies, then restore its exit. No dialogs or Keychain ACLs are changed. */
async function maintenance({ bundle, profile, runtime, evidence, identity, inspect, args }) {
  stopped(profile); check(!fs.existsSync(runtime), 'maintenance-root-exists');
  check(canonicalDirectory(path.dirname(runtime)), 'invalid-maintenance-parent');
  check(digest(path.join(bundle,'Contents/Resources/app.asar')) === identity.asarSHA256, 'accepted-artifact-changed');
  fs.mkdirSync(runtime,{mode:0o700});
  writeJSON(path.join(runtime,'inspection-runtime.json'),{version:1,purpose:'deskpet-profile-inspection'});
  const reportFile=path.join(evidence,'bootstrap.json'), binary=path.join(bundle,'Contents/MacOS/deskpet-electron');
  const flags=['--inspect-brk=127.0.0.1:0','--deskpet-maintenance-root='+runtime,'--deskpet-inspect-profile='+profile,'--deskpet-inspection-report='+reportFile];
  const env={}; for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL']) if(process.env[key]) env[key]=process.env[key];
  let child, ws;
  try {
    child=spawn(binary,flags,{env,stdio:['ignore','ignore','pipe']});
    const exited=once(child,'exit');
    const endpoint=await deadline(new Promise((accept,reject)=>{
      let buffer=''; child.stderr.on('data',chunk=>{buffer=(buffer+chunk.toString()).slice(-4096);const match=buffer.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+)/iu);if(match)accept(match[1]);});
      child.once('error',()=>reject(Error('maintenance-spawn-failed')));exited.then(()=>reject(Error('maintenance-early-exit')),()=>reject(Error('maintenance-spawn-failed')));
    }),'maintenance-inspector-timeout');
    ws=new WebSocket(endpoint); await deadline(once(ws,'open'),'maintenance-attach-timeout');
    let sequence=0,wake; const pending=new Map(),scripts=new Map(),pauses=[];
    ws.addEventListener('message',event=>{
      const value=JSON.parse(String(event.data));
      if(value.method==='Debugger.scriptParsed')scripts.set(value.params.scriptId,value.params.url);
      if(value.method==='Debugger.paused'){if(wake){const next=wake;wake=null;next(value.params);}else pauses.push(value.params);}
      const job=pending.get(value.id);if(job){pending.delete(value.id);if(value.error)job.reject(Error('maintenance-rpc-failed'));else job.accept(value.result);}
    });
    const rpc=(method,params={})=>deadline(new Promise((accept,reject)=>{const id=++sequence;pending.set(id,{accept,reject});ws.send(JSON.stringify({id,method,params}));}),'maintenance-rpc-timeout');
    await rpc('Runtime.enable');await rpc('Debugger.enable');
    const bp=await rpc('Debugger.setBreakpointByUrl',{lineNumber:0,urlRegex:'\\.webpack/main/index\\.js$'});
    await rpc('Runtime.runIfWaitingForDebugger');let frame;
    for(let count=0;count<8;count++){
      const pause=await deadline(pauses.length?Promise.resolve(pauses.shift()):new Promise(resolve=>{wake=resolve;}),'maintenance-entry-timeout');
      frame=pause.callFrames.find(value=>(value.url||scripts.get(value.location.scriptId)||'').endsWith('.webpack/main/index.js'));
      if(frame)break;await rpc('Debugger.resume');
    }
    check(frame,'wrong-maintenance-entry');
    const hold=await rpc('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:"(()=>{const {app}=require('electron');globalThis.__usabilityInspectionExit=app.exit.bind(app);app.exit=()=>{};return true;})()",returnByValue:true});
    check(!hold.exceptionDetails&&hold.result.value===true,'maintenance-exit-hold-failed');
    await rpc('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await rpc('Debugger.resume');
    // The report appears before it is fully written: wait until it parses, not merely exists.
    const readReport=()=>{try{return JSON.parse(fs.readFileSync(reportFile,'utf8'));}catch{return null;}};
    const until=Date.now()+540_000;let bootstrap=readReport();
    while(!bootstrap&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,100));bootstrap=readReport();}
    check(bootstrap,'maintenance-bootstrap-timeout');validateBootstrap(bootstrap,identity,profile);
    const checkedArgs={...args,installedAsar:path.join(bundle,'Contents/Resources/app.asar'),expectedSHA:identity.asarSHA256};
    const expression=`(()=>{const require=process.getBuiltinModule('module').createRequire(process.execPath);const {app}=require('electron');if(!app.isPackaged||app.getName()!=='DeskPet Electron'||app.getAppPath()!==${JSON.stringify(checkedArgs.installedAsar)}||process.execPath!==${JSON.stringify(binary)}||app.getPath('userData')!==${JSON.stringify(path.join(runtime,'profile'))}||!${JSON.stringify(flags.slice(1))}.every(flag=>process.argv.includes(flag)))throw Error('wrong-maintenance-identity');return (${inspect.toString()})(${JSON.stringify(checkedArgs)});})()`;
    const result=await rpc('Runtime.evaluate',{expression,includeCommandLineAPI:true,returnByValue:true,awaitPromise:true});
    check(!result.exceptionDetails,'private-comparison-refused');
    await rpc('Runtime.evaluate',{expression:"(()=>{const require=process.getBuiltinModule('module').createRequire(process.execPath);const {app}=require('electron');const exit=globalThis.__usabilityInspectionExit;app.exit=exit;setTimeout(()=>exit(0),0);return true;})()",returnByValue:true});
    ws.close();ws=null;const [exitCode,signal]=await deadline(exited,'maintenance-exit-timeout');check(exitCode===0&&!signal,'maintenance-exit-unclean');
    return {bootstrap,result:result.result.value};
  } finally {ws?.close();if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}
}
module.exports={check,hash,digest,canonicalDirectory,stopped,inventory,loadConfiguration,writeJSON,maintenance};
