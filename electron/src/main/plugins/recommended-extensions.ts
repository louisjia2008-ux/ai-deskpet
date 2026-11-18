import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DomainRepository } from '../domain/repository';
import { importSkill } from './desktop-extensions';
import type { RecommendedExtensionsCatalog, RecommendedInstall, RecommendedServerId, RecommendedSkillId } from '../../shared/desktop-extensions';
import { recommendedInstallSchema } from '../../shared/desktop-extensions';

const skills: Record<RecommendedSkillId, {name:string;description:string}> = {
  'bilingual-writing': {name:'中英写作与文档共创',description:'保留作者意图与事实，协作撰写、翻译和润色中英文文档。'},
  'evidence-review': {name:'资料归纳与证据检查',description:'整理所给材料中的主张、证据、矛盾与待核实事项。'},
  'ib-economics': {name:'IB Economics 双语讲解与答题自检',description:'解释经济机制、图表与计算，依据所给题目提供学习性反馈。'},
  'project-review': {name:'项目复盘与发布检查',description:'整理目标、完成项、验证证据、发布状态与遗留问题。'},
};
export const recommendedServers: Record<RecommendedServerId, {name:string;description:string;endpoint:string}> = {
  deepwiki: {name:'DeepWiki',description:'查询公开 GitHub 仓库的文档、结构和代码说明。',endpoint:'https://mcp.deepwiki.com/mcp'},
  'microsoft-learn': {name:'Microsoft Learn',description:'检索和读取 Microsoft 官方技术文档与代码示例。',endpoint:'https://learn.microsoft.com/api/mcp'},
  playwright: {name:'Playwright',description:'使用 DeskPet 独立浏览器浏览和操作网页；按需启动。',endpoint:'http://127.0.0.1:8931/'},
  github: {name:'GitHub',description:'只读访问 GitHub 仓库、Issue 和拉取请求；需要认证。',endpoint:'https://api.githubcopilot.com/mcp/readonly'},
};

export class RecommendedExtensions {
  constructor(private readonly repo:DomainRepository, private readonly skillRoot:string, private readonly available:()=>boolean) {}
  async catalog():Promise<RecommendedExtensionsCatalog> {
    const installed = this.repo.snapshot().desktopExtensions;
    return {
      skills:Object.entries(skills).map(([id,entry])=>({id:id as RecommendedSkillId,...entry,installed:installed.skills.some(skill=>skill.catalogId===id)})),
      servers:Object.entries(recommendedServers).map(([id,{name,description,endpoint}])=>({id:id as RecommendedServerId,name,description,installed:installed.servers.some(server=>server.preset===id||server.endpoint===endpoint)})),
    };
  }
  async install(raw:RecommendedInstall):Promise<void> {
    if (!this.available()) throw new Error('extensions.unavailable');
    const input = recommendedInstallSchema.parse(raw), profileId = this.repo.snapshot().profileId;
    const selectedSkills = await Promise.all([...new Set(input.skills)].map(async id => ({...await importSkill(join(this.skillRoot,id)),catalogId:id,name:skills[id].name,enabled:input.enabled})));
    await this.repo.transaction(state=>{
      if (!this.available() || state.profileId!==profileId) throw new Error('extensions.changed');
      const extensions = state.desktopExtensions;
      const newSkills=selectedSkills.filter(candidate=>!extensions.skills.some(item=>item.catalogId===candidate.catalogId||item.digest===candidate.digest));
      const newServers=[...new Set(input.servers)].filter(id=>!extensions.servers.some(item=>item.preset===id||item.endpoint===recommendedServers[id].endpoint));
      if (extensions.skills.length+newSkills.length>80) throw new Error('extensions.skillCapacity');
      if (extensions.servers.length+newServers.length>32) throw new Error('extensions.capacity');
      for (const candidate of selectedSkills) {
        const existing=extensions.skills.find(item=>item.digest===candidate.digest);
        if (existing && !existing.catalogId) {existing.catalogId=candidate.catalogId;existing.revision=(existing.revision??1)+1;}
      }
      for (const id of input.servers) {
        const existing=extensions.servers.find(item=>item.endpoint===recommendedServers[id].endpoint);
        if(existing && !existing.preset) {existing.preset=id;existing.revision++;}
      }
      extensions.skills.push(...newSkills);
      for (const id of newServers) extensions.servers.push({id:randomUUID(),name:recommendedServers[id].name,endpoint:recommendedServers[id].endpoint,preset:id,enabled:input.enabled,revision:1});
      if (input.enabled) {
        for (const skill of extensions.skills) if (selectedSkills.some(candidate=>candidate.catalogId===skill.catalogId||candidate.digest===skill.digest) && !skill.enabled) {skill.enabled=true;skill.revision=(skill.revision??1)+1;}
        for (const server of extensions.servers) if (input.servers.some(id=>server.preset===id||server.endpoint===recommendedServers[id].endpoint) && !server.enabled) {server.enabled=true;server.revision++;}
      }
    });
  }
}
