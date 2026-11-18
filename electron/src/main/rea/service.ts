import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import type { ReaResult, ReaStatus, ReaTarget } from '../../shared/rea';
import type { PermissionLease } from '../runtime/permissions';
import { PermissionDeniedError } from '../runtime/permissions';
import { ReaStdioClient } from './stdio-client';
import type { ReaRuntimeConfig, ReaToolReply } from './stdio-client';
import { ReaTargetBoundary } from './target-boundary';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().refine(isAbsolute);
const runtimeSchema = z.object({ executablePath:path,executableSHA256:hash,entryPath:path,entrySHA256:hash,packageRoot:path,manifestPath:path,manifestSHA256:hash,expectedToolContractsSHA256:hash,darwinSwiftcPath:path.optional(),darwinSwiftcSHA256:hash.optional(),darwinSDKRoot:path.optional() }).strict();
interface Selected { target:ReaTarget; boundary:ReaTargetBoundary; token:string; client:ReaStdioClient; root:string; controller:AbortController|null; results:Map<string,{result:ReaResult;analysisToken:string}> }
interface Dependencies { assertSession(id:string):void; lease():Promise<PermissionLease> }
const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Explicit main-chat adapter only. No registry accessible to jobs, children, schedules or events. */
export class ReaService {
  readonly #selected = new Map<string,Selected>();
  #runtimeCheck: Promise<ReaStatus> | null = null;
  #runtimeCheckClient: ReaStdioClient | null = null;
  #runtimeCheckEpoch = 0;
  #lastRuntimeCheck: { signature: string; status: ReaStatus } | null = null;
  #closing = false;
  constructor(private readonly dataRoot:string,private readonly manifestPath:string,private readonly dependencies:Dependencies) {}
  get active():boolean { return this.#runtimeCheck !== null || [...this.#selected.values()].some((s)=>s.controller!==null); }
  async status():Promise<ReaStatus> {
    if (this.#closing) return this.#runtimeStatus(false, 'rea.closed');
    try {
      const config = await this.#runtime(), signature = await this.#runtimeSignature(config);
      const previous = this.#lastRuntimeCheck;
      if (previous?.signature === signature) return { ...previous.status, active: this.active };
      return this.#runtimeStatus(false, 'rea.runtimeNotChecked', '6.8.0');
    } catch (error) { return this.#runtimeStatus(false, this.#runtimeFailure(error)); }
  }
  #runtimeStatus(available:boolean,reasonCode:string,version:string|null=null,checkedAt:string|null=null):ReaStatus {
    return { available, version, active:this.active, reasonCode, verified:available, checkedAt };
  }
  #runtimeFailure(error:unknown):string {
    if (error instanceof PermissionDeniedError || (error instanceof Error && error.message === 'permission.revoked')) return 'rea.permissionDenied';
    if (error instanceof Error && /^rea\.[a-zA-Z]+$/u.test(error.message)) return error.message;
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'rea.runtimeMissing';
    return 'rea.runtimeUnavailable';
  }
  /** Cheap freshness check. Full byte hashes and the MCP handshake run only on explicit check/start. */
  async #runtimeSignature(config:Omit<ReaRuntimeConfig,'sessionRoot'>):Promise<string> {
    const signatures:string[] = [JSON.stringify(config)];
    for (const path of [this.manifestPath, config.executablePath, config.entryPath, config.manifestPath]) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw Error('rea.runtimePathInvalid');
      signatures.push(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
    }
    for (const path of [config.packageRoot, ...(config.darwinSDKRoot ? [config.darwinSDKRoot] : [])]) {
      if (!(await lstat(path)).isDirectory()) throw Error('rea.runtimePathInvalid');
    }
    return signatures.join('|');
  }
  checkRuntime():Promise<ReaStatus> {
    if (this.#runtimeCheck) return this.#runtimeCheck;
    const checking = this.#checkRuntime(); this.#runtimeCheck = checking;
    void checking.finally(() => { if (this.#runtimeCheck === checking) this.#runtimeCheck = null; });
    return checking;
  }
  async #checkRuntime():Promise<ReaStatus> {
    let lease:PermissionLease|undefined,client:ReaStdioClient|undefined,signature='';
    const epoch=this.#runtimeCheckEpoch;
    const current=():void=>{lease?.assertCurrent();if(this.#closing)throw Error('rea.closed');if(epoch!==this.#runtimeCheckEpoch)throw Error('rea.cancelled');};
    const revoke=():void => { void client?.close().catch(()=>undefined); };
    let failure:string|null=null;
    try {
      current();
      lease=await this.dependencies.lease(); current();
      const config=await this.#runtime(); signature=await this.#runtimeSignature(config);
      const checkRoot=join(this.dataRoot,'rea-analysis','runtime-checks');await mkdir(checkRoot,{recursive:true,mode:0o700});
      const root=await realpath(checkRoot);
      // Each handshake owns a fresh private session; it never receives target paths or model credentials.
      const sessionRoot=join(root,randomUUID());await mkdir(sessionRoot,{mode:0o700});
      client=new ReaStdioClient({...config,sessionRoot});this.#runtimeCheckClient=client;
      lease.signal.addEventListener('abort',revoke,{once:true});current();
      await client.start();current();
      if (signature !== await this.#runtimeSignature(await this.#runtime())) throw Error('rea.runtimeIdentityMismatch');
      current();
    } catch(error) { failure=this.#runtimeFailure(error); }
    finally {
      lease?.signal.removeEventListener('abort',revoke);
      try { await client?.close(); } catch { failure='rea.cleanupUnconfirmed'; }
      lease?.release();if(this.#runtimeCheckClient===client)this.#runtimeCheckClient=null;
    }
    const status=this.#runtimeStatus(failure===null,failure??'rea.ready',failure===null?'6.8.0':null,new Date().toISOString());
    // The check process has closed before reporting readiness; active excludes this completed check.
    status.active=[...this.#selected.values()].some((s)=>s.controller!==null);
    this.#lastRuntimeCheck={signature,status};return structuredClone(status);
  }
  async #runtime():Promise<Omit<ReaRuntimeConfig,'sessionRoot'>> {
    let info;try{info=await lstat(this.manifestPath);}catch{throw Error('rea.runtimeUnavailable');}
    if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw Error('rea.runtimeUnavailable');
    const parsed = runtimeSchema.parse(JSON.parse(await readFile(this.manifestPath,'utf8')));
    return {...parsed, darwinSwiftcPath:parsed.darwinSwiftcPath??'', darwinSwiftcSHA256:parsed.darwinSwiftcSHA256??'', darwinSDKRoot:parsed.darwinSDKRoot??''};
  }
  async bind(sessionId:string,selectedPath:string, existingLease?:PermissionLease):Promise<ReaTarget> {
    this.dependencies.assertSession(sessionId);if(this.#closing)throw Error('rea.closed');
    if(this.#selected.size>=8)throw Error('rea.targetLimit');
    const lease=existingLease??await this.dependencies.lease();
    try {
      lease.assertCurrent();const config=await this.#runtime();
      const directory=join(this.dataRoot,'rea-analysis',sessionId,randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
      if ((await lstat(selectedPath)).isSymbolicLink()) throw Error('rea.linkedTarget');
      const root=await realpath(directory),source=await realpath(selectedPath),profile=await realpath(this.dataRoot);
      if(source===profile||source.startsWith(profile+sep)||profile.startsWith(source+sep))throw Error('rea.targetOutOfScope');
      const boundary=new ReaTargetBoundary(root,{forbiddenRoots:[profile]});const bound=await boundary.bind(selectedPath);lease.assertCurrent();
      const target:ReaTarget={id:randomUUID(),sessionId,name:basename(source),identitySHA256:bound.identitySHA256,files:bound.files,bytes:bound.bytes,kind:bound.kind};
      this.dependencies.assertSession(sessionId);if(this.#closing)throw Error('rea.closed');
      const client=new ReaStdioClient({...config,sessionRoot:root});
      this.#selected.set(target.id,{target,boundary,token:bound.token,client,root,controller:null,results:new Map()});return structuredClone(target);
    }catch(error){throw this.#safe(error);}finally{if(!existingLease)lease.release();}
  }
  #target(sessionId:string,targetId:string):Selected {
    this.dependencies.assertSession(sessionId);const selected=this.#selected.get(targetId);
    if(this.#closing||!selected||selected.target.sessionId!==sessionId)throw Error('rea.targetTokenInvalid');return selected;
  }
  #safe(error:unknown):Error { const code=error instanceof Error?error.message:'';return Error(/^rea\.[a-zA-Z]+$/u.test(code)?code:'rea.operationFailed'); }
  #evidence(reply:ReaToolReply):string {
    const value=reply.structuredContent;
    const normalized=object(value)?value.normalized_result:undefined;
    const id=object(normalized)?normalized.parent_evidence_id:undefined;
    if(typeof id!=='string'||!/^ev_[a-f0-9]{64}$/u.test(id))throw Error('rea.retainedEvidenceUnavailable');return id;
  }
  async #call(selected:Selected,tool:ReaResult['tool'],args:Record<string,unknown>,analysisToken?:string):Promise<ReaResult> {
    if(selected.controller)throw Error('rea.sessionBusy');
    if(selected.results.size>=16)throw Error('rea.resultLimit');
    const controller=new AbortController();selected.controller=controller;
    let lease:PermissionLease|undefined;
    const revoke=()=>{controller.abort();void selected.client.close().catch(()=>undefined);};
    const current=():void=>{
      controller.signal.throwIfAborted();lease?.assertCurrent();
      this.dependencies.assertSession(selected.target.sessionId);
      if(this.#closing||this.#selected.get(selected.target.id)!==selected)throw Error('rea.targetTokenInvalid');
    };
    try {
      lease=await this.dependencies.lease();lease.signal.addEventListener('abort',revoke,{once:true});
      current();await selected.boundary.verify(selected.token);current();await selected.client.start();current();
      const reply=await selected.client.callTool(tool,args,{signal:controller.signal});current();
      if(reply.isError)throw Error('rea.toolFailed');
      const envelope=reply.structuredContent;
      if(!object(envelope)||!object(envelope.normalized_result))throw Error('rea.staticResultUnavailable');
      const normalized=envelope.normalized_result,expected=selected.boundary.resolve(selected.token);
      const expectedEvidence=analysisToken?selected.boundary.resolveAnalysis(selected.token,analysisToken).evidenceId:null;
      if(normalized.parent_operation!=='analyze_javascript_application'||!object(normalized.artifact)||normalized.artifact.path!==expected.snapshotPath
        ||(expectedEvidence!==null?normalized.parent_evidence_id!==expectedEvidence:normalized.kind!=='summary'))throw Error('rea.resultIdentityMismatch');
      const token=analysisToken??selected.boundary.retainAnalysis(selected.token,this.#evidence(reply));
      // Generic protocol instructions, stderr and process metadata are never forwarded.
      const data={tool,targetIdentitySHA256:selected.target.identitySHA256,staticAnalysis:envelope.normalized_result},text=JSON.stringify(data,null,2),id=randomUUID();
      const result:ReaResult={id,targetId:selected.target.id,sessionId:selected.target.sessionId,targetIdentitySHA256:selected.target.identitySHA256,tool,
        text:text.slice(0,16000),truncated:text.length>16000,untrusted:true,privacy:'local-only'};
      await writeFile(join(selected.root,`host-result-${id}.json`),JSON.stringify({result,provenance:reply.provenance},null,2),{flag:'wx',mode:0o600});
      current();selected.results.set(id,{result,analysisToken:token});return structuredClone(result);
    }catch(error){
      if(controller.signal.aborted||lease?.signal.aborted||this.#closing||this.#selected.get(selected.target.id)!==selected){
        await selected.client.close();selected.boundary.dispose();this.#selected.delete(selected.target.id);
      }
      throw this.#safe(error);
    }finally{
      lease?.signal.removeEventListener('abort',revoke);lease?.release();
      if(selected.controller===controller)selected.controller=null;
    }
  }
  async analyze(input:{sessionId:string;targetId:string}):Promise<ReaResult> {const s=this.#target(input.sessionId,input.targetId);return this.#call(s,'analyze_javascript_application',await s.boundary.analyzeArguments(s.token));}
  async inspect(input:{sessionId:string;targetId:string;resultId:string;view:'summary'|'modules'|'boundaries'}):Promise<ReaResult> {
    const s=this.#target(input.sessionId,input.targetId),prior=s.results.get(input.resultId);if(!prior)throw Error('rea.analysisTokenInvalid');
    return this.#call(s,'inspect_analysis_view',s.boundary.inspectArguments(s.token,prior.analysisToken,input.view),prior.analysisToken);
  }
  material(sessionId:string,resultId:string):ReaResult {
    this.dependencies.assertSession(sessionId);
    for(const s of this.#selected.values())if(s.target.sessionId===sessionId){const record=s.results.get(resultId);if(record)return structuredClone(record.result);}
    throw Error('rea.analysisTokenInvalid');
  }
  async cancel(sessionId:string):Promise<void> {
    await Promise.all([...this.#selected.values()].filter(s=>s.target.sessionId===sessionId).map(async s=>{s.controller?.abort();await s.client.close();s.boundary.dispose();this.#selected.delete(s.target.id);}));
  }
  async cancelAll():Promise<void> {
    this.#runtimeCheckEpoch++;await this.#runtimeCheckClient?.close();await this.#runtimeCheck;
    await Promise.all([...this.#selected.values()].map(async s=>{s.controller?.abort();await s.client.close();s.boundary.dispose();this.#selected.delete(s.target.id);}));
  }
  async shutdown():Promise<void> {this.#closing=true;await this.cancelAll();}
}
