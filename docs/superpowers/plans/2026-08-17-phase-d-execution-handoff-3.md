# Phase D execution handoff, part 3

This document is the complete brief for an orchestrating agent resuming Phase D after the
second orchestrator ran out of session budget. Read it fully, then read `AGENTS.md` fully,
before doing anything. `AGENTS.md` is binding; this document is your resume state.

It supersedes `2026-08-17-phase-d-execution-handoff-2.md` for status. That earlier document is
still worth reading once for its pitfall list, which remains accurate and is summarized here.

## Your role

You are an orchestrator. You plan, decompose, dispatch, verify, and merge. You do not write
implementation code yourself. You dispatch subagents to write it, then you verify by running
the lint, the build, and the tests yourself.

The single most important rule, repeated because agents break it: **a subagent's report that
the tests pass is not evidence that the tests pass.** Run `pnpm lint`, `pnpm build`, and
`pnpm test` yourself after every task or batch and read the real output.

Second most important, learned again in this session: **`git show --stat` every commit you
make.** A commit that lands implementation without its tests looks fine in `git log` and is a
serious defect. See "The commit-splitting trap" below.

## STATUS BOARD, the thing to read first

Update this table as you go. Mark a task ONGOING *before* you dispatch it, so the next agent
knows what to verify rather than assume.

### Retrieval plan (`2026-08-17-context-and-retrieval-plan.md`), 19 tasks

| Task | State | Commit |
| --- | --- | --- |
| 1-9 | DONE (previous session) | `345b4fa` `ec1469d` `ec2c52a` `d792d8f` `492e2b3` `4631522` `714aebb` `76d8089` `f89a001` |
| 10 `list_people`/`list_entities` tools | DONE | `dd68212` |
| 11 node lane in `search_memory` | DONE | `3359402` |
| 12 search-lane descriptions | DONE | `9c037c7` |
| 13 truncation markers name their tool | DONE | `d1f4cf6` |
| 14 prompt budget module | DONE | `61cdc25` |
| 15 apply budget to capped sections | DONE | `0ac3459` |
| 16 reflection gets full constitution | DONE | `a3c0840` |
| (extra) arcs marker on character cap | DONE | `fa95c0e` |
| 17 weekly rollup shelf | DONE | `e0c8bbd` |
| 18 DocKind wiring test (P8) | DONE | `a8c523d` |
| (extra) rollup escape-hatch row must never be capped away | DONE | `6c82ce5` |
| 19 final verification + README | DONE | `17dd15e` |
| **retrieval merged into design** | DONE | merge `a0bd482`, worktree removed |

### Watch item carried forward from modes Batch B

`profileUpdatesSchema` is a strict object with no nullable field, so a reflection reply
containing `"profileUpdates": {"timezone": null}` fails the WHOLE reflection parse and degrades
the session to summary only. The prompt paragraph that used to instruct the model to null an
unchanged timezone was removed in `e0277e7` so the prompt and the schema now agree, and the
RESPONSE_SHAPE line advertises plain string types. This is the plan's design (Task 3 authored the
schema strict and non-nullable, and its tests pin that), so it was not changed. But models emit
`null` for "nothing to report" all the time. If reflection starts degrading to summary in real
use, this is the first place to look. Fixing it would mean either accepting and dropping nulls in
the schema, or adding an explicit "omit a key you have nothing for" line to the prompt.

### Modes plan (`2026-08-17-modes-profile-settings-plan.md`), 24 tasks

Worktree `.claude/worktrees/modes`, branch `feat/phase-d-modes`. Design was merged in and
`pnpm install` re-run. **Task 0 gate is fully passed, all six steps**, baseline
Test Files 50 / Tests 812. Do not re-run Task 0.

Batching below is by shared files, derived from every task's `**Files**` block. Run them
SEQUENTIALLY in the one worktree: two agents running `npx tsc -b` against the same `dist/` will
read each other's half-written build output.

