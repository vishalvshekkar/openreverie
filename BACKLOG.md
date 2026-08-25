# Backlog

This file is canonical for everything named but not yet started: deferred work, known gaps,
ideas, and features not built. If it has not shipped, it lives here. `ROADMAP.md` holds the
honest Done narrative and the current direction; it does not keep its own list of future work.

To add an entry, follow the policy in `AGENTS.md` under "Backlog and roadmap": every deferral
gets recorded in the same change that makes it, with the five fields that policy names (what it
is, why it was deferred, where the thinking lives, what would trigger picking it up, rough size).
Never invent a reason or a trigger the source did not give; write `not stated` instead. When an
item ships, remove it from here and record it in `ROADMAP.md`'s Done narrative.

## 1. Known defects and gaps

- **A newer chat model can quietly stop using memory, and nothing in openreverie notices.**
  Observed on 2026-08-20 against v0.6.0 by changing `models.chat` in `config.toml` from `gpt-5`
  to `gpt-5.1` and back, with no code change in between. On `gpt-5.1` the companion answered
  normally, and much faster, while almost entirely giving up on tools: one `search_memory` call
  across twelve user messages, and no `remember` calls at all, against roughly one to two
  tool-calling rounds per user message on `gpt-5` over the preceding days. Switching back to
  `gpt-5` restored tool calls on the very first message. `tool_choice` is never sent, so OpenAI's
  `auto` default applies and whether memory is consulted at all rests on the model's inclination.

  Ruled out already, so nobody repeats the work: not a v0.6.0 regression (no source diff in
  `packages/providers/` between the v0.5.0 and v0.6.0 tags beyond version and license fields,
  `MAX_TOOL_ROUNDS` is 8 at both, default chat model is `gpt-5` at both); not a streaming or
  parsing problem (the one tool call `gpt-5.1` did emit was reassembled and dispatched correctly);
  not a rejected request (tools are attached on every round and the call is accepted); nothing in
  the codebase branches on the model id.

  What to evaluate when picked up: reproduce with a fixed prompt set across `gpt-5`, `gpt-5.1` and
  whatever is current, counting tool calls per user message (session transcripts already record
  `toolCalls` per assistant message); whether sending `tool_choice` explicitly changes the
  disposition, and what that costs in latency; whether a deterministic pre-turn `search_memory`
  folded into context the way `context.ts` already folds in arcs and summaries is a better answer
  than leaving recall to the model's judgment; a `doctor` check or startup warning when
  `models.chat` is outside a known-good list; whether the Responses API migration (below) changes
  any of this.
  - Why deferred: "Decided on 2026-08-24 to leave recorded and pick up later. It is an evaluation
    question (`tool_choice`, a deterministic pre-turn search, a doctor check), not a file fix, and
    folding it in here would change what the retrieval work is being judged against."
  - Where: `docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md`, "Explicitly out of
    scope".
  - Trigger: not stated.
  - Size: medium (an evaluation pass first, then a fix shaped by what it finds).

- **A live provider reachability check in `doctor` (`doctor --live`).** `reverie doctor` confirms
  a configured API key resolves, not that the model actually responds.
  - Why deferred: "checking that a key *resolves* is not the same as checking that it *works*, and
    this spec does not add a live provider ping, since a doctor command a person might run offline
    or before deciding to spend a token should not require network reachability to report anything
    at all."
  - Where: `docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md`, section 1.4 and
    "Deferred / out of scope".
  - Trigger: not stated.
  - Size: small.

- **Exit code 4 (Interrupted) is not extended to `reindex`/`reflect`.** It is scoped narrowly to
  interactive chat's own double-Ctrl-C handling today.
  - Why deferred: "Not needed for this spec's scope; noted so it is not forgotten if those
    commands change later."
  - Where: `docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md`, section 1.5 and
    "Open questions".
  - Trigger: `reindex` or `reflect` grow their own interrupt handling.
  - Size: small.

- **`reverie <subcommand> --help` and `help <subcommand>` show per-subcommand help; `reverie
  --help <subcommand>` (flag first) does not.** Hand-rolled argv parsing only checks `argv[0]` for
  a subcommand name once a bare `--help`/`-h` flag is found anywhere in argv.
  - Why deferred: "a deliberate, stated simplification of hand-rolled parsing."
  - Where: `docs/superpowers/plans/2026-08-17-cli-polish-and-ci-fix-plan.md`, Task 2 Step 2.4.
  - Trigger: not stated.
  - Size: small.

- **`packages/cli/src/read.ts`'s 19 `return 1` sites are not generalized to the exit-code-kind
  work.** Every other dispatch path distinguishes config error (2), provider error (3), and
  interrupted (4); `read.ts` still always returns 1 on any failure.
  - Why deferred: not stated ("grandfathered" is the only word given).
  - Where: `docs/superpowers/plans/2026-08-17-cli-polish-and-ci-fix-plan.md`, "File structure" /
    "Not modified" note, and the "Spec coverage" table.
  - Trigger: not stated.
  - Size: small.

- **The `engine.test.ts` git-sync CI flake fix is unverified beyond local runs.** The two-layer
  fix (`-c gc.auto=0` in `gitSync.ts`, a retry helper around the recursive `rm` in `afterEach`) has
  not reproduced the race locally, which is weaker than proving it cannot recur.
  - Why deferred: "Real confidence beyond this task comes from watching CI itself over the next
    several pushes to `main` for a recurrence of this exact `ENOTEMPTY` failure, or its absence,
    not from this task's local runs alone."
  - Where: `docs/superpowers/plans/2026-08-17-cli-polish-and-ci-fix-plan.md`, Task 10, Step 10.3.
  - Trigger: a recurrence of the `ENOTEMPTY` failure on `main`, or enough clean pushes to call it
    settled (neither threshold is stated).
  - Size: not stated (monitoring, not a code change, unless it recurs).

- **An injectable git-sync dependency on `EngineDeps`, and the default-injection policy that
  would follow it.** The deeper fix considered for the CI flake: making `commitMemory` an
  injected dependency so tests supply a no-op fake, removing all 82-of-87 real git subprocess
  spawns from `engine.test.ts` at the source, instead of the two shallower mitigations that
  shipped. A follow-on open question: should `EngineDeps` default to a real `commitMemory` so
  existing call sites are unaffected, or should every caller supply it explicitly.
  - Why deferred: "it is a cross-package interface change with its own blast radius (six call
    sites in production code, an `EngineDeps` shape change, wiring at every real construction
    point) that deserves to be scoped, tested, and reviewed as its own piece of work rather than
    riding in on a spec whose stated job is 'fix the thing that made CI red.'"
  - Where: `docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md`, section 2.4 and
    "Deferred / out of scope"; `docs/superpowers/plans/2026-08-17-cli-polish-and-ci-fix-plan.md`,
    Task 10 Step 10.3.
  - Trigger: not stated.
  - Size: medium (`EngineDeps` (`packages/memory/src/engine.ts:116-121`), `commitMemory`
    (`packages/memory/src/gitSync.ts`), call sites at `engine.ts` lines 520, 807, 882, 982, 1075,
    1202).

- **The CLI's EOF input loop depends on `case 'bye'` staying in the dispatch table.**
  `packages/cli/src/chat.ts` synthesizes `/bye` on readline EOF and relies entirely on that case to
  end the loop; if it is ever removed or renamed, EOF causes an infinite CPU-spinning hang instead
  of a clean failure.
  - Why deferred: "If the loop grows a second exit condition, consider tracking EOF explicitly and
    returning on it regardless of what the command table did. That is scope beyond the modes plan,
    so it was NOT done; raise it with the human first."
  - Where: `docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-3.md` and
    `-handoff-4.md`, "DEFERRED ITEMS AND OPEN ISSUES".
  - Trigger: raised with the human before doing it unasked (per the source's own instruction).
  - Size: small (roughly three lines, per the source).

- **`profileUpdatesSchema` rejects a `null` field instead of tolerating it.** A model reply
  containing `"profileUpdates": {"timezone": null}` fails the whole reflection parse and degrades
  the session to summary-only, even though models emit `null` for "nothing to report" routinely.
  - Why deferred: "This is the plan's design (Task 3 authored the schema strict and non-nullable,
    and its tests pin that), so it was not changed."
  - Where: `docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-3.md`, "Watch item carried
    forward from modes Batch B".
  - Trigger: "If reflection starts degrading to summary in real use, this is the first place to
    look."
  - Size: small (`profileUpdatesSchema`, `RESPONSE_SHAPE`).

