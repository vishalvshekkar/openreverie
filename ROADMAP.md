# Roadmap

This file tracks what openreverie can do, what is being worked on, and where help is welcome. It is kept honest the same way the README is: nothing here is claimed as done unless it works.

## Done (v0.1.0 through v0.3.1)

Sub-project 1 of 5: the local-first memory engine and agent core, usable as a terminal app. See the README for the full capability list and the [design spec](docs/superpowers/specs/2026-08-13-openreverie-design.md) for how it all fits together.

v0.2.0 added, from the first round of real dogfooding: a close-friend conversational voice replacing the consultant register, three style preferences (engagement, tone, orientation) chosen at setup and changeable mid-conversation with immediate effect, a guided first conversation, speaker colors in the terminal, honest tool notices, and reliable capture of basic identity facts into the constitution.

v0.3.0 removed the confirmation step from reflection. Asking permission to remember does not fit a companion whose defining property is that it remembers, so new arcs, new people, and every attribution are now saved right away instead of waiting in a proposal queue. Person pages joined arcs as a narrative document reflection maintains. Reverie now speaks first at the start of a session instead of waiting to be spoken to, a status line shows when the model or a tool is working, and an abandoned session with no typing costs nothing (no reflection call, no rollup). This release also fixed a real defect: reflection used to overwrite an arc's narrative without reading the one already there, replacing accumulated narrative every session instead of growing it; it now reads the current body first and carries it forward. A forget feature (retracting a node or edge and rewriting the documents it touches) was built and tested this release, then deliberately held back by the owner's decision until two gaps close; see the deferred list below.

v0.3.1 finished the job v0.3.0 started: the persona no longer raises pending proposals, no longer asks whether to keep something, and `resolve_proposal` is gone from the tool list, so the model has no way left to ask. Asking permission to remember did not fit a companion whose defining property is that it remembers. Capture also widened: reflection now mints a node, using the existing person or entity type, for anyone or anything with a real part in the owner's life (a partner as much as a public figure they keep returning to, a company as much as a film), while a maintained page stays earned separately, granted only once someone recurs across sessions or clearly matters within one. A node-only person can be promoted to a page later. The session prompt now surfaces known people and entities by name and page status, and recent intentions, so the companion does not need to search for what it already knows. Legacy proposal queues from before this release drain silently on open instead of stranding anyone who upgrades.

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
- **Real date metadata on search hits.** Date filtering currently derives dates from file paths; a meta-date field on indexed documents would be cleaner (`packages/memory/src/retrieval.ts` documents the limitation).
- **Advisory locking for the memory folder.** Two engines opened on the same folder do not corrupt anything, but they can double-reflect a stale session. A lock file would prevent it.
- **Local embedding option.** An `EmbeddingProvider` backed by a local model would keep the search index fully offline.
- **Exposing the forget feature.** The engine method exists and is tested, but two gaps need closing before any tool or persona instruction can reach it: retracting a person's node currently leaves their page on disk and fully searchable, and a forget call touching more than one document is not atomic.
- **Retiring the proposal machinery further.** `resolve_proposal` is already gone. What remains is the `proposals.jsonl` file format, the silent drain that runs on every `open()`, and `materializeProposal`, all kept for the compatibility promise to folders written before save-by-default. Once that promise is no longer needed, this can come out too.
- **A deterministic significance threshold for person pages**, if leaving the judgment of who is worth a page to reflection's model call proves too loose in practice.
- **Merging person aliases.** If the same human ends up with more than one person node (different names or spellings across sessions), there is no way yet to merge them.
- **A duplicate arc from a retried reflection.** If reflection's document writes partly fail and the session is retried, the retry can create a second arc with a `-2` suffixed page rather than resuming the first. This is a deliberate trade: a visible duplicate you can merge by hand beats a silent, permanent loss of what reflection found.
- **Warnings dropped mid-session.** A failed reindex during a live conversation (for instance, from a `remember` call) is pushed to the engine's warning list, but nothing drains that list before session end clears it, so the warning never reaches you. This is a systemic gap in how warnings are surfaced, not something specific to this release.
- **Reflection's per-document error guard is one statement too wide.** `resolveNarratives` in `packages/memory/src/reflection.ts` wraps a pure in-memory computation inside the same `try` that guards the file read and the model call, so a programming error there would be treated as "skip this document" instead of surfacing. The guard should cover only the two operations that can genuinely fail on a user's machine.
- **`reverie read` reports only the first unreadable file** that matches what you typed. If two pages are broken and both match, you hear about one of them.
- **The `/bye` message can be slightly wrong in a narrow window.** If reflection fails after the session summary has already been written (during the graph sync, the constitution read, or an arc read), reverie says the session will be reflected next time it starts, when in fact it already counts as reflected. Nothing is lost either way and what is on disk is correct, but the sentence is not true in that case.
- **A `pagePromotions` entry can lose a race against `newPersons` in the same session and be dropped with nothing to fall back on.** If a person is promoted to a page earlier in the same reflection output, a `pagePromotions` entry for that same person (now already paged) is dropped rather than attached, so its `itemIndexes` never become `involves` edges at all.
- **A relisted paged person's `personUpdates` note is silently dropped.** Their items and edges still land, but the note describing what this session added to their page is discarded, so the page itself does not learn what was said about them.
- **`sessionContext` does not dedupe people or entities by label.** Two graph nodes that happen to share a label (the escape-hatch fix for two different people with the same name is a legitimate reason this can now happen) render as two identical-looking lines in the People or Entities section, distinguishable only by id.
- **An arc touched only by attribution carries no `lastTouched`.** `arcUpdates` sets it, but attaching an item to an arc through `attributions` alone does not, so an arc that was actually just talked about can still look untouched to the greeting's "arc gone quiet" logic.
- **People and entities are capped and ordered by first mention, not last mention.** The `ts` on a person or entity node is set once, when the node is created, and nothing that attaches later items to it (`attachItemsToNode`) refreshes that `ts`. So the cap's recency order is really "created most recently," not "come up most recently": someone mentioned once two years ago and never since can, in principle, sort above someone who comes up every week but was first mentioned earlier. A fix needs a real last-touched signal on the node, not just its creation `ts`.

## How work happens here

This project is built with heavy use of AI coding agents under human direction, with per-task adversarial review. The bar for merged code is the same regardless of who or what wrote it: understood, tested, and honest. If you pick something up, open an issue first so nobody duplicates effort.
