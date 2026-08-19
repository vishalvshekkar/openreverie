# Phase D execution handoff, part 4

This document is the complete brief for an orchestrating agent resuming Phase D. Read it fully,
then read `AGENTS.md` fully, before doing anything. `AGENTS.md` is binding; this document is your
resume state.

It supersedes `2026-08-17-phase-d-execution-handoff-3.md` for status. Part 3 is still worth
opening twice: its appendix holds the standing subagent preamble you will need, and its trap list
remains accurate. Everything else in it is stale.

## Your role

You are an orchestrator. You plan, decompose, dispatch, verify, and merge. You do not write
implementation code yourself. You dispatch subagents to write it, then you verify by running the
lint, the build, and the tests yourself.

Three rules, all of which cost real time in earlier sessions:

1. **A subagent's report that the tests pass is not evidence that the tests pass.** Run
   `pnpm lint`, `pnpm build` and `pnpm test` yourself and read the real output.
2. **`git show --stat` every commit.** A commit that lands implementation without its tests looks
   fine in `git log` and is a serious defect.
3. **`cd` with an absolute path in every shell command that runs the gate.** See "the wrong-tree
   trap, orchestrator edition" below.

## START HERE: modes is done and merged; journal is batched, Batches A-G done (7 of 16 tasks), Batch H is next

