# Phase B resume handoff (v0.4.0 web interface)

Written 2026-08-15, after recovering the work from a temporary worktree. Give the prompt below to a
fresh agent to resume Phase B.

---

You are resuming an in-progress feature branch in the openreverie repository. Work was stopped
mid-task by an external usage limit, not by a problem with the code. Nothing was lost. Do not
restart anything that is already done.

## Where the work is

- Repository: `/Users/vishal/work/personal/second-mind`
- Branch: `feat/phase-b-v0.4.0`, HEAD at `8c733ba`, checked out directly in the main working
  directory.
- There are no git worktrees. Earlier work happened in `/private/tmp/openreverie-phase-b-v0.4.0`.
  That directory has been removed and its contents recovered. Do not look for it.
- Five files are modified and unstaged. This is intentional. See "Resume point" below.
- `~/work/personal/second-mind-recovery/` holds a backup taken during the recovery. It is a frozen
  snapshot and it goes stale the moment Task 5 is committed. The live paths in the repository are
  authoritative. Delete the recovery directory once Task 5 lands.

## Step zero, before anything else

Run `pnpm install`. The `node_modules` tree in this workspace was installed against `main`'s
manifest. This branch adds `packages/server` and `packages/web` and modifies the root
`package.json`. Skipping this makes the first build or test run fail in a way that looks like
broken recovered work but is not.

## Read these first, in this order

1. `AGENTS.md`. It is the canonical instruction set and it is binding. Read it fully.
2. `docs/superpowers/plans/2026-08-15-phase-b-web-interface.md`. This is the implementation plan and
   the source of truth for task scope. It contains 8 tasks, each with its own file map, named
   failing tests to write first, rerun commands, reviewer and falsification step, and commit step.
   Follow it exactly. Do not work from any paraphrase of it, including this document.
3. `docs/superpowers/specs/2026-08-15-phase-b-c-web-atlas-design.md`, the design spec behind the plan.
4. `.superpowers/sdd/2026-08-15-phase-b-web-interface/`, which holds the per-task briefs, the task
   reports, `progress.md`, and the per-task review diffs. Read `progress.md`, `task-5-brief.md`,
   and `task-5-report.md` before touching Task 5.

Note: `.superpowers/` is gitignored. Those briefs, reports, and review diffs exist only on this
filesystem and are invisible to git. If work ever moves to another checkout or machine, copy that
directory by hand or it is lost.

## What is already done

Tasks 1 through 4 are complete, reviewed, and committed. Do not re-review or redo them.

- Task 1, packages, provider-free projections, API primitives: `b255f0e`
- Task 2, auth and bounded read-only resources: `510fe6f`, with fix `ccfb1ea`
- Task 3, graph snapshot and event history APIs: `58bc14f`, with fix `e5a08c6`
- Task 4, live sessions, streaming, replay, lifecycle: `38c70e7`, with fix `dcb9fc0`
- Task 5, provider-optional server and `reverie web`: base commit `8c733ba` is landed. Review fixes
  are implemented but uncommitted.

`packages/server` is essentially built: cursors and envelopes, bootstrap-token auth, HTTP routing,
the live session registry, and the launcher. The graph backend is done, `graphSnapshot()` in
`packages/memory` serving `GET /api/v1/graph/snapshot` and `GET /api/v1/graph/events`.

`packages/web` is scaffolding only: `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`,
and `src/test-setup.ts`. There is no `App.tsx`, `api.ts`, `session.ts`, `main.tsx`, or `styles.css`.
The browser-side atlas is entirely unbuilt.

## Resume point: finish Task 5

The five unstaged files are Task 5 review fixes, written in response to a code review and stranded
before the commit. They are three fixes:

1. `package.json`, the root `build` script now runs `tsc -b --force` followed by the Vite build for
   `@openreverie/web`, so a root build produces the web assets.
2. `packages/server/src/app.ts`, static file serving now resolves `realpath()` on both the static
   directory and the candidate file and re-checks containment, so symlinks inside the asset
   directory that escape it are rejected. `packages/server/src/index.ts` changes the assertion
   error text from `pnpm --filter @openreverie/web build` to `pnpm build` as a corollary.
3. `packages/server/src/launch.ts`, shutdown is extracted into `closeServerResources()` which
   attempts every cleanup step and keeps the first error, instead of skipping later cleanup when an
   earlier step throws. `packages/server/src/launch.test.ts` adds four tests covering the symlink
   escape and the three shutdown failure orderings.

Your job is to review these as a reviewer, not to accept them. AGENTS.md requires two things here
and they are not optional:

- Run the tests, the build, and the lint yourself. Do not treat any written report as evidence that
  the suite passes. This exact failure has happened in this repository before.
