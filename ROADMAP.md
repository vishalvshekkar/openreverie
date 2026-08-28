# Roadmap

This file tracks what openreverie can do and what is being worked on now. It is kept honest the same way the README is: nothing here is claimed as done unless it works. Everything not yet started, deferred work, known gaps, and ideas not built, lives in [BACKLOG.md](BACKLOG.md), which is canonical for all of that.

## Done (v0.1.0 through v0.8.0)

Sub-project 1 of 5: the local-first memory engine and agent core, usable as a terminal app. See the README for the full capability list and the [design spec](docs/superpowers/specs/2026-08-13-openreverie-design.md) for how it all fits together.

v0.2.0 added, from the first round of real dogfooding: a close-friend conversational voice replacing the consultant register, three style preferences (engagement, tone, orientation) chosen at setup and changeable mid-conversation with immediate effect, a guided first conversation, speaker colors in the terminal, honest tool notices, and reliable capture of basic identity facts into the constitution.

v0.3.0 removed the confirmation step from reflection. Asking permission to remember does not fit a companion whose defining property is that it remembers, so new arcs, new people, and every attribution are now saved right away instead of waiting in a proposal queue. Person pages joined arcs as a narrative document reflection maintains. Reverie now speaks first at the start of a session instead of waiting to be spoken to, a status line shows when the model or a tool is working, and an abandoned session with no typing costs nothing (no reflection call, no rollup). This release also fixed a real defect: reflection used to overwrite an arc's narrative without reading the one already there, replacing accumulated narrative every session instead of growing it; it now reads the current body first and carries it forward. A forget feature (retracting a node or edge and rewriting the documents it touches) was built and tested this release, then deliberately held back by the owner's decision until two gaps close; see the deferred list below.

v0.3.1 finished the job v0.3.0 started: the persona no longer raises pending proposals, no longer asks whether to keep something, and `resolve_proposal` is gone from the tool list, so the model has no way left to ask. Asking permission to remember did not fit a companion whose defining property is that it remembers. Capture also widened: reflection now mints a node, using the existing person or entity type, for anyone or anything with a real part in the owner's life (a partner as much as a public figure they keep returning to, a company as much as a film), while a maintained page stays earned separately, granted only once someone recurs across sessions or clearly matters within one. A node-only person can be promoted to a page later. The session prompt now surfaces known people and entities by name and page status, and recent intentions, so the companion does not need to search for what it already knows. Legacy proposal queues from before this release drain silently on open instead of stranding anyone who upgrades.

v0.4.0 shipped the local web interface alongside the terminal CLI. `reverie web` serves the record through a browser on `127.0.0.1` only, admitted by a single-use bootstrap token that expires five minutes after startup. Browsing records, people, sessions, and transcripts works with no API key configured, pending legacy proposals are readable, and browser sessions become read-only after the server restarts. Chat streams live when a provider is configured. The Phase B atlas foundation renders the graph with deterministic temporary layout, pan and zoom, type filtering, selection, and an accessible node list.

v0.5.0 rebuilt the browser interface into three sections (Talk, Atlas, Record) reached from a left rail, and replaced the hand-written graph layout with the standard graphology layout libraries: ForceAtlas2 for layout, noverlap for collision removal, both run with fixed iteration counts so the result stays deterministic. This also fixed a real bug where the atlas canvas was sized by the list next to it and could grow past the browser's maximum canvas dimension, so WebGL allocation failed and the graph rendered as a black rectangle. The atlas gained node dragging with positions saved to the browser's local storage, hover emphasis, progressive label culling by zoom level, a type filter with live counts, a label search, and the accessible node list carried forward from v0.4.0.

