# Session resume: the R1 design

Date: 2026-08-29. From openreverie, to Reverie Cloud, against
`docs/specs/2026-08-29-openreverie-release-benchmark.md` section 4, which asks for this page before
any R1 code is written.

Written at `8dc071f` on `host-configurable-deployment-context`, with R8 and R5 in flight beside it.

It answers the three things you asked for (how history is rebuilt and where the stamps come from,
what happens to `liveItems`, and the shape of the registry entry point), and then raises three
things the design forced into the open that your document does not cover. Two of those are ours to
state and build. One is a decision we are not going to make for you, per your own instruction to
raise rather than guess.

## 1. Rebuilding history

### 1.1 The stamp, and why the obvious helper is the wrong one

Your trap is real and there is a sharper version of it. The live path (`agent.ts:560`,
`appendBoth`) reads the clock once and produces two different renderings from that one read: the
transcript line gets `ts` and `utcOffsetMinutes` as separate fields, and, for user messages only,
history gets `renderLiveStamp(now, engine.timezone())` prefixed onto the content. That renders as

    [Sat 2026-08-29 14:32 Asia/Kolkata]

The obvious helper for the stored side is `renderStoredStamp(ts, utcOffsetMinutes)`
(`packages/memory/src/time.ts:150`), which is what every other stored-transcript reader in this
repository uses. It renders the same instant as

    [Sat 2026-08-29 14:32 UTC+05:30]

Those are different bytes. A resume built on the helper that looks correct would re-derive stamps
from each line's own stored `ts` and `utcOffsetMinutes`, exactly as you asked, and still change
every user message in the conversation. The zone label is the difference: the live path has the
person's IANA zone name and the stored line does not, because a stored offset is not a zone.

So the rule is a check, not a rendering choice. For each user line:

1. Compute `utcOffsetMinutesFor(new Date(line.ts), engine.timezone())`.
2. If the line carries `utcOffsetMinutes` and it equals that, render
   `renderLiveStamp(new Date(line.ts), engine.timezone())`. This is byte-identical to what the live
   session wrote: equal offsets at the same instant mean identical wall-clock digits, and the zone
   label is the same string it was then.
3. Otherwise fall back to `renderStoredStamp(line.ts, line.utcOffsetMinutes)`. Not byte-identical,
   and it does not pretend to be.

Case 3 fires when the person's zone changed since the line was written, or when the line predates
`utcOffsetMinutes` existing. In both, the string the live session wrote is genuinely unrecoverable:
nothing on disk records the zone name that was in effect. Rendering the current zone's wall clock
onto an old instant would be a fabrication of exactly the kind this repository refuses elsewhere, so
the fallback prints the offset it actually has.

One honest limit. Equal offsets do not prove the same zone: Asia/Kolkata and Asia/Colombo are both
+05:30. A person who moved between two same-offset zones passes the check and gets the current
zone's label. The stored line carries no zone name, so there is nothing better available, and the
rendered wall clock is correct either way.

Resume reports whether every stamp came back exact, so you can tell a cache-preserving resume from a
cache-breaking one rather than inferring it from your bill. See section 3.

### 1.2 A second divergence you did not name: `/mode` lines

`agent.ts:17` documents the stamps. It does not document this one, and we only found it by grepping
every caller of `appendTranscript`. There are exactly two: `appendBoth`, which writes both records,
and `setMode` (`agent.ts:273`), which writes the transcript **only**.

So a `/mode decompress` line is on disk and was never in history. Both sources do this: the CLI's
typed `/mode`, and the web picker's click, which is additionally marked `synthetic: true`. A naive
replay puts a user message into the rebuilt history that the live session never sent to the model,
and it lands in the middle of the conversation rather than at the end, so it moves every stamp after
it out of the cached prefix as well.

`synthetic` cannot be the discriminator, because the CLI's `/mode` is a line the person literally
typed and is correctly not synthetic. Content matching cannot be it either: a message whose text is
`/mode general`, sent through `POST /api/v1/sessions/:id/message`, is a real user turn and reaches
history like any other.

The fix is a durable marker written by that one append site: a new optional transcript field, same
posture as `synthetic` (`true` or absent, never `false`), so no existing line needs migrating and no
reader written before it breaks on it. Working name `historyOmitted`. Resume rebuilds history from
every transcript line that does not carry it.

The limit, stated rather than papered over: a session started before this field exists cannot be
resumed at full fidelity, because a `/mode` line in it is indistinguishable from a typed message. We
are not adding a content heuristic to cover that, because the heuristic would also swallow a real
message. Resume is new, so no host has such a session inside a resumable window.

### 1.3 The incomplete tail, and the 400 hiding in it

Transcript-first discipline means the transcript can end mid-turn in two shapes, and one of them is
not cosmetic.

**A user line with nothing after it.** The person's message was recorded, the object evicted before
any assistant line landed. History keeps the line. The person said it, and it is the last thing the
model needs to see.

