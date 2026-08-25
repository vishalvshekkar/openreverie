# Dreaming backlog

This is every piece of dreaming work deliberately left undone in v1, gathered in one place. It
exists so that nothing gets lost when this project's backlogs and roadmaps are consolidated
elsewhere: everything below should be easy to lift into whatever document replaces it.

Dreaming v1 shipped. What it does is described in the README's Dreaming section and in
[`docs/dreaming.md`](dreaming.md), which is the full working record: the original framing, the
idea catalog, the approaches considered, and the decisions taken. This file does not repeat that
reasoning. It only collects what was set aside, so a reader deciding what to build next does not
have to reread the whole record to find it.

Nothing in this document is a defect in what shipped, unless a line says otherwise. Most of it is
work chosen not to do yet. Section 2 is the exception: those seven items are real gaps between the
approved spec and the shipped code, each left as an open decision.

## 1. V1 non-goals

Chosen, not missed. Reasoning for each lives in `docs/dreaming.md` sections 5 and 10; this is only
the list.

**Graph writes of any kind.** Dreaming writes prose and a jsonl dream log in v1, never a graph
edge or node. Section 10 sketches the options for when this is revisited:

- Unconfirmed `relates_to` edges between existing nodes (`source: 'dream'`, `confirmed: false`),
  the cheapest option and the one closest to the existing edge schema.
- A `theme` node type for cross-cutting patterns that are not arcs.
- A `dream` node type, so a dream is itself a node with `involves` edges to what it touched.
- Retract-on-feedback: a "wrong" verdict appending a retract record for the edge the insight
  created.
- Confirmation-by-use: raising an edge's confidence if the companion draws on it in conversation
  and the user does not object. Flagged in the record itself as speculative, with a real risk of
  confirming by silence.

**Relevance-ranked prompt injection.** The dream section of the system prompt currently orders by
recency. Ranking by similarity to the live conversation was always the intended refinement (idea
19), not built in v1.

**Transcript-level attribution tagging.** The third option considered for feedback attribution
(idea catalog section 9a): assistant turns carrying hidden metadata naming which insight ids were
in context, so the web UI could mark a turn as dream-informed. Deferred in favor of the simpler
per-artifact feedback that shipped.

**Insight decay.** Old, never-confirmed insights do not yet lose prompt priority over time (idea
37). Everything with equal recency competes equally for the capped prompt section.

**Cross-dream consolidation.** A periodic pass that reads only past dream insights and writes a
higher-level digest (idea 38). Recorded as open but cautious: this is the exact shape of the
confabulation-drift risk the prior-art review flagged, so if it is ever built, the digest must cite
original evidence pointers, not dream ids.

**Dream series.** A multi-night thread following one long arc across several dreams (idea 33).

**User-seeded and in-conversation-requested dreams.** A CLI flag or tool to ask for a dream about
something specific (idea 34), and honoring a request made mid-conversation on the next dream (idea
35). Both open, idea 34 flagged as cheap to build.

**Feedback-driven selection tuning.** Right / wrong / do-not-bring-up feedback shipped and
permanently excludes an insight from the prompt and opener once recorded, but it does not yet
adjust selection weights going forward. The idea catalog (idea 18) calls for keeping an
exploration term so tuning selection by feedback does not collapse into flattery; that tuning
itself is not built.

Two further deferred items from the same catalog: **dream-informed mode behavior** (idea 20, for
example a `boost` mode drawing on the strengths ledger) and **reading-aloud or ambient surfacing**
(idea 36, a dream shown on the web landing page like a morning note). Both open or later, both
untouched in v1.

Approach 2 in `docs/dreaming.md` section 6, a tool-using agent session replacing the bounded
dig-deeper loop, was named as the upgrade path if the loop that shipped proves too shallow. It was
not built and is not currently planned; it is the answer if idea 7's restraint turns out to be too
tight in practice. Approach 3, continuous micro-dreaming folded into reflection instead of run on a
schedule, was rejected for v1 but could return as a small supplement to idea 5 (dormant-arc
revisits) if the scheduled path proves too infrequent on a machine that is rarely on.

## 2. Open spec deviations

