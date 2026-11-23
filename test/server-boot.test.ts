import { describe, expect, it, vi } from 'vitest';

import { connectWithRetry } from '../src/server.js';

describe('connectWithRetry', () => {
  it('ends failed pools before retrying and returns the first successful pool', async () => {
    const pools: Array<{ ended: boolean; fail: boolean }> = [];
    const create = vi.fn(() => {
      const state = { ended: false, fail: pools.length < 2 };
      pools.push(state);
      return {
        query: vi.fn(async () => {
          if (state.fail) throw new Error('db down');
          return { rows: [{ ok: 1 }] };
        }),
        end: vi.fn(async () => {
          state.ended = true;
        }),
      } as any;
    });
    const sleep = vi.fn(async () => {});

    const pool = await connectWithRetry('postgres://x', {
      maxAttempts: 5,
      baseMs: 1,
      sleep,
      createPool: create,
    });

    expect(pool).toBeDefined();
    expect(create).toHaveBeenCalledTimes(3);
    expect(pools[0]?.ended).toBe(true);
    expect(pools[1]?.ended).toBe(true);
    expect(pools[2]?.ended).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
