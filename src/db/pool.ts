import pg from 'pg';

// Return NUMERIC and BIGINT columns as strings. Token amounts are i128 on
// chain and must never pass through a JS number.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
// NUMERIC[] (oid 1231) parses like TEXT[] (oid 1009) so array items stay strings too.
pg.types.setTypeParser(1231 as never, pg.types.getTypeParser(1009 as never));
// DATE stays a 'YYYY-MM-DD' string. Parsing it into a JS Date would place it at
// local midnight and shift the day for anyone west or east of UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = pg.Pool;

const CONNECTION_ERROR_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export function isConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}