These are real gaps between the approved spec (`docs/superpowers/specs/2026-08-24-dreaming-design.md`)
and what shipped. Each was caught, recorded, and deliberately left for a human decision rather than
resolved on an implementer's own judgment. Full detail is in `docs/dreaming.md`'s changelog
(section 14, the two 2026-08-25 entries and the final whole-branch review entry). This is the
inventory, not the argument.

1. **The CLI cannot record dream feedback, only display it.** The spec says the CLI "appends
   directly through the engine," matching the web path. `reverie dream --show` displays verdicts
   recorded elsewhere (web UI, `dream_feedback` tool) but has no command to record a new one.
   Deciding this means choosing how a terminal-issued verdict is represented: the `feedback`
   record's `source` field is typed `'ui' | 'tool'`, so either that enum gains a third value
   (changing an append-only log's record shape) or a CLI verdict is written under `source: 'ui'`,
   which would be false. Both are data-format decisions, not implementation work.

2. **No CLI settings surface for the three dream preferences.** The spec says voice, opener
   mention, and prompt section are changeable "from the CLI settings surface and the web Settings
   view." The web half works. There is no CLI equivalent; hand-editing `profile.md` is the only
   other route. Deciding this means designing what a CLI settings command for these three fields
   looks like, or deciding the web view is sufficient and updating the spec instead.

3. **Calendar resonance (selection step 5) was never built.** The spec calls for a weight boost
   when a candidate's date lands within about a week of "one or more years ago this week." This
   was already absent from the implementation plan before v1 shipped; it was simply not written
   down as a gap until the final review. Deciding this means either implementing the boost against
   the existing weighting function or removing it from the spec.

4. **The dream packet omits the constitution and profile summary the spec lists as inputs.**
   What shipped is narrower: the exploration prompt tells the model that reading the constitution
   is fine, and the bounded tool loop can reach both the constitution and the profile through
   `read_document` if a seed calls for them. They are tool-reachable, not injected up front.
   Deciding this means choosing whether injecting them by default is worth the token cost against
   the tool-reachable status quo.

5. **`reverie dream` (`dreamNow`) lacks the spec's manual once-per-period exemption.** The spec
   says a manual run should be exempt from the once-per-period rule. The code still refuses an
   unforced manual run when the period is already covered, the same as a background trigger would.
   `--force` is the current workaround. Deciding this means confirming whether the exemption is
   still wanted given the workaround, or implementing it as specified.

6. **The opener has no period bound.** The spec says the opener may mention a dream from the
   current or previous period. The code offers the newest unmentioned dream with a narrative,
   regardless of age, so a dream from months ago can still surface in an opener. Deciding this
   means adding the bound or confirming the unbounded behavior is preferred.

7. **The `dreamt` log record stores seeds only, not seeds plus walk plus tool-read entities.**
   The spec says it should store all three, since a `dream_state` fold would derive "last dreamt"
   times from that record. As shipped, anything reached only by the graph walk or by a tool call
   during the dig-deeper loop is never marked dreamt, so its staleness keeps accruing even after a
   dream actually touched it. Deciding this means widening the `dreamt` record's shape, which
   touches the append-only dream log's format.

## 3. Deferred minors from the execution ledger

`.superpowers/sdd/2026-08-24-dreaming-implementation/progress.md` is the task-by-task execution
ledger for the implementation plan. It is gitignored and will be deleted once this branch merges,
which is why these are recorded here rather than left to disappear with it. Across the
implementation tasks, fifteen items were flagged during review as minor: not worth blocking on,
each with its own note on why. The final whole-branch review (scoped to the seams between tasks,
after each task had already been individually reviewed and merged) triaged all fifteen and cleared
every one to ship. None of these are features; they are small test-coverage gaps, accepted
behavior gaps, one piece of dead code, one consolidation candidate, and two wording corrections to
a completion report. Two of the fifteen ledger lines describe the same finding (the `dreams.css`
lint warnings, flagged once mid-review and once at task close), so this list has fourteen entries.

**Test coverage, not code correctness:**

- The `foldDreamLog` fixture happens to have its array order match timestamp order for the one
  entity with two `dreamt` records, so deleting the newest-wins guard entirely still passes that
  fixture; only inverting the comparison catches it. The guard itself is correct. A second
  `dreamt` record in reverse timestamp order would close the gap if this fold is touched again.
- The every-insight-fails abort test in the dream pipeline passes because the fake provider's
  script runs out at the narrative call, not via a clean assertion on the abort path itself. The
  outcome assertion is real, just weaker than it looks; padding the script would make the failure
  mode unambiguous.
- Only one direction of the opener/prompt-section switch-independence property has an automated
  test (opener firing while the prompt section is off). The converse was checked manually against
  a built distribution but has no committed test.
- The artifact-tracking rule, that `dream.md`, `insight.md`, `process.jsonl`, and `log.jsonl` stay
  tracked while only the lock file is gitignored, was verified manually via `git ls-files`, not as
  an automated regression test. The ignore rule is a literal path, not a glob, so it cannot
  accidentally swallow other filenames.

**Known, accepted gaps in behavior:**

- A write failure partway through producing a dream (for example `insight.md` throwing after
  `dream.md` has already landed) can leave a partial dream directory: a narrative with no
  insights, no process log, and no log record. Nothing is corrupted or deleted, and the readers
  that consume dream directories (the CLI, the server endpoints, the web view) were all told to
  tolerate an incomplete directory rather than assume both files exist.
- `candidateWeight`'s staleness term is a hard linear cap (days since last dreamt, capped at 365,
  divided by 365) rather than the smoother "soft cap" the spec's wording suggests. The spec treats
  exact constants as implementation detail tested by invariant, and the invariants hold, so this is
  a wording mismatch, not a behavior gap.
