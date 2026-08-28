# Hostable engine, round two: what running it actually found

Date: 2026-08-27. Status: released in v0.8.0.

## Why there is a second round

The first round (`2026-08-27-hostable-engine-design.md`) ended with an honest gap: the seams were
built and tested, but nothing had ever run on a Workers-style runtime. Reverie Cloud, the hosted
product that asked for the work, has now run it on one, and verified the whole change set against
its own build rather than accepting our report. Their numbers match ours exactly.

Everything the first round claimed holds, with four corrections. One of them stops a non-Node host
from starting at all. The other three are safety and correctness improvements that nothing
currently depends on.

All four are behavior-neutral for self-hosted openreverie. This is still a pure refactor of v0.7.3.

## What running it settled

Three things the first round listed as unknown or unproven are now answered, and the answers are
recorded here because they change what this repository may honestly claim.

- **The engine constructs and runs with no filesystem.** `MemoryEngine.fromPaths` over injected
  stores, with `MemoryIndex.fromDatabase` over a non-`better-sqlite3` database, opens successfully
  on a real Workers-style runtime. The seams work.
- **`gray-matter` is fine.** The first round flagged it as a five-minute question deferred to the
  consumer's first spike: its main entry references `fs` for a `matter.read()` helper we never
  call. It bundles, and its YAML path executes, with a document round trip through
  `writeDocumentAtomic` and `readDocument` succeeding on that runtime. The question is closed.
- **Bundle size is a non-issue.** Well inside the limits that were worth checking once.

## B1: the server barrel cannot load off Node

`packages/server/src/index.ts` builds a `createRequire` at module scope. On a runtime where
`import.meta.url` is undefined, that throws while the module is being evaluated, before any handler
runs, so the isolate never starts.

`packages/server/package.json` declares `main` as `dist/index.js` with no `exports` map, and
`index.ts` is an unrestricted `export *` barrel. So `import { createFetchApp } from
'@openreverie/server'`, which is the whole point of P1-1, loads the Node bootstrap and dies.

`createRequire`'s result is used in exactly one place, resolving the web interface's built assets
inside `resolveStaticDir`. Building it on first use rather than at module scope is the entire fix.

**This is worth recording as a lesson, not just a fix.** Three cheap checks all pass against the
broken code: the bundler builds it, a vitest import of the package succeeds because vite supplies
`import.meta.url`, and this repository's whole suite is blind to it. Only starting the isolate
fails. That is the same shape as the buffering-NDJSON trap the first round warned about, where
every naive check goes green and the thing that matters is broken.

It also corrects a claim this repository made. The first round's README said running on a runtime
other than Node was an obstacle removed but unproven. It was not removed: the package root could
not load. This is what removes it.

**Coverage, stated honestly.** This repository cannot run a Workers runtime, so nothing here will
catch this regressing. The guard we can afford is a test asserting that importing the package root
does not evaluate `createRequire` at module scope, which is cheap and catches the specific mistake.
The real integration test lives downstream.

## F2: git auto-commit is not gated on `capabilities.versioning`

The first round said `capabilities.versioning` covered git auto-commit the way
`capabilities.locking` covers the dream lock. The lock was wired in that round's own review. Git
was not.

`commitMemory` carries no capability check, and the engine calls it from seven write paths, which
is effectively every mutating call. It degrades safely rather than crashing, because it checks
whether the root is a directory through the injected `FileStore` before shelling out. What it costs
is a pointless storage query on every write, and a warning that misstates its own cause: it reports
that git was skipped because the root is not a directory, when the truth is that git was never
applicable on that host.

A warning that misdescribes the reason is worse than no warning. It sends whoever reads it looking
for a directory problem that does not exist.

The consumer asked for the seven call sites to be gated. We are gating inside `commitMemory`
instead. It already receives the `FileStore`, so the flag is in hand, and one guard at the source
covers all seven call sites and every future one, failing closed by construction rather than by
seven callers remembering. "Not applicable here" and "tried and failed" have to stay
distinguishable to callers that surface the result.