v0.6.0 is five pieces of work landed together. CLI polish added `doctor` (five independent setup checks, never a network call), `version`, `help`, `--config`, and distinct exit codes for a second Ctrl-C and a live provider failure during `reindex`, `reflect`, or `chat`. Local time became a first-class fact: every message is stamped with the sender's local date and time from a timezone recorded in a new `profile.md`, and daily and weekly rollups compute from local calendar days instead of UTC. Retrieval got a real date span recorded on every document at index time, so `after`/`before` search filters now work uniformly by document metadata rather than only for the document kinds whose file paths happened to encode a date. A personal profile and ten conversation modes shipped together: `profile.md` holds preferred name, pronouns, location, timezone, birthday, occupation, and style, moved out of `config.toml`; modes (general, listen, solve, real, deep, brainstorm, boost, decompress, process, journal) adjust conversational style within a safety mode and never touch the safety mode itself. Journal mode closed out the release: six writing formats, each stating its own evidence honestly rather than borrowing a better-studied method's weight, a safety gate on expressive writing (crisis check, no offer on acute or recent trauma, a capped session, a mandatory grounding close), a `journaling.md` protocol negotiated conversationally the first time someone journals, and a read-only Journal tab in the browser. See the README for the full list and its honest caveats, including the one gap left open by design: a session recovered after a crash records `entryDate` as the recovery day, not the day the writing actually happened.

A memory folder created before v0.6.0 needs `reverie migrate` once: it seeds `profile.md` with your machine timezone, discards existing rollups so they rebuild on local-day boundaries, and moves a leftover `config.toml` `[style]` table into `profile.md`. `loadConfig` refuses to start while that table is still there. Run `reverie migrate --list` first to see what is pending, or `reverie migrate --dry-run` to see what would change with nothing touched yet.

v0.7.0 is two features and one round of repair, all landed on top of v0.6.0. See [docs/releases/v0.7.0.md](docs/releases/v0.7.0.md) for the release notes, including what each part deliberately does not do yet.

The repair came first. A recall-and-event-time round fixed a live failure found on 2026-08-22: a search result carried the correct booking date and time in one place and an undated, tenseless copy of the same fact in another, and only the undated copy came back. `fuseByReciprocalRank` in `packages/memory/src/retrieval.ts` now ranks by document but returns the matched chunks, up to a cap of three, instead of only the best-ranked one, and `SearchHit` now carries the `date_start`/`date_end` already indexed per document, so a returned snippet reaches the model dated. The FTS lane was a dead keyword search (it ANDed every whitespace-separated term, so almost no natural-language query matched); `toFtsQuery` now ORs terms instead. This round also closed a gap where five of thirteen tools leaked their internal function name instead of a plain-English notice, guarded by a test that fails if a new tool ships without an entry. That table has since moved: v0.7.3 replaced it with `packages/core/src/tool-labels.ts`, which covers all fourteen tools and carries both a running and a finished form, shared by the terminal and mirrored by the browser, and gave `/mode` with no argument a real selection state in the terminal instead of silently swallowing the next line typed. The README's claims about tool-based retrieval and live capture now carry the caveat that both depend on the model choosing to call the tools it is given, pointing at the model-choice finding in [BACKLOG.md](BACKLOG.md).

**Dreaming v1 shipped in v0.7.0.** A background process, off by default, that periodically revisits stored memory on a daily or weekly cadence and writes a narrative plus a set of evidence-pointed insights, run from four triggers with at most one dream per period, gated on at least 5 reflected sessions, reachable through `reverie dream` and a web Dreams tab with per-insight feedback. Design, decision history, and the full non-goal list (graph writes, relevance-ranked injection, transcript-level attribution, cross-dream consolidation, dream series, user-seeded dreams, and feedback-driven selection tuning, all deferred) live in [docs/dreaming.md](docs/dreaming.md); the current behavior is also described in the README's [Dreaming](README.md#dreaming) section. The pipeline is covered by an automated suite against scripted fake providers; the quality of a real model's dreams and insights has not yet had a human review pass, and that gap is tracked in the manual testing queue at the end of `docs/dreaming.md`.

