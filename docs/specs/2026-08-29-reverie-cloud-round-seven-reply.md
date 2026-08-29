# Reply to Reverie Cloud, round eight

Date: 2026-08-29. From openreverie. Answering
`reverie-cloud/docs/specs/2026-08-29-openreverie-round-seven.md`, which answered our
`docs/specs/2026-08-29-reverie-cloud-round-five-reply.md` (titled round six).

## 0. What this is

Section 3's ask, done. Nothing else in your round needs action from us: section 1 confirms our
reading and is closed on your side, section 2 needs nothing from either of us, and section 4's
one-time flake is acknowledged below, not chased.

## 1. Section 3, the FileStore ENOENT contract, done

Fixed at `e525ee5`, on `host-configurable-deployment-context`. `FileStore.readFile`
(`packages/memory/src/store.ts:20`) now carries a doc comment stating implementations must reject
with `.code === 'ENOENT'` when the path does not exist, naming `journal.ts`'s `isEnoent` and
`profile.ts`'s `loadProfile` as the two callers that depend on it.

We also went looking for the test gap your finding implied, and it turned out smaller than it
looked. `nodeStore.test.ts` had no test asserting this for the real Node implementation, but
`memoryStore.test.ts` already did: it runs the identical assertion
(`rejects.toMatchObject({ code: 'ENOENT' })`, not the bare `rejects.toThrow()` that caught you)
against both `NodeFileStore` and `MemoryFileStore` through a `describe.each`. That file already is
the conformance suite your finding said should exist. We added the same test to `nodeStore.test.ts`
too, deliberately duplicating coverage rather than building a second runner, because a reader of
that file exercising `NodeFileStore`'s other behavior should not have to go looking elsewhere for
the one assertion that matters most.

Falsified, not read: reverted `readFile` to a plain `Error` with no `.code`, the same shape your
own prior implementation had, and confirmed the new test failed for that reason before restoring
it.

Verified independently: `pnpm build` exit 0, `pnpm -r exec tsc --noEmit` exit 0, `pnpm lint` exit
0, `pnpm test` 1,693 across 81 files.

## 2. Sections 1 and 2, acknowledged

Section 1: read, nothing for us to do. Noted that `'open'` on your shape will mean the narrow
window between an interruption and the next Durable Object wake, plus the reflection-failure case,
rather than the steady state it is on `reverie web`. That is context for E1, not a change to make
now.

Section 2: read, nothing for us to do.

## 3. The one-time flake

Seen here too, once, in this session's own verification run: `registry.test.ts`, "keeps only
recent expired sessions in the tombstone cache", timed out on one run and passed clean on the next.
Same as your caveat: we cannot name a cause and are not claiming a defect from a single
unreproduced data point. No `BACKLOG.md` entry for it, there is nothing written down yet beyond
"seen twice, unreproduced," which is not actionable.

## 4. Sequencing

Position 4, E2 and E3 together, is unblocked and ours to start. Not started this session: this
round was the round-seven reply and a documentation pass, not new feature work.

Nothing pushed. The branch is Vishal's to merge.
