// Staged composition derived from AIRI motion-manager.ts @ 00c6867; MIT.
export type Stage = 'pre'|'post'|'final';
export class MotionPipeline {
  private plugins: Record<Stage,Array<(dt:number)=>void>>={pre:[],post:[],final:[]};
  register(stage:Stage,plugin:(dt:number)=>void) {this.plugins[stage].push(plugin);}
  run(stage:Stage,dt:number) {for(const p of this.plugins[stage])p(dt);}
}
