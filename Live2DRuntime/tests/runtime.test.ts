import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitModel } from '../src/fit-model';
import { decodeZipFileName } from '../src/loader/decode-zip-filename';
import { ignored,normalizePath,selectSettings,sanitizeSettings } from '../src/loader/paths';
import { blendValue,ExpressionController } from '../src/expression-controller';
import { decodeCommand,commandTypes } from '../src/bridge';
import { LipSync } from '../src/lip-sync';
import { MotionPipeline } from '../src/motion-manager';
test('contain fitting respects both axes and offsets',()=>{assert.deepEqual(fitModel(400,600,800,800),{scale:.475,x:200,y:300});assert.equal(fitModel(400,600,800,800,2,10,-20).y,280)});
test('invalid dimensions fail instead of hiding bad data',()=>{for(const n of [0,-1,NaN,Infinity])assert.throws(()=>fitModel(n,2,2,2))});
test('CJK legacy decoder does not mistake GBK for valid UTF8',()=>{assert.equal(decodeZipFileName(new Uint8Array([0xd2,0xbb])),'一');assert.equal(decodeZipFileName(new Uint8Array([65,66])),'AB')});
test('archive metadata is ignored at every depth',()=>{for(const p of ['a/__MACOSX/x','a/._x','items_pinned_to_model.json'])assert.equal(ignored(p),true);assert.equal(ignored('foo.model3.json'),false)});
test('settings detection is deterministic and rejects ambiguity',()=>{assert.equal(selectSettings(['a/items_pinned_to_model.json','a/m.model3.json']),'a/m.model3.json');assert.throws(()=>selectSettings(['a.model3.json','b.model3.json']));assert.throws(()=>selectSettings(['m.moc3']))});
test('decoded paths retain literal percent and refuse traversal',()=>{assert.equal(normalizePath('模型%20目录/a%ZZ.png'),'模型%20目录/a%ZZ.png');assert.equal(normalizePath('a%20b/x'),'a b/x');for(const p of ['../../x','%2e%2e/x','https://x','/x'])assert.throws(()=>normalizePath(p))});
test('null optional refs are removed and invalid metadata rejected',()=>{const x=sanitizeSettings({Version:3,FileReferences:{Moc:'m.moc3',Textures:['t.png'],Physics:null,Pose:null,DisplayInfo:null}});assert.equal('Physics' in x.FileReferences,false);assert.throws(()=>sanitizeSettings({Version:3}))});
test('all blend modes preserve meaning',()=>{assert.equal(blendValue(.5,.2,'Add'),.7);assert.equal(blendValue(.5,.2,'Multiply'),.1);assert.equal(blendValue(.5,.2,'Overwrite'),.2)});
test('expressions do not accumulate and clear restores actual defaults',()=>{const values:Record<string,number>={eye:.8,other:.3};const core={getParameterValueById:(id:string)=>values[id],setParameterValueById:(id:string,v:number)=>{values[id]=v}};const c=new ExpressionController(core,new Map([['smile',{Parameters:[{Id:'eye',Value:.5,Blend:'Multiply'},{Id:'other',Value:.2,Blend:'Add'}]}]]));c.set('smile');for(let i=0;i<100;i++){c.resetFrame();c.applyFrame();assert.equal(values.eye,.4);assert.equal(values.other,.5)}c.clear();c.resetFrame();c.applyFrame();assert.deepEqual(values,{eye:.8,other:.3});assert.throws(()=>c.set('missing'))});
test('reject invalid bridge payloads and arbitrary command strings',()=>{for(const c of [{version:2,id:'x',type:'runtime.pause',payload:{}},{version:1,id:'x',type:'eval',payload:{}},{version:1,id:'x',type:'speech.setMouth',payload:{openness:Infinity}},{version:1,id:'x',type:'model.load',payload:{source:'https://host/x'}},{version:1,id:'x',type:'runtime.pause',payload:{shell:'x'}}])assert.throws(()=>decodeCommand(c))});
test('every command decodes its intended schema',()=>{const payloads:Record<string,unknown>={'model.load':{source:'deskpet://models/Haru/Haru.model3.json'},'model.setView':{scale:1,x:0,y:0},'model.setFocus':{x:0,y:1,active:true},'model.hitTest':{x:0,y:10},'motion.play':{group:'Idle',index:0},'expression.set':{name:'F01'},'speech.setMouth':{openness:.5},'speech.setSpeaking':{speaking:true},'runtime.setFPS':{fps:30}};for(const type of commandTypes)assert.equal(decodeCommand({version:1,id:'x',type,payload:payloads[type]??{}}).type,type)});
test('final pipeline always executes in registered order',()=>{const pipeline=new MotionPipeline(),trace:string[]=[];for(const s of ['pre','post','final'] as const)pipeline.register(s,()=>trace.push(s));for(const s of ['pre','post','final'] as const)pipeline.run(s,.016);assert.deepEqual(trace,['pre','post','final'])});
test('mouth zero during speech is a silent phoneme, not ownership release',()=>{let mouth=.5;const core={getParameterValueById:()=>mouth,setParameterValueById:(_id:string,v:number)=>{mouth=v}};const lip=new LipSync();lip.speaking=true;lip.apply(core,.016);assert.equal(mouth,0);lip.openness=1;lip.apply(core,.016);assert.equal(mouth,1);lip.speaking=false;for(let i=0;i<20;i++)lip.apply(core,.016);assert.equal(mouth,0)});

