// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { InferenceAdmission } from './inference-admission';

describe('inference admission resource pools', () => {
  it('admits independent resources while preserving foreground priority within one resource', async () => {
    const admission = new InferenceAdmission();
    const states: string[] = [];
    const releaseA = await admission.acquire('background', undefined, { resourceKey: 'A' });
    const background = admission.acquire('background', undefined, { resourceKey: 'A', onAdmissionState: state => states.push(`background:${state}`) });
    const foreground = admission.acquire('foreground', undefined, { resourceKey: 'A', onAdmissionState: state => states.push(`foreground:${state}`) });
    const releaseB = await admission.acquire('foreground', undefined, { resourceKey: 'B', onAdmissionState: state => states.push(`independent:${state}`) });
    expect(states).toEqual(['background:queued', 'foreground:queued', 'independent:running']);
    releaseA();
    const releaseForeground = await foreground;
    expect(states.at(-1)).toBe('foreground:running');
    releaseA();
    expect(states).not.toContain('background:running');
    releaseForeground();
    (await background)();
    releaseB();
    expect(states.at(-1)).toBe('background:running');
    (await admission.acquire('foreground', undefined, { resourceKey: 'A' }))();
  });

  it('removes cancelled waiters without reporting running or blocking the next waiter', async () => {
    const admission = new InferenceAdmission();
    const release = await admission.acquire('background');
    const controller = new AbortController();
    const states: string[] = [];
    const pending = admission.acquire('foreground', controller.signal, { onAdmissionState: state => states.push(state) });
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    release();
    (await admission.acquire('background'))();
    expect(states).toEqual(['queued']);
    await expect(admission.acquire('foreground', controller.signal, { onAdmissionState: state => states.push(state) })).rejects.toMatchObject({ name: 'AbortError' });
    expect(states).toEqual(['queued']);
  });

  it('tolerates status observer failures and synchronous cancellation in a queued observer', async () => {
    const admission = new InferenceAdmission();
    const throwingObserver = () => { throw new Error('Synthetic observer failure'); };
    const release = await admission.acquire('foreground', undefined, { onAdmissionState: throwingObserver });
    const controller = new AbortController();
    const states: string[] = [];
    const pending = admission.acquire('foreground', controller.signal, { onAdmissionState: state => { states.push(state); controller.abort(); } });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const next = admission.acquire('background', undefined, { onAdmissionState: throwingObserver });
    release();
    (await next)();
    expect(states).toEqual(['queued']);
    (await admission.acquire('foreground'))();
  });
});
