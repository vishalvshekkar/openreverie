# Recall and event time fixes, plus three recorded pickups

Date: 2026-08-24. Written after a live failure on 2026-08-22 against v0.6.0.

This is an execution document, not a design spec. It states what is broken, what the evidence is,
what changes, and who does which piece. Read the evidence section before touching anything: three of
the four defects look like the same bug from a distance and are not.

## The observed failure

Session `2026-08-22-session_01M0MHZ78SMTVC83DARMWPB5SD`, opened at 16:29 IST on Saturday 22 August.

Reverie opened with "Did you end up going to Nightfall with Arjun, how did it land for you?" about a
film booked for the following day. Asked directly what day it was and when the movie was, it replied
that the movie was "at 8:10 pm on Sunday, Aug 16 (PVR IMAX, Westgate Mall)" and that the
person "ended up seeing it that night in Ashford". The booking is 6:40pm on Sunday 23 August in
Bangalore. The 8:10pm Ashford showing was a different film (Halcyon) on 16 August.

### What was not wrong

The clock. "Today is Saturday, Aug 22, 2026" was correct. The transcript line carries
`ts: 2026-08-22T10:59:31.041Z` with `utcOffsetMinutes: 330`, which is 16:29 IST on Saturday 22
August. Time-as-first-class is doing its job: `AgentSession.appendBoth`
(`packages/core/src/agent.ts:473`) stamps every user message from a single clock read, and
`runGreeting` (`packages/core/src/agent.ts:297`) appends the current local time to the system string
for the one call that has no user message to carry a stamp.

Nothing in this plan changes the clock channel. What is missing is the calendar: the model knows
what time it is now and has no reliable way to date anything it remembers.

### What was wrong

The correct fact was in memory the entire time. `graph.jsonl` line 925, asserted 2026-08-20:

> Tickets are booked with Arjun for Nightfall on Sunday, 23 Aug 2026 at 7:20pm.

It lives in `sessions/2026-08-20-session_01M0F1SBG4YYGJC45APRBSMCWS/summary.md`, which is
`doc_01M0F375ARVVYBW8Y0XAHEAEAQ`. That document **was retrieved** by the search the model ran. The
payload handed back one line from it:

> `item_01M0EXAMPLE9ITEMID0000001: Vishal booked tickets to see Nightfall with Arjun.`

The undated, tenseless version of the same fact, a few lines away in the same file.

## The four defects

### 1. Retrieval returns one snippet per document

`fuseByReciprocalRank` in `packages/memory/src/retrieval.ts` calls `dedupeByDocId` on each candidate
list before ranking, then keeps the snippet from whichever chunk had the better individual rank
(`retrieval.ts:88-120`). Search returns eight documents, so a summary with twelve matching items
contributes exactly one line no matter which of them the query was actually about.

The rank-level dedupe is correct and must stay: without it a document with many matching chunks in
one list out-accumulates a document that genuinely tops both lists, which breaks the fusion. The
defect is that ranking and payload construction are the same step, so a correct ranking decision
silently became a payload decision. Rank by document, return by chunk.

This is the proximate cause of the observed failure. It is the highest-value fix in this document.

### 2. `SearchHit` carries no date

`packages/memory/src/sqlite.ts:39`. The index already stores `date_start` and `date_end` per
document, written at index time by `documentDateSpan` (`sqlite.ts:210`), and already uses them for
the `after` and `before` filters (`sqlite.ts:673`). They are never returned to the caller.

So every snippet reaches the model undated. In the observed failure the model recovered a date by
reading `2026-08-16` out of the file path string in the result payload. That is not a channel we
should be relying on.

Note the limit of this fix honestly: document date is not event date. Returning the span would have
told the model that a passage came from 20 August. It would not have produced "Sunday 23 August at
7:20pm". Defect 1 is what lost that; this one is what leaves everything else undatable.

### 3. `eventTime` is captured, stored, and surfaced nowhere

`ReflectionItem.eventTime` exists (`packages/memory/src/reflection.ts:62`), is populated by both
reflection and the live `remember` tool (`packages/core/src/tools.ts:60,240`), and is persisted in
summary frontmatter. Confirmed live: the 22 August transcript contains
`{"kind":"intention","eventTime":"this evening"}`, and ten session summaries in the dogfooding folder
carry `eventTime` values.

It then goes nowhere. It is not in the graph node label, not in an indexed chunk, not in a search
result, not in the session prompt. A summary item saying "tonight" and retrieved six days later
reads as tonight.

**Do not resolve `eventTime` into a timestamp.** The time spec
(`docs/superpowers/specs/2026-08-16-time-as-first-class-design.md:107-115`) chose free text
deliberately, `reflection.ts:332` explicitly instructs the model not to resolve a time the person did
not state, and structured event-time resolution is listed as deferred future work at spec line 1026.
That decision stands. What ships instead is the **anchor**: wherever `eventTime` is surfaced, the
record time it is relative to is surfaced with it, so the model can do the resolution itself and see
when it cannot. `"tonight" (as stated on 2026-08-16)` is honest; `2026-08-16T19:25+05:30` is not.

