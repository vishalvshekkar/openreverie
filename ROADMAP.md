# Roadmap

This file tracks what openreverie can do, what is being worked on, and where help is welcome. It is kept honest the same way the README is: nothing here is claimed as done unless it works.

## Done (v0.1.0)

Sub-project 1 of 5: the local-first memory engine and agent core, usable as a terminal app. See the README for the full capability list and the [design spec](docs/superpowers/specs/2026-08-13-openreverie-design.md) for how it all fits together.

v0.2.0 added, from the first round of real dogfooding: a close-friend conversational voice replacing the consultant register, three style preferences (engagement, tone, orientation) chosen at setup and changeable mid-conversation with immediate effect, a guided first conversation, speaker colors in the terminal, honest tool notices, and reliable capture of basic identity facts into the constitution.

## Up next (sub-projects, in intended order)

These are the large pieces from the original design, each sized like its own project. Open an issue before starting one of these; they need design conversation first.

2. **Web interface and local auth.** A proper chat UI served by the engine, replacing nothing (the CLI stays) but making daily use gentler. Needs an engine-facing API layer and a session auth story for a machine you own.
3. **More provider adapters.** The interfaces are in `@openreverie/providers` (`ChatProvider`, `EmbeddingProvider`) and the factory has one switch statement waiting for company: Anthropic, OpenRouter, Cloudflare AI Gateway, DeepSeek, and local models (Ollama and OpenAI-compatible endpoints). Every adapter must pass the same contract tests. This is the most contributor-friendly large item.
4. **Alternate deployment targets.** Cloudflare (Workers, D1 or Durable Objects storage, Vectorize) and VPS packaging. The storage layer is behind interfaces for exactly this reason, but this is a real porting effort.
5. **Graph visualization.** The data has been accumulating in `graph.jsonl` since the first conversation; nothing renders it yet.

## Smaller improvements, help welcome

Good first contributions, roughly ordered by usefulness. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) first.

- **Graceful handling of a corrupt constitution.md.** A hand-mangled arc or realm file is skipped with a warning, but a corrupt constitution still crashes engine startup loudly. It should degrade with a clear message instead.
- **Monthly and yearly rollups.** Daily and weekly exist; the pattern extends naturally (`packages/memory/src/rollups.ts`).
- **A `list_proposals` tool.** Pending proposals reach the agent through the session context; a tool to re-list them mid-conversation would help long sessions.
- **Real date metadata on search hits.** Date filtering currently derives dates from file paths; a meta-date field on indexed documents would be cleaner (`packages/memory/src/retrieval.ts` documents the limitation).
- **Advisory locking for the memory folder.** Two engines opened on the same folder do not corrupt anything, but they can double-reflect a stale session. A lock file would prevent it.
- **Skip reflection for empty sessions.** A session with no user messages still spends a reflection call.
- **Local embedding option.** An `EmbeddingProvider` backed by a local model would keep the search index fully offline.
- **Person pages.** People get graph nodes and involves-edges today, but no narrative page the way arcs have; a per-person document the agent maintains would make "what's been going on with X" richer.
- **Proactive session greeting.** Reverie currently waits for the user's first message. A session should open with a short, contextually written hello from reverie itself, and when something is pressing (a pending proposal, a thread left mid-air last time, a day that sounded hard), gently kick the conversation off with it.

## How work happens here

This project is built with heavy use of AI coding agents under human direction, with per-task adversarial review. The bar for merged code is the same regardless of who or what wrote it: understood, tested, and honest. If you pick something up, open an issue first so nobody duplicates effort.
