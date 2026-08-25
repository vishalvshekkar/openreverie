# Dreaming: the working record

This document is the running record of everything considered for the dreaming feature: the original framing, the ideas explored, the approaches weighed, the decisions taken, and the ideas we chose not to pursue yet. It is deliberately not a spec. The spec, once written, lives in `docs/superpowers/specs/` and says what we are building now. This file says everything we have thought about, so that nothing is lost when we pick one path and set the others aside.

Rules for this file:

- Add to it whenever a new idea, objection, or direction comes up, whether or not we act on it.
- Never delete an idea. If it is rejected, say so and say why, and leave it in place.
- Date every decision. Keep the changelog at the bottom current.

## 1. What dreaming is

Dreaming is a background process that revisits the user's stored memory (transcripts, session summaries, arcs, realms, people, entities, journal entries, rollups, the constitution, and the graph log), recombines it across time and theme, and writes two things back:

1. **Insights.** Hedged, sourced observations that connect things the user has shared over time: patterns, changes, connections between distant parts of their life, open questions the companion could ask later, and strengths the user may not see in themselves. These exist to make later conversations deeper and more specific to the person.
2. **A dream.** A short, vivid piece of creative writing built from the same material, non-literal, with a setting, an atmosphere, and a loose storyline. This exists for the user to read. It is a way of processing what the system has been turning over, and it is meant to be a small pleasure, not a diagnosis.

It runs on a cadence, best effort. If it cannot run, it runs later. It never modifies anything that already exists. It is oriented toward the good: no nightmares, no dread, no catastrophizing. Curiosity, warmth, and gentle honesty are the register.

## 2. The original framing (Vishal, 2026-08-24)

Recorded here in substance so the origin is not lost.

- Dreaming happens on a cadence, best attempt, retried later on failure.
- It goes through a lot of stored memory: transcripts, people, realms, arcs, files, the graph itself. It adds an element of randomness so that, over time, it explores things it would never reach procedurally. It goes back to old material that has not been touched in a while and looks at patterns from then to now, orthogonally.
- Every piece of information should have a way to be reached by the dream element. Each dreaming session randomly picks something, has the context of past dreams, and can use lookup and search to dig in.
- Track when something was last dreamt about, so that nothing goes too long without being part of a dream. Information circulates; nothing goes stale.
- Two outputs: observations written as a meta layer over everything the user has shared (deeper understanding, analyses), and a creative-writing piece with a storyline and atmosphere, like the way people dream about what is lingering on their mind. The second is meant to be vivid and, for lack of a better word, fun for the user to read.
- The purpose of all of it: more reasoned, in-depth observations, so the companion can have deeper conversations with the user, grounded in the user's own memories.
- No nightmares. Everything slightly positive in orientation.
- Later additions (same day): dreaming needs an on/off switch and a cadence setting (daily or weekly only). Switching off never deletes anything; switching on resumes from that date. The dream process must keep the ability to search and read documents rather than being limited to a fixed set of inputs, with restraint enforced at the prompt level (read the constitution, yes; read the whole biography, no). Because this runs on the user's machine and not in the cloud, auto-run cadence cannot be relied on, so dreaming should also be able to run after a session's reflection and in the background at startup.

## 3. The terrain (what the codebase gives us, as of v0.6.0)

Verified against code on 2026-08-24. File references are the ones to reread before implementing.

