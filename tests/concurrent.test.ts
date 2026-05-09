import { describe, expect, it } from 'vitest';
import { concurrentMap } from '../src/domains/ppp.js';

describe('concurrentMap', () => {
  it('processes all items and preserves order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await concurrentMap(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects the concurrency limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await concurrentMap(items, 3, async (n) => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      // Yield to the event loop so concurrent peers can start.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    // With 10 items and limit 3, peak should reach 3 in normal scheduling.
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  it('handles empty input', async () => {
    const results = await concurrentMap<number, number>([], 5, async (n) => n);
    expect(results).toEqual([]);
  });

  it('handles concurrency higher than item count', async () => {
    const items = [1, 2, 3];
    const results = await concurrentMap(items, 10, async (n) => n + 100);
    expect(results).toEqual([101, 102, 103]);
  });

  it('propagates worker errors', async () => {
    const items = [1, 2, 3];
    await expect(
      concurrentMap(items, 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow(/boom/);
  });
});
