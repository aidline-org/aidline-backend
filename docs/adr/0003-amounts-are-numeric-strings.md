# 0003: Token amounts are NUMERIC in Postgres and strings in JSON

Status: Accepted

## Context

Soroban token amounts are `i128`. A JavaScript number is a 64 bit float and silently loses precision above 2^53. Relief campaigns can be denominated in tokens with 7 decimals, so large goals can exceed that limit.

## Decision

- Store amounts as `NUMERIC(39,0)` in Postgres, which fits any `i128`.
- Return amounts as strings in API responses.
- Register type parsers in `src/db/pool.ts` so values never pass through a JavaScript number, including when they come back inside arrays.
- Contributors must never call `Number()` on an amount. Use `bigint` or keep the string.

## Consequences

- No rounding errors between the chain, the database and the API.
- Clients must parse amounts as `bigint`. The frontend already does.
- Sorting and summing happen in SQL, not in JavaScript.
