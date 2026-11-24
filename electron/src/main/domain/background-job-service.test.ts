// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJobInput } from '../../shared/background-jobs';
import type { ProviderConfig } from '../../shared';
import type { SafeStorageVault } from '../security';
import { ProviderService } from '../providers/provider-service';
import { EncryptedJsonStore } from '../persistence/encrypted-json-store';
import { decryptJson } from '../persistence/encryption';
import type * as AtomicFile from '../persistence/atomic-file';
import { BackgroundJobService } from './background-job-service';
import { ChatService } from './chat-service';
import { DomainRepository } from './repository';
import { persistentStateSchema } from './schemas';

const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before' | 'after', predicate: null as null | ((serialized: string) => boolean) }));
vi.mock('../persistence/atomic-file', async (original) => {
  const actual = await original<typeof AtomicFile>();
  return { ...actual, atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
    const mode = fault.predicate && !fault.predicate(String(args[1])) ? 'none' : fault.mode;
    if (mode !== 'none') { fault.mode = 'none'; fault.predicate = null; }
    if (mode === 'before') throw new Error('fixture.before-rename');
    await actual.atomicWriteFile(...args);
    if (mode === 'after') throw new Error('fixture.after-rename');
  } };
});

const evidenceRoot = process.env.DESKPET_EP2_UNIT_EVIDENCE_ROOT ?? join(process.cwd(), '../../output/deskpet-electron-ep2-20261028/unitservice');
const key = Buffer.alloc(32, 83);
const config: ProviderConfig = {
  id: '0e5e71f9-5987-486d-bb03-f75c4c693783', kind: 'lm-studio', name: 'Synthetic E-P2 service',
  baseUrl: 'http://127.0.0.1:19872/v1', model: 'ep2-synthetic', enabled: true, supportsTools: true,
  localExecutionConfirmed: true, contextWindowTokens: 8192, maxOutputTokens: 512, secretState: 'configured',
};
const input = (instruction = 'JOB_INSTRUCTION_MARKER'): BackgroundJobInput => ({
  operationId: randomUUID(), instruction, material: 'ONLY_EXPLICIT_MATERIAL_MARKER', privacy: 'local-only', providerId: config.id, model: config.model,
});
type RecordedCall = { body: Record<string, unknown>; credentialsPresent: boolean; respond: (text?: string) => void };
const fixtures: Array<{ service: BackgroundJobService; calls: RecordedCall[] }> = [];

const fixture = async (label: string, available: () => boolean = () => true) => {
  const root = join(evidenceRoot, 'profiles', `${label}-${randomUUID()}`); await mkdir(root, { recursive: true });
  const path = join(root, 'profile.enc.json');
  const secrets = new Map([[config.id, 'FAKE_EP2_SERVICE_CREDENTIAL_ONLY']]);
  const vault = {
    getVaultKey: async () => Buffer.from(key), getSecret: async (id: string) => secrets.get(id) ?? null,
    setSecret: async (id: string, value: string) => { secrets.set(id, value); },
    deleteSecret: async (id: string) => { secrets.delete(id); }, hasSecret: async (id: string) => secrets.has(id), isAvailable: () => true,
  };
  const reopen = async () => { const repo = new DomainRepository(path, vault); await repo.initialize(); return repo; };
  const repo = await reopen();
  await repo.transaction((state) => { state.providers.push(config); state.providerCredentialRefs[config.id] = randomUUID(); });
  const calls: RecordedCall[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/api/show')) return Response.json({details:{format:'gguf'},model_info:{'general.architecture':'qwen','qwen.context_length':8192}});
    return new Promise<Response>((resolve) => {
    // Intentionally ignores AbortSignal: exercises a late server response after
    // cancellation. This is a controlled transport double, not live HTTP evidence.
    calls.push({ body: JSON.parse(String(options?.body)) as Record<string, unknown>,
      credentialsPresent: String((options?.headers as Record<string, string> | undefined)?.authorization ?? '').startsWith('Bearer '),
      respond: (text = 'PERSISTENT_JOB_RESULT_MARKER') => resolve(new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 11 } })}\n\ndata: [DONE]\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })),
    });
    });
  });
  vi.stubGlobal('fetch', fetcher);
  let service: BackgroundJobService;
  const providers = new ProviderService(repo, vault as unknown as SafeStorageVault, undefined, {
    prepared: async (record) => { await service.prepare(record); },
    observed: async (record) => { await service.observe(record); },
    beforeDispatch: (requestId) => service.assertDispatch(requestId),
  });
  service = new BackgroundJobService(repo, providers, () => undefined, available); fixtures.push({ service, calls });
  const arrived = async (count = 1) => { await vi.waitFor(() => expect(calls).toHaveLength(count)); return calls[count - 1]!; };
  const idle = async (allowUnknown = false) => { await vi.waitFor(() => expect(service.active).toBe(false)); await repo.flush().catch((error: unknown) => { if (!allowUnknown || !(error instanceof Error) || error.message !== 'repository.commitUncertain') throw error; }); };
  const evidence = async (name: string) => {
    const fresh = await reopen();
    await writeFile(join(root, `${name}.json`), JSON.stringify({ configuration: 'genuine encrypted repository + real ProviderService / OpenAI adapter; synthetic in-memory fetch; same-process fresh repository read',
      state: fresh.snapshot(), calls: calls.map(({ body, credentialsPresent }) => ({ body, credentialsPresent })) }, null, 2));
    return fresh.snapshot();
  };
  return { root, path, repo, vault, service, providers, calls, arrived, idle, reopen, evidence };
};
const armStatusFault = (status: string, mode: 'before' | 'after'): void => {
  fault.mode = mode;
  fault.predicate = (serialized) => decryptJson(JSON.parse(serialized), key, persistentStateSchema).backgroundJobs.some((job) => job.status === status);
};
afterEach(async () => {
  fault.mode = 'none'; fault.predicate = null; vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { for (const call of f.calls) call.respond(); await f.service.shutdown(); }
  vi.unstubAllGlobals();
});