**An assistant tool-call line with no matching tool result line.** `appendBoth` writes the assistant
tool-call line *before* `dispatchTool` runs (`agent.ts:474` then `:486`), on purpose, so a consumer
that abandons the iterator leaves a coherent record rather than a call that was announced and never
written down. An eviction in that gap leaves a durable assistant message carrying a `tool_call` that
nothing answers. Replay that into history and the next request to the provider is a 400, not a
degraded answer. Resume would produce a session that looks live and fails on its first message.

So: history drops trailing assistant tool-call lines whose result line never landed. The transcript
keeps them, untouched, because transcripts are sacred and nothing here rewrites one. That is a third
deliberate divergence between the two records, and it gets documented in `agent.ts`'s header
alongside the other two rather than living only here.

Two consequences worth naming. We do not know whether that tool actually ran, because the append
happens before the dispatch. And if it was a `remember`, we replay it anyway (section 2), preferring
a possible duplicate item over a lost one, since reflection re-derives items from the transcript
regardless.

This is where your "retry is acceptable and silence is not" lands concretely. Both tail shapes are
reported, not smoothed over:

    incompleteTurn?: {
      // transcript lineSequence of the person's last message: where the lost turn started
      fromLineSequence: number
      // trailing assistant tool-call lines left out of history. The transcript still holds them.
      droppedToolCallLines: number
    }

The test is one rule: the tail is complete only when the last rebuilt history message is an
assistant message with no tool calls. An empty history (a session evicted before its greeting
landed) is not incomplete.

## 2. `liveItems`

We are taking your preference, with three specifics you should check.

**Only the plain item shape replays.** `remember` carries four disjoint argument shapes
(`packages/core/src/tools.ts:90-150`). Only the plain `{ text, kind?, eventTime? }` one is an
in-memory write. `commitment`, `reviseCommitment` and `resolveCommitment` all go straight to
`graph.jsonl` and are already durable, so replaying those would double-record a commitment rather
than restore it. The replay is gated on the same key check `dispatchRemember` already does, and a
call whose arguments fail that schema is skipped for the same reason the live path skipped it: it
returned an error and never became an item.

**The item's `ts` comes from its own transcript line, not from the resume clock.** Same principle as
the stamps, and it matters more than it looks: `ts` is the record time reflection anchors a stated
event time against, so a resume-time value would quietly move every item the person recorded before
the eviction to the moment of the resume.

**Ids are minted fresh.** They were never durable and nothing references them across a process, as
you said.

Where the code lives: the parse stays in `packages/core`, because `tools.ts` already owns those
argument shapes and a second copy in `packages/memory` would let the two drift. Core hands the
parsed values to one narrow new engine method, roughly

    restoreLiveItems(sessionId, items: { text, kind?, eventTime?, ts }[]): void

which mints ids and sets the map. Direction stays downward: core calls memory, never the reverse.
It is safe to call unconditionally, because an unreflected session has by definition never written
an item to disk, so there is nothing to double count.

With this built there is no silent hole to declare, which is the outcome you asked for.

## 3. The registry entry point

    async resume(sessionId: string): Promise<ResumedSession>

    interface ResumedSession extends PublicSession {
      incompleteTurn?: { fromLineSequence: number; droppedToolCallLines: number }
      // Diagnostic, not person-facing: false means at least one user stamp could not be
      // reproduced byte for byte, so this resume did not preserve the provider's prefix cache.
      stampsExact: boolean
    }

Behavior, in the order the checks run:

- **Already in the live map**: return its current public view. No rebuild. Idempotent, so a host
  that resumes defensively before every message pays one map lookup.
- **Concurrent calls for the same id**: single-flighted through an in-flight promise map, so two
  requests arriving together cannot build two `AgentSession` objects over one session id.
- **At capacity**: the same `429 session_capacity` `create()` raises.
- **Not on disk**: `404 not_found`.
- **On disk and reflected**: `409 session_ended`. We never rebuild over a reflected session.
  Reflection has already materialised arcs, people and items from that transcript, which is your own
  section 6 exclusion, and this is the enforcement point for it.
- **Otherwise**: rebuild and insert as `status: 'live'`, `readOnly: false`, `lastActivity` now,
  empty replay buffer, `sequence: 0`, `activeTurnId: undefined`, `greeting: undefined`.

No greeting is scheduled and `freshDream` is left undefined on the rebuilt session. `freshDream` is
only ever consumed by `runGreeting`, and a resumed session never greets, so carrying it would risk
burning the one-time dream mention on a greeting that never happens.

Mode comes from `engine.sessionMode(sessionId)`, which is durable (`session.json`). If it is absent
we use `'general'`, the same default `start()` would have recorded, and note that absence means a
legacy or corrupt session rather than a real state, since `start()` writes the mode immediately.

**The window is not checked here, deliberately.** D19 puts liveness in your durable row, and the
registry has no durable clock for a session it has never seen, so a window check here could only be
a second and weaker opinion about a question you have already answered. You call `resume` when your
row says the session is live.

