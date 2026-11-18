import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMediaSettings } from '../../shared/media';
import type { MediaAPI, MediaAsset } from '../../shared/media';
import { ChatImages, localMediaUrl } from './ChatImages';

const originalDeskpet = Object.getOwnPropertyDescriptor(window, 'deskpet');
const asset = (n = 1): MediaAsset => ({
  id: n.toString(16).padStart(64, '0'), sha256: n.toString(16).padStart(64, '0'), title: '开心挥手', tags: ['开心'], enabled: true, allowQq: false,
  mime: 'image/png', extension: 'png', bytes: 100, width: 1000, height: 1000, source: { kind: 'imported', name: 'fixture.png' },
  createdAt: '2026-11-06T12:00:00.000Z', updatedAt: '2026-11-06T12:00:00.000Z', deletedAt: null, lastUsedAt: null, useCount: 0,
});
const install = (assets: MediaAsset[]) => {
  const snapshot = vi.fn<MediaAPI['snapshot']>(async () => ({ assets, settings: defaultMediaSettings() }));
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { media: { snapshot } } }); return snapshot;
};
afterEach(() => { cleanup(); if (originalDeskpet) Object.defineProperty(window, 'deskpet', originalDeskpet); else Reflect.deleteProperty(window, 'deskpet'); });

describe('chat image attachments', () => {
  it('renders a bounded local URL, ignores supplied remote URLs and allows closing a local preview', async () => {
    const image = { ...asset(), url: 'https://untrusted.example/private.png' }; install([image]);
    render(<ChatImages attachments={[{ assetId: image.id, alt: '收到啦' }]} />);
    const thumbnail = await screen.findByRole('img', { name: '收到啦' });
    const expected = `deskpet://managed/reply-images/${image.id}.png`;
    expect(thumbnail).toHaveAttribute('src', expected); expect(thumbnail).toHaveAttribute('loading', 'lazy');
    const open = screen.getByRole('button', { name: '放大图片：收到啦' }); open.focus(); fireEvent.click(open);
    expect(screen.getByRole('dialog', { name: '图片预览：开心挥手' })).toBeVisible(); expect(screen.getByRole('img', { name: '开心挥手' })).toHaveAttribute('src', expected);
    expect(screen.getByRole('button', { name: '关闭预览' })).toHaveFocus(); fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(open).toHaveFocus();
    expect(document.querySelector('img[src^="https:"]')).toBeNull();
  });

  it('preserves recycled pictures in history and shows placeholders for missing or invalid assets', async () => {
    const valid = asset(), deleted = { ...asset(2), deletedAt: '2026-11-06T13:00:00.000Z' }, invalid = { ...asset(3), id: 'https://untrusted.example/image.png', url: 'https://untrusted.example/image.png' };
    const snapshot = install([valid, deleted, invalid]);
    render(<ChatImages attachments={[{ assetId: deleted.id, alt: '已删除' }, { assetId: asset(4).id, alt: '缺失' }, { assetId: invalid.id, alt: '异常' }]} />);
    const recycled = await screen.findByRole('img', { name: '已删除' });
    expect(recycled).toHaveAttribute('src', `deskpet://managed/reply-images/${deleted.id}.png`);
    await waitFor(() => expect(snapshot).toHaveBeenCalledOnce()); expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(document.querySelector('img[src^="https:"]')).toBeNull();
    expect(localMediaUrl({ id: valid.id, extension: '../remote' as MediaAsset['extension'] })).toBeNull();
  });

  it('replaces an unreadable local image with a placeholder', async () => {
    const image = asset(); install([image]); render(<ChatImages attachments={[{ assetId: image.id, alt: '开心' }]} />);
    fireEvent.error(await screen.findByRole('img', { name: '开心' })); expect(screen.getByRole('status')).toHaveTextContent('暂时无法读取'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('supports old preloads and omits empty attachments without any read', () => {
    const snapshot = install([]); const view = render(<ChatImages />); expect(view.container).toBeEmptyDOMElement(); expect(snapshot).not.toHaveBeenCalled();
    Object.defineProperty(window, 'deskpet', { configurable: true, value: {} });
    view.rerender(<ChatImages attachments={[{ assetId: asset().id, alt: '旧窗口' }]} />); expect(screen.getByRole('status')).toHaveTextContent('暂时无法读取');
  });
});
