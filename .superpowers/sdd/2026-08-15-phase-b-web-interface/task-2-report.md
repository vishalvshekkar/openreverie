# Task 2 report: authenticated bounded record browsing API

## Scope

Implemented bootstrap authentication, native Node HTTP routes for provider-free record browsing,
legacy proposal inspection and resolution, durable session descriptions, and transcript page
projections.

## RED evidence

Before implementation, ran:

```text
pnpm vitest run packages/server/src/auth.test.ts packages/server/src/app.test.ts packages/memory/src/transcripts.test.ts
```

Result: failed as expected. `./auth.js` and `./app.js` did not exist, and
`SessionStore.describe` was not defined.

## GREEN evidence

Focused test run:

```text
Test Files  3 passed (3)
Tests  22 passed (22)
```

The repeated resource-bound diagnostic used a document body with exactly
`4 * 1024 * 1024 + 1` UTF-8 bytes:

```text
Test Files  1 passed (1)
Tests  1 passed | 7 skipped (8)
```

Final verification:

```text
pnpm test
Test Files  26 passed (26)
Tests  464 passed (464)

pnpm build
exit 0

pnpm lint
Checked 79 files. No fixes applied.

## Fix Round 2

### Changes

- Removed duplicate strict parses from the document, session, transcript, and proposal routes.
  Each route now passes its raw projection to `writePublicJson`, which is the single strict
  response-validation boundary. Successful response shapes and the safe internal error are
  unchanged.

### RED and GREEN evidence

The existing focused malformed-projection test covers the boundary: the fake document includes a
`filesystemPath`, and the expected response is the safe `internal_error` without that path. After
the route-level parses were removed, the focused test remained green:

```text
pnpm vitest run packages/server/src/app.test.ts -t "rejects unexpected and malformed public projections before serializing them"
Test Files  1 passed (1)
Tests  1 passed | 9 skipped (10)
```

Covering tests:

```text
pnpm vitest run packages/server/src/auth.test.ts packages/server/src/app.test.ts packages/memory/src/transcripts.test.ts
Test Files  3 passed (3)
Tests  24 passed (24)
```

### Falsification

The focused test now depends on `writePublicJson` for rejection because route-level parses were
removed. A direct temporary deletion of the final strict parse was blocked by the editing safety
guard, so no unsafe bypass was retained in the worktree.
```

## Falsification

Temporarily removed the Host check from `requireAuthenticatedRead` and ran the named HTTP test.
It failed as expected because a request carrying `Host: localhost:4312` returned 200 instead of
400. The check was restored and the final focused and full suites passed.

The requested temporary removal of `consumed = true` was blocked by the editing safety guard,
because that edit would make a launch token reusable. The replay behavior is covered by the
bootstrap unit and integration tests, including the initial RED run, but that specific destructive
falsification was not performed.

## Implementation notes

- Bootstrap tokens and sessions are process-memory values. Invalid, expired, and replayed tokens
  receive the same generic unauthorized response.
- All API reads require the exact canonical Host and valid cookie. Writes also require the exact
  canonical Origin.
- Documents, sessions, transcripts, and pending legacy proposals use versioned cursor pagination
  with source revisions and stated byte limits.
- Stored sessions are always ended and read-only. Transcript line sequence numbering excludes
  blank and incomplete physical lines before numbering.

## Fix Round 1

### Changes

- Serialized the pending-proposal check and resolution under an app-instance lock keyed by
  proposal ID. A second concurrent resolution now checks the queue only after the first has
  completed, and returns `404` when the proposal is no longer pending.
- Added strict Zod public response schemas for bootstrap, document rows, document bodies,
  sessions, transcript lines and tool-call metadata, legacy proposal rows, and proposal
  resolution responses. Every successful response is checked before JSON serialization. A
  malformed or unexpected projection returns the existing safe `internal_error` response.

### Covering tests

`packages/server/src/app.test.ts` now includes:

- A real concurrent HTTP test that submits two proposal resolutions at the same time. It asserts
  exactly one `200`, one `404`, one engine resolution call, and one materialized resolution record.
- A public-boundary test that injects a filesystem path into a document row, plus malformed
  document, session, transcript, and proposal projections. It verifies that none become a
  successful JSON response.

### RED and GREEN evidence

RED, before the production change:

```text
pnpm vitest run packages/server/src/app.test.ts -t "serializes concurrent proposal resolutions|rejects unexpected and malformed public projections"
Test Files  1 failed (1)
Tests  2 failed | 8 skipped (10)

proposal resolution: expected [200, 404], received [200, 200]
public projection: expected 500, received a 200 document page containing filesystemPath
```

GREEN:

```text
pnpm vitest run packages/server/src/app.test.ts -t "serializes concurrent proposal resolutions|rejects unexpected and malformed public projections"
Test Files  1 passed (1)
Tests  2 passed | 8 skipped (10)

pnpm vitest run packages/server/src/auth.test.ts packages/server/src/app.test.ts packages/memory/src/transcripts.test.ts
Test Files  3 passed (3)
Tests  24 passed (24)
```

### Falsification

Temporarily removed the per-proposal lock wait and reran the concurrent HTTP test. It failed with
two `200` responses where the test requires one `200` and one `404`. The wait was restored before
the final verification.

### Final verification

```text
pnpm test
Test Files  26 passed (26)
Tests  466 passed (466)

pnpm build
exit 0

pnpm lint
Checked 79 files. No fixes applied.
```