| Batch | Tasks | Shared files | Model | State | Commits |
| --- | --- | --- | --- | --- | --- |
| A | 1, 2, 3 | `memory/style.ts` (new), `memory/profile.ts`, `core/config.ts` | sonnet | DONE, 841 tests | `351092e` `d0e8015` `efa565b` |
| B | 4, 5 | `memory/engine.ts`, `core/tools.ts`, `memory/reflection.ts` | sonnet | DONE, 858 tests | `0db42b1` `e0277e7` |
| C | 6 | `core/modes.ts` (new catalogue) | sonnet | DONE, 867 tests | `9b091df` |
| D | 7, 7A, 8 | `core/personas.ts` **SAFETY** | sonnet impl, orchestrator falsified | DONE, 884 tests | `bc2530c` (combined, shared file) |
| E | 9 | `core/context.ts` profile block, 2000 char cap | sonnet | DONE, 897 tests | `8087dab` |
| F | 10, 11 | `memory/transcripts.ts`, `memory/engine.ts` | sonnet | DONE, 912 tests | `63bda62` (combined, shared test block) |
| G | 12 | `set_mode` replaces `update_style`, tools/agent/cli | sonnet | **ONGOING** | |
| H | 13 | style leaves `config.toml`, migration plus 9 fixtures | sonnet | TODO | |
| I | 14, 15 | `cli/commands.ts`, the `/mode` `/style` `/settings` `/whoami` table | sonnet | TODO | |
| J | 16 | persistent status line, `cli/strip.ts` | sonnet | TODO | |
| K | 17, 18 | `server/registry.ts`, `web/api.ts`, mode stream event and mode over HTTP | sonnet | TODO | |
| L | 19 | profile/settings endpoints, **the API key that must never be reachable** | sonnet impl, **you verify the key test** | TODO | |
| M | 20, 21 | `web/views/*` journal and settings destinations, mode picker | sonnet | TODO | |
| N | 22 | README | **you, personally** | TODO | |

Batch D is the safety batch: Task 7 (stance doctrine), Task 7A (the one identity sentence the
model may narrate), Task 8 (mode overlay plus the safety invariant). Do the falsification of
every safety-related assertion yourself. Batch L exposes profile and settings over HTTP and must
never make the provider API key reachable; verify that test yourself too.

### All five Phase D epochs, and what is left

Phase D is five plans, not one. The original brief for the whole phase is
`docs/superpowers/plans/2026-08-17-execution-handoff.md`; read its "The five plans" section
once for the original intent. Every plan names its spec in its own header, and the specs live
in `docs/superpowers/specs/` dated `2026-08-16`. Read the spec alongside the plan whenever a
task's intent is unclear.

**Phase D is not finished until all five have shipped and merged into `feat/phase-d-design`,
and design has merged to `main`.** Two of the five are done. One is nearly done. Two have not
been started.

| # | Epoch | What it is | Tasks | Depends on | State |
| --- | --- | --- | --- | --- | --- |
| 1 | **cli-polish** `2026-08-17-cli-polish-and-ci-fix-plan.md` | Terminal UX cleanup and the CI fix. Independent of everything else. | 10 | nothing | **DONE**, merged into design (verified) |
| 2 | **time** `2026-08-17-time-as-first-class-plan.md` | Local time as a first class fact: `profile.md` holds the timezone, messages are stamped in local time, session dates and daily/weekly rollups use the local calendar day instead of UTC. Shipped the `reverie migrate` subcommand and the migration registry. | 23 | nothing | **DONE**, merged into design |
| 3 | **retrieval (DONE)** `2026-08-17-context-and-retrieval-plan.md` | Close the loop where the prompt says more exists but gives no way to reach it. Node listing tools, a graph-node search lane, truncation markers that name their tool and carry a docId, and a hard per-section character budget for the prompt. | 19 | time (one fix only) | **COMPLETE**, all 19 tasks plus two extra defect fixes. Merged into design as `a0bd482` |
| 4 | **modes** `2026-08-17-modes-profile-settings-plan.md` | Conversation modes, the profile's personal fields, and settings. Moves `StyleConfig` down into memory, adds the mode catalogue and the mode overlay in the persona, replaces `update_style` with `set_mode`, takes style out of `config.toml`, adds a CLI command table with `/mode` `/style` `/settings` `/whoami`, a persistent status line, the `mode` stream event, session mode over HTTP, profile and settings endpoints, and two new web destinations. | 24 (Task 0, Tasks 1-22, plus Task 7A) | time | **NOT STARTED.** Worktree exists and `pnpm install` is done. Task 0 steps 1-5 verified this session, step 6 still to run |
| 5 | **journal** `2026-08-17-journal-mode-plan.md` | Journaling as its own mode: a `journal/` document kind, entry assembly from a transcript, six journaling methods, `journaling.md` protocol read/write, the `update_journaling_protocol` tool, reflection's `journalingUpdate` backstop, server and web wiring, and a safety invariant test. | 16 | time, modes | **NOT STARTED.** No worktree yet |

