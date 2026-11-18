// AIRI expression-controller.ts / expression-store.ts adaptation @ 00c6867; MIT.
export type Blend = 'Add'|'Multiply'|'Overwrite';
export interface Parameter { Id:string; Value:number; Blend:Blend }
export interface Core { getParameterValueById(id:string):number; setParameterValueById(id:string,value:number):void }
export const blendValue = (base:number,value:number,blend:Blend) => blend==='Add' ? base+value : blend==='Multiply' ? base*value : value;
export class ExpressionController {
  private definitions = new Map<string,Parameter[]>();
  private defaults = new Map<string,number>();
  private active?: string;
  constructor(private core:Core, expressions:Map<string,unknown>, private appearance:string[] = []) {
    for(const [name,raw] of expressions) {
      const data=raw as any;
      if(!Array.isArray(data?.Parameters))throw new Error('Invalid expression: '+name);
      const params:Parameter[]=data.Parameters.map((p:any)=>{
        if(typeof p.Id!=='string'||typeof p.Value!=='number'||!Number.isFinite(p.Value)||!['Add','Multiply','Overwrite'].includes(p.Blend??'Add'))throw new Error('Invalid expression parameter');
        this.defaults.set(p.Id,core.getParameterValueById(p.Id));
        return {...p,Blend:p.Blend??'Add'};
      });
      this.definitions.set(name,params);
    }
    for(const name of appearance)if(!this.definitions.has(name))throw new Error('Unknown appearance expression: '+name);
  }
  list() {return [...this.definitions.keys()];}
  selectedName() {return this.active;}
  set(name:string) {if(!this.definitions.has(name))throw new Error('Unknown expression');this.active=name;}
  clear() {this.active=undefined;}
  // Run after SDK loadParameters, before motion updates. Resets expression-only parameters
  // before motion owns them this frame; prevents accumulation and stale values on clear/swap.
  resetFrame() {for(const [id,value] of this.defaults)this.core.setParameterValueById(id,value);}
  applyFrame() {
    // Persist model appearance independently of transient emotion expressions.
    // Rebase additive values every frame, so reload/clear/1000 frames cannot accumulate.
    for(const name of [this.active??'',...this.appearance])for(const p of this.definitions.get(name)??[]) {
      const base=p.Blend==='Add' ? this.defaults.get(p.Id)! : this.core.getParameterValueById(p.Id);
      this.core.setParameterValueById(p.Id,blendValue(base,p.Value,p.Blend));
    }
  }
  reset() {this.clear();this.resetFrame();}
}
