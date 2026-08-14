# openreverie design spec

Date: 2026-08-13
Status: approved (brainstormed and confirmed section by section with the project owner)
Scope: sub-project 1 of the larger openreverie vision, the local-first memory engine and agent core behind a terminal CLI.

Amended in part by [the Phase A companion quality spec](2026-08-14-phase-a-companion-quality-design.md), which replaces the confirmation flow described in sections 2, 3, and 6 with save-by-default plus an explicit forget. Everything else here still stands.

## 1. Overview

openreverie is an open-source, self-hosted companion agent for personal reflection and mental wellbeing. The defining property is a layered memory that never forgets: verbatim transcripts at the bottom, extracted items and session summaries above them, daily and weekly rollups above those, and at the top a living constitution of the user, plus arcs (ongoing storylines) and realms (life domains) connected by an explicit graph. Every new conversation starts with this context already assembled, and the agent can reach deeper through retrieval tools.

The larger vision includes a web UI, multiple deployment targets (Cloudflare, VPS), many provider adapters, and graph visualization. This spec deliberately covers only the first sub-project. Decisions here should not paint later sub-projects into corners, which is why the provider layer is abstracted from day one and storage is behind interfaces.

## 2. Goals and non-goals

Goals:

- A memory engine whose truth is a human-readable folder the user owns.
- An agent that starts every session already knowing where the user's life stands.
- Reflection that runs without the user managing it: live capture plus post-session processing plus lazy rollups.
- A confirmation flow that keeps the user in control of how their record is structured.
- Two explicit safety modes chosen at setup.
- A provider abstraction that makes models hot-swappable via config.

Non-goals for this sub-project:

- Web UI, auth, or any network-facing surface. The CLI talks to a local process.
- Cloudflare or VPS deployment.
- Graph visualization UI (the data model supports it; no UI is built).
- Multi-user support. One install, one person.
- Monthly and yearly rollups (the pattern supports them; only daily and weekly ship).

## 3. Decisions log

| Decision | Choice |
| --- | --- |
| First sub-project | Local-first memory engine + agent core, CLI interface |
| Audience | Owner dogfoods it; repo public from day one with honest docs |
| Stack | TypeScript, Node 22+, pnpm monorepo |
| Source of truth | Files: markdown prose + append-only graph.jsonl; SQLite derived and rebuildable |
| Memory timing | Hybrid: live `remember` tool + canonical post-session reflection; lazy rollups |
| Attribution | Confidence split: auto-assert high-confidence links to existing arcs (reversible), queue proposals for new arcs and uncertain links |
| Providers | Interfaces from day one; OpenAI adapters first; per-provider model configurable |
| Safety | Two modes, companion (default suggestion) and firewall, chosen explicitly during setup |
| License | AGPL-3.0 |
| Name | openreverie; CLI binary `reverie`; domain reverie.my |

## 4. Architecture

One process, four packages, downward-only dependencies:

```
cli        Terminal chat REPL, setup wizard. Thin.
core       Conversation loop (streaming), context assembly,
           tool dispatch, safety mode enforcement.
memory     Stores (prose files, graph log), reflection pipeline,
           rollups, retrieval (semantic + FTS + graph), indexer.
providers  ChatProvider / EmbeddingProvider interfaces and adapters.
```

The memory engine knows nothing about conversations or specific providers; it consumes an EmbeddingProvider and exposes read, write, and search operations. The CLI is replaceable by a web UI later without touching core or memory.

On-disk layout:

- `~/.reverie/memory/` holds all user data (the layout in section 5) and is a git repository of its own; the engine auto-commits after each write cycle.
- `~/.reverie/config.toml` holds provider choice, per-provider model names, API keys or env var references, safety mode, and crisis resources.
- `reverie setup` is the first-run wizard: provider, key, model, safety mode (explicit choice, no silent default), crisis resource defaults offered.

## 5. Memory model

### Prose documents

Markdown with YAML frontmatter; every document has a ULID.

- `constitution.md`: the living record of the user. Identity, values, current life snapshot, standing preferences for how the agent behaves. Rewritten by reflection only when something rises to that level; history preserved via git.
- `realms/*.md`: one per life domain (health, career, relationships, and whatever else emerges). Narrative overview of the domain's current state.
- `arcs/*.md`: one per ongoing storyline, positive or negative. Frontmatter: status (active, dormant, closed), opened and closed dates, realm. Body: evolving narrative.
- `sessions/YYYY-MM-DD-<ulid>/transcript.jsonl`: verbatim message log, appended during conversation, never modified afterward.
- `sessions/YYYY-MM-DD-<ulid>/summary.md`: reflection output. Frontmatter carries the extracted items; body is the narrative summary.
- `rollups/daily/YYYY-MM-DD.md` and `rollups/weekly/YYYY-Www.md`: period synthesis. Weeklies are built from dailies, not raw transcripts, to bound cost.
- `proposals.jsonl`: the pending proposal queue (see section 7).

### Items

The atomic memory unit: one observation, feeling, event, or intention extracted from a session. Items live as structured frontmatter entries in their session's summary (id, text, timestamp, kind), not as one file each. Items are what embeddings index and what attributions attach to.

### Graph

`graph.jsonl` is an append-only log of assertions about structure. Example line:

```json
{"ts":"2026-08-13T21:04:11Z","op":"assert","edge":"part_of","from":"item_01J...","to":"arc_marathon","confidence":0.92,"source":"session_...","confirmed":false}
```