The same round's final review pass (2026-08-25) fixed a non-transitive comparator in the recency tiebreak (`recencyTiebreak` in `packages/memory/src/retrieval.ts`), which could rank an older document above a newer, equally-scored one whenever an undated living document happened to join the same tie; an undated hit now sorts after every dated one, a fixed position rather than an undefined one. It also threaded `AgentSession`'s own injectable clock into all three of its `assembleSystemPrompt` calls, which had been silently reading the real wall clock instead, and closed a gap where a `summary.md` carrying an empty-string `eventTime` (from before an earlier fix, or hand-edited) still reproduced a fabricated `(eventTime: "")` anchor at both read boundaries, the search index and the rendered prompt, even though the four write sites had already been fixed.

The commitments engine (`docs/superpowers/specs/2026-08-24-commitments-design.md`, approved 2026-08-24) shipped this round: a first-class, revisable graph entity for a bounded thing the person means to do, replacing free-text intentions that can only be appended, never corrected, as the record of what someone is planning (`packages/memory/src/commitments.ts`, `commitmentTime.ts`). A commitment carries identity: it can be recorded, revised, and resolved to an outcome (done, dropped, or asked to go quiet) without losing the history of what it used to say, through either the live `remember` tool or reflection at session end, whichever actually runs. A vaguely stated time gets a gloss and an internal bracket, per the invariant that the bracket only ever decides when to surface a commitment and is never itself shown or spoken. A resolved commitment stops entering the session prompt; an unresolved one is eligible from a lead time before its window to a grace period after it closes, then goes quiet on its own. That grace period is a deliberate interim stand-in, not the design in the spec: the spec calls for a commitment to become eligible for exactly one natural follow-up, track that it was asked, and then fall silent permanently, which needs the companion to signal that it actually raised something in a live session, a mechanism not built yet (see [BACKLOG.md](BACKLOG.md)). The browser view for commitments is neither planned nor built this round either. See [docs/commitments.md](docs/commitments.md) for the full account, including what is not built.

v0.7.1 was a packaging release, no behavior change to the companion itself: the same features as v0.7.0, now installable from npm in one command instead of requiring a clone and a build. It fixed four real defects found while packaging: every bundled command crashed on load because esbuild's ESM output broke `gray-matter`'s CommonJS `require('fs')` (fixed by injecting a real `createRequire`-based `require`, and now caught earlier by a smoke test that runs the built binary as part of the build itself); the `reverie` command broke on every rebuild for anyone using `npm link` because `tsc` silently drops the executable bit (the build now guarantees it survives repeated builds); the web assets could not be found from an installed package because the server resolved its static directory by a path that only existed in a repository checkout (it now looks next to the running bundle first); and a status line test that passed or failed depending on how fast the machine was, now waiting on an unambiguous timer signal instead of a bounded loop. See [docs/releases/v0.7.1.md](docs/releases/v0.7.1.md).

v0.7.2 changed nothing a user runs. It exists to prove the automated publish path works for real, on a release where nothing else was at stake: publishing moved from a stored `NPM_TOKEN` secret to npm trusted publishing over OpenID Connect, so the workflow mints a short-lived token at run time and there is no long-lived credential to leak or rotate; the token wiring was removed rather than kept as a fallback, since a `NODE_AUTH_TOKEN` left in place "just in case" would silently take precedence the moment anyone added the secret back. It also fixed a defect that would have failed the first automated publish: Node 22 bundles npm 10.x, which has no OpenID Connect support, so the workflow now upgrades npm to 11.5.1 or newer before publishing. v0.7.1 was published to npm by hand; v0.7.2 is the first release `.github/workflows/publish.yml` has published for real, and `openreverie` is live on the registry: `npm i -g openreverie` resolves. See [docs/releases/v0.7.2.md](docs/releases/v0.7.2.md).

