export const commandTypes = ['runtime.initialize','model.load','model.unload','model.setView','model.setFocus','model.hitTest','motion.play','expression.set','expression.clear','speech.setMouth','speech.setSpeaking','runtime.pause','runtime.resume','runtime.setFPS','runtime.queryCapabilities'] as const;
export type CommandType = typeof commandTypes[number];
export interface Command { version: 1; id: string; type: CommandType; payload: Record<string, unknown> }
const object = (x: unknown): x is Record<string,unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export function decodeCommand(raw: unknown): Command {
  if (!object(raw) || raw.version !== 1 || typeof raw.id !== 'string' || raw.id.length > 128 || !raw.id || !commandTypes.includes(raw.type as CommandType) || !object(raw.payload)) throw new Error('Invalid v1 command envelope');
  const p = raw.payload, t = raw.type;
  const number = (k: string, min: number, max: number) => typeof p[k] === 'number' && Number.isFinite(p[k]) && (p[k] as number) >= min && (p[k] as number) <= max;
  const string = (k: string) => typeof p[k] === 'string' && (p[k] as string).length > 0 && (p[k] as string).length <= 512;
  let valid = true;
  let keys: string[] = [];
  switch(t) {
    case 'runtime.initialize': keys=['preserveDrawingBuffer']; valid=p.preserveDrawingBuffer===undefined || typeof p.preserveDrawingBuffer==='boolean'; break;
    case 'model.load': keys=['source','appearanceExpressions']; valid=string('source') && /^deskpet:\/\/models\//.test(p.source as string) && (p.appearanceExpressions===undefined || (Array.isArray(p.appearanceExpressions) && p.appearanceExpressions.length<=16 && new Set(p.appearanceExpressions).size===p.appearanceExpressions.length && p.appearanceExpressions.every(x=>typeof x==='string' && x.length>0 && x.length<=512))); break;
    case 'model.setView': keys=['scale','x','y']; valid=number('scale',0.05,10)&&number('x',-10000,10000)&&number('y',-10000,10000); break;
    case 'model.setFocus': keys=['x','y','active']; valid=number('x',-1,1)&&number('y',-1,1)&&typeof p.active==='boolean'; break;
    case 'model.hitTest': keys=['x','y']; valid=number('x',0,10000)&&number('y',0,10000); break;
    case 'motion.play': keys=['group','index']; valid=string('group')&&number('index',0,10000)&&Number.isInteger(p.index); break;
    case 'expression.set': keys=['name']; valid=string('name'); break;
    case 'speech.setMouth': keys=['openness']; valid=number('openness',0,1); break;
    case 'speech.setSpeaking': keys=['speaking']; valid=typeof p.speaking==='boolean'; break;
    case 'runtime.setFPS': keys=['fps']; valid=number('fps',1,60); break;
  }
  if (!valid || Object.keys(p).some(k => !keys.includes(k))) throw new Error('Invalid payload for '+t);
  return raw as unknown as Command;
}
export function emit(type: string, payload: Record<string,unknown> = {}, id?: string) {
  const message = {version:1,type,payload,...(id ? {id} : {})};
  const host = (window as any).webkit?.messageHandlers?.live2d;
  if (host) host.postMessage(message);
}

// A rejected optional action must not invalidate an already visible model.
export function commandFailureIsFatal(type: string | undefined): boolean {
  return type === 'model.load' || type === 'runtime.initialize';
}
