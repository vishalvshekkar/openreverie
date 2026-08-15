# Task 4 Fix Round 1

## RED

- `pnpm vitest run packages/server/src/registry.test.ts`
  - 4 failures before the fix: inactive capacity was not released, `close()` was absent, the oldest expired session remained in an unbounded tombstone shadow set, and a typed runtime provider outage returned `chat_failed`.
- `pnpm vitest run packages/providers/src/openai.test.ts`
  - 2 failures before the adapter fix: an `ECONNREFUSED` fetch failure and an HTTP 429 response were not typed as provider outages.

## GREEN

- Added a registry-owned scheduler seam and an unrefed Node interval. It sweeps inactive sessions without a caller invoking `sweep()`, releases live-session capacity, and is cancelled by `close()`.
- Tombstones remain capped at 64. Evicted entries use durable session metadata and return `409 session_ended`; retained expired entries return `409 session_expired`.
- Added `ProviderUnavailableError` to the providers boundary. The OpenAI adapter classifies typed fallback errors, selected network error codes, HTTP 429, and HTTP 5xx as unavailable. Other failures remain `chat_failed`.
- Turn records retain the request hash, state, and sequence range only. `runTurn` receives the message separately.

## Falsification

- Removing the scheduled callback made `expires inactive sessions through its scheduler and releases capacity without a manual sweep` fail with `session_capacity`.
- Allowing 65 tombstones made `keeps only recent expired sessions in the tombstone cache` fail because the oldest entry returned `session_expired` instead of the disk-backed `session_ended`.
- Disabling typed-error recognition made `reports a runtime typed provider outage as chat_unavailable` fail because it returned `chat_failed`.

## Verification

- `pnpm --filter @openreverie/providers build`
  - Passed.
- `pnpm vitest run packages/providers/src/openai.test.ts packages/server/src/registry.test.ts`
  - Passed: 25 tests.
- `pnpm build`
  - Passed.
- `pnpm test`
  - Passed.
- `pnpm lint`
  - Passed after formatting fixes.
