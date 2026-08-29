# openreverie

A self-hosted companion agent with a memory that does not forget.

openreverie is a source-available agent you run on your own machine. You talk to it about what you are dealing with and working toward: struggles, plans, patterns, good things and hard things. It remembers all of it, organizes it into an evolving record of your life, and brings that context into every new conversation. It is built for personal reflection and mental wellbeing, and it is yours: your data lives in a folder you own, readable in any text editor, versioned with git.

Website: [reverie.my](https://reverie.my)

Current release: v0.8.0. It runs as a terminal app and as a local web interface. The [Status](#status) section below is the unvarnished inventory of what works and what does not, and it is kept accurate on purpose.

## What you can do with it

In your first few minutes, from the terminal or from your browser:

- **Talk to it.** Start a session and say what is on your mind. It opens with a short hello of its own instead of waiting for you to type first. (Your very first conversation runs a guided flow instead.)
- **Have it remember.** After the session, it files what mattered into your memory folder: the people involved, the storylines you are living through, what changed. Nothing you said is deleted or rewritten afterward.
- **Choose what the conversation is for.** Ten conversation modes change what a session is doing, from listening without offering advice, to working a problem toward a decision, to saying the thing you would rather not hear.
- **Read back everything it keeps.** Your memory is plain markdown in a folder you own. Browse it in the app, or open the files in any text editor.
- **Journal with it.** Journal mode runs six written-reflection formats, each one honest about how well studied it actually is.
- **See the shape of it.** The atlas draws your realms, arcs, people, entities, and sessions as a graph you can pan, zoom, filter, and search.

## Getting started

The intended way to run openreverie is the npm package:

```
npm i -g openreverie
reverie setup
reverie
reverie web
```

If you do not have `npm`, you do not install it separately: it ships with Node.js. Install Node 22 or newer from [nodejs.org](https://nodejs.org), or with a version manager such as [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`), [fnm](https://github.com/Schniz/fnm), or your package manager (`brew install node` on macOS). Check what you have with `node -v` and `npm -v` before anything else.

To update later, install the same way again: `npm i -g openreverie@latest`. That replaces the binary in place and touches nothing in your memory folder, which lives outside the package. Run `reverie version` to confirm which version you ended up on, and `reverie doctor` if something looks wrong afterwards. Some upgrades ask for a one-time `reverie migrate` run, and when that is the case the app says so on startup and refuses to continue until you have run it, rather than migrating your files behind your back.

Requirements: Node 22 or newer; a platform npm can get a `better-sqlite3` prebuilt binary for (macOS, Linux, and Windows on the common architectures all have one), or a C++ toolchain so it can build from source instead; and an API key for your chat provider (OpenAI is the only one implemented today, see [Command reference](#command-reference) and the Status section below). The web assets ship inside the package, so `reverie web` works immediately, with no separate build step.

`openreverie` is published to npm: `npm i -g openreverie` resolves. The packaging itself, the bundled single-file binary, the web assets shipped alongside it, and the executable bit surviving repeated builds, has been built and verified end to end, first locally (a tarball installed into a scratch npm global prefix outside this repository, with `reverie version`, `reverie doctor`, and `reverie web` all serving correctly from there) and now for real: `.github/workflows/publish.yml` publishes to npm automatically on a pushed version tag, after running the full suite, the build, and the lint, and refusing to publish if any of them fail. v0.7.1 reached npm by hand; v0.7.2 is the first release the workflow published for real, on a version chosen specifically to exercise that path where nothing else was at stake. Publishing uses npm trusted publishing (OpenID Connect): the workflow mints a short-lived token at run time instead of using a stored `NPM_TOKEN` secret, so there is nothing to leak or rotate. See [docs/releases/v0.7.1.md](docs/releases/v0.7.1.md) and [docs/releases/v0.7.2.md](docs/releases/v0.7.2.md) for the details.

`setup` runs a first-run wizard that asks for your provider API key, your safety mode, and where you want your memory folder to live, then writes a config file. Run it once before anything else.

With no arguments, the same binary starts the terminal chat REPL, loading your existing memory (constitution, arcs, recent context) into the conversation. `web` starts the local web interface and prints a bootstrap URL to paste into your browser. The full command list is in [Command reference](#command-reference) below.

Building and running from source, for development or if you would rather not install a global binary:

```
pnpm install
pnpm build
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js
node packages/cli/dist/index.js web
```

`pnpm build` compiles every workspace package, builds the web interface with vite, and then bundles the CLI the same way the published package is bundled (see `packages/cli/scripts/bundle.mjs`), so `packages/cli/dist/index.js` behaves identically whether you got it from npm or built it yourself.

> **Upgrading a memory folder created before v0.6.0:** run `reverie migrate` once before anything else. Style settings moved out of `config.toml` and into `profile.md`, and `loadConfig` now refuses to start while `config.toml` still has a `[style]` table, with an error naming `reverie migrate`. The same migration seeds `profile.md` into folders that predate it and discards UTC-dated rollups so they rebuild on local-day boundaries. To look before you leap: `reverie migrate --list` shows each migration as pending or applied, and `reverie migrate --dry-run` reports what would change. Neither one touches anything.

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

Each conversation starts with your constitution, active arcs, and recent context already loaded. The agent retrieves deeper memory through tools: semantic search, keyword search, graph traversal, and full transcript reads; that is guidance to the model, not a guarantee of what it actually does. The chat model must be willing to call these tools, which depends on the model you configure. See [BACKLOG.md](BACKLOG.md) under "Known defects and gaps" for the finding on newer models that decline to use tools. Search itself is a hybrid of keyword and vector search fused by reciprocal rank; see [docs/retrieval.md](docs/retrieval.md) for how it works and its current limits (brute-force vector search, no reranking, and date filters that deliberately never exclude the continuously rewritten documents, so a date-filtered search still surfaces an arc or person page from outside the range). After each session, a reflection pass extracts what mattered and saves it directly: new arcs, new people and entities as nodes, page promotions for a person who has come to recur, updated arc and person narratives, and every attribution, unconfirmed but not held back for approval. A companion that remembers should not have to ask permission to remember. Nothing you said is ever deleted or rewritten; transcripts are append-only.

### Dreaming

Dreaming is a background process that goes back over your stored memory on its own schedule, without you starting a conversation, and writes two things back: a short narrative for you to read, and a set of hedged insights the companion can draw on later. Each run picks a couple of distant, unrelated-looking things from your memory (an old arc, a person you have not mentioned in months, a session from a different season) and looks for a real connection between them. Design details, including the selection and pipeline mechanics, are in [docs/dreaming.md](docs/dreaming.md).

It is **off by default**. Dreaming spends your money on model calls that run in the background whether or not you asked for them in that moment, so it stays opt-in rather than something that starts consuming your budget the moment you upgrade. Turn it on by setting `enabled = true` under `[dreaming]` in `config.toml`, and choose a cadence: `daily` or `weekly`. It cannot be turned on from the web interface; the config file is the only switch.

A dream can start from four places: after a session's reflection finishes, in the background when reverie starts up, from the server's own timer if you run `reverie web` (every 30 minutes), or on demand with `reverie dream`. No matter how many of those fire, at most one dream runs per cadence period. Missed periods are never made up: if your machine is off for two weeks under a daily cadence, you get one dream when it next runs, not fourteen. Dreaming also needs at least 5 reflected sessions in your memory folder before it will run at all; below that, it stays quiet.

The insights are the model's guesses, not settled facts. Each one is hedged and points at the specific document, session, or graph entity it came from. You can mark one right, wrong, or "do not bring this up" from the web Dreams view, or in conversation when you react to something the companion says (it records the correction through a `dream_feedback` tool). A rejected insight does not come back. Nothing here is ever rewritten: `dream.md`, `insight.md`, and the process log for a run are written once and never edited afterward, and the dream log (`dreams/log.jsonl`) is append-only, the same posture as `graph.jsonl`.

Where it lives: `dreams/<date>-<dreamId>/` holds `dream.md` (the narrative), `insight.md` (the insights, with evidence pointers), and `process.jsonl` (a per-run audit trail: which seeds were picked and why, what the tool loop looked at, what each model call returned). `dreams/log.jsonl` is the append-only record of coverage and feedback across all runs.

Read it back with `reverie dream --list` and `reverie dream --show <id>` (the terminal shows verdicts already recorded, but does not let you record a new one from there), or from the Dreams tab in the browser, which shows the narrative and the insights as separate sections with feedback controls on each insight.

## Why this exists

Tools that hold your most personal thoughts should not live on someone else's servers under someone else's business model. openreverie is self-hosted and source-available: you can read every line, run it yourself, and modify it for your own use. See [License](#license) below for the one commercial restriction and when it lifts. The other honest caveat: when you use a hosted model provider (OpenAI, Anthropic, and others), your conversation text is sent to that provider for inference. The provider layer is swappable by design so that local models can close that gap for people who want it fully private.

## Conversation modes

A mode says what this particular conversation is for. It is not a setting you configure once: a mode is chosen for one conversation and is never remembered for the next. It adjusts style within your safety mode and never changes the safety mode itself, and it never changes your tone. Mode changes what the conversation is doing, not who is talking.

There are ten:

| Mode | What it is for |
| --- | --- |
| `general` | Open conversation, no agenda. The default. |
| `listen` | You talk it through, it stays out of the way. |
| `solve` | A concrete problem, worked toward real options and a decision. |
| `real` | It pushes back and names what it sees. It does not soften. |
| `deep` | It asks the questions. It is trying to understand you, not answer anything. |
| `brainstorm` | Quantity over judgment. Ideas riffed on, evaluation deferred. |
| `boost` | Your corner talked up, from things it actually knows about you. |
| `decompress` | Winding down. Light, low-stakes, deliberately not going deep. |
| `process` | Working through one specific thing until it settles. |
| `journal` | Structured written reflection. See [Journal mode](#journal-mode) below. |

Set one with `/mode` in the terminal, a picker in the browser, or by asking (the `set_mode` tool).

Mode at launch differs by interface, on purpose. The terminal always starts a session in `general`, with no prompt and no memory of what you used last time; it shows a small decorative status spinner while your memory folder opens, since that wait used to be silent. The browser instead shows the ten modes as clickable cards on a new chat and creates no session (no `POST /api/v1/sessions`) until you click one. The browser can afford this because its one engine already starts once when the server boots, before any session exists, so gating on a picker costs nothing there; the terminal has no equivalent point to decouple, which is why it does not gate.

One mode, `boost`, exists to talk you up. Whether it manufactures praise instead of finding real material is not something a test can settle, so it was checked by hand against a memory folder with almost no history, the case where manufacturing is most tempting. Asked to talk up someone it knew nothing about, it did not invent anything: it said plainly that it works best from real things about the person and asked for a name and pronouns first. Given one real fact in the next message (a shipped feature after two days chasing a flaky test), it built praise strictly from that fact, said as much explicitly ("From what I actually know today"), and added nothing invented.

## Journal mode

Journal mode is written reflection with a structure, rather than ordinary conversation. You pick a format, the agent follows that format's own sequence instead of steering toward advice, and what you write becomes a journal entry in your memory folder. There are six formats.

| Format | What you actually do | Evidence |
| --- | --- | --- |
| Expressive writing | Write continuously for 15 to 20 minutes about the same difficult thing, across four days in a row. Grammar does not matter; it is not for anyone else to read. | Well replicated, with modest effects. |
| Gratitude | Name a few things you are glad about, specific enough to be more than a label. | Well replicated, with modest effects. |
| Daily examen | Five steps in order: how you feel right now, the day reviewed with gratitude, one moment that stirred something strong, what that moment is telling you, an intention for tomorrow. | Thin but suggestive, one small trial. |
| CBT thought record | The situation, the feeling and how strong it was, the automatic thought, the evidence for it, the evidence against it, a more balanced alternative, then re-rate the feeling. | Validated as part of a broader CBT course, but not on its own. |
| Morning pages | Three pages, stream of consciousness, no editing, first thing in the morning. | No clinical studies at all. |
| Open format | Nothing prescribed. A place to write with no ritual attached. | No research question to begin with. |

Each format states its own evidence honestly rather than borrowing a better-studied method's weight. That is the point of the table above, and it is enforced in the prompt content itself: expressive writing and gratitude are well replicated with modest effects, the examen is thin but suggestive (one small trial), the thought record is validated as part of a broader CBT course but not on its own, morning pages has no clinical studies at all, and open format carries no research question to begin with.

The first time someone journals, or whenever `journaling.md` still holds no real setup, the agent runs an actual conversation about what they want rather than defaulting silently. The examen is suggested only because its fixed question sequence suits a turn-based agent, not because it is the best evidenced. `journaling.md` can be rewritten live, in any session, through the `update_journaling_protocol` tool, or as a backstop by reflection when someone renegotiated their setup without the model calling that tool.

Expressive writing carries its own safety gate: a crisis check before it is offered, refused for very recent or acute trauma, a session capped at fifteen to twenty minutes, and a grounding prompt that closes every session using it, unconditionally, regardless of how the writing went.

A journal entry is a tool-only document kind, the first one in this codebase: never injected into the system prompt, reachable only through `search_memory` and `read_document`, so entries never crowd out other context. The active journaling protocol, by contrast, is injected directly while journal mode is active. `entryDate` (what the entry is about) and `recordedAt` (when it was actually written) are kept separate throughout, the same distinction session dates already draw. One known gap, left as is rather than silently fixed: a session recovered after a crash writes `entryDate` as the day of recovery, not the day it actually happened, since the session's real start time is not threaded into that one path.

## What it is not

openreverie is not a therapist and does not diagnose or treat anything. It is a reflective companion. At first-run setup you choose one of two safety modes for moments of acute distress: **companion** (stays present, gently and persistently points to real help) or **firewall** (declines to engage further with crisis topics and immediately points to real help). Crisis resource contacts are configurable. If you are in crisis now, please reach a human: in the US, call or text 988; elsewhere, [findahelpline.com](https://findahelpline.com).

## The browser interface

A local web interface, `reverie web`, serves the same record in a browser. The server binds to `127.0.0.1` only and admits you through a single-use bootstrap token that is generated fresh each run and expires five minutes after startup. Browsing records, people, sessions, and transcripts works with no API key configured; chat in the browser works when a provider is configured. The command prints the bootstrap URL and does not open your browser for you.

The interface is organized into six sections reached from a left rail: Talk (conversations), Atlas (the graph), Record (the written documents), Journal, Dreams, and Settings. Only one section is on screen at a time, and the atlas is unmounted while you are in another section, so the graph costs nothing while you are reading or talking.

- **Talk** shows a session list grouped by day with readable times instead of raw session ids. Clicking a past session opens its transcript read only. The message thread keeps the full conversation through a turn, and streamed replies arrive as one growing message. It also shows the opening greeting described under Status below. Until this rework, the server sent the greeting stream but no browser client consumed it, so a new conversation opened with an empty thread even though the greeting had already been written to the transcript. If the greeting fails or the provider is unreachable, the session still opens and the composer still works, matching the terminal.
- **Record** groups your documents by kind and shows a readable label for summaries and rollups, which carry no title of their own, derived from their date. It has a search box and renders markdown through a deliberately limited renderer that handles headings, paragraphs, lists, blockquotes, horizontal rules, fenced code, and inline code, bold, and italic. It builds React elements only and never sets raw HTML; it also no longer treats an underscore inside a word as italic markup, so an identifier like `doc_const_1` displays correctly.
- **Journal** lists entries written during journal-mode sessions, newest first by the date the entry is about, each with its method in plain words and a short excerpt; clicking one shows the full entry as markdown. It is read-only: no edit, delete, or compose control anywhere in it, since it only reads back what a journal-mode session already produced.
- **Settings** shows your safety mode and provider configuration as read-only text, alongside editable profile fields.

Sessions you start in the browser stay live while the server runs, then become read-only after it restarts. Their transcripts remain browsable after the restart.

### The atlas

The atlas renders the graph of realms, arcs, people, entities, items, and sessions as an interactive node view. It is now built on the standard graphology layout libraries rather than hand-written geometry, which also fixed a bug where the atlas canvas was sized by the list next to it and could grow past the browser's maximum canvas dimension, so WebGL allocation failed and the graph rendered as a black rectangle.

The atlas uses ForceAtlas2 for layout and noverlap for collision removal, both run with fixed iteration counts so the result stays deterministic. It supports pan, zoom with explicit zoom in, zoom out, and reset controls, dragging a node to move it, click selection, hover emphasis that dims everything except the hovered node and its direct neighbors, label culling so labels appear progressively as you zoom in, a type filter with live counts where item nodes start hidden, a label search, and the accessible node list. Positions you set by dragging a node are saved to the browser's local storage, so the map does not rearrange itself between visits; nothing about layout is written to your memory folder.

Realm influence visualization and a history time lens still do not exist in the atlas. ForceAtlas2 runs on the main thread: it is fast at the current graph size and the iteration count is capped so a large graph cannot hang the tab, but the worker build the library ships with is not used yet. The graph snapshot is still loaded whole; the server caps it at 8 MiB and never paginates, so there is an upper limit on graph size the browser cannot work around. Switching your operating system between light and dark while the atlas is open can also leave some of its colors out of step until you reload the page.

## Status

**Usable as a terminal app and a local web interface. v0.4.0 was the first release to ship a browser UI alongside the terminal CLI. v0.5.0 rebuilt that browser UI into three separate sections and replaced the hand-written graph layout with the standard graphology layout libraries. v0.6.0 has now shipped. It made local time a first class fact, closed the gap where the system prompt would say more memory existed without giving the model any way to reach it, added a personal profile and ten conversation modes including how a mode gets chosen when a session starts, added the `doctor`, `version`, `help`, and `--config` CLI surface, and delivered a real journal mode: six evidence-based writing formats, a safety gate on the riskiest of them, and a browser tab to read back what was written. A memory folder created before v0.6.0 needs one `reverie migrate` run before the app will start. The automated suite covers the journal content and its wiring end to end; the live conversational behavior (which format gets suggested, whether the safety gate holds in the moment) has not yet had a hands-on pass with a real model and is queued for one. v0.7.0 has now shipped on top of that: a retrieval and event-time round (a keyword search lane that was silently dead, chunk-level and dated search results, a fixed recency tiebreak) and a commitments engine, a first-class revisable record for a bounded thing you say you mean to do. See the commitments bullet below for what it does and does not do yet, [docs/releases/v0.7.0.md](docs/releases/v0.7.0.md) for the release notes, and [ROADMAP.md](ROADMAP.md) for the full account. Dreaming shipped in v0.7.0 as well: a background process, off by default, that periodically revisits stored memory and writes a narrative and a set of evidence-pointed insights, reachable through `reverie dream` and a web Dreams tab, with per-insight feedback and a capped prompt section. It is described in full under [Dreaming](#dreaming) above. The dreaming pipeline is covered end to end by the automated suite (selection, the tool loop, schema validation and retry, scheduling and the once-per-period rule, feedback, the CLI, the server endpoints, the web view), all of it against scripted fake model providers. No human has yet read a dream a real model wrote and judged whether the narrative reads well in any of the three voices, whether an insight is actually a good one, or whether the tone stays where the design intends. The dreaming machinery is tested. The dreaming output is not. v0.7.1 was a packaging release with no behavior change to the companion itself: it fixed a build defect where every bundled command crashed on load (esbuild's ESM output broke a CommonJS `require`, caught now by a smoke test that runs the built binary as part of the build), fixed the executable bit being silently dropped on rebuild under `npm link`, and fixed the web assets failing to resolve from an installed package. v0.7.2 changed nothing a user runs: it moved npm publishing to trusted publishing (OpenID Connect), so there is no stored `NPM_TOKEN` secret to leak or rotate, and it exists specifically to exercise the publish workflow for real on a release where nothing else was at stake. v0.7.1 reached npm by hand; v0.7.2 is the first release the workflow published for real. See [docs/releases/v0.7.1.md](docs/releases/v0.7.1.md) and [docs/releases/v0.7.2.md](docs/releases/v0.7.2.md) for the full account. v0.7.3 is a repair release, and it corrects something this section got wrong. Dreaming was tested end to end against fake providers and had never once produced a dream on a real memory folder. Six defects sat between turning it on and a dream on disk: the dreaming model fell back to the reflection model, which is not chosen to run a tool loop and in one real config could not run one at all; a failed attempt left no trace anywhere, so a dream that died on its first model call and a dream that was never due looked identical from outside; `reverie dream --force` lost a lock race against the engine's own background trigger in the same process; `reverie web` never fired an early trigger, so nothing happened until a timer first ticked thirty minutes in; the insight prompt biased the model toward evidence ids that could never resolve; and the narrative step sent a temperature the model rejected. All six are fixed, and a real dream has now been produced end to end against a real memory folder as the final check. `reverie doctor` and the web Dreams tab now report dreaming's status honestly, including why the last attempt produced nothing. What a real model actually writes still has not been reviewed by a human, so the sentence above stands: the dreaming machinery is tested, the dreaming output is not. v0.7.3 also fixed the web session list not appearing until a reload, overlapping speaker labels, a composer that stayed on screen for conversations that had ended, tool calls that showed a raw function name and then raw JSON, an atlas where every node type shared one colour, and settings that saved silently without saying so. It gave the model the project's own prose rule, which it had never been given, after em dashes were found written into permanent memory files. See [docs/releases/v0.7.3.md](docs/releases/v0.7.3.md).**

v0.8.0 is a hostable-engine release with no user-visible change to self-hosted openreverie. It
makes filesystem access, the SQLite handle, the timezone, and the wall clock injectable, adds
public engine and server entry points for a Workers-style host, and keeps the Node server as a thin
adapter over the transport-agnostic HTTP core. A separate hosted product is the first real consumer:
it has served the complete API, including one authenticated streamed turn that survived rebuilding
the engine and registry, and repeated the same path through local Workers development. Its route
configuration supplies the canonical public origin, which differs from the address a developer
uses locally: development routing can rewrite `Host` while leaving `Origin` alone. The Fetch app
therefore requires a configured canonical origin and an explicit policy for whether native clients
may omit `Origin`; the self-hosted Node adapter keeps its existing browser-only requirement. This
repository still cannot run the Workers runtime, so that integration test remains downstream. See
[docs/releases/v0.8.0.md](docs/releases/v0.8.0.md) and [ROADMAP.md](ROADMAP.md) for the full
account.

A further round on top of v0.8.0 lets a host supply three pieces of the system prompt instead of
all of it being hardcoded prose asserting the software runs on the person's own machine.
`deploymentContext`, second person and paragraph length, replaces the deployment claim inside the
identity block. `firstConversationDeploymentClause`, third person and clause length, replaces the
matching deployment clause inside the welcome sentence shown on someone's first conversation.
`firstConversation` replaces that whole welcome and onboarding script. The first two are separate
fields because one register never worked in both places: second person reads correctly in the
identity block and reads as a mid-sentence pronoun switch in the welcome, third person is the
reverse, and the identity block wants a paragraph where the welcome wants a clause. Resolving
`firstConversationDeploymentClause` fails closed: an explicitly supplied clause always wins,
including an empty string; the stock default clause applies only when `deploymentContext` is also
left unset; otherwise the welcome carries no deployment claim at all, because a host that replaced
`deploymentContext` has told the software the stock claim is false, and repeating it in the welcome
would be worse than saying nothing there. An empty string for either deployment field omits it
entirely rather than leaving stray punctuation behind. `buildDreamPersona(mode, resources, options)`
in `packages/core/src/personas.ts` gives a host that opens `MemoryEngine` directly, rather than
through the CLI or server launcher, a one-line way to get its `PersonaOptions` into dream runs too.
Nothing else in the prompt is host-configurable yet, and two gaps in what shipped this round are
still open, both tracked in [BACKLOG.md](BACKLOG.md): nothing enforces the length of a
host-supplied field (under "A host-configurable prompt and tool-description surface"), and a host
that omits `dreamPersona` entirely, or builds one some other way than `buildDreamPersona`, still
gets an empty system prompt for every dream stage (under "Known defects and gaps"). The general
named-block override API over the rest of the prompt and over tool descriptions is also tracked
under "A host-configurable prompt and tool-description surface" in BACKLOG.md. The empty-memory
guardrail inside the first-conversation section stays engine-composed either way, because it is a
true statement about engine state on a first conversation, not a preference a host could reasonably
override. Self-hosted output is unchanged with one deliberate exception, and this is the exception:
the precedence sentence, which ranks the crisis stance above everything else in the prompt, was
reworded to rank the blocks by the role they play rather than by naming the stock structures, so it
still means something once a host replaces one of those structures. That reword changed default
output for every deployment, self-hosted included, and it was signed off by a human before it was
written because of what it ranks. Apart from that sentence, `buildPersona` and
`assembleSystemPrompt` produce the exact same text as before this round when a host supplies
nothing. See `packages/core/src/personas.ts`
(`PersonaOptions`, `DEFAULT_DEPLOYMENT_CONTEXT`, `DEFAULT_FIRST_CONVERSATION_DEPLOYMENT_CLAUSE`,
`buildDreamPersona`) and `packages/core/src/context.ts` (`firstConversationSection`).

A 2026-08-29 pass fixed three defects, one of which changes the API. `listStoredSessions` used to
report every session stored on disk as `'ended'`, whether or not it had actually been reflected.
`PublicSession.status` now carries a fourth value, `'open'`, for a session that is on disk, was
never reflected, and is not live in this process, distinct from `'expired'`, which is the
in-memory idle sweep's own state and never describes a session read straight off disk. `readOnly`
stays `true` for both `'ended'` and `'open'` unconditionally, because the stored view still cannot
serve writes until session resume exists: only the label was wrong, not the permission underneath
it. The server's registry now answers a write attempted against an `'open'` session with `409
session_not_live` rather than the more restrictive `409 session_ended`; any status it does not
recognize, including one added later, still falls to `session_ended`, fail closed. The response
schema's `status` field now accepts `'open'` as a fourth value alongside the other three, so a
client validating that enum strictly needs to add it too. In the browser, a session interrupted
before reflection now shows as `open` in the Talk list instead of `ended`; nothing else about it
changed for a self-hosted user. The second defect: dreaming used to run all four dream stages on
an empty system prompt when the rendered dream persona was empty or whitespace only; it now fails
loudly instead, recording the attempt as `'failed'` and throwing before any stage runs. A
non-empty persona that renders real prose with no crisis stance in it still passes this guard, a
gap tracked in [BACKLOG.md](BACKLOG.md). The third defect: `writeJournalingProtocol` used to
rebuild the journal entry's `meta` object from scratch on every rewrite, discarding any structured
field it did not know about; it now reads the existing `meta`, merges its own fields into it, and
writes the result back, so a pre-existing structured field survives the next prose rewrite.
Separately, the `FileStore.readFile` contract is now written down directly on the interface in
`packages/memory/src/store.ts`: an implementation must reject with an error whose `.code` is
`'ENOENT'` when the path does not exist, because
`journal.ts` and `profile.ts` both depend on that exact code to tell a missing file apart from any
other read failure. It was written down because a real host's own `FileStore` implementation threw
a plain `Error` instead, silently breaking reflection end to end on that deployment before anyone
noticed.

The sections above describe the conversation modes, journal mode, the browser interface, and the atlas in full, including their caveats. What follows is the rest of the inventory.

What works today:

- Terminal chat with persistent, layered memory (constitution, realms, arcs, people, session transcripts)
- Live capture during a conversation (the agent can call `remember` mid-session; that is guidance to the model, not a guarantee of what it actually does, and depends on the chat model being willing to call tools, which is the finding recorded in BACKLOG.md under "Known defects and gaps")
- Reverie speaks first. A session opens with a short, model-written hello instead of waiting for you to type. Reverie is instructed to lead with anything left unresolved from last time or notable in the recent record, and to keep it to a plain hello otherwise, but that is guidance to the model, not a guarantee of what it actually says. If the model is unreachable or the call times out, the greeting is skipped silently and the session just opens at the prompt. A first conversation still gets the guided flow, not this.
- Person and entity nodes, captured generously: reflection is instructed to create a node the moment someone or something with a real part in your life is mentioned, whether or not it ever gets a page, but that is guidance to the model, not a guarantee it always does. A person earns a page (a narrative document under `people/` that reflection maintains) only when they recur across sessions or clearly mattered within one; a person captured as a node only can still gain a page later, once they recur. Entities (books, films, companies, places, and the like) get a node only; they do not get a page in this release.
- Post-session reflection: each session is summarized and filed into memory directly. New arcs, new people, new entities, page promotions, and every attribution (whatever the model's confidence) are saved right away: nothing is held back for your review, and nothing saved this way can be undone through the product (see below). A memory folder from an earlier release may still carry pending proposals from before proposal generation was retired; those are now materialized and resolved automatically the moment the engine opens, silently, with no review step, so they no longer wait for `resolve_proposal`
- Lazy daily and weekly rollups, built the first time enough time has passed to need them
- Local time throughout. Each of your messages is stamped with the local date and time it was sent, in your timezone. The timezone lives as a machine-readable fact in `profile.md` at the memory folder root, seeded when the folder is created and confirmed when the agent learns or corrects where you are. Session dates and daily and weekly rollups are computed from your local calendar day rather than UTC, so a session that crosses midnight belongs to the day you were living in.
- Both safety modes (companion and firewall)
- The prompt no longer hides what it cannot fit. Every list the system prompt shows is capped, and where a cap cuts something the prompt now says so and names the tool that fetches the rest. Prose sections (the constitution, the latest daily rollup, each recent session summary) carry the document id alongside the truncation marker, so the model can read the part it was not shown. Section caps are measured in characters, not tokens: there is no tokenizer in this codebase and the prompt does not pretend to count tokens.
- `list_people` and `list_entities` tools, so people and things beyond the prompt's cap stay reachable. The prompt shows only the most recent forty people and thirty entities; these tools page through the rest and look someone up by name. A person with no page is still fully recorded and still has an id you can pass to `graph_query`.
- `search_memory` returns two kinds of hit. `documents` are ranked passages from pages, summaries, and rollups, as before. `nodes` are graph nodes whose name matches the query, including people and things that have no page at all. Node hits are returned beside the ranked documents and are never mixed into the ranking: a node has no passage and no relevance score, so any score given to it for ranking would be invented.
- Search date filters work on what a document is about, not on its filename. `after` and `before` are applied in SQL against a date span recorded for each document when it is indexed, so they now behave the same for every document kind rather than only for the ones whose paths happen to encode a date. The search index carries a schema version and rebuilds itself automatically when that version changes, so an index written by an older build is replaced rather than queried.
- Weekly rollups are listed in the prompt as a compact index: the newest twelve weeks, each with its document id, plus the true total and the earliest week, and a count and date range for daily rollups. The bodies are never preloaded, because weekly rollups accumulate at fifty-two a year without bound.
- Reflection is still shown the whole constitution, never a capped one. Reflection rewrites the constitution as a complete replacement, so a truncated input would delete the part the model never saw. This is enforced by the architecture (the truncation helper lives in a package `memory` cannot import) and pinned by a test.
- A first-run setup wizard
- The `reindex`, `reflect`, and `read` CLI subcommands. `read` works with no network call and no API key: it is a plain filesystem read of your memory record
- A status line while the model or a tool is working, so a slow call looks slow rather than stuck. It only appears when the terminal supports color; a piped or non-interactive session gets none.
- Opening a session and leaving without typing anything costs nothing: no reflection call, no rollup
- The OpenAI provider
- A personal profile. `profile.md` at the memory folder root holds your preferred name, pronouns, location, timezone, birthday, occupation, birthday greetings, style, and a short prose body. Every field is optional and nothing is ever inferred. The model can record a fact you tell it through the `update_profile` tool; it can never change your style.
- Style (how reverie talks: how much it initiates, its register, whether it leans toward listening or toward offering next steps) lives in `profile.md`, not `config.toml`. A config file from before this change that still has a `[style]` table is refused at startup with a message naming `reverie migrate`. After migrating, `config.toml` holds only infrastructure: provider, API key, model names, memory folder, and safety mode. Safety mode is still changed only by hand, deliberately: no tool, command, or endpoint touches it.
- An in-chat command table in the terminal: `/mode`, `/style`, `/settings`, `/whoami`, `/help`, and `/bye`, plus a persistent status strip above the prompt showing the active mode and the local time. See [Command reference](#command-reference) below for what each command does. Asking the model to change your style permanently now points you at `/style` or the browser's settings pane instead of doing it itself.
- Session mode over HTTP: the server accepts `POST /api/v1/sessions/:id/mode`, and a session's mode rides along on its stream events. Two new endpoints, `GET`/`PATCH /api/v1/profile` and `GET /api/v1/settings`, read and write the profile and read infrastructure settings. `GET /api/v1/settings` reports the safety mode as plain text; there is no route that can change it.
- Commitments: a bounded thing you say you mean to do ("I'm going to the Nightfall screening on Sunday," "come summer I want to start swimming again"), a distinct memory entity from an item because it has identity and can be revised instead of only appended. Three operations, each writing to the same record, always kept distinguishable: recording, revising, and resolving with an outcome (done, dropped, or asked to go quiet). All three work from either path. See [docs/commitments.md](docs/commitments.md) for how it works and its honest limits. Live, through the `remember` tool during conversation, depends on the model actually choosing to call it, the same caveat as live capture above. Reflection, at session end, reads the whole transcript and always runs whether or not any tool was called during the session, which is why it is the path that has to work, including for resolving a commitment, not only capturing one; where the two disagree about the same commitment, reflection wins. A vaguely stated time ("come summer") gets a gloss, a short interpretation a model writes after reading your profile, plus an internal time bracket used only to decide when a commitment is worth bringing up in the session prompt. The bracket is never shown or spoken; only the gloss and your own words are, and there is no state anywhere in the schema meaning overdue. A resolved commitment (done, dropped, or quiet) stops entering the prompt once resolved. What is not built yet is the spec's own "ask once, then permanent silence" mechanism: nothing currently marks a commitment as having been raised in conversation, so as an interim stand-in, an unresolved commitment past its window simply stops surfacing on its own after a couple of weeks, rather than being silenced by an actual ask (tracked in [BACKLOG.md](BACKLOG.md)). Commitments have no view of their own in the browser yet: commitment nodes show up generically in the graph atlas, but the dedicated Record-section list the design calls for (what is open, resolved, quiet) has not been built.
- Dreaming (off by default; see [Dreaming](#dreaming) above for how to turn it on). A background process producing a narrative and evidence-pointed insights per run, on a daily or weekly cadence, from four triggers with a once-per-period cap, gated on at least 5 reflected sessions. `reverie dream` (`--force`, `--dry-run`, `--list`, `--show <id>`), a web Dreams tab with per-insight feedback (right, wrong, do not bring this up), a `dream_feedback` tool so the companion can record a correction in conversation, and a capped prompt section surfacing recent, non-rejected insights. The CLI reads dreams and shows verdicts already recorded; it has no command of its own for recording new feedback. Dream and insight files are write-once; the dream log is append-only. The pipeline and its scheduling are covered by the automated suite against scripted fake providers, and as of v0.7.3 the pipeline is also confirmed to complete end to end against a real provider, with a real dream written. Before that release it could silently never run at all for a real config, and said nothing when it did not. The quality of what a real model actually writes has still not been reviewed by a human (see Status above).
- npm packaging: `packages/cli/scripts/bundle.mjs` bundles the CLI and its four workspace dependencies into one esbuild-produced ESM file, ships the built web interface assets alongside it, and keeps the binary executable across repeated builds. `.github/workflows/publish.yml` publishes to npm on a pushed version tag, after the full suite, the build, and the lint all pass, using npm trusted publishing (OpenID Connect) rather than a stored token. Verified first by installing a locally built tarball into a scratch global npm prefix outside this repository (`reverie version`, `reverie doctor`, and `reverie web`, checked with `curl` against its actual served assets, not just that the process started, all ran correctly from there), and now for real: v0.7.1 reached npm by hand, and v0.7.2 is the first release the workflow itself has published. The package is published; `npm i -g openreverie` resolves.

What does not exist yet:

- Dreaming does not write anything to the graph, by design for v1. It produces prose and a log entry, never a node or an edge, so nothing it finds becomes a graph fact on its own.
- The dream insights prompt section shows the most recent insights, not the most relevant ones to the current conversation, also by design for v1. There is no relevance ranking yet.
- No transcript-level attribution for dream feedback, no consolidation across dreams, no dream series, no way to ask for a dream about something specific, and feedback does not change what gets selected for future dreams. All are recorded as later work in [docs/dreaming.md](docs/dreaming.md).
- Supported running on a runtime other than Node. The refactor described above removes the assumptions that stopped it (no ambient filesystem, no native SQLite binding, no `node:http`, no system clock or timezone), and the memory engine and the HTTP core have now been run on Cloudflare Workers, though by the hosted product built on this rather than from here. Bun and Deno remain untried by anyone. Nothing in this repository's own suite exercises a non-Node runtime, so this is a removed obstacle and a downstream report, not a capability this project tests or supports.
- Providers other than OpenAI
- Any deployment target beyond running it yourself (no Cloudflare or VPS packaging)
- A view of pending legacy proposals in the browser. An earlier build listed them; the three section rework dropped that panel. The engine already materializes and resolves any leftover proposals silently the moment it opens, so there is normally nothing left to show, but if your memory folder still holds some there is now no way to see them in the interface
- A dedicated commitments view in the browser's Record section (open, resolved, quiet, as the design calls for). Commitment nodes render like any other node type in the graph atlas, and that is the only place they are currently visible in the interface
- Realm influence or a history time lens in the atlas (see above)
- Pages for entities: they get a node in the graph, not a maintained document, in this release
- Monthly and yearly rollups (only daily and weekly exist)
- Any way to make reverie forget. The feature exists in code and is tested, but it is deliberately unexposed: no tool, no persona instruction, and no CLI command reaches it. Deleting or editing a page under `people/` or `arcs/` removes the prose, but not the record: the node it corresponds to, its edges, and every attribution that named it still live in `graph.jsonl`, nothing in the product retracts them, and the agent can still surface what the graph knows about a person or arc whose page you deleted. Running `reindex` does clear the deleted page's stale rows out of the search index, so it stops turning up in `search_memory` hits, but `reindex` rebuilds the graph from `graph.jsonl` exactly as it already was, so the node and its edges come straight back. There is currently no user-accessible way to remove a node, an edge, or an attribution at all.

The architecture and memory model are specified in full in [the design spec](docs/superpowers/specs/2026-08-13-openreverie-design.md). This README is updated honestly as the project progresses; if this section says something works, it works.


v0.9.1 is a packaging release with no behaviour change: it publishes the four engine packages a host
imports (`@openreverie/core`, `@openreverie/memory`, `@openreverie/providers`,
`@openreverie/server`) plus `@openreverie/web`, which v0.9.0 did not, so building on this engine no
longer means depending on a working copy of this repository. `@openreverie/web` also stopped being a
hard dependency of the server, so a host serving the API without the browser interface no longer
installs React to do it. See [docs/releases/v0.9.1.md](docs/releases/v0.9.1.md).

v0.9.0 shipped before it. It answered a single consolidated request from a hosted deployment building
on this engine, and where v0.8.0 made the engine runnable by a host with no local filesystem, this
release makes it survivable by a host whose process evicts between one message and the next. See
[docs/releases/v0.9.0.md](docs/releases/v0.9.0.md) for the full account. Unlike v0.8.0, this one does
change things a self-hosted person can see, so it is not described as invisible. Ending a conversation in the browser now returns as soon as the transcript
is durable, with reflection continuing behind it, where it used to wait for one or two more model
calls plus a rewrite for every arc and person that changed. The terminal's own path is unchanged and
still waits. Two new things appear in the memory folder: `sessions/log.jsonl`, an append-only record
of every reflection attempt and how it resolved, and a `system-prompt.txt` in each session
directory holding the prompt that session was actually opened with. Sessions now report whether
their reflection has not started, is in progress, finished, was skipped, or failed and why, so a
reflection that dies partway is no longer invisible; before this, it left the session looking
untouched and nothing on disk said it had ever been tried.

Also in that round: `POST /api/v1/sessions` accepts `greet: false` for a client whose person opens
by typing rather than being greeted; `LiveSessionRegistry` takes its idle timeout, sweep intervals
and greeting timeout as options and can have its sweeps turned off outright, for a host that owns
session lifetime itself; and `OpenAiConfig` accepts extra headers, so a self-hoster routing through
a provider gateway can turn off that gateway's payload logging instead of silently shipping every
conversation into its logs.

Two things from that round are reachable by code and not yet by a person, and the distinction
matters. `GET /api/v1/search` exposes the same hybrid search the companion already had through its
own tool, but **no browser UI calls it yet**, so searching your own memory from the web interface
still is not a thing you can do. Session resume is built as a library seam, `AgentSession.resume`
and `LiveSessionRegistry.resume`, with **no HTTP route**, because it is driven by a host that keeps
its own durable record of which session is live; a self-hosted browser user cannot resume a session.
Resume is covered by the automated suite and has never been run against a real model or a real
process that evicts between messages, so the machinery is tested and the behaviour in a live
deployment is not. Search also has no lexical fallback: with no provider configured it returns an
honest 503 rather than the keyword half it could have computed, which is recorded in
[BACKLOG.md](BACKLOG.md).

## Command reference

Subcommands of the same binary:

- `web`: starts the local web interface and prints its bootstrap URL. The server listens on `127.0.0.1` only, so only processes on your own machine can reach it. Copy the printed URL into your browser to start; the command does not open the browser for you.
- `reindex`: rebuilds the SQLite search index from your memory folder from scratch. Safe to run any time; the index is always derived and disposable.
- `reflect`: runs maintenance on demand (reflects any stale unreflected sessions, builds any daily or weekly rollups that are due) instead of waiting for it to happen automatically.
- `read`: prints part of your memory record straight from the files on disk. With no arguments it lists your constitution, arcs, realms, and people; `read constitution` prints the constitution in full; `read arc <name>`, `read realm <name>`, and `read person <name>` print one document by a case-insensitive substring match on its name. This is a plain filesystem read: it works even with no model provider configured or reachable, since seeing what is being kept about you should never depend on the network being up.
- `migrate`: applies pending memory-folder migrations, deliberately and once. `migrate --dry-run` reports what would change without changing anything; `migrate --list` shows each migration as pending or applied. Migrations seed `profile.md` into pre-existing folders, discard UTC-dated rollups so they rebuild on local-day boundaries, and move a `[style]` table still sitting in `config.toml` into `profile.md`, removing it from the config file. Run it once after upgrading from a release that predates the timezone, profile, or modes work; `loadConfig` refuses to start until you do, if `config.toml` still has `[style]`.
- `doctor`: checks whether reverie is set up correctly (config file, API key, memory folder, its git state, the SQLite index) and prints one line per check. Never prints a secret value, and never opens a full engine or makes a network call.
- `version` (or `--version`/`-v`): prints the installed version and exits.
- `help [command]` (or `--help`/`-h`, or `<command> --help`): prints the command list, or one command's own help.
- `--config <path>`: use a config file at this path instead of `~/.reverie/config.toml`, before or after the subcommand.

Inside the terminal chat itself, a few commands work at the prompt:

- `/mode [name]`: with no name, lists the ten modes and marks the current one. With a name, switches to it for the rest of this conversation only; it is never remembered for the next one, and it never changes your safety mode.
- `/style [axis] [value]`: with nothing, shows your current engagement, tone, and orientation. With an axis and a value, changes that one axis, saved to `profile.md`, and it lasts across sessions until you change it again.
- `/settings`: shows your safety mode (changed only by hand in the config file) and your memory folder path.
- `/whoami`: shows your profile exactly as reverie currently has it recorded (preferred name, pronouns, location, timezone, birthday, occupation, birthday greetings), each field plainly marked "not known" rather than guessed at when it is unset.
- `/help`: lists all of these.
- `/bye`: ends the session. Closing the terminal or pressing Ctrl-D does the same thing.

A persistent status strip above the prompt shows the active mode and the local time throughout the conversation, when your terminal supports color; a piped or non-interactive session gets none.

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

The engine and server can also be embedded by a host other than this repository's own CLI: see [docs/hosting.md](docs/hosting.md) for what a host supplies and what it can customize.

## Roadmap

1. Memory engine and agent core behind a terminal CLI (done, v0.1.0)
2. Web interface and local auth (done, v0.4.0)
3. More provider adapters (Anthropic, OpenRouter, Cloudflare AI Gateway, DeepSeek, local models)
4. Alternate deployment targets (Cloudflare, VPS)
5. Phase C atlas polish (realm influence, history time lens)

Remaining tasks and contributor-friendly starting points are canonical in [BACKLOG.md](BACKLOG.md). [ROADMAP.md](ROADMAP.md) holds the honest Done narrative and current direction, and points back at BACKLOG.md rather than keeping its own list.

## Development

This project is built with heavy use of AI coding agents, directed and reviewed by a human who has worked in software, ML, and AI for over a decade. That direction is closer to working with a team of agents than to unreviewed "vibe coding": every change is planned, read, and tested before it merges, and the human decides what ships. That is stated plainly because you deserve to know how the code you might trust with your inner life gets written. Agent instructions live in [AGENTS.md](AGENTS.md) and the design lives in the spec; both are kept current.

Contributions are welcome from people who know what they are doing. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; this codebase serves a sensitive purpose and casual drive-by changes carry real risk for its users.

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2). This is source-available, not OSI-approved open source: the [Open Source Initiative](https://opensource.org/) requires a license not to restrict commercial use, and this one does, deliberately.

In plain terms: you can read, run, modify, and self-host openreverie for anything except reselling or rehosting it (or a modified version of it) as a competing commercial product or service. Internal use, non-commercial research and education, and professional services you provide using it are all explicitly permitted. Two years after each version is published, that version automatically becomes available under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), a permissive, fully open-source license, with no action required from anyone.
