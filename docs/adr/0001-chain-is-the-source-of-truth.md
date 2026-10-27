# 0001: The contract is the source of truth

Status: Accepted

## Context

Aidline holds donor money in a Soroban contract. The backend exists to make that activity fast to browse, but donors need to be able to trust the numbers they see.

## Decision

The backend never moves funds and never computes balances that the chain already knows. For every campaign touched by a page of events, the indexer reads `get_campaign` from the contract and stores the totals it returns. Events are used to build history tables and to know which campaigns changed.

The backend only stores what the chain cannot hold cheaply: campaign stories, proof files and verifier profiles.

## Consequences

- A missed, duplicated or reordered event cannot make `raised` or `released` drift from the contract.
- The database can be rebuilt from scratch by replaying the chain, within the RPC history window.
- Verifier status comes from the on chain `verifier_updated` event only. A profile alone never makes someone a verifier.
- Reads cost one extra contract simulation per touched campaign. That is acceptable at current volume.
