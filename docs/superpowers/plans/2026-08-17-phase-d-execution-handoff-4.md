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

## START HERE: nothing is in flight, the tree is green

The previous orchestrator stopped at a clean boundary after finishing modes Batch M.
**There is no ONGOING work to verify.** Modes Batches A through M (Tasks 0 to 21) are DONE,
committed, and gated.

Confirm the starting state:

```bash
cd /Users/vishal/work/personal/second-mind/.claude/worktrees/modes
git log --oneline -1        # expect 5e40167 "Add journal and settings destinations, and a mode picker"
git status --short          # expect empty
pnpm lint && pnpm build && pnpm test
```

Expected: lint 0, build 0, test 0, **Test Files 57 passed (57) / Tests 1018 passed (1018)**.

The main repo at `/Users/vishal/work/personal/second-mind` is on `feat/phase-d-design` and should
show only ` M ROADMAP.md`, which is the human's own uncommitted note about BUSL-1.1 licensing.
**Leave it alone.** Do not commit it, do not stash it, do not tidy it. Never use `git commit -am`
in the main repo; it sweeps that file up. Stage the exact path you mean.

If any of that does not match, work out what moved before continuing.

**Your next action is modes Batch N, Task 22, the README. Do it personally, not via a subagent.**
`AGENTS.md` treats an overstated Status section as a serious defect, not a cosmetic one. Read
`sed -n '6986,$p' docs/superpowers/plans/2026-08-17-modes-profile-settings-plan.md`. Then merge
modes into design. Then start the journal epoch.

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
| 4 | **modes** `2026-08-17-modes-profile-settings-plan.md` | 24 | time | **22 of 24 done.** Only Task 22 (README) left, then the merge |
| 5 | **journal** `2026-08-17-journal-mode-plan.md` | 16 | time, modes | **NOT STARTED.** No worktree yet |

Phase D is not finished until all five have shipped and merged into `feat/phase-d-design`, and
design has merged to `main`. Merging design into `main` and cutting a release is the human's call:
raise it and wait. `main` is at `e72377b` (v0.5.0) and is a long way behind.

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
| N | 22 | README | **NEXT, not started** | |

Seventeen commits sit on `feat/phase-d-modes` ahead of `feat/phase-d-design`.

## What to do next, in order

1. **Batch N, Task 22, the README. Personally.** The Status section must reflect reality. What
   modes actually shipped: conversation modes with a ten-mode catalogue and a persona overlay;
   the personal profile fields; `set_mode` replacing `update_style`; style out of `config.toml`
   and into `profile.md` with a `reverie migrate` path; a CLI command table with `/mode`,
   `/style`, `/settings`, `/whoami`, `/help` and `/bye`; a persistent CLI status strip; a `mode`
   stream event; session mode over HTTP; profile and settings endpoints; and two new web
   destinations plus a mode picker. Claim nothing beyond that. Note honestly that the journal
   destination is a placeholder whose contents the journal epoch replaces.

2. **Clear the deferred items below that you judge blocking.** At minimum, read all of them.

3. **Merge modes into design:**
   ```bash
   cd /Users/vishal/work/personal/second-mind
   git merge feat/phase-d-modes        # regular merge, NOT --ff-only
   pnpm lint && pnpm build && pnpm test
   git worktree remove .claude/worktrees/modes
   ```
   Run the full gate again on design after the merge, because a merge can break what neither
   branch broke alone.

4. **Then journal.** Create the worktree from the modes-merged design, NOT before:
   ```bash
   git worktree add .claude/worktrees/journal -b feat/phase-d-journal feat/phase-d-design
   cd .claude/worktrees/journal && pnpm install
   ```
   Run the journal plan's 16 tasks. Its **Task 13 is a safety-invariant test (six combinations,
   position plus bytes). Falsify that one yourself**, never a subagent. It is the same shape as
   the modes Task 8 invariant.

5. Update the README honestly after journal ships too.

## DEFERRED ITEMS AND OPEN ISSUES

Nothing here is blocking the merge in the previous orchestrator's judgement, but every one is a
real finding and none should be lost. They are ordered by how much they matter.

### 1. The web API client's three new methods have no tests

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
