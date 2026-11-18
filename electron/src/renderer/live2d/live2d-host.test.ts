import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  apps: [] as Array<{
    stage: { addChild: ReturnType<typeof vi.fn> };
    renderer: { width: number; height: number; resolution: number; render: ReturnType<typeof vi.fn>; plugins: { extract: { pixels: ReturnType<typeof vi.fn> } } };
    ticker: { add: ReturnType<typeof vi.fn>; deltaMS: number };
    resize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
  }>,
  from: vi.fn(),
  core: vi.fn(async () => undefined),
}));
vi.mock('pixi.js', () => ({
  ShaderSystem: class {},
  Application: class {
    stage = { addChild: vi.fn() };
    renderer = { width: 420, height: 620, resolution: 1, render: vi.fn(), plugins: { extract: { pixels: vi.fn(() => new Uint8Array([0, 0, 0, 255])) } } };
    ticker = { add: vi.fn(), deltaMS: 16 };
    resize = vi.fn();
    destroy = vi.fn();
    constructor() { fixture.apps.push(this); }
  },
  Rectangle: class {
    constructor(public x: number, public y: number, public width: number, public height: number) {}
  },
}));
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: { from: fixture.from } }));
vi.mock('@pixi/unsafe-eval', () => ({ install: vi.fn() }));
vi.mock('./core-loader', () => ({ loadCubismCore: fixture.core }));

import { Live2DHost } from './live2d-host';

const source = 'deskpet://managed/models/.staging/model/avatar.model3.json';
const core = 'deskpet://managed/core/live2dcubismcore.min.js';
const modelFixture = () => {
  const scale = { x: 1, y: 1, set: vi.fn((value: number) => { scale.x = value; scale.y = value; }) };
  return {
    scale, position: { set: vi.fn() }, destroy: vi.fn(), update: vi.fn(), expression: vi.fn(async () => true),
    getLocalBounds: vi.fn(() => ({ clone: () => ({ x: 0, y: 0, width: 100, height: 200 }) })),
    internalModel: { settings: { url: source }, motionManager: { definitions: { TapBody: [{}] }, stopAllMotions: vi.fn(), startRandomMotion: vi.fn(async () => true) } },
  };
};
const canvasFixture = () => {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, width: 420, height: 620, right: 430, bottom: 640, toJSON: () => ({}) });
  return canvas;
};
beforeEach(() => { fixture.apps.length = 0; fixture.from.mockReset(); fixture.core.mockClear(); });

