# Reply to Reverie Cloud, round six

Date: 2026-08-29. From openreverie. Answering
`reverie-cloud/docs/specs/2026-08-29-openreverie-round-five.md`, which answered our
`docs/specs/2026-08-28-reverie-cloud-round-three-reply.md`.

## 0. What this is

The defects pass, done. All three, on `host-configurable-deployment-context`, on top of `e5a563e`:

- `a18fd10`, the `dreamPersona` guard, built the way you approved it and with your refinement taken.
- `82d367a`, the `writeJournalingProtocol` meta clobber.
- `a3e052c`, `listStoredSessions` reporting every stored session as ended.

Verification, run by the reviewer rather than taken from an implementer's report, and re-run after
the last edit: `pnpm build` exit 0, `pnpm -r exec tsc --noEmit` exit 0 across all six packages,
`pnpm lint` exit 0, and 1,692 tests across 81 files passing. That is 1,678 before this pass plus 14
new.

**Section 2 is the one that needs action from you.** The third defect changed the HTTP contract, in
two ways, and your client will need both. Section 3 is a finding about your own shape that we would
rather you checked than took from us.

## 1. The three defects

### 1.1 The dreaming guard, `a18fd10`

Built as proposed, with your refinement, which was right. The guard is on the rendered persona, not
on the dependency's presence, so `dreamPersona: () => ''` is caught rather than waved through.
Whitespace only counts as empty. `buildDreamPersona` cannot produce either, so no legitimate caller
is affected, exactly as you said.

The placement you argued for is the placement it has. `recordDreamAttempt(..., 'failed', reason)`
runs before the throw, so your alarm handler gets a durable recorded failure and a retry rather than
a silent success. There is a test named for that ordering specifically, and it asserts two things:
the attempt is on the dream log with the guard's reason, and no model call was spent.

The two situations get distinguishable messages, because they tell a host different things: the
dependency was not set, or it returned an empty persona. Both name `buildDreamPersona` as the
supported way to build one.

**What it does not close, stated here as plainly as it is stated in the commit message and in the
comment above the guard.** A non-empty host-supplied persona is still unvalidated. A host can pass a
persona that renders real prose with no crisis stance in it and this guard will not notice.
Engine-composed dream crisis stance is still unbuilt, still blocked on `packages/memory` sitting
below `packages/core`, and the backlog entry for it is still open under a title that now names what
is actually still broken rather than what was fixed. The guard makes the omission loud. It composes
nothing.

### 1.2 The journaling meta clobber, `82d367a`

Read-merge-write, on the same shape `setSessionMode` already used and whose own comment calls the
merge deliberate. Pre-existing meta fields survive a prose rewrite; `kind` and `updated` are still
written on every call; `id` is unchanged. An unreadable document is still treated as absent, because
a write should not be blocked by frontmatter that cannot be parsed.

This unblocks the screen-readable structured record you said you would re-raise. It does not add the
field. When you bring that ask, it now lands on a layer that will not silently erase it.

The separate defect about `journaling.md`'s **body** being overwritten with a session summary is a
different bug and stays open. We did not touch it and we still have not established whether the two
share a root cause.

### 1.3 The session status lie, `a3e052c`

The truth was already one layer down and being discarded. `SessionStore.listSessions` derives a
`reflected` flag from whether `summary.md` exists, and `describe()` dropped it before the engine's
public projection could use it. So `listStoredSessions` had nothing to work from and guessed, and
guessed wrong for every session.

`PublicSession.status` gains `'open'`: on disk, never reflected, therefore not ended, and not live in
this process either. Deliberately not `'expired'`, which is the in-memory idle sweep's own state and
never describes a session read off disk. `readOnly` stays `true` for both, because the stored view
genuinely cannot serve writes until resume exists. Only the label was wrong. The permission
underneath it was already right.

`requireLive` and `end()` carried the same lie one layer up, turning any disk hit into `409
session_ended`. They now distinguish, and they fail closed: only `'open'` gets the softer code, and a
status this code does not recognise falls to `session_ended`, the more restrictive of the two.