Merge state verified this session with `git merge-base --is-ancestor`: both
`feat/phase-d-cli-polish` and `feat/phase-d-time` are ancestors of `feat/phase-d-design`, and
`git log feat/phase-d-design..feat/phase-d-cli-polish` is empty. Those two branches still exist
but carry nothing unmerged; they can be deleted whenever the human wants. Do not delete them on
your own initiative.

Dependency graph, from the original brief:

```
cli-polish            independent                      DONE
time                  before modes and journal         DONE
  modes               before journal                   NOT STARTED
    journal                                            NOT STARTED
  retrieval           needs only the sessionId fix     17/19
```

So the remaining critical path is: **finish retrieval, merge it, then modes, merge it, then
journal, merge it, then design to main.** modes is the long pole at 24 tasks, and journal at 16
cannot start until modes is merged.

### Worktree conventions for the two plans not yet started

The established pattern, one worktree per plan branched from `feat/phase-d-design`:

```bash
git worktree add .claude/worktrees/<plan-name> -b feat/phase-d-<plan-name> feat/phase-d-design
```

The modes worktree already exists but predates retrieval; see "Merge order" below before using
it. The journal worktree does not exist yet and must be branched from design **after** modes has
merged into design, not before.

Merge a worktree back into design only after the whole plan is complete and you have personally
run `pnpm lint`, `pnpm build` and `pnpm test` in it. Run the full gate again on design after the
merge, because a merge can break what neither branch broke alone. Then
`git worktree remove .claude/worktrees/<plan-name>`.

## VERIFY THE ONGOING WORK BEFORE YOU CONTINUE

Retrieval Tasks 17 and 18 were dispatched to one subagent and the session ended before the
result could be verified. **Do not assume they landed, and do not assume they did not.**

Run this first, in `/Users/vishal/work/personal/second-mind/.claude/worktrees/retrieval`:

```bash
git log --oneline -3          # is fa95c0e still HEAD? then nothing was committed
git status --short            # uncommitted work from the agent?
pnpm lint && pnpm build && pnpm test
```

Three possible worlds:

1. **HEAD is `fa95c0e` and the tree is clean.** The agent produced nothing usable. Re-dispatch
   Tasks 17 and 18 from scratch using the brief recipe below.
2. **HEAD is `fa95c0e` and the tree is dirty.** The agent did work but nothing was committed
   (correct: subagents are instructed never to commit). Verify it yourself: run the full gate,
   check `git diff --stat` shows only the files Tasks 17/18 name, grep the diff for parked tests
   (`\.skip\(|\.only\(|\.todo\(`), then falsify at least one new assertion per task yourself
   before committing. Expected files: Task 17 touches `packages/memory/src/engine.ts`,
   `packages/core/src/context.ts`, `packages/core/src/context.test.ts`. Task 18 touches
   `packages/memory/src/sqlite.ts` and CREATES `packages/core/src/docKinds.test.ts`.
   Commit messages are in the plan; see "exact commit messages" below.
3. **HEAD is past `fa95c0e`.** Somebody committed. Verify with `git show --stat` on each new
   commit that tests landed alongside implementation, then run the full gate.

**Baseline test count at `fa95c0e` is: Test Files 49 passed (49) / Tests 806 passed (806).**
Tasks 17 and 18 must RAISE that number. A flat or falling count means tests were parked or
deleted. That is the failure mode this repo has been bitten by repeatedly.

## VERIFY THE ONGOING MODES BATCH BEFORE YOU CONTINUE

Modes Batch G (Task 12, `set_mode` replaces `update_style`) was dispatched and the session may
have ended before it was verified. In `.claude/worktrees/modes`:

```bash
git log --oneline -3     # tip should be 63bda62 if nothing was committed
git status --short       # uncommitted agent work?
pnpm lint && pnpm build && pnpm test
```