- **No background scheduler exists for memory work.** Reflection and rollups run once, synchronously, inside `MemoryEngine.open()` (`packages/memory/src/engine.ts:417-476`, `runMaintenance` at 1571-1663). The only periodic timer in the codebase is the server's 60-second idle-session sweep (`packages/server/src/registry.ts:125`, injectable `RegistryScheduler`).
- **Completion state is the artifact.** A rollup file existing is the marker that the rollup is done; pending work is computed by diffing session dates against existing files (`engine.ts:1607-1640`). There is no job table. Dreaming should follow the same convention.
- **Doc kinds** are a closed enum, `DOC_KINDS` in `packages/memory/src/sqlite.ts:18-30`: `constitution, realm, arc, summary, rollup_daily, rollup_weekly, person, journal, journaling`. A wiring test (`packages/core/src/docKinds.test.ts`) requires every kind to appear in the `search_memory` tool description, return a defined `documentDateSpan`, and have a prompt budget cap or an explicit exemption. New kinds must satisfy it.
- **Prose files** are YAML frontmatter plus markdown, written only via `writeDocumentAtomic` (`packages/memory/src/documents.ts:54-65`). Ids are `newId(prefix)` ulids.
- **Journal entries** (`packages/memory/src/journal.ts`) are the closest structural precedent: one write-once file per entry under `journal/`, with their own web view.
- **Graph log** (`packages/memory/src/graph.ts`): node types `realm | arc | item | session | person | entity`, edge types `part_of | in | from | involves | relates_to`, edges carry `confidence`, `source`, `confirmed`. Append-only with retract records; fold semantics, later wins.
- **Search**: FTS5 plus brute-force cosine over stored embeddings, `neighbors()` adjacency, substring node search. The conversational agent reaches memory only through tools in `packages/core/src/tools.ts`: `search_memory`, `graph_query`, `read_document`, `read_transcript`, and the list tools.
- **Prompt assembly** is an ordered list of capped section functions in `packages/core/src/context.ts:67-81`, deliberately clock-free for prefix-cache stability. A dream section slots in there, fed through `SessionContext` (`engine.ts:245-333`).
- **Model slots**: `models.chat`, `models.reflection`, `models.embeddings` (`packages/core/src/config.ts:33`). Dreaming gets a fourth.
- **LLM structured output pattern**: `packages/memory/src/reflection.ts:366-401`. Zod schema, one corrective retry, then degrade rather than throw.
- **Safety modes** live in `packages/core/src/personas.ts` and differ only in crisis stance. There is no separate safety gate elsewhere; any prompt that produces user-facing text must include the persona.
- **Web** has five tabs (`packages/web/src/App.tsx`): Talk, Atlas, Record, Journal, Settings. `Library.tsx` lists documents by kind; `Journal.tsx` is the precedent for a dedicated view.
- Nothing about dreaming exists in specs, roadmap, or handoffs before this document.

## 4. Prior art and analogies

Collected 2026-08-24. Several 2026 arXiv entries were not independently verified against full PDFs; treat the specifics as likely, not certain.

### Agent memory systems

- **Generative Agents** (Park et al. 2023, arXiv:2304.03442). Periodic, importance-threshold-triggered reflection that builds a tree of increasingly abstract inferences over raw observations. Retrieval scores recency, importance, relevance.
- **Letta sleep-time compute** (2025). A background agent shares memory with the primary agent and rewrites raw context into learned context between conversations. Closest production precedent, minus the creative output.
- **Sleep-Consolidated Memory** (arXiv:2604.20943). A WAKE / NREM / REM / forgetting state machine. NREM strengthens co-activated concept pairs. REM has high-importance nodes start random walks through the memory graph to propose novel associations, constrained to not contradict established facts. Forgetting prunes by importance and recency. The REM phase is nearly a blueprint for our seeded random walk.
- **Auto-Dreamer** (arXiv:2605.20616). Separates fast per-session acquisition from slow cross-session consolidation, with bounded tool use over a read-only memory region.
- **A-MEM** (arXiv:2502.12110). Zettelkasten-style notes that trigger evolution of existing notes when a new one links to them. Continuous, not batched.
- **TiMem** (arXiv:2601.02845). Temporal-hierarchical consolidation for long-horizon conversational agents.
- **Mem0**, **MemGPT**, **Reflexion**: tiered memory and verbal self-reflection; relevant for mechanism, less for offline batch work.
- **ChatGPT "Dreaming"** (OpenAI, June 2026). Background rewriting of a synthesized user summary after conversations. Reported large recall gains. Criticized for silently rewriting the user model with no audit trail and letting wrong inferences persist unnoticed.

### Neuroscience analogies

- **Complementary learning systems.** Fast episodic store, slow interleaved generalizer. Keep the per-session write path and the cross-session dream path separate; write derived abstractions somewhere new, never over the raw record.
- **Hippocampal replay is interleaved, not chronological.** Dreams should sample across time and theme in one pass. This is what makes cross-era patterns findable at all.
- **Spacing effect.** Revisit each thing at growing intervals rather than repeatedly. Spaced-repetition scheduling (SM-2, FSRS) is a ready-made model for "nothing goes stale."
- **Reminiscence bump.** Recency-weighted systems collapse into "what happened this week." Reserve capacity for old, formative material: arc origins, early realm entries, first mentions of people.
- **Overfitted brain hypothesis** (Hoel 2021, arXiv:2007.09560). Dreams are corrupted, out-of-distribution replays that act like dropout, preventing overfitting to daily specifics. This is the license for the dream narrative to be deliberately non-literal, and the argument that the narrative and the insights must be separate artifacts with different truth standards.
- **Reconsolidation.** Retrieving a memory makes it labile. In an agent this is also the main failure mode: each pass can drift the interpretation further from the original testimony.
- **Default mode network, incubation.** Unfocused states support insight. Dreaming is a looser-sampling, no-question-to-answer regime, not a retrieval-augmented-answer regime.

