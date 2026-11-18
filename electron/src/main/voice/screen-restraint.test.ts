import { describe, expect, it } from 'vitest';
import { foregroundCoversDisplay } from './screen-restraint';

describe('foregroundCoversDisplay', () => {
  // Runs the real osascript probe: a stubbed probe once hid that the window list was never read.
  it.runIf(process.platform === 'darwin')('reads the real window list and answers true or false', async () => {
    await expect(foregroundCoversDisplay([{ x: 0, y: 0, width: 100_000, height: 100_000 }])).resolves.toBe(false);
  });
});