Baseline before Batch G is **Test Files 53 / Tests 912** at `63bda62`. Batch G must raise that.
Expected files: `packages/core/src/tools.ts`, `tools.test.ts`, `packages/core/src/agent.ts`,
`agent.test.ts`, `packages/cli/src/chat.ts`, `chat.test.ts`, `packages/cli/src/index.ts`,
`packages/cli/src/setup.ts`.

**Task 12 retires `update_style`.** When it does, the write-through added to `agent.ts` in
`8087dab` (`await this.engine.updateProfileSettings({ style: resultData.style })`) should
disappear with it. If Task 12 leaves `update_style` in place, that line must stay or the prompt
stops seeing style changes. Check which happened before accepting the batch.
Note the tool count in `tools.test.ts` is currently ELEVEN; replacing `update_style` with
`set_mode` keeps it at eleven, but confirm rather than assume.

### Two things Batch E settled that later batches depend on

1. **The prompt now reads style from `engine.currentStyle()` (the profile), not `config.style`.**
   That broke `agent.test.ts`'s update_style reassembly test, because `update_style` still writes
   `config.toml` through its persister. Fixed in `8087dab` with a one-line write-through in
   `packages/core/src/agent.ts` calling `engine.updateProfileSettings({ style })`. Task 12
   retires `update_style` and Task 13 takes style out of `config.toml`; when you do those, this
   write-through is the line that should disappear, and the double write with it.
2. **`capBody` must NOT be used for the profile body.** `profile.md` is unindexed by design:
   `walkAllDocuments` never includes `paths.profile`, so it has no docId, and `capBody`'s marker
   names a `read_document` call that could not work. `budget.ts` documents this above
   `PROFILE_BODY_CAP`. The profile section uses a local slice plus a plain marker instead. The
   orchestrator initially instructed the subagent to use `capBody` here and was wrong; the
   subagent pushed back with evidence and was right.

### The safety batch is DONE and was falsified by the orchestrator, not a subagent

Batch D (Tasks 7, 7A, 8) landed as `bc2530c`. Recorded here so nobody redoes it or assumes it
was taken on trust:

- All five crisis symbols were verified byte-identical to their pre-batch state by extracting
  each template literal and comparing md5: `CRISIS_DETECTION`, `COMPANION_CRISIS_STANCE`,
  `FIREWALL_CRISIS_STANCE`, `crisisSection`, `renderResources`.
- Task 8 step 9 was performed by the orchestrator: moving `crisisSection(mode, resources)` above
  `modeSection(activeMode)` in `buildPersona`'s section list fails the invariant with
  `companion/listen position: expected false to be true`.
- A second, independent falsification was run: keeping crisis last but letting an active mode
  append text to it also fails. So the test discriminates on both halves, position and bytes,
  not just on presence.
- `buildPersona` now carries a comment saying why the ordering matters. Do not reorder those
  sections. The mode paragraph goes BEFORE the crisis stance, never after: text after the crisis
  stance reads to the model as amending it.

Commit messages: the plan gives one per task at the end of each task's step list. Get them with
`grep -n 'git commit -m' <plan>` and read the following lines; they are multi-line messages.

## FIXED: the rollup escape-hatch row could be capped away

Found, verified and fixed this session in `6c82ce5`, after Task 17 was committed at `e0c8bbd`.
Recorded here because the reasoning matters and the same pattern may exist elsewhere.

`rollupsAvailableSection` in `packages/core/src/context.ts` builds up to four rows and passes
ALL of them through `capRows(lines, ROLLUPS_AVAILABLE_CAP)` where the cap is 800. The last row
is the escape hatch:

```
Read any of these with read_document, or find one by period with search_memory using kinds and a date range.
```

Measured directly with `node`, using 12 weekly rollups at the real 27-character docId shape:

| Daily rollup total | Rows kept | Characters |
| --- | --- | --- |
| 1 day | 4 of 4 | 800 of 800 |
| 2 days | **3 of 4** | 692 of 800 |
| 365 days | **3 of 4** | 694 of 800 |

The escape-hatch row survives only in the single case of exactly one daily rollup, where it
lands at exactly 800/800 with zero margin. For any real user with 12 weekly rollups and more
than one daily rollup, the row is silently dropped: the model is shown a shelf of rollup docIds
and never told that `read_document` is what takes them off it. That is the same P1 defect class
this whole release exists to remove, reintroduced by capping the escape hatch alongside the data.

The existing Task 17 test does not catch it because it uses a smaller fixture.

