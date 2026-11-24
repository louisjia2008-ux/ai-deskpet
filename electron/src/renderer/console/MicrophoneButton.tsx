/* global MediaStream, AudioContext, ScriptProcessorNode, MediaStreamAudioSourceNode, GainNode */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Microphone } from '@phosphor-icons/react';
import type { SpeechInputSettings } from '../../shared/speech-input';

export function pcm16(chunks: readonly Float32Array[], rate: number): string {
  const input = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const bytes = new Uint8Array(Math.min(960_000, Math.floor(input.length * 16_000 / rate)) * 2), view = new DataView(bytes.buffer);
  for (let n = 0; n < bytes.length / 2; n++) {
    const from = Math.floor(n * rate / 16_000), to = Math.max(from + 1, Math.floor((n + 1) * rate / 16_000));
    let value = 0; for (let i = from; i < to; i++) value += input[i] ?? 0;
    value = Math.max(-1, Math.min(1, value / (to - from))); view.setInt16(n * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  let binary = ''; for (let n = 0; n < bytes.length; n += 8192) binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return window.btoa(binary);
}

export const MicrophoneButton = ({ zh, disabled, onResult }: { zh: boolean; disabled: boolean; onResult(text: string, autoSend: boolean): void }): JSX.Element | null => {
  const api = window.deskpet.speech;
  const [settings, setSettings] = useState<SpeechInputSettings>({ mode: 'hold', autoSend: false });
  const [state, setState] = useState('idle'), [error, setError] = useState('');
  const live = useRef(true), held = useRef(false), busy = useRef(false), generation = useRef(0);
  const resources = useRef<{ stream: MediaStream; context: AudioContext; processor: ScriptProcessorNode; chunks: Float32Array[]; timer: number; source: MediaStreamAudioSourceNode; mute: GainNode } | null>(null);
  const cleanup = (): typeof resources.current => {
    const value = resources.current; resources.current = null;
    if (value) { clearTimeout(value.timer); value.processor.onaudioprocess = null; value.processor.disconnect(); value.source.disconnect(); value.mute.disconnect(); value.stream.getTracks().forEach(track => track.stop()); void value.context.close(); }
    return value;
  };
  useEffect(() => {
    live.current = true;
    const refresh = (): void => { void api?.status().then(value => { if (live.current) setSettings(value); }).catch(() => { if (live.current) setError(zh ? '语音输入设置读取失败。' : 'Could not load speech input settings.'); }); };
    refresh(); window.addEventListener('focus', refresh);
    const cancel = (): void => { generation.current++; held.current = false; cleanup(); busy.current = false; if (live.current) setState('idle'); void api?.cancel(); };
    window.addEventListener('blur', cancel);
    return () => { live.current = false; window.removeEventListener('focus', refresh); window.removeEventListener('blur', cancel); cancel(); };
  }, [api, zh]);
  useEffect(() => { if (disabled) { generation.current++; held.current = false; cleanup(); busy.current = false; setState('idle'); void api?.cancel(); } }, [api, disabled]);
  const stop = async (): Promise<void> => {
    held.current = false;
    const value = cleanup(); if (!value || !api || !live.current) { void api?.cancel(); return; }
    const own = generation.current; setState('recognising');
    try { const text = await api.transcribe(pcm16(value.chunks, value.context.sampleRate)); if (live.current && own === generation.current) onResult(text, settings.autoSend); }
    catch { if (live.current && own === generation.current) setError(zh ? '识别失败，请检查语音文件夹后重试。录音没有发送。' : 'Transcription failed. Check the voice folder. Audio was not sent.'); }
    finally { if (own === generation.current) { busy.current = false; if (live.current) setState('idle'); } }
  };
  const start = async (): Promise<void> => {
    if (!api || disabled || busy.current) return;
    busy.current = true; held.current = true; setState('starting'); setError(''); const own = ++generation.current;
    let stream: MediaStream | null = null, context: AudioContext | null = null;
    try {
      await api.prepare();
      if (!live.current || own !== generation.current || !held.current) { if (own === generation.current) { busy.current = false; if (live.current) setState('idle'); void api.cancel(); } return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (!live.current || own !== generation.current || !held.current) { stream.getTracks().forEach(track => track.stop()); if (own === generation.current) { busy.current = false; if (live.current) setState('idle'); void api.cancel(); } return; }
      context = new AudioContext(); await context.resume();
      if (!live.current || own !== generation.current || !held.current) { stream.getTracks().forEach(track => track.stop()); void context.close(); if (own === generation.current) { busy.current = false; if (live.current) setState('idle'); void api.cancel(); } return; }
      const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain(); mute.gain.value = 0;
      const chunks: Float32Array[] = []; let total = 0;
      processor.onaudioprocess = event => { const data = event.inputBuffer.getChannelData(0), remaining = Math.floor(context!.sampleRate * 60) - total; if (remaining > 0) { chunks.push(data.slice(0, remaining)); total += Math.min(data.length, remaining); } };
      source.connect(processor); processor.connect(mute); mute.connect(context.destination);
      resources.current = { stream, context, source, processor, mute, chunks, timer: window.setTimeout(() => void stop(), 60_000) }; setState('recording');
    } catch {
      stream?.getTracks().forEach(track => track.stop()); if (context) void context.close();
      if (own === generation.current) { busy.current = false; void api.cancel(); if (live.current) { setState('idle'); setError(zh ? '无法录音。请在系统设置 → 隐私与安全性 → 麦克风中允许 DeskPet，然后重试。' : 'Cannot record. Allow DeskPet in System Settings → Privacy & Security → Microphone, then retry.'); } }
    }
  };
  if (!api) return null;
  const label = state === 'recording' ? (zh ? '结束录音（最长60秒）' : 'Finish recording (60s max)') : state === 'recognising' ? (zh ? '本地识别中…' : 'Transcribing locally…') : settings.mode === 'hold' ? (zh ? '按住说话' : 'Hold to talk') : (zh ? '说话' : 'Talk');
  return <span className="microphone-control"><button type="button" className={state === 'recording' ? 'microphone-button recording' : 'secondary microphone-button'} disabled={disabled || state === 'recognising'} aria-label={label} aria-pressed={state === 'recording'}
    onPointerDown={e => { if (e.button === 0) { e.currentTarget.setPointerCapture(e.pointerId); if (settings.mode === 'hold') void start(); } }}
    onPointerUp={() => { if (settings.mode === 'hold') void stop(); }} onPointerCancel={() => { generation.current++; held.current = false; cleanup(); busy.current = false; setState('idle'); void api.cancel(); }}
    onClick={() => { if (settings.mode === 'toggle') { if (busy.current) void stop(); else void start(); } }}
    onKeyDown={e => { if (settings.mode === 'hold' && [' ', 'Enter'].includes(e.key) && !e.repeat) { e.preventDefault(); void start(); } }}
    onKeyUp={e => { if (settings.mode === 'hold' && [' ', 'Enter'].includes(e.key)) { e.preventDefault(); void stop(); } }}><Microphone size={15} weight={state === 'recording' ? 'fill' : 'regular'} />{label}</button>
    {state === 'recognising' && <button type="button" className="secondary" onClick={() => { generation.current++; void api.cancel(); setState('idle'); busy.current = false; }}>{zh ? '取消识别' : 'Cancel transcription'}</button>}
    {error && <span role="alert">{error}</span>}</span>;
};