v0.7.3 is a repair release, and almost all of it came from one person using v0.7.2 for a day and writing down what was wrong. Dreaming, shipped in v0.7.0 and covered end to end by the automated suite, had never once produced a dream on a real memory folder. Six defects sat between `enabled = true` and a dream on disk: the dreaming model fell back to the reflection model, which is not chosen to run a tool loop; a failed attempt left no trace anywhere, so a dream that died on its first model call and a dream that was never due looked identical from outside; `reverie dream --force` lost a lock race against the engine's own un-awaited `onStart` trigger in the same process; `reverie web` never fired an early trigger, because the server opens the engine with maintenance disabled and `onStart` is gated behind that flag, leaving only a timer that first ticks thirty minutes in; the insight prompt showed only a document id as its worked example, so the model labelled session and node ids as documents and every insight was dropped for evidence that resolved nowhere; and the narrative step sent a temperature the model rejected, which only became visible once the other five were fixed. All six are fixed and a real dream has been produced end to end against a real memory folder. `reverie doctor` and the web Dreams tab now report dreaming's status honestly, including why the last attempt produced nothing, and the dream log records a failed attempt rather than staying silent. The same release fixed the web session list not appearing until a reload (an un-awaited auth bootstrap racing the first request, with the resulting 401 thrown away by a blanket catch), speaker labels that overflowed a fixed-width negative-offset gutter and overlapped the rule, a composer that stayed on screen for conversations that had ended, a cramped composer and a mode picker that read as though it had to be chosen every message, tool calls that showed a raw function name while running and raw JSON afterwards, and an atlas where all seven node types shared one near-black fill. It also gave the model this project's own prose rule, which it had never been given: em dashes had been written into permanent memory files. That rule is an instruction, not enforcement, and a deterministic pass is recorded in [BACKLOG.md](BACKLOG.md) rather than claimed. See [docs/releases/v0.7.3.md](docs/releases/v0.7.3.md).

## Current direction

The commitments engine above is built and reachable through the terminal, changing what the companion knows and therefore what it says, per spec Section 8: that is the entire intended surface this round. It has no CLI command and no HTTP route of its own. See [BACKLOG.md](BACKLOG.md) for what is not started, including the commitments engine's own deferred pieces (the real one-ask/permanent-silence mechanism, event-anchored `waitsOn` reactivation, the browser Record-section view, recurring commitments, and the rest) and the retrieval and documentation gaps recorded from the 2026-08-25 review.

v0.8.0 is a pure refactor with no user-visible change to self-hosted openreverie. It makes the
engine able to run on a machine that is not a machine. It comes from a change request by Reverie
Cloud, a separate hosted product that runs this engine inside a Cloudflare Durable Object, one
object per user. The design and the full list of items live in
[docs/superpowers/specs/2026-08-27-hostable-engine-design.md](docs/superpowers/specs/2026-08-27-hostable-engine-design.md).

What it does: filesystem access in `packages/memory` now goes through two injected interfaces, a
`FileStore` for whole-file reads and atomic writes and an `AppendOnlyStore` for logs, both hanging
off `MemoryPaths` so almost no function signature changed. `MemoryIndex` takes an injected
`SqlDatabase` rather than reaching for `better-sqlite3` itself, and `MemoryEngine.fromPaths` lets
an engine be built from stores and a database rather than from a root path. Embedding rows now
record the model and dimensions that produced them, so a model change is detectable instead of
silently mixing incomparable vectors. The provider interfaces report token usage. The HTTP layer
split into a transport-agnostic core over Web-standard `Request` and a thin `node:http` adapter,
with `createApp` unchanged for self-hosted.

Two parts of it are worth having regardless of the hosted product. The engine no longer reads the
ambient timezone or wall clock: both are injected, which is what this project's own agent rules
have required of time-dependent tests since three timezone-dependent failures in one day on
2026-08-25, and the ambient reads were the remaining hole. And an in-memory `FileStore` makes the
suite hermetic, with no temp directories.

