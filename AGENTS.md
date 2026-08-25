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

Three review practices, learned the hard way here and not optional:

- **A reviewer runs the tests, the build, and the lint itself.** Do not accept an implementer's report as evidence that the suite passes. One task reported a fully passing suite while a test file was failing, and it went two tasks undetected because reviewers had been told the report already carried that evidence.
- **Falsify, do not read.** The recurring failure in this codebase is a test that passes for a reason unrelated to what it is named: an error-path test whose fake threw before any output accumulated, a status line test that passed with the wiring deleted, a narrative test asserting the body equals the new narrative, which is the bug recorded as the expectation. Delete the fix, watch the test fail, restore it. Reading tells you the code is right today; falsifying tells you it stays right.
- **A green test suite does not mean the package compiles, and editing `memory/src` does not mean a `core` or `cli` test sees the edit.** Vitest does not typecheck. A test file can be fully green while its package fails to build: this hid two real TypeScript errors in `packages/cli` and one in `packages/server`, each a test fake that had stopped satisfying an interface, while 59 tests passed anyway. Run `pnpm exec tsc --noEmit` in a package, or `pnpm build`, before believing a package is sound. Separately, tests in `core`, `cli`, and `server` resolve `@openreverie/memory` through its compiled `dist`, not its source, because its `package.json` declares `main` as `dist/index.js` and nothing aliases the package to `src`. Editing `packages/memory/src` and re-running a `core` test is silently a no-op: the test still runs against the old `dist`. This produced a false negative on the highest-stakes property falsified in one task. Run `pnpm exec tsc -b` in `packages/memory`, or a full build, between editing `memory` and running a test outside it.

## Honesty about authorship

This codebase is built with heavy agent involvement, reviewed by a human. Do not obscure that, and do not add self-congratulatory attribution either. The code speaks for itself or it does not.
