import { TextureCache, BaseTextureCache } from '@pixi/utils';
// Model.vue surgical lifecycle adaptation from AIRI @ 00c6867; MIT.
import { Live2DFactory, Live2DModel, Cubism4ModelSettings } from 'pixi-live2d-display/cubism4';
import type { PixiStage } from './pixi-stage';
import { loadSource, activeObjectURLCount, type ModelSource } from './loader/live2d-zip-loader';
import { resolveBlobResource } from './loader/paths';
import { fitModelBounds } from './fit-model';
import { ExpressionController } from './expression-controller';
import { MotionPipeline } from './motion-manager';
import { Blink, IdleEye } from './idle-eye';
import { LipSync } from './lip-sync';
import { emit } from './bridge';
export class CharacterModel {
  private animation:Record<string,number>={};
  model?:Live2DModel; private source?:ModelSource; expressions?:ExpressionController;
  lip=new LipSync(); focus?:{x:number;y:number}; view={scale:1,x:0,y:0}; private generation=0; private bounds={left:0,top:0,right:0,bottom:0};
  constructor(private stage:PixiStage) {stage.resized=()=>this.fit();stage.update=dt=>this.model?.update(dt*1000);}
  async load(url:string,appearanceExpressions:string[] = []) {
    this.unload();const token=this.generation;emit('modelLoading');const start=performance.now();
    let source:ModelSource|undefined;let model:Live2DModel|undefined;
    try {
      source=await loadSource(url);model=new Live2DModel({autoUpdate:false,autoInteract:false});
      const settings=new Cubism4ModelSettings(source.settings);
      // Legacy Node-style URL resolution corrupts blob:deskpet:// opaque resource URLs.
      settings.resolveURL=resolveBlobResource;
      await Live2DFactory.setupLive2DModel(model,settings,{autoUpdate:false,autoInteract:false});
      if(token!==this.generation){model.destroy({texture:true,baseTexture:true});source.dispose();return;}
      const im=model.internalModel as any, core=im.coreModel;
      this.expressions=new ExpressionController(core,source.expressions,appearanceExpressions);
      // Own expressions/blink here, preserving SDK breath, physics, pose and model motions.
      im.eyeBlink=undefined;
      const pipeline=new MotionPipeline(), idle=new IdleEye(),blink=new Blink();
      pipeline.register('pre',()=>this.expressions?.resetFrame());
      pipeline.register('post',dt=>idle.update(core,dt,this.focus));
      pipeline.register('final',()=>this.expressions?.applyFrame());
      pipeline.register('final',dt=>blink.apply(core,dt));
      pipeline.register('final',dt=>this.lip.apply(core,dt));
      pipeline.register('final',()=>{this.animation={eyeOpen:core.getParameterValueById('ParamEyeLOpen'),mouthOpen:core.getParameterValueById('ParamMouthOpenY'),eyeX:core.getParameterValueById('ParamEyeBallX'),eyeY:core.getParameterValueById('ParamEyeBallY')};});
      let delta=0;
      const update=im.update.bind(im);im.update=(dt:number,now:number)=>{delta=Math.min(dt/1000,.1);update(dt,now);};
      // Previous frame ends with loadParameters; beforeModelUpdate occurs before core.update.
      im.on('beforeMotionUpdate',()=>pipeline.run('pre',delta));
      im.on('beforeModelUpdate',()=>{pipeline.run('post',delta);pipeline.run('final',delta);});
      im.motionManager.on('motionStart',(group:string,index:number)=>emit('motionStarted',{group,index}));
      im.motionManager.on('motionFinish',()=>emit('motionFinished'));
      // Some VTS meshes (including author watermarks) extend outside the nominal canvas.
      // Include visible drawable bounds once at load, preserving those pixels without hiding layers.
      this.bounds={left:0,top:0,right:im.width,bottom:im.height};
      for(let i=0;i<core.getDrawableCount();i++) {
        if(core.getDrawableOpacity(i)<=0)continue;
        const vertices=im.getDrawableVertices(i), t=im.localTransform;
        for(let j=0;j<vertices.length;j+=2){const x=vertices[j]*t.a+vertices[j+1]*t.c+t.tx,y=vertices[j]*t.b+vertices[j+1]*t.d+t.ty;
          this.bounds.left=Math.min(this.bounds.left,x);this.bounds.right=Math.max(this.bounds.right,x);this.bounds.top=Math.min(this.bounds.top,y);this.bounds.bottom=Math.max(this.bounds.bottom,y);}
      }
      this.source=source;this.model=model;model.anchor.set(.5,.5);this.stage.app.stage.addChild(model);this.fit();
      emit('modelLoaded',{loadMs:performance.now()-start,...this.capabilities()});
    } catch(e){if(model?.internalModel)model.destroy({texture:true,baseTexture:true});source?.dispose();emit('modelLoadFailed',{message:String(e),resource:(e as any)?.url ?? ''});throw e;}
  }
  fit(){if(!this.model)return;const im=this.model.internalModel;const v=fitModelBounds(this.stage.app.screen.width,this.stage.app.screen.height,im.width,im.height,this.bounds,this.view.scale,this.view.x,this.view.y);this.model.scale.set(v.scale);this.model.position.set(v.x,v.y);}
  capabilities(){const core=(this.model?.internalModel as any)?.coreModel;
    const ids:string[]=core?._parameterIds ?? [];
    return {diagnostics:{loadedModelCount:this.model?1:0,stageChildCount:this.stage.app.stage.children.length,
      activeObjectURLs:activeObjectURLCount(),textureCacheCount:Object.keys(TextureCache).length,baseTextureCacheCount:Object.keys(BaseTextureCache).length,
      rafCount:this.stage.activeRAFCount,preserveDrawingBuffer:this.stage.preserveDrawingBuffer,
      modelListenerCount:this.model?.eventNames().reduce((n,e)=>n+this.model!.listenerCount(e),0)??0,
      motionListenerCount:this.model?.internalModel.motionManager.eventNames().reduce((n,e)=>n+this.model!.internalModel.motionManager.listenerCount(e),0)??0},hitAreas:(this.source?.settings.HitAreas ?? []).map((area:any)=>area.Name),
      supportsStandardMouth:ids.includes('ParamMouthOpenY'),
      supportsStandardEyeTracking:ids.includes('ParamEyeBallX') && ids.includes('ParamEyeBallY'),animation:this.animation,activeExpression:this.expressions?.selectedName() ?? null,motions:this.model?Object.entries(this.model.internalModel.motionManager.definitions).flatMap(([group,v])=>(v??[]).map((_,index)=>({group,index}))):[],expressions:this.expressions?.list()??[],fps:this.stage.measuredFPS,paused:this.stage.paused,renderScale:1};}
  unload(){this.generation++;this.expressions?.reset();this.expressions=undefined;if(this.model){this.stage.app.stage.removeChild(this.model);this.model.destroy({texture:true,baseTexture:true});}this.model=undefined;this.source?.dispose();this.source=undefined;this.lip=new LipSync();}
}