- **`PublicSession.mode` survives onto tombstones even though the field is meant to be
  live-only.** `registry.ts`'s `end()` and `sweep()` build ended/expired session tombstones by
  spreading `live.public`, so `mode` carries over.
  - Why deferred: "The plan leaves those two functions untouched, so the behaviour was left as
    plan-faithful and the field's doc comment... was corrected to say so plainly rather than
    claiming 'live sessions only.'"
  - Where: `docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-4.md`, item 4.
  - Trigger: "If a later task wants mode to be genuinely live-only, that is a code change in
    `end()` and `sweep()`, not a comment change."
  - Size: small (`packages/server/src/registry.ts`).

- **A flaky-under-load test pattern recurring across files.** `keeps only recent expired sessions
  in the tombstone cache` (`packages/server/src/registry.test.ts:175`) intermittently times out
  under a loaded machine; the same pattern later surfaced in
  `packages/web/src/views/settings.test.tsx`, `packages/web/src/views/conversations.test.tsx`, and
  one unidentified test, always passing on rerun or in isolation.
  - Why deferred: "Left alone because fixing it means editing a test outside the modes plan's
    scope... If flakes under load keep surfacing in different files, that is worth raising with
    the human as a pattern rather than chasing file by file."
  - Where: `docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-3.md` and `-handoff-4.md`.
  - Trigger: the pattern recurring again (the source says raise it as a suite-level concern:
    parallelism, worker count, timeout margins, rather than one-off fixes). **This trigger has now
    fired:** the same test failed again on 2026-08-24 during a full-suite run with several agents
    working concurrently.
  - Evidence added 2026-08-24, which narrows it: the test is not wall-clock dependent. It injects
    its own clock (`now: () => now`) and a `FakeScheduler`, and it creates its 65 sessions
    sequentially, so there is no obvious logic race. Run in isolation it passed 5 times out of 5.
    That points at a vitest timeout under parallel load rather than a defect in `registry.ts`, so
    the suite-level fix the source recommends (worker count, timeout margins) looks like the right
    shape, and chasing the test's own logic would be wasted effort.
  - Size: not stated.

## 2. Retrieval and memory quality

- **`DocumentHit.snippet` and `chunks[0]` can name different physical chunks of the same
  document.** `snippet` comes from the document-level best rank in `fuseByReciprocalRank`, while
  `chunks` is ordered by a separate chunk-level RRF score computed across the raw candidate lists
  in `collectChunksByDocId`. When a chunk that is not the document's best-ranked one appears in
  both lanes, it can top the chunk-level ordering while a different chunk supplied `snippet`. The
  model then receives a payload whose headline passage is not the first of its own listed chunks.
  - Why deferred: found on 2026-08-24 while fixing snippet truncation, and it is pre-existing
    architecture rather than anything that fix introduced. Both values are honest full chunk text
    now, so nothing is truncated or wrong, which makes this a coherence issue rather than a
    correctness one. Re-architecting chunk selection was outside that task's scope.
  - Where: `packages/memory/src/retrieval.ts`, `fuseByReciprocalRank` and `collectChunksByDocId`.
  - Trigger: deciding whether `snippet` should simply be `chunks[0]`, which would remove the
    divergence and one of the two orderings. Worth doing if the retrieval payload is touched again
    for any reason.
  - Size: small.

- **A reranker for retrieval.** Deferred pending measurement: the cheap fixes (reviving the
  keyword lane, chunk-level payload) had to land and be measured first, because a reranker layered
  on a broken keyword lane measures the wrong thing.
  - Why deferred: "Reranking is deliberately **not** in this unit. A reranker layered on a dead
    keyword lane, a discarded snippet and a flattened fusion constant would be measuring the wrong
    thing. The decision waits on what A1 reports once A2 through A6 have landed." Also, from the
    context-and-retrieval spec: "No evidence yet that fusion of FTS and cosine is the weak link,"
    covering the related, undecided pieces of query rewriting (e.g. HyDE) and chunk-overlap
    windows.
  - Constraint to record: AGENTS.md forbids memory content reaching any service other than the
    user's configured model provider, and OpenAI has no rerank endpoint, so hosted rerankers
    (Cohere, Voyage) are ruled out. The two viable shapes are an LLM reranker through the
    already-configured provider, or a local cross-encoder.
  - Where: `docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md`, end of "Unit A:
    retrieval"; `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 11
    and section 13; `docs/retrieval.md`, "Known limitations".
  - Trigger: the retrieval eval harness showing what is still missing after the fixes that landed
    on 2026-08-24.
  - Size: medium to large, depending on the shape chosen.

- **Stemming in the FTS lane.** `toFtsQuery` now ORs terms, which revived the keyword lane, but
  there is no stemming. Verified directly: `MATCH '"flight"'` returns zero rows against a document
  containing "Flights". A query resting on a single mismatched word form still fails.
  - Why deferred: not stated.
  - Where: `packages/memory/src/sqlite.ts` (`toFtsQuery`, line 741).
  - Trigger: not stated.
  - Size: small.

- **Supersession and recency for facts in the graph.** Contradictory records coexist as live
  assertions with nothing marking the dead ones. Observed live: four mutually contradictory
  records of one cinema booking, all equally retrievable and equally ranked ("Wants help picking
  an IMAX showtime," "remains open and has not yet been confirmed," "Tickets are booked... Sunday
  6:45pm," "booked... around 6:40pm"). An item is a fact and a fact can only be appended; it has
  no identity, so it can never be revised. On the retrieval side, RRF scores are `1 / (60 + rank)`,
  so ordering carries no recency signal at all. The commitments design fixes this for commitments
  only (a commitment is a graph node with identity, so `assert` on an existing node id is a
  revision, and the full history stays in `graph.jsonl`), not for facts generally.
  - Why deferred: "That needs its own design conversation."
  - Where: `docs/superpowers/specs/2026-08-24-commitments-design.md`, "Why it needs to exist" (the
    identity-versus-append reasoning) and section 2; `docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md`,
    "Nothing distinguishes a plan from a memory" and "Explicitly out of scope".
  - Trigger: not stated.
  - Size: needs its own design conversation.

- **The retrieval eval corpus may be too small to detect ranking changes.** A grid search over
  `RRF_K` (1 to 120) and `CANDIDATE_LIMIT` (20 to 100) moved recall@5 not at all and moved no
  individual query's rank, so both constants were left unchanged (`packages/memory/src/retrieval.ts`,
  lines 30-49). That flat result may mean the constants do not matter, or may mean a 35-document
  fixture corpus with a bag-of-words embedding stub cannot detect the difference. Related: the
  recency tiebreaker added the same day was kept on a neutral result, so it is carried on reasoning
  rather than evidence.
  - Why deferred: not stated beyond the grid-search result itself.
  - Where: `packages/memory/src/retrieval.ts` (comment above `CANDIDATE_LIMIT`/`RRF_K`);
    `packages/memory/src/retrievalEval.ts`, `packages/memory/src/evalFixtures.ts`,
    `packages/memory/src/evalEmbeddingStub.ts`.
  - Trigger: wanting to tune ranking with confidence.
  - Size: medium.

- **No approximate-nearest-neighbor (ANN) index for vector search.** `MemoryIndex.searchVector`
  reads and scores every embedding row on every search in JavaScript, with no ANN index and no
  vector extension (such as `sqlite-vec`) in the loop.
  - Why deferred: "This is fine at the size of one person's memory folder, but it is a real
    ceiling... No rewrite is designed, and none should be attempted before those numbers exist,"
    referring to corpus-size, timing-split, and end-to-end latency measurements that do not exist
    yet.
  - Where: `docs/retrieval.md`, "Known limitations" and "Query time"; `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`,
    section 9 and section 13.
  - Trigger: roughly one to three years of daily use, per section 9's own estimate.
  - Size: large.

