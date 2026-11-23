import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(1231 as never, pg.types.getTypeParser(1009 as never));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = pg.Pool;

export interface PoolOptions {
  statementTimeoutMs?: number;
}

export function createPool(connectionString: string, options: PoolOptions = {}): Db {
  const statementTimeoutMs = options.statementTimeoutMs;
  return new pg.Pool({
    connectionString,
    max: 10,
    ...(statementTimeoutMs && statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
  });
}
