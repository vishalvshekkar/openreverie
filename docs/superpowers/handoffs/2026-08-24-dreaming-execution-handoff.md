# Dreaming execution handoff

For the orchestrating agent that builds dreaming v1. Read this fully, then read, in order:
`AGENTS.md`, `docs/superpowers/specs/2026-08-24-dreaming-design.md`,
`docs/superpowers/plans/2026-08-24-dreaming-implementation.md`, and skim `docs/dreaming.md`
(the working record; rationale lives there). The spec and plan were approved by the human on
2026-08-24. Do not redesign; execute. If a task reveals a real defect in the spec or plan,
stop that task, record the issue, and raise it to the human before diverging.

## Workspace

- Work only in the worktree `/Users/vishal/work/personal/second-mind/.claude/worktrees/dreaming`
  on branch `worktree-dreaming`. Never cd into the main checkout or the sibling
  `recall-and-event-time` worktree (another session owns it; its uncommitted work is why the
  plan's Task 11 mentions a TOOL_NOTICES completeness test that may not exist on this branch's
  base yet).
- Never use bare `git stash` (the stash stack is shared across worktrees). Prefer a WIP commit.
- Do not push, do not merge to main, do not tag. The branch is handed back for human review.
- Baseline: `pnpm install && pnpm build` pass; `pnpm test` has exactly one pre-existing failure,
  `packages/core/src/context.test.ts` "renders each recent session id so the model can pass one
  to read_transcript", which also fails on main. Leave it alone; every other test must pass.

## Orchestration and models

You are the orchestrator: plan, dispatch, review, integrate, talk to the human. Do not
implement tasks in your own context. Use subagent-driven development: one fresh implementer
subagent per plan task, then a reviewer subagent per task. Pin a model explicitly on every
subagent you spawn, and state the fan-out (for example "T3 implementer: sonnet; reviewer:
sonnet") before launching:

- haiku: mechanical work (running suites and reporting output, formatting sweeps, checkbox
  updates in the plan document, doc greps).
- sonnet: default for every implementation task and every review.
- opus: only where judgment genuinely bottlenecks, and say why when you do. Expected opus-worthy
  spots, at most: the Task 7 pipeline review (abort semantics, tone gate, write ordering) and
  the Task 9 engine wiring review (trigger correctness, lock, once-per-period guard). Everything
  else is sonnet or below.

Tasks run in plan order 1 through 15. Tasks 12, 13, and 14 touch disjoint packages and may run
as parallel implementers after Task 11 lands; everything else is sequential. Never let two
agents touch the same file concurrently.

## Per-task contract

Give each implementer only its task text from the plan (plus the plan's header and Global
Constraints section) and the file paths it needs; it should not ingest the whole plan. Each
task follows its written TDD steps exactly: failing test first, watch it fail, minimal
implementation, watch it pass, commit with the message the plan specifies. Small commits,
plain messages, no ceremony, no co-author trailers.

Reviewers, per AGENTS.md and learned the hard way in this repo:

- A reviewer runs `pnpm vitest run <the package>`, `pnpm build`, and `pnpm lint` itself. Never
  accept the implementer's report as evidence.
- Falsify, do not read: for each new behavior, the reviewer deletes or inverts the key line and
  confirms the named test fails, then restores it. The plan marks explicit falsification steps
  in Tasks 5 and 7; apply the same standard everywhere.
- Reject any prose (comments, docs, CLI copy, commit messages) containing em dashes or
  AI-typical tropes. This is a hard rule in this repo.

After each task passes review: tick its checkboxes in the plan document, commit that update,
and post a one-line status. After Task 15: run the full `pnpm test && pnpm build && pnpm lint`
from the root yourself, confirm the only failure is the known pre-existing one, and report
honestly what shipped and what did not.

## Domain rules that bind every task

- Downward-only deps: `cli|server -> core -> memory -> providers`; `web` over HTTP only.
- Nothing in a user memory folder is ever modified or deleted by dreaming; dream artifacts are
  write-once; jsonl is append-only; prose writes go through `writeDocumentAtomic`.
- Never weaken the safety modes. The dreaming persona callback and tone gate are part of the
  design; do not simplify them away.
- No telemetry, no network calls beyond the configured provider, and no developer `.reverie/`
  data anywhere near the repo.
- Zod at every LLM boundary; retry once with the validation error, then abort the dream run.
- No `Math.random` in dreaming code; all randomness flows from the recorded `rngSeed`.
- LLM behavior is tested with `FakeChatProvider` scripts and schema assertions, never golden
  text.

## Manual checks

Do not hand-drive the CLI or browser mid-build. Collect manual checks (dream tone across the
three voices, opener feel, web Dreams view rendering, settings round-trip) into a "Manual
testing queue" list appended to `docs/dreaming.md`, and leave them for the human after Task 15.

## Done means

All 15 tasks committed on `worktree-dreaming`, plan checkboxes ticked, suite green except the
known failure, build and lint clean, README and ROADMAP truthful, working record changelog
updated, manual queue written, branch left unmerged for human review.