## F3: the shared HTTP core still builds a Node store

`dreamFeedbackVerdicts` in `http-core.ts` constructs `nodeStores()` directly, inside the shared
transport-agnostic core rather than the Node adapter, and the call sits inside a `try`/`catch` that
returns an empty map.

So on a host with no filesystem the dream detail route succeeds and silently drops every feedback
verdict. The file's own comment is honest that this is a remaining Node dependency, so it is not
hidden, but it is silent at runtime, which is the worse half. A route that returns a wrong answer
confidently is worse than one that fails.

The engine handed to `createFetchApp` already holds a `MemoryPaths` over whatever stores the host
supplied. The verdicts should be read through that.

## F4: the bootstrap route is always mounted

`handle()` matches `POST /api/v1/auth/bootstrap` unconditionally, before any auth check, and sets a
session cookie on success. `FetchAppDeps` has no way to switch it off, unlike `serveStatic`, which
is simply absent unless supplied.

The placement is fine. The first round moved this flow into the shared core on the argument that
nothing Node-specific was left in it once `deps.auth` became pluggable, and that argument stands.
The default is the problem: whether a deployment exposes an unauthenticated cookie-issuing endpoint
depends on every host remembering to write a `BootstrapAuth.exchange` that refuses. That is
isolation by discipline, and this project's own rules ask a closed set of states to fail closed
rather than depend on every caller getting it right.

Making the route opt-in costs almost nothing and removes the mistake from every future host.
Self-hosted passes the dep and is unchanged.

## Also in this round

`assertValidTimezone`'s rejection is currently proven only through `MemoryEngine.open()`, which
calls `fromPaths` internally. `fromPaths` is the entry point a filesystem-free host actually uses,
and nothing tests it directly with an empty or malformed zone. The guard is the same call on both
paths, so this is a test gap rather than a defect, and it is worth closing because an empty string
that is present is a different case from a field that is absent, which this project has been bitten
by before.

## Deliberately not doing

Each of these was measured downstream rather than guessed at, and none is needed.

- No `exports` map, no `sideEffects: false`, no barrel restructuring, and no splitting
  `http-core.ts` into its own entry point. Once B1 lands, both packages import cleanly through
  their package roots.
- No `gray-matter` work. See above: settled.
- No `better-sqlite3` split. It survives in a bundle today only because better-sqlite3 defers its
  native load into the `Database` constructor, and nothing on a filesystem-free host calls
  `MemoryIndex.open`. That means the guarantee currently belongs to a third party's implementation
  detail rather than to us, and making it ours is worth doing eventually. It is explicitly not
  wanted in this round, and belongs in `BACKLOG.md` rather than here.

## A correction to what we reported in the first round

The first round's spec never stated a count, but our report on it said six `systemTimeZone()` call
sites where the change request said five. Both counts were describing different moments. After that round's changes there are five remaining
call sites, all in the outer interfaces (`server/src/launch.ts` and four in `packages/cli`), and
all five are legitimate: those processes really do run on the person's own machine. The substantive
point stands unchanged, which is that the engine may not read the ambient zone and a CLI may.

## How we will know it worked

- `pnpm build` clean, `pnpm exec tsc -b --force` clean, `pnpm exec biome check .` clean, and the
  full suite green with no regression.
- The CLI bundle still resolves its web assets in both layouts it supports, since `resolveStaticDir`
  is the one caller of the binding B1 changes and the published binary depends on it.
- Every new guarantee has a test shown to fail when the specific behavior it names is mutated. Named
  cases: restoring the module-scope `createRequire` makes the startup guard fail; removing the
  versioning gate makes the git test fail; restoring `nodeStores()` in the shared core makes the
  verdicts test fail; mounting the bootstrap route unconditionally makes the opt-in test fail;
  removing `assertValidTimezone` from `fromPaths` alone fails its tests while `open()`'s still pass.
