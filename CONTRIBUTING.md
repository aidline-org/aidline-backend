# Contributing to Aidline Backend

Thanks for helping make relief and climate funding transparent. This guide gets you from clone to merged pull request.

## Finding something to work on

- Issues labelled `good first issue` are small and well scoped.
- Every issue lists acceptance criteria and the files you will likely touch. Ask in the issue if anything is unclear.
- Comment on an issue to get assigned before you start.

## Working on a Stellar Wave issue

Issues labelled `Stellar Wave` are part of the [Stellar Wave program on Drips](https://docs.drips.network/wave/). Contributors earn points for resolved issues and share the Wave reward pool in proportion to their points.

| Complexity | Label                 | Points |
| ---------- | --------------------- | ------ |
| Trivial    | `complexity: trivial` | 100    |
| Medium     | `complexity: medium`  | 150    |
| High       | `complexity: high`    | 200    |

How it works:

1. Pick an open issue and comment to ask for it. A maintainer assigns it to you. Please take one issue at a time and check nobody else is already assigned.
2. Read the acceptance criteria. Every box needs to be true for the issue to count as resolved.
3. Open a pull request that links the issue with `Closes #123`. Keep it focused on that one issue.
4. Respond to review comments. A maintainer merges the pull request and marks the issue resolved, which awards the points.

Quality matters more than speed. Pull requests are reviewed for understanding, not just for passing checks:

- Write and run the tests for your change. Do not submit code you have not run or cannot explain.
- Do not open pull requests that only fix typos or reformat files to collect points.
- If you use an AI assistant, you are still responsible for every line. Pull requests that look untested or not understood will be closed.
- Do not claim several issues at once or comment on assigned issues asking to be reassigned.

See the Drips [Terms and rules](https://docs.drips.network/wave/terms-and-rules/) for the full conduct rules.

## Local setup

```sh
git clone https://github.com/aidline-org/aidline-backend
cd aidline-backend
npm install
cp .env.example .env
npm run dev:db     # keep running
npm run dev
npm test
```

Tests start their own temporary Postgres, so they work without `dev:db` running.

## Making a change

1. Fork the repo and branch: `git checkout -b feat/short-description`
2. Keep pull requests focused on one issue.
3. Add tests in `test/`. Route changes need an API test, indexer changes need an indexer test.
4. Run the checks CI runs:
   ```sh
   npm run lint
   npm run typecheck
   npm test
   npx prettier --check .
   ```
5. Schema changes go in a new numbered file in `src/db/migrations/`. Never edit a migration that has already been merged.
6. Update `docs/API.md` if you change a request or response.
7. Open a pull request, fill in the template and link the issue with `Closes #123`.

## Code guidelines

- Validate every request with zod. Errors are turned into `400` responses automatically.
- Keep token amounts as strings or `bigint`. Never `Number()` an amount.
- SQL lives next to the route that uses it. Always use parameters (`$1`), never string interpolation of user input.
- The contract is the source of truth. Do not compute balances that the chain already knows.

## Commit messages

Use a short prefix: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`. Example: `feat: add donor refund history endpoint`.
