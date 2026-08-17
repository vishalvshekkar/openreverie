# Execution handoff: Phase D

This document is the complete brief for an orchestrating agent that will implement five
plans in this repository using subagents. It assumes you have no prior context. Read it
fully before doing anything.

## Your role

You are an orchestrator. You plan, decompose, dispatch, verify, and merge. You do not
write implementation code yourself. You dispatch subagents to write it, then you verify
their work by running the tests, the build, and the lint yourself.

The single most important rule in this document: **a subagent's report that the tests pass
is not evidence that the tests pass.** Run them yourself, every time. This project has been
burned by exactly that: one task reported a fully passing suite while a test file was
failing, and it went two tasks undetected because reviewers trusted the report.

## The repository

- Path: `/Users/vishal/work/personal/second-mind`
- Project: openreverie, a self-hosted companion agent for personal reflection, with a
  layered memory that never forgets. Six packages, TypeScript, pnpm workspace.
- Branch to work from: `feat/phase-d-design`. It already contains five design specs and a
  retrieval reference doc, committed as `0322c0e`.
- Node: v22.22.0. Package manager: pnpm.
- Commands: `pnpm lint`, `pnpm build`, `pnpm test` from the repo root. Individual test
  files run with `npx vitest run <path>`.

### Read these first, in this order

1. `AGENTS.md` at the repo root. It is the canonical instruction set. Every rule in it is
   binding on you and on every subagent you dispatch.
2. `README.md`, for what the project currently claims to do.
3. `docs/retrieval.md`, for how search and indexing actually work today.

## Non-negotiable rules

These come from `AGENTS.md`. Violating any of them is a defect, not a style choice.

**Writing style, applies to all prose including code comments, commit messages, error
messages and CLI copy:**
- Never use em dashes. Use commas, periods, colons or parentheses.
- Never use these words: delve, seamlessly, robust, leverage, streamline, empower, unlock,
  supercharge. Avoid "It's not just X, it's Y" constructions and emoji in headings or lists.
- Write plainly. Short sentences are fine. Say what is true, not what sounds impressive.

**Architecture, downward-only dependencies:**
- `cli` -> `core` -> `memory` -> `providers`
- `server` -> `core` -> `memory` -> `providers`
- `cli` and `server` are sibling outer interfaces.
- `web` talks to `server` over HTTP only and never imports runtime engine packages.
- Never import upward or sideways around these boundaries.

**Data integrity:**
- Truth lives in the user's memory folder: markdown prose files plus the append-only
  `graph.jsonl`. SQLite is a derived index and must always be rebuildable from the folder.
  Never store anything only in SQLite.
- Transcripts are sacred. Append-only, never modified, never deleted by code.
- Prose file writes are atomic (temp file, then rename). Graph log writes are single-line
  appends.
- Validate all LLM structured output with zod schemas at the boundary.

**Safety:**
- Both safety modes (companion and firewall) exist by design. Never remove, weaken or
  bypass them. Never make crisis behavior "smarter" without explicit human sign-off.
- Never write code that could send memory folder contents anywhere except the user's
  configured model provider. No telemetry, no analytics.
- A developer's own `.reverie/` data must never enter the repo.

**Testing:**
- TDD for deterministic logic. Write the failing test first, watch it fail, then implement.
- LLM-dependent behavior is tested with fixture transcripts and schema assertions, never
  golden text.
- **Falsify, do not read.** After a test passes, delete the fix, confirm the test fails,
  then restore the fix. Reading tells you the code is right today. Falsifying tells you the
  test will catch a regression tomorrow. The recurring failure in this codebase is a test
  that passes for a reason unrelated to what it is named.

## The five plans

All under `docs/superpowers/plans/`. Each plan is written for an executor with zero
context: every task lists exact files, exact interfaces, and steps of two to five minutes
with real code and real commands. Do not improvise beyond a plan. If a plan is ambiguous,
stop and report rather than guessing.

| Plan file | Tasks | Depends on |
| --- | --- | --- |
| `2026-08-17-cli-polish-and-ci-fix-plan.md` | 10 | nothing |
| `2026-08-17-time-as-first-class-plan.md` | 17 plus migration tasks | nothing |
| `2026-08-17-modes-profile-settings-plan.md` | 24 | time |
| `2026-08-17-journal-mode-plan.md` | 16 | time, modes |
| `2026-08-17-context-and-retrieval-plan.md` | 14 plus wiring tasks | time (for one fix only) |

Each plan names its spec in its header. Read the spec alongside the plan when a task's
intent is unclear. The specs are in `docs/superpowers/specs/` and dated `2026-08-16`.

### Execution order

```
cli-polish            can run at any time, independent
time                  must complete before modes and journal
  modes               must complete before journal
    journal
  retrieval           needs only the sessionId fix from time
```

Run `cli-polish` and `time` first. They do not touch the same files. After `time` merges,
run `modes` and `retrieval`. After `modes` merges, run `journal`.

## Isolation and merging

Create one git worktree per plan, branched from `feat/phase-d-design`:

```bash
git worktree add .claude/worktrees/<plan-name> -b feat/phase-d-<plan-name> feat/phase-d-design
```

Dispatch every subagent for that plan with `--dir` pointed at its worktree. Never let two
subagents work in the same directory at the same time.