This section was rewritten by the orchestrator that ran Batches A through G, pausing deliberately
(at the human's request, to hand off to a fresh session on a fresh context budget) before
dispatching Batch H. Nothing is broken, nothing is mid-flight, both trees are clean. Read this
whole section before doing anything else; it is denser than the rest of the document on purpose.

### What is actually true right now

- Modes (all 24 plan tasks plus Batches O, P, Q) is DONE and merged into `feat/phase-d-design` as
  `e9c3350`. Nothing to verify there.
- Journal Batches A through G (Tasks 1, 2, 3, 4, 7, 5, 6, 8, 9, in dispatch order) are DONE,
  verified by the orchestrator personally (diff read, gate rerun, lint rerun) and committed, in
  the worktree `.claude/worktrees/journal` on branch `feat/phase-d-journal`. **Nothing has been
  merged into `feat/phase-d-design` yet**; journal only exists in its own worktree/branch so far.
- Current worktree test count: **1076 passed (1076), Test Files 59 passed (59)**, build 0, lint 0.
  Last commit in the worktree: `bfa1637` ("Add journalingProtocolSection to the assembled system
  prompt"). Confirm with:
  ```bash
  cd /Users/vishal/work/personal/second-mind/.claude/worktrees/journal
  git log --oneline -8        # top should be bfa1637
  git status --short          # must be EMPTY, nothing uncommitted
  npx tsc -b && npx vitest run   # expect 59 files / 1076 tests, all green
  npx biome check .
  ```
- Main repo (`/Users/vishal/work/personal/second-mind`) status should be exactly:
  ```
   M ROADMAP.md
  ?? docs/superpowers/specs/2026-08-19-mode-at-launch-design.md
  ```
  (the human's own uncommitted BUSL note, and a read-only spec file). Nothing else. If either tree
  doesn't match, work out what moved before continuing; do not assume it's safe to proceed.
- The "Journal plan" table further down (search for `### Journal plan, worktree`) has the full
  Batch A-N breakdown with commit hashes for A-G. **Batch H is marked TODO, not yet dispatched. It
  is the next action.**

### Batches O and P (modes), for context if it comes up

O (CLI startup spinner, `f51647b`) went to the `pi` CLI running DeepSeek V4 flash instead of a
Claude subagent, at the human's explicit request, as a one-batch trial. It went well but the human
decided not to continue the trial. P onward, including all of journal so far, used Claude subagents
(`sonnet` via the `Agent` tool), batched by shared files. That is the standing approach.

### Before dispatching Batch H, read these five things or you will redo work or break something

1. **The standing subagent preamble is at**
   `/Users/vishal/work/personal/second-mind/.claude/journal-preamble.md`. Deliberately placed
   inside the repo's own gitignored `.claude/` directory (not a session-scoped scratchpad), so it
   survives across sessions on this machine and is not tied to any session ID. Every batch A
   through G dispatch opened by `cat`-ing this exact path; every future batch should too. It is
   current as of Batch G (includes the `this.timezone()` reconciliation from Batch E and the
   G-before-H `context.ts` coordination note). If it is ever missing, the fallback is this
   document's "Dispatching subagents" section plus the reconciliation notes and safety boundary
   sections further down, reassembled the same way.

2. **Batch H (Task 10) is the largest task in the plan and is safety-relevant**: it creates
   `packages/core/src/journaling.ts`, containing the expressive-writing safety gate and per-method
   safety notes transcribed verbatim from the design spec. Its own Files block in the plan is
   incomplete: Step 7 also edits `packages/core/src/personas.ts` (widens `buildPersona`'s
   signature) and `packages/core/src/context.ts` (the `buildPersona(...)` call site inside
   `assembleSystemPrompt`, lines 53-58 as of `bfa1637`). **Batch G already added
   `journalingProtocolSection(context)` to the `sections` array in that same function (lines
   68-73-ish) and deliberately left the `buildPersona(...)` call site untouched for H.** Tell
   Batch H's brief plainly: do not touch the `sections` array (G already wired it), only the
   `buildPersona(...)` call site needs the new arguments threaded through.

3. **`packages/memory/src/index.ts` does not re-export anything from `journal.ts`.** Every batch
   so far avoided needing it (either stayed within `memory`, or reached journal.ts's exports
   through a `MemoryEngine` method rather than a direct import). Batch H, living in `core`, may be
   the first to need a direct cross-package import (e.g. `JOURNALING_PROTOCOL_ABSENT`). If so, add
   the barrel export as part of Batch H and rebuild (`npx tsc -b`) before the import resolves.

4. **Batch H must hand Batch K (the safety invariant test) a REAL signature, not the plan's
   text.** The plan's Task 10 Step 7 code for widening `buildPersona` is placeholder-style
   (`...unchanged...`), so what actually ships may differ from the plan's snippet. When you verify
   H, record `buildPersona`'s real final signature in this document, in H's row of the Journal
   plan table or a note under it, and write K's brief against that real signature. Also require
   H's brief to grep every `buildPersona(` call site before editing, and to confirm the
   pre-existing 42 `personas.test.ts` tests still pass in H's own gate run.

5. **Batch K (Task 13) is the safety invariant: six combinations of {companion, firewall} safety
   mode times {no mode, journal mode with a real `journaling.md` fixture, journal mode with the
   protocol absent}, asserting the crisis section is byte-identical and positionally LAST across
   every arm.** Falsify it yourself, personally, never trust a subagent's report of having done
   it: move the mode-paragraph insertion after `crisisSection` in `buildPersona`, confirm the
   `endsWith` assertions fail while a `toContain` presence check would still pass, then restore.
   Before committing K, run `git diff --exit-code -- packages/core/src/personas.ts` (must report
   no differences) and `git show --stat` on K's commit (must show only `personas.test.ts`). This
   is the same shape as modes' Task 8 invariant (Batch D there, falsified by the orchestrator, not
   redone). K cannot be dispatched until H has landed and been verified.

### Other things worth knowing before you continue

- **Two plan defects were found and fixed during Batch B**, not deferred: the plan predates
  `packages/core/src/docKinds.test.ts` (the "P8" DocKind wiring invariant), which assumed every
  `DocKind` gets an injected, capped prompt section. `journal` is tool-only (never prompt-
  injected, only reachable through `search_memory`/`read_document`) and `journaling`'s injected
  section is deliberately uncapped. Both are now recorded as an explicit `PROMPT_EXEMPT_KINDS`
  carve-out in that test file, not silently worked around. See "Journal plan defects found",
  defect 7, for the full reasoning if this comes up again in a later batch.
- **Batch C found and fixed a vacuous falsification in the plan's own Task 4 step 7** (the
  examen-label ordering test could not distinguish "correct order" from "first label silently
  missing"). Fixed with a stronger exact-sequence assertion, confirmed to actually fail under the
  plan's own falsification injection. Recorded in the Batch C commit message.
- **Batch E found and fixed the same class of problem**, personally re-verified by the
  orchestrator: falsifying the `mode === 'journal'` gate alone, in isolation, passed every test the
  plan gave, because none of them declare a method without also setting mode. A fifth test was
  added; the orchestrator independently re-ran that exact falsification and confirmed the new test
  catches it. See defect notes and Batch E's commit message.
- **Defect 8, not blocking, flagged for the human, not fixed**: the crash-path journal entry's
  `entryDate` uses `_doEndSession`'s `now = new Date()` (the moment recovery runs), not the
  session's actual start time. On the genuine crash path (process dies before `/bye`, a much later
  `runMaintenance` recovers it) this conflates event time and record time, which `entryDate`
  versus `recordedAt` exists everywhere else in this plan to keep apart. Plan-faithful, not a bug
  introduced by any batch. Raise with the human before changing it; do not silently fix it.
- **A third instance of a flaky-under-load test surfaced during Batch F**
  (`packages/web/src/views/conversations.test.tsx`, passed cleanly on immediate rerun). This is
  now three distinct files across three epochs (modes Batches L, P; journal Batch F), all the same
  shape: never touched by the batch that surfaced it, always clean in isolation or on rerun, only
  fails under full-suite load. This crosses the threshold this document already named for raising
  it with the human as a suite-level pattern (parallelism, worker count, timeout margins) rather
  than continuing to log one-off occurrences file by file. Raise it at the journal merge if it
  hasn't come up again sooner.
- **Deferred item 1 from the modes epoch (untested `getProfile`/`updateProfile`/`getSettings` in
  `packages/web/src/api.test.ts`) is folded into Batch M's scope**, not forgotten: M already
  touches that exact file for Task 15's own schema widening.
- **`ROADMAP.md`'s uncommitted change in the main repo is the human's own BUSL-1.1 note.** Leave
  it alone; it is not related to Phase D. Never `git commit -am` in the main repo; always stage
  the exact path.
- **Machine timezone is Asia/Calcutta (UTC+05:30).** CI is UTC. This has bitten date-sensitive
  tests before; see "Environment facts" below for the pinning pattern.
- The full Batch A-N table, the complete defects list (8 entries), the safety handling rules, and
  the dispatch recipe are all further down in this same document and are current as of `bfa1637`.
  This START HERE section is a summary for a fast cold start; the rest of the document is the
  detail to fall back on.

## STATUS BOARD

Mark a task ONGOING *before* you dispatch it, so the next agent knows what to verify rather than
assume. Fill in the commit hash as soon as you have verified and committed it. **Read the hash
back with `git rev-parse --short HEAD`; do not type one from memory.** Two fabricated hashes had
to be corrected in the last session.

### All five Phase D epochs

| # | Epoch | Tasks | Depends on | State |
| --- | --- | --- | --- | --- |
| 1 | **cli-polish** `2026-08-17-cli-polish-and-ci-fix-plan.md` | 10 | nothing | **DONE**, merged into design |
| 2 | **time** `2026-08-17-time-as-first-class-plan.md` | 23 | nothing | **DONE**, merged into design |
| 3 | **retrieval** `2026-08-17-context-and-retrieval-plan.md` | 19 | time | **DONE**, merged into design as `a0bd482` |
| 4 | **modes** `2026-08-17-modes-profile-settings-plan.md` | 24 | time | **DONE, merged into design as `e9c3350`.** Re-gated on design after merge: build 0, lint 0, 1029/1029. Worktree `.claude/worktrees/modes` removed. See Batches A to Q below |
| 5 | **journal** `2026-08-17-journal-mode-plan.md` | 16 | time, modes | **BATCHED, not yet dispatched.** Worktree `.claude/worktrees/journal` on `feat/phase-d-journal`, baseline reconfirmed at 1029/1029 (build 0, lint 0). Plan read and split into Batches A to N by shared files. See the Journal plan table below |

Phase D is not finished until all five have shipped and merged into `feat/phase-d-design`, and
design has merged to `main`. Merging design into `main` and cutting a release is the human's call:
raise it and wait. `main` is at `e72377b` (v0.5.0) and is a long way behind.

## MANUAL TESTING QUEUE, deliberately deferred, visit together near the end

An automated gate (`tsc`, `vitest`, `biome`) proves the code is correct, not that a feature works.
AGENTS.md requires starting the dev server and actually using a UI change by hand before calling it
done. This session deferred that, on the human's explicit instruction, rather than skip it or do it
piecemeal: everything below gets one consolidated manual pass near the end of Phase D (after journal
ships, before design merges to `main`), because seeing the pieces work together end to end is more
useful than one browser tab per commit. Add to this list as work lands. The one exception is a
change that seems too risky to leave unverified that long: say so plainly and do it immediately
instead of queuing it.

- [ ] **Modes Batch O, the CLI startup spinner** (`f51647b`). Run `node packages/cli/dist/index.js`
  for real, against a memory folder with something in it so the open takes a moment, and watch the
  spinner actually render: phrases cycling, the line clearing cleanly before the session opens.
  Automated tests cover phrase rotation and the clear-on-error path with fake timers and a fake
  `write`; nobody has watched it in a real terminal yet.
- [ ] **Modes Batch P, the web mode-card new-chat flow** (`d6f0700`). Run `reverie web`, open it in
  a real browser, and confirm: the new-chat screen shows all ten mode cards with no session created
  yet (check the network tab: no `POST /api/v1/sessions` before a click), clicking a card starts a
  session in that mode, "New conversation" returns to the picker instead of eagerly starting one,
  and abandoning the picker (navigate away, close the tab) leaves nothing to clean up. Also worth a
  look: the cards read well and the mid-conversation `<select>` switcher (Task 21) still works
  unchanged.
- [ ] **The web journal tab, real content, replacing the placeholder** (`4a170a0`). Run `reverie web`
  against a memory folder with at least one real journal entry (start a session in journal mode from
  the CLI or web, write something, end the session so reflection runs), open the Journal nav
  destination, and confirm: entries list newest-`entryDate`-first with the method in plain words
  ("Gratitude", "Daily Examen", not the internal key), a formatted date, and a short excerpt;
  clicking an entry shows its full body rendered as markdown, the method and date as a header line,
  and a "Written <date>" secondary line only when `recordedAt` differs meaningfully from
  `entryDate`; confirm there is no edit, delete, or compose control anywhere on the tab (it is
  read-only by design); confirm switching to the Journal tab does not end a live Conversations
  session (same check as the other nav destinations). Also worth a look: a memory folder with zero
  journal entries yet shows "No journal entries yet." rather than an empty list that could read as
  broken.
- [ ] **The journal-mode conversational experience itself, CLI and web**: start a session in journal
  mode, go through the first-time setup conversation (no `journaling.md` yet), confirm the agent
  actually asks what you want out of journaling rather than launching straight into a method, then
  pick a method (the examen is a good one to try, since it is the suggested default) and confirm the
  prompt sequence runs conversationally rather than as a form. Separately, try expressive writing and
  confirm the safety gate behavior described in the spec is visible in practice: it should not be
  offered if the conversation reads as being in crisis territory, and the session should close with
  the grounding prompt. This is the one part of the whole journal epoch no automated test can verify,
  since it depends on the model's actual behavior at inference time, not on code paths.

### Modes plan, worktree `.claude/worktrees/modes`, branch `feat/phase-d-modes`

Batching is by shared files. Run them SEQUENTIALLY in the one worktree: two agents running
`npx tsc -b` against the same `dist/` will read each other's half-written build output.

| Batch | Tasks | What | State | Commits |
| --- | --- | --- | --- | --- |
| A | 1, 2, 3 | `memory/style.ts`, `memory/profile.ts`, `core/config.ts` | DONE, 841 | `351092e` `d0e8015` `efa565b` |
| B | 4, 5 | `memory/engine.ts`, `core/tools.ts`, `memory/reflection.ts` | DONE, 858 | `0db42b1` `e0277e7` |
| C | 6 | `core/modes.ts` catalogue | DONE, 867 | `9b091df` |
| D | 7, 7A, 8 | `core/personas.ts` **SAFETY** | DONE, 884, orchestrator falsified | `bc2530c` |
| E | 9 | `core/context.ts` profile block | DONE, 897 | `8087dab` |
| F | 10, 11 | `memory/transcripts.ts`, `memory/engine.ts` | DONE, 912 | `63bda62` |
| G | 12 | `set_mode` replaces `update_style` | DONE, 919 | `c80f7bb` |
| H | 13 | style leaves `config.toml`, migration plus fixtures | DONE, 928 | `c5ba266` `49f3f3c` |
| I | 14, 15 | `cli/commands.ts`, the command table | DONE, 962 | `ba311c9` `9272fd1` |
| J | 16 | persistent status line, `cli/strip.ts` | DONE, 974 | `1c644b2` |
| K | 17, 18 | mode stream event, mode over HTTP | DONE, 990 | `fa7499d` |
| L | 19 | profile/settings endpoints, the API key | DONE, 1002, orchestrator falsified | `22e719e` |
| M | 20, 21 | web journal and settings destinations, mode picker | DONE, 1018 | `5e40167` |
| O | spec | CLI startup spinner, `2026-08-19-mode-at-launch-design.md` | DONE, 1023, dispatched via `pi` CLI + DeepSeek V4 flash (trial), orchestrator-verified and independently falsified | `f51647b` |
| P | spec | web mode-card new-chat flow, same spec | DONE, 1029, orchestrator-verified and independently falsified | `d6f0700` |
| Q | 22 | README | DONE, orchestrator personally, 1029 unchanged, boost dogfood pass done by hand | `bd68c2f` |

Batches O and P have no task numbers in the modes plan; they come from
`docs/superpowers/specs/2026-08-19-mode-at-launch-design.md` instead, folded into this epoch
because the human asked for the workshop's outcome to ship as part of modes, not as a separate
epoch. Point subagent briefs at the spec's decision sections and its "Implementation notes for the
next agent" section directly.

Seventeen commits sit on `feat/phase-d-modes` ahead of `feat/phase-d-design`, before O, P, and Q.

### Journal plan, worktree `.claude/worktrees/journal`, branch `feat/phase-d-journal`

Batching is by shared files, same discipline as modes: SEQUENTIAL in the one worktree, never
parallel, because two agents running `npx tsc -b` against the same `dist/` read each other's
half-written build output. Mark a batch ONGOING *before* dispatching it.

| Batch | Tasks | What | Depends on | State | Commits |
| --- | --- | --- | --- | --- | --- |
| A | 1 | `memory/paths.ts`: `journalDir`, `journaling` fields | nothing | DONE, 1033 | `30e80d9` |
| B | 2, + defect 7 | `DocKind` gains `journal`/`journaling`; `sqlite.ts`, `engine.ts`, `core/tools.ts`, plus `dateSpan.ts` and `core/docKinds.test.ts` (undeclared, see defect 7) | A | DONE, 1038 | `eb8a7ea` |
| C | 3, 4, 7 | `memory/journal.ts`: entry filename/frontmatter, body assembly, `journaling.md` read/write helper | A, B | DONE, 1057 | `a11a213` |
| D | 5 | `declare_journal_method` tool; `transcripts.ts`, `engine.ts`, `core/tools.ts` | C | DONE, 1063 | `d941c7b` |
| E | 6 | Gated write in `_doEndSession`, the crash path; `engine.ts` **safety-adjacent** | C, D | DONE, 1068, orchestrator personally re-falsified the mode gate | `dbf5621` |
| F | 8 | `sessionContext` gains `mode` param, `journalingProtocol`; `engine.ts` | C | DONE, 1072 | `3071398` |
| G | 9 | `journalingProtocolSection` in the assembled prompt; `core/context.ts` | F | DONE, 1076 | `bfa1637` |
| H | 10 | `core/journaling.ts` content module (largest task, includes the expressive-writing safety gate); wires into `core/modes.ts`, `core/personas.ts` (`buildPersona` signature), `core/context.ts` (call site) **safety-relevant content** | C, G | DONE, 1103, orchestrator personally cross-checked all six formats' evidence text and the safety gate against the spec, and personally falsified the wiring fix | `5aec7a4` |
| I | 11 | `update_journaling_protocol` tool, `refreshSystemPrompt` trigger; `engine.ts`, `core/tools.ts`, `core/agent.ts` | C | DONE, 1107, orchestrator personally falsified the reassembly trigger | `5f5e5b7` |
| J | 12 | Reflection's `journalingUpdate` field, the backstop path; `reflection.ts`, `engine.ts` | C | DONE, 1115, dispatched to `pi` CLI + DeepSeek V4 flash (trial 2), orchestrator-verified and independently falsified | `62f98a6` |
| K | 13 | **SAFETY invariant test, six combinations, position plus bytes**; `core/personas.test.ts` only | H, C | DONE, 1117, orchestrator personally re-falsified both halves in isolation | `5993b07` |
| L | 14 | Server exposes `journal`/`journaling` kinds; `server/app.ts` | B | DONE, 1118, dispatched to `pi` CLI + DeepSeek V4 flash (trial 3), orchestrator-verified and independently falsified | `2814ca9` |
| M | 15, + deferred item 1 | Web client schema, `Library.tsx` `KIND_LABELS`; `web/api.ts`, `web/views/Library.tsx`. Also close deferred item 1 from the modes epoch (below): `getProfile`, `updateProfile`, `getSettings` have no tests in `api.test.ts`, and M is already touching that exact file | L | DONE, 1125, dispatched to `pi` CLI + DeepSeek V4 flash (trial 4), orchestrator-verified and independently falsified. **Deferred item 1 (below) is now closed.** | `7bea8f7` |
| N | 16 | Real web journal tab, `excerpt`/`recordedAt` end to end; `engine.ts`, `server/app.ts`, `web/api.ts`, `web/views/Journal.tsx` (replaces placeholder), `journal.css` | B, L, M | DONE, 1132, dispatched to `pi` CLI + DeepSeek V4 flash (trial 5), orchestrator-verified and independently falsified. **All 16 journal tasks complete.** | `4a170a0` |

Notes on sequencing, from the plan survey:

- **C bundles three tasks (3, 4, 7) that all touch `journal.ts` and each depend only on Task 1.**
  Task 3 also has an undeclared soft dependency on Task 2 (it writes `kind: 'journal'` into
  frontmatter before `DocKind` formally includes it), which is why C runs after B, not before.
- **G before H is a deliberate ordering, not a hard dependency.** Task 10 declares a dependency
  only on Task 3, but its Step 7 (undeclared in the plan's own Files block for Task 10) edits
  `core/context.ts`'s `assembleSystemPrompt` to widen the `buildPersona(...)` call site, which is
  the same function Task 9 (Batch G) edits to add `journalingProtocolSection` to the `sections`
  array. Running G first means H's brief can say plainly "the `sections` array already has the
  journaling line, thread the new args through the `buildPersona` call without touching it,"
  instead of leaving two batches to land conflicting edits to the same function in either order.
- **H is where `buildPersona` gains the widened signature Batch K's safety test depends on.** K
  cannot be dispatched before H lands and is verified.
- **N's declared dependency in the plan is Task 2 only; the real dependency is B, L, and M.** Task
  16 Steps 5 and 8 add `excerpt`/`recordedAt` to the response schemas Tasks 14 and 15 create
  (`publicDocumentRowSchema`, `documentRowSchema`). Dispatching N before L and M land means those
  schemas do not exist yet to extend.
- Batch E (Task 6) is flagged safety-adjacent, not the safety invariant itself: it is the
  crash-path gating logic Batch K's test protects. Its own plan steps require a two-direction
  falsification (remove the `mode` gate, then separately the `method` gate) with the plan's own
  warning that a gate checking only one of the two would pass every test written before that
  second falsification. **Require two distinct pasted failure outputs in E's report**; if they are
  identical, or only one is given, re-run the missing direction yourself rather than accepting the
  report. This one does not need the orchestrator to re-run it personally, unlike K.
- **H's real final signature, recorded as required (`5aec7a4`).** `buildPersona`'s widened
  signature is:
  ```ts
  export function buildPersona(
    mode: PersonaMode,
    resources: CrisisResource[],
    style: StyleConfig,
    activeMode: ModeName = 'general',
    journalingProtocol?: string,
  ): string
  ```
  `personas.ts`'s internal `modeSection` also widened, to `modeSection(activeMode: ModeName,
  journalingProtocol: string | undefined)`, and now special-cases `activeMode === 'journal'` to call
  `buildJournalModeParagraph(journalingProtocol ?? JOURNALING_PROTOCOL_ABSENT)` instead of the static
  `modeParagraph(activeMode)` every other mode still uses; the surrounding `## Mode: ...` header and
  trailing `PRECEDENCE_SENTENCE` wrap stays uniform across every mode, journal included (an
  orchestrator ruling, since the plan's own Step 7 snippet was ambiguous on this point). The call
  site in `context.ts`'s `assembleSystemPrompt` (lines 53-59 as of `5aec7a4`) passes
  `context.journalingProtocol` as the 5th argument; `modeSection(...)`'s position in `buildPersona`'s
  `sections` array is unchanged (still directly before `crisisSection`), so the crisis-last invariant
  holds by construction. Write K's brief against this real signature, not the plan's placeholder.
  All 42 pre-existing `personas.test.ts` tests passed unchanged in H's gate run (54 unmodified
  `buildPersona(` call sites, relying on the new 5th parameter's default).
- **One plan defect found and fixed during H, worth knowing before K**: the plan's own Step 1 test
  for `CADENCE_DISCLOSURE_INSTRUCTION` asserted `.not.toMatch(/recurring/i)`, which collides with the
  plan's own Step 3 prose, "not a recurring nag." The implementer first fixed this by paraphrasing
  the prose to "not a nag to repeat," misclassifying it as incidental plan connective tissue. The
  orchestrator caught this on review by grepping the spec directly
  (`docs/superpowers/specs/2026-08-16-journal-mode-design.md:433`, exact phrase "not a recurring
  nag"), confirmed it is spec-transcribed like the evidence claims, and had the implementer revert
  the prose and narrow the assertion instead (dropped `recurring` from the negative pattern, added a
  positive `.toMatch(/not a recurring nag/i)` lock-in), falsified for real. Lesson for future
  batches: a subagent's own classification of "spec-transcribed vs. incidental" is not reliable
  enough to skip checking the spec directly when the two collide.
- **N's plan Files block omitted `packages/web/src/App.tsx`.** The placeholder `Journal` component
  took no props; the real one requires `api: AppApi`. `App.tsx`'s call site
  (`{view === 'journal' && (...)}`) needed one line changed, `<Journal />` to `<Journal api={api}
  />`, or `tsc -b` fails. `App.test.tsx` needed no change (it mocks `./views/Journal.js` with a
  prop-agnostic stub). Two more plan defects found and fixed in N: the `excerpt` conditional-spread
  literal fails `exactOptionalPropertyTypes` on a second call site (fixed by hoisting to a `const`
  and narrowing the truthy branch, the same pattern used elsewhere in this file); and the plan's own
  entry-view assertion (`getByText(/Gratitude/)` / a naive formatted-date match) matches multiple
  elements at once, since the same method label and date text render in both the list row and the
  reading pane. Fixed with an exact match on the reading pane's own concatenated text
  (`'Gratitude · 14 August 2026'`, `/Written 14 August 2026/`), which the orchestrator's own
  corrected brief for this batch had also gotten wrong on the first pass; the implementer caught it,
  not the orchestrator.
- **K's own plan text (Task 13 Step 1) contained a tautological assertion, caught by the
  implementer's own second review pass, then independently re-verified by the orchestrator.** The
  plan's position check compared each arm's crisis-section slice against itself
  (`journalWithFixture.endsWith(crisisSectionOf(journalWithFixture))`), which is true for any
  string regardless of where the section actually sits: a suffix always ends with itself. Fixed to
  compare all three arms against one fixed `baselineCrisis` comparator instead, plus an anchor
  assertion (`baseline.endsWith('- Find A Helpline (international): findahelpline.com')`) pinning
  that the baseline's own crisis section really is the output's tail, not just self-referential.
  Both the byte-identity and position checks were confirmed independently falsifiable, by the
  implementer and again by the orchestrator, each in isolation (commenting out the other check and
  re-running the reordering falsification alone). Lesson: even the plan's own falsify-step code can
  itself be anti-falsifiable; falsifying in isolation, one assertion at a time, is what catches that,
  not just running the whole block and seeing it fail somewhere.
- **A fourth instance of the flaky-under-load pattern surfaced during the orchestrator's own gate
  run for Batch K**: 1 test failed on the first full-suite run after Batch K's changes landed
  (`Tests 1 failed | 1116 passed (1117)`), passed cleanly on three immediate reruns
  (`1117 passed (1117)` each time). The specific failing test was not captured before the output
  cleared; not one of Batch K's own new tests (isolated `-t` runs of the new describe block were
  clean throughout). This crosses the threshold already named twice in this document for raising a
  suite-level pattern rather than continuing to log occurrences; raise it at the journal merge,
  alongside the three prior instances (modes Batches L, P; journal Batch F).
- **J went to `pi` CLI + DeepSeek V4 flash, a second trial, at the human's explicit request this
  session** (the first was modes' Batch O). Non-interactive invocation confirmed working:
  `pi --provider deepseek --model deepseek-v4-flash --print --no-session -p "<prompt>"` from the
  worktree root, run in the background; it has read/bash/edit/write tool access with no interactive
  permission prompts to work around. The report was thorough and caught real defects the plan itself
  under-enumerated (the `journalingUpdate: null` ripple hit four more files than the plan's Step 4
  named; `engine.search`'s real `{ documents, nodes }` return shape; an `exactOptionalPropertyTypes`
  violation in the plan's own verbatim field spread). Orchestrator verified and independently
  falsified the same as every sonnet-dispatched batch; no quality gap observed on this task. Kept
  off the two safety-relevant batches (H, K) deliberately; a reasonable batch to route this way is
  one with a complete, concrete plan and no crisis/safety-stance surface.
- **I's plan text guessed the wrong precedent for the reassembly trigger.** It said to copy
  whatever pattern `set_mode` uses; `set_mode` actually goes through a separate callback mechanism
  (`dispatchTool`'s options object), not a post-hoc `toolCall.name === '...'` check. The real,
  already-existing precedent is `update_profile`'s block at `agent.ts:417-424`; `update_journaling_protocol`'s
  trigger was added as a sibling `if` right after it (`5f5e5b7`). The plan's own Step 7 test (mirroring
  `update_profile`'s reassembly test, no explicit mode) could never pass regardless of correct wiring:
  `context.journalingProtocol` is only populated when the session's mode is `'journal'`. Fixed by
  starting the test's session in journal mode with a prior arc (not a first session, which would
  have taken the onboarding branch instead). Orchestrator personally falsified the corrected trigger.
- **Three test assertions were added beyond the plan's own text in H** (`personas.test.ts`'s
  `journal mode threading` describe block, `modes.test.ts`'s catalogue-identity check, one line in
  `context.test.ts`'s existing journaling-protocol-section test), because the plan's own generic
  `MODE_NAMES` loops would not have caught a silent regression in the new dynamic wiring (they also
  passed against journal's old static placeholder text). Each was personally falsified by the
  implementer and independently spot-checked by the orchestrator before being kept.
- **`packages/memory/src/index.ts` does not yet re-export anything from `journal.ts`** (found
  during C). Fine for C, D, E, F, J (all within `memory`, or reached through `MemoryEngine`
  methods rather than a direct import). The first batch that needs a `journal.ts` symbol
  (`JOURNALING_PROTOCOL_ABSENT`, `JournalMethod`, etc.) directly from `core` (most likely H or K,
  which live in `packages/core`) must add the barrel export first and rebuild (`npx tsc -b`)
  before that cross-package import resolves.
- **K's commit must be exactly one file.** Before committing K, run
  `git diff --exit-code -- packages/core/src/personas.ts` in the worktree; it must report no
  differences (the falsification's temporary edit must be fully reverted). `git show --stat` on
  K's commit must show only `personas.test.ts`. A leaked safety-ordering inversion is the worst
  defect this repo can ship; verify this personally, do not trust the subagent's report of having
  reverted it.

### Journal plan defects found, do not re-derive

From the same survey that produced the batching above, verified by reading the plan itself (not
yet cross-checked against the real tree, since nothing has been dispatched):

1. **Task 10's own Files block omits two files it actually edits.** It declares only
   `journaling.ts`, `journaling.test.ts`, `modes.ts`, `modes.test.ts`, but Step 7 also edits
   `core/personas.ts` (widens `buildPersona`) and `core/context.ts` (the `assembleSystemPrompt`
   call site, which Task 9 also touches). Reflected in Batch H's scope and the G-before-H ordering
   above.
2. **The plan's global "File Structure" table (its lines 54 to 92) is incomplete and does not
   match the per-task Files blocks.** `core/personas.ts` never appears there at all (only
   `personas.test.ts` does); `core/modes.ts` and `modes.test.ts` are absent despite Task 10's own
   Files block listing both. Treat per-task Files blocks as more authoritative, with the caveat in
   defect 1.
3. **Task 16's declared dependency (Task 2 only) understates its real dependency on Tasks 14 and
   15.** See the N row above.
4. **Task 6 assumes `this.profile.meta.timezone` exists on `MemoryEngine` without a grep check**,
   unlike almost everywhere else in this plan, which otherwise grep-confirms cross-plan
   assumptions explicitly. **Resolved in Batch E**: the real accessor is `this.timezone()`
   (`engine.ts:475`), which already resolves the stored value with a `systemTimeZone()` fallback
   baked in. Used directly; `this.profile.meta.timezone` was never a valid path.
5. **Task 3's stated dependency (Task 1 only) may understate a soft dependency on Task 2**, since
   it writes `kind: 'journal'` into frontmatter before `DocKind` formally includes that literal.
   Resolved by ordering (C runs after B), not by changing Task 3's own text.
6. **Many code snippets in the plan are placeholders**, marked
   `// ...whatever this function already does..., unchanged...`, expecting the implementer to grep
   the real shape rather than copy-paste. This is by design (the plan predates the time and modes
   plans landing) but raises the bar on batches touching the same file this way, notably G and H
   on `context.ts`.
7. **The plan predates `packages/core/src/docKinds.test.ts` (the "P8" DocKind wiring test), which
   assumes every `DocKind` gets an injected, capped prompt section.** `journal` is the first
   tool-only kind in this codebase's history (per the design spec, section 4.4: reachable only
   through `search_memory`/`read_document`, never prompt-injected), and `journaling` is the first
   kind whose injected section is deliberately uncapped (the spec's `journalingProtocolSection`
   has no `capBody` call, unlike `constitutionSection`). Resolved in Batch B, not deferred: added
   `journal`/`journaling` cases to `dateSpan.ts`'s exhaustive switch (`journal` point-in-time on
   `meta.entryDate`, `journaling` living/null, its header comment corrected from "four kinds" to
   "five"), extended `docKinds.test.ts`'s `PROMPT_SECTION_CAP` ledger with an explicit
   `PROMPT_EXEMPT_KINDS` carve-out (both entries `0`, each with its own comment explaining why),
   and hand-seeded a `journal` entry and a `journaling` doc in that file's integration test,
   confirming `walkAllDocuments` classifies both purely by file location, not `meta.kind`, so no
   dependency on Task 3's or Task 7's write helpers was needed to close this now. This is not a
   weakening of the P8 invariant: every other kind still requires a real positive cap present in
   `SECTION_CAPS`, and the exemption is only for these two, by name, with the reason recorded.
8. **The crash-path journal write's `entryDate` uses `_doEndSession`'s local `now = new Date()`,
   not the session's actual start time.** Found in Batch E, not fixed, not blocking: on the
   ordinary path this is harmless (the session ends the same day it happens), but on the genuine
   crash path (the process dies before `/bye`, a later process's `runMaintenance` reflects it
   days later) the journal entry's `entryDate` becomes the day of recovery, not the day the person
   actually journaled, which is exactly the event-time/record-time conflation `entryDate` versus
   `recordedAt` exists to prevent everywhere else in this plan. The plan's own text is explicit
   about using `now` here, so this was implemented plan-faithfully, not as a bug introduced by
   this batch. Fixing it would mean sourcing `entryDate` from the session's recorded start time
   instead (`SessionStore` already knows it), which is a real design change beyond Task 6's Files
   block. Raise with the human before fixing; do not silently change it.

## What to do next, in order

Modes is fully done: Batches O, P, Q shipped, merged into design as `e9c3350`, re-gated
(build 0, lint 0, 1029/1029). The worktree `.claude/worktrees/modes` is removed. The journal
worktree exists and is batched (Batches A to N above). Nothing dispatched yet.

1. **Dispatch Batches A through N, sequentially, one `sonnet` subagent per batch** (see "Dispatching
   subagents: the workflow that works" below for the recipe: shared preamble, short brief pointing
   at exact `sed -n` ranges, state the starting test count, forbid committing, require falsify-not-
   backfill). Mark each batch ONGOING before dispatch, verify with the full worktree gate yourself
   (`npx tsc -b && npx vitest run && npx biome check --write . && npx biome check .`), `git show
   --stat` the would-be commit's contents before committing, read the hash back with
   `git rev-parse --short HEAD`, then fill in the table.

2. **Batch K (Task 13) is the safety invariant. Falsify it personally**, exactly like modes Task 8
   (Batch D): a subagent may write the RED test and the GREEN implementation, but the orchestrator
   personally re-runs the falsification (move the mode-paragraph insertion after `crisisSection`
   in `buildPersona`, confirm the `endsWith` assertions fail while a `toContain` presence check
   would still pass, then restore) and pastes the real output here, rather than trusting the
   subagent's report of having done it.

3. **Add to the MANUAL TESTING QUEUE as journal's web/CLI surfaces land**, per that section's own
   rule: specifics (what to click, what to type, what to watch for), not "test the journal
   feature." Batch N (the real web journal tab) is the obvious candidate. Do not test any of it
   piecemeal unless it looks too risky to leave unverified until the end-of-epoch pass; say so
   plainly if that judgment call comes up.

4. **After all 16 tasks are done and verified**, run the full worktree gate one more time, then
   merge journal into design:
   ```bash
   cd /Users/vishal/work/personal/second-mind
   git merge feat/phase-d-journal      # regular merge, NOT --ff-only
   pnpm lint && pnpm build && pnpm test
   git worktree remove .claude/worktrees/journal
   ```
   Run the full gate again on design after the merge, because a merge can break what neither
   branch broke alone.

5. **Run the full MANUAL TESTING QUEUE**, journal's own items plus the two already queued from
   modes (the CLI startup spinner, the web mode-card picker), as one consolidated pass.

6. **Update the README honestly**, reflecting what journal actually shipped on top of what modes
   already documented.

7. Phase D is not finished until design merges to `main`. That merge, and cutting a release, is
   the human's call: raise it and wait.

## DO THIS FIRST: a design workshop on mode at launch — DONE

The human asked for a small design workshop on how mode selection works as an experience, in both
the CLI and the web, before resuming implementation. That workshop happened directly with the
human (not decided by an agent alone) and its outcome is written up in full at
`docs/superpowers/specs/2026-08-19-mode-at-launch-design.md`. Read that spec, not this section,
for the decision and the reasoning. Do not re-run the workshop.

Summary only, so you know whether you need the full spec for a given task: CLI always starts
`general`, no launch gate, no last-mode memory, with a new decorative status spinner during the
startup wait. Web decouples engine start from session start and gates session creation behind a
mode-card picker on the new-chat screen, a deliberate divergence from the CLI justified in the
spec. This is now Batches O and P of the modes epoch, above.

## DEFERRED ITEMS AND OPEN ISSUES

Nothing here is blocking the merge in the previous orchestrator's judgement, but every one is a
real finding and none should be lost. They are ordered by how much they matter.

### 1. The web API client's three new methods have no tests — CLOSED, journal Batch M, `7bea8f7`

`getProfile`, `updateProfile`, and `getSettings` now have request/response tests in `api.test.ts`,
matching the file's existing pattern. Orchestrator independently falsified one (changed `updateProfile`'s
method from `PATCH` to `POST`, confirmed the new test catches it, restored). Left here, struck through
in spirit, so the original finding stays legible.

`getProfile`, `updateProfile` and `getSettings` were added to `packages/web/src/api.ts` in
Task 19. `packages/web/src/api.test.ts` has **no tests for any of them**: confirm with
`grep -nE "getProfile|updateProfile|getSettings" packages/web/src/api.test.ts`, which returns
nothing. Task 19's Files block did not ask for them and Task 20's settings view tests against a
fake `AppApi`, so the real client implementations (URL, method, schema parsing) are unexercised
in both directions.

This is the largest genuine coverage hole modes leaves behind. The sibling methods added in
Task 18 (`createSession`, `setSessionMode`) DO have tests in `api.test.ts`, so there is a pattern
to copy directly. Worth closing before the merge; it is perhaps thirty minutes of work for a
cheap subagent.

### 2. The EOF loop depends on `case 'bye'` staying in the dispatch table

`packages/cli/src/chat.ts` treats readline EOF as `line = '/bye'` and lets it flow through
`parseInput` and `runCommand`. That is Task 14's design and it works: one place knows what `/bye`
does. But the ONLY thing ending the input loop on EOF is `case 'bye'` returning `'exit'`.

A Task 14 falsification found what happens if that case goes missing: EOF makes `io.question`
reject immediately, the synthesized `/bye` falls to the unknown-command branch, which writes one
line and `continue`s, and the loop spins forever. It is not a normal test failure. The
immediately-rejecting promise is awaited in a tight loop where no macrotask ever wins, so the
event loop starves, vitest's own timeout never fires, and the run dies at the V8 level with
`ERR_IPC_CHANNEL_CLOSED` instead of a clean assertion diff.

Nothing is broken today and a test covers the EOF path. Recorded because the failure mode is a
CPU-spinning hang rather than a red test, so whoever renames that case gets no useful signal.
The fix, if the human wants it, is to track EOF explicitly and return on it regardless of what
the command table did, roughly three lines. **It was deliberately NOT done: it is scope beyond
the modes plan. Raise it with the human rather than doing it unasked.**

### 3. One flaky test in `packages/server/src/registry.test.ts`

`keeps only recent expired sessions in the tombstone cache` (`registry.test.ts:175`) failed once
during a Task 16 run and passed on every rerun (5 of 5 in isolation, and in every full suite
since). It is NOT a logic race: the test injects both the clock (`now: () => now`) and the
scheduler (`FakeScheduler`). What it has is an explicit `15_000` ms timeout around a loop
creating 65 sessions, which can be exceeded when vitest workers compete for a loaded machine.

Left alone because fixing it means editing a test outside the modes plan's scope. If it recurs,
raise that one timeout. Do not reduce the session count: 65 is what the test is about.

A second instance of the same shape turned up during Batch P: `packages/web/src/views/settings.test.tsx`
failed once under full-suite load and passed on every rerun (5 of 5 in isolation, and on the
orchestrator's own two full-suite reruns after). Same pattern as above: not touched by Batch P's
changes, not a logic race, just resource contention under a loaded machine. Left alone for the same
reason. If flakes under load keep surfacing in different files, that is worth raising with the human
as a pattern rather than chasing file by file.

**A third instance turned up during journal Batch F, orchestrator's own verification run**:
`packages/web/src/views/conversations.test.tsx` (a "Session summary, 14 A..." button lookup)
failed once under full-suite load, passed cleanly on immediate rerun (1072/1072). Same shape again:
not touched by Batch F's changes (`engine.ts`/`engine.test.ts` only), not a logic race, resource
contention. This is the third distinct file across three different epochs (modes Batches L, P;
journal Batch F), which crosses the threshold this document already named for raising it with the
human as a pattern rather than continuing to log one-off occurrences. Raise it at the next natural
checkpoint (the journal merge, or sooner if it recurs again before then): a suite that flakes under
its own load on three unrelated files, always passing in isolation, may be worth addressing at the
suite/CI level (parallelism, worker count, timeout margins) rather than file by file.

### 4. `PublicSession.mode` survives onto tombstones

`registry.ts`'s `end()` and `sweep()` build ended and expired tombstones by spreading
`live.public`, so the `mode` field added in Task 18 is carried onto them. The plan leaves those
two functions untouched, so the behaviour was left as plan-faithful and the field's doc comment
in `packages/memory/src/engine.ts` was corrected to say so plainly rather than claiming
"live sessions only". If a later task wants mode to be genuinely live-only, that is a code change
in `end()` and `sweep()`, not a comment change.

### 5. A TDD lapse worth watching for

The Task 19 subagent reported plainly that it wrote tests and implementation together rather than
RED first, and compensated by running both falsifications against the finished code. The
orchestrator re-ran the security-critical falsification personally, so the evidence that those
tests can fail does exist. But a test written alongside its implementation can be shaped by the
code it tests, which is weaker than a real RED step. Later dispatches added an explicit
"write the failing test FIRST and run it, do not backfill the evidence" line. Keep that line in
every brief.

### 6. `~/.reverie` contamination, fixed, but know the shape of it

During Task 13 a subagent's `setup.test.ts` run wrote a `[style]` block into the developer's
**real** `~/.reverie/memory/profile.md`, because the test left the memory-folder prompt blank and
`askWithDefault` fell through to the real home directory. The agent caught it, restored it, and
fixed the root cause: `scriptedIo` now mints a per-call `mkdtemp` directory and substitutes it for
any blank "Memory folder" answer.

Verified independently afterwards: `~/.reverie/memory` is a git repo whose working tree is
identical to its last commit, and the whole `~/.reverie` tree was hashed before and after a full
suite run at every subsequent batch and never changed. The tripwire is cheap, keep using it:

```bash
BEFORE=$(find ~/.reverie -type f -exec md5 -q {} \; | sort | md5 -q)
# ... run the suite ...
AFTER=$(find ~/.reverie -type f -exec md5 -q {} \; | sort | md5 -q)
[ "$BEFORE" = "$AFTER" ] && echo "REVERIE UNTOUCHED" || echo "REVERIE CHANGED"
```

`AGENTS.md` forbids a developer's own `.reverie/` data entering the repo. A test suite writing
INTO it is the same rule from the other side.

### 7. The human's real config will need `reverie migrate`

`~/.reverie/config.toml` still has a `[style]` table. Once modes merges and ships, `loadConfig`
refuses it with "The style settings have moved out of config.toml and into profile.md. Run:
reverie migrate". That is the designed upgrade path Task 13 built, not a fault. Worth mentioning
to the human when the release is cut.

## PLAN DEFECTS FOUND, do not re-derive

All verified against the real tree. Several are cases where following the plan literally produces
either a compile error or, worse, a test that cannot fail.

### Drift carried forward from part 3, still true

1. **`saveProfile` does not exist. Use `writeProfile`** (`packages/memory/src/profile.ts:194`).
2. **`currentProfile()` does not exist. The accessor is `profile()`** (`engine.ts:458`).
   `currentStyle()` (`:480`) and `updateProfileSettings()` (`:512`) are named as the plan expects.
3. **`Profile.body` is correct**; do not substitute `prose` on the TYPE. Note that `prose` IS the
   correct field name in the PUBLIC HTTP response, mapped from `profile.body`. They are
   deliberately different names and both are right in their own place.
4. **`MigrationResult` is `{ id, applied, summary, details }`**, not the plan's
   `{ changed, messages }`. Both shipped migrations return `applied: !opts.dryRun`; follow them.
5. **Command table is stale.** Use `npx vitest run <path>` and `-t 'name'` to filter.
   `npx biome check --write .` then `npx biome check .`.

### New defects found in Tasks 13 to 21

6. **Task 13 step 9's grep is wrong.** It says `grep -rn "style: {"` should return no matches
   after the fixture sweep. There were 14 matches in 12 files, several of them legitimate profile
   `meta.style` and settings objects. Sweeping by grep deletes correct code. Delete `style:` from
   `ReverieConfig` literals only, and let `npx tsc -b` name them.

7. **Task 13 step 6's falsification cannot fail.** It says to break the idempotence guard and
   watch `is idempotent` fail. It will not: `writeProfile` calls `writeDocumentAtomic`
   (`documents.ts:54`), which serializes `meta` verbatim and stamps nothing time-varying, so a
   second unconditional apply reproduces both files byte-identically. Substitute: break
   `isPending` to ignore the `style` key and confirm the case-1 assertion fails.

8. **Task 17 step 8's falsification cannot fail.** It says to delete `mode` from the web
   `streamEventSchema` and rerun a test that never calls `parseStreamEvent`. vitest does not
   type-check, so it stays green; only `tsc -b` catches it. The subagent closed the gap with a
   runtime parse test in `api.test.ts`, after which deleting the schema member fails properly.

9. **Task 18's given tests miss the line they appear to cover.** Deleting
   `live.public = { ...live.public, mode }` in `setMode` left every plan-given test green,
   because `setMode` returns its own `{ mode }` independently of the public view. A readback test
   through `GET /api/v1/sessions/:id` was added and now fails for the right reason.

10. **Task 19 references a `makeServer` helper that does not exist** in
    `packages/server/src/app.test.ts`. The file uses `beforeEach` blocks calling `createApp`
    directly. Write the fixture the file's idiom wants.

11. **Task 19's API key test can pass while proving nothing.** `CreateAppDeps.config` is optional
    and the pre-existing `createApp` calls in `app.test.ts` pass no config at all. A sentinel test
    against a config-less app cannot leak the sentinel. The fixture must thread a real
    `ReverieConfig` with `provider.apiKey` set to the sentinel into BOTH `createApp` and the
    `LiveSessionRegistry`, and the test must be proven capable of failing.

12. **Task 15's plan contradicts itself** on one string: its test asserts
    `'nothing here is guessed'` and its implementation emits `'Nothing here is guessed. ...'`.
    The implementation is right (sentence-initial capital in user-facing copy); the test was
    changed to match.

## Where the API key guarantee actually lives

Recorded because it is stronger than the test and the next agent should not weaken it by
accident. The sentinel test in `app.test.ts` asserts by value across the endpoints it enumerates,
which is good but scales only with the routes someone remembers to list. The real guarantee is
structural:

- `config` is referenced in `packages/server/src/app.ts` in five places and **read exactly once**,
  as `config?.safety.mode` (line 411). No other route touches it.
- In `packages/server/src/registry.ts`, `config` reaches only `AgentSession.start`. It never
  enters `live.public`.
- Both new response schemas are `z.strictObject`, so serialization is a second gate behind
  key-by-key construction in `publicProfile()`.

If a future change makes `config` reachable from a new place, the sentinel test only catches it
if that route is in the list. Add the route to the list AND keep the single-read discipline.

## Traps hit this session

The part-3 trap list is still valid. These are new.

### The wrong-tree trap, orchestrator edition

Part 3 documents that SUBAGENTS get a fresh shell rooted at the main repo. The same thing bit the
orchestrator: the Bash tool's working directory was silently reset to
`/Users/vishal/work/personal/second-mind` between calls, and a full gate run reported
**Test Files 50 / Tests 812**, which is the design branch's baseline, not the worktree's. It was
caught only because that number was recognisable.

**Put an absolute `cd` in every gate command.** Do not rely on a `cd` from an earlier call. Echo
`pwd` in the same command if you want the evidence in front of you.

### `git commit -am` in the main repo swept up the human's ROADMAP.md

The status-board update was committed with `git commit -qam`, and `-a` staged the human's
unrelated uncommitted BUSL note along with it. Recovered with
`git reset --soft HEAD~1`, `git restore --staged ROADMAP.md`, recommit. Nothing was pushed.
**Stage the exact path.** The board update line that works is:

```bash
git add -- docs/superpowers/plans/<handoff>.md && git commit -qm "..."
```

### Fabricated commit hashes, twice

A hash was typed into the status board, and another into a subagent brief, before the commit had
been made or read back. Both were wrong and both had to be corrected.
`git show --stat HEAD` does not print the hash in its tail; use `git rev-parse --short HEAD`.

### A subagent stalled with no output and had to be re-dispatched

One Batch I dispatch died on a stream watchdog timeout after ~600s with no progress, having only
oriented itself. Nothing was lost, because briefs forbid committing: the worktree was clean and
no partial work existed. Re-dispatched as two smaller tasks (one per plan task) with an
instruction to read large plan sections in chunks, and both completed. If an agent stalls, check
the worktree with `git status --short` before assuming damage.

## Dispatching subagents: the workflow that works

**Model policy (from the human's global CLAUDE.md, binding):** pin `model` explicitly on EVERY
dispatch. Never omit it and rely on inheritance. `haiku` for mechanical and lookup work, `sonnet`
for implementation, `opus` only for the hardest judgement. Use `general-purpose` as the
`subagent_type` (`Explore` and `Plan` cannot write files). State the model per agent when
announcing a fan-out so the claim is checkable.

Every task in Batches H to M was one `sonnet` dispatch, except one `haiku` for a single focused
test addition. That ratio worked well.

The recipe:

1. **A shared standing preamble, written once to a file**, that every brief opens by `cat`-ing.
   It is the single biggest token saver. It lives in this repo only as the appendix of part 3:
   extract it with, and check the fence line first since edits shift it:
   ```bash
   grep -n '^```markdown' docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-3.md
   sed -n '<fence+1>,<lastline-1>p' docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-3.md > <scratchpad>/preamble.md
   ```
   **Change the worktree path inside it** when you move from the modes worktree to the journal one.
2. **A short task brief** pointing at the plan file and exact `sed -n 'A,Bp'` ranges. Never
   re-transcribe the plan's code. The one exception is where the plan is known-wrong: inline the
   correction and say plainly that it overrides the plan.
3. **State the starting test count in every brief.** It gives the agent a self-check and you a
   tripwire.
4. **Forbid committing.** The orchestrator verifies and commits. This is what made the stalled
   agent above a non-event.
5. **Require both `git status --short` outputs**, worktree and main repo.
6. **One logical unit per dispatch**, batched by shared files. Two plan tasks in one dispatch is
   fine when they share a file; more is not.
7. **Sequential, never parallel, within one worktree.**
8. **Tell it to write the failing test first and not backfill evidence**, and to report a
   falsification that cannot fail as a finding rather than a success.

## Safety handling

- A mode adjusts STYLE WITHIN the safety stance. A mode NEVER adjusts the safety stance.
- The modes safety batch (D: Tasks 7, 7A, 8) is DONE and was falsified by an orchestrator, not a
  subagent. Do not redo it. Do not reorder `buildPersona`'s sections: the mode paragraph goes
  BEFORE the crisis stance, because text after the crisis stance reads to the model as amending
  it.
- **The journal plan's Task 13 is a safety-invariant test. Falsify that one yourself.**
- Never let a subagent alter crisis or safety behaviour, or weaken companion/firewall. Every
  brief must say so explicitly.
- Nothing may change the safety mode over HTTP. `GET /api/v1/settings` reports it; there is no
  write route and the web settings pane renders it as plain text with no control.

## Environment facts you must not re-learn the hard way

- **Machine timezone is Asia/Calcutta (UTC+05:30).** CI is UTC. `T20:00:00Z` is the NEXT local day
  here. Pin UTC with the `pinTimezoneUtc(paths)` helper pattern INSIDE the date-sensitive `it`
  block, never in a shared `beforeEach`: a blanket pin breaks the "system default timezone" test
  in `packages/core/src/context.test.ts`.
- **Single-file test command is `npx vitest run <path>`** from the worktree root. The plans'
  `pnpm --filter openreverie test -- <path>` form fails with "No projects were found".
- **Cross-package imports resolve via `dist/`.** After any source change, `npx tsc -b` BEFORE
  running tests that import that package cross-package. Most common source of a lying failure.
- **Fresh worktrees have no `node_modules`.** `pnpm install` first.
- **biome line width is 100**, and its recommended preset flags unused variables. Remove dead
  symbols rather than suppressing. A parameter that a LATER task in the same batch will consume is
  the one acceptable temporary warning; it must be gone by the end of the batch.
- **`exactOptionalPropertyTypes` is on.** Never write `{ key: undefined }`. Use
  `...(value !== undefined ? { key: value } : {})`. zod 4 has `.exactOptional()`.
- **`noUncheckedIndexedAccess` is on.** Narrow every array index and `.find()` result. Note this
  interacts with falsification quality: a test that indexes `arr[0]` directly fails with
  "the given combination of arguments (undefined and string) is invalid for this assertion"
  instead of a readable diff. Assert the length first.
- **`.claude/` is gitignored and committed as such.** Do not reintroduce a non-ignored scratch
  directory; unignored worktree dirs break biome.
- Node v22.22.0, pnpm 10.8.1. Gate order is always `pnpm lint && pnpm build && pnpm test`.

## When to stop and ask the human

- A plan task references a symbol that does not exist and is not created by an earlier task, and
  the correct fix is not one of the documented drifts above.
- Two plans contradict each other.
- A test genuinely cannot be made to fail before the implementation exists.
- A change requires an upward import across a package boundary.
- Anything touches crisis handling or safety modes in a way the plan did not already specify.
- A fix would widen scope beyond the plan, like deferred item 2.
- The same task fails three times.

## About this document

Keep it current. Mark a task ONGOING in the status board *before* dispatching it, and fill in its
verified commit hash as soon as you have committed it. If you run out of session, the next agent's
first action is reading the status board and the START HERE section, so those two must always
describe reality.
