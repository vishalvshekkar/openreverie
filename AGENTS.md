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

- Four packages with downward-only dependencies: `cli` -> `core` -> `memory` -> `providers`. Never import upward or sideways around this order.
- Truth lives in the user's memory folder: markdown prose files plus the append-only `graph.jsonl`. SQLite is a derived index and must always be rebuildable from the folder. Never store anything only in SQLite.
- Transcripts are sacred. Append-only, never modified, never deleted by code.
- Relationship claims in prose are testimony, not record. The graph log is the record.
- Model access goes through the provider interfaces in `@openreverie/providers`. Never call a provider SDK or HTTP API directly from other packages.

## Domain sensitivity

- Both safety modes (companion and firewall) exist by design and were deliberately chosen. Never remove, weaken, or bypass them, and never make crisis behavior "smarter" without explicit human sign-off.
- Never write code that could leak memory folder contents anywhere except the user's configured model provider. No telemetry, no analytics, no phoning home. Ever.
- A developer's own `.reverie/` data must never enter the repo. It is gitignored; keep it that way.

## Engineering practice

- TDD for deterministic logic (stores, graph log, indexer, rollup triggers, config). Write the failing test first.
- LLM-dependent behavior is tested with fixture transcripts and schema assertions, not golden text.
- Validate all LLM structured output with zod schemas at the boundary.
- Prose file writes are atomic (temp file, then rename). Graph log writes are single-line appends.
- Keep commits small and messages plain: what changed and why, no ceremony.

## Honesty about authorship

This codebase is built with heavy agent involvement, reviewed by a human. Do not obscure that, and do not add self-congratulatory attribution either. The code speaks for itself or it does not.