- Ops: `assert` and `retract`. Nothing is overwritten; current state is the fold of the log. This gives relationship history for free.
- Node types (v1, deliberately tiny): realm, arc, item, session, person, entity (escape hatch).
- Edge types: `part_of` (item to arc), `in` (arc to realm), `from` (item to session), `involves` (item to person), `relates_to` (anything to anything, the escape hatch).
- Every edge carries timestamp, confidence, source session, and a confirmed flag.
- Discipline: prose mentions of relationships are testimony, never load-bearing. If a summary claims a connection with no matching edge, reflection's job is to propose the edge.

### Index

`index.db` (SQLite) is derived and disposable: FTS5 over prose, vectors over items and document chunks (via the EmbeddingProvider), and materialized node and edge tables folded from graph.jsonl. `reverie reindex` rebuilds it from the folder byte-for-byte equivalently. Nothing exists only in the index.

## 6. Memory pipeline

Live, mid-session: the agent has a `remember` tool for urgent or explicit captures. Items land in a session-scoped scratch list; obvious high-confidence edges may be asserted immediately.

Post-session reflection (canonical), triggered on session end: a separate LLM call receives the full transcript plus current arc and realm listings and produces, validated by zod schemas:

1. The session summary and deduplicated item list (merged with live captures).
2. Proposed graph operations. High-confidence attributions to existing arcs are asserted immediately with `confirmed: false` (reversible). New arcs, new persons of significance, and uncertain links go to `proposals.jsonl`.
3. Narrative updates for arcs that received new items.
4. Constitution deltas, rarely, only when something rises to that level.

Next session start: pending proposals are woven into the agent's opening conversationally (for example, "a few things last time felt like a new thread about X; want me to track that?"). Accept, reject, and rename decisions land as confirmed edges or retractions.

Lazy rollups on engine start: any completed day with sessions but no daily rollup gets one; completed weeks likewise, built from dailies.

Every write cycle ends with reindex of affected documents and a git commit of the memory folder.

## 7. Agent loop, context, tools

Context assembled fresh at session start: persona and safety mode, full constitution, realm index (names and one-line states), active arcs (name, status, last touched), most recent daily rollup, previous day's session summaries, pending proposals. A few thousand tokens, always included.

Tools (all read paths hit the local index; no network):

- `search_memory(query, filters?)`: hybrid semantic plus FTS retrieval over items, summaries, rollups, arc and realm pages; filters for date range, kind, realm, arc.
- `graph_query(...)`: node neighbors, items in an arc, arcs touching a person, paths between nodes.
- `read_document(id)` and `read_transcript(session_id)`: full fidelity on demand.
- `remember(text, kind?)`: live capture.
- `list_arcs()` and `list_realms()`: cheap orientation.

The loop is a standard streaming tool-call loop. Behavioral rule in the persona: retrieve before asserting. When conversation touches an arc or a past event, search or read first rather than answering from rollup gist, so details come from the record, not confabulation.

## 8. Provider layer

Interfaces from day one:

- `ChatProvider`: streaming chat completion with tool calling.
- `EmbeddingProvider`: batch text embedding.

Adapters implement these per vendor; config selects adapter and model per role (chat, reflection, embeddings), so reflection can run on a cheaper model than conversation. OpenAI adapters ship first. Planned next: Anthropic, OpenRouter, Cloudflare AI Gateway, DeepSeek, and local (Ollama and OpenAI-compatible endpoints). No package other than providers may call a vendor SDK or API directly. All adapters must pass the same contract test suite against recorded fixtures.

## 9. Safety modes

Both modes exist from day one. Setup forces an explicit choice; config can change it later. Detection of crisis territory (self-harm, acute distress) is the model's judgment guided by the persona prompt, not a keyword filter, because keyword filters false-positive on exactly the heavy-but-healthy conversations this tool exists for.

- Companion mode (suggested default in wizard copy): the agent is a reflective companion, not a therapist, and says so. In crisis territory it stays present, keeps listening, responds with warmth, and gently and persistently surfaces crisis resources and real humans. Nothing refused; the tone shifts.
- Firewall mode: in crisis territory the agent states plainly that this is beyond what it should handle, points immediately and concretely to crisis resources and professional help, and declines to continue that thread until the topic shifts. Firm and warm, not cold.

Crisis resources are configurable in config.toml (region-appropriate hotlines, optionally a trusted contact); US and international defaults ship. Reflection still runs on hard sessions in both modes; the record does not go blind, only the conversational posture differs. The README states all of this honestly.

## 10. Resilience and error handling

Prime directive: never lose what the user said. Transcript lines are appended to disk as they happen, before any other processing.

- Reflection failure (API error, invalid output, interrupt): session marked unreflected in frontmatter; retried on next engine start. Reflection is idempotent.
- Structured output: zod validation; one retry with the validation error fed back; then fall back to summary-only so a session is never stuck.
- Crash mid-write: prose writes are atomic (temp file then rename); graph appends are single lines; index is rebuildable via `reverie reindex`.
- Provider outage: local memory reads still work; the CLI says plainly that the model is unreachable rather than half-working.
- Git commit failure: warn and continue; versioning is a safety net, not a dependency.

## 11. Testing

- Unit tests (TDD): store round-trips, graph log fold (assert, retract, materialize), indexer rebuild fidelity (delete index.db, rebuild, identical query results), lazy rollup triggers, proposal queue lifecycle, config parsing.
- Provider contract tests: one suite, recorded fixtures, every adapter passes it.
- End-to-end reflection harness: synthetic fixture transcripts in, assertions on structure out (items extracted, valid graph ops, schema conformance). No golden-text assertions on LLM prose.
- Fixtures are always synthetic. Real personal data never enters the repo.

## 12. Later sub-projects (context, not commitments)

1. Web interface and local auth.
2. Additional provider adapters.
3. Cloudflare and VPS deployment targets (storage interfaces already isolate what must be reimplemented).
4. Graph visualization (data model already supports it).
5. Monthly and yearly rollups.