### Creative recombination

- **Bisociation** (Koestler): insight from two normally unconnected frames suddenly fitting. Formalized for LLMs in arXiv:2412.14141 and arXiv:2509.21043, the latter with metrics for meaningful versus nonsense blends.
- Random walks over knowledge graphs seeded from low-recency, high-importance nodes.
- Constrained random pairing of distant nodes that share one rare feature.
- Higher temperature, persona sampling, and counterfactual prompts, for the narrative only.

### Scheduling

- FSRS-style per-item intervals; least-recently-reviewed queues weighted by importance; a novelty or diversity bonus so one run does not pick three variations of the same theme; bandit-style exploration so user feedback does not collapse selection into flattery.

### Failure modes and guardrails others learned

- **Confabulation drift** when a system reflects on its own reflections. Guardrail: past dreams inform coverage and continuity, never serve as evidence.
- **Silent rewriting** (the ChatGPT criticism). Guardrail: append, never overwrite; make everything inspectable.
- **Context contamination** (Simon Willison on ChatGPT memory). Guardrail: scoped, capped, user-controllable injection.
- **Over-interpretation of a person's life** (Replika harm literature). Guardrail: hedged claims ("it looks like", never "you are"), user can reject, and dreaming never changes tone or behavior on its own.
- **Crisis judgments from unaudited background work.** Guardrail: dreaming never touches crisis-relevant material or the safety mode. Full stop.

## 5. The idea catalog

Numbered so we can refer to them. Status tags: **v1** (in the first build), **later** (agreed in principle, not in v1), **open** (undecided), **rejected** (with reason).

### A. How a dream picks what to look at

1. **Dream weight per entity.** Three components: staleness (time since last dreamt, with a growing interval so recently dreamt things rest longer), significance (graph degree, session frequency, arc open or closed), and random jitter. Every document, node, transcript, and rollup gets a row in a derived `dream_state` table, rebuildable from the dream log. Selection is weighted sampling. **v1.**
2. **Seed pairing, not single seeds.** Each dream starts from two or three seeds chosen to be distant: different realms, different years, different people, or high embedding distance with one shared rare feature (same month of the year, same emotional register). A single seed produces a summary; a pair produces a connection. **v1.**
3. **Bounded random walks from the seeds over `graph.jsonl`.** The walk is recorded so the dream can cite its path. The path is the provenance trail. **v1.**
4. **Anniversary and calendar resonance.** "One year ago this week." Cheap and very human. The time-as-first-class spec already provides the machinery. **v1 if cheap, else later.**
5. **Dormant-arc revisits.** Arcs closed or quiet for a long time: how did it end, what did it lead to. **v1** (falls out of staleness weighting; may deserve an explicit boost).
6. **Counterfactual and reframing prompts** for the narrative only, never for insights. **v1** as a narrative technique.
7. **Dig-deeper tool access.** The dream process is not limited to the seeded material. It can call `search_memory`, `read_document`, `read_transcript`, and `graph_query` to follow up on what the seeds raise. Restraint is a prompt-level instruction plus a hard cap on tool calls per dream: read the constitution, yes; read the whole record, no. **v1.** (Added 2026-08-24 after Vishal flagged that a fixed input set produces half-baked insights.)
8. **Dream memory of its own dreams.** Each dream gets a compact digest of recent dreams (seeds, insight headlines, open questions) so it can continue a thread or deliberately avoid repeating one. Past dreams are context, never evidence. **v1.**

### B. What a dream produces

9. **Insights** with a fixed shape: claim, confidence, kind (`pattern | change_over_time | connection | open_question | strength`), evidence pointers (session ids, doc ids, graph path), and the seeds it came from. Written once, never edited. **v1.**
10. **The dream narrative.** 300 to 600 words, a setting, an atmosphere, a loose storyline, built from the same seeds and recombined non-literally. Positive or gently curious. Never a nightmare, enforced in the prompt and by a cheap check pass that rejects and regenerates. **v1.**
11. **Open questions as a first-class insight kind.** Things the companion could ask later. These are what make a conversation feel like it comes from someone who thinks about you between talks. **v1.**
12. **Strengths ledger.** Things the user has handled well, repeatedly, that they may not see. The positive orientation turned into an output rather than a filter. **v1** as an insight kind.
13. **Grounding enforced structurally.** The zod schema requires at least one evidence pointer per insight, and a post-check verifies the pointed-at document or session exists. Unverifiable insights are dropped, not written. **v1.**
14. **Voice switch for the narrative.** First person as the companion ("I dreamt..."), second person ("you were walking..."), or third person. Default first person, since it is honest about whose dream it is. Configurable so Vishal can play with all three. **v1.**

