import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ChatImageAttachment, MediaAsset } from '../../shared/media';
import { mediaAssetUrl } from '../../shared/media';
import './media-library.css';

/** Asset metadata may supply a URL in older preloads. Always construct our own
 * bounded local address instead of trusting that field or model-authored text. */
export const localMediaUrl = (asset: Pick<MediaAsset, 'id' | 'extension'>): string | null =>
  /^[a-f0-9]{64}$/u.test(asset.id) && ['png', 'jpg', 'webp', 'gif'].includes(asset.extension)
    ? mediaAssetUrl(asset) : null;

export const ChatImages = ({ attachments }: { attachments?: ChatImageAttachment[] | undefined }): JSX.Element | null => {
  const api = window.deskpet?.media;
  const [assets, setAssets] = useState<MediaAsset[]>([]), [failed, setFailed] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const ids = (attachments ?? []).map(item => item.assetId).join(',');
  useEffect(() => {
    if (!api || !ids) return;
    let active = true;
    const refresh = async (): Promise<void> => {
      try { const snapshot = await api.snapshot(); if (active) { setAssets(snapshot.assets); setFailed(new Set()); } }
      catch { if (active) setAssets([]); }
    };
    void refresh(); const stop = api.onChanged?.(() => void refresh());
    return () => { active = false; stop?.(); };
  }, [api, ids]);
  const dismiss = useCallback((): void => { setPreview(null); previousFocus.current?.focus(); }, []);
  useEffect(() => {
    if (preview === null) return;
    close.current?.focus();
    const escape = (event: { key: string }): void => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [preview, dismiss]);
  if (!attachments?.length) return null;
  const selected = assets.find(asset => asset.id === preview);
  const selectedUrl = selected ? localMediaUrl(selected) : null;
  return <div className="chat-images" aria-label="图片附件">
    {attachments.map((attachment, index) => {
      const asset = assets.find(value => value.id === attachment.assetId);
      const url = asset ? localMediaUrl(asset) : null;
      return <figure key={`${attachment.assetId}:${index}`}>
        {asset && url && !failed.has(asset.id) ? <button type="button" className="chat-image-open" aria-label={`放大图片：${attachment.alt || asset.title}`} onClick={() => {
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setPreview(asset.id);
        }}><img src={url} alt={attachment.alt || asset.title} loading="lazy" onError={() => setFailed(value => new Set(value).add(asset.id))} /></button>
          : <div className="chat-image-unavailable" role="status">图片暂时无法读取，可能已丢失或损坏。</div>}
        {attachment.alt && <figcaption>{attachment.alt}</figcaption>}
      </figure>;
    })}
    {selected && selectedUrl && <div className="media-preview-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
      <div className="media-preview" role="dialog" aria-modal="true" aria-label={`图片预览：${selected.title}`} onKeyDown={event => {
        if (event.key === 'Tab') { event.preventDefault(); close.current?.focus(); }
      }}><button type="button" className="secondary" ref={close} onClick={dismiss}>关闭预览</button><img src={selectedUrl} alt={selected.title} /><p>{selected.title}</p></div>
    </div>}
  </div>;
};
