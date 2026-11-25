import { Application, Rectangle, ShaderSystem } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Live2DModel as Live2DModelInstance } from 'pixi-live2d-display';
import { install } from '@pixi/unsafe-eval';

import { loadCubismCore } from './core-loader';
import { rankMotionGroups } from './semantic-action';
import { visiblePixelBounds } from './preview-frame';
import { expressionForMood } from '../../shared/character-reactions';
import type { CharacterMood } from '../../shared/character-reactions';

install({ ShaderSystem });

interface FacialExpression {
  doUpdateParameters(model: unknown, now: number, weight: number, entry?: unknown): void;
}

interface InternalMotionManager {
  definitions?: Record<string, unknown[]>;
  startRandomMotion(group: string, priority?: number): Promise<boolean>;
  stopAllMotions(): void;
  expressionManager?: {
    resetExpression(): void; currentExpression: unknown; defaultExpression: unknown; reserveExpressionIndex: number;
    definitions?: Array<{ Name: string }>;
    loadExpression?(index: number): Promise<FacialExpression | undefined>;
  };
}

interface InternalModel {
  settings?: { url: string };
  motionManager?: InternalMotionManager;
  getDrawableIDs?(): string[];
  getDrawableVertices?(index: number): Float32Array;
  coreModel?: { getDrawableOpacity(index: number): number; addParameterValueById?(id: string, value: number): void; setParameterValueById?(id: string, value: number): void };
  localTransform?: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  focusController?: { x: number; y: number; focus(x: number, y: number): void };
  on?(event: 'beforeModelUpdate', listener: () => void): void;
}

// pixi-live2d-display 0.4 exposes its expression loader at runtime but marks it
// protected in TypeScript. Keep that version-specific bridge in this adapter.
const modelInternals = (model: Live2DModelInstance): InternalModel => model.internalModel as unknown as InternalModel;

const validateModelUrl = (source: string): void => {
  const url = new URL(source);
  if (url.protocol !== 'deskpet:' || url.hostname !== 'managed' || !url.pathname.startsWith('/models/')) {
    throw new Error('Live2D models must load from validated managed storage.');
  }
};

/** Where the fitted model is drawn, in CSS pixels from the top of the view. */
export type ModelBox = { top: number; height: number; viewHeight: number };

export class Live2DHost {
  readonly #canvas: HTMLCanvasElement;
  #app: Application | null = null;
  #model: Live2DModelInstance | null = null;
  #generation = 0;
  #scale = 1;
  #bounds: Rectangle | null = null;
  #actions: Promise<boolean> = Promise.resolve(false);
  #refitAfterExpression = 0;
  #reactionRequest = 0;
  #speaking = false;
  #voice: (() => number | null) | null = null;
  #mouth = 0;
  #lifeMs = 0;
  // Read on every frame, so turning the system setting on stops the drift at once.
  readonly #reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  get #reducedMotion(): boolean { return this.#reducedMotionQuery?.matches === true; }
  #reaction: { name: string; expression: FacialExpression; elapsed: number; remainingMs: number | null } | null = null;
  #lastReactionAt = -Infinity;

  constructor(canvas: HTMLCanvasElement, private readonly onLayout?: (box: ModelBox) => void) {
    this.#canvas = canvas;
  }

