import { expect, it } from 'vitest';
import { SpeechTurnGate } from './speech-turn-gate';

it('reserves synchronously across awaits and ignores cleanup from an older recording', async () => {
  const gate = new SpeechTurnGate(), input = gate.reserve()!;
  expect(gate.busy).toBe(true); expect(gate.reserve()).toBeNull();
  await Promise.resolve(); expect(gate.reserve()).toBeNull();
  gate.release(input); const output = gate.reserve()!;
  gate.release(input); expect(gate.current(output)).toBe(true);
  gate.release(output); expect(gate.busy).toBe(false);
});