**The fix applied**: cap only the DATA rows, then always append the instructional row after
`capRows`. The instruction is not data competing for budget; it is the thing that makes the data
reachable, and it must never be the row that loses. A test with 12 weekly rollups and 2 daily
rollups now asserts the `read_document` sentence is present, and it was falsified by moving the
row back inside the `capRows` input and confirming it fails.

**Watch for the same pattern elsewhere.** Any section that passes its own escape-hatch text
through `capRows` alongside its data has this bug latent in it. The other sections currently
append their markers after building rows, so they are fine today, but the modes and journal plans
both add new prompt sections and could reintroduce it.

Do NOT fix this by raising `ROLLUPS_AVAILABLE_CAP`. `packages/core/src/budget.test.ts` asserts
that the sum of `SECTION_CAPS` stays under `PROMPT_BUDGET_TOTAL`, and the sum is already 27,800
of 28,000. Raising the cap buys a little headroom and leaves the same bug one longer docId away.

## Repository and exact git state

- Path: `/Users/vishal/work/personal/second-mind`
- Project: openreverie, a self-hosted companion agent for reflection with a layered memory.
  Six TypeScript packages, pnpm workspace. Node v22.22.0, pnpm 10.8.1.
- Commands: `pnpm lint`, `pnpm build`, `pnpm test` from a worktree root. One test file:
  `npx vitest run <path>`. Gate order is always `pnpm lint && pnpm build && pnpm test`.

Worktrees live inside the main repo at `.claude/worktrees/` (gitignored):

| Path | Branch | HEAD at handoff time | State |
| --- | --- | --- | --- |
| `/Users/vishal/work/personal/second-mind` | `feat/phase-d-design` | tip = the commit adding this file | ` M ROADMAP.md` only |
| `.claude/worktrees/retrieval` | `feat/phase-d-retrieval` | `fa95c0e` | see "verify the ongoing work" |
| `.claude/worktrees/modes` | `feat/phase-d-modes` | `6016eb6` | clean, `pnpm install` DONE, not started |

`ROADMAP.md` on design has an uncommitted edit by the human (a note about moving to BUSL-1.1
licensing). It is unrelated to Phase D and no plan touches it. **Leave it alone.** It does not
block any merge. Do not commit it, do not stash it, do not "tidy" it.

## Exact commit messages for the remaining retrieval tasks

From the plan, use verbatim:

- Task 17: `Preload a compact weekly rollup index with docIds, never the bodies`
- Task 18: `Add the table-driven DocKind wiring test and a runtime DOC_KINDS list`

## What to do next, in order

1. Verify/finish retrieval Tasks 17 and 18 as described above.
2. Retrieval Task 19: run `pnpm lint`, `pnpm build`, `pnpm test` yourself from a clean tree.
   Then update the README Status section honestly for what the retrieval release actually
   changed (see "README" below). Commit that.
3. Merge retrieval into design:
   ```bash
   cd /Users/vishal/work/personal/second-mind
   git merge feat/phase-d-retrieval        # a regular merge, NOT --ff-only
   pnpm lint && pnpm build && pnpm test    # run the gate again on design after the merge
   git worktree remove .claude/worktrees/retrieval
   ```
   A regular merge is required because design carries two handoff-doc commits beyond the time merge
   (`a466123` part 2, and the commit that added this file, part 3).
4. **Before starting modes, merge design into `feat/phase-d-modes`.** This was decided this
   session and is important, see "Merge order" below. Then re-run `pnpm install` in that
   worktree (the merge can move `package.json`/the lockfile), then run the modes plan's Task 0
   gate including its step 6 green baseline.
5. Run the modes plan. Decompose into file-sharing batches, dispatch, verify, and do the safety
   falsification yourself for Tasks 7, 7A and 8.
6. After modes merges into design, create `.claude/worktrees/journal` branched from the
   modes-merged design and run the journal plan. Its Task 13 safety-invariant falsification
   (six combinations, position plus bytes) is yours, never a subagent's.
7. Update the README honestly after each plan ships. The Status section must never overstate.
8. When all five epochs have merged into `feat/phase-d-design` and the full gate is green there,
   Phase D is complete. Merging `feat/phase-d-design` into `main` and cutting a release is the
   human's call, not yours: raise it and wait. `main` is currently at `e72377b`
   (the v0.5.0 merge), so design is a long way ahead of it and that merge deserves a human eye.

