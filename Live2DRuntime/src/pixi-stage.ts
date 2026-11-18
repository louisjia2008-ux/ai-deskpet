// AIRI Canvas.vue lifecycle adaptation @ 00c6867; MIT.
import { Application } from '@pixi/app';
export class PixiStage {
  readonly app:Application; private observer:ResizeObserver; private timer?:number;
  private last=0; private frames=0; private epoch=performance.now(); measuredFPS:number|null=null; fps=30; paused=false;
  update:(dt:number)=>void=()=>{}; resized:()=>void=()=>{};
  get activeRAFCount(){return this.timer===undefined?0:1;}
  constructor(parent:HTMLElement,private error:(e:unknown)=>void,readonly preserveDrawingBuffer=true) {
    this.app=new Application({width:parent.clientWidth,height:parent.clientHeight,backgroundAlpha:0,resolution:1,autoDensity:true,antialias:true,preserveDrawingBuffer:this.preserveDrawingBuffer});
    parent.appendChild(this.app.view);this.app.view.style.width='100%';this.app.view.style.height='100%';
    this.observer=new ResizeObserver(()=>{this.app.renderer.resize(parent.clientWidth,parent.clientHeight);this.resized();});this.observer.observe(parent);
    this.resume();
  }
  private tick=()=>{
    const now=performance.now();
    if(now-this.last>=1000/this.fps-1){const dt=this.last?Math.min((now-this.last)/1000,.1):0;this.last=now;
      try{this.update(dt);this.app.render();this.frames++;if(now-this.epoch>=1000){this.measuredFPS=this.frames*1000/(now-this.epoch);this.frames=0;this.epoch=now;}}
      catch(e){this.pause();this.error(e);return;}}
    this.timer=requestAnimationFrame(this.tick);
  };
  pause(){this.paused=true;if(this.timer!==undefined)cancelAnimationFrame(this.timer);this.timer=undefined;}
  resume(){if(this.timer!==undefined)return;this.paused=false;this.last=0;this.timer=requestAnimationFrame(this.tick);}
  destroy(){this.pause();this.observer.disconnect();this.app.destroy(true,{children:true,texture:true,baseTexture:true});}
}