### C. How dreams reach conversations

15. **A capped `dreamsSection` in the system prompt** carrying the most recent few insights and open questions. Relevance-ranking against the session's early turns is a later refinement; start with recency. **v1.** Switchable.
16. **Dreams are searchable.** As doc kinds they fall into `search_memory` and `read_document` automatically. **v1.**
17. **Light mention in the opener.** Openreverie already opens with a hello of its own. When a dream is fresh and unread, the opener may mention it lightly. Mode-aware: never in `decompress`, never in a crisis stance. **v1.** Switchable, separately from 15.
18. **Feedback: right, wrong, do not bring this up.** Wrong and do-not-bring-up append a retract-style record to the dream log so the insight never resurfaces, and lower the weight of that framing. Keep an exploration term so selection does not collapse into flattery. **v1 wanted;** attribution problem open, see section 9.
19. **Relevance-ranked injection.** Pick dream insights for the prompt by similarity to the current conversation, not just recency. **later.**
20. **Dream-informed mode behavior.** For example, `boost` mode drawing on the strengths ledger. **later.**

### D. Safety and honesty

21. Dreams never read or produce anything crisis-tagged, never alter safety mode, never adjust tone on their own. The persona is prepended to every dreaming prompt exactly as it is for a turn. **v1, non-negotiable.**
22. Everything appended, nothing rewritten. Dream files are write-once. The dream log is jsonl. `dream_state` is derived and rebuildable. **v1.**
23. The README says what dreaming is and is not, including that insights are the model's guesses about the user. **v1.**
24. A user-visible process log per dream: seeds, walk path, tool calls made, model used, tokens, duration, outcome. Shown in the CLI and web. **v1.**

### E. Scheduling and robustness

25. **Cadence setting: `daily` or `weekly`.** Only those two. **v1.**
26. **On/off switch.** Off never deletes anything. On resumes from the date it was switched on; it does not backfill the gap. **v1.**
27. **Artifact as completion marker.** A dream directory for a cadence period existing means that period is done. No job table. Provider failure means no directory, so the next trigger retries. **v1.**
28. **Multiple triggers, because the machine is not always on** (added 2026-08-24):
    - After a session ends and its reflection completes, if the current cadence period has no dream yet. The material is fresh and the user is likely done for now.
    - In the background at process start, after `runMaintenance`, so a dream is ready for the next session. Must not block the first turn.
    - From the server's sweep timer when the web server is long-running.
    - On demand: `reverie dream`, with `--dry-run` to show seeds and walk without calling a model.
    Which of these are on is configurable. **v1.**
29. **Catch-up semantics ("backups" for missed runs).** If several cadence periods were missed, run one dream, not one per missed period. The missed periods are not backfilled; dreaming is about the present state of memory, not about producing an artifact per calendar slot. The dream state tracks "last dreamt" per entity, so a long gap simply makes everything stale and the next dream picks freely. **v1** (see section 8 for the reasoning).
30. **Budget discipline.** N seeds, M hops, K tool calls, one structured call for insights, one for the narrative, one cheap check pass. Cost per dream is predictable and configurable. **v1.**
31. **Minimum memory threshold.** Below some number of sessions there is nothing to dream about; dreaming stays off and the README says so. **v1.**
32. **Concurrency guard.** Two processes (CLI and server) must not dream the same period at once. A lock file in the memory folder, or the artifact directory created first as a claim. **v1.**

### F. Ideas not yet placed

33. **Dream series.** A multi-night thread that follows one long arc across several dreams. **open.**
34. **User-seeded dreams.** "Dream about my career this week." A CLI flag and a tool. **open**, cheap.
35. **Dream on request in conversation.** The user asks the companion to dream about something, and the next dream honors it. **open.**
36. **Reading-aloud or ambient surfacing** (a dream shown on the web landing page like a morning note). **open.**
37. **Insight decay.** Old, never-confirmed insights lose prompt priority over time so the section does not fill with stale guesses. **later.**
38. **Cross-dream consolidation.** Every N dreams, one pass that reads only dream insights and writes a higher-level digest. Explicitly the confabulation-drift risk; if ever done, the digest must cite original evidence pointers, not dream ids. **open, cautious.**