Note the ordering constraint that makes this sequential rather than parallel: journal depends on
modes, and modes depends on time (done). retrieval and modes could in principle have run in
parallel, but retrieval is nearly finished and modes has not started, so just finish retrieval
first and take its merged result into modes.

## Merge order: why modes must take design first

`feat/phase-d-modes` sits at `6016eb6`, which predates all of retrieval. Both plans rewrite the
same code:

- retrieval Task 15 rewrites `packages/core/src/context.ts`'s prompt assembly and adds many
  fields to `SessionContext` in `packages/memory/src/engine.ts`.
- modes Task 9 inserts a `## Profile` block into that same assembled prompt, with its own
  2,000 character cap.

Building modes on the stale base guarantees a large, ugly conflict in exactly the code
retrieval just rewrote. Merging design into modes first turns that into one controlled merge
before any modes work starts, and lets modes build against the final shapes. Do this.

## Modes plan: verified drift, do not re-derive

All of these were confirmed by grep against the real tree this session. A ready-made brief for
subagents is at `scratchpad/modes-drift.md` (regenerate it from this section if the scratchpad
is gone; it is a temp dir and will not survive).

1. **`saveProfile` does not exist. Use `writeProfile`.**
   `packages/memory/src/profile.ts:95` exports `writeProfile(paths, profile): Promise<void>`.
   `loadProfile(paths): Promise<Profile>` at `:68` is named as the plan expects.
   The plan writes `saveProfile` in Tasks 4, 5, 15, 19 and elsewhere. Every one means
   `writeProfile`.
2. **`MigrationResult` in the plan is wrong.** Real shape, `packages/memory/src/migrations/index.ts:28`:
   `{ id: string; applied: boolean; summary: string; details: string[] }`.
   The plan shows `{ changed: boolean; messages: string[] }`. Use the real shape. The
   `reverie migrate` CLI already ships and prints `summary` then `details` one per line, so the
   `style-to-profile` migration must return those fields. `MigrationContext` is
   `{ paths, configPath }`, as the plan expects. `migrations` already holds
   `profileSeedMigration` and `utcToLocalRollupsMigration`.
3. **`currentProfile()` does not exist. The accessor is `profile()`.**
   `packages/memory/src/engine.ts:291` `profile(): Profile`. The private cached field is
   `profileCache` (`:221`), not `profile`. `updateProfile(patch)` exists at `:314` and currently
   accepts only `{ timezone?: string }`. `timezone()` and `timezoneSource()` already exist.
   The plan's own Task 0 step 4 says to use an existing accessor under its real name.
4. **`Profile.body` is correct** (`profile.ts:33`). The plan offers `prose` as an alternative:
   do NOT substitute. Note `meta` is `ProfileMeta & { [key: string]: unknown }`.
5. **The plan's command table is stale.** Use `npx vitest run <path>` for one file, and
   `npx biome check --write .` then `npx biome check .` for format plus safe fixes. `pnpm format`
   only runs the formatter, not the linter's fixes.

The modes plan's Task 0 is a verification gate whose greps will report `writeProfile` where it
expects `saveProfile`. That is drift 1, not a missing symbol. Read Task 0's intent, not its
literal symbol names. Steps 1-5 of Task 0 are already verified as above; only step 6 (the green
baseline) still needs running, and it must be run AFTER merging design into modes.

## Safety handling (critical, read carefully)

- Retrieval Tasks 17-19 do NOT touch safety modes or crisis behavior. Falsification there may be
  delegated.
- The modes plan DOES: Task 7 (stance doctrine), Task 7A (identity-fact sentence) and Task 8
  (mode overlay plus safety invariant), all in `packages/core/src/personas.ts` and its tests.
  For those, **do the falsification yourself, never delegate it.**
- The journal plan's Task 13 is a safety-invariant test (six combinations, position plus bytes).
  **Falsify that one yourself too.**
- A mode adjusts STYLE WITHIN the safety stance. A mode NEVER adjusts the safety stance.
- Never let a subagent alter crisis or safety behavior, or weaken companion/firewall. Every
  subagent brief must say so explicitly.

## Dispatching subagents: the workflow that worked this session

