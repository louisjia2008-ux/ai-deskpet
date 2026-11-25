import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent, PointerEvent } from 'react';

import type { CharacterReaction, CharacterState, CompanionPointer } from '../../shared';
import { messages } from '../../shared';
import { Live2DHost } from '../live2d';
import type { ModelBox } from '../live2d';
import { SpeechBubble } from './SpeechBubble';
import { VoicePlayer } from './voice-player';

const MOVE_KEYS: Record<string, readonly [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };

const TAP_DISTANCE = 5;
const IDLE_MOODS = ['happy', 'shy', 'curious'] as const;

export const OverlayApp = (): JSX.Element => {
  const [hops, setHops] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<Live2DHost | null>(null);
  const voice = useRef<VoicePlayer | null>(null);
  const interactive = useRef(false);
  const latestState = useRef<CharacterState | null>(null);
  const loaded = useRef(false);
  const actionRevision = useRef(0);
  const actions = useRef<string[]>([]);
  const pointer = useRef<CompanionPointer | null>(null);
  const reactionId = useRef<string | null>(null);
  const pendingReaction = useRef<CharacterReaction | null>(null);
  const drag = useRef<{ pointerId: number; element: HTMLElement; startX: number; startY: number; windowX: number; windowY: number } | null>(null);
  const pendingPosition = useRef<{ x: number; y: number } | null>(null);
  const moving = useRef(false);
  const [state, setState] = useState<CharacterState | null>(null);
  const [modelBox, setModelBox] = useState<ModelBox | null>(null);
  const [locale, setLocale] = useState<'en' | 'zh-CN'>('en');
  const [loadError, setLoadError] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [playedActions, setPlayedActions] = useState(0);
  const [dragging, setDragging] = useState(false);
  const coreUrl = state?.coreUrl ?? null;
  // Committing a staged import changes its URL, but keeps the same model.
  const modelKey = state?.modelUrl?.replace('/models/.staging/', '/models/') ?? null;
  const scale = state?.scale ?? 1;

  const setInteractive = useCallback((next: boolean): void => {
    if (interactive.current === next) return;
    interactive.current = next;
    void window.deskpet.character.setInteractive(next);
  }, []);
  const finishDrag = useCallback((): void => {
    const current = drag.current;
    if (current === null) return;
    // Clear ownership before release, which can synchronously fire lostcapture.
    drag.current = null;
    setDragging(false);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    setInteractive(false);
  }, [setInteractive]);
  const updateInteraction = useCallback((x: number, y: number): void => {
    if (drag.current !== null) { setInteractive(true); return; }
    const element = document.elementFromPoint(x, y);
    const control = element !== null && element.closest('.drag-handle, .setup-card, .speech-bubble') !== null;
    const character = latestState.current;
    const modelVisible = loaded.current && character?.coreState === 'ready' && (character.modelState === 'ready' || character.modelState === 'loading');
    setInteractive(control || (modelVisible && (host.current?.containsPoint(x, y) ?? false)));
  }, [setInteractive]);

  useEffect(() => finishDrag, [finishDrag, coreUrl, modelKey]);

  const drainReaction = useCallback((): void => {
    if (!loaded.current || host.current === null || pendingReaction.current === null) return;
    const reaction = pendingReaction.current;
    pendingReaction.current = null;
    if (reaction.phase === 'clear') host.current.clearReaction();
    else void host.current.react(reaction.mood, false, reaction.phase === 'speaking').catch(() => false);
  }, []);

  const drainActions = useCallback((): void => {
    if (!loaded.current || host.current === null) return;
    const target = host.current;
    for (const action of actions.current.splice(0)) {
      void target.playSemanticAction(action).then((played) => {
        if (played && host.current === target) setPlayedActions((count) => count + 1);
      }).catch(() => false);
    }
  }, []);
  const receiveState = useCallback((next: CharacterState): void => {
    if (next.actionRevision > actionRevision.current) {
      actionRevision.current = next.actionRevision;
      if (next.action !== null) actions.current.push(next.action);
    }
    latestState.current = next;
    setState(next);
    drainActions();
  }, [drainActions]);

  useEffect(() => {
    const capture = (event: globalThis.Event): void => {
      const request = event as globalThis.CustomEvent<{ frame: string | null }>;
      if (request.detail) request.detail.frame = loaded.current ? host.current?.capturePreview() ?? null : null;
    };
    window.addEventListener('deskpet:model-preview', capture);
    return () => window.removeEventListener('deskpet:model-preview', capture);
  }, []);

  useEffect(() => {
    void Promise.all([window.deskpet.character.getState(), window.deskpet.app.getState()]).then(([character, app]) => {
      receiveState(character);
      setLocale(app.resolvedLocale);
    });
    const stopCharacter = window.deskpet.character.onChanged(receiveState);
    const stopApp = window.deskpet.app.onChanged((app) => setLocale(app.resolvedLocale));
    const stopPointer = window.deskpet.character.onPointer((point) => {
      pointer.current = point;
      host.current?.followPointer(point.x, point.y);
      // This also arms a model already under a stationary cursor after loading.
      updateInteraction(point.x, point.y);
    });
    const stopReaction = window.deskpet.character.onReaction((reaction) => {
      if (reactionId.current === reaction.id) return;
      reactionId.current = reaction.id;
      pendingReaction.current = reaction;
      drainReaction();
    });
    const idle = window.setInterval(() => {
      // Unprompted moods are decoration; reduced motion keeps her still until something real happens.
      if (!loaded.current || document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true || Math.random() < 0.5) return;
      const mood = IDLE_MOODS[Math.floor(Math.random() * IDLE_MOODS.length)]!;
      void host.current?.react(mood, true).catch(() => false);
    }, 45_000);
    const player = new VoicePlayer();
    voice.current = player;
    const stopVoice = window.deskpet.character.onVoice((chunk) => player.receive(chunk));
    return () => { stopCharacter(); stopApp(); stopPointer(); stopReaction(); stopVoice(); player.dispose(); voice.current = null; window.clearInterval(idle); };
  }, [receiveState, drainReaction, updateInteraction]);

  useEffect(() => {
    const character = latestState.current;
    if (canvas.current === null || coreUrl === null || character?.modelUrl === null || character?.modelUrl === undefined) return;
    let cancelled = false;
    let settled = false;
    const live2d = new Live2DHost(canvas.current, setModelBox);
    host.current = live2d;
    live2d.setVoice(() => voice.current?.mouth() ?? null);
    loaded.current = false;
    setModelLoaded(false);
    setPlayedActions(0);
    setLoadError(false);
    live2d.setScale(character.scale);
    const fail = async (): Promise<void> => {
      if (cancelled || settled) return;
      settled = true;
      setLoadError(true);
      if (character.pendingImportId !== null) {
        try { await window.deskpet.character.modelLoadFailed(character.pendingImportId); }
        catch { /* Keep the error card and console cancel control available. */ }
      }
    };
    const deadline = window.setTimeout(() => void fail(), 30_000);
    void live2d.load(coreUrl, character.modelUrl).then(async () => {
      if (cancelled || settled) return;
      window.clearTimeout(deadline);
      if (character.pendingImportId !== null) {
        const committed = await window.deskpet.character.acknowledgeModelLoaded(character.pendingImportId);
        if (cancelled) return;
        if (committed.modelUrl !== null) live2d.setSourceUrl(committed.modelUrl);
      }
      live2d.setScale(latestState.current?.scale ?? 1);
      const expression = latestState.current?.expression;
      if (expression !== undefined) await live2d.setExpression(expression).catch(() => false);
      if (cancelled || settled) return;
      settled = true;
      loaded.current = true;
      setModelLoaded(true);
      const point = pointer.current;
      if (point !== null) { live2d.followPointer(point.x, point.y); updateInteraction(point.x, point.y); }
      drainActions();
      drainReaction();
    }).catch(() => { window.clearTimeout(deadline); void fail(); });
    const resize = new ResizeObserver(() => live2d.fit());
    resize.observe(canvas.current.parentElement ?? canvas.current);
    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
      loaded.current = false;
      resize.disconnect();
      void live2d.destroy();
      if (host.current === live2d) host.current = null;
    };
  }, [coreUrl, modelKey, drainActions, drainReaction, updateInteraction]);

  useEffect(() => {
    host.current?.setScale(scale);
  }, [scale]);
  useEffect(() => {
    if (loaded.current && state?.expression !== undefined) void host.current?.setExpression(state.expression).catch(() => false);
  }, [state?.expression]);

  const releaseBubble = useCallback(() => { if (drag.current === null) setInteractive(false); }, [setInteractive]);
  const moveWindow = (x: number, y: number): void => {
    pendingPosition.current = { x, y };
    if (moving.current) return;
    moving.current = true;
    void (async () => {
      try {
        while (pendingPosition.current !== null) {
          const position = pendingPosition.current;
          pendingPosition.current = null;
          await window.deskpet.character.setPosition({ ...position, displayId: latestState.current?.position?.displayId ?? 'current' });
        }
      } catch (error) {
        window.console.error('Could not move the companion.', error);
      } finally {
        moving.current = false;
      }
    })();
  };
  const beginDrag = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || drag.current !== null) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, element: event.currentTarget, startX: event.screenX, startY: event.screenY, windowX: window.screenX, windowY: window.screenY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setInteractive(true);
  };
  const beginModelDrag = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (!ready || !loaded.current || !(host.current?.containsPoint(event.clientX, event.clientY) ?? false)) return;
    beginDrag(event);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    moveWindow(current.windowX + event.screenX - current.startX, current.windowY + event.screenY - current.startY);
  };
  const endDrag = (event: PointerEvent<HTMLElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup') moveWindow(current.windowX + event.screenX - current.startX, current.windowY + event.screenY - current.startY);
    const distance = Math.abs(event.screenX - current.startX) + Math.abs(event.screenY - current.startY);
    if (event.type === 'pointerup' && current.element.tagName === 'CANVAS') {
      if (distance < TAP_DISTANCE) {
        // With reduced motion the tap still reaches her; only the hop is skipped.
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true) setHops((count) => count + 1);
        void window.deskpet.character.tap().catch(() => undefined);
      } else void host.current?.react('surprised').catch(() => false);
    }
    finishDrag();
  };
  const mouse = (event: MouseEvent<HTMLElement>): void => {
    host.current?.followPointer(event.clientX, event.clientY);
    if (drag.current !== null) { setInteractive(true); return; }
    // Electron forwards mousemove while the native window ignores mouse input.
    if (event.type === 'mouseleave') {
      setInteractive(false);
      return;
    }
    updateInteraction(event.clientX, event.clientY);
  };
  const t = (key: keyof typeof messages.en): string => messages[locale][key];
  const ready = state?.coreState === 'ready' && (state.modelState === 'ready' || state.modelState === 'loading');

  return (
    <main className={dragging ? 'overlay-root is-dragging' : 'overlay-root'} data-load-state={loadError ? 'failed' : modelLoaded ? 'ready' : 'loading'} data-actions-played={playedActions} onMouseMove={mouse} onMouseLeave={mouse} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <button type="button" className="drag-handle" aria-label={t('companion.drag')} onPointerDown={beginDrag} onKeyDown={(event) => {
        const delta = MOVE_KEYS[event.key];
        if (delta !== undefined) { event.preventDefault(); moveWindow(window.screenX + delta[0], window.screenY + delta[1]); }
      }}><i /></button>
      {state?.bubble === null || state?.bubble === undefined ? null : <SpeechBubble key={state.bubbleRevision ?? state.bubble} text={state.bubble} revision={state.bubbleRevision ?? 0} expiresAt={state.bubbleExpiresAt} closeLabel={t('companion.closeBubble')} sessionId={state.bubbleSessionId} replyLabel={t('proactive.reply')} model={modelLoaded ? modelBox : null} onDismiss={releaseBubble} />}
      <canvas key={modelKey ?? 'empty'} ref={canvas} onPointerDown={beginModelDrag} data-hops={hops} onAnimationEnd={() => setHops(0)} className={`${ready ? 'live2d-canvas visible' : 'live2d-canvas'}${hops > 0 ? ' is-hopping' : ''}`} aria-label={state?.modelName ?? t('nav.companion')} />
      {!ready || loadError ? <button type="button" className="setup-card" onClick={() => void window.deskpet.app.showConsole()}><span>✦</span><strong>{loadError ? t('setup.overlayLoadFailed') : t('setup.notSet')}</strong><small>{t('setup.openSettings')}</small></button> : null}
    </main>
  );
};
