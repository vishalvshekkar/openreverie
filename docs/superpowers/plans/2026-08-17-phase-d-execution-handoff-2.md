# Phase D execution handoff, part 2

This document is the complete brief for an orchestrating agent resuming the Phase D
implementation after the first orchestrator paused. Read it fully, then read `AGENTS.md`
fully, before doing anything. `AGENTS.md` is binding; this document is your resume state.

## Your role

You are an orchestrator. You plan, decompose, dispatch, verify, and merge. You do not write
implementation code yourself. You dispatch subagents to write it, then you verify by running
the lint, the build, and the tests yourself.

The single most important rule, repeated because agents break it: **a subagent's report that
the tests pass is not evidence that the tests pass.** Run `pnpm lint`, `pnpm build`, and
`pnpm test` yourself after every task or batch and read the real output.

## Repository and exact git state

- Path: `/Users/vishal/work/personal/second-mind`
- Project: openreverie, a self-hosted companion agent for reflection with a layered memory.
  Six TypeScript packages, pnpm workspace. Node v22.22.0, pnpm 10.8.1.
- Commands: `pnpm lint`, `pnpm build`, `pnpm test` from the repo root. One test file:
  `npx vitest run <path>`. Full gate order is always `pnpm lint && pnpm build && pnpm test`.

Worktrees live inside the main repo at `.claude/worktrees/` (already gitignored). Current state:

| Path | Branch | HEAD | State |
| --- | --- | --- | --- |
| `/Users/vishal/work/personal/second-mind` | `feat/phase-d-design` | `6016eb6` | clean |
| `.claude/worktrees/retrieval` | `feat/phase-d-retrieval` | `f89a001` | clean |
| `.claude/worktrees/modes` | `feat/phase-d-modes` | `6016eb6` | clean, not started |

The `time` plan is fully merged into `feat/phase-d-design`. The old `feat/phase-d-time`
branch still exists but its worktree was removed.

## Plan status

| Plan file | Tasks | State |
| --- | --- | --- |
| `2026-08-17-cli-polish-and-ci-fix-plan.md` | 10 | DONE (before this session) |
| `2026-08-17-time-as-first-class-plan.md` | 23 | DONE, merged into design |
| `2026-08-17-context-and-retrieval-plan.md` | 19 | Tasks 1-9 done, Task 10 blocked on a resolved defect |
| `2026-08-17-modes-profile-settings-plan.md` | 24 (Task 0 + Tasks 1-22) | not started |
| `2026-08-17-journal-mode-plan.md` | 16 | not started (needs modes) |

Time plan commit hashes (13-23): `3b9f545`, `ecb6e31`, `70597cb`, `7b3c307`, `1e0f4c7`,
`6b40972`, `559313f`, `571aeb6`, `de261d4`, `9da2e2d`, `6016eb6`.

Retrieval plan commit hashes (1-9): `345b4fa`, `ec1469d`, `ec2c52a`, `d792d8f`, `492e2b3`,
`4631522`, `714aebb`, `76d8089`, `f89a001`.

## The one blocking decision, already resolved

Retrieval Task 10 (`list_people` / `list_entities` tools) has a plan defect that blocked the
implementing subagent. It is resolved; do not re-derive it.

The plan's Task 10 Step 1 says to rewrite the tool-list test to expect "ten" tools with an
array that omits `update_profile`. Reality: `toolDefinitions()` currently returns 9 tools
(including `update_profile`, added by the time plan). Adding `list_people` and `list_entities`
makes 11, not 10. The plan author wrote "eight names to ten" against a pre-time-plan tool list.

Resolution: the tool-list test must expect **11** tools, sorted, as follows:

```
graph_query, list_arcs, list_entities, list_people, list_realms,
read_document, read_transcript, remember, search_memory, update_profile, update_style
```

Everything else in Task 10 (the two arg schemas, the two tool definitions, the two dispatch
cases, the import extension, and the paging test) is verbatim as the plan writes it. Do not
remove `update_profile`; do not reduce the count.

## Modes plan: known drift, reconcile as you go

The modes plan (`2026-08-17-modes-profile-settings-plan.md`) was written against an
anticipated shape of the time plan that differs slightly from what actually landed. These are
mechanical, unambiguous reconciliations. Instruct every modes subagent to apply them; do not
let them improvise or stop on them.

1. **`saveProfile` does not exist.** The time plan exported `writeProfile` (in
   `packages/memory/src/profile.ts`). Everywhere the modes plan writes `saveProfile`, use
   `writeProfile`. This is systematic across Tasks 4, 5, 15, 19 and others.
2. **`MigrationResult` shape is wrong in the plan.** The real shape (from
   `packages/memory/src/migrations/index.ts`) is
   `{ id: string; applied: boolean; summary: string; details: string[] }`. The modes plan's
   Task 0 doc and its `style-to-profile` migration show `{ changed: boolean; messages: string[] }`.
   Use the real shape. The `reverie migrate` CLI (already shipped by the time plan) prints
   `summary` and `details`, so the `style-to-profile` migration must return those fields.