import { resolveBlobResource } from '../src/loader/paths';
test('custom-origin blob URLs remain opaque and remote references fail',()=>{const url='blob:deskpet://runtime/123';assert.equal(resolveBlobResource(url),url);assert.throws(()=>resolveBlobResource('https://example.test/a'));});

import { discoverUnlistedReferences } from '../src/loader/paths';
test('VTS exports discover real unlisted expressions and motions only under model root',()=>{const refs:any={};discoverUnlistedReferences(refs,['m/Cry.exp3.json','m/Scene1.motion3.json','other/Bad.exp3.json'],'m/');assert.deepEqual(refs.Expressions,[{Name:'Cry',File:'Cry.exp3.json'}]);assert.deepEqual(refs.Motions,{Imported:[{File:'Scene1.motion3.json'}]});});
test('discovery preserves explicit model mappings',()=>{const refs:any={Expressions:[{Name:'Smile',File:'F01.exp3.json'}],Motions:{Idle:[]}};discoverUnlistedReferences(refs,['m/Cry.exp3.json','m/Scene1.motion3.json'],'m/');assert.equal(refs.Expressions[0].Name,'Smile');assert.deepEqual(refs.Motions,{Idle:[]});});

import { fitModelBounds } from '../src/fit-model';
test('visible meshes outside nominal model canvas remain inside viewport',()=>{const f=fitModelBounds(400,600,400,600,{left:0,top:0,right:400,bottom:700});const bottom=f.y+(700-300)*f.scale;assert.ok(bottom<600);assert.ok(f.y-300*f.scale>0);});

import { commandFailureIsFatal } from '../src/bridge';
test('optional motion failure preserves model availability while load failure is fatal',()=>{
  assert.equal(commandFailureIsFatal('motion.play'),false);
  assert.equal(commandFailureIsFatal('expression.set'),false);
  assert.equal(commandFailureIsFatal('model.load'),true);
  assert.equal(commandFailureIsFatal('runtime.initialize'),true);
});

test('persistent model appearance survives transient expression clear and never accumulates',()=>{
  const values:Record<string,number>={watermark:0,mood:0};
  const core={getParameterValueById:(id:string)=>values[id],setParameterValueById:(id:string,v:number)=>{values[id]=v}};
  const definitions=new Map([
    ['Watermark',{Parameters:[{Id:'watermark',Value:1,Blend:'Add'}]}],
    ['Happy',{Parameters:[{Id:'mood',Value:.7,Blend:'Overwrite'}]}]
  ]);
  const controller=new ExpressionController(core,definitions,['Watermark']);
  for(let i=0;i<1000;i++){
    if(i%2)controller.set('Happy');else controller.clear();
    controller.resetFrame();controller.applyFrame();
    assert.equal(values.watermark,1);assert.equal(values.mood,i%2?.7:0);
  }
  controller.reset();assert.equal(values.watermark,0);
  const other=new ExpressionController(core,definitions);other.resetFrame();other.applyFrame();assert.equal(values.watermark,0);
  assert.throws(()=>new ExpressionController(core,definitions,['Absent']));
});
test('model appearance bridge accepts bounded names and rejects malformed settings',()=>{
  const command=(appearanceExpressions:unknown)=>({version:1,id:'appearance',type:'model.load',payload:{source:'deskpet://models/model.zip',appearanceExpressions}});
  assert.doesNotThrow(()=>decodeCommand(command(['Watermark'])));
  for(const bad of [null,1,'Watermark',[''],['Watermark','Watermark'],[{}],['x'.repeat(513)],Array.from({length:17},(_,i)=>String(i))])assert.throws(()=>decodeCommand(command(bad)));
});