For the same reason `requireLive` is unchanged: no auto-resume. A guess about your window in front
of every write is worse than an explicit call. If you want the bundled Node server to resume across
a restart, that is a separate opt-in option and we would rather add it deliberately than have it
fall out of this.

No `/api/v1` route is added. R1 asks for a registry entry point and you drive it from inside the
Durable Object. Say so if you want a route as well.

## 4. `listStoredSessions` and `readOnly`, with a wrinkle

Proposed: `readOnly: status !== 'open'`. A reflected session stays read-only, and an unreflected one
stops claiming to be.

The wrinkle, which is why this is not purely mechanical. With no auto-resume, openreverie's own
server will still answer `409 session_not_live` for an open session it has not been asked to resume,
while the list now says `readOnly: false`. That makes the field a statement about the session ("this
one can be resumed") rather than a promise about this process ("this one will accept your next
write"), which is a slightly weaker claim than the one `a3e052c` just finished making honest.

We think that is the right reading and the alternative is worse (leaving the hardcode is a lie you
already named). But if you would rather the field stayed conservative, say so, because you are the
consumer that reads it.

There is a second interaction here that R8 creates and only R4 resolves. Once ending stops blocking
on reflection, a session that the person deliberately ended sits on disk unreflected for as long as
the reflection takes, and `listStoredSessions` reports it as `status: 'open'`, which now reads as
"resumable". A deliberately ended session must never be resumable. R4's durable record is what tells
those two apart, so R4 is not just nice-to-have next to R8, it is load-bearing for R1 as well. We
are building it before R1 for that reason.

## 5. The decision we want from you: where the system prompt comes from

This is the one thing we are not deciding for you, and it is a bigger cache lever than the stamps.

`AgentSession.start` assembles the system prompt once from a snapshot of memory state and holds it
for the session's life. It is refreshed in only three places: after `update_profile`, after
`update_journaling_protocol`, and through `refreshSystemPrompt` (used by `/style` and the settings
pane).

A resumed session has to get that string from somewhere, and re-assembling it is wrong twice.

**Cost.** The system prompt is the very start of the request prefix. Any change to it invalidates
the whole cached prefix, history included. Preserving every stamp below it buys nothing if the block
above it is rebuilt on every resume. At your hibernation timescale that is a full cache miss on
essentially every message, which is a larger version of the exact problem you asked us to avoid.

**Fidelity.** A session in which the model recorded a commitment would come back with that
commitment printed in its own system prompt, because `recordCommitment` writes straight to
`graph.jsonl` and `commitmentsSection` reads it at assembly time. The live session would not have
refreshed. Resume would hand the model a prompt that session never had.

**What we propose.** Persist the assembled system string in the session directory, written wherever
`this.system` is assigned (start, the two tool-triggered refreshes, `refreshSystemPrompt`), and read
it back on resume. A file next to `transcript.jsonl` and `session.json`, written whole through
`FileStore.writeFile`, which is already the atomic temp-then-rename path `session.json` uses.

Three costs, named rather than buried:

- A new per-session artifact holding a copy of the memory snapshot that was in the prompt. It never
  leaves the memory folder, and it makes what the model was actually told auditable, which today is
  knowable only by re-deriving it and hoping nothing moved.
- It is not rebuildable from the rest of the folder. That is the point of it, and it is why it sits
  in the session directory (part of the session's record) rather than being treated as an index.
- It freezes prose. A host that deploys new `PersonaOptions` mid-session keeps serving the old
  persona for the remainder of that session. We read that as continuity rather than a bug, but it is
  your deploy cadence, so it is your call.

**The alternative** is one line: re-assemble on resume, accept the cache miss and the drift. If you
would rather have that, say so and we will build it that way.

## 6. What resume will not do

Restating so nothing gets rebuilt into scope:

- No replay of a turn in flight at eviction. Withdrawn in round three, still withdrawn. The tail is
  reported, not reconstructed.
- No reopening of a session that was already ended and reflected.
- No window judgement inside the engine or the registry.
- No rewriting of any transcript line, for any reason.

## 7. What we will test

Named here so the design and the guards can be checked against each other:

- A stamp reproduced byte for byte, with the zone pinned and the clock injected, never relying on
  the machine's own zone.
- The fallback path, with a stored offset that disagrees with the current zone.
- A history whose zone changed partway, so both branches appear in one rebuild.
- `/mode` lines present in the transcript and absent from history.
- A dangling assistant tool-call line dropped from history, with the transcript verified unchanged.
- `incompleteTurn` reported for both tail shapes, and absent for a clean tail.
- `remember` replayed with its original `ts`, and the three commitment shapes not replayed.
- Two concurrent `resume` calls yielding one session.
- `resume` of a reflected session refused.
- The persisted system prompt read back rather than re-assembled, falsified by mutating the stored
  string and watching the next request carry the mutation.

## 8. What we need back

Only two answers, both in section 5 and section 4:

1. Persist the system prompt, or re-assemble on resume and accept the cache miss.
2. `readOnly: status !== 'open'`, or keep it conservative.

Everything else here we will build as written unless you object.
