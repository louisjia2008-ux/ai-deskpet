// AIRI animation.ts / eye-motions.ts @ 00c6867, MIT. Local math, seconds only.
import type { Core } from './expression-controller';
const weights=[.075,.110,.125,.140,.125,.050,.040,.030,.020,1];
export function randomSaccadeInterval(random=Math.random) {let n=random(),sum=0;for(let i=0;i<weights.length;i++){sum+=weights[i];if(n<=sum)return .8+i*.4+random()*.4;}return 4.8;}
export class IdleEye {
  private next=0; private x=0; private y=0;
  update(core:Core,dt:number,focus?:{x:number;y:number}) {
    this.next-=dt;
    if(this.next<=0){this.next=randomSaccadeInterval();this.x=Math.random()*2-1;this.y=Math.random()*1.7-1;}
    const a=1-Math.exp(-10*dt), target=focus??{x:this.x,y:this.y};
    for(const [id,value] of [['ParamEyeBallX',target.x],['ParamEyeBallY',target.y]] as const) core.setParameterValueById(id,core.getParameterValueById(id)+(value-core.getParameterValueById(id))*a);
  }
}
export class Blink {
  private remaining=3+Math.random()*5; private elapsed=0;
  apply(core:Core,dt:number) {
    this.remaining-=dt;if(this.remaining>0)return;
    this.elapsed+=dt;
    const factor=this.elapsed<.075 ? (1-this.elapsed/.075)**2 : Math.min(1,((this.elapsed-.075)/.225)**2);
    for(const id of ['ParamEyeLOpen','ParamEyeROpen'])core.setParameterValueById(id,core.getParameterValueById(id)*factor);
    if(this.elapsed>=.3){this.elapsed=0;this.remaining=3+Math.random()*5;}
  }
}
