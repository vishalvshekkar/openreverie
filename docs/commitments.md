# How commitments work

This is a reference for the commitments engine: a bounded thing you say you mean to
do ("I'm going to the Nightfall screening on Sunday," "come summer I want to start
swimming again"). It covers what exists today, including the parts that are not
built yet. For the design this implements, see
[the commitments spec](superpowers/specs/2026-08-24-commitments-design.md).

## Why a commitment is not an item

An item, the existing unit of captured memory, is a fact: append-only, no identity,
never revised. A commitment needs to be corrected as circumstances change ("forget
Friday, we'll sort out a day at some point"), and an append-only fact has no way to
express that except by adding a second, contradictory fact next to the first. The
dogfooding memory folder that motivated this feature held four contradictory item
records of one cinema booking, with nothing marking three of them dead
(`packages/memory/src/commitments.ts:1-14`).

A commitment is instead a graph node with identity. `graph.jsonl` stays append-only,
exactly as always: nothing is edited or deleted. "Revision" means reasserting the
same node id. Folding the log (`foldGraph` in `graph.ts`) already treats a later
assertion of an existing id as replacing the earlier one in current state, while
every prior version stays on disk, readable, forever. One live row per commitment,
history never destroyed.

## The record

`CommitmentPayload` (`packages/memory/src/graph.ts:88`):

- `flavor`: `'errand'` or `'plan'`. Affects only how the model is asked to talk
  about it (a solo bounded task versus something involving someone else); it never
  changes storage or selection.
- `state`: `'open' | 'done' | 'dropped' | 'unknown' | 'quiet'`
  (`graph.ts:56`). Nothing in this schema is named `overdue`, deliberately: spec
  Section 6 makes the absence of an overdue state a guarantee, not an oversight.
  `'unknown'` exists in the type but has no writer in production code (see
  "What is not built" below).
- `timing?`: a `CommitmentTiming`, present only when the person gave some kind of
  time. Absent entirely for an untimed commitment ("someday I want to learn
  pottery").
- `waitsOn?`, `askedAt?`: both exist on the record type. Neither is reachable from
  the live tool. See "What is not built."
- `sessionId`: the session that created (or, for a revision, most recently
  touched) this commitment.

### Stated time versus interpreted time

`CommitmentTiming` (`graph.ts:74`) always carries the person's own words (`words`)
and when they said it (`anchor`), never overwritten. Beyond that, exactly one of
two branches is present, enforced by a zod `.refine` so a record violating this can
never reach the log (`commitmentTimingSchema`, `graph.ts:141`):

- `resolved`: present only when `resolveStatedTime`
  (`packages/memory/src/commitmentTime.ts`) was certain enough to reduce the words
  to a calendar window with no judgment involved. It resolves `today`, `tonight`,
  `this evening`, `tomorrow`, `tomorrow night`, `in N days`, and a bare or
  `on `/`this `-qualified weekday. `next <weekday>` is refused on purpose: English
  speakers do not agree whether it means the coming occurrence or the one after, so
  resolving it would invent a fact the person did not state.
  (`commitmentTime.ts:8-10`, `:56-59`)
- `interpretation`: present only when the resolver refused, and only once
  reflection has had a chance to write one. It carries a `gloss` (a short, model-
  written interpretation), an optional `bracketFrom`/`bracketTo` (an internal
  window), and an `interpretationConfidence`.

Both branches also carry a `statedPrecision`: `'day' | 'range'` on `resolved`,
`'period' | 'vague'` on `interpretation`. This is a second field, not folded into
confidence, because they answer different questions. `graph.ts`'s own comment
states the distinction directly: `statedPrecision` is "how precisely the PERSON
spoke," and is "distinct from interpretationConfidence... which is how sure OUR
reading is." "Come summer" is vague speech (`statedPrecision: 'vague'`) that a
model may still bracket with high confidence; "next Friday" sounds precise but our
reading of it (were it not refused outright) would be a near coin flip. Conflating
the two was, in the graph.ts comment's own words, "the earlier draft's mistake."

`selectCommitments` reads `statedPrecision`, never `interpretationConfidence`, to
decide how much lead time a commitment gets before it starts appearing in the
session prompt (`commitments.ts:198-256`): 0 days for a named day, 3 for a soft
range, 30 for a named period such as a season, 45 for anything vaguer. A weaker
stated anchor gets more lead, not less, so the one natural mention lands early and
gently rather than close to a bracket that is itself a rough guess.

### The live path never invents an interpretation

`MemoryEngine.recordCommitment` and `.reviseCommitment` (`engine.ts:708`, `:724`)
call a private `buildCommitmentTiming` (`engine.ts:747`) that only ever resolves or
carries the bare words forward. If the words don't resolve, the timing has
`words` and `anchor` and nothing else: no `interpretation`, no gloss, because "a
live tool call has no reliable moment to ask a model for a gloss" (`engine.ts:747`,
comment). The interpretation branch is written only by reflection, at session end,
which has the whole transcript and a moment set aside to read the person's profile
and think about what "come summer" probably means for them.

## Two paths in, three operations, one record

Every commitment can be recorded, revised, or resolved to an outcome
(`done`, `dropped`, or `quiet`), through either of two paths, kept distinguishable
at every boundary rather than flattened into one shape:

- **Live**, through the `remember` tool during conversation
  (`rememberCommitmentArgs`, `rememberReviseCommitmentArgs`,
  `rememberResolveCommitmentArgs`, `packages/core/src/tools.ts:123-150`). This
  depends on the model actually choosing to call the tool, the same caveat that
  applies to every other live capture in this codebase (see BACKLOG.md, "A newer
  chat model can quietly stop using memory").
- **Reflection**, at session end, reading the whole transcript
  (`commitments`, `commitmentRevisions`, `commitmentResolutions` on
  `ReflectionOutput`, `packages/memory/src/reflection.ts:157-203`). Reflection
  always runs, whether or not any tool was called during the session, which is why
  it has to be the path that works even when live capture doesn't: it is the only
  place a commitment mentioned in a tool-averse session, or resolved in one, is
  ever recorded at all.

The live tool's `resolveCommitment` shape requires both a commitment id and an
outcome; a resolution naming no outcome is refused outright by the schema, the same
discipline that applies to a revision naming no commitment id. Reflection's three
arrays follow the identical shape, "recording, revising, and resolving stay three
distinguishable operations" (spec Section 7), for the same reason: a resolution
folded into a generic revision would let a model quietly report "done" as a detail
of an unrelated edit instead of a real declared outcome.

### Reflection wins when both paths touch the same commitment

If a commitment was recorded live earlier in a session, and reflection at the end
of that same session proposes what looks like the same commitment (matched
case-insensitively on label), reflection revises the existing record instead of
creating a duplicate (`applyReflection`, `reflection.ts:1178-1206`). This is scoped
to the current session only, not to every commitment ever recorded, so a
same-labelled commitment from months ago is never silently overwritten by an
unrelated new one. The reasoning: reflection read the whole session, the live tool
call that created the commitment read only the one turn it fired on.

A malformed commitment, or a revision or resolution naming a commitment id that
does not exist (hallucinated, or retracted since the prompt was built), is dropped
silently rather than aborting the rest of reflection, the same posture the summary
and item pipeline already takes for entries it cannot act on.

## Selection: what makes it into the live session prompt

`selectCommitments` (`commitments.ts:362`) decides which commitments are worth
surfacing in the standing "Commitments" section of the system prompt, every
session, capped like every other prompt section. Three checks, each one an
anti-taskmaster guarantee named in spec Section 6, not incidental filtering logic:

1. **State is an allow-list, not a deny-list.** Only `state === 'open'` is
   eligible. This is deliberate: the shipped defect this fixed was a deny-list
   that excluded only `'quiet'`, so a commitment already resolved `'done'` or
   `'dropped'` kept loading into the prompt forever, under a header stating a
   commitment is "never evidence that they did it." A deny-list excludes the
   states someone thought to name at the time and silently admits every state
   added later; an allow-list fails visibly instead, since a future state defaults
   to not-surfaced until someone adds it.
2. **`askedAt` excludes a commitment once asked about**, in principle. In
   practice this filter has no production writer (see below), so it never
   excludes anything today.
3. **`waitsOn` excludes an event-anchored commitment from ever surfacing by
   time.** Also has no production writer from the live tool (see below).
4. **Time eligibility** (`isTimeEligible`, `commitments.ts:333`): today must fall
   within the lead time before the commitment's window, or within the window
   itself, or within a grace period after the window closes
   (`ASK_GRACE_DAYS = 14`, `commitments.ts:310`). A commitment with no computable
   window at all, timing absent entirely, or an interpretation with no bracket,
   is never eligible through this section: nothing for the calendar to gate on.

Eligible commitments are sorted soonest-window-first and capped
(`COMMITMENTS_SECTION_CAP = 800` characters, `packages/core/src/budget.ts:42`).

## The bracket selects, the gloss speaks

Spec Section 3's invariant, and the one piece of this design most worth getting
right: a derived time bracket may decide whether a commitment enters the prompt,
but it is never shown or spoken. Only the person's own stated words, and the
model-written gloss, ever reach the model in the rendered prompt.

This is enforced structurally, not just by convention. `SessionContext`'s
commitment projection (`engine.ts:321`) carries only `label`, `words`, `date`
(the day the words were said, read off `timing.anchor`), and `gloss`, no field
exists on that type for a bracket or a resolved window at all, so there is
nothing to leak even by an implementation mistake later. `commitmentsSection`
(`packages/core/src/context.ts:339`) renders `- <label> (said <date>: "<words>")
<gloss>` and nothing else. A test guards this rendering as a second line of
defense on top of the structural one.

## What is not built

- **"One ask, then permanent silence" (spec Section 6) is not implemented.**
  The spec's own words: "A commitment whose window has passed with no recorded
  outcome becomes eligible for exactly one natural follow-up. Asking it sets
  `askedAt`. It is never raised again and resolves to `unknown`." Nothing in
  `packages/*/src` writes `askedAt`, and nothing transitions a commitment to
  `unknown`. `ASK_GRACE_DAYS = 14` is an interim stand-in: it bounds time
  eligibility above so a passed-window commitment stops entering the prompt on
  its own after two weeks, instead of surfacing forever, but no outcome is ever
  recorded when that happens, and no real "the companion actually raised this"
  signal exists to build the honest version on. See BACKLOG.md, "The real
  `askedAt`/one-ask mechanism," for the deferred design and its trigger.
- **An untimed commitment is invisible to the live companion.** Spec Section 3
  says an open-ended commitment ("someday I want to learn pottery") should be
  "surfaced only when the conversation touches the subject, never by the
  calendar." That channel does not exist: nothing indexes commitments for
  `search_memory` or any graph lookup tool, so an untimed commitment has no way
  back into a live conversation at all. It is not orphaned: reflection still sees
  every commitment, uncapped, at session end (`engine.ts:1867`), so it stays
  revisable and resolvable there.
- **`waitsOn` is stored as a free-text field, not the graph edge the spec calls
  for.** The `waits_on` edge type exists in the graph vocabulary
  (`graph.ts:37`) and round-trips in tests, but no production code ever emits
  one. The live `remember` tool does not expose `waitsOn` at all, on purpose:
  Ruling 8's audit found that setting it live, with nothing anywhere to unset it,
  would let one tool call permanently silence a commitment. The data model
  (the field, the edge type, `selectCommitments`'s exclusion) is correct and
  waiting; the reactivation half of the mechanism, "becomes eligible once the
  awaited thing is recorded as having happened" (spec Section 5), is not built.
- **No browser view.** Spec Section 8 calls for a Record-section view: what is
  open, resolved, quiet. It does not exist. Commitment nodes render generically
  in the graph atlas, `packages/web/src/atlas.tsx` added `'commitment'` as a node
  type there, by its own comment "a minimal, functional default, not a
  considered design", and that is the only place they are visible in the
  interface.
- **A single long gloss can suppress the whole Commitments section.** The
  section-capping helper (`capRows`, `packages/core/src/budget.ts`) drops a row
  that doesn't fit and stops, rather than skipping it and trying shorter rows
  after it. Commitments are sorted soonest-first, so if the very first row's
  model-written gloss alone exceeds the 800-character cap, the whole section is
  dropped, including shorter rows that would have fit on their own.
- **Reflection's "Known commitments" listing is uncapped.** Every commitment
  ever recorded, in every state, is rendered into every reflection prompt
  (`engine.ts:1867`), on the reasoning that a person accumulates far fewer open
  commitments than named people or things. Over a long enough history this is
  still an unbounded, monotonically growing block in a prompt every other
  section of which is capped.

Each of the gaps above has its own entry in `BACKLOG.md` under "Companion
behavior," including the spec section it traces to and, where the source gave
one, the trigger for picking it up.