- `POST /api/v1/dreams/:id/feedback` validates but discards the `:id` path segment, because
  feedback recording resolves an insight by its own id across all dreams, not by dream id. This
  matches the engine signature the task brief specified and was named as a known limitation by
  both the implementer and the reviewer, not a defect introduced in that task.
- A type-only import cycle exists between `engineDreams.ts` and `engine.ts` (one imports types from
  the other, which imports values back). It erases at build and violates no package boundary.
  Moving the two shared interfaces to a leaf module would make the split acyclic if anyone wants to
  clean it up.
- The CLI-level `!force &&` guard in the "dreaming is off" message check is dead code: the engine
  never returns that reason when `force` is true, so the guard can never actually trigger. Harmless.
- `dreams.css` carries four pre-existing cosmetic lint warnings (`noDescendingSpecificity`), left
  as the original ordering; lint still exits clean since these are warnings, not errors.

**Consolidation opportunities, not bugs:**

- Feedback-verdict folding logic is duplicated between `packages/cli/src/dream.ts` and
  `packages/server/src/app.ts`. It would consolidate most naturally by having the engine's
  `readDream` expose verdicts directly, so both callers read rather than re-derive them.

**Framing corrections, no code action:**

- A task's own completion report described a config field-by-field assembly as strictly required,
  when a narrower interface-level change would also have compiled. The approach that shipped
  mirrors an existing pattern in the same function, so it stayed; the note is about the report's
  wording, not the code.
- A task's own completion report called three new lint warnings "pre-existing." They were new to
  the repository in that diff, but dictated verbatim by the task brief. Wording only.

**Already resolved, recorded for the trail:** `dreamNow` originally had no handling for a throwing
`acquireDreamLock`, which would have surfaced a raw `ENOENT` error from the CLI. This was carried
into the CLI task as a requirement rather than left open, and the CLI now catches it with "Dreaming
could not run: ... Your memory folder may be damaged; try 'reverie doctor'." Listed here only
because it appears in the ledger as a deferred minor; it is not outstanding work.

## 4. Idea 39: commitment-aware dreams

From `docs/dreaming.md` section 11. Once a `commitment` graph node type exists (a separate,
unapproved design reviewed for interaction with dreaming but not itself built), a dream could
notice a quiet-but-alive commitment thread, a stated event whose time has passed, a seasonal gloss
whose season has arrived, and surface it as a gentle open-question insight. This is blocked on the
commitments design landing, and it is bound by that design's anti-taskmaster guarantees: no
open-question insight about a commitment whose single ask is already spent or that is marked quiet,
and interpreted time brackets never rendered in dream prose. Status: open, blocked.

## 5. Manual testing queue

Real outstanding work, but it belongs where it already lives rather than duplicated here: see
section 13 of [`docs/dreaming.md`](dreaming.md#13-manual-testing-queue). In short, everything about
whether a real model produces a good dream, a well-grounded insight, or the right tone has not yet
had a human look at it. Every automated test in this branch runs against scripted fake providers.
