// Release/handoff algorithm adapted from AIRI motion-manager.ts @ 00c6867; MIT.
import type { Core } from './expression-controller';
export class LipSync {
  speaking=false; openness=0; private release=0; private hold=0; private last=0;
  apply(core:Core,dt:number) {
    if(this.speaking){this.last=this.openness;this.release=.2;this.hold=.5;core.setParameterValueById('ParamMouthOpenY',this.openness);}
    else if(this.release>0){this.release=Math.max(0,this.release-dt);const t=1-this.release/.2;core.setParameterValueById('ParamMouthOpenY',this.last*(1-t*t*(3-2*t)));}
    else if(this.hold>0){this.hold-=dt;core.setParameterValueById('ParamMouthOpenY',0);}
  }
}