The previous handoff used `opencode run -m deepseek/deepseek-v4-pro`. This session used the
Agent tool instead, with an explicitly pinned model on every dispatch. Both work. The Agent tool
approach is written up here because it is what produced the commits above.

**Model policy (from the human's global CLAUDE.md, binding):** pin `model` explicitly on EVERY
dispatch. Never omit it and rely on inheritance. `haiku` for mechanical/transcription work,
`sonnet` for implementation, `opus` only for the hardest judgment. Use `general-purpose` as the
`subagent_type` (`Explore` and `Plan` cannot write files). When announcing a fan-out, state the
model per agent so the claim is checkable.

What each dispatch actually looked like:

1. **A shared standing preamble, written once to a file**, that every brief opens by `cat`-ing.
   This is the single biggest token saver: the ~900-token preamble is written once, not per
   dispatch. Recreate it if the scratchpad is gone; its contents are listed under "The standing
   preamble" below.
2. **A short task-specific brief** that points at the plan file and exact `sed -n 'A,Bp'` line
   ranges. Never re-transcribe the plan's code blocks; the plan is in the worktree and is the
   verbatim source. The ONE exception is where the plan is known-wrong: then inline the
   correction and say plainly that it overrides the plan.
3. **State the starting test count in every brief** ("green at 806 tests; your batch should
   raise that, never lower it"). This gives the agent a self-check and gives you a tripwire.
4. **Forbid committing.** The plan's last step per task says to commit. Every brief must
   override that: the orchestrator verifies and commits. Otherwise a subagent commits a state
   you later find broken and you are unwinding history.
5. **Require both `git status --short` outputs in the report**, for the worktree AND for the
   main repo. The main repo must show only ` M ROADMAP.md`. See "the wrong-tree trap" below.
6. **One logical unit per dispatch.** Batch tasks that share files, so context is reused. Never
   hand a whole plan to one subagent.
7. **Sequential, not parallel, within one worktree.** Two agents running `npx tsc -b` against
   the same `dist/` at once will read each other's half-written build output.

### The standing preamble (recreate at `<scratchpad>/preamble.md`)

Contents, in this order: the absolute worktree path and an instruction to `cd` there first and
use absolute paths everywhere; what the project is and the downward-only package dependency
rule; the writing style rules (no em dashes, no AI tropes, plain and concrete, honesty over
polish); the TDD method (RED, GREEN, then the plan's falsify step, with "reading the code is not
falsifying"); the TypeScript settings that bite (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, cross-package imports resolving through `dist/`); the environment
facts (Asia/Calcutta timezone, `npx vitest run` as the single-file command, biome line width
100); the gate order `npx tsc -b` then `npx vitest run` then `npx biome check --write .` then
`npx biome check .`; "do NOT commit"; the stop-and-report conditions; and the required report
format ending in both `git status --short` outputs.

## Traps hit this session (these are new; the part-2 list is still valid too)

### The wrong-tree trap

Agent-tool subagents do NOT inherit your Bash cwd. They get a fresh shell rooted at
`/Users/vishal/work/personal/second-mind`, which is `feat/phase-d-design`. A brief that says
"modify `packages/core/src/tools.ts`" will edit the DESIGN branch. Every brief must name the
absolute worktree path, instruct `cd` there first, and end by printing the main repo's
`git status --short` so you can catch it. `isolation: "worktree"` does not help; it creates a
new throwaway worktree, which is not what you want.

### The commit-splitting trap (cost real time this session)

`git diff` merges ADJACENT changes into a single hunk. A new test inserted next to another
task's new tests becomes inseparable from it by hunk. Reverse-applying "your" hunk silently
reverted 248 lines of the other task's tests, `git add` then staged nothing, and the resulting
commit contained implementation with no tests. `git log` looked fine.

Mitigations: **always `git show --stat` after committing** and confirm test files are present
alongside source files. If you must split commits within a file, separate by text (locate the
block by a unique string and slice it out) rather than by hunk. Nothing was pushed, so
`git reset --soft HEAD~N` and rebuilding the commits is a safe recovery.

### Plan arithmetic is not trustworthy

Task 14's test asserted a fixture length of 114 characters. The fixture
(`'a'.repeat(40) + '\n\n' + 'b'.repeat(40)` head, `'THE SENTINEL PARAGRAPH'` tail, joined by
`'\n\n'`) is 40+2+40+2+22 = **106**. Recompute assertions like this in `node` rather than
accept either the plan's number or an agent's claim about it. The kept-length figure (82) was
correct; only the total was wrong.

### A real defect found in the plan's shipped code

`arcsSection` in `packages/core/src/context.ts` gated its truncation marker on
`context.arcsTruncated` alone, which is the ROW cap (30 arcs). It ignored the CHARACTER cap
(`ARCS_SECTION_CAP = 2000`). A user with 20 long-named arcs would have arcs silently dropped
from the prompt with no marker at all: the exact "shelf the model cannot take anything off"
defect this release exists to remove. Fixed in `fa95c0e` to
`context.arcsTruncated || capped.shown < lines.length`, matching `peopleSection` and
`entitiesSection`, with a test that was confirmed to fail without the fix.

Watch for the same pattern elsewhere: a section that caps rows two different ways but only
reports one of them.

### Task 16's falsify step as written is impossible

The plan says to falsify by "applying the cap to `buildReflectionContext`". You cannot: `capBody`
lives in `@openreverie/core` and `memory` cannot import upward. That architecture wall is the
very thing Task 16 pins. Falsify instead by inlining a raw `.slice()` on the constitution body
in `buildReflectionContext`. Both directions were checked this session:
`.slice(0, 6000)` fails the body assertion, and `.slice(0, 12000)` (which keeps the bulk and
drops only the tail) fails the sentinel assertion independently. Restore the file afterward and
confirm with `git diff --stat`.

## Environment facts you must not re-learn the hard way

- **Machine timezone is Asia/Calcutta (UTC+05:30).** CI is UTC. `T20:00:00Z` is the NEXT local
  day here. Date-sensitive tests pin UTC with the `pinTimezoneUtc(paths)` helper pattern in
  `packages/memory/src/engine.test.ts`. Pin it INSIDE the date-sensitive `it` block, never in a
  shared `beforeEach`: a blanket pin breaks the "system default timezone" test in
  `packages/core/src/context.test.ts`.
- **The single-file test command is `npx vitest run <path>` from the worktree root.** The plans'
  `pnpm --filter openreverie test -- <path>` form fails with "No projects were found".
- **Cross-package imports resolve via `dist/`** (each package's `main` is `dist/index.js`).
  After any source change in a package, run `npx tsc -b` BEFORE running tests that import that
  package cross-package. This is the single most common source of a failure message that lies.
- **Fresh worktrees have no `node_modules`.** `pnpm install` first. The modes worktree has
  already had this done, but re-run it after merging design in.
- **biome line width is 100**, and its recommended preset flags unused variables. Remove dead
  symbols rather than suppressing. End every task with `npx biome check --write .` then
  `npx biome check .` (must report "No fixes applied").
- **`exactOptionalPropertyTypes` is on.** Never write `{ key: undefined }`. Use
  `...(value !== undefined ? { key: value } : {})`. zod 4 has `.exactOptional()`.
- **`noUncheckedIndexedAccess` is on.** Narrow every array index and `.find()` result.
- **`.claude/` is gitignored and committed as such.** Do not reintroduce a non-ignored scratch
  directory; unignored worktree dirs break biome.

## README

`AGENTS.md` requires the README Status section to reflect reality at all times, and treats
overstatement as a serious defect. Nothing in the README has been updated for the retrieval work
yet. When retrieval ships, the Status section should honestly reflect that the model can now
reach past the prompt's caps: `list_people` and `list_entities` page through nodes the prompt
only shows the newest of, `search_memory` returns a second lane of graph-node hits beside
document hits, every truncation marker now names the tool that fetches the rest and carries a
docId where one exists, and the prompt has a hard character budget per section. Do not claim
anything beyond what the code does.

## When to stop and ask the human (do not work around)

- A plan task references a symbol that does not exist and is not created by an earlier task, and
  the correct fix is not one of the documented drifts above.
- Two plans contradict each other.
- A test genuinely cannot be made to fail before the implementation exists.
- A change requires an upward import across a package boundary.
- Anything touches crisis handling or safety modes in a way the plan did not already specify.
- The same task fails three times.

## About this document

Keep it current. Mark a task ONGOING in the status board *before* dispatching it, and fill in
its commit hash as soon as you have verified and committed it. If you run out of session, the
next agent's first action is reading the status board and the "verify the ongoing work" section,
so those two must always describe reality.