describe('durable no-tool background text job service', () => {
  it('refuses cloud consent given for another address, checked when the connection is captured', async () => {
    const f = await fixture('consented-endpoint');
    await f.repo.transaction(state => { state.providers[0] = { ...config, kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol' }; });
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    await expect(f.service.submit({ ...input('Consent for A'), model: 'gpt-6.1-sol', privacy: 'cloud-allowed' }, undefined, undefined, 'https://gateway.example.invalid/v1'))
      .rejects.toThrow('provider.bindingMismatch');
    expect(f.repo.snapshot().backgroundJobs).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('completes an OpenAI Responses background job without unsupported sampling parameters and preserves exact request accounting', async () => {
    const f = await fixture('responses-reasoning');
    await f.repo.transaction(state => { state.providers[0] = { ...config, kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol' }; });
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      const body = JSON.parse(String(options?.body));
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      if (Object.hasOwn(body, 'temperature')) return Response.json({ error: { code: null, type: 'invalid_request_error', param: 'temperature', message: 'Unsupported parameter: temperature is not supported with this model.' } }, { status: 400 });
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好，记得休息一下。' }], status: 'completed' }], usage: { input_tokens: 37, output_tokens: 25 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetcher);
    const job = await f.service.submit({ ...input('A friendly check-in'), model: 'gpt-6.1-sol', privacy: 'cloud-allowed' });
    await f.idle();
    const saved = await f.service.get(job.id);
    expect(saved).toMatchObject({ status: 'succeeded', result: '你好，记得休息一下。' });
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, tool_choice: 'none', max_output_tokens: 512 });
    expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('tools');
    expect(saved.request?.observations.at(-1)).toMatchObject({ httpStatus: 200, outcome: 'completed', usage: { inputTokens: 37, outputTokens: 25 } });
    expect(saved.request?.bodySHA256).toBe(saved.request?.observations.at(-1)?.bodySHA256);
  });

  it.each(['maintenance', 'shutdown'] as const)('keeps pending binding capture busy and rejects stale acceptance after %s', async (mode) => {
    let available = true;
    const f = await fixture(`pending-capture-${mode}`, () => available);
    const binding = await f.providers.captureBinding(config.id, config.model);
    let releaseCapture!: () => void; let enteredCapture!: () => void;
    const release = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const entered = new Promise<void>((resolve) => { enteredCapture = resolve; });
    const capture = vi.spyOn(f.providers, 'captureBinding').mockImplementationOnce(async () => { enteredCapture(); await release; return binding; });
    const pending = f.service.submit(input()); await entered;
    expect(f.service.active).toBe(true); expect(f.calls).toHaveLength(0); expect(f.repo.snapshot().backgroundJobs).toHaveLength(0);
    if (mode === 'maintenance') available = false; else await f.service.shutdown();
    expect(f.service.active).toBe(true); releaseCapture();
    await expect(pending).rejects.toThrow('job.maintenance'); expect(f.service.active).toBe(false);
    expect(capture).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(0);
    expect((await f.evidence(`pending-capture-${mode}`)).backgroundJobs).toHaveLength(0);
    if (mode === 'maintenance') await expect(f.service.submit(input())).rejects.toThrow('job.maintenance');
  });

  it('deduplicates concurrent submit, lost acknowledgement retry and terminal replay; rejects changed content', async () => {
    const f = await fixture('duplicate'); const spec = input();
    fault.mode = 'after';
    const [a, b] = await Promise.all([f.service.submit(spec), f.service.submit(spec)]);
    expect(a.id).toBe(b.id); expect(a.attemptId).toBe(b.attemptId);
    const call = await f.arrived(); call.respond(); await f.idle();
    const replay = await f.service.submit(spec); expect(replay.id).toBe(a.id); expect(replay.status).toBe('succeeded');
    await expect(f.service.submit({ ...spec, material: 'CHANGED_MATERIAL' })).rejects.toThrow('job.operationConflict');
    const state = await f.evidence('deduplicated');
    expect(state.backgroundJobs).toHaveLength(1); expect(f.calls).toHaveLength(1);
    expect(state.backgroundJobs[0]?.receipts.filter((receipt) => receipt.kind === 'accepted')).toHaveLength(1);
    expect(state.backgroundJobs[0]?.receipts.filter((receipt) => receipt.kind === 'terminal')).toHaveLength(1);
    expect(state.backgroundJobs[0]?.request?.observations.at(-1)?.usage).toEqual({ inputTokens: 23, outputTokens: 11, source: 'provider-reported', reportedCostUSD: null });
    expect(call.body).toMatchObject({ model: config.model, tool_choice: 'none' }); expect(call.body).not.toHaveProperty('tools');
    expect(JSON.stringify(call.body)).not.toContain('FAKE_EP2_SERVICE_CREDENTIAL_ONLY');
    expect((await readFile(f.path, 'utf8'))).not.toContain('JOB_INSTRUCTION_MARKER');
  });

  it('keeps cancellation authoritative when a late response completes after cancel commit', async () => {
    const f = await fixture('cancel-first'); const job = await f.service.submit(input()); const call = await f.arrived();
    const cancelled = await f.service.cancel(job.id); expect(cancelled.status).toBe('cancelled');
    call.respond('LATE_SUCCESS_MUST_NOT_PUBLISH'); await f.idle();
    const state = await f.evidence('cancel-first'); const persisted = state.backgroundJobs[0]!;
    expect(persisted.status).toBe('cancelled'); expect(persisted.result).toBeNull(); expect(persisted.cancelRequestedAt).not.toBeNull();
    expect(persisted.request?.observations.some((observation) => observation.phase === 'fetch-invoked')).toBe(true);
    expect(persisted.receipts.filter((receipt) => receipt.status === 'succeeded')).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });

  it('does not publish an old skill job after disable and re-enable with identical text, while a new version-bound job can succeed', async () => {
    const f = await fixture('skill-disable-reenable'), skillId = randomUUID(), spec = input('Use the selected skill reference');
    await f.repo.transaction(state => {
      state.providers.find(provider => provider.id === config.id)!.kind = 'ollama';
      state.desktopExtensions.skills.push({id:skillId,name:'Synthetic skill',text:spec.material,enabled:true,revision:1});
    });
    const job = await f.service.submit(spec,undefined,skillId), call = await f.arrived();
    // These are separate durable mutations, matching the management toggle's
    // revision increments. The final text and enabled flag match the original.
    await f.repo.transaction(state => { const skill = state.desktopExtensions.skills.find(item => item.id === skillId)!; skill.enabled = false; skill.revision = 2; });
    await f.repo.transaction(state => { const skill = state.desktopExtensions.skills.find(item => item.id === skillId)!; skill.enabled = true; skill.revision = 3; });
    call.respond('STALE_SKILL_SUCCESS_MUST_NOT_PUBLISH'); await f.idle();
    const persisted = (await f.evidence('skill-revoked')).backgroundJobs.find(item => item.id === job.id)!;
    expect(persisted).toMatchObject({status:'blocked',completionReason:'job.privacyBlocked',result:null,specDigest:job.specDigest});
    expect(persisted.receipts.some(receipt => receipt.status === 'succeeded')).toBe(false);
    const replay = await f.service.submit(spec,undefined,skillId);
    expect(replay).toMatchObject({id:job.id,status:'blocked',specDigest:job.specDigest});
    expect(f.calls).toHaveLength(1);
    const fresh = await f.service.submit({...spec,operationId:randomUUID()},undefined,skillId);
    expect(fresh.specDigest).not.toBe(job.specDigest);
    (await f.arrived(2)).respond('CURRENT_SKILL_VERSION_RESULT'); await f.idle();
    const after = (await f.evidence('skill-new-version')).backgroundJobs;
    expect(after.find(item => item.id === job.id)).toMatchObject({status:'blocked',result:null});
    expect(after.find(item => item.id === fresh.id)).toMatchObject({status:'succeeded',result:'CURRENT_SKILL_VERSION_RESULT'});
  });

  it('fails closed on restart for a legacy queued skill job with no frozen skill version', async () => {
    const f = await fixture('legacy-queued-skill'), skillId = randomUUID(), spec = input('Legacy skill request');
    await f.repo.transaction(state => {
      state.providers.find(provider => provider.id === config.id)!.kind = 'ollama';
      state.desktopExtensions.skills.push({id:skillId,name:'Legacy synthetic skill',text:spec.material,enabled:true,revision:1});
    });
    const foreground = await f.providers.captureBinding(config.id,config.model);
    const frontRun = (async () => { for await (const event of foreground.adapter.streamChat({model:config.model,messages:[{role:'user',content:'FOREGROUND_HOLDS_LEGACY_QUEUE'}]})) void event; })();
    const frontCall = await f.arrived(), job = await f.service.submit(spec,undefined,skillId);
    await f.service.shutdown();
    await f.repo.transaction(state => {
      const stored = state.backgroundJobs.find(item => item.id === job.id)!;
      expect(stored).toMatchObject({status:'queued',request:null});
      // Historical records committed only the input, without skill identity,
      // content digest or revision. Never infer a new grant during recovery.
      stored.specDigest = createHash('sha256').update(JSON.stringify({instruction:spec.instruction,material:spec.material,privacy:spec.privacy,providerId:spec.providerId,model:spec.model})).digest('hex');
    });
    frontCall.respond('FOREGROUND_DONE'); await frontRun;
    const fresh = await f.reopen(); let resumed:BackgroundJobService;
    const providers = new ProviderService(fresh,f.vault as unknown as SafeStorageVault,undefined,{
      prepared:async record => {await resumed.prepare(record);}, observed:async record => {await resumed.observe(record);}, beforeDispatch:requestId => resumed.assertDispatch(requestId),
    });
    resumed = new BackgroundJobService(fresh,providers); fixtures.push({service:resumed,calls:f.calls}); await resumed.initialize();
    await vi.waitFor(() => expect(resumed.active).toBe(false));
    const persisted = (await f.evidence('legacy-skill-recovery')).backgroundJobs.find(item => item.id === job.id)!;
    expect(persisted).toMatchObject({status:'blocked',completionReason:'job.privacyBlocked',result:null,request:null});
    expect(persisted.receipts.some(receipt => receipt.status === 'succeeded')).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('returns already completed after success commits first and preserves result ownership', async () => {
    const f = await fixture('success-first'); const job = await f.service.submit(input()); (await f.arrived()).respond(); await f.idle();
    const before = await f.service.get(job.id); expect(before.status).toBe('succeeded');
    const cancelled = await f.service.cancel(job.id); expect(cancelled.status).toBe('succeeded'); expect(cancelled.result).toBe(before.result); expect(cancelled.cancelRequestedAt).toBeNull();
    const state = await f.evidence('success-first'); expect(state.backgroundJobs[0]?.resultOwner).toBe(job.id); expect(state.backgroundJobs[0]?.profileId).toBe(state.profileId);
    await expect(f.service.get(randomUUID())).rejects.toThrow('job.unavailable');
  });

  it('serializes concurrent chat writes without whole-profile overwrite and freezes the submitted binding', async () => {
    const f = await fixture('chat-concurrent'); const chat = new ChatService(f.repo); const session = await chat.createSession('UNSELECTED_CHAT', 'normal');
    await chat.addMessage({ sessionId: session.id, role: 'user', content: 'UNSELECTED_CHAT_SECRET', status: 'complete', errorCode: null });
    const job = await f.service.submit(input()); const call = await f.arrived();
    await chat.addMessage({ sessionId: session.id, role: 'assistant', content: 'FOREGROUND_RESULT_MUST_SURVIVE', status: 'complete', errorCode: null });
    await f.providers.setModel(config.id, 'changed-front-model'); call.respond(); await f.idle();
    const state = await f.evidence('chat-concurrent');
    expect(state.chatMessages.map((message) => message.content)).toEqual(['UNSELECTED_CHAT_SECRET', 'FOREGROUND_RESULT_MUST_SURVIVE']);
    expect(state.backgroundJobs.find((item) => item.id === job.id)).toMatchObject({ status: 'succeeded', result: 'PERSISTENT_JOB_RESULT_MARKER', binding: { model: config.model } });
    expect(call.body.model).toBe(config.model); expect(JSON.stringify(call.body)).not.toContain('UNSELECTED_CHAT');
  });

  it('blocks a queued job after its frozen credential reference is revoked before admission', async () => {
    const f = await fixture('queued-revoke');
    const foreground = await f.providers.captureBinding(config.id, config.model);
    const frontRun = (async () => { for await (const event of foreground.adapter.streamChat({ model: config.model, messages: [{ role: 'user', content: 'FOREGROUND_HOLDS_SLOT' }] })) void event; })();
    const call = await f.arrived(); const job = await f.service.submit(input());
    await f.providers.clearSecret(config.id); call.respond('FOREGROUND_DONE'); await frontRun; await f.idle();
    const state = await f.evidence('queued-revoke'); const blocked = state.backgroundJobs.find((item) => item.id === job.id)!;
    expect(blocked.status).toBe('blocked'); expect(blocked.completionReason).toBe('provider.bindingMismatch'); expect(blocked.request).toBeNull();
    expect(blocked.binding.credentialRef).not.toBe(state.providerCredentialRefs[config.id]); expect(f.calls).toHaveLength(1);
  });

  it('does not accept or dispatch a job whose acceptance commit fails before publication', async () => {
    const f = await fixture('accept-before-failure'); const original = await readFile(f.path);
    fault.mode = 'before'; await expect(f.service.submit(input())).rejects.toThrow('fixture.before-rename');
    expect(await readFile(f.path)).toEqual(original); expect(f.calls).toHaveLength(0);
    expect((await f.evidence('accept-before-failure')).backgroundJobs).toEqual([]);
  });

  it('keeps an uncertain acceptance unknown and never dispatches from its unconfirmed draft', async () => {
    const f = await fixture('accept-unknown');
    const authority = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable'));
    fault.mode = 'after'; await expect(f.service.submit(input())).rejects.toThrow('repository.commitUncertain');
    await expect(f.service.list()).rejects.toThrow('repository.commitUncertain'); expect(f.calls).toHaveLength(0);
    expect(() => f.repo.snapshot()).toThrow('repository.commitUncertain'); authority.mockRestore();
    const state = await f.evidence('accept-unknown'); expect(state.backgroundJobs[0]?.status).toBe('queued'); expect(state.backgroundJobs[0]?.request).toBeNull(); expect(state.backgroundJobs[0]?.receipts).toHaveLength(1);
  });

  it('never dispatches after an uncertain dispatch-intent commit; fresh authority preserves possible-send state', async () => {
    const f = await fixture('dispatch-unknown');
    const authority = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable'));
    armStatusFault('dispatching', 'after'); const job = await f.service.submit(input()); await f.idle();
    expect(f.calls).toHaveLength(0); await expect(f.service.get(job.id)).rejects.toThrow('repository.commitUncertain'); authority.mockRestore();
    const state = await f.evidence('dispatch-unknown'); expect(state.backgroundJobs[0]?.status).toBe('dispatching'); expect(state.backgroundJobs[0]?.request?.dispatchIntentAt).toBeTruthy();
  });

  it('keeps an uncertain cancellation unpublished locally while persisted intent rejects a late success', async () => {
    const f = await fixture('cancel-unknown'); const job = await f.service.submit(input()); const call = await f.arrived();
    const authority = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable'));
    armStatusFault('cancelled', 'after'); await expect(f.service.cancel(job.id)).rejects.toThrow('repository.commitUncertain');
    await expect(f.service.get(job.id)).rejects.toThrow('repository.commitUncertain'); call.respond('LATE_AFTER_UNKNOWN_CANCEL'); await f.idle(true);
    authority.mockRestore(); const state = await f.evidence('cancel-unknown'); expect(state.backgroundJobs[0]?.status).toBe('cancelled'); expect(state.backgroundJobs[0]?.result).toBeNull();
    expect(state.backgroundJobs[0]?.receipts.some((receipt) => receipt.kind === 'cancel')).toBe(true); expect(f.calls).toHaveLength(1);
  });

  it('recovers a proven queued attempt after graceful worker exit and never re-generates its completed result', async () => {
    const f = await fixture('queued-recovery');
    const foreground = await f.providers.captureBinding(config.id, config.model);
    const frontRun = (async () => { for await (const event of foreground.adapter.streamChat({ model: config.model, messages: [{ role: 'user', content: 'FOREGROUND_HOLDS_QUEUE' }] })) void event; })();
    const frontCall = await f.arrived(); const job = await f.service.submit(input()); await f.service.shutdown();
    expect((await f.reopen()).snapshot().backgroundJobs[0]).toMatchObject({ status: 'queued', attemptId: job.attemptId, request: null });
    frontCall.respond('FOREGROUND_DONE'); await frontRun;
    const fresh = await f.reopen(); let resumed: BackgroundJobService;
    const providers = new ProviderService(fresh, f.vault as unknown as SafeStorageVault, undefined, {
      prepared: async (record) => { await resumed.prepare(record); }, observed: async (record) => { await resumed.observe(record); }, beforeDispatch: (requestId) => resumed.assertDispatch(requestId),
    });
    resumed = new BackgroundJobService(fresh, providers); fixtures.push({ service: resumed, calls: f.calls }); await resumed.initialize();
    (await f.arrived(2)).respond('RECOVERED_QUEUE_RESULT'); await vi.waitFor(() => expect(resumed.active).toBe(false));
    const done = (await f.evidence('queued-recovery')).backgroundJobs[0]!; expect(done).toMatchObject({ id: job.id, attemptId: job.attemptId, status: 'succeeded', result: 'RECOVERED_QUEUE_RESULT' });
    await resumed.shutdown(); const freshAgain = await f.reopen(); const reader = new BackgroundJobService(freshAgain, providers); await reader.initialize(); await reader.shutdown();
    expect((await reader.get(job.id)).result).toBe('RECOVERED_QUEUE_RESULT'); expect(f.calls).toHaveLength(2);
  });

  it('does not let a stale execution owner publish failure or success over authoritative state', async () => {
    const f = await fixture('stale-owner'); const job = await f.service.submit(input()); const call = await f.arrived(); const newOwner = randomUUID();
    await f.repo.transaction((state) => { const current = state.backgroundJobs.find((item) => item.id === job.id)!; current.executionOwner = newOwner; });
    call.respond('STALE_OWNER_RESULT'); await f.idle();
    const state = await f.evidence('stale-owner'); const unchanged = state.backgroundJobs[0]!;
    expect(unchanged.executionOwner).toBe(newOwner); expect(unchanged.status).toBe('running'); expect(unchanged.result).toBeNull();
    expect(unchanged.receipts.some((receipt) => receipt.kind === 'terminal')).toBe(false);
  });

  it('does not report success from an uncertain result commit and recovers the committed result without regeneration', async () => {
    const f = await fixture('result-unknown'); const job = await f.service.submit(input()); const call = await f.arrived();
    const authority = vi.spyOn(EncryptedJsonStore.prototype, 'readPersisted').mockRejectedValue(new Error('fixture.authority-unreadable'));
    armStatusFault('succeeded', 'after'); call.respond(); await f.idle();
    await expect(f.service.get(job.id)).rejects.toThrow('repository.commitUncertain'); expect(f.calls).toHaveLength(1); authority.mockRestore();
    const state = await f.evidence('result-unknown'); expect(state.backgroundJobs[0]?.status).toBe('succeeded'); expect(state.backgroundJobs[0]?.result).toBe('PERSISTENT_JOB_RESULT_MARKER');
    expect((await f.service.get(job.id)).result).toBe('PERSISTENT_JOB_RESULT_MARKER'); expect(f.calls).toHaveLength(1);
  });
});
