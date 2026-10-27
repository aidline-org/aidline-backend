# Architecture decision records

Short notes on decisions that shaped the backend, written so a new contributor can see why things are the way they are before proposing a change.

To add one, copy the layout of an existing record, use the next number and open a pull request. Records are not edited once accepted. If a decision changes, write a new record that supersedes the old one.

| #                                            | Decision                                                  | Status   |
| -------------------------------------------- | --------------------------------------------------------- | -------- |
| [0001](0001-chain-is-the-source-of-truth.md) | The contract is the source of truth                       | Accepted |
| [0002](0002-poll-soroban-rpc-for-events.md)  | Poll Soroban RPC instead of streaming                     | Accepted |
| [0003](0003-amounts-are-numeric-strings.md)  | Token amounts are NUMERIC in Postgres and strings in JSON | Accepted |
