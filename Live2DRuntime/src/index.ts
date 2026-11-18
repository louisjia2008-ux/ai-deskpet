import { decodeCommand, emit, commandFailureIsFatal } from './bridge';
import { PixiStage } from './pixi-stage';
import { CharacterModel } from './live2d-model';
let stage:PixiStage|undefined, character:CharacterModel|undefined;
async function dispatch(raw:unknown) {
  let id:string|undefined;
  let commandType:string|undefined;
  try {
    if(raw && typeof raw==='object' && typeof (raw as any).id==='string' && (raw as any).id.length<=128)id=(raw as any).id;
    const c=decodeCommand(raw);id=c.id;commandType=c.type;const p=c.payload;
    if(c.type==='runtime.initialize') {if(!stage){stage=new PixiStage(document.body,e=>emit('runtimeError',{message:String(e)}),p.preserveDrawingBuffer as boolean|undefined);character=new CharacterModel(stage);} }
    else {
      if(!stage||!character)throw new Error('Runtime not initialized');
      switch(c.type){
        case 'model.load':await character.load(p.source as string,p.appearanceExpressions as string[]|undefined);break;
        case 'model.unload':character.unload();break;
        case 'model.setView':character.view=p as any;character.fit();break;
        case 'model.setFocus':character.focus=p.active ? {x:p.x as number,y:p.y as number}:undefined;character.model?.internalModel.focusController.focus(p.x as number,p.y as number);break;
        case 'model.hitTest':for(const name of character.model?.hitTest(p.x as number,p.y as number)??[])emit('hitArea',{name});break;
        case 'motion.play':if(!character.model || !await character.model.motion(p.group as string,p.index as number,3))throw new Error('Motion unavailable');break;
        case 'expression.set':if(!character.expressions)throw new Error('No model');character.expressions.set(p.name as string);break;
        case 'expression.clear':character.expressions?.clear();break;
        case 'speech.setMouth':character.lip.openness=p.openness as number;break;
        case 'speech.setSpeaking':character.lip.speaking=p.speaking as boolean;break;
        case 'runtime.pause':stage.pause();break;
        case 'runtime.resume':stage.resume();break;
        case 'runtime.setFPS':stage.fps=p.fps as number;break;
        case 'runtime.queryCapabilities':emit('capabilities',character.capabilities(),id);break;
      }
    }
    emit('commandCompleted',{},id);
  }catch(error){emit('runtimeError',{message:String(error),commandType:commandType ?? 'invalid',fatal:commandFailureIsFatal(commandType)},id);}
}
(window as any).deskpetLive2D=Object.freeze({dispatch});
window.addEventListener('error',e=>emit('runtimeError',{message:e.message}));
window.addEventListener('unhandledrejection',e=>emit('runtimeError',{message:String(e.reason)}));
window.addEventListener('pagehide',()=>{character?.unload();stage?.destroy();});
document.addEventListener('pointerup',e=>{for(const name of character?.model?.hitTest(e.clientX,e.clientY)??[])emit('hitArea',{name});});
emit('runtimeReady');
