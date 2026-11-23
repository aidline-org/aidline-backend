import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(1231 as never, pg.types.getTypeParser(1009 as never));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = pg.Pool;

export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}
