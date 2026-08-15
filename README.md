# openreverie

A self-hosted companion agent with a memory that does not forget.

openreverie is an open-source agent you run on your own machine. You talk to it about what you are dealing with and working toward: struggles, plans, patterns, good things and hard things. It remembers all of it, organizes it into an evolving record of your life, and brings that context into every new conversation. It is built for personal reflection and mental wellbeing, and it is yours: your data lives in a folder you own, readable in any text editor, versioned with git.

Website: [reverie.my](https://reverie.my)

## Status

**Usable as a terminal app and a local web interface. v0.4.0 is the first release that ships a browser UI alongside the terminal CLI.**

What works today:

- Terminal chat with persistent, layered memory (constitution, realms, arcs, people, session transcripts)
- Live capture during a conversation (the agent can call `remember` mid-session)
- Reverie speaks first. A session opens with a short, model-written hello instead of waiting for you to type. Reverie is instructed to lead with anything left unresolved from last time or notable in the recent record, and to keep it to a plain hello otherwise, but that is guidance to the model, not a guarantee of what it actually says. If the model is unreachable or the call times out, the greeting is skipped silently and the session just opens at the prompt. A first conversation still gets the guided flow, not this.
- Person and entity nodes, captured generously: reflection is instructed to create a node the moment someone or something with a real part in your life is mentioned, whether or not it ever gets a page, but that is guidance to the model, not a guarantee it always does. A person earns a page (a narrative document under `people/` that reflection maintains) only when they recur across sessions or clearly mattered within one; a person captured as a node only can still gain a page later, once they recur. Entities (books, films, companies, places, and the like) get a node only; they do not get a page in this release.
- Post-session reflection: each session is summarized and filed into memory directly. New arcs, new people, new entities, page promotions, and every attribution (whatever the model's confidence) are saved right away: nothing is held back for your review, and nothing saved this way can be undone through the product (see below). A memory folder from an earlier release may still carry pending proposals from before proposal generation was retired; those are now materialized and resolved automatically the moment the engine opens, silently, with no review step, so they no longer wait for `resolve_proposal`
- Lazy daily and weekly rollups, built the first time enough time has passed to need them
- Both safety modes (companion and firewall)
- A first-run setup wizard
- The `reindex`, `reflect`, and `read` CLI subcommands. `read` works with no network call and no API key: it is a plain filesystem read of your memory record
- A local web interface, `reverie web`, serving the same record in a browser. The server binds to `127.0.0.1` only and admits you through a single-use bootstrap token that is generated fresh each run and expires five minutes after startup. Browsing records, people, sessions, and transcripts works with no API key configured; chat in the browser works when a provider is configured. Pending legacy proposals are readable in the interface. The command prints the bootstrap URL and does not open your browser for you.
- Sessions you start in the browser stay live while the server runs, then become read-only after it restarts. Their transcripts remain browsable after the restart.
- A status line while the model or a tool is working, so a slow call looks slow rather than stuck. It only appears when the terminal supports color; a piped or non-interactive session gets none.
- Opening a session and leaving without typing anything costs nothing: no reflection call, no rollup
- The OpenAI provider

The Phase B atlas renders the graph of realms, arcs, people, entities, items, and sessions as an interactive node view.

The atlas in v0.4.0 has deterministic temporary layout, pan and zoom, type filtering, selection, and an accessible node list. It does not yet include saved graph positions, graph search, realm influence, progressive labels, or a history time lens.

What does not exist yet:

- Providers other than OpenAI
- Any deployment target beyond running it yourself (no Cloudflare or VPS packaging)
- Saved graph positions, graph search, realm influence, progressive labels, or a history time lens in the atlas (see above)
- Pages for entities: they get a node in the graph, not a maintained document, in this release
- Monthly and yearly rollups (only daily and weekly exist)
- Any way to make reverie forget. The feature exists in code and is tested, but it is deliberately unexposed: no tool, no persona instruction, and no CLI command reaches it. Deleting or editing a page under `people/` or `arcs/` removes the prose, but not the record: the node it corresponds to, its edges, and every attribution that named it still live in `graph.jsonl`, nothing in the product retracts them, and the agent can still surface what the graph knows about a person or arc whose page you deleted. Running `reindex` does clear the deleted page's stale rows out of the search index, so it stops turning up in `search_memory` hits, but `reindex` rebuilds the graph from `graph.jsonl` exactly as it already was, so the node and its edges come straight back. There is currently no user-accessible way to remove a node, an edge, or an attribution at all.

The architecture and memory model are specified in full in [the design spec](docs/superpowers/specs/2026-08-13-openreverie-design.md). This README is updated honestly as the project progresses; if this section says something works, it works.

## Usage

```
pnpm install
pnpm build
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js
node packages/cli/dist/index.js web
```

`setup` runs a first-run wizard that asks for your provider API key, your safety mode, and where you want your memory folder to live, then writes a config file. Run it once before anything else.

With no arguments, the same binary starts the terminal chat REPL, loading your existing memory (constitution, arcs, recent context) into the conversation. A few more subcommands are available:

- `web`: starts the local web interface and prints its bootstrap URL. The server listens on `127.0.0.1` only, so only processes on your own machine can reach it. Copy the printed URL into your browser to start; the command does not open the browser for you.
- `reindex`: rebuilds the SQLite search index from your memory folder from scratch. Safe to run any time; the index is always derived and disposable.
- `reflect`: runs maintenance on demand (reflects any stale unreflected sessions, builds any daily or weekly rollups that are due) instead of waiting for it to happen automatically.
- `read`: prints part of your memory record straight from the files on disk. With no arguments it lists your constitution, arcs, realms, and people; `read constitution` prints the constitution in full; `read arc <name>`, `read realm <name>`, and `read person <name>` print one document by a case-insensitive substring match on its name. This is a plain filesystem read: it works even with no model provider configured or reachable, since seeing what is being kept about you should never depend on the network being up.

## Why this exists

Tools that hold your most personal thoughts should not live on someone else's servers under someone else's business model. openreverie is self-hosted and open source. The one honest caveat: when you use a hosted model provider (OpenAI, Anthropic, and others), your conversation text is sent to that provider for inference. The provider layer is swappable by design so that local models can close that gap for people who want it fully private.

## How it works

Your memory is a folder. Prose lives in markdown files, structure lives in an append-only graph log, and a SQLite index over both is derived and disposable.

```
memory/
├── constitution.md   A living record of who you are
├── realms/           Life domains (health, career, ...)
├── arcs/             Ongoing storylines, positive and negative
├── people/           People who recur or clearly matter, each with a narrative page
├── sessions/         Verbatim transcripts and session summaries
├── rollups/          Daily and weekly synthesis
├── graph.jsonl       Timestamped relationships between all of it
└── index.db          Rebuildable search index (FTS + vectors)
```

Each conversation starts with your constitution, active arcs, and recent context already loaded. The agent retrieves deeper memory through tools: semantic search, keyword search, graph traversal, and full transcript reads. After each session, a reflection pass extracts what mattered and saves it directly: new arcs, new people and entities as nodes, page promotions for a person who has come to recur, updated arc and person narratives, and every attribution, unconfirmed but not held back for approval. A companion that remembers should not have to ask permission to remember. Nothing you said is ever deleted or rewritten; transcripts are append-only.

## What it is not

openreverie is not a therapist and does not diagnose or treat anything. It is a reflective companion. At first-run setup you choose one of two safety modes for moments of acute distress: **companion** (stays present, gently and persistently points to real help) or **firewall** (declines to engage further with crisis topics and immediately points to real help). Crisis resource contacts are configurable. If you are in crisis now, please reach a human: in the US, call or text 988; elsewhere, [findahelpline.com](https://findahelpline.com).

## Architecture

TypeScript monorepo, six packages, strict downward-only dependencies:

| Package | Purpose |
| --- | --- |
| `openreverie` (cli) | Terminal chat, the `reverie setup` wizard, and the `reverie web` launcher |
| `@openreverie/server` | Loopback HTTP server: bootstrap auth, record/graph/session APIs, live streaming, and static asset serving |
| `@openreverie/web` | The browser client (React). Talks to `@openreverie/server` over HTTP only; never imports runtime engine packages |
| `@openreverie/core` | Agent loop, context assembly, tools, safety modes |
| `@openreverie/memory` | Stores, reflection pipeline, rollups, retrieval, indexer |
| `@openreverie/providers` | Chat and embedding provider interfaces, swappable adapters (OpenAI first) |

Dependencies point downward only. `cli` and `server` are sibling outer interfaces that both depend on `core`, which depends on `memory`, which depends on `providers`. `cli` also depends on `server` to launch the web interface. `web` depends on nothing in the engine and reaches the server over HTTP alone.

## Roadmap

1. Memory engine and agent core behind a terminal CLI (done, v0.1.0)
2. Web interface and local auth (done, v0.4.0)
3. More provider adapters (Anthropic, OpenRouter, Cloudflare AI Gateway, DeepSeek, local models)
4. Alternate deployment targets (Cloudflare, VPS)
5. Phase C atlas polish (saved graph positions, graph search, realm influence, progressive labels, history time lens)

Ongoing work, remaining tasks, and contributor-friendly starting points live in [ROADMAP.md](ROADMAP.md).

## Development

This project is built with heavy use of AI coding agents, directed and reviewed by a human. That is stated plainly because you deserve to know how the code you might trust with your inner life gets written. Agent instructions live in [AGENTS.md](AGENTS.md) and the design lives in the spec; both are kept current.

Contributions are welcome from people who know what they are doing. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; this codebase serves a sensitive purpose and casual drive-by changes carry real risk for its users.

## License

[AGPL-3.0](LICENSE). You can run it, change it, and share it. If you host a modified version for others, you must share your changes.
