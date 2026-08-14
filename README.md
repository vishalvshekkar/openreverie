# openreverie

A self-hosted companion agent with a memory that does not forget.

openreverie is an open-source agent you run on your own machine. You talk to it about what you are dealing with and working toward: struggles, plans, patterns, good things and hard things. It remembers all of it, organizes it into an evolving record of your life, and brings that context into every new conversation. It is built for personal reflection and mental wellbeing, and it is yours: your data lives in a folder you own, readable in any text editor, versioned with git.

Website: [reverie.my](https://reverie.my)

## Status

**Usable as a terminal app. Everything else in the roadmap is still ahead.**

What works today:

- Terminal chat with persistent, layered memory (constitution, realms, arcs, session transcripts)
- Live capture during a conversation (the agent can call `remember` mid-session)
- Post-session reflection: each session is summarized, filed into memory, and produces confidence-split proposals (high-confidence links are asserted automatically as unconfirmed; everything else waits for you to accept or reject it)
- Lazy daily and weekly rollups, built the first time enough time has passed to need them
- Both safety modes (companion and firewall)
- A first-run setup wizard
- The `reindex` and `reflect` CLI subcommands
- The OpenAI provider

What does not exist yet:

- A web UI (terminal only, for now)
- Providers other than OpenAI
- Any deployment target beyond running it yourself (no Cloudflare or VPS packaging)
- Graph visualization of realms, arcs, and their connections
- Monthly and yearly rollups (only daily and weekly exist)

The architecture and memory model are specified in full in [the design spec](docs/superpowers/specs/2026-08-13-openreverie-design.md). This README is updated honestly as the project progresses; if this section says something works, it works.

## Usage

```
pnpm install
pnpm build
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js
```

`setup` runs a first-run wizard that asks for your provider API key, your safety mode, and where you want your memory folder to live, then writes a config file. Run it once before anything else.

With no arguments, the same binary starts the terminal chat REPL, loading your existing memory (constitution, arcs, recent context) into the conversation. Two more subcommands are available:

- `reindex`: rebuilds the SQLite search index from your memory folder from scratch. Safe to run any time; the index is always derived and disposable.
- `reflect`: runs maintenance on demand (reflects any stale unreflected sessions, builds any daily or weekly rollups that are due) instead of waiting for it to happen automatically.

## Why this exists

Tools that hold your most personal thoughts should not live on someone else's servers under someone else's business model. openreverie is self-hosted and open source. The one honest caveat: when you use a hosted model provider (OpenAI, Anthropic, and others), your conversation text is sent to that provider for inference. The provider layer is swappable by design so that local models can close that gap for people who want it fully private.

## How it works

Your memory is a folder. Prose lives in markdown files, structure lives in an append-only graph log, and a SQLite index over both is derived and disposable.

```
memory/
├── constitution.md        A living record of who you are
├── realms/                Life domains (health, career, ...)
├── arcs/                  Ongoing storylines, positive and negative
├── sessions/              Verbatim transcripts and session summaries
├── rollups/               Daily and weekly synthesis
├── graph.jsonl            Timestamped relationships between all of it
└── index.db               Rebuildable search index (FTS + vectors)
```

Each conversation starts with your constitution, active arcs, and recent context already loaded. The agent retrieves deeper memory through tools: semantic search, keyword search, graph traversal, and full transcript reads. After each session, a reflection pass extracts what mattered, updates arc narratives, and proposes new connections, which you confirm or reject conversationally. Nothing you said is ever deleted or rewritten; transcripts are append-only.

## What it is not

openreverie is not a therapist and does not diagnose or treat anything. It is a reflective companion. At first-run setup you choose one of two safety modes for moments of acute distress: **companion** (stays present, gently and persistently points to real help) or **firewall** (declines to engage further with crisis topics and immediately points to real help). Crisis resource contacts are configurable. If you are in crisis now, please reach a human: in the US, call or text 988; elsewhere, [findahelpline.com](https://findahelpline.com).

## Architecture

TypeScript monorepo, four packages, strict downward-only dependencies:

| Package | Purpose |
| --- | --- |
| `openreverie` (cli) | Terminal chat and the `reverie setup` wizard |
| `@openreverie/core` | Agent loop, context assembly, tools, safety modes |
| `@openreverie/memory` | Stores, reflection pipeline, rollups, retrieval, indexer |
| `@openreverie/providers` | Chat and embedding provider interfaces, swappable adapters (OpenAI first) |

## Roadmap

1. Memory engine and agent core behind a terminal CLI (current)
2. Web interface and local auth
3. More provider adapters (Anthropic, OpenRouter, Cloudflare AI Gateway, DeepSeek, local models)
4. Alternate deployment targets (Cloudflare, VPS)
5. Graph visualization of realms, arcs, and their connections

## Development

This project is built with heavy use of AI coding agents, directed and reviewed by a human. That is stated plainly because you deserve to know how the code you might trust with your inner life gets written. Agent instructions live in [AGENTS.md](AGENTS.md) and the design lives in the spec; both are kept current.

Contributions are welcome from people who know what they are doing. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; this codebase serves a sensitive purpose and casual drive-by changes carry real risk for its users.

## License

[AGPL-3.0](LICENSE). You can run it, change it, and share it. If you host a modified version for others, you must share your changes.