- Falsify, do not read. Delete the fix, watch the test fail, restore it. This repository has a
  history of tests that pass for reasons unrelated to their name.

The Task 5 brief names the falsifications explicitly: falsify `opens provider-free projections
without maintenance work when maintenance is false` by deleting the `maintenance: false` guard and
observing a fake `complete`, `stream`, or `embed` call or a drained proposal; falsify `starts read
paths when API-key resolution fails` by replacing unavailable providers with an eager factory call;
falsify `dispatches web only for reverie web` by moving the branch below normal chat context
creation. Add falsification of the new symlink and shutdown tests in the same manner.

Verification commands from the plan:

```
pnpm vitest run packages/server/src/launch.test.ts packages/cli/src/web.test.ts packages/cli/src/e2e.test.ts
pnpm test
pnpm build
pnpm lint
```

When the fixes hold, commit them as a follow-up fix commit in the style of `ccfb1ea`, `e5a08c6`, and
`dcb9fc0`. The base commit already used the plan's Task 5 commit message, so do not reuse it.

### Two discrepancies to reconcile, not to trust

- `progress.md` has no Task 5 entry. Its task ledger ends at Task 4, even though `task-5-report.md`
  exists and claims verified work. Update the ledger as part of closing Task 5.
- Test counts do not agree across sources. `progress.md` records a 445-test baseline,
  `task-3-report.md` says 472, `task-5-report.md` says 490 across 29 files. A verbal handoff
  mentioned 494 with loopback enabled and 489 when loopback binding was denied, with five HTTP
  launch tests timing out. Those two figures appear in no written artifact. Establish the real
  number by running the suite yourself and record it. If you see HTTP launch tests time out rather
  than fail, that is a loopback binding denial in the sandbox, not a defect. Confirm it resolves
  when loopback is available and move on.

## Then Tasks 6, 7, 8, strictly in order

They cannot be parallelized. Task 7 consumes Task 6's `ApiClient` and document-opening callback, and
both modify `App.tsx`, `App.test.tsx`, `styles.css`, and `api.ts`. Task 8 documents what 6 and 7
deliver and runs the release gates.

- Task 6, the authenticated React record browser and streamed chat. Creates
  `packages/web/src/api.ts`, `api.test.ts`, `session.ts`, `session.test.ts`, `App.tsx`,
  `App.test.tsx`, `main.tsx`, `styles.css`; modifies `packages/web/vite.config.ts`,
  `packages/web/src/test-setup.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`.
  Named failing tests to write first: `bootstraps once, removes token from the address, and loads
  records with credentials`; `reconnects from its last sequence and fetches transcript after
  resync_required`; `opens a document from the browser and makes provider outage honest`.
- Task 7, the accessible atlas foundation. `packages/web/src/atlas.ts` plus an `Atlas` component.
  Deterministic seeded layout, Graphology and Sigma, type filter, and a parallel semantic list built
  from the exact same filtered node set. Pan, zoom, filter, selection, and document open only.
  Saved positions, realm influence, search, progressive labels, and the time lens are Phase C.
- Task 8, the v0.4.0 release. Version bumps, README, ROADMAP, and SECURITY rewrites, a release test
  asserting versions and honest README claims, and the full gate run.

Take the exact file lists, test names, and commit messages from the plan document, not from this
summary.

## Guardrails

- **Package boundaries.** Six packages, downward only: `cli -> core -> memory -> providers` and
  `server -> core -> memory -> providers`. `cli` and `server` are sibling outer interfaces. `web`
  talks to `server` over HTTP only and never imports runtime engine packages. This directly governs
  Tasks 6 and 7: `packages/web/src/api.ts` may not import `@openreverie/memory`. Validate responses
  with zod at the boundary instead.
- **Orchestrate, do not implement.** Plan, decompose, review, and talk to the human. Delegate
  implementation, exploration, and audits to subagents sized to the task, and parallelize
  independent work.
- **Pin a model on every subagent, explicitly.** This is hook-enforced in this environment and
  unpinned calls are denied. Cheap models for mechanical and lookup work, mid-tier for
  implementation and review, top-tier only for the hardest judgment calls. State the model per agent
  when announcing a fan-out.
- **TDD for deterministic logic.** Write the failing test first. LLM-dependent behavior is tested
  with fixture transcripts and schema assertions, never golden text.
- **Writing style.** No em dashes anywhere, including code comments and commit messages. No AI
  tropes. Plain, concrete, honest. If something is half-done, say half-done.
- **README honesty.** The Status section must reflect reality. Overstating status is a serious
  defect in this project, not a cosmetic one.
- **Never** weaken the companion or firewall safety modes, and never let memory folder contents
  leave for anywhere except the user's configured model provider.

Report honestly at each checkpoint: what passed, what failed, what you skipped and why.
