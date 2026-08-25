# Agent instructions for openreverie

Every AI agent working in this repository must read this file fully before making any change. These rules are not suggestions.

## What this project is

A self-hosted companion agent for personal reflection and mental wellbeing, with a layered memory that never forgets. The design source of truth is the newest spec in `docs/superpowers/specs/`. Read the relevant spec sections before implementing anything. If your change contradicts the spec, stop and raise it; do not silently diverge.

## Writing style, non-negotiable

Applies to all prose: README, docs, comments, commit messages, error messages, CLI copy.

- Never use em dashes. Use commas, periods, colons, or parentheses instead.
- Avoid AI-typical tropes: "delve", "seamlessly", "robust", "leverage", "streamline", "empower", "unlock", "supercharge", "It's not just X, it's Y" constructions, rhetorical triads bolted onto every claim, emoji in headings or lists, and breathless marketing tone.
- Write plainly and concretely. Short sentences are fine. Say what is true, not what sounds impressive.
- Honesty over polish. If something is half-done, the docs say half-done.

## README honesty

The README's Status section must reflect reality at all times. After any meaningful build session, update the README so it stays true: status, what works, what does not. Never let the README claim capability that does not exist in the code. Overstating status in this project is a serious defect, not a cosmetic one.

## Backlog and roadmap

Two files, one job each. An item lives in exactly one of them, never both.

- `BACKLOG.md` is canonical for everything named but not yet started: deferred work, known gaps, ideas, and features not built. If it has not shipped, this is where it lives.
- `ROADMAP.md` is the honest Done narrative and the current direction, and it points at `BACKLOG.md` for everything not started. It does not keep its own list of future work.

**Every deferral gets an entry in the same change that makes it.** When a spec, plan, or review says something is out of scope, deferred, future work, or worth revisiting, add it to `BACKLOG.md` then, not later. A deferral recorded only inside a spec is invisible the moment that spec stops being the active one. This has already cost this project real time: structured event-time resolution sat deferred in one section of a 1064-line spec from 2026-08-16, and only resurfaced on 2026-08-24 because someone happened to read that file for an unrelated reason.

Each entry carries five things:

- what it is, in one or two sentences
- why it was deferred
- where the thinking already lives, linking the spec or plan section
- what would trigger picking it up
- rough size

Two rules about those fields. **Never invent a reason or a trigger.** If the source gives none, write `not stated`, the same way this project prefers an honest gap to a confident guess anywhere else. And keep the reason distinguishable from your own summary: quote the source's own words when it gave them.

When a backlog item ships, remove its entry and record it in the `ROADMAP.md` Done narrative. Do not leave it in both, and do not leave a shipped item sitting in the backlog marked done. The same honesty bar as the README applies to both files: nothing is claimed done unless it works.

## Architecture rules

- Six packages with downward-only dependencies: `cli` -> `core` -> `memory` -> `providers`, and `server` -> `core` -> `memory` -> `providers`. `cli` and `server` are sibling outer interfaces. `web` communicates with `server` through HTTP only and never imports runtime engine packages. Never import upward or sideways around these boundaries.
- Truth lives in the user's memory folder: markdown prose files plus the append-only `graph.jsonl`. SQLite is a derived index and must always be rebuildable from the folder. Never store anything only in SQLite.
- Transcripts are sacred. Append-only, never modified, never deleted by code.
- Relationship claims in prose are testimony, not record. The graph log is the record.
- Model access goes through the provider interfaces in `@openreverie/providers`. Never call a provider SDK or HTTP API directly from other packages.
- Dream artifacts live at `dreams/<local-date>-<dreamId>/`, holding `dream.md`, `insight.md`, and `process.jsonl`, plus an append-only `dreams/log.jsonl` alongside them. Dream files are written once and never modified afterward, the same posture as the rest of the memory folder.

## Domain sensitivity

- Both safety modes (companion and firewall) exist by design and were deliberately chosen. Never remove, weaken, or bypass them, and never make crisis behavior "smarter" without explicit human sign-off.
- Never write code that could leak memory folder contents anywhere except the user's configured model provider. No telemetry, no analytics, no phoning home. Ever.
- A developer's own `.reverie/` data must never enter the repo. It is gitignored; keep it that way.

## Orchestration and token discipline

The main agent in a session acts as an orchestrator. It plans, decomposes, reviews, and talks to the human. It delegates the actual work (implementation, research, codebase exploration, audits, reviews) to subagents sized to the task, and it parallelizes independent work. Do not burn the expensive main-loop context on mechanical work a cheaper subagent can do. Pin an explicit model on every subagent: cheap models for mechanical and lookup work, mid-tier models for implementation and review, top-tier models only for the hardest judgment calls.

## Engineering practice