### 4. Nothing distinguishes a plan from a memory

`recentIntentionsSection` (`packages/core/src/context.ts:300`) renders `- ${date}: ${text}`, where
`date` is when the intention was recorded, never when the thing is supposed to happen. An intention
still in the future is formatted identically to one already carried out. The greeting instruction
(`packages/core/src/agent.ts`, `GREETING_INSTRUCTION`) then tells the model to lead with "something
left unresolved from the most recent session", which is exactly the sentence that came out.

We cannot compute past-or-future, because we deliberately do not resolve `eventTime`. So the fix is
not a computed tense flag. It is two honest changes: carry the stated event time and its anchor into
the section, and state the standing rule in the prompt, that a recorded intention is evidence the
person said they meant to do something and is never evidence that they did it.

Related and out of scope for this round, recorded here so it is not lost: superseded facts are never
retracted. `Fri Aug 21`, `Friday not confirmed`, `Sunday 23 Aug 7:20pm` and `about 6:40pm` all
coexist as live assertions, and RRF scores are `1 / (60 + rank)`, so ordering carries no recency
signal at all. That needs its own design conversation.

## Work units

Four units, clubbed so that no two agents have to read the same file. Every agent runs the tests, the
build, and the lint itself before reporting, per AGENTS.md. TDD for the deterministic pieces: write
the failing test first.

### Unit A: retrieval

Files: `packages/memory/src/sqlite.ts`, `packages/memory/src/retrieval.ts`,
`packages/core/src/tools.ts`, and their tests.

Covers defects 1 and 2, plus a fifth defect found on 2026-08-24 while answering a question about
whether this project has a good retrieval system. It does not, and the reason is not the one anyone
expected.

**Defect 5: the keyword lane of the hybrid search returns nothing for real queries.**

`toFtsQuery` (`packages/memory/src/sqlite.ts:631`) quotes each whitespace-separated term and joins
them with a space. A space is an implicit AND in FTS5, so every token must appear in the same chunk.
Chunks are roughly one summary item each, about 100 characters. The `search_memory` tool description
asks the model for a query "in plain language", and the model duly writes 10 to 15 token sentences.

Measured against the dogfooding index (60 documents, 465 chunks, read only):

```
     0 hits   "movie supposed to be time Westgate Mall PVR IMAX Halcyon movie plan..."
     0 hits   "Nightfall tickets booked showtime Arjun"
     8 hits   "Nightfall booked Sunday"
    35 hits   "Nightfall"
```

The first of those is the exact query from the observed failure. So the hybrid search has been
running vector-only since it shipped, and reciprocal rank fusion has had nothing to fuse. This is
confirmed independently by the score sequence in the failing session: 1/61, 1/62, 1/63 and so on,
perfectly sequential, which can only happen when no document appears in both candidate lists.

No unit test would have caught this, because a test uses a short query and gets hits. The bug lives
in the seam between two individually reasonable decisions.

**Ordering within this unit is fixed, and the harness gates the tuning.**

A1. **The evaluation harness, first.** Nothing else in this unit may be tuned until it exists.
   A fixture set of (query, expected docId) pairs, with queries in the shape the model actually
   writes (full natural-language sentences, not keywords), scored as recall@k. It must run offline
   with a stub embedding provider, in the style the project already uses for LLM-dependent behavior.
   Record the baseline numbers before changing anything.

A2. **Revive the keyword lane.** OR the terms rather than AND them and let bm25 do the ranking it
   exists to do. Include a regression test that uses a realistic twelve-token natural-language query
   and asserts a non-empty result, so this cannot close silently again.

A3. **`SearchHit` carries the document's date span**, plumbed out of `searchText` and `searchVector`
   from the `documents` table. Living documents have no span and must render as absent, never as a
   guessed date.

A4. **Chunk-level payload.** Fusion keeps ranking by document, which is correct and must stay:
   without the per-list dedupe, a document with many matching chunks in one list out-accumulates a
   document that genuinely tops both, which breaks the fusion. What changes is the payload. A
   document hit carries the matched chunks from that document, best first, under a small fixed cap.
   State the cap and the reason for it in a comment, and make anything dropped by it visible in the
   payload rather than silently truncated.

A5. **Retune the fusion, measured against A1.** `RRF_K` is 60, tuned for candidate lists of
   thousands. Against a 20-item list the spread from rank 1 to rank 20 is 0.0164 to 0.0125, so
   within-list rank barely contributes and presence-in-both-lists is nearly the whole signal. Bring
   it down and widen `CANDIDATE_LIMIT`. Report recall@k before and after; keep the change only if the
   harness says it helped.