  async load(coreUrl: string, modelUrl: string): Promise<void> {
    validateModelUrl(modelUrl);
    const generation = ++this.#generation;
    this.#release();
    await loadCubismCore(coreUrl);
    if (generation !== this.#generation) return;
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    if (generation !== this.#generation) return;
    const app = new Application({ view: this.#canvas, resizeTo: this.#canvas.parentElement ?? window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
    this.#app = app;
    try {
      // Own the update loop so it stops with this host, including cancelled loads.
      const model = await Live2DModel.from(modelUrl, { autoInteract: false, autoUpdate: false });
      if (generation !== this.#generation) {
        model.destroy({ children: true });
        return;
      }
      app.stage.addChild(model);
      this.#model = model;
      this.#bounds = this.#measureBounds(model);
      const internal = modelInternals(model);
      internal.on?.('beforeModelUpdate', () => {
        // The SDK has applied the persistent expression. Layer only the
        // temporary face before drawing, then its normal parameter restore
        // removes this layer each frame. The expression queue stays untouched.
        const reaction = this.#reaction;
        if (reaction !== null) {
          const weight = Math.max(0, Math.min(1, reaction.elapsed / 350, (reaction.remainingMs ?? 800) / 800));
          reaction.expression.doUpdateParameters(internal.coreModel, 0, weight);
        }
        this.#animateLife(internal);
        const focus = internal.focusController;
        if (focus !== undefined) this.#canvas.dataset.gaze = `${focus.x.toFixed(3)},${focus.y.toFixed(3)}`;
      });
      app.ticker.add(() => {
        this.#lifeMs += app.ticker.deltaMS;
        if (this.#reaction !== null) {
          this.#reaction.elapsed += app.ticker.deltaMS;
          if (this.#reaction.remainingMs !== null) this.#reaction.remainingMs -= app.ticker.deltaMS;
          if (this.#reaction.remainingMs !== null && this.#reaction.remainingMs <= 0) {
            this.#reaction = null;
            delete this.#canvas.dataset.reaction;
          }
        }
        model.update(app.ticker.deltaMS);
        if (this.#refitAfterExpression > 0) {
          this.#refitAfterExpression -= app.ticker.deltaMS;
          if (this.#refitAfterExpression <= 0) {
            this.#bounds = this.#measureBounds(model);
            this.fit();
          }
        }
      });
      this.fit();
    } catch (error) {
      if (generation === this.#generation) this.#release();
      throw error;
    }
  }

  #measureBounds(model: Live2DModelInstance): Rectangle {
    const internal = modelInternals(model);
    const ids = internal.getDrawableIDs?.();
    const transform = internal.localTransform;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    if (ids !== undefined && transform !== undefined && internal.getDrawableVertices !== undefined) {
      ids.forEach((_id, index) => {
        if ((internal.coreModel?.getDrawableOpacity(index) ?? 1) <= 0) return;
        const vertices = internal.getDrawableVertices?.(index) ?? [];
        for (let offset = 0; offset + 1 < vertices.length; offset += 2) {
          const x = vertices[offset] ?? 0;
          const y = vertices[offset + 1] ?? 0;
          const localX = transform.a * x + transform.c * y + transform.tx;
          const localY = transform.b * x + transform.d * y + transform.ty;
          left = Math.min(left, localX); right = Math.max(right, localX);
          top = Math.min(top, localY); bottom = Math.max(bottom, localY);
        }
      });
    }
    // Some models draw beyond their nominal canvas (for example an author mark).
    return Number.isFinite(left) && right > left && bottom > top
      ? new Rectangle(left, top, right - left, bottom - top)
      : model.getLocalBounds().clone();
  }

  fit(): void {
    if (this.#app === null || this.#model === null) return;
    this.#app.resize();
    const width = this.#app.renderer.width / this.#app.renderer.resolution;
    const height = this.#app.renderer.height / this.#app.renderer.resolution;
    const bounds = this.#bounds ?? this.#model.getLocalBounds();
    const scale = Math.min(Math.max(1, width - 24) / Math.max(1, bounds.width), Math.max(1, height - 42) / Math.max(1, bounds.height)) * this.#scale;
    this.#model.scale.set(scale);
    this.#model.position.set((width - bounds.width * scale) / 2 - bounds.x * scale, height - 12 - (bounds.height + bounds.y) * scale);
    this.onLayout?.({ top: height - 12 - bounds.height * scale, height: bounds.height * scale, viewHeight: height });
  }

  /** Export this existing WebGL scene only, without speech bubbles or desktop UI. */
  capturePreview(): string | null {
    if (this.#app === null || this.#model === null) return null;
    const renderer = this.#app.renderer;
    renderer.render(this.#app.stage);
    const source = renderer.plugins.extract.canvas();
    const context = source.getContext('2d');
    if (context === null) return null;
    const bounds = visiblePixelBounds(context.getImageData(0, 0, source.width, source.height).data, source.width, source.height);
    if (bounds === null) return null;
    const result = document.createElement('canvas');
    const ratio = Math.min(1, 560 / bounds.width, 840 / bounds.height);
    result.width = Math.max(1, Math.round(bounds.width * ratio));
    result.height = Math.max(1, Math.round(bounds.height * ratio));
    result.getContext('2d')?.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, result.width, result.height);
    return result.toDataURL('image/png');
  }

  async playSemanticAction(action: string): Promise<boolean> {
    if (this.#model === null) return false;
    const internal = modelInternals(this.#model);
    const manager = internal.motionManager;
    if (manager?.definitions === undefined) return false;
    const candidate = rankMotionGroups(action, Object.keys(manager.definitions))[0];
    if (candidate === undefined) return false;
    const model = this.#model;
    const generation = this.#generation;
    // Explicit commands restart a motion, even if the same single motion is active.
    // Serializing the starts also prevents two async reservations eating one another.
    const start = this.#actions.then(async () => {
      if (this.#model !== model || generation !== this.#generation) return false;
      manager.stopAllMotions();
      return manager.startRandomMotion(candidate.group, 3);
    });
    this.#actions = start.catch(() => false);
    return start;
  }

  async setExpression(expression: string | null): Promise<boolean> {
    if (this.#model === null) return Promise.resolve(false);
    this.#reactionRequest += 1;
    this.#reaction = null;
    delete this.#canvas.dataset.reaction;
    this.#refitAfterExpression = 1_500;
    if (expression === null) {
      const manager = modelInternals(this.#model).motionManager?.expressionManager;
      if (manager === undefined) return false;
      manager.reserveExpressionIndex = -1;
      manager.currentExpression = manager.defaultExpression;
      manager.resetExpression();
      return true;
    }
    return this.#model.expression(expression);
  }

  followPointer(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Feed the SDK's smoothed controller directly. Normalized, proportional
    // targets avoid snapping to a full head turn near the centre of the face.
    const clamp = (value: number): number => Math.max(-1, Math.min(1, value));
    (this.#model === null ? undefined : modelInternals(this.#model))?.focusController?.focus(
      clamp((x - rect.left - rect.width / 2) / (rect.width * 0.75)),
      clamp((rect.top + rect.height * 0.35 - y) / (rect.height * 0.75)),
    );
  }

  clearReaction(): void {
    this.#speaking = false;
    this.#reactionRequest += 1;
    this.#reaction = null;
    delete this.#canvas.dataset.reaction;
  }

  /** A slow drift so a model with few motions never stands frozen, plus a talking mouth. */
  #animateLife(internal: InternalModel): void {
    const core = internal.coreModel, seconds = this.#lifeMs / 1_000;
    if (!this.#reducedMotion) {
      core?.addParameterValueById?.('ParamAngleX', Math.sin(seconds * 0.61) * 2.4 + Math.sin(seconds * 0.23) * 1.2);
      core?.addParameterValueById?.('ParamAngleY', Math.sin(seconds * 0.43) * 1.6);
      core?.addParameterValueById?.('ParamAngleZ', Math.sin(seconds * 0.31) * 1.8);
      core?.addParameterValueById?.('ParamBodyAngleX', Math.sin(seconds * 0.37) * 1.4);
      core?.addParameterValueById?.('ParamBodyAngleZ', Math.sin(seconds * 0.27) * 1);
    }
    const voice = this.#voice?.() ?? null;
    if (voice !== null) {
      // Ease toward the voice so the mouth moves like speech, not a flicker.
      this.#mouth += (voice - this.#mouth) * 0.5;
      core?.setParameterValueById?.('ParamMouthOpenY', this.#mouth);
    } else if (this.#speaking) core?.setParameterValueById?.('ParamMouthOpenY', 0.2 + 0.5 * Math.abs(Math.sin(seconds * 9)) * (0.6 + 0.4 * Math.sin(seconds * 2.3)));
  }

  /** While her voice plays, its loudness opens the mouth instead of the talking loop. */
  setVoice(level: (() => number | null) | null): void { this.#voice = level; this.#mouth = 0; }

  async react(mood: CharacterMood, idle = false, speaking = false): Promise<boolean> {
    if (!idle) this.#speaking = speaking;
    const model = this.#model;
    const internal = model === null ? undefined : modelInternals(model);
    const manager = internal?.motionManager?.expressionManager;
    if (model === null || manager?.loadExpression === undefined || internal?.on === undefined) return false;
    if (idle && (this.#reaction !== null || window.performance.now() - this.#lastReactionAt < 20_000)) return false;
    const names = (manager.definitions ?? []).map((definition) => definition.Name);
    const name = expressionForMood(mood, names);
    if (name === null) return false;
    const request = ++this.#reactionRequest;
    if (this.#reaction?.name === name) {
      this.#reaction.remainingMs = speaking ? null : 6_000;
      this.#lastReactionAt = window.performance.now();
      return true;
    }
    const generation = this.#generation;
    const expression = await manager.loadExpression(names.indexOf(name));
    if (expression === undefined || model !== this.#model || generation !== this.#generation || request !== this.#reactionRequest) return false;
    this.#reaction = { name, expression, elapsed: 0, remainingMs: speaking ? null : 6_000 };
    this.#lastReactionAt = window.performance.now();
    this.#canvas.dataset.reaction = name;
    return true;
  }

  setScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0.2 || scale > 3) return;
    this.#scale = scale;
    this.fit();
  }

  setSourceUrl(source: string): void {
    validateModelUrl(source);
    const internal = this.#model === null ? undefined : modelInternals(this.#model);
    if (internal?.settings !== undefined) internal.settings.url = source;
  }

  containsPoint(x: number, y: number): boolean {
    if (this.#model === null || this.#app === null) return false;
    const rect = this.#canvas.getBoundingClientRect();
    const renderer = this.#app.renderer as Renderer;
    const width = renderer.width;
    const height = renderer.height;
    const pixelX = Math.floor((x - rect.left) * width / rect.width);
    const pixelY = Math.floor((y - rect.top) * height / rect.height);
    if (pixelX < 0 || pixelY < 0 || pixelX >= width || pixelY >= height) return false;
    // Sample the rendered alpha, including texture transparency and Cubism masks.
    // Refresh the framebuffer because WebGL may discard it after presentation.
    renderer.render(this.#app.stage);
    const resolution = renderer.resolution;
    const pixel = renderer.plugins.extract.pixels(undefined, new Rectangle(pixelX / resolution, (height - pixelY - 1) / resolution, 1 / resolution, 1 / resolution));
    return (pixel[3] ?? 0) >= 16;
  }

  async destroy(): Promise<void> {
    this.#generation += 1;
    this.#release();
  }

  #release(): void {
    this.#reactionRequest += 1;
    this.#reaction = null;
    this.#lastReactionAt = -Infinity;
    delete this.#canvas.dataset.reaction;
    delete this.#canvas.dataset.gaze;
    this.#bounds = null;
    this.#refitAfterExpression = 0;
    if (this.#model !== null) {
      this.#model.destroy({ children: true, texture: true, baseTexture: true });
      this.#model = null;
    }
    if (this.#app !== null) {
      this.#app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.#app = null;
    }
  }
}
