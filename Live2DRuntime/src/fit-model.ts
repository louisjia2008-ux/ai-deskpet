// Algorithm adapted from AIRI fit-model.ts @ 00c6867; see ThirdParty/AIRI_LICENSE.txt.
export function fitModel(w: number, h: number, mw: number, mh: number, scale = 1, x = 0, y = 0) {
  if (![w,h,mw,mh,scale,x,y].every(Number.isFinite) || Math.min(w,h,mw,mh,scale) <= 0)
    throw new Error('Invalid model or viewport geometry');
  // AIRI uses 2x for a portrait crop; DeskPet uses full-body contain with a 5% margin.
  return { scale: Math.min(w / mw, h / mh) * scale * 0.95, x: w / 2 + x, y: h / 2 + y };
}

export function fitModelBounds(w:number,h:number,mw:number,mh:number,bounds:{left:number;top:number;right:number;bottom:number},scale=1,x=0,y=0) {
  const left=Math.min(0,bounds.left),top=Math.min(0,bounds.top),right=Math.max(mw,bounds.right),bottom=Math.max(mh,bounds.bottom);
  const fit=fitModel(w,h,right-left,bottom-top,scale,x,y);
  return {...fit,x:fit.x-((left+right)/2-mw/2)*fit.scale,y:fit.y-((top+bottom)/2-mh/2)*fit.scale};
}
