import { describe, expect, it } from 'vitest';

import { rankMotionGroups } from './semantic-action';

describe('rankMotionGroups', () => {
  it('selects semantic motion groups deterministically without mapping model metadata to commands', () => {
    expect(rankMotionGroups('greet', ['Idle', 'WaveHello', 'TapBody'])[0]).toMatchObject({ group: 'WaveHello' });
    expect(rankMotionGroups('unknown-action', ['Idle', 'TapBody'])).toEqual([]);
    expect(rankMotionGroups('interact', ['Idle', 'Scene1'])[0]).toMatchObject({ group: 'Scene1' });
    expect(rankMotionGroups('interact', ['Idle', 'TapBody', 'Scene1'])[0]).toMatchObject({ group: 'TapBody' });
  });
});