- **Entities never get a maintained page, so they stay outside the document index and outside
  `search_memory`'s document lane.** Entities (books, films, companies, places) get a graph node
  only. The node lane can find them by name; the document lane cannot find them by content, and
  `EntityRow` (`listEntities`'s return shape) deliberately carries no `hasPage` and no `docId`,
  unlike `PersonRow`. The same is true of a person mentioned but not yet paged.
  - Why deferred: "deliberately, until it is clear whether a maintained page per film reads well."
    Also: "entities have no pages in this release, and emitting `hasPage: false` on every row
    would imply a page might exist. If entity pages ever arrive, the shape gains the fields then."
  - Where: `docs/superpowers/specs/2026-08-15-remember-by-default-design.md`, section 4 and
    section 8; `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 6;
    `docs/superpowers/plans/2026-08-17-context-and-retrieval-plan.md`, Task 9; `docs/retrieval.md`,
    "Known limitations".
  - Trigger: not stated.
  - Size: medium.

- **Mode-aware retrieval.** `search_memory` and related tools behave identically regardless of
  which conversation mode is active; `boost` mode searches more, but only through the ordinary
  tools, and nothing about what is fetched changes by mode.
  - Why deferred: "Modes change the prompt, not what is fetched from memory." Also: "The modes
    spec explicitly leaves this alone and so does this one."
  - Where: `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 13, item
    8; `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 17, item 22.
  - Trigger: not stated.
  - Size: not stated.
  - Related but distinct: ROADMAP's carried-over "Tool exposure is not gated by mode, only by
    prompt text" (section 5 below) is about which *tools* are offered, not what retrieval returns.

- **Constitution compaction.** The chat prompt caps the constitution at 6,000 characters, but
  reflection's own prompt receives the full, uncapped constitution, which can grow without bound
  and dominate the reflection call over time. A compaction pass (the model rewriting the
  constitution shorter, deliberately) is the plausible shape of a fix.
  - Why deferred: "it is a change to the one document the project treats as the living record of
    the person and should not be designed casually."
  - Where: `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 7 and
    section 13, and section 14 open question 2 (`buildReflectionContext`, `engine.ts:1704`
    onward; `capBody`).
  - Trigger: not stated.
  - Size: medium.

- **`docId` is omitted from the prompt's People, Realms, and Arcs sections.** The model must go
  through a listing tool to fetch a page rather than reading the id straight off the prompt.
  - Why deferred: "a 26-character id per row against a 40-person list is roughly 1,100 characters
    of every prompt, and the fetch path already exists through the listing tools... rejected on
    budget grounds."
  - Where: `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 4 and
    section 13 (`context.ts`, `list_people`).
  - Trigger: not stated.
  - Size: small.

- **A `graph_query` kind that resolves a single node id straight to its `docId`.** Considered as
  a fourth `graph_query` kind, instead of going through `list_people`.
  - Why deferred: "Redundant with `list_people` today."
  - Where: `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 4 and
    section 13.
  - Trigger: "Revisit if the extra hop shows up in practice."
  - Size: small.

- **Recent intentions have no listing tool or fetch path.** When the "Recent intentions" prompt
  section truncates, the marker can only report a count. Unlike arcs, people, entities, and
  realms, there is no `list_intentions`-style tool and no `read_document`-style fetch key.
  - Why deferred: "Intentions have no listing tool and no fetch path of their own, so a marker
    here can only state the count. The five-row cap keeps this unreachable in practice; the
    character cap is a budget backstop."
  - Where: `docs/superpowers/plans/2026-08-17-context-and-retrieval-plan.md`, Task 15
    (`recentIntentionsSection`, `RECENT_INTENTIONS_SECTION_CAP`).
  - Trigger: not stated.
  - Size: small.

- **Three tuning constants set by spec judgment, not by measurement, and never revisited.**
  Whether the 6,000-character constitution cap is right ("No real constitution has been measured
  against it, because no long-running folder exists yet to measure. The number should be
  revisited against a real folder before v0.5.0 ships," `context.ts`); whether
  `list_people`'s default sort should stay recency order or switch to alphabetical for the web
  atlas ("If the atlas ever renders this, the two consumers may want different orders, and the
  tool should probably take a sort argument rather than pick one"); whether `WEEKLY_INDEX_CAP =
  12` weekly rollups shown in the "Rollups available" shelf is the right number versus, say, 26
  ("This is the kind of number that should be set by watching what people actually ask about").
  - Why deferred: quoted per constant above.
  - Where: `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 14, open
    questions 1, 3, and 4.
  - Trigger: not stated for any of the three.
  - Size: small each.

- **Cache-control breakpoints in `@openreverie/providers`.** Explicit `cache_control` plumbing on
  `ChatRequest`, beyond the implicit prefix-stability the per-message time stamping already
  provides.
  - Why deferred: "this spec does not add explicit `cache_control` plumbing to `ChatRequest`...,
    and it has not measured actual cache hit rates against any provider."
  - Where: `docs/superpowers/specs/2026-08-16-time-as-first-class-design.md`, section 10, fifth
    bullet (`ChatRequest`, `packages/providers/src/types.ts:27-34`).
  - Trigger: "a future provider or a measured cache-hit-rate problem."
  - Size: small.

## 3. Companion behavior

- **Six deferred pieces of the commitments design**, a new first-class entity for a bounded thing
  the person means to do (`docs/superpowers/specs/2026-08-24-commitments-design.md`, itself "Not
  yet planned or implemented" as of 2026-08-24):
  - *Projects as a distinct entity type.* Not introduced; the cheap alternative is an optional
    completion condition on arcs. Why deferred: "Adding a project type means every reflection call
    must first answer 'is this an arc or a project', and that answer will be inconsistent across
    sessions, which is how an ontology rots." Trigger: "Revisit only after commitments have been
    used for real." Size: not stated. Where: section 1 and section 10.
  - *Recurring commitments* ("every Sunday", "workout daily"). Why deferred: "A different shape
    that needs its own thinking. A single commitment is not the right container." Trigger: not
    stated. Size: not stated. Where: section 3 and section 10.
  - *Duration and effort on a commitment.* Why deferred: "'It will take a couple of weeks' is not
    a when." Trigger: not stated. Size: not stated. Where: section 10.
  - *Notifications or reminders tied to a commitment.* Why deferred: "Nothing in this project
    reaches out. The companion speaks when a session opens, and that is the only channel."
    Trigger: not stated. Size: not stated. Where: section 10.
  - *Editing commitments from the browser.* Read-only this round. Why deferred: "consistent with
    how the Journal tab shipped." Trigger: not stated. Size: not stated. Where: section 8 and
    section 10.
  - *A page for a commitment.* Why deferred: "Arcs and people earn pages once they recur or
    clearly matter, and a commitment revised repeatedly over months is a plausible future
    candidate. It is easy to add later and awkward to remove." Trigger: "seeing that happen in
    real use, not deciding it in advance." Size: not stated. Where: section 10 and section 11.

- **The browser's dedicated commitments view (spec Section 8) is not built.** Section 8 says
  "The browser's Record section gains a commitments view: what is open, what resolved, what is
  quiet," read-only. That view does not exist yet: `packages/web/src/atlas.tsx` added
  `'commitment'` as a node type so the graph atlas renders commitment nodes like any other node
  (its own comment there says this is "a minimal, functional default, not a considered design"),
  but nothing lists commitments the way the Record section's other tabs list their own kind. This
  is distinct from the already-recorded "editing commitments from the browser" deferral above,
  which assumes a read-only view exists and only editing is missing; the view itself is what is
  missing here.
  - Why deferred: not stated (the commitments design scoped the browser view to "a separate plan"
    per `atlas.tsx`'s own comment; no reason is given beyond that).
  - Where the thinking lives: spec Section 8; `packages/web/src/atlas.tsx` lines 20 to 29 (the
    `NODE_TYPES` comment); task-8-report.md (this task, which surfaced commitments in the chat
    prompt only, not the browser).
  - Trigger: the separate plan atlas.tsx's comment refers to, once it exists.
  - Size: not stated.

- **`waitsOn` is stored as free text, not the graph edge the spec calls for, and the
  reactivation half of the mechanism does not exist.** Spec Section 5 says the honest
  representation is a graph edge: "the commitment `waitsOn` another node, which usually already
  exists... It becomes eligible only once the thing it waits on is recorded as having happened."
  Task 3 implemented `waitsOn` as a plain string on `CommitmentPayload` instead
  (`packages/memory/src/commitments.ts`), and its own report already flagged this: "waitsOn is
  stored as a payload string only; nothing yet emits the waits_on edge Task 1 added to EdgeType.
  That wiring is not part of this task's brief." Task 6 briefly exposed `waitsOn` on the live
  `remember` tool's commitment shape, which meant a single tool call could set a field that
  `selectCommitments` then excludes from time-based selection permanently, with nothing anywhere
  that reactivates it. That live-reachability was closed the same task it was found: the
  `remember` tool's `rememberCommitmentArgs` (`packages/core/src/tools.ts`) no longer accepts
  `waitsOn`, and the tool description and JSON schema the model sees no longer mention it. A call
  carrying `waitsOn` is now refused, not silently dropped, because `rememberCommitmentArgs` is a
  `z.strictObject`. `Commitment.waitsOn` still exists on the record type, the `waits_on` edge type
  still exists in the graph vocabulary, and `selectCommitments` still excludes any commitment with
  `waitsOn` set: none of that changed, because the data model is correct, only unreachable from
  the tool, which is the right state until the rest of the mechanism is built. The spec's promised
  "becomes eligible once the awaited thing happens" is still not implemented, and neither
  `reviseCommitment` nor the `remember` tool's `reviseCommitment` shape can clear `waitsOn` once
  set (moot while the field cannot be set from the tool, but true of the data layer itself).
  - Why deferred: not stated (Task 3's brief scoped the graph-edge wiring out with no reason given
    beyond it not being part of that task).
  - Where the thinking lives: spec Section 5; `packages/memory/src/commitments.ts` (the `waitsOn`
    field and `selectCommitments`); `packages/core/src/tools.ts` (the comment at
    `rememberCommitmentArgs` explaining why the field is absent from the tool); task-3-report.md's
    Concerns section.
  - Trigger: implementing the `waits_on` graph edge and the reactivation check ("once the awaited
    thing is recorded as having happened") that Section 5 specifies. Only once that exists should
    `waitsOn` return to the live tool surface.
  - Size: not stated.

- **The real `askedAt`/one-ask mechanism (spec Section 6) is not built; an interim time-bound
  stands in for it.** Spec Section 6: "A commitment whose window has passed with no recorded
  outcome becomes eligible for exactly one natural follow-up. Asking it sets `askedAt`. It is
  never raised again and resolves to `unknown`." Nothing anywhere writes `askedAt` or transitions
  a commitment to `unknown`: the 2026-08-25 final review (Critical 2) found the field had a reader
  in `selectCommitments` and no writer anywhere in `packages/*/src/`, so a passed-window
  commitment with no recorded outcome surfaced every session indefinitely, the exact taskmaster
  behavior the feature exists to prevent. The proper fix needs the companion to signal that it
  actually raised a commitment during a live conversation turn, which is a live-session feature
  this review's scope could not build (fixing it, per the controller's own ruling on the finding,
  "needs the companion to signal that it raised something, which is a live-session feature too
  large for this branch"). As an interim anti-nag guard, `isTimeEligible`
  (`packages/memory/src/commitments.ts`) now bounds eligibility above with a fixed grace period
  (`ASK_GRACE_DAYS`, currently 14 days) after a commitment's window closes, after which it stops
  entering the session prompt on its own, with no outcome ever recorded and no `askedAt` ever set.
  That gets most of the same practical effect (a passed-window commitment does not nag forever)
  without inventing a fake ask, but it is explicitly not the spec's own design: there is still no
  `unknown` state reachable in production, and a commitment that ages out through the grace period
  is silently dropped from the standing prompt rather than resolved to anything.
  - Why deferred: controller ruling on Critical 2 (2026-08-25 final review): "Do NOT invent an
    `askedAt` writer. Doing it properly needs the companion to signal that it raised something,
    which is a live-session feature too large for this branch."
  - Where the thinking lives: spec Section 6; `packages/memory/src/commitments.ts`
    (`isTimeEligible`, `ASK_GRACE_DAYS`, and `selectCommitments`'s `askedAt` filter, which has no
    production caller yet); `.superpowers/sdd/2026-08-24-commitments-engine/final-review-part2.md`,
    Critical 2.
  - Trigger: a live-session signal that the companion actually raised a commitment in
    conversation (an explicit tool call, or an inferred one from the transcript at reflection
    time), which the writer and the `unknown` transition would both key off.
  - Size: medium (needs a live-session design decision, not only a data-layer change).

- **Proposals returning for arbitration, in a non-conversational surface.** Not permission to
  remember, but arbitration only the user can settle: merging two nodes that turn out to be the
  same human, closing an arc gone quiet, resolving a contradiction between what was said months
  ago and today.
  - Why deferred: "Not in this release."
  - Where: `docs/superpowers/specs/2026-08-15-remember-by-default-design.md`, section 2 and
    section 8 (`proposals.jsonl`).
  - Trigger: not stated.
  - Size: not stated.

- **A first-class open-threads or reminders subsystem**, distinct from resurfacing existing
  intentions and arcs.
  - Why deferred: "Intentions and arcs already exist; what was missing was resurfacing. If use
    shows this is not enough, a first-class version belongs in the web interface release, where a
    surface exists to display it."
  - Where: `docs/superpowers/specs/2026-08-15-remember-by-default-design.md`, section 5 and
    section 8 (`SessionContext`, `intention` items).
  - Trigger: use showing resurfacing is not enough (per the quote above).
  - Size: not stated.

- **Provenance on `profile.md` fields.** Which surface (live tool, reflection, settings pane,
  setup) set a given field, and when, so reflection could be prevented from overwriting a value
  the user set by hand. There is no provenance tracking today; the effective rule is last write
  wins.
  - Why deferred: not stated.
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 3.2 and
    section 17.
  - Trigger: not stated.
  - Size: medium.

- **Per-browser mode memory.** The web interface does not remember which mode was last used in a
  given browser. (Distinct from the rejected persisted-default-mode idea in section 6 below; this
  is browser-local memory, not a saved profile field, and was not itself rejected in the source.)
  - Why deferred: not stated.
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 17.
  - Trigger: not stated.
  - Size: small.

- **Editing safety mode from any interface.** Safety mode (companion/firewall) cannot be changed
  from the CLI, web settings pane, or any HTTP endpoint; it stays a hand edit of `config.toml`.
  Handle any future work here carefully: AGENTS.md requires explicit human sign-off before
  crisis-behavior handling changes.
  - Why deferred: "Safety mode stays in `config.toml` even though it is personal. It is
    safety-critical, it is chosen deliberately at setup with no default offered..., and reflection
    writes to `profile.md`. A file a model writes into must not be the file that decides crisis
    behaviour."
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 3.1,
    section 13.2, and section 17 (`config.toml`, `GET /api/v1/settings`, no corresponding
    `PATCH`).
  - Trigger: not stated.
  - Size: not stated.

- **Editing crisis resources from the web settings pane.** Same safety-sensitivity note as
  above applies.
  - Why deferred: "Same reasoning" (the safety-mode item immediately above).
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 17.
  - Trigger: not stated.
  - Size: not stated.

- **Custom or user-defined modes.** The ten modes are fixed; there is no way for a user to define
  their own.
  - Why deferred: not stated ("Ten fixed modes is the whole catalogue" is the only statement
    given).
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 17
    (`Mode` interface).
  - Trigger: not stated.
  - Size: medium.

- **`/settings` is read-only.** The CLI command only prints current settings; it cannot change
  anything.
  - Why deferred: not stated ("Read-only in this release" is the only statement given).
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 10.2.
  - Trigger: not stated.
  - Size: medium.

- **Open question: should `/style` use a numbered menu instead of `<axis> <value>` arguments?**
  - Why deferred: "The argument form is specified above because it is one round trip and trivially
    testable. The menu form matches setup and needs no memorized enum values. Either is compatible
    with everything else here."
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 18, open
    question 1.
  - Trigger: not stated.
  - Size: small.

- **Open question: should the status strip mark an unconfirmed (system-default) timezone?** For
  instance a trailing `?` or a different color, rather than just omitting the place name.
  - Why deferred: "depends on how often a system-default zone actually survives the first
    conversation, which is not knowable until the time spec ships."
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 18, open
    question 2 (`renderStatusStrip`).
  - Trigger: not stated (the time spec has since shipped; the question was never revisited).
  - Size: small.

- **Open question: concurrent CLI and web sessions on the same memory folder, in different
  modes.** What happens when the same folder is open in both at once, each potentially in a
  different mode.
  - Why deferred: "worth confirming against the registry's live-session handling before
    implementation rather than after."
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 18, open
    question 3 (session registry).
  - Trigger: not stated.
  - Size: not stated.
  - Related but distinct: the profile-cache-invalidation item below is about a stale in-memory
    cache across processes, not this session/mode question.

- **Open question: does `boost` mode need its own retrieval/tool-round budget?** Its quality
  depends on how much of the record it reads; whether it should get a raised `MAX_TOOL_ROUNDS`
  instead of the shared limit every mode uses.
  - Why deferred: "Raising it for one mode is a change to the loop's shape, so it is not being
    done blind; it is worth measuring during the dogfooding pass... before deciding."
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 18, open
    question 4 (`MAX_TOOL_ROUNDS`, `agent.ts:29`).
  - Trigger: not stated.
  - Size: small.

- **Open question: profile cache invalidation across process boundaries.** If multiple
  `MemoryEngine` instances ever run concurrently against the same memory folder (two CLI sessions,
  or CLI plus a running server), a profile update from one would not be visible to the other until
  it happens to reload.
  - Why deferred: "worth naming as a boundary this spec does not solve, in case `server`'s
    existing concurrency story already has an answer that should be reused rather than
    re-invented later."
  - Where: `docs/superpowers/specs/2026-08-16-time-as-first-class-design.md`, section 11, open
    question 1 (`MemoryEngine` profile cache).
  - Trigger: not stated.
  - Size: not stated.
  - Related but distinct: this is not the same claim as "Advisory locking for the memory folder"
    (section 5 below), which is about a reflection race on a stale session, not cache staleness.

- **Purging forgotten content from the memory folder's git history.** `forget` is a forward-only
  redaction; removed content remains recoverable from git history.
  - Why deferred: not stated (the source explains current forward-only behavior, not why a purge
    path itself was not built).
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 2 and
    section 10; `docs/superpowers/plans/2026-08-14-phase-a-companion-quality.md`, Task 14.
  - Trigger: not stated.
  - Size: medium.

- **Extending `forget` to session summaries and the items inside them.** Once exposed (see
  section 5 below), `forget` does not reach session `summary.md` files or the reflection items
  recorded within them.
  - Why deferred: "A summary is the record of a session, sitting closer to the transcript than to
    the forward-looking record. Extending forget to reach items is a roadmap item, not part of
    this release."
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 2 and
    section 10; `docs/superpowers/plans/2026-08-14-phase-a-companion-quality.md`, Task 14.
  - Trigger: not stated.
  - Size: medium.

- **Em dashes in the companion's conversational voice.** AGENTS.md's no-em-dash rule is scoped
  to repository prose; the persona's actual conversational output still uses em dashes.
  - Why deferred: "The companion writes them. AGENTS.md scopes the no-em-dash rule to repo prose,
    so this is not silently added to the persona. Flagged for the owner, not actioned."
  - Where: `docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md`, "Explicitly out of
    scope".
  - Trigger: not stated (an owner decision is needed on whether to extend the rule).
  - Size: small, if decided.

- **Journal and note import.** Importing external journal exports (Day One, plain text folders)
  or notes into `journal/`, including bulk writes and format detection.
  - Why deferred: "explicitly parked by the human who commissioned this spec. It is out of scope
    here entirely: no importer, no format detection for external journal exports... no bulk-write
    path into `journal/`."
  - Where: `docs/superpowers/specs/2026-08-16-journal-mode-design.md`, section 3 and section 14
    (`journal/`, `entryDate`, `recordedAt`, `method`).
  - Trigger: not stated.
  - Size: medium.
  - Related: `writeJournalEntry`'s `entryDate` and `recordedAt` fields were built independently
    settable specifically "so a future importer can set a historical entryDate without a
    migration" (`docs/superpowers/plans/2026-08-17-journal-mode-plan.md`, Task 3), so the
    primitive this would build on already exists.

- **Per-method journaling activity level as structured data instead of free prose.**
  `journaling.md`'s "agent activity level" (active vs. hang-back, per method) is free prose the
  model reads and reasons about, not a structured per-method map in frontmatter.
  - Why deferred: "Whether that turns out to be reliable enough in practice, versus needing a
    small structured table inside the document's frontmatter, is worth revisiting after real
    dogfooding."
  - Where: `docs/superpowers/specs/2026-08-16-journal-mode-design.md`, section 8 and section 15,
    open question 1 (`journaling.md`).
  - Trigger: not stated explicitly beyond "after real dogfooding."
  - Size: small.

- **Whether journal-session items should be structurally distinguishable from ordinary items.**
  No `'journal_entry'` node type or new `ReflectionItemKind` exists; whether the web atlas or
  `search_memory` should be able to filter on journal-originated activity is unresolved.
  - Why deferred: "if it turns out to matter once journal mode is in real use, that is an
    additive follow-up, not a reason to add speculative structure today."
  - Where: `docs/superpowers/specs/2026-08-16-journal-mode-design.md`, section 11 and section 15,
    open question 2 (`NodeType`, `packages/memory/src/graph.ts`, `ReflectionItemKind`).
  - Trigger: journal mode seeing real use and the distinction mattering.
  - Size: small to medium.

- **Rollups reflecting journaling cadence.** A rollup stating cadence itself (for instance, "you
  journaled three times this week") would require a rollup builder to scan the `journal/`
  directory directly; rollups do not do this today.
  - Why deferred: "If a future need arises to reflect journaling cadence itself in a rollup...,
    that is a `journal/` directory scan a rollup builder could add later, not something this spec
    builds now."
  - Where: `docs/superpowers/specs/2026-08-16-journal-mode-design.md`, section 11
    (`buildDailyRollup`, `buildWeeklyRollup`, `packages/memory/src/rollups.ts`).
  - Trigger: not stated.
  - Size: small.

- **Whether `packages/web` needs its own local-time rendering.** The design spec raised whether
  the web package needs local-time rendering logic of its own, versus only ever displaying what
  `server` sends it; the time plan answered no for this round and made only a schema-widening
  change, without auditing whether `server`'s response shapes already carry raw UTC timestamps
  needing the same treatment.
  - Why deferred: "auditing `server`'s response shapes was out of scope for this pass and is
    worth a follow-up look before implementation begins." Also, from the plan that decided this:
    "The only `web` change here is widening one response schema so a new optional field is not
    rejected. Do not build local-time rendering in the browser UI."
  - Where: `docs/superpowers/specs/2026-08-16-time-as-first-class-design.md`, section 11, open
    question 2; `docs/superpowers/plans/2026-08-17-time-as-first-class-plan.md`, "Global
    Constraints" (`packages/web`, `packages/web/src/api.ts`, `packages/server`).
  - Trigger: not stated.
  - Size: medium (includes a `server` response-shape audit first).

- **Birthday greeting scheduling: an ownership gap, not a built feature.** The modes/profile spec
  states plainly that "whether a birthday greeting actually fires is a scheduling question the
  time spec owns," but the time-as-first-class spec, read in full, contains no section building or
  describing such scheduling logic anywhere.
  - Why deferred: not stated; this was never framed as a deferral, only as settled ownership
    assigned to a spec that turns out not to contain the work.
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 15.2
    (`birthdayGreetings` field).
  - Trigger: not stated.
  - Size: small to medium.

- **Manual testing queue: four pieces of shipped v0.6.0 work have automated coverage but have
    never been watched running for real.** The CLI startup spinner (phrase rotation, clearing on
  error/completion, commit `f51647b`); the web mode-card new-chat picker flow (commit `d6f0700`);
  the real web Journal tab against a memory folder with actual entries (commit `4a170a0`); and the
  full conversational experience of journal mode itself (first-time setup, method selection,
  prompt sequencing, the expressive-writing safety gate), the one piece of the whole journal
  epoch no automated test can verify, since it depends on the model's actual behavior at
  inference time.
  - Why deferred: "This session deferred that, on the human's explicit instruction, rather than
    skip it or do it piecemeal: everything below gets one consolidated manual pass near the end of
    Phase D (after journal ships, before design merges to `main`), because seeing the pieces work
    together end to end is more useful than one browser tab per commit."
  - Where: `docs/superpowers/plans/2026-08-17-phase-d-execution-handoff-4.md`, "MANUAL TESTING
    QUEUE, deliberately deferred, visit together near the end".
  - Trigger: the consolidated manual pass this section describes, which is not recorded anywhere
    as having happened yet.
  - Size: small (a sweep, not code).

## 4. Larger pieces not built

Each of these is sized like its own sub-project. Open an issue before starting one; they need
design conversation first.

- **More provider adapters.** The interfaces are in `@openreverie/providers` (`ChatProvider`,
  `EmbeddingProvider`) and the factory has one switch statement waiting for company: Anthropic,
  OpenRouter, Cloudflare AI Gateway, DeepSeek, and local models (Ollama and OpenAI-compatible
  endpoints). Every adapter must pass the same contract tests. This is the most
  contributor-friendly large item.
  - Why deferred: "This spec deliberately covers only the first sub-project."
  - Where: `docs/superpowers/specs/2026-08-13-openreverie-design.md`, sections 2 and 12.
  - Trigger: not stated.
  - Size: large (per-adapter work is contained; the interface and contract tests already exist).

- **Alternate deployment targets.** Cloudflare (Workers, D1 or Durable Objects storage,
  Vectorize) and VPS packaging. The storage layer is behind interfaces for exactly this reason,
  but this is a real porting effort.
  - Why deferred: "This spec deliberately covers only the first sub-project."
  - Where: `docs/superpowers/specs/2026-08-13-openreverie-design.md`, sections 2 and 12.
  - Trigger: not stated.
  - Size: large.

- **Phase C atlas polish: realm influence, a history time lens, worker-thread layout, and
  partial/streamed graph loading.** Verified against the code on 2026-08-24: no realm-influence
  or time-lens implementation exists anywhere in `packages/web/src`. The shipped atlas is
  `packages/web/src/atlas.tsx`, not the `packages/web/src/atlas/graph.ts` module that
  `docs/superpowers/plans/2026-08-15-phase-c-atlas.md` assumed when it wrote Task 5 (realm
  influence) and Task 7 (the history lens). Either those tasks were not executed as written, or
  v0.5.0 took a different implementation path; the plan's file path is stale and should not be
  used to go looking for this code.
  - Why deferred: not stated in the Phase B/C spec beyond scope-limiting language for that phase.
  - Where: `docs/superpowers/specs/2026-08-15-phase-b-c-web-atlas-design.md`, section 8 (feature
    matrix); `docs/superpowers/plans/2026-08-15-phase-c-atlas.md` (Tasks 5 and 7, note the stale
    file path above).
  - Trigger: not stated.
  - Size: large.

- **Constellation layout, and a shared (cross-device/synced) saved layout.** An alternate,
  richer graph layout mode; called out as still deferred even beyond the rest of Phase C's scope,
  and apparently dropped from ROADMAP tracking somewhere along the way, since it does not appear
  in any prior ROADMAP text despite two independent extraction passes over the source documents
  flagging it. Distinct from the browser-local saved positions already shipped in v0.5.0: this is
  specifically a saved layout synced across devices or shared.
  - Why deferred: not stated.
  - Where: `docs/superpowers/specs/2026-08-15-phase-b-c-web-atlas-design.md`, section 1 and
    section 8; `docs/superpowers/plans/2026-08-15-phase-c-atlas.md`, Task 8 Step 3 (the exact
    README sentence: "Constellation layout and any saved shared layout are deferred. Atlas
    positions stay in this browser only and never change the memory folder.").
  - Trigger: not stated.
  - Size: large.

- **Multi-user support.** One install, one person, today. Stated as a non-goal for the first
  sub-project rather than rejected outright.
  - Why deferred: not stated.
  - Where: `docs/superpowers/specs/2026-08-13-openreverie-design.md`, section 2 (Non-goals).
  - Trigger: not stated.
  - Size: large (architectural).

## 5. Smaller improvements, help welcome

Good first contributions, carried across unchanged from ROADMAP.md's prior "Smaller improvements,
help welcome" section. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) first.

- **Migrate the OpenAI provider from Chat Completions to the Responses API.** Newer reasoning-tier
  models (confirmed with `gpt-5.6-terra`) reject function tools together with real reasoning
  effort on `/v1/chat/completions`; OpenAI requires `/v1/responses` for that combination.
  `packages/providers/src/openai.ts` is the only file in the repo allowed to speak the OpenAI HTTP
  API, so this is a contained change: a different request/response shape, an event-based streaming
  format instead of raw content deltas, and a `reasoningEffort` field threaded through
  `config.toml`. No other package should need to change, since everything else consumes the
  abstract `ChatProvider`/`ChatRequest`/`ChatEvent` interfaces. Until this lands, a model that
  requires reasoning effort together with tools fails outright on `/v1/chat/completions`. Outright
  failure is not the only bad outcome, and not the worst one: `gpt-5.1` is accepted on Chat
  Completions and then largely declines to call the tools it was given (see the gpt-5.1 entry in
  section 1 above). The workaround for both is picking a model confirmed to actually use tools on
  Chat Completions (`gpt-5`, current default).
  - Why deferred: not stated beyond the scope of the change itself.
  - Where: not stated as a spec section; this entry originates in ROADMAP.md's own prior text.
  - Trigger: not stated.
  - Size: medium (contained to one file, per the description above).

- **No warning when reflection drops a malformed commitment.** In `applyReflection`
  (`packages/memory/src/reflection.ts`), a commitment or commitment revision that fails to write
  (a schema-invalid payload, or a `commitmentRevisions` entry naming an id that does not resolve
  to a live commitment) is caught and dropped silently, with the rest of reflection still
  completing. `resolveNarratives` in the same file has an `onFailure` callback the engine uses to
  push a visible warning for an equivalent per-entry failure; the commitment write path has no
  equivalent, so a dropped commitment currently leaves no trace anywhere the person or a developer
  would see.
  - Why deferred: noted in task-7-report.md as a judgment call made under time pressure, not
    something the task-7 brief asked for.
  - Where: `packages/memory/src/reflection.ts`, the two `try`/`catch` blocks in `applyReflection`
    that call `recordCommitment`/`reviseCommitment` for `out.commitments` and
    `out.commitmentRevisions`; `.superpowers/sdd/2026-08-24-commitments-engine/task-7-report.md`.
  - Trigger: not stated.
  - Size: small.

- **Graceful handling of a corrupt `constitution.md`.** A hand-mangled arc or realm file is
  skipped with a warning, but a corrupt constitution still crashes engine startup loudly. It
  should degrade with a clear message instead.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **Monthly and yearly rollups.** Daily and weekly exist; the pattern extends naturally
  (`packages/memory/src/rollups.ts`).
  - Why deferred: "the pattern supports them; only daily and weekly ship." Also: "Adding a rollup
    tier means a new `DocKind`, a new build prompt, a new pending-rollup trigger, and a decision
    about whether monthlies summarize weeklies or dailies."
  - Where: `docs/superpowers/specs/2026-08-13-openreverie-design.md`, section 2 and section 12;
    `docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md`, section 8 and section 13.
  - Trigger: not stated.
  - Size: medium.

- **Advisory locking for the memory folder.** Two engines opened on the same folder do not
  corrupt anything, but they can double-reflect a stale session. A lock file would prevent it.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **Local embedding option.** An `EmbeddingProvider` backed by a local model would keep the
  search index fully offline.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: medium.

- **Exposing the forget feature.** The engine method exists and is tested, but two gaps need
  closing before any tool or persona instruction can reach it: retracting a person's node
  currently leaves their page on disk and fully searchable, and a forget call touching more than
  one document is not atomic.
  - Why deferred: "Status: parked during implementation, on the owner's decision. Not shipping in
    v0.3.0." The two gaps: "Retracting a node that has a page left the page on disk and fully
    searchable, so reverie would report someone forgotten while their page still surfaced in the
    next conversation... A partial multi document failure was not atomic."
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 2 and
    section 10 (`MemoryEngine.forget`, the unregistered `forget` tool, `writeDocumentAtomic`).
  - Trigger: not stated.
  - Size: medium.

- **Retiring the proposal machinery further.** `resolve_proposal` is already gone. What remains
  is the `proposals.jsonl` file format, the silent drain that runs on every `open()`, and
  `materializeProposal`, all kept for the compatibility promise to folders written before
  save-by-default. Once that promise is no longer needed, this can come out too.
  - Why deferred: "Removing the machinery is a roadmap item for after existing queues have
    drained. This is not tidiness deferred, it is a compatibility guarantee."
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 2 and
    section 10.
  - Trigger: existing pending-proposal queues finishing their drain.
  - Size: small.

- **Tool exposure is not gated by mode, only by prompt text.** `toolDefinitions()` returns all
  thirteen tools on every round of every session, so a general-mode session is offered
  `declare_journal_method` and `update_journaling_protocol` alongside everything else. The tools
  carry the constraint in their own descriptions instead, which makes it a promise the prompt
  keeps rather than one the code enforces. Harmless in practice today, and worth tightening if the
  tool list keeps growing.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: the tool list continuing to grow.
  - Size: small to medium.

- **A deterministic significance threshold for person pages**, if leaving the judgment of who is
  worth a page to reflection's model call proves too loose in practice.
  - Why deferred: "If dogfooding shows `people/` filling with one-line pages, a deterministic
    threshold (for example, items from at least two distinct sessions) is the fallback, recorded
    on the roadmap rather than built now."
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 3 and
    section 10.
  - Trigger: "if letting reflection judge proves too loose" in practice.
  - Size: small.

- **Merging person aliases.** If the same human ends up with more than one person node (different
  names or spellings across sessions), there is no way yet to merge them.
  - Why deferred: not stated.
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 10.
  - Trigger: not stated.
  - Size: medium.

- **A duplicate arc from a retried reflection.** If reflection's document writes partly fail and
  the session is retried, the retry can create a second arc with a `-2` suffixed page rather than
  resuming the first. This is a deliberate trade: a visible duplicate you can merge by hand beats
  a silent, permanent loss of what reflection found.
  - Why deferred: "The trade was deliberate: a visible duplicate beats a silent permanent loss."
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 10.
  - Trigger: not stated.
  - Size: medium.

- **Warnings dropped mid-session.** A failed reindex during a live conversation (for instance,
  from a `remember` call) is pushed to the engine's warning list, but nothing drains that list
  before session end clears it, so the warning never reaches you. This is a systemic gap in how
  warnings are surfaced, not something specific to this release.
  - Why deferred: "Systemic, not specific to this work."
  - Where: `docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md`, section 10.
  - Trigger: not stated.
  - Size: small.

- **Reflection's per-document error guard is one statement too wide.** `resolveNarratives` in
  `packages/memory/src/reflection.ts` wraps a pure in-memory computation inside the same `try`
  that guards the file read and the model call, so a programming error there would be treated as
  "skip this document" instead of surfacing. The guard should cover only the two operations that
  can genuinely fail on a user's machine.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **`reverie read` reports only the first unreadable file** that matches what you typed. If two
  pages are broken and both match, you hear about one of them.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **The `/bye` message can be slightly wrong in a narrow window.** If reflection fails after the
  session summary has already been written (during the graph sync, the constitution read, or an
  arc read), reverie says the session will be reflected next time it starts, when in fact it
  already counts as reflected. Nothing is lost either way and what is on disk is correct, but the
  sentence is not true in that case.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **A `pagePromotions` entry can lose a race against `newPersons` in the same session and be
  dropped with nothing to fall back on.** If a person is promoted to a page earlier in the same
  reflection output, a `pagePromotions` entry for that same person (now already paged) is dropped
  rather than attached, so its `itemIndexes` never become `involves` edges at all.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **A relisted paged person's `personUpdates` note is silently dropped.** Their items and edges
  still land, but the note describing what this session added to their page is discarded, so the
  page itself does not learn what was said about them.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **`sessionContext` does not dedupe people or entities by label.** Two graph nodes that happen
  to share a label (the escape-hatch fix for two different people with the same name is a
  legitimate reason this can now happen) render as two identical-looking lines in the People or
  Entities section, distinguishable only by id.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **An arc touched only by attribution carries no `lastTouched`.** `arcUpdates` sets it, but
  attaching an item to an arc through `attributions` alone does not, so an arc that was actually
  just talked about can still look untouched to the greeting's "arc gone quiet" logic.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: small.

- **People and entities are capped and ordered by first mention, not last mention.** The `ts` on
  a person or entity node is set once, when the node is created, and nothing that attaches later
  items to it (`attachItemsToNode`) refreshes that `ts`. So the cap's recency order is really
  "created most recently," not "come up most recently": someone mentioned once two years ago and
  never since can, in principle, sort above someone who comes up every week but was first
  mentioned earlier. A fix needs a real last-touched signal on the node, not just its creation
  `ts`.
  - Why deferred: not stated.
  - Where: not stated.
  - Trigger: not stated.
  - Size: medium.

- **`selectCommitments`'s cap and sort are exercised by no test.** Every one of the
  `selectCommitments` tests in `packages/memory/src/commitments.test.ts` (as of the 2026-08-24
  commitments engine work) passed a single-element array, so `.slice(0, cap)` and the whole sort
  comparator (soonest-window-first, with three undefined-handling branches) went uncovered.
  Deleting the entire `.sort(...)` call left the suite green.
  - Why deferred: "Ledger-flagged as the controller's own omission" (2026-08-25 final review,
    part two, Minor 10); not picked up in that review's fix pass, which was scoped to Critical and
    Important findings only.
  - Where: `packages/memory/src/commitments.ts` (`selectCommitments`'s cap and comparator);
    `packages/memory/src/commitments.test.ts`.
  - Trigger: not stated.
  - Size: small.

- **Three accepting branches of the commitment time resolver are untested.** `'this evening'`,
  `'tomorrow night'`, and the `'this '` qualifier in the weekday regex
  (`packages/memory/src/commitmentTime.ts`) are all accepted branches with no test covering them;
  `commitmentTime.test.ts` covers `today`, `tonight`, `tomorrow`, `in N days`, a bare weekday, and
  the `next <weekday>` refusal, but not these three. All three are reachable from two live call
  paths (the live `remember` tool and reflection), not merely theoretical.
  - Why deferred: "Ledger-flagged; confirmed" (2026-08-25 final review, part two, Minor 11); not
    picked up in that review's fix pass, which was scoped to Critical and Important findings only.
  - Where: `packages/memory/src/commitmentTime.ts` (the weekday regex and the two named-time
    branches); `packages/memory/src/commitmentTime.test.ts`.
  - Trigger: not stated.
  - Size: small.

- **`web`'s enum drift guard does not block a future merge that adds a graph node or edge type.**
  `packages/web/src/api.ts` currently carries the full `NODE_TYPES`/`EDGE_TYPES` vocabulary
  (including `'commitment'` and `'waits_on'`), verified against `packages/memory`'s own source of
  truth by `packages/server/src/graph-vocabulary-parity.test.ts`. `web`'s own parity test compares
  `api.ts` against a second hardcoded mirror in the same package, so it would still pass even if a
  seventh node type were added to `memory` and `web` were never updated: the failure mode is Atlas
  rendering degradation (an unrecognized node type), not a server error, since commitments (and
  any future type) have no dedicated browser view yet regardless.
  - Why deferred: "explicitly 'deferred for the final review to triage'" (per the commitments
    engine ledger); not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is Minor 12 in that review).
  - Where: `packages/web/src/api.ts` (the hardcoded node/edge enum and its own parity test);
    `packages/server/src/graph-vocabulary-parity.test.ts` (the guard that does exist, for `server`
    against `memory`). The review's own fix sketch: read `api.ts` as text and compare against
    `memory`'s `NODE_TYPES`/`EDGE_TYPES`, the same guarding-without-importing shape
    `graph-vocabulary-parity.test.ts` already uses, extended to also cover `web`.
  - Trigger: not stated.
  - Size: small.

- **`weekdayIndex` returns -1 on an abbreviation miss instead of `undefined`, against the
  refuse-over-guess contract the rest of the resolver follows.** Currently unreachable in
  production (no caller passes an unrecognized abbreviation today), so this is defensive-only, not
  a live defect.
  - Why deferred: "unreachable today, defensive only" (2026-08-25 final review, part two, Minor
    13's list); not picked up in that review's fix pass, which was scoped to Critical and
    Important findings only.
  - Where: `packages/memory/src/commitmentTime.ts` (`weekdayIndex`).
  - Trigger: not stated.
  - Size: small.

- **`parseGraphRecord` reports a malformed node record's parse failure in terms of the edge
  schema's field names.** When a `graph.jsonl` line fails both the node and edge schemas,
  `parseGraphRecord` (`packages/memory/src/graph.ts`) currently surfaces
  `edgeValidation.error.message` regardless of which shape the line was actually attempting, so a
  bad `NODE` line's error is explained using edge field names, which is confusing rather than
  wrong (the line is still correctly rejected).
  - Why deferred: "not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is part of Minor 13's list in that review)."
  - Where: `packages/memory/src/graph.ts` (`parseGraphRecord`, around line 281 to 291 as of
    2026-08-25).
  - Trigger: not stated.
  - Size: small.

- **`DOC_KINDS` is hand-copied across three packages** (`packages/memory/src/sqlite.ts`,
  `packages/server/src/app.ts`, `packages/web/src/api.ts`), the same duplication shape the graph
  vocabulary (`NODE_TYPES`/`EDGE_TYPES`) has, currently in sync and untouched, with no guard test
  comparing the three the way `graph-vocabulary-parity.test.ts` does for the graph vocabulary.
  - Why deferred: "currently in sync and untouched" (2026-08-25 final review, part two, Minor 13's
    list); not picked up in that review's fix pass, which was scoped to Critical and Important
    findings only.
  - Where: `packages/memory/src/sqlite.ts` (`DOC_KINDS`), `packages/server/src/app.ts`,
    `packages/web/src/api.ts`.
  - Trigger: not stated.
  - Size: small.

- **The reflection prompt's "Known commitments" listing is uncapped and lists dead commitments
  forever.** `readCommitments` (`packages/memory/src/engine.ts`) is deliberately uncapped for
  reflection's own prompt (justified on the grounds that a person accumulates far fewer *open*
  commitments than named people or things), but every commitment ever recorded, in every state
  including `done`, `dropped`, and `quiet`, is rendered into every reflection prompt, so after a
  year of daily use this is an unbounded, monotonically growing block in a prompt every other
  section of which is capped. The listing itself renders only id, label, flavor, and state, never
  gloss or bracket, so no leak was found here, only an unbounded-growth concern.
  - Why deferred: "not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is Minor 15 in that review's part two)."
  - Where: `packages/memory/src/engine.ts` (`readCommitments`); `packages/memory/src/reflection.ts`
    (`renderCommitmentListing`).
  - Trigger: not stated.
  - Size: small to medium (needs a capping and truncation-marker design, the same shape every
    other capped section in `packages/core/src/context.ts` already uses).

- **One long commitment gloss can suppress the entire Commitments section, including shorter
  rows that would have fit.** `capRows` (`packages/core/src/budget.ts`) breaks on the first row
  that does not fit rather than skipping it and continuing. `selectCommitments` sorts
  soonest-window-first, so the soonest commitment's row is checked first; if a model-written gloss
  with no length bound makes that one row alone exceed `COMMITMENTS_SECTION_CAP` (800 characters),
  the whole section is dropped, discarding shorter, later rows that would have fit on their own.
  Pre-existing `capRows` behavior shared with every other capped section, so this is not a defect
  introduced by the commitments work, but Commitments is the first section whose rows carry
  unbounded model prose in a sorted-by-importance order, which is what makes head-of-list
  suppression newly consequential.
  - Why deferred: "not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is Minor 16 in that review's part two)."
  - Where: `packages/core/src/budget.ts` (`capRows`); `packages/core/src/context.ts`
    (`commitmentsSection`).
  - Trigger: not stated.
  - Size: small to medium (either bound gloss length at the schema boundary, or change `capRows`
    to skip an oversized row and keep trying shorter ones after it).

- **After a single Ctrl-C at the CLI's `/mode` selection prompt, typing `/bye` on the next line
  does not stop the session.** The `/mode` selection state machine
  (`packages/cli/src/chat.ts`) is otherwise correct: it is strictly one-shot, EOF bypasses it,
  a second Ctrl-C still exits from the selection prompt, and out-of-range or unrecognized input
  falls to "Mode unchanged." A single Ctrl-C at that prompt prints "Type /bye when you want to
  stop; it reflects on the session first," and the person doing exactly that has their `/bye`
  consumed as a cancelled mode selection instead, printing "Mode unchanged."; a second `/bye`
  then works. This is a copy/ordering problem (the CLI told them to type `/bye` one line earlier
  than the state machine expects it), not a state-machine bug, and no data is at risk.
  - Why deferred: "not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is finding 6 in that review's part one)."
  - Where: `packages/cli/src/chat.ts` (the `/mode` selection state and the Ctrl-C prompt text,
    around lines 201-207 and 302-311 as of 2026-08-25).
  - Trigger: not stated.
  - Size: small.

- **Two "no clock leaked into the prompt" test guards compare a UTC-formatted date against a
  prompt that renders local dates, so they can pass vacuously.**
  `expect(prompt).not.toContain(new Date().toISOString().slice(0, 10))` in
  `packages/core/src/context.test.ts` checks the UTC calendar date, but the fixture pins the
  profile timezone to `Asia/Kolkata` (UTC+5:30) and the code under test renders every date through
  `formatLocalDate` in that zone. For roughly 23% of any given day (18:30 to 24:00 UTC), the
  Kolkata local date is one day ahead of the UTC date the assertion checks for, so a leaked clock
  reading during that window would carry a string the assertion is not looking for and the guard
  would pass without actually having checked anything. No code path currently formats a
  `now`-derived date into the prompt, so this is a latent test weakness, not a current false
  negative.
  - Why deferred: "not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is finding 13 in that review's part one)."
  - Where: `packages/core/src/context.test.ts`, the two "does not leak the wall clock into the
    prompt" style tests (one pre-existing, one added alongside this round's commitment-timing
    work).
  - Trigger: not stated.
  - Size: small.

- **The chunk-cap test does not pin the exact boundary `CHUNKS_PER_DOC_CAP` sets.** The
  "caps the chunks returned per document" test in `packages/memory/src/retrieval.test.ts` asserts
  `chunks.length < chunksTotal` and `chunks.length > 0`, which is satisfied by any value in 1..5
  for six matching items, so changing `CHUNKS_PER_DOC_CAP` from 3 to 5, or to 1, leaves the test
  green. `chunksTotal` itself is genuinely pinned by the same test, which is the more important
  half. No off-by-one exists at the boundary (verified by reading: at exactly 3 matched chunks,
  `chunks.length === chunksTotal === 3`; at 4, it is 3 and 4).
  - Why deferred: "not picked up in the 2026-08-25 final review's fix pass, which was scoped to
    Critical and Important findings only (this is finding 14 in that review's part one)."
  - Where: `packages/memory/src/retrieval.test.ts` (the chunk-cap test); `packages/memory/src/retrieval.ts`
    (`CHUNKS_PER_DOC_CAP`).
  - Trigger: not stated.
  - Size: small (`expect(hits[0]?.chunks.length).toBe(3)`, or assert against the exported constant
    if it is worth exporting).

## 6. Decided against, with a trigger to revisit

- **A default or remembered mode (persisted in `profile.md`, or as the CLI's sticky default).**
  The modes/profile spec listed a persisted default mode as a live open possibility under
  "Deferred." Three days later, the mode-at-launch spec rejected the same idea outright, on
  doctrinal grounds, for the CLI: mode is scoped to one conversation, not a setting. Treat the
  earlier spec's "deferred" framing as superseded, not as "probably coming."
  - Why decided against: "Rejected: remembering the last used mode as the CLI default. It would
    need a new persisted field and makes mode sticky across conversations, which contradicts the
    existing doctrine that mode is a property of one conversation, not a setting."
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 17
    (original "Deferred" framing, now superseded); `docs/superpowers/specs/2026-08-19-mode-at-launch-design.md`,
    "Decision: CLI always starts in `general`" (the rejection; `AgentSession.start`,
    `packages/core/src/agent.ts:197`).
  - Trigger to revisit: not stated.

- **Backfilling missing historical data, declined wherever it has come up: `utcOffsetMinutes` on
  transcript lines written before it existed, re-dating existing sessions off their old
  UTC-derived date prefix, and backfilling commitment nodes from existing `intention` items.**
  Each case shares the same reasoning and each was decided permanently, not merely postponed.
  - Why decided against: "there is no reliable source for what timezone a past session was
    actually written in, and a guess presented as fact is worse than an honest gap." Also: "A
    missing offset means genuinely unknown, not 'assume the current profile timezone': assuming
    the current value is exactly the bug this field exists to prevent, applied retroactively." The
    commitments spec cites the identical reasoning for declining to backfill: "There is no
    reliable way to know which of the four Nightfall lines was live at any given moment, and a guess
    presented as a record is worse than an honest gap. This is the same reasoning the time spec
    used when it declined to backfill `utcOffsetMinutes` onto existing transcript lines."
  - Where: `docs/superpowers/specs/2026-08-16-time-as-first-class-design.md`, sections 7, 8, and
    10; `docs/superpowers/plans/2026-08-17-time-as-first-class-plan.md`, Task 9
    (`TranscriptLine.utcOffsetMinutes`, session directory naming
    `sessions/YYYY-MM-DD-<sessionId>`); `docs/superpowers/specs/2026-08-24-commitments-design.md`,
    section 11, decision 3 (`ReflectionItem`, `kind: 'intention'`).
  - Trigger to revisit: not stated.