describe('Live2D host', () => {
  it('holds a talking face throughout a long stream and fades after finishing without resetting the base expression', async () => {
    const model = modelFixture(); const face = { doUpdateParameters: vi.fn() };
    const base = { name: 'Watermark' }; const coreModel = {};
    const manager = { currentExpression: base, definitions: [{ Name: 'love' }], loadExpression: vi.fn(async () => face) };
    let beforeUpdate = (): void => undefined;
    Object.assign(model.internalModel, { on: (_event: string, listener: () => void) => { beforeUpdate = listener; }, coreModel });
    Object.assign(model.internalModel.motionManager, { expressionManager: manager });
    model.update.mockImplementation(() => beforeUpdate()); fixture.from.mockResolvedValue(model);
    const canvas = canvasFixture(); const host = new Live2DHost(canvas); await host.load(core, source);
    await host.react('affection', false, true);
    const app = fixture.apps[0]!; const tick = app.ticker.add.mock.calls[0]?.[0] as () => void;
    app.ticker.deltaMS = 60_000; tick();
    expect(canvas.dataset.reaction).toBe('love');
    expect(face.doUpdateParameters).toHaveBeenLastCalledWith(coreModel, 0, 1);
    expect(await host.react('happy', true)).toBe(false);
    await host.react('affection');
    expect(manager.loadExpression).toHaveBeenCalledOnce();
    app.ticker.deltaMS = 5_500; tick();
    expect(face.doUpdateParameters).toHaveBeenLastCalledWith(coreModel, 0, 0.625);
    app.ticker.deltaMS = 501; tick(); expect(canvas.dataset.reaction).toBeUndefined();
    expect(manager.currentExpression).toBe(base); expect(model.expression).not.toHaveBeenCalled();
    await host.react('affection', false, true); host.clearReaction();
    expect(canvas.dataset.reaction).toBeUndefined(); await host.destroy();
  });

  it('smoothly targets CSS coordinates independently of the backing pixel resolution and clamps distant cursors', async () => {
    const model = modelFixture();
    const focus = vi.fn();
    Object.assign(model.internalModel, { focusController: { x: 0, y: 0, focus } });
    fixture.from.mockResolvedValue(model);
    const host = new Live2DHost(canvasFixture()); await host.load(core, source);
    const app = fixture.apps[0]!;
    app.renderer.resolution = 2; app.renderer.width = 840; app.renderer.height = 1240;
    host.followPointer(220, 237);
    expect(focus).toHaveBeenLastCalledWith(0, 0);
    host.followPointer(377.5, 4.5);
    expect(focus).toHaveBeenLastCalledWith(0.5, 0.5);
    host.followPointer(-10_000, 10_000);
    expect(focus).toHaveBeenLastCalledWith(-1, -1);
    host.followPointer(NaN, 1);
    expect(focus).toHaveBeenCalledTimes(3);
    await host.destroy(); host.followPointer(100, 100);
    expect(focus).toHaveBeenCalledTimes(3);
  });

  it('layers a fading face over the persistent expression without replacing or resetting it', async () => {
    const model = modelFixture();
    const face = { doUpdateParameters: vi.fn() };
    const base = { name: 'Watermark' };
    const coreModel = {};
    const manager = { currentExpression: base, definitions: [{ Name: 'Watermark' }, { Name: 'love' }], loadExpression: vi.fn(async () => face) };
    let beforeUpdate = (): void => undefined;
    Object.assign(model.internalModel, { on: (_event: string, listener: () => void) => { beforeUpdate = listener; }, coreModel });
    Object.assign(model.internalModel.motionManager, { expressionManager: manager });
    model.update.mockImplementation(() => beforeUpdate());
    fixture.from.mockResolvedValue(model);
    const canvas = canvasFixture(); const host = new Live2DHost(canvas); await host.load(core, source);
    expect(await host.react('affection')).toBe(true);
    const app = fixture.apps[0]!;
    const tick = app.ticker.add.mock.calls[0]?.[0] as () => void;
    app.ticker.deltaMS = 350; tick();
    expect(face.doUpdateParameters).toHaveBeenLastCalledWith(coreModel, 0, 1);
    expect(manager.currentExpression).toBe(base);
    expect(model.expression).not.toHaveBeenCalled();
    expect(await host.react('happy', true)).toBe(false);
    expect(canvas.dataset.reaction).toBe('love');
    app.ticker.deltaMS = 6_200; tick();
    expect(face.doUpdateParameters).toHaveBeenCalledOnce();
    expect(canvas.dataset.reaction).toBeUndefined();
    expect(manager.currentExpression).toBe(base);
    await host.destroy();
  });

  it('discards a late face load after a manual choice, a newer reaction or destruction', async () => {
    const model = modelFixture();
    const pending: Array<(value: { doUpdateParameters: ReturnType<typeof vi.fn> }) => void> = [];
    Object.assign(model.internalModel, { on: vi.fn() });
    Object.assign(model.internalModel.motionManager, { expressionManager: {
      definitions: [{ Name: 'love' }],
      loadExpression: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    } });
    fixture.from.mockResolvedValue(model);
    const canvas = canvasFixture(); const host = new Live2DHost(canvas); await host.load(core, source);
    const old = host.react('affection'); const current = host.react('affection');
    pending[1]?.({ doUpdateParameters: vi.fn() }); expect(await current).toBe(true);
    pending[0]?.({ doUpdateParameters: vi.fn() }); expect(await old).toBe(false);
    host.clearReaction();
    const manual = host.react('affection'); await host.setExpression('Watermark');
    pending[2]?.({ doUpdateParameters: vi.fn() }); expect(await manual).toBe(false);
    const obsolete = host.react('affection'); await host.destroy();
    pending[3]?.({ doUpdateParameters: vi.fn() }); expect(await obsolete).toBe(false);
    expect(canvas.dataset.reaction).toBeUndefined();
  });

  it('can restore the default expression and invalidate a pending expression selection', async () => {
    const model = modelFixture();
    const expressionManager = { currentExpression: {}, defaultExpression: {}, reserveExpressionIndex: 3, resetExpression: vi.fn() };
    Object.assign(model.internalModel.motionManager, { expressionManager });
    fixture.from.mockResolvedValue(model);
    const host = new Live2DHost(canvasFixture()); await host.load(core, source);
    expect(await host.setExpression('Watermark')).toBe(true);
    expect(model.expression).toHaveBeenCalledWith('Watermark');
    expect(await host.setExpression(null)).toBe(true);
    expect(expressionManager.currentExpression).toBe(expressionManager.defaultExpression);
    expect(expressionManager.reserveExpressionIndex).toBe(-1);
    expect(expressionManager.resetExpression).toHaveBeenCalledOnce();
    await host.destroy();
  });

  it('uses an absolute scale, preserves it on resize, and anchors the fitted model', async () => {
    const model = modelFixture(); fixture.from.mockResolvedValue(model);
    const layout = vi.fn();
    const host = new Live2DHost(canvasFixture(), layout);
    host.setScale(0.5);
    await host.load(core, source);
    const base = 578 / 200;
    expect(model.scale.x).toBeCloseTo(base * 0.5);
    const box = layout.mock.lastCall![0] as { top: number; height: number; viewHeight: number };
    expect(box.top).toBeCloseTo(608 - 289); expect(box.height).toBeCloseTo(289); expect(box.viewHeight).toBe(620);
    host.setScale(0.5); host.fit(); host.setScale(0.5);
    expect(model.scale.x).toBeCloseTo(base * 0.5);
    expect(fixture.from).toHaveBeenCalledTimes(1);
    expect(model.position.set).toHaveBeenLastCalledWith((420 - 100 * base * 0.5) / 2, 608 - 200 * base * 0.5);
    const app = fixture.apps[0]; if (app === undefined) throw new Error('No application');
    app.renderer.width = 210; app.renderer.height = 310;
    host.fit();
    expect(model.scale.x).toBeCloseTo(268 / 200 * 0.5);
    expect(fixture.from).toHaveBeenCalledWith(source, { autoInteract: false, autoUpdate: false });
    expect(app.ticker.add).toHaveBeenCalledOnce();
    await host.destroy();
  });

  it('includes visible drawable geometry beyond the model canvas when fitting', async () => {
    const model = modelFixture();
    Object.assign(model.internalModel, {
      getDrawableIDs: () => ['character', 'mark', 'hidden'],
      getDrawableVertices: (index: number) => new Float32Array(index === 0 ? [0, 0, 100, 200] : index === 1 ? [100, 200, 120, 240] : [-10000, -10000, 10000, 10000]),
      coreModel: { getDrawableOpacity: (index: number) => index === 2 ? 0 : 1 },
      localTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    });
    fixture.from.mockResolvedValue(model);
    const host = new Live2DHost(canvasFixture()); await host.load(core, source);
    expect(model.scale.x).toBeCloseTo(578 / 240);
    await host.destroy();
  });

  it('starts two identical explicit commands, including while a single motion is active', async () => {
    const model = modelFixture(); fixture.from.mockResolvedValue(model);
    const host = new Live2DHost(canvasFixture()); await host.load(core, source);
    expect(await Promise.all([host.playSemanticAction('greet'), host.playSemanticAction('greet')])).toEqual([true, true]);
    const manager = model.internalModel.motionManager;
    expect(manager.stopAllMotions).toHaveBeenCalledTimes(2);
    expect(manager.startRandomMotion.mock.calls).toEqual([['TapBody', 3], ['TapBody', 3]]);
    await host.destroy();
  });

  it('does not resurrect a cancelled load and releases the temporary application on failure', async () => {
    const model = modelFixture(); let resolveModel: ((value: typeof model) => void) | undefined;
    fixture.from.mockReturnValueOnce(new Promise((resolve) => { resolveModel = resolve; }));
    const host = new Live2DHost(canvasFixture()); const loading = host.load(core, source);
    await vi.waitFor(() => expect(fixture.from).toHaveBeenCalledOnce());
    await host.destroy(); resolveModel?.(model); await loading;
    expect(model.destroy).toHaveBeenCalledOnce();
    expect(fixture.apps[0]?.stage.addChild).not.toHaveBeenCalled();
    expect(fixture.apps[0]?.destroy).toHaveBeenCalledOnce();
    fixture.from.mockRejectedValueOnce(new Error('Invalid moc'));
    await expect(host.load(core, source)).rejects.toThrow('Invalid moc');
    expect(fixture.apps[1]?.destroy).toHaveBeenCalledOnce();
    expect(host.containsPoint(100, 100)).toBe(false);
  });

  it('samples rendered alpha at the correct high-DPI canvas coordinate', async () => {
    const model = modelFixture(); fixture.from.mockResolvedValue(model);
    const host = new Live2DHost(canvasFixture()); await host.load(core, source);
    const app = fixture.apps[0]; if (app === undefined) throw new Error('No application');
    app.renderer.width = 840; app.renderer.height = 1240; app.renderer.resolution = 2;
    app.renderer.plugins.extract.pixels.mockReturnValueOnce(new Uint8Array([0, 0, 0, 0]));
    expect(host.containsPoint(110, 220)).toBe(false);
    expect(app.renderer.plugins.extract.pixels.mock.calls[0]).toEqual([undefined, { x: 100, y: 419.5, width: 0.5, height: 0.5 }]);
    expect(host.containsPoint(110, 220)).toBe(true);
    expect(host.containsPoint(-1, 220)).toBe(false);
    expect(app.renderer.render).toHaveBeenCalledTimes(2);
    host.setSourceUrl('deskpet://managed/models/model/avatar.model3.json');
    expect(model.internalModel.settings.url).toBe('deskpet://managed/models/model/avatar.model3.json');
    expect(() => host.setSourceUrl('https://example.com/avatar.model3.json')).toThrow('validated managed');
    await host.destroy();
  });
});
