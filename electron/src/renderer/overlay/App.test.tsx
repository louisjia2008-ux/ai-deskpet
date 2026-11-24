import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterReaction, CharacterState, CompanionPointer, DeskPetApi } from '../../shared';

const fixture = vi.hoisted(() => ({
  hosts: [] as Array<{ load: ReturnType<typeof vi.fn>; setScale: ReturnType<typeof vi.fn>; setSourceUrl: ReturnType<typeof vi.fn>; playSemanticAction: ReturnType<typeof vi.fn>; setExpression: ReturnType<typeof vi.fn>; fit: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; containsPoint: ReturnType<typeof vi.fn>; followPointer: ReturnType<typeof vi.fn>; react: ReturnType<typeof vi.fn>; clearReaction: ReturnType<typeof vi.fn>; capturePreview: ReturnType<typeof vi.fn> }>,
  load: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock('../live2d', () => ({ Live2DHost: class {
  load = fixture.load;
  setScale = vi.fn(); setSourceUrl = vi.fn(); fit = vi.fn(); destroy = vi.fn(async () => undefined);
  playSemanticAction = vi.fn(async () => true); setExpression = vi.fn(async () => true); containsPoint = vi.fn(() => false);
  followPointer = vi.fn(); react = vi.fn(async () => true); clearReaction = vi.fn(); setVoice = vi.fn(); capturePreview = vi.fn(() => 'data:image/png;base64,model-only');
  constructor() { fixture.hosts.push(this); }
} }));
import { OverlayApp } from './App';

const character: CharacterState = {
  coreState: 'ready', modelState: 'ready', coreUrl: 'deskpet://managed/core/live2dcubismcore.min.js',
  modelUrl: 'deskpet://managed/models/model/avatar.model3.json', pendingImportId: null, modelName: 'Real model',
  scale: 1, position: null, expression: null, expressions: [], action: null, actionRevision: 0, bubble: null,
};
let emit: (state: CharacterState) => void;
let pointer: (point: CompanionPointer) => void;
let reaction: (value: CharacterReaction) => void;
const install = (initial = character) => {
  const api = {
    app: { getState: vi.fn(async () => ({ resolvedLocale: 'en' })), onChanged: () => () => undefined, showConsole: vi.fn() },
    character: {
      getState: vi.fn(async () => initial),
      onChanged: (listener: typeof emit) => { emit = listener; return () => undefined; },
      onPointer: (listener: typeof pointer) => { pointer = listener; return vi.fn(); },
      onReaction: (listener: typeof reaction) => { reaction = listener; return vi.fn(); },
      onVoice: () => vi.fn(),
      acknowledgeModelLoaded: vi.fn(async () => character), setInteractive: vi.fn(async () => undefined),
      modelLoadFailed: vi.fn(async () => { emit(character); return character; }),
      setPosition: vi.fn(async () => character), dismissBubble: vi.fn(async () => character),
    },
  };
  Object.defineProperty(window, 'deskpet', { value: api as unknown as DeskPetApi, configurable: true });
  return api;
};
beforeEach(() => {
  fixture.hosts.length = 0; fixture.load.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); });
  vi.stubGlobal('PointerEvent', class extends window.MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: ConstructorParameters<typeof window.MouseEvent>[1] & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => null), configurable: true });
  Object.defineProperties(window, { screenX: { value: 0, configurable: true }, screenY: { value: 0, configurable: true } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ready = async () => waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-load-state', 'ready'));

const capture = (element: HTMLElement) => {
  const ids = new Set<number>();
  const methods = {
    setPointerCapture: vi.fn((id: number) => { ids.add(id); }),
    hasPointerCapture: vi.fn((id: number) => ids.has(id)),
    releasePointerCapture: vi.fn((id: number) => { ids.delete(id); }),
  };
  Object.assign(element, methods);
  return methods;
};

describe('Live2D overlay lifecycle', () => {
  it('exports only the loaded model and removes the fixed preview listener on unmount', async () => {
    install(); const view = render(<OverlayApp />); await ready();
    const request = new window.CustomEvent('deskpet:model-preview', { detail: { frame: null as string | null } });
    window.dispatchEvent(request);
    expect(request.detail.frame).toBe('data:image/png;base64,model-only');
    expect(fixture.hosts[0]?.capturePreview).toHaveBeenCalledOnce();
    view.unmount();
    const late = new window.CustomEvent('deskpet:model-preview', { detail: { frame: null as string | null } });
    window.dispatchEvent(late); expect(late.detail.frame).toBeNull();
  });

  it('keeps the latest reaction during loading, applies it after the persistent face, and clears on cancellation', async () => {
    let finish: (() => void) | undefined;
    fixture.load.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    install({ ...character, expression: 'Watermark' }); render(<OverlayApp />);
    await waitFor(() => expect(fixture.load).toHaveBeenCalledOnce());
    await act(async () => {
      reaction({ id: 'reply:1', mood: 'sad', phase: 'speaking' });
      reaction({ id: 'reply:2', mood: 'affection', phase: 'speaking' });
    });
    expect(fixture.hosts[0]?.react).not.toHaveBeenCalled();
    await act(async () => { finish?.(); }); await ready();
    expect(fixture.hosts[0]?.setExpression).toHaveBeenCalledWith('Watermark');
    expect(fixture.hosts[0]?.react).toHaveBeenCalledExactlyOnceWith('affection', false, true);
    await act(async () => { reaction({ id: 'reply:3', mood: 'affection', phase: 'clear' }); });
    expect(fixture.hosts[0]?.clearReaction).toHaveBeenCalledOnce();
  });

  it('reports failed staging loads and reloads the restored model on a fresh canvas', async () => {
    fixture.load.mockRejectedValueOnce(new Error('invalid moc'));
    const api = install({ ...character, modelState: 'loading', pendingImportId: 'failed', modelUrl: 'deskpet://managed/models/.staging/failed/avatar.model3.json' });
    render(<OverlayApp />); await ready();
    expect(api.character.modelLoadFailed).toHaveBeenCalledWith('failed');
    expect(api.character.acknowledgeModelLoaded).not.toHaveBeenCalled();
    expect(fixture.hosts).toHaveLength(2);
    expect(fixture.hosts[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('bounds a stalled load and never acknowledges it if it resolves after timeout', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    fixture.load.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const api = install({ ...character, modelState: 'loading', pendingImportId: 'stalled', modelUrl: 'deskpet://managed/models/.staging/stalled/avatar.model3.json' });
    render(<OverlayApp />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(api.character.modelLoadFailed).toHaveBeenCalledWith('stalled');
    await act(async () => { finish?.(); });
    expect(api.character.acknowledgeModelLoaded).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('follows a cursor outside the window without enabling native interaction and deduplicates chat reactions', async () => {
    const api = install(); render(<OverlayApp />); await ready();
    await act(async () => {
      pointer({ x: -500, y: 200 });
      reaction({ id: 'reply-1', mood: 'affection' }); reaction({ id: 'reply-1', mood: 'affection' });
      emit({ ...character, scale: 0.8 });
    });
    expect(fixture.hosts[0]?.followPointer).toHaveBeenLastCalledWith(-500, 200);
    expect(api.character.setInteractive).not.toHaveBeenCalled();
    expect(fixture.hosts[0]?.react.mock.calls).toEqual([['affection', false, false]]);
    expect(fixture.hosts).toHaveLength(1);
  });

  it('captures a drag, coalesces native moves, and keeps interaction until release', async () => {
    const api = install(); render(<OverlayApp />); await ready();
    const handle = screen.getByRole('button', { name: 'Drag companion (arrow keys to move)' });
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(handle, { button: 0, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(screen.getByRole('main'), { screenX: 150, screenY: 130 });
    fireEvent.mouseLeave(screen.getByRole('main'));
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(screen.getByRole('main'), { screenX: 155, screenY: 135 });
    await waitFor(() => expect(api.character.setPosition).toHaveBeenLastCalledWith({ displayId: 'current', x: 55, y: 35 }));
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
    expect(handle.releasePointerCapture).toHaveBeenCalledOnce();
  });

  it('drags opaque model pixels from the current window position and coalesces the final native move', async () => {
    const api = install({ ...character, position: { displayId: 'display-2', x: 300, y: 400 } });
    let finishMove: ((value: CharacterState) => void) | undefined;
    api.character.setPosition.mockImplementationOnce(() => new Promise<CharacterState>((resolve) => { finishMove = resolve; }));
    Object.defineProperties(window, { screenX: { value: 300, configurable: true }, screenY: { value: 400, configurable: true } });
    render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model');
    const captured = capture(canvas);
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(canvas, { pointerId: 7, button: 0, screenX: 360, screenY: 520, clientX: 60, clientY: 120 });
    expect(captured.setPointerCapture).toHaveBeenCalledWith(7);
    expect(screen.getByRole('main')).toHaveClass('is-dragging');
    fireEvent.pointerMove(canvas, { pointerId: 8, screenX: 900, screenY: 900 });
    fireEvent.pointerUp(canvas, { pointerId: 8, screenX: 900, screenY: 900 });
    expect(api.character.setPosition).not.toHaveBeenCalled();
    fireEvent.pointerMove(canvas, { pointerId: 7, screenX: 380, screenY: 540 });
    fireEvent.pointerMove(canvas, { pointerId: 7, screenX: 390, screenY: 550 });
    await act(async () => { pointer({ x: -200, y: -200 }); });
    fireEvent.mouseLeave(screen.getByRole('main'));
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(canvas, { pointerId: 7, screenX: 400, screenY: 560 });
    expect(captured.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(screen.getByRole('main')).not.toHaveClass('is-dragging');
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
    expect(api.character.setPosition).toHaveBeenCalledExactlyOnceWith({ displayId: 'display-2', x: 320, y: 420 });
    await act(async () => { finishMove?.(character); });
    expect(api.character.setPosition.mock.calls).toEqual([
      [{ displayId: 'display-2', x: 320, y: 420 }],
      [{ displayId: 'display-2', x: 340, y: 440 }],
    ]);
  });

  it('keeps transparent pixels and non-primary buttons from starting a model drag', async () => {
    const api = install(); render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model');
    const captured = capture(canvas);
    fireEvent.pointerDown(canvas, { pointerId: 2, button: 0, clientX: 5, clientY: 5 });
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(canvas, { pointerId: 3, button: 2, clientX: 100, clientY: 200 });
    fireEvent.pointerMove(canvas, { pointerId: 2, screenX: 200, screenY: 300 });
    fireEvent.pointerUp(canvas, { pointerId: 2, screenX: 200, screenY: 300 });
    expect(captured.setPointerCapture).not.toHaveBeenCalled();
    expect(api.character.setPosition).not.toHaveBeenCalled();
    expect(api.character.setInteractive).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'lostpointercapture'])('releases a body drag after %s and accepts the next drag', async (type) => {
    const api = install(); render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model');
    const captured = capture(canvas);
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(canvas, { pointerId: 4, button: 0, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 4, screenX: 120, screenY: 130 });
    fireEvent(canvas, new window.PointerEvent(type, { pointerId: 4, bubbles: true, screenX: 900, screenY: 900 }));
    fireEvent.pointerMove(canvas, { pointerId: 4, screenX: 500, screenY: 500 });
    expect(api.character.setPosition).toHaveBeenCalledExactlyOnceWith({ displayId: 'current', x: 20, y: 30 });
    expect(captured.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(4);
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('main')).not.toHaveClass('is-dragging');
    fireEvent.pointerDown(canvas, { pointerId: 5, button: 0, screenX: 100, screenY: 100 });
    expect(captured.setPointerCapture).toHaveBeenLastCalledWith(5);
    fireEvent.pointerUp(canvas, { pointerId: 5, screenX: 105, screenY: 110 });
    await waitFor(() => expect(api.character.setPosition).toHaveBeenLastCalledWith({ displayId: 'current', x: 5, y: 10 }));
  });

  it('releases pointer capture and native interaction when the overlay unmounts during a drag', async () => {
    const api = install(); const view = render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model');
    const captured = capture(canvas);
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(canvas, { pointerId: 6, button: 0 });
    view.unmount();
    expect(captured.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(6);
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
    expect(api.character.setPosition).not.toHaveBeenCalled();
  });

  it('ends an old canvas drag when a different model is selected', async () => {
    const api = install(); render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model');
    const captured = capture(canvas);
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(canvas, { pointerId: 9, button: 0 });
    await act(async () => { emit({ ...character, modelUrl: 'deskpet://managed/models/other/avatar.model3.json', modelName: 'Other' }); });
    await ready();
    expect(captured.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(9);
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('main')).not.toHaveClass('is-dragging');
    fireEvent.pointerMove(screen.getByLabelText('Other'), { pointerId: 9, screenX: 500, screenY: 500 });
    expect(api.character.setPosition).not.toHaveBeenCalled();
  });

  it('does not let speech dismissal interrupt an active model drag', async () => {
    const api = install({ ...character, bubble: 'Hello', bubbleRevision: 4 }); render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model'); capture(canvas);
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(canvas, { pointerId: 12, button: 0, screenX: 100, screenY: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Close speech bubble' }));
    expect(api.character.dismissBubble).toHaveBeenCalledWith(4);
    expect(api.character.setInteractive.mock.calls).toEqual([[true]]);
    fireEvent.pointerUp(canvas, { pointerId: 12, screenX: 120, screenY: 130 });
    await waitFor(() => expect(api.character.setPosition).toHaveBeenLastCalledWith({ displayId: 'current', x: 20, y: 30 }));
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it('arms a stationary cursor over the model after loading and restores transparent click-through', async () => {
    let finish: (() => void) | undefined;
    fixture.load.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const api = install(); render(<OverlayApp />);
    await waitFor(() => expect(fixture.load).toHaveBeenCalledOnce());
    fixture.hosts[0]?.containsPoint.mockImplementation((x) => x === 100);
    await act(async () => { pointer({ x: 100, y: 200 }); });
    expect(api.character.setInteractive).not.toHaveBeenCalled();
    await act(async () => { finish?.(); }); await ready();
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(true);
    await act(async () => { pointer({ x: 5, y: 5 }); });
    expect(api.character.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it('leaves speech controls clickable and arrow key movement available', async () => {
    const api = install({ ...character, bubble: 'Hello', bubbleRevision: 3 }); render(<OverlayApp />); await ready();
    const close = screen.getByRole('button', { name: 'Close speech bubble' });
    fixture.hosts[0]?.containsPoint.mockReturnValue(true);
    fireEvent.pointerDown(close, { pointerId: 10, button: 0 });
    fireEvent.pointerMove(close, { pointerId: 10, screenX: 200, screenY: 300 });
    expect(api.character.setPosition).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(api.character.dismissBubble).toHaveBeenCalledWith(3);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag companion (arrow keys to move)' }), { key: 'ArrowRight' });
    await waitFor(() => expect(api.character.setPosition).toHaveBeenLastCalledWith({ displayId: 'current', x: 10, y: 0 }));
  });

  it('leaves the setup card clickable while no model is available', async () => {
    const api = install({ ...character, coreState: 'missing', coreUrl: null, modelState: 'missing', modelUrl: null }); render(<OverlayApp />);
    const setup = await screen.findByRole('button', { name: /no look yet/i });
    fireEvent.pointerDown(setup, { pointerId: 11, button: 0 });
    fireEvent.pointerMove(setup, { pointerId: 11, screenX: 200, screenY: 300 });
    fireEvent.click(setup);
    expect(api.app.showConsole).toHaveBeenCalledOnce();
    expect(api.character.setPosition).not.toHaveBeenCalled();
  });

  it('changes scale without a reload and handles same-name actions even in a React batch', async () => {
    install(); render(<OverlayApp />); await ready();
    await act(async () => {
      emit({ ...character, action: 'greet', actionRevision: 1 });
      emit({ ...character, action: 'greet', actionRevision: 2, scale: 0.7 });
    });
    expect(fixture.hosts).toHaveLength(1);
    expect(fixture.load).toHaveBeenCalledOnce();
    expect(fixture.hosts[0]?.setScale).toHaveBeenLastCalledWith(0.7);
    expect(fixture.hosts[0]?.playSemanticAction.mock.calls).toEqual([['greet'], ['greet']]);
    expect(screen.getByRole('main')).toHaveAttribute('data-actions-played', '2');
    await act(async () => { emit({ ...character, action: 'greet', actionRevision: 2, scale: 0.8 }); });
    expect(fixture.hosts[0]?.playSemanticAction).toHaveBeenCalledTimes(2);
    expect(fixture.load).toHaveBeenCalledOnce();
  });

  it('keeps one loaded model at commit and rebases lazy assets to the active location', async () => {
    const api = install({ ...character, modelState: 'loading', pendingImportId: 'model', modelUrl: 'deskpet://managed/models/.staging/model/avatar.model3.json' });
    api.character.acknowledgeModelLoaded.mockImplementation(async () => { emit(character); return character; });
    render(<OverlayApp />); await ready();
    expect(api.character.acknowledgeModelLoaded).toHaveBeenCalledWith('model');
    expect(fixture.hosts).toHaveLength(1);
    expect(fixture.hosts[0]?.setSourceUrl).toHaveBeenCalledWith(character.modelUrl);
  });

  it('replaces the canvas when switching models so a destroyed WebGL context is never reused', async () => {
    install(); render(<OverlayApp />); await ready();
    const firstCanvas = screen.getByLabelText('Real model');
    await act(async () => { emit({ ...character, modelUrl: 'deskpet://managed/models/kitty/kitty.model3.json', modelName: 'Kitty' }); });
    await ready();
    expect(screen.getByLabelText('Kitty')).not.toBe(firstCanvas);
    expect(fixture.hosts[0]?.destroy).toHaveBeenCalledOnce();
    expect(fixture.hosts).toHaveLength(2);
  });

  it('queues actions and uses the latest scale while a model is loading', async () => {
    let finish: (() => void) | undefined;
    fixture.load.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    install(); render(<OverlayApp />);
    await waitFor(() => expect(fixture.load).toHaveBeenCalledOnce());
    await act(async () => {
      emit({ ...character, action: 'greet', actionRevision: 1, scale: 0.6 });
      emit({ ...character, action: 'greet', actionRevision: 2, scale: 0.5 });
    });
    expect(fixture.hosts[0]?.playSemanticAction).not.toHaveBeenCalled();
    await act(async () => { finish?.(); }); await ready();
    expect(fixture.hosts[0]?.playSemanticAction).toHaveBeenCalledTimes(2);
    expect(fixture.hosts[0]?.setScale).toHaveBeenLastCalledWith(0.5);
  });

  it('never acknowledges or changes UI after an obsolete load completes or fails', async () => {
    let finish: (() => void) | undefined;
    fixture.load.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const api = install({ ...character, modelState: 'loading', pendingImportId: 'model' });
    const rendered = render(<OverlayApp />);
    await waitFor(() => expect(fixture.load).toHaveBeenCalledOnce());
    rendered.unmount(); await act(async () => { finish?.(); });
    expect(api.character.acknowledgeModelLoaded).not.toHaveBeenCalled();
    expect(fixture.hosts[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('switches native interaction only for opaque model pixels or actual controls', async () => {
    const api = install(); render(<OverlayApp />); await ready();
    const canvas = screen.getByLabelText('Real model');
    fixture.hosts[0]?.containsPoint.mockReturnValueOnce(true).mockReturnValue(false);
    Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => canvas), configurable: true });
    fireEvent.mouseMove(canvas, { clientX: 100, clientY: 200 });
    fireEvent.mouseMove(canvas, { clientX: 5, clientY: 5 });
    expect(api.character.setInteractive.mock.calls).toEqual([[true], [false]]);
  });
});