It has since been run, though not here. Reverie Cloud verified the whole change set against its
own build rather than accepting the report, and ran the parts only a real runtime can answer on
real `workerd`. It is the first real consumer of `createFetchApp` and `LiveSessionRegistry`: the
whole API, an authenticated streamed turn, and the same turn after rebuilding the engine and
registry have all run there, then through a local Workers development route with curl. Three things
that were open are now settled: the engine constructs and opens inside a Durable Object with no
filesystem, `gray-matter` bundles and its YAML path executes there (it was flagged because its main
entry references `fs` for a helper this codebase never calls), and bundle size is not close to a
limit. That round also found one defect nothing here could have caught: `packages/server`'s barrel
built a `createRequire` at module scope, and since `import.meta.url` is undefined in that kind of
bundle, importing the package killed the isolate before any handler ran. It is now built on first
use. See
[docs/superpowers/specs/2026-08-27-hostable-engine-followup-design.md](docs/superpowers/specs/2026-08-27-hostable-engine-followup-design.md)
for that round and its three smaller fixes.

A later integration pass found that the shared server still treated its public canonical origin
as the loopback address it binds to. It now accepts origin-only HTTP and HTTPS URLs for public
hosts, including standard ports, while rejecting paths, credentials, queries, and fragments. A
Fetch host must also choose whether authenticated writes may omit `Origin`; the Node adapter keeps
requiring it, so self-hosted behavior is unchanged. A Workers development route can replace the
incoming `Host` with its route hostname while leaving `Origin` unchanged, so the canonical origin
must come from host configuration rather than from the address a developer types into a browser.
The decision and its limits are recorded in
[docs/superpowers/specs/2026-08-27-hostable-engine-canonical-origin-design.md](docs/superpowers/specs/2026-08-27-hostable-engine-canonical-origin-design.md).

What still has not happened: none of this has been run from this repository, on any runtime. The
suite here cannot run `workerd`, so nothing in it will catch that startup defect coming back; the
guard we can afford is a test that importing the package root does not evaluate `createRequire`,
and the real integration test lives downstream. Bun and Deno remain untried by anyone. Three
modules in `packages/memory` still import `node:fs` directly (the dream lock, the `config.toml`
migration, and git sync), each for a stated reason recorded in [BACKLOG.md](BACKLOG.md), as does
`sqlite.ts`'s top-level `better-sqlite3` import, which is safe today only because that package
defers loading its native binding until its constructor runs.

A round-two request from Reverie Cloud asked to go further than the hostable-engine refactor: make
the prompt a structured, host-configurable surface, so that varying it is a supported operation
rather than a fork. This round shipped the first piece of that, not the whole thing. `PersonaOptions`
now carries two named, host-supplyable blocks: `deploymentContext`, which replaces the deployment
claim in the identity block (an empty string omits it entirely), and `firstConversation`, which
replaces the welcome and onboarding script shown on someone's very first conversation. Both are
threaded as an optional field at every level a host might enter from: `buildPersona`,
`assembleSystemPrompt`, `AgentSessionOptions.persona`, `LiveSessionRegistryOptions.persona`, and
`ServerLaunchOptions.persona`, the last reaching both the registry and `dreamPersona`. The
empty-memory guardrail inside the first-conversation section stays engine-composed regardless of
what a host supplies, because it is a true statement about engine state on a first conversation
(there really is nothing to search yet), not a preference. Default output is unaffected:
`buildPersona` was compared against the prior code across 48 combinations of safety mode, active
mode, style, and crisis resources, all identical, and `assembleSystemPrompt`'s first-session output
matched the prior code byte for byte at 12,896 characters; both are now pinned as literal `toBe`
assertions rather than substring checks. Verified by the reviewer directly rather than taken from
the implementer's report: `pnpm build` clean, `pnpm exec tsc --noEmit` exit 0 across all six
packages, `pnpm lint` clean, and the full suite at 1,664 tests across 81 files, all passing. The
highest-stakes property was falsified by hand: with the guardrail mutated to drop out whenever a
host supplies its own opening, exactly one test fails, the one named for that behaviour, and it
passes again on restore. The rest of what the request asked for, a general override API over the
whole composed prompt and over tool descriptions, is not built this round. See
[docs/specs/2026-08-28-reverie-cloud-round-two-reply.md](docs/specs/2026-08-28-reverie-cloud-round-two-reply.md)
for the full review and our positions on each part, and [BACKLOG.md](BACKLOG.md) under "A
host-configurable prompt and tool-description surface" for everything from that request not built
this round.