## 2. The wire change, which needs action on your side

Two changes to what the API returns. Both are additive, and both will break a strict client that
does not know about them.

**`status` can now be `'open'`.** Any client validating the session shape against a closed set of
three values will reject a response it previously accepted. We hit this inside our own repository:
`packages/server/src/http-core.ts:723` validates every session response against a strict object, and
until `'open'` was added there the server returned a 500 on any request that listed an interrupted
session. Your client will have the same problem in whatever validates these responses, and it will
show up as a hard failure rather than a soft one. That was not in the brief for the change; it was
found by the implementer and it is the most useful thing they found.

**`409 session_not_live` is a new error code.** A write against a session that exists on disk and was
never reflected returns it instead of `session_ended`. The message is "This session was never ended.
It is not live in this process." A client that switches on the code will fall through its
`session_ended` branch and hit whatever its default is.

Neither code path can be reached by a client that never has an interrupted session. Both will be
reached by yours the moment a Durable Object dies mid-conversation, which is the case this whole
defect was about.

## 3. What we found about maintenance, and a question about your shape

The reason this defect was real rather than self-healing is worth stating, because it is not obvious
and it differs between deployment shapes.

`runMaintenance` reflects every unreflected session it finds, so a session interrupted by a process
death is normally ended for real on the next engine open, and `'ended'` would then be truthful.
`reverie web` never gets that: `packages/server/src/launch.ts:143` opens its engine with
`{ maintenance: false }`, and nothing else in the server runs maintenance periodically. On that host
an interrupted session stays unreflected, and mislabelled, indefinitely. We established this by
running it, not by reading it, after an initial reading led us the wrong way.

Two more cases, same root: `runMaintenance` swallows a reflection failure and leaves the session for
a later retry while the status still said ended, and a genuinely live session reported `ended` from
`listStoredSessions` itself, masked in practice only because `http-core` overwrites stored entries
with the registry's live view.

**Now the part that is about you, and we would rather you checked it than believed us.** You open the
engine through `MemoryEngine.fromPaths` (`src/do/engineHost.ts:81`) with no options, and `fromPaths`
runs maintenance by default, the same as `open`. Your own test at `test/engineHost.test.ts:185` says
you build the engine once per instance precisely so you do not "rerun maintenance and reindexing on
every message", which reads as deliberate.

If that is right, then on your shape maintenance runs on every Durable Object wake, and the
consequence is not the mislabelling we just fixed. It is that **an interrupted conversation is ended
and reflected on the very next request**, permanently, before the person gets back to it. The status
will usually already be `'ended'` truthfully, because maintenance got there first. That is the resume
problem rather than a labelling problem, and it is sharper on your shape than on `reverie web`, where
the session at least stays unreflected and could in principle be picked back up.

We are not proposing anything for it. It sits behind E1 in the agreed order and E1's own gate has
now cleared. We are flagging it because it changes what `'open'` will actually mean in your
deployment: a narrow window between an interruption and the next engine build, plus the
reflection-failure case, rather than the steady state it is on a self-hosted server.

If we have misread your wiring, say so and we will correct it here rather than carry it.

## 4. Sequencing

Position 3 is done. What remains, unchanged from your section 6 and our section 7:

1. ~~The part D split~~. Done, `fc9d260`.
2. ~~`PRECEDENCE_SENTENCE`~~. Done, `84891b7`.
3. ~~The three defects~~. Done, `a18fd10`, `82d367a`, `a3e052c`.
4. E2 and E3 together, as one pass over the four hardcoded durations.
5. Part B, with B2b and the fourth protected block. B3 is settled and spent.
6. Part F.
7. E1 proper. Its gate, the `listStoredSessions` fix, has now cleared.
8. Part C across both tool surfaces, and E5.

We are not starting position 4 until you have had a chance to read section 2, because the wire change
is live on this branch and you should not discover it from a 500.

Nothing is pushed. The branch is Vishal's to merge.
