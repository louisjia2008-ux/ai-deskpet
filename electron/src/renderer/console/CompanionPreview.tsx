import { createContext, useContext, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Cat, ArrowCounterClockwise, HandWaving, SlidersHorizontal, X } from '@phosphor-icons/react';

import type { CharacterState } from '../../shared';
import { portraitRegion } from '../live2d/preview-frame';

type Translator = (key: string) => string;
const PreviewContext = createContext<{ frame: string | null; portrait: string | null; unavailable: boolean }>({ frame: null, portrait: null, unavailable: false });

export const CharacterPreviewProvider = ({ state, enabled, children }: {
  state: CharacterState; enabled: boolean; children: ReactNode;
}): JSX.Element => {
  const [preview, setPreview] = useState({ frame: null as string | null, portrait: null as string | null, unavailable: false });
  const ready = state.modelState === 'ready';
  useEffect(() => {
    setPreview({ frame: null, portrait: null, unavailable: false });
  }, [state.modelUrl]);
  useEffect(() => {
    if (!enabled || !ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let misses = 0;
    const update = async (): Promise<void> => {
      try {
        if (document.visibilityState !== 'hidden') {
          const frame = await window.deskpet.character.getPreview();
          if (cancelled) return;
          misses = frame === null ? misses + 1 : 0;
          let portrait: string | null = null;
          if (frame !== null) {
            const image = new window.Image(); image.src = frame;
            await image.decode();
            if (cancelled) return;
            const crop = portraitRegion(image.naturalWidth, image.naturalHeight);
            const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 160;
            canvas.getContext('2d')?.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, 160, 160);
            portrait = canvas.toDataURL('image/png');
          }
          setPreview((current) => ({ frame: frame ?? current.frame, portrait: portrait ?? current.portrait, unavailable: misses > 10 }));
        }
      } catch {
        if (!cancelled) setPreview((current) => ({ ...current, unavailable: true }));
      } finally {
        if (!cancelled) timer = setTimeout(() => void update(), 150);
      }
    };
    void update();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, ready, state.modelUrl]);
  return <PreviewContext.Provider value={preview}>{children}</PreviewContext.Provider>;
};

export const CompanionAvatar = ({ name, large = false }: { name: string; large?: boolean }): JSX.Element => {
  const { portrait } = useContext(PreviewContext);
  return <span className={large ? 'companion-avatar large' : 'companion-avatar'} aria-hidden="true">
    {portrait === null ? <Cat size={large ? 38 : 20} weight="duotone" /> : <img src={portrait} alt={name} />}
  </span>;
};

export const LiveCompanion = ({ name, ready, t }: { name: string; ready: boolean; t: Translator }): JSX.Element => {
  const { frame, unavailable } = useContext(PreviewContext);
  return <div className="character-stage" data-preview-state={!ready ? 'missing' : unavailable ? 'unavailable' : frame === null ? 'loading' : 'live'}>
    {ready && frame !== null ? <img className="live-preview-image" src={frame} alt={`${name} Live2D`} /> : <div className="preview-empty"><Cat size={40} weight="duotone" /><p>{t(ready ? 'ui.previewLoading' : 'setup.title')}</p></div>}
    {unavailable ? <p className="preview-error">{t('ui.previewUnavailable')}</p> : null}
  </div>;
};

export const CompanionPanel = ({ state, name, t, close, manage, refresh }: {
  state: CharacterState; name: string; t: Translator; close(): void; manage(): void; refresh(): Promise<void>;
}): JSX.Element => {
  const [error, setError] = useState(false);
  const ready = state.modelState === 'ready';
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    try { setError(false); await operation(); await refresh(); }
    catch { setError(true); }
  };
  return <aside className="companion-panel" aria-label={name}>
    <div className="companion-top"><span>{t('ui.withCompanion')}</span><button type="button" className="icon-button" aria-label={t('ui.hideCompanion')} title={t('ui.hideCompanion')} onClick={close}><X size={17} /></button></div>
    <div className="companion-title"><h2>{name}<span className={ready ? 'presence-dot ready' : 'presence-dot'} /></h2><p>{t('ui.companionDetail')}</p></div>
    <LiveCompanion name={name} ready={ready} t={t} />
    <div className="character-caption">{ready ? t('ui.livePreview') : t('setup.title')}</div>
    <div className="preview-controls"><label htmlFor="preview-scale">{t('companion.scale')}<span>{Math.round(state.scale * 100)}%</span></label><input id="preview-scale" aria-label={t('companion.scale')} type="range" min="0.2" max="3" step="0.1" value={state.scale} disabled={!ready} onChange={(event) => void perform(() => window.deskpet.character.setScale(Number(event.target.value)))} />
      <div className="character-buttons"><button type="button" className="secondary" disabled={!ready} onClick={() => void perform(() => window.deskpet.character.setScale(1))} aria-label={t('ui.resetScale')} title={t('ui.resetScale')}><ArrowCounterClockwise size={15} /></button><button type="button" className="secondary" disabled={!ready} onClick={() => void perform(() => window.deskpet.character.playAction('interact'))}><HandWaving size={15} />{t('companion.action')}</button><button type="button" className="secondary" onClick={manage} aria-label={t('ui.manageCompanion')} title={t('ui.manageCompanion')}><SlidersHorizontal size={15} /></button></div>
      {error ? <p role="alert" className="inline-error">{t('common.error')}</p> : null}
    </div>
    <p className="companion-footnote">{t('ui.previewDetail')}</p>
  </aside>;
};
