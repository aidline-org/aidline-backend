import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { notFound, pagination, stellarAddress } from '../src/lib/http.js';

describe('stellarAddress', () => {
  it('accepts a real account address', () => {
    expect(stellarAddress.safeParse(Keypair.random().publicKey()).success).toBe(true);
  });

  it('rejects a contract address, which starts with C', () => {
    const contract = 'C' + Keypair.random().publicKey().slice(1);
    expect(stellarAddress.safeParse(contract).success).toBe(false);
  });

  it('rejects the wrong length', () => {
    const address = Keypair.random().publicKey();
    expect(stellarAddress.safeParse(address.slice(0, 55)).success).toBe(false);
    expect(stellarAddress.safeParse(address + 'A').success).toBe(false);
  });

  it('rejects lowercase and characters outside base32', () => {
    const address = Keypair.random().publicKey();
    expect(stellarAddress.safeParse(address.toLowerCase()).success).toBe(false);
    expect(stellarAddress.safeParse('G' + '1'.repeat(55)).success).toBe(false);
  });

  it('rejects empty input', () => {
    expect(stellarAddress.safeParse('').success).toBe(false);
  });
});

describe('pagination', () => {
  it('defaults to the first 20 items', () => {
    expect(pagination.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('coerces query strings to numbers', () => {
    expect(pagination.parse({ limit: '50', offset: '10' })).toEqual({ limit: 50, offset: 10 });
  });

  it('accepts the limit boundaries 1 and 100', () => {
    expect(pagination.parse({ limit: '1' }).limit).toBe(1);
    expect(pagination.parse({ limit: '100' }).limit).toBe(100);
  });

  it('rejects a limit of 0 or above 100', () => {
    expect(pagination.safeParse({ limit: '0' }).success).toBe(false);
    expect(pagination.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects a negative offset and non integers', () => {
    expect(pagination.safeParse({ offset: '-1' }).success).toBe(false);
    expect(pagination.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(pagination.safeParse({ limit: 'many' }).success).toBe(false);
  });
});

describe('notFound', () => {
  it('replies 404 with the standard error shape', () => {
    const send = vi.fn((body: unknown) => body);
    const code = vi.fn(() => ({ send }));

    const result = notFound({ code } as never, 'campaign');

    expect(code).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith({ error: 'not_found', message: 'campaign not found' });
    expect(result).toEqual({ error: 'not_found', message: 'campaign not found' });
  });
});