Merge a worktree back into `feat/phase-d-design` only after its whole plan is complete and
you have personally run `pnpm lint`, `pnpm build` and `pnpm test` in that worktree and seen
them pass. After merging, run the full suite again on `feat/phase-d-design`, because a
merge can break things neither branch broke alone.

Remove the worktree after a successful merge:

```bash
git worktree remove .claude/worktrees/<plan-name>
```

## Dispatching subagents

Use opencode in non-interactive mode. The `deepseek` provider is authenticated and both
models are verified working, including tool use.

```bash
opencode run -m deepseek/deepseek-v4-pro --dir <worktree-path> "<task brief>"
opencode run -m deepseek/deepseek-v4-flash --dir <worktree-path> "<task brief>"
```

**Model selection.** Use Flash for mechanical work: renaming a symbol across call sites,
adding a flag, copying a test the plan already wrote out in full, changing a string. Use
Pro for anything with logic in it: schema migrations, the `listSessions` rework, the prompt
budget, anything touching reflection or safety.

**One task per dispatch.** Never hand a subagent a whole plan. A bad task must not cascade.

**Two dispatches per task where TDD matters.** First dispatch writes only the failing test
and reports the exact failure output. You verify the failure is the expected one. Second
dispatch writes the implementation. Left to do both in one pass, agents reliably write the
implementation first and then a test shaped to pass, which is worthless.

**Every brief must be self-contained.** The subagent sees only what you send. Include the
task text from the plan verbatim, the writing style rules, the relevant architecture
constraint, and an explicit instruction to stop and report rather than improvise if
anything is ambiguous.

## Your verification loop, per task

1. Dispatch the test-writing subagent. Read its reported failure.
2. Run the failing test yourself. Confirm it fails for the stated reason, not for a typo
   or a missing import.
3. Dispatch the implementation subagent.
4. Run the single test yourself. Confirm it passes.
5. Falsify: revert the implementation change, run the test, confirm it fails, restore.
   Skip this only for pure additions with no behavior to break.
6. Run `pnpm lint`, `pnpm build`, `pnpm test` in the worktree. All three must be green.
7. Commit, using the commit message the plan specifies.

If step 6 fails, do not proceed to the next task. Fix it or report it. The build and the
suite must be green after every task.

## Known landmines

These were found during design and review. Each one has bitten someone already.

**Truncating the constitution would delete it.** Reflection's second pass emits
`constitutionUpdate` as a full replacement body. If the reflection model is ever shown a
truncated constitution, it rewrites what it saw and the unseen tail is deleted from disk.
The prompt budget applies to `assembleSystemPrompt` only, never to reflection's input. The
retrieval plan has a test pinning this asymmetry. Do not let anyone "simplify" it away.

**Mocking `execFile` silently breaks the code under test.** Node's `execFile` carries an
internal `util.promisify.custom` symbol that a plain mock lacks, so `promisify()` on a
mocked `execFile` resolves to a bare string instead of `{stdout, stderr}`. The CLI plan
avoids this with a pure exported `gitArgs()` function. Do not reintroduce the mock.

**A test that passes harder when you delete the implementation is not a test.** The journal
spec originally asserted that prompts with and without journal mode had byte-identical
crisis sections. Removing all journal code makes them more identical. Safety tests assert
position plus bytes, with real fixture content so the arms genuinely differ elsewhere.

**Synthesized transcript lines must not enter journal entries.** `setMode` appends a
user-role line reading `/mode <name>`. Journal entry bodies are the person's own words
verbatim. The `synthetic: true` field on `TranscriptLine` is what separates them. Do not
pattern-match a leading slash instead: a person can legitimately write a line starting
with a slash inside a journal entry.

**Any unrecognized CLI argument currently starts a chat session.** `mainWith()` has no
fallthrough guard, so `reverie --version` today loads config, resolves the API key, opens
the engine and drops the user at a prompt. The CLI plan fixes this first.

**Two tool descriptions are currently false.** `search_memory`'s `after`/`before` filters
are inert for most document kinds, and `list_arcs` promises a status field that
`GraphNode` does not have. A tool description that lies makes the model confidently wrong,
which is worse than a missing capability. The retrieval plan fixes both.

**Mode must persist to disk, not memory.** `runMaintenance` reflects stale sessions in a
later process. If mode lives only in memory, a session that crashes before `/bye` loses its
journal entry entirely. It is written to `session.json` at session start.

## Definition of done, per plan

- Every task's checkbox is ticked.
- `pnpm lint`, `pnpm build`, `pnpm test` all green in the worktree, run by you.
- Every safety-related and falsifiability-related test has been falsified once, by you.
- The worktree is merged into `feat/phase-d-design` and the suite is green there too.
- `README.md` reflects reality. If a plan shipped a capability, say so. If it shipped half
  of one, say that. Overstating status in this project is a serious defect. The README's
  Status section must be true at all times.

## When to stop and ask

Stop and report to the human rather than guessing when:

- A plan task references a symbol that does not exist and is not created by an earlier task.
- Two plans appear to contradict each other.
- A test cannot be made to fail before the implementation exists.
- A change would require importing upward across a package boundary.
- Anything touches crisis handling, safety modes, or would send memory content anywhere.
- The same task fails three times.

Do not work around any of these. They are signals that the plan is wrong, and a plan being
wrong is cheaper to fix than code built on a wrong plan.