- TDD for deterministic logic (stores, graph log, indexer, rollup triggers, config). Write the failing test first.
- LLM-dependent behavior is tested with fixture transcripts and schema assertions, not golden text.
- Validate all LLM structured output with zod schemas at the boundary.
- Prose file writes are atomic (temp file, then rename). Graph log writes are single-line appends.
- Keep commits small and messages plain: what changed and why, no ceremony.

Review practices, learned the hard way here and not optional:

- **A reviewer runs the tests, the build, and the lint itself.** Do not accept an implementer's report as evidence that the suite passes. One task reported a fully passing suite while a test file was failing, and it went two tasks undetected because reviewers had been told the report already carried that evidence.
- **Falsify, do not read.** The recurring failure in this codebase is a test that passes for a reason unrelated to what it is named: an error-path test whose fake threw before any output accumulated, a status line test that passed with the wiring deleted, a narrative test asserting the body equals the new narrative, which is the bug recorded as the expectation. Delete the fix, watch the test fail, restore it. Reading tells you the code is right today; falsifying tells you it stays right.

  Two limits on falsification, both learned on 2026-08-24. It proves a test guards what it tests; it cannot reveal a case nobody wrote a test for. The real bug found that day (an empty-string `eventTime` writing a fabricated anchor into the search index) was found by reading, because every existing test covered the field being absent and none covered it being present and empty. And a test can fail under mutation while still being weaker than its name: one date-span test failed when the feature was deleted wholesale, yet passed when a living document's date was fabricated, because its own fixture had no such fields to fabricate from. When you falsify, mutate the specific behavior the test is named for, not just the whole feature.

- **Build before trusting a cross-package test, and remember a green suite is not a compile.** `packages/cli` resolves `@openreverie/core` through `dist/index.js`, not live `src`, and `core`, `cli`, and `server` all resolve `@openreverie/memory` the same way, because its `package.json` declares `main` as `dist/index.js` and nothing aliases the package to `src`. Editing one package's `src` and then running another package's tests without `pnpm build` in between silently tests stale compiled code, and it passes. This was hit live twice: a deliberately broken `toolDefinitions()` produced a green cli suite until the package was rebuilt (2026-08-24), and a falsification of the highest-stakes property in one dreaming task produced a false negative until `packages/memory` was rebuilt (2026-08-25). Separately, vitest does not typecheck at all, so a fully green test file can sit on a package that does not build: this hid two real TypeScript errors in `packages/cli` and one in `packages/server`, each a test fake that had quietly stopped satisfying an interface. Any result that crosses a package boundary is meaningless until `pnpm build` has run, and no package is sound until `pnpm exec tsc --noEmit` or `pnpm build` says so.
- **Never run `git stash` or a destructive `git reset` in a worktree shared with other agents.** This repository lost real work twice in one day (2026-08-25) to agents running exactly these commands against a worktree other agents were concurrently using. An agent's own harness in this same worktree now refuses compound bash commands touching git for exactly this reason, verifying every git operation stays scoped to its own worktree, which is live, present-day confirmation that the hazard is not hypothetical. If you need a clean state, create a new worktree or ask the human; do not stash or reset one shared with anyone else's in-flight work.
- **A test whose correctness depends on the machine's own timezone matching a hardcoded assumption is not a real guard.** This recurred three times in one day (2026-08-25): a private `isoDate` helper in two test files used the UTC date while the engine names session directories off the person's local date, passing for 18.5 hours a day in `Asia/Kolkata` and failing the other 5.5; a commitment timing test hardcoded an expected date and passed with the wiring deleted because the machine's system timezone happened to match the one it picked; and two "does not leak the wall clock into the prompt" guards check the UTC calendar date against a prompt rendered in `Asia/Kolkata`, vacuous for roughly 23% of any given day. When a test involves a date or a clock, either inject the clock and pin the timezone explicitly, or assert something true in every timezone, never something that happens to be true in the zone the test runs in today.
- **Prefer an allow-list (fail closed) over a deny-list (fail open) for a closed set of states.** Twice in one day (2026-08-25) code took the deny-list shape and both times it hid a real bug: `selectCommitments` excluded only the `'quiet'` state, so `'done'` and `'dropped'` commitments kept surfacing in the session prompt forever, under a header stating a commitment is never evidence the person did the thing; and `isTimeEligible` treated a commitment with no computable time window as always eligible rather than never eligible, the same "unhandled case defaults to admitted" shape one level down. Both were fixed to fail closed: a state or a case nobody has named yet defaults to excluded, and a future addition that should be visible has to be added on purpose, not discovered by its absence causing harm.

## Honesty about authorship

This codebase is built with heavy agent involvement, reviewed by a human. Do not obscure that, and do not add self-congratulatory attribution either. The code speaks for itself or it does not.
