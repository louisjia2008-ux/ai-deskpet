import { describe, expect, it, vi } from 'vitest';
import { CatalogPriceRefresh } from './catalog-price-refresh';

describe('shared catalog refresh before request price capture', () => {
  it('holds concurrent first requests until the same refresh completes, independently per provider endpoint', async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const manager = new CatalogPriceRefresh(() => 0);
    let completed = 0;
    const first = manager.run('provider-a:endpoint', refresh).then(() => { completed++; });
    const second = manager.run('provider-a:endpoint', refresh).then(() => { completed++; });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce(); expect(completed).toBe(0);
    const independent = vi.fn(async () => undefined);
    await manager.run('provider-b:endpoint', independent); expect(independent).toHaveBeenCalledOnce();
    finish(); await Promise.all([first, second]); expect(completed).toBe(2);
    await manager.run('provider-a:endpoint', refresh); expect(refresh).toHaveBeenCalledOnce();
  });
  it('retries a failed refresh after five minutes and a successful refresh after a day', async () => {
    let now = 0;
    const manager = new CatalogPriceRefresh(() => now);
    const refresh = vi.fn<() => Promise<void>>(async () => { throw new Error('provider.network'); });
    await expect(manager.run('exact-key', refresh)).resolves.toBeUndefined();
    now = 299_999; await manager.run('exact-key', refresh); expect(refresh).toHaveBeenCalledOnce();
    refresh.mockResolvedValueOnce(undefined);
    now = 300_000; await manager.run('exact-key', refresh); expect(refresh).toHaveBeenCalledTimes(2);
    now += 86_399_999; await manager.run('exact-key', refresh); expect(refresh).toHaveBeenCalledTimes(2);
    now++; await manager.run('exact-key', refresh); expect(refresh).toHaveBeenCalledTimes(3);
  });
});