A6. **Recency as a tiebreaker**, using the date span from A3. A tiebreaker, not a multiplier: a
   query about something from years ago must not be dragged toward last week. At equal relevance the
   more recent document wins, which is the ordering that would have put the 20 August booking above
   the 16 August Halcyon note.

A7. `dispatchSearchMemory` in `packages/core/src/tools.ts` renders the new fields into the JSON the
   model sees, and the tool description says what they mean.

Reranking is deliberately **not** in this unit. A reranker layered on a dead keyword lane, a
discarded snippet and a flattened fusion constant would be measuring the wrong thing. The decision
waits on what A1 reports once A2 through A6 have landed. Note for whoever picks it up: AGENTS.md
forbids memory content reaching any service other than the user's configured model provider, and
OpenAI has no rerank endpoint, so hosted rerankers (Cohere, Voyage) are out. The two viable shapes
are an LLM reranker through the already-configured provider, or a local cross-encoder.

Check every consumer of `SearchHit.snippet` across `packages/server` and `packages/web` before
changing its shape. `web` talks to `server` over HTTP only; if the wire schema changes, the client
schema changes with it.

### Unit B: event time anchoring and intention tense

Files: `packages/memory/src/documents.ts` (or wherever summary items become indexed chunks),
`packages/memory/src/engine.ts` (`sessionContext`, `SessionContext.recentIntentions`),
`packages/core/src/context.ts`, `packages/core/src/agent.ts` (`GREETING_INSTRUCTION`), and their
tests.

Covers defects 3 and 4.

- The indexed chunk text for a summary item includes the stated `eventTime` and the item's record
  date when `eventTime` is present, so a retrieved snippet carries its own anchor. The index is
  derived and rebuildable, so this is a reindex, not a migration.
- `SessionContext.recentIntentions` carries `eventTime`. `recentIntentionsSection` renders it as the
  person's own words next to the date it was said, and omits it cleanly when absent.
- The Time section in `context.ts` gains one sentence: a stated event time is the person's own
  wording, relative to the date beside it, and must be resolved against the current stamp rather than
  read as if it were said today.
- The prompt states plainly that a recorded intention is not evidence the thing happened.
  `GREETING_INSTRUCTION` gets the operational form of the same rule: do not ask how something went
  unless the record shows it happened.
- Do not add an em dash to any prompt text. Do not resolve `eventTime` to an instant.

### Unit C: the two CLI fixes

Files: `packages/cli/src/chat.ts`, `packages/cli/src/commands.ts`, and their tests.

Both recorded in ROADMAP.md. Clubbed because both live in `chat.ts`.

- `TOOL_NOTICES` gains the five missing entries: `list_people`, `list_entities`, `update_profile`,
  `declare_journal_method`, `update_journaling_protocol`. Phrase them to match the existing eight.
  Add a test that fails when any name returned by `toolDefinitions()` has no entry, so the next tool
  added cannot reopen the gap.
- `/mode` with no argument enters a short-lived selection state instead of letting the next line be
  parsed as an ordinary chat message. `/mode <name>` on one line keeps working unchanged. Escape or
  an unrecognised input leaves the state without changing mode and without sending a message.

### Unit D: README and ROADMAP honesty

Files: `README.md`, `ROADMAP.md`.

- The README states tool-based retrieval and live capture as flat capabilities. Both depend on the
  model choosing to call the tools. Add the caveat in the idiom the README already uses twice, "that
  is guidance to the model, not a guarantee of what it actually says", with a pointer to the
  model-choice finding in ROADMAP.md.
- ROADMAP.md: mark the tool notice gap and the `/mode` picker as being fixed in this round, and add
  the retrieval and event-time defects above as a short entry so the record shows where they came
  from.
- Nothing in either file may claim a capability that does not exist in the code once this round
  lands. Overstating status here is a defect, not a cosmetic issue.

## Explicitly out of scope

- **Structured event-time resolution.** Deferred by the time spec, and this round holds that line.
- **The gpt-5.1 tool-use finding.** Decided on 2026-08-24 to leave recorded and pick up later. It is
  an evaluation question (`tool_choice`, a deterministic pre-turn search, a doctor check), not a file
  fix, and folding it in here would change what the retrieval work is being judged against.
- **The Responses API migration.** Already backlogged as its own project.
- **Supersession and recency in ranking.** Real, named above, needs its own design conversation.
- **Em dashes in the companion's conversational voice.** The companion writes them. AGENTS.md scopes
  the no-em-dash rule to repo prose, so this is not silently added to the persona. Flagged for the
  owner, not actioned.

## Review

One reviewer, after all four units report, per AGENTS.md:

- Run the tests, the build, and the lint. Do not accept any implementer's report as evidence.
- Falsify, do not read. For each new test: delete the fix, confirm the test fails, restore it. This
  codebase has a history of tests that pass for a reason unrelated to their name.
- Confirm no `eventTime` value anywhere gets resolved into a timestamp.
- Confirm the retrieval payload change did not break the `server` wire schema or the `web` client.
