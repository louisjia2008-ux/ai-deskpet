import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MicrophoneButton, pcm16 } from './MicrophoneButton';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(mode: 'hold' | 'toggle' = 'hold', autoSend = false) {
  const stopTrack = vi.fn(), close = vi.fn(async () => undefined), processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as null | ((event: unknown) => void) };
  const context = { sampleRate: 48_000, destination: {}, resume: async () => undefined, close,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }), createScriptProcessor: () => processor,
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }) };
  vi.stubGlobal('AudioContext', function () { return context; });
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  const api = { status: vi.fn(async () => ({ mode, autoSend, state: 'idle' })), prepare: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined), transcribe: vi.fn(async (_pcm: string) => { void _pcm; return '合成识别文本'; }) };
  vi.stubGlobal('deskpet', undefined);
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { speech: api } });
  const onResult = vi.fn();
  const view = render(<MicrophoneButton zh disabled={false} onResult={onResult} />);
  const start = async () => { const button = screen.getByRole('button', { name: '按住说话' }); fireEvent.keyDown(button, { key: ' ' }); await screen.findByRole('button', { name: '结束录音（最长60秒）' }); };
  const feed = () => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(24_000).fill(0.25) } });
  return { api, onResult, getUserMedia, stopTrack, close, view, start, feed };
}

it('downsamples to bounded little-endian int16, including clamping', () => {
  const bytes = Uint8Array.from(window.atob(pcm16([new Float32Array([2, 2, 2, -2, -2, -2])], 48_000)), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer); expect(view.getInt16(0, true)).toBe(32767); expect(view.getInt16(2, true)).toBe(-32768);
});
it('prepares before opening the microphone, stops tracks on release and returns a draft by default', async () => {
  const f = fixture(); await f.start(); f.feed();
  expect(f.api.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.getUserMedia.mock.invocationCallOrder[0]!);
  fireEvent.keyUp(screen.getByRole('button', { name: /结束录音/u }), { key: ' ' });
  await waitFor(() => expect(f.onResult).toHaveBeenCalledWith('合成识别文本', false));
  expect(f.stopTrack).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); expect(f.api.transcribe.mock.calls[0]?.[0]).toHaveLength(21_336);
});
it('explains permission denial without transcribing and releases the host reservation', async () => {
  const f = fixture(); f.getUserMedia.mockRejectedValueOnce(new Error('denied'));
  fireEvent.keyDown(screen.getByRole('button', { name: '按住说话' }), { key: ' ' });
  expect(await screen.findByRole('alert')).toHaveTextContent('麦克风中允许'); expect(f.api.transcribe).not.toHaveBeenCalled(); expect(f.api.cancel).toHaveBeenCalled();
});
it('cancels an in-flight result when disabled and does not submit late recognised text', async () => {
  const f = fixture(); let resolve!: (text: string) => void;
  f.api.transcribe.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
  await f.start(); f.feed(); fireEvent.keyUp(screen.getByRole('button', { name: /结束录音/u }), { key: ' ' });
  await screen.findByRole('button', { name: '取消识别' });
  f.view.rerender(<MicrophoneButton zh disabled onResult={f.onResult} />);
  await act(async () => resolve('late result')); expect(f.onResult).not.toHaveBeenCalled(); expect(f.api.cancel).toHaveBeenCalled();
});
it('supports toggle mode, explicit auto-send and the 60-second cap without retaining audio after unmount', async () => {
  const f = fixture('toggle', true); await waitFor(() => expect(f.api.status).toHaveBeenCalled());
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '说话' })); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole('button', { name: /结束录音/u })).toBeTruthy(); f.feed();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); vi.useRealTimers();
  await waitFor(() => expect(f.onResult).toHaveBeenCalledWith('合成识别文本', true));
  f.view.unmount(); expect(f.api.cancel).toHaveBeenCalled(); expect(f.stopTrack).toHaveBeenCalledOnce();
});