## 6. Approaches

### Approach 1: dreaming as a fourth maintenance step (chosen, 2026-08-24)

A `dreaming.ts` module in `packages/memory` beside `reflection.ts` and `rollups.ts`. Same engine deps, same zod-retry-degrade pattern, same "artifact is the marker" idempotence. Selection (weights, seeds, walk) is deterministic given a recorded seed value, so dreams are reproducible against fixture folders. Extended per section 7 with bounded tool access for digging deeper.

Why chosen: fits every existing convention, smallest new surface, testable in halves (deterministic selection and storage with TDD; LLM behavior with fixtures and schema assertions), ships in phases.

### Approach 2: dreaming as a tool-using agent session (future improvement)

Reuse `AgentSession` from `packages/core` with a dreaming persona and the full tool roster, and let the model explore from the seeds with an agent loop rather than a fixed sequence of calls.

Strengths: the richest exploration; closest to "it can look up and dig in" without a hand-built control flow. Costs: unbounded spend unless capped by turns; harder to test with fixtures; the loop lives in `core`, so either dreaming moves up a package or `core` calls back into memory-level dream storage. The middle path we chose for v1 is approach 1 with a bounded tool loop inside `memory` (idea 7). If that proves too shallow, this approach is the upgrade: the seed and walk stay in `memory`, the "dig deeper" step becomes a real agent turn in `core`.

### Approach 3: continuous micro-dreaming on every reflection (rejected for now)

Each session's reflection also touches a few stale neighbors, A-MEM style. No scheduler at all.