A follow-up round on the same branch split the deployment claim into two fields instead of one.
Reverie Cloud's own copy review rendered a real hosted privacy string through both the identity
block and the welcome sentence, rather than reasoning about it, and found neither register worked
in both places: second person reads correctly in the identity block and reads as a mid-paragraph
pronoun switch in the welcome, and third person is the reverse. A second, independent problem made
one field worse than the register mismatch alone: the identity block wants a paragraph and the
welcome instruction asks for a clause of two or three sentences, so any host string honest enough to
state a real deployment stance overflows the welcome's own budget before the model reads a word of
it. `PersonaOptions` now carries a third field, `firstConversationDeploymentClause`: third person,
clause length, sitting alongside `deploymentContext`, which stays second person and paragraph
length. `resolveFirstConversationDeploymentClause` in `packages/core/src/personas.ts` fails closed:
an explicitly supplied clause always wins, including an empty string; the stock default clause
applies only when `deploymentContext` is also unset; otherwise the welcome carries no deployment
claim at all. The reasoning: a host that replaced `deploymentContext` has told us the stock claim is
false, so falling back to the stock welcome clause anyway would speak that false claim in the
opening sentences of someone's first conversation. Nothing yet enforces the length of either field,
so a host could still put a paragraph in the clause slot; that gap is recorded in `BACKLOG.md` and
scoped to land with the prompt's budget work rather than as a one-off patch on this field.

The same round added `buildDreamPersona` to `packages/core/src/personas.ts`, so a host that opens
`MemoryEngine` directly, without going through the CLI or server launcher, gets a `PersonaOptions`
into dream runs in one line instead of hand-writing the closure itself; `packages/server/src/launch.ts`
and `packages/cli/src/chat.ts` both call it now. This does not close the standing dream hazard.
`EngineDeps.dreamPersona` is still optional, and a host that omits it, or builds a persona some
other way, still gets an empty system prompt for all four dream stages through the untouched `?? ''`
fallback at `packages/memory/src/engine.ts:3173`. Composing the crisis stance in the engine itself on
the dream path, rather than trusting it to arrive inside a host-supplied string, also remains
unbuilt. Both stay open in `BACKLOG.md`; neither is fixed by this round.

Separately, `PRECEDENCE_SENTENCE` was reworded from ranking the prompt's blocks by their stock
structure to ranking them by role: the crisis stance first, then any first-conversation guidance,
then the rule about how to speak when the topic is personal, then the section it appears in, then
standing preferences, naming
no block identities or axes so the ordering survives a replaced block. This is the one place in the
whole host-configurable-prompt line of work where default output was allowed to change; everywhere
else the rule stays byte identity, no exceptions. It shipped alone, as its own commit, with the
exact replacement wording proposed in writing and signed off by Vishal in advance, because the
sentence ranks how crisis behavior outranks everything else, and both this project's and Reverie
Cloud's `AGENTS.md` require explicit human sign-off before that kind of text changes.

## How work happens here

This project is built with heavy use of AI coding agents under human direction, with per-task adversarial review. The bar for merged code is the same regardless of who or what wrote it: understood, tested, and honest. If you pick something up, open an issue first so nobody duplicates effort.
