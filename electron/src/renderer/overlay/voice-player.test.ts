import { expect, it, vi } from 'vitest';
import { VoicePlayer, mouthLevels } from './voice-player';

const pcm = (values: number[]): string => {
  const bytes = new Uint8Array(Int16Array.from(values.map((value) => Math.round(value * 32_767))).buffer);
  return globalThis.btoa(String.fromCharCode(...bytes));
};

const fakeContext = () => {
  const started: number[] = [], stopped: number[] = [];
  const context = {
    currentTime: 0, destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: vi.fn() }),
    createBufferSource: () => {
      const source = { buffer: null, onended: null, connect: vi.fn(), start: (at: number) => started.push(at), stop: () => stopped.push(1) };
      return source;
    },
    close: vi.fn(async () => undefined),
  };
  return { context, started, stopped };
};

it('opens the mouth with the loudness of each 20 ms', () => {
  const levels = mouthLevels(Float32Array.from([...Array(480).fill(0), ...Array(480).fill(0.2)]), 24_000);
  expect(Array.from(levels).map((level) => Number(level.toFixed(2)))).toEqual([0, 0.8]);
});

it('plays chunks back to back, follows the voice with the mouth, and goes quiet on stop or a new reply', () => {
  const { context, started, stopped } = fakeContext();
  const player = new VoicePlayer(() => context as unknown as globalThis.AudioContext);
  expect(player.mouth()).toBeNull();
  const chunk = pcm([...Array(480).fill(0.2), ...Array(480).fill(0)]);
  player.receive({ id: 'a', pcm: chunk, rate: 24_000 });
  player.receive({ id: 'a', pcm: chunk, rate: 24_000 });
  expect(started).toEqual([0.05, 0.09]);
  context.currentTime = 0.05;
  expect(player.mouth()).toBeCloseTo(0.8);
  context.currentTime = 0.075;
  expect(player.mouth()).toBe(0);
  player.receive({ id: 'b', pcm: chunk, rate: 24_000 });
  expect(stopped).toHaveLength(2);
  player.receive({ id: null, stop: true });
  expect(stopped).toHaveLength(3);
  expect(player.mouth()).toBeNull();
});