3. **`currentProfile()` already exists under the name `profile()`.** The modes plan Task 0
   step 4 explicitly says: if an accessor exists under a different name, use it. The engine's
   public accessor is `profile()`; the private cached field is `profileCache`. Use `profile()`
   everywhere the plan writes `currentProfile()`. `timezone()` and `timezoneSource()` also
   already exist on the engine.
4. **`Profile.body` is correct.** The plan says to substitute `prose` for `body` if the time
   plan named it `prose`; it named it `body`, so no substitution.
5. **The modes plan's command table is stale.** It lists `pnpm vitest run <path>` and
   `pnpm format`. Use `npx vitest run <path>` (the `pnpm vitest` form also works, but `npx`
   is the established form here) and `npx biome check --write .` for auto-format, then
   `npx biome check .` (must print "No fixes applied"). `pnpm format` exists but only runs
   the formatter, not the linter's safe fixes.

The modes plan's Task 0 is a verification gate. Its greps for `saveProfile` will report the
name `writeProfile` instead; that is the drift above, not a missing symbol. Read Task 0's
intent, not its literal symbol names.

## Environment facts you must not re-learn the hard way

- **Machine timezone is Asia/Calcutta (UTC+05:30).** CI is UTC. New date-sensitive tests must
  pin timezone to UTC where they build `Date.UTC`/`toISOString` fixtures, using the existing
  `pinTimezoneUtc(paths)` helper pattern (defined in `packages/memory/src/engine.test.ts`).
  `T20:00:00Z` maps to the next local day in Asia/Calcutta.
- **The single-file test command is `npx vitest run <path>` from the repo root.** The plans'
  `pnpm --filter openreverie test -- <path>` form fails with "No projects were found" (root
  `vitest.config.ts` uses `projects: ['packages/*']` resolved from cwd).
