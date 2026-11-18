// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DomainRepository } from '../domain/repository';
import { recommendedServerIds, recommendedSkillIds } from '../../shared/desktop-extensions';
import { RecommendedExtensions } from './recommended-extensions';
import { importSkill } from './desktop-extensions';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const fixture=async()=>{
  const root=await mkdtemp(join(tmpdir(),'deskpet-recommended-'));roots.push(root);
  const repo=new DomainRepository(join(root,'profile'),{getVaultKey:async()=>Buffer.alloc(32,42)});await repo.initialize();
  return {repo,service:new RecommendedExtensions(repo,join(process.cwd(),'resources/skills'),()=>true)};
};
it('installs the four self-contained skills and exact official MCP presets without deleting existing entries',async()=>{
  const {repo,service}=await fixture();
  await repo.transaction(state=>{state.desktopExtensions.servers.push({id:crypto.randomUUID(),name:'Existing',endpoint:'https://example.com/mcp',enabled:false,revision:1});});
  await service.install({skills:[...recommendedSkillIds],servers:[...recommendedServerIds],enabled:true});
  const state=repo.snapshot().desktopExtensions;
  expect(state.skills).toHaveLength(4);expect(state.servers).toHaveLength(5);
  expect(state.skills.every(skill=>skill.enabled&&skill.text.includes('---')&&skill.text.length<32000)).toBe(true);
  expect(state.servers.find(server=>server.preset==='github')).toMatchObject({endpoint:'https://api.githubcopilot.com/mcp/readonly',enabled:true});
  expect(state.servers.find(server=>server.name==='Existing')).toMatchObject({enabled:false,revision:1});
  expect((await service.catalog()).skills.every(skill=>skill.installed)).toBe(true);
  const before=structuredClone(state);
  await service.install({skills:[...recommendedSkillIds],servers:[...recommendedServerIds],enabled:true});
  expect(repo.snapshot().desktopExtensions).toEqual(before);
});
it('validates all selected resources before committing and defaults to disabled',async()=>{
  const {repo,service}=await fixture();
  await service.install({skills:['evidence-review'],servers:['deepwiki'],enabled:false});
  expect(repo.snapshot().desktopExtensions.skills[0]?.enabled).toBe(false);
  expect(repo.snapshot().desktopExtensions.servers[0]?.enabled).toBe(false);
  const broken=new RecommendedExtensions(repo,'/missing-bundled-skills',()=>true);
  await expect(broken.install({skills:['project-review'],servers:['github'],enabled:true})).rejects.toThrow();
  expect(repo.snapshot().desktopExtensions.servers).toHaveLength(1);
});
it('adopts exact manually imported matches without duplicates or silently enabling them',async()=>{
  const {repo,service}=await fixture();
  const manual=await importSkill(join(process.cwd(),'resources/skills/bilingual-writing'));
  await repo.transaction(state=>{
    state.desktopExtensions.skills.push(manual);
    state.desktopExtensions.servers.push({id:crypto.randomUUID(),name:'My browser',endpoint:'http://127.0.0.1:8931/',enabled:false,revision:1});
  });
  await service.install({skills:['bilingual-writing'],servers:['playwright'],enabled:false});
  const state=repo.snapshot().desktopExtensions;
  expect(state.skills).toHaveLength(1);expect(state.skills[0]).toMatchObject({id:manual.id,catalogId:'bilingual-writing',enabled:false});
  expect(state.servers).toHaveLength(1);expect(state.servers[0]).toMatchObject({preset:'playwright',name:'My browser',enabled:false});
  const catalog=await service.catalog();expect(catalog.skills.find(item=>item.id==='bilingual-writing')?.installed).toBe(true);
});