Why rejected: tangles dreaming with reflection, adds cost and latency to every session end, and never produces the interleaved, cross-era sampling that makes dreaming different from reflection. Could return as a small supplement (idea 5's dormant-arc nudge inside reflection) if the scheduled path proves too infrequent on real machines.

## 7. Dig-deeper access within approach 1

The dream process gets a bounded tool loop, not an open-ended agent:

- Seeds and the walk are computed deterministically first and handed to the model as the starting material.
- The model may then make up to K tool calls (default small, configurable) from a restricted roster: `search_memory`, `read_document`, `read_transcript`, `graph_query`. No write tools. No `remember`, no `update_profile`, no `set_mode`.
- The prompt says what restraint means: read the constitution and profile; follow up on what the seeds raise; do not try to read everything. The hard cap is what actually enforces it.
- Every tool call is written to the dream's process log.
- After the loop, one structured call produces insights, one produces the narrative, one cheap pass checks tone.

## 8. Cadence on a machine that is not always on

The problem: a laptop that is closed most of the day cannot promise a daily run. So:

- The cadence setting describes a period (a local day or a local week), not a time. A period is "due" if it has no dream directory and dreaming was on for at least part of it.
- Any trigger (session end, process start, server timer, on demand) runs the dream if the current period is due, and otherwise does nothing.
- If the gap spans several periods, only the current one runs. Missed periods stay empty. The reasons: memory does not need an artifact per calendar slot; backfilling would spend the user's money on the past; and per-entity staleness already ensures a long gap makes the next dream range widely.
- Switching off and on follows the same rule. Off means no period is due. On means the current period becomes due. Nothing in between is touched.
- "Best effort" is therefore precise: a dream happens the first time any trigger fires inside a due period.

Open point: should a weekly cadence prefer a particular day (the week's first session) or simply the first trigger in the week? Default: first trigger.

## 9. Open questions

### 9a. Attribution for feedback

If insights reach the user through the companion's ordinary speech, the user cannot tell which sentence came from a dream, so "wrong" has nothing to attach to. Options recorded 2026-08-24:

- **Feedback on the artifact, not the utterance.** Right / wrong / do-not-bring-up live in the dream view (CLI and web), per insight. The companion's speech is unattributed. Simplest; matches how journal entries work today. Downside: the user has to go to the dream to correct it.
- **Soft attribution in speech.** The prompt tells the companion to say where a thought came from when it uses a dream insight ("something I noticed going back over what you told me in March..."). Honest and natural, and it gives the user a handle to say "no, that is not it" in conversation. Requires a tool so the companion can record that correction against the insight id. Downside: risk of the companion narrating its plumbing too often; needs a prompt rule and a cap.
- **Transcript-level tagging.** Assistant turns carry hidden metadata listing insight ids that were in context. The web UI can then show a small marker on turns that drew on a dream, with feedback controls. Most precise, most work; touches transcript format (append-only, so it is an additive field, allowed).

Leaning: the first option in v1 plus a `dream_feedback` tool so in-conversation corrections can be recorded when the companion has attributed a thought to a dream. The third as a later refinement.

### 9b. Where the dream configuration lives

Candidates: `config.toml` (system-level: on/off, cadence, model, triggers, caps) versus `profile.md` (user-facing preferences: voice, whether the opener may mention dreams). The split by "does this cost money or change what runs" versus "does this change how it reads" seems right. CLI: `reverie dream` to run, `reverie dream --list`, `reverie dream --show <id>`, and settings changes through the existing settings surfaces. Undecided whether voice belongs in profile or config.

### 9c. Cadence details

Whether the after-session trigger should require a minimum gap since the last dream even within a due period (it cannot: period-based means once per period). Whether the background-at-start trigger should wait for the first turn to complete before spending on a dream, to keep startup snappy. Default: start after `runMaintenance`, run concurrently, never block a turn.

### 9d. What "enough memory" means

The minimum session count before dreaming turns on. Guess: five reflected sessions. To be tuned.

## 10. Graph writes, for later

Prose-only in v1. Options for when we revisit:

- **Unconfirmed `relates_to` edges** between existing nodes, `source: 'dream'`, `confirmed: false`, `confidence` from the insight. Cheapest and already fits the schema. The atlas would show them; they could be styled as dotted.
- **A `theme` node type** for cross-cutting patterns that are not arcs (for example "asking for help late"). Insights would attach to themes. Requires extending `NodeType` and the atlas.
- **A `dream` node type** so each dream is a node with `involves` edges to what it touched. Makes coverage visible in the atlas and gives `dream_state` a graph-native form.
- **Retract on feedback.** "Wrong" appends a retract record for the edge the insight created. Fits fold semantics exactly.
- **Confirmation by use.** If the companion draws on a dream edge in conversation and the user does not object, raise confidence slightly. Speculative; risk of confirming by silence.

## 11. Concurrent work reviewed (2026-08-24)

The `recall-and-event-time` worktree (recall fixes, event-time anchoring, and an unapproved
commitments design) was reviewed for interactions. Findings, folded into the spec's
"Interactions with the recall-and-event-time work" section:

- Dreaming adopts the stated-event-time convention: event times are the person's words paired
  with the record date, never resolved to a timestamp, and a stated plan is never treated as a
  completed fact.
- If the `commitment` node type lands, it joins the dream candidate pool automatically, but
  dreaming must honor the anti-taskmaster guarantees: no open-question insight about a
  commitment whose single ask is spent or that is marked quiet, and interpreted time brackets
  are never rendered in dream prose. Recorded here so the constraint survives even if either
  design changes shape.
- `dream_feedback` needs a `TOOL_NOTICES` entry (new CLI completeness test in that worktree).
- `SearchHit` now carries optional date spans; absent dates mean a living document.
- No collisions on doc kinds, id prefixes, budget caps, tools, or scheduling. Both branches
  touch `context.ts`, `engine.ts`, `sqlite.ts`, and the CLI chat module, so the implementation
  plan rebases onto whatever merges first.

Idea for later, prompted by this review: **39. Commitment-aware dreams.** Once commitments
exist, a dream could notice quiet-but-alive threads (a `waitsOn` event that has passed, a
seasonal gloss whose season has arrived) and surface them as gentle open questions, within the
one-ask rule. **open**, blocked on the commitments design landing.

## 12. Decisions log

- 2026-08-24: Approach 1 chosen. Approaches 2 and 3 retained here as future paths.
- 2026-08-24: Storage is `dreams/YYYY-MM-DD-<id>/` with two files, `dream.md` and `insight.md`, separate because the two are written in different registers. Both are doc kinds, searchable and readable through the existing tools.
- 2026-08-24: Graph writes deferred. Prose plus a dream log in v1.
- 2026-08-24: Surfacing is a capped system prompt section plus a light opener mention, each with its own switch.
- 2026-08-24: Feedback (right / wrong / do-not-bring-up) wanted in v1; attribution mechanism still open (9a).
- 2026-08-24: `models.dreaming` config slot, falling back to `models.reflection` when unset.
- 2026-08-24: Narrative voice is configurable across first, second, and third person; default first person.
- 2026-08-24: On/off switch and a `daily | weekly` cadence. Off never deletes; on resumes from the switch date.
- 2026-08-24: The dream process keeps read-only tool access with a hard call cap and prompt-level restraint.
- 2026-08-24: Triggers: after reflection at session end, background at process start, server timer, on demand.
- 2026-08-24: Feedback attribution resolved (9a): feedback lives on the artifact (per-insight controls in the dream views), plus a `dream_feedback` tool so the companion can record a correction when the user reacts in conversation. Transcript-level tagging deferred.
- 2026-08-24: Config split confirmed (9b): system-level settings (on/off, cadence, model, triggers, caps) in `config.toml`; reading preferences (narrative voice, opener mention, prompt section) in `profile.md`.
- 2026-08-24: Minimum memory before dreaming activates: five reflected sessions (9d).
- 2026-08-24: Weekly cadence has no preferred day; the first trigger inside a due period runs the dream (9c).

## 13. Manual testing queue

Deferred to a human, since none of it can be settled by an automated suite running against scripted fake providers and fixture data. Nothing below has been checked yet.

- Read several real dreams end to end, produced by a real model, across all three narrative voices (first, second, third). Judge tone, whether the recombination feels genuine rather than generic, and whether the piece stays positively or curiously oriented the way the design intends.
- Read the insights from those same runs. Judge whether a hedged claim is actually a good observation grounded in real material, not just schema-valid and evidence-resolved.
- The opener mention in a real session: does a light dream mention actually read as light, land naturally, and stay absent in `decompress` mode and in distress.
- The web Dreams view rendering a full set of real dreams, including at least one whose narrative was withheld by the tone gate (`dream.md` absent, `insight.md` present, and the view should say plainly that no narrative was written).
- The Settings round trip for `dreams.voice`, `dreams.openerMention`, and `dreams.promptSection`, changed from the web UI and confirmed to take effect in the next dream run and the next session's prompt.
- `reverie dream --dry-run` and `reverie dream --show <id>` against a real, lived-in memory folder, not a fixture: do the seeds, weights, and walk it prints make sense against what is actually in that folder.
- A verdict recorded through the web Dreams view or the `dream_feedback` tool then shows up correctly when the same insight is read back with `reverie dream --show <id>`, since that is the only place where the two feedback paths that write and the one path that only reads are seen to meet.

## 14. Changelog

- 2026-08-24: Document created from the first brainstorming session. Terrain, prior art, idea catalog, three approaches, decisions, and open questions recorded.
- 2026-08-24: Open questions 9a-9d resolved; decisions logged. Spec written (`docs/superpowers/specs/2026-08-24-dreaming-design.md`).
- 2026-08-24: Reviewed the concurrent recall-and-event-time worktree; interactions recorded in section 11 and in the spec. Idea 39 added.
- 2026-08-24: Spec approved. Implementation plan written (`docs/superpowers/plans/2026-08-24-dreaming-implementation.md`), 15 TDD tasks. Two spec amendments made during planning: dream coverage state is an in-memory fold of `dreams/log.jsonl` rather than a SQLite `dream_state` table (the log stays tiny at one dream per period; a table remains a later optimization), and the candidate pool excludes the dream doc kinds so a dream can never select a past dream as source material, closing the self-reference loop structurally rather than only in the prompt.
- 2026-08-25: All 14 implementation tasks landed and reviewed; dreaming v1 shipped on top of v0.6.0, not yet in a tagged release. The append-only dream log, both doc kinds wired into the index and prompt budget, period math and dueness, the filesystem lock, seeded selection (mulberry32 PRNG, staleness times significance weighting, seed pairing, a bounded graph walk), the bounded read-only tool loop, the zod-validated insight and narrative pipeline with retry and the tone gate, the `[dreaming]` config section (off by default) and `profile.md` reading preferences (corrected below, 2026-08-25: the typed fields and the engine's reads landed as specified, the spec's sentence that they are changeable from a CLI settings surface and the web Settings view did not), engine wiring for all four triggers with the once-per-period guard, the capped prompt section and one-time opener mention, the `dream_feedback` tool, `reverie dream`, the server timer trigger and three `/api/v1/dreams` endpoints, and the web Dreams view all landed as specified. One further deviation from the spec, beyond the two amendments already recorded above: the spec's Feedback section says the CLI "appends directly through the engine," so `reverie dream --show` was meant to record a verdict, not just display one. It ships display-only. The dream_state table was never built, exactly as amended, and the candidate pool exclusion of dream/dream_insight kinds shipped as amended. Final verification: `pnpm build` exit 0; `pnpm lint` exit 0 (171 files, 9 warnings, no errors); `pnpm test` 1281 passed, 1 failed across 68 files, the single failure being the pre-existing `context.test.ts` "renders each recent session id..." case that fails on main and on this branch's base (unrelated to this work). This branch adds 148 passing tests over the session baseline of 1133. What did not ship, all deliberately out of scope for v1: no graph writes of any kind, no relevance-ranked prompt injection (the section renders the most recent insights, not the most relevant), no transcript-level attribution tagging, no cross-dream consolidation, no dream series, no user-seeded dreams, and feedback does not tune selection in v1. Most importantly: dream quality itself is unverified by a human. Every test in this branch runs against scripted fake providers; nothing here demonstrates that a real model produces a good dream, a well-judged insight, or an appropriate tone. See section 13 for the manual testing this leaves open.
- 2026-08-25: Recorded as a deviation, not silently absorbed into the wording fix above: the spec's Feedback section requires the CLI to append feedback directly through the engine, the same as the web path, with both writing a `feedback` record to `dreams/log.jsonl`. v1 ships `reverie dream --show` as read-only: it displays verdicts already recorded by the web view or the `dream_feedback` tool, but has no command of its own to record a new one. This was caught late, during the README honesty pass, not during implementation: Task 12's brief narrowed the CLI's `DreamEngine` interface to `dreamNow`, `listDreams`, `readDream`, with no write method, and nothing flagged the gap against the spec until the README was checked sentence by sentence against what the code actually does. The reason it is not fixed now rather than closed immediately: the `feedback` record's `source` field is typed `'ui' | 'tool'`, and a CLI write path needs one of two choices, either widen that enum with a third value, which changes an append-only log's record shape at the very end of a branch, or record a terminal-issued verdict under `source: 'ui'`, which would be false: it did not come from the web UI. Both are format and data-honesty decisions, not implementation work, so the choice is left to the human rather than resolved on the implementer's own judgment. What still works: two of the three feedback paths shipped and are tested, the web Dreams view through `POST /api/v1/dreams/:id/feedback` and the `dream_feedback` tool in conversation, and a verdict recorded either way still permanently excludes the insight from the prompt section and the opener, and still shows up when read back with `reverie dream --show`. Only writing a verdict from the terminal is missing.
- 2026-08-25: A final whole-branch review, scoped to the seams between the fifteen already-reviewed implementation tasks, found and fixed one bug and recorded six further spec deviations that no per-task review had been scoped to catch.

  The bug: `profileSettingsPatchSchema` (`packages/memory/src/profile.ts`) and the server's public profile read path (`packages/server/src/app.ts`) were never extended when the web Settings Dreams section was built, so every PATCH from the web's voice, opener-mention, and prompt-section controls came back `400`, and the GET path never returned `dreams` at all, so the panel showed defaults regardless of what was saved. Both sides are fixed now: the patch schema accepts `dreams`, the engine merges it shallowly (one field at a time, matching how the web sends it, without dropping the other two saved preferences), and the public profile read path returns it.

  The six deviations, recorded here and left unresolved, each a design decision for the human:

  1. Configuration section: the spec says the three dream preferences are "changeable from the CLI settings surface and the web Settings view." The web half is fixed above. There is no CLI settings surface for them at all; hand-editing `profile.md` is the only other route. This also corrects the "landed as specified" claim in the 2026-08-25 entry above: the typed `ProfileMeta.dreams` fields and the engine's reads of them landed as specified, that one spec sentence about where they are changeable did not.
  2. Selection step 5, calendar resonance (a weight boost for a candidate whose date lands within seven days of "one or more years ago this week") was never built. It was already absent from the implementation plan, so this was a known gap before v1 shipped, just not written down until now.
  3. Pipeline step 1: the packet the dream pipeline assembles omits the constitution and the profile summary the spec lists. Narrowed rather than dropped: the exploration prompt in `dreaming.ts` tells the model that reading the constitution is fine, and the read-only tool loop can reach both the constitution and the profile through `read_document` if a seed calls for them. They are tool-reachable, not injected.
  4. `reverie dream` (`dreamNow`) lacks the spec's manual exemption from the once-per-period rule. The spec says a manual run is exempt from that rule; the code still aborts an unforced manual run when the period is already covered, the same as a background trigger would. `--force` is the current workaround; see the corrected comment on `dreamNow` in `engine.ts`.
  5. The opener has no period bound. The spec says the opener may mention a dream from the current or previous period; the code offers the newest dream that has a narrative and has not yet been mentioned, regardless of how old it is.
  6. The `dreamt` log record stores seeds only. The spec says it should store seeds plus the walk plus anything read in the tool loop, since that is what a `dream_state` fold would derive last-dreamt times from. Walked and tool-read entities are never marked dreamt, so their staleness keeps accruing even after a dream actually touched them.