- **Cross-package imports resolve via `dist/`** (each package's `main` is `dist/index.js`).
  After any source change in a package, run `npx tsc -b` BEFORE running tests that import that
  package cross-package. This bit the CLI migrate falsify step: the CLI test imports
  `@openreverie/memory` via `dist`, so a source edit in memory does not reach the CLI test
  until you rebuild.
- **Fresh worktrees have no `node_modules`.** The retrieval subagent had to run `pnpm install`
  first. Do this in the modes worktree before dispatching its first task. Do not assume
  node_modules is present in a worktree you just created.
- **biome line width is 100.** Plan code snippets sometimes exceed it. End every task with
  `npx biome check --write .` (auto-format) then `npx biome check .` (must report "No fixes
  applied"). biome's recommended preset flags unused variables; remove dead symbols rather
  than suppressing.
- **`exactOptionalPropertyTypes` is on.** Never write `{ key: undefined }`. Use
  `...(value !== undefined ? { key: value } : {})`. zod 4 has `.exactOptional()` for schema
  fields whose type must be `T | undefined`-free.
- **`noUncheckedIndexedAccess` is on.** Narrow every array index and `.find()` result.
- **opencode dispatch** (verified working, both models):
  `opencode run -m deepseek/deepseek-v4-pro --dir <worktree-path> "$(cat /path/to/brief)"`.
  Use `deepseek/deepseek-v4-pro` for anything with logic (all remaining tasks). Never omit `-m`.

## Pitfalls already discovered (learn from them, watch for more)

1. **East-of-UTC machine breaks date fixtures.** `packages/cli/src/e2e.test.ts` broke this way
   and was fixed with `pinTimezoneUtc` + `ensureMemoryTree` in its `beforeEach`.
2. **`pinTimezoneUtc` in a shared `beforeEach` breaks the "system default" timezone test**
   (`context.test.ts`). Pin selectively in date-sensitive `it` blocks, not blanket `beforeEach`.
3. **The plans have real defects.** Ones hit and fixed (with clear intent, documented in the
   commit or report, none touching safety):
   - time Task 18 "empty registry" test was removed: it is stale once Task 19 registers a
     migration, and the registry is never empty in the final code.
   - time Tasks 15/16 used `z.string().optional()`; under `exactOptionalPropertyTypes` this is
     not assignable to `eventTime?: string`, so the subagent used zod 4 `.exactOptional()`.
   - time Task 21's `index.ts` line refs predate a `KNOWN_SUBCOMMANDS` set; `migrate` had to be
     added to it and `runMigrate` added to the `CliMainDeps` fake in `index.test.ts`.
   - time Task 14 Step 2 named the wrong `-t` filter ("lists known"); the changed assertions
     live in the "includes the constitution" test.
   - retrieval Task 5's RED was one of three new tests failing (the daily-rollup tests pass
     under the old path filter because their paths still encode readable dates); the falsify
     steps confirm the behavior. Proceed; do not weaken the assertions.
   - retrieval Task 10 (the resolved tool-count defect above).
4. **A plan's "expected failure/pass" can contradict reality.** When it does, fix the test
   minimally to match the plan's clearly-stated intent, note it in your final summary, and do
   not silently diverge from intent. These are not occasions to stop and ask unless the fix
   itself is genuinely ambiguous.
5. **`git worktree` dirs break biome** if not gitignored. `.claude/` is already gitignored
   (committed). Do not reintroduce a non-ignored scratch dir.

## Dispatching subagents

The established, token-efficient workflow:

1. Batch tasks that touch the same files into one subagent session, to reuse loaded context.
2. Write the brief to a temp file, then dispatch with `opencode run`. Point the brief at the
   plan file and exact task numbers; never re-transcribe large code blocks (the plan is in the
   worktree and is the verbatim source). Include in every brief: the writing style rules, the
   relevant architecture constraint, the exact gate order, and an instruction to stop and
   report rather than improvise if anything is ambiguous or a symbol does not exist.
3. Require each subagent to: RED (write test, run, confirm fail) then GREEN (implement, run,
   confirm pass) then the plan's falsify step (if any) then `npx tsc -b` FIRST, then
   `npx vitest run`, then `npx biome check --write .` and `npx biome check .`.
4. You verify, not the subagent. After each batch, run `pnpm lint && pnpm build && pnpm test`
   in the worktree yourself and read the output. Then commit per task with the plan's exact
   commit message. If a batch's tasks share files such that clean per-task commits are
   impossible, one combined commit with a plain message is acceptable.
5. One logical unit per dispatch. Never hand a whole plan to one subagent.

## Safety handling (critical, read carefully)

- The remaining retrieval tasks (10-19) do NOT touch safety modes or crisis behavior.
  Falsification there may be delegated to subagents.
- The modes plan DOES touch safety modes and crisis behavior: Task 7 (stance doctrine),
  Task 7A (identity-fact sentence), and Task 8 (mode overlay + safety invariant) all sit in
  `packages/core/src/personas.ts` and its tests. For those tasks, do the falsification of any
  safety-related test **yourself**, never delegate it, and read the modes plan's own notes
  about the safety invariant. The journal plan similarly has a safety-invariant test
  (six combinations, position plus bytes) that you must falsify yourself.
- Never let a subagent alter crisis/safety behavior or weaken a safety mode. Never remove or
  bypass companion/firewall. The modes plan's own constraint says a mode adjusts style within
  the safety stance and never adjusts the safety stance.

## What to do next, in order

1. **Resolve retrieval Task 10** using the 11-tool resolution above, then complete retrieval
   Tasks 10-19. Suggested batching (all sequential within the retrieval worktree):
   - Task 10 alone (blocked decision now resolved).
   - Tasks 11 + 12 (share `retrieval.ts`/`sqlite.ts`/`tools.ts`): node lane in `search_memory`,
     then the search-lane descriptions. Task 11 changes the `search` shape and ripples into
     `cli/src/e2e.test.ts` and `server`; follow the plan's call-site updates and run the full
     suite after.
   - Tasks 13 + 14 + 15 + 16 (share `core/context.ts` + `budget.ts`): truncation markers, the
     budget module, applying the budget, and the reflection-full-constitution pin. Task 16 is
     the safety-adjacent one (constitution truncation could delete data); read its falsify
     carefully.
   - Tasks 17 + 18 + 19: weekly rollup shelf, the DocKind wiring test, final verification +
     README. Task 19 you do yourself.
   - Read each plan task's section fully before dispatching it; the plan has verbatim code and
     its own falsify steps.
2. After retrieval is complete and green, merge into design:
   `cd /Users/vishal/work/personal/second-mind && git merge feat/phase-d-retrieval` (a regular
   merge, not `--ff-only`: design now carries one extra handoff-doc commit, see below). Run the
   full gate again on `feat/phase-d-design` after the merge. Then
   `git worktree remove .claude/worktrees/retrieval`.
3. **Run modes** in `.claude/worktrees/modes`. First `pnpm install` in that worktree. Read the
   modes plan fully. Run its Task 0 gate (reconciling the drift above). Decompose into
   file-sharing batches, dispatch, verify, and do safety falsification yourself for Tasks 7/7A/8.
4. After modes merges into design, create `.claude/worktrees/journal` branched from the
   modes-merged design and run the journal plan (its safety-invariant falsification is yours).
5. Update the README honestly after each plan ships; the Status section must never overstate.

## About this handoff document

This file is committed to `feat/phase-d-design` as its own commit (a plain docs commit) so the
state is durable. It is the only extra commit on design beyond the time merge. That is why the
retrieval and modes merges should use a regular `git merge` rather than `--ff-only`. If you
prefer a clean fast-forward, `git revert` or drop that doc commit first; either is fine.

## When to stop and ask the human (do not work around)

- A plan task references a symbol that does not exist and is not created by an earlier task,
  and the correct fix is not one of the documented drifts above.
- Two plans contradict each other.
- A test genuinely cannot be made to fail before the implementation exists.
- A change requires an upward import across a package boundary.
- Anything touches crisis handling or safety modes in a way the plan did not already specify.
- The same task fails three times.
