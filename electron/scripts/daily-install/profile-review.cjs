/* global process, Buffer */
'use strict';
// Serialized into the new daily package's maintenance branch. Plaintext stays
// inside that process. Only counts, booleans, hashes and schedule metadata leave.
module.exports=function reviewStoppedCopy({profile,installedAsar,expectedSHA}) {
  const {app,safeStorage}=require('electron');
  const fs=process.getBuiltinModule('module').createRequire(process.execPath)('original-fs');
  const path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const check=(value,code)=>{if(!value)throw Error(code);};
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const valueHash=value=>hash(JSON.stringify(canonical(value))??'__absent__');
  const read=name=>{const file=path.join(profile,name),info=fs.lstatSync(file);check(info.isFile()&&!info.isSymbolicLink()&&fs.realpathSync(file)===file,'unsafe-copy-file');return fs.readFileSync(file);};
  const exists=name=>fs.existsSync(path.join(profile,name));
  const decode=(name,vault)=>{
    const bytes=read(name),envelope=JSON.parse(bytes.toString('utf8'));
    check(envelope.version===1&&envelope.algorithm==='aes-256-gcm','unsupported-envelope');
    const key=Buffer.from(safeStorage.decryptString(read(path.join(vault,'vault-key.safe'))),'base64');let plaintext;
    try {check(key.length===32,'invalid-key');const decipher=crypto.createDecipheriv(envelope.algorithm,key,Buffer.from(envelope.nonce,'base64'));decipher.setAuthTag(Buffer.from(envelope.authenticationTag,'base64'));plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);return {state:JSON.parse(plaintext.toString('utf8')),sha256:hash(bytes)};}
    finally{key.fill(0);plaintext?.fill(0);}
  };
  check(app.isPackaged&&app.getName()==='DeskPet Electron'&&app.getAppPath()===installedAsar&&hash(fs.readFileSync(installedAsar))===expectedSHA,'wrong-maintenance-identity');
  const decoded=decode('profile.enc.json','vault'),state=decoded.state;
  check(state.version===1&&typeof state.profileId==='string'&&Array.isArray(state.chatSessions)&&Array.isArray(state.chatMessages)&&Array.isArray(state.memories),'invalid-domain');
  const arrays=(value,name)=>{check(value===undefined||Array.isArray(value),'invalid-'+name);return value??[];};
  const research=arrays(state.researchTasks,'research'),schedules=arrays(state.chatCronSchedules,'cron').filter(row=>row.enabled&&!row.cancelledAt);
  const countStatus=(items,status)=>items.filter(row=>row.status===status).length;
  const researchStates=['queued','running','completed','failed','interrupted','cancelled','partial'];
  check(research.every(row=>researchStates.includes(row.status)),'invalid-research-status');
  const workCounts={researchQueued:countStatus(research,'queued'),researchRunning:countStatus(research,'running'),
    researchResumable:research.filter(row=>['failed','interrupted','cancelled','partial'].includes(row.status)).length,
    streamingMessages:state.chatMessages.filter(row=>row.status==='streaming').length,
    runningChatTasks:arrays(state.chatWorkTasks,'chat-work').filter(row=>row.status==='running').length,
    unconfirmedProactivePublications:arrays(state.automationTriggers,'automatic-triggers').filter(row=>row.kind==='proactive'&&row.status==='succeeded'&&row.messageId!==null&&row.publishedAt==null).length,
     activeFocus:state.focus?.status==='running'?1:0,
     activeBackgroundJobs:arrays(state.backgroundJobs,'background-jobs').filter(row=>['queued','dispatching','running'].includes(row.status)).length};
  let qq=null,telegram=null;const channelChecks={qqQueue:0,qqReminders:0,qqCare:false,qqActive:false,qqPaused:false,qqInboundQueued:0,qqInboundRunning:0,qqInboundPaused:0,
    telegramStatePresent:exists('telegram-channel-state.enc.json'),qqCronCount:schedules.filter(row=>row.channel||state.chatSessions.some(session=>session.id===row.sessionId&&session.channelBindingId)).length,
    telegramCronDeliveries:schedules.filter(row=>row.telegramDelivery).length};
  if(exists('qq-channel-state.enc.json')){
    const found=decode('qq-channel-state.enc.json','qq-channel-vault'),q=found.state;
    check(q.version===2&&Array.isArray(q.outbox)&&Array.isArray(q.confirmations??[])&&q.config&&typeof q.config.enabled==='boolean'&&typeof q.stopped==='boolean','invalid-qq-state');
    const inbound=arrays(q.inboundQueue,'qq-inbound');check(inbound.every(row=>['queued','running','paused','completed','cancelled','interrupted'].includes(row.status)),'invalid-qq-inbound');
    Object.assign(channelChecks,{qqQueue:q.outbox.filter(row=>['pending','sending'].includes(row.status)).length,qqReminders:q.outbox.filter(row=>row.reminderDueAt&&row.status==='pending').length,
      qqCare:!!q.binding?.privateCareGrant,qqActive:q.config.enabled,qqPaused:q.stopped,
      qqInboundQueued:countStatus(inbound,'queued'),qqInboundRunning:countStatus(inbound,'running'),qqInboundPaused:countStatus(inbound,'paused')});
    qq={stateSHA256:found.sha256,wrappedKeySHA256:hash(read('qq-channel-vault/vault-key.safe')),profileMatches:q.profileId===state.profileId,
      bindingSessionMatches:!!q.binding&&state.chatSessions.some(session=>session.id===q.binding.sessionId&&session.channelBindingId===q.binding.id&&!session.deletedAt&&!session.archivedAt),
      privateCareEnabled:channelChecks.qqCare,privateCareAuthorityMatches:!q.binding?.privateCareGrant||q.binding.privateCareGrant.authorityId===q.authorityId,
      remindersEnabled:!!q.binding?.remindersAuthorityId,remindersAuthorityMatches:!q.binding?.remindersAuthorityId||q.binding.remindersAuthorityId===q.authorityId,
      bindingSHA256:valueHash(q.binding),configSHA256:valueHash(q.config),pendingOutbox:channelChecks.qqQueue,pendingReminders:channelChecks.qqReminders,
      pendingConfirmations:(q.confirmations??[]).length,pairingPending:!!q.pairingCandidate||!!q.groupCandidate||!!q.groupPairing||q.config.pairingCode!==null||q.config.pairingExpiresAt!==null,
      inboundQueued:channelChecks.qqInboundQueued,inboundRunning:channelChecks.qqInboundRunning,inboundPaused:channelChecks.qqInboundPaused,
      inboundTotal:inbound.length,domainHashes:Object.fromEntries(Object.keys(q).sort().map(field=>[field,valueHash(q[field])]))};
    check(found.sha256===hash(read('qq-channel-state.enc.json')),'qq-copy-changed');
  }
  if(channelChecks.telegramStatePresent){
    const found=decode('telegram-channel-state.enc.json','telegram-channel-vault'),t=found.state;
    const expected=['version','tokenConfigured','profileId','enabled','providerId','model','memoryAllowed','botId','binding','pairing','candidate','offset','lastUpdateAt','inbox','outbox','approvals','diagnostics'].sort();
    const token=Object.hasOwn(t,'tokenConfigured')?t.tokenConfigured:false;
    const required=expected.filter(key=>key!=='tokenConfigured');
    const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
    check(t.version===1&&typeof t.enabled==='boolean'&&typeof token==='boolean'&&typeof t.memoryAllowed==='boolean'
      &&required.every(key=>Object.hasOwn(t,key))&&Object.keys(t).every(key=>expected.includes(key))&&['inbox','outbox','approvals','diagnostics'].every(key=>Array.isArray(t[key])),'invalid-telegram-state');
    const dormantShape=t.enabled===false&&token===false&&t.binding===null&&t.pairing===null&&t.candidate===null&&t.inbox.length===0&&t.outbox.length===0&&t.approvals.length===0
      &&(t.profileId===null||t.profileId===state.profileId)&&(t.providerId===null||uuid(t.providerId))&&(t.model===null||typeof t.model==='string')
      &&(t.botId===null||typeof t.botId==='string'&&t.botId.length>0)&&(t.offset===null||Number.isSafeInteger(t.offset)&&t.offset>=0)&&(t.lastUpdateAt===null||Number.isFinite(t.lastUpdateAt))
      &&t.diagnostics.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).sort().join(',')==='at,field,outcome,type'&&typeof row.at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(row.at)&&Number.isFinite(Date.parse(row.at))&&typeof row.type==='string'&&['accepted','rejected'].includes(row.outcome)&&(row.field===null||typeof row.field==='string'));
    telegram={version:1,schemaValidated:dormantShape,validationScope:'dormant-state-shape',enabled:t.enabled,tokenConfigured:token,profileMatches:t.profileId===state.profileId||t.profileId===null,
      hasBinding:t.binding!==null,pairingPending:t.pairing!==null||t.candidate!==null,inbox:t.inbox.length,outstandingOutbox:t.outbox.filter(row=>!['sent','discarded'].includes(row.status)).length,
      approvals:t.approvals.length,stateSHA256:found.sha256,wrappedKeySHA256:hash(read('telegram-channel-vault/vault-key.safe')),
      domainHashes:Object.fromEntries(Object.keys(t).sort().map(field=>[field,valueHash(t[field])]))};
    check(found.sha256===hash(read('telegram-channel-state.enc.json')),'telegram-copy-changed');
  }
  const nightlyPresent=Object.hasOwn(state,'nightlyMemory'),nightlyMemoryEnabled=nightlyPresent?state.nightlyMemory?.settings?.enabled:false;
  check(typeof nightlyMemoryEnabled==='boolean','invalid-nightly-state');
  const policy=state.proactivePolicy,grants=arrays(state.persistentPermissionGrants,'grants');
  check(policy&&typeof policy.enabled==='boolean','invalid-proactive-policy');
   const blocked=[];
   let diaryEnabled=false;
   if(exists('diary.enc.json')) {
     const diary=decode('diary.enc.json','qq-channel-vault').state;
     check(diary&&diary.preferences&&typeof diary.preferences.diaryEnabled==='boolean'&&Array.isArray(diary.entries),'invalid-diary-state');
     diaryEnabled=diary.preferences.diaryEnabled;
     // A new independent nightly writer needs its own reviewed policy, not an
     // implicit exemption under the old memory-sleep approval.
     if(diaryEnabled)blocked.push('diaryEnabledNeedsSeparateReview');
   }
  for(const [key,value] of Object.entries(workCounts))if(key!=='researchResumable'&&value!==0)blocked.push(key);
  for(const key of ['qqQueue','qqReminders','qqInboundQueued','qqInboundRunning','qqInboundPaused','qqCronCount','telegramCronDeliveries'])if(channelChecks[key]!==0)blocked.push(key);
  if(qq?.pendingConfirmations||qq?.pairingPending)blocked.push('qqPendingAuthority');
  if(telegram&&!telegram.schemaValidated)blocked.push('telegramNeedsReview');
  if(nightlyMemoryEnabled)blocked.push('nightlyMemoryEnabled');
  const now=Date.now();
  const result={operation:'read-only-enabled-cron-review',readOnly:true,status:blocked.length?'review-required':'passed',blocked,
    appASARSHA256:expectedSHA,profilePath:profile,profileSHA256:decoded.sha256,checkedAt:new Date(now).toISOString(),enabledCount:schedules.length,
     providerSecretValuesRead:false,instructionTextExported:false,privateTextExported:false,nightlyMemoryEnabled,nightlyFieldPresent:nightlyPresent,diaryEnabled,
    channelChecks,workCounts,researchStateCounts:Object.fromEntries(researchStates.map(status=>[status,countStatus(research,status)])),
    schedules:schedules.map(schedule=>({id:schedule.id,sessionId:schedule.sessionId,providerId:schedule.providerId,model:schedule.model,enabled:schedule.enabled,revision:schedule.revision,
      expression:schedule.expression,timezone:schedule.timezone,missedPolicy:schedule.missedPolicy,allowedCapabilities:schedule.allowedCapabilities,nextRunAt:schedule.nextRunAt,cancelledAt:schedule.cancelledAt,
      scheduleSHA256:valueHash(schedule),dueNow:schedule.nextRunAt!==null&&Date.parse(schedule.nextRunAt)<=now,
      sessionActive:state.chatSessions.some(session=>session.id===schedule.sessionId&&!session.archivedAt&&!session.deletedAt),providerEnabled:state.providers.some(provider=>provider.id===schedule.providerId&&provider.enabled),
      pendingRuns:arrays(state.chatCronRuns,'cron-runs').filter(run=>run.scheduleId===schedule.id&&['reserved','running'].includes(run.status)).length})),
    persistentGrants:grants.map(grant=>({capabilityId:grant.capabilityId,scope:grant.scope,expiresAt:grant.expiresAt})),
    domainHashes:Object.fromEntries(Object.keys(state).sort().map(field=>[field,valueHash(state[field])])),
    retained:{focusStatus:state.focus?.status??null,unconfirmedProactivePublications:workCounts.unconfirmedProactivePublications,policySHA256:valueHash(policy),grantsSHA256:valueHash(grants),
      eventProactiveEnabled:policy.enabled,mode:policy.mode??(policy.enabled?'auto':'off'),timezone:policy.timezone,policyRevision:policy.revision,
      hasPersistentAutomationGrant:grants.some(grant=>grant.capabilityId==='automation.text'&&grant.scope==='always'&&grant.expiresAt===null),qq,telegram},
    sourceUnchanged:decoded.sha256===hash(read('profile.enc.json'))};
  check(result.sourceUnchanged,'profile-copy-changed');return result;
};
