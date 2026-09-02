# Context and retrieval design

Date: 2026-08-16
Status: proposed
Target release: v0.5.0
Scope: fix the places where memory the user gave the system cannot be reached by the model, make
the tool descriptions true, and put a budget on the system prompt. Design only. No implementation
in this document.

## Dependencies on the sibling specs

Four specs were written the same day. This one is the fifth and does not redefine what they own.

- **2026-08-16-time-as-first-class-design.md** owns `profile.md`, the `## Right now` block that
  replaces `todaySection` and is appended per model-call round at the tail of the prompt, the
  `update_profile` tool, local day boundaries, and the fix that renders `sessionId` in
  `## Recent sessions` so `read_transcript` is reachable (that spec's section 7, "Transcript
  timestamps"). This spec assumes all of that and treats the now-block as outside its character
  budget, since it is fixed-size and re-rendered per round.
- **2026-08-16-modes-profile-settings-design.md** owns modes, `set_mode`, the removal of
  `update_style`, the profile prose block's placement in the prompt, its 2,000-character cap and
  truncation marker, and the precedence sentence. It states explicitly that modes change the
  prompt, not what is fetched from memory, which leaves retrieval to this spec.
- **2026-08-16-journal-mode-design.md** owns `journaling.md`, the `journal/` directory, and the
  two new `DocKind` values `'journaling'` and `'journal'`. Section 10 below states what those two
  types still have to declare, and does not change anything that spec decides.
- **2026-08-16-cli-polish-and-ci-fix-design.md** owns `reverie doctor` and argv handling. It does
  not touch context assembly or retrieval. Section 9 names a measurement whose natural home is
  `doctor`; deciding where it prints belongs to that spec, not this one.

Both of the gaps this spec originally flagged as unowned were checked against the sibling files
directly, not assumed, and both are now closed elsewhere: the time spec's latest pass folds in the
session-id render fix (section 3 below describes the defect and points to that spec's design and
test rather than repeating them), and the modes spec's latest pass caps the profile prose body at
2,000 characters (section 7's budget table carries that number for the total only, and section 14
question 5 records the resolution).

## 1. Problem statement

The architecture is deliberately listing plus fetch. The system prompt carries compact listings of
what exists (realms, arcs, people, entities), and the model pulls the full text of anything it needs
through `read_document`, `read_transcript`, or `search_memory`. At personal-memory scale that is the
right shape: it keeps the prompt small, it keeps every turn honest about what is actually known, and
it degrades gracefully as the folder grows.

Listing plus fetch works only under two conditions.

**Every listing must hand back the key needed to fetch.** Three of them do not. `## Recent sessions`
renders a date and a summary body and drops the session id that `read_transcript` requires, so the
transcript layer, the one part of memory that is never lossy, is reachable in principle and
unreachable in practice (the fix is the time spec's, not this spec's own; see section 3). `list_arcs`
and `list_realms` return raw graph nodes with no `docId`, so the two cheapest orientation tools cannot
chain into `read_document`. Weekly rollups appear in no listing at all, so their existence is not
knowable without guessing.

**Every fetch tool must tell the truth about what it does.** `search_memory`'s `after` and `before`
filters over-include: any hit whose date cannot be read out of its path passes every filter
unconditionally, and that is most of the corpus. The tool schema promises date filtering with no
caveat. `list_arcs`'s description promises "id, name, and status" and returns nodes that carry no
status field at all. A capability that quietly does nothing while advertising success is the worst
failure mode in a tool-using system, because it does not produce an error the model can recover
from. It produces confident wrong answers.

There is a third problem underneath both, and it is the one the project owner called unacceptable.
Entities past `ENTITIES_CAP` and unpaged people past `PEOPLE_CAP` are not merely absent from the
prompt. They have no document, so they are not in the search index at all, and there is no listing
tool for either. They are unreachable by any means short of walking arcs to items to neighbors, and
not reachable at all if unlinked. The prompt already tells the model they exist: `context.ts:109-113`
renders "(list truncated: paged people are kept first, then the most recently created; older,
unpaged people exist but are not shown here)". So the model is informed that more exist and given no
way to get at them. Data the user gave the system must not become unreachable because it aged past a
constant.

Finally, three sections of the prompt render unbounded bodies. A constitution that grows for two
years silently inflates every model call in every session, and nothing anywhere caps it.

## 2. What reaches the model today

Read from `assembleSystemPrompt` (`context.ts:22-46`) and `MemoryEngine.sessionContext`
(`engine.ts:526` onward). Sections render in this order, and a section with nothing to say is
omitted rather than rendered empty.

| Section | What is rendered | Bound |
| --- | --- | --- |
| persona | Safety mode, style, crisis text | Fixed, authored |
| `## Today` | Today's date | One line. Replaced by `## Right now` in the time spec |
| `## Constitution` | Full body (`context.ts:67-71`) | **None** |
| `## Realms` | Name plus first non-blank line of the page (`context.ts:73-80`) | None on count |
| `## Active arcs` | Name, status, lastTouched. Active only (`engine.ts:547`). No body | None on count |
| `## People` | Name, node id, has-page flag | `PEOPLE_CAP = 40` (`engine.ts:200`), paged-first truncation (`engine.ts:1711-1719`) |
| `## Entities` | Name only | `ENTITIES_CAP = 30` (`engine.ts:201`) |
| `## Recent intentions` | Date and text | `RECENT_INTENTIONS_CAP = 5` (`engine.ts:192`) |
| `## Latest daily rollup` | Date and full body | Newest one only (`engine.ts:565-571`). Body **unbounded** |
| `## Recent sessions` | Date and full summary body | Up to 3, within 7 days (`engine.ts:191`, `:575`, `:586`). Bodies **unbounded** |
| Weekly rollups | Nothing | Never preloaded |
| Journal entries, transcripts | Nothing | Never preloaded |

Two details worth stating because they are easy to get wrong. `SessionContext.recentSummaries`
already carries `sessionId` (`engine.ts:154` for the type, `engine.ts:597` for the push); only the
renderer drops it. And the People and Entities sections already emit truncation markers
(`context.ts:109-113` and `:121-124`), which means this codebase already has a house convention for
signalling truncation, and section 7 extends it rather than inventing one.

Eight tools exist (`tools.ts:68-250`): `search_memory`, `graph_query`, `read_document`,
`read_transcript`, `remember`, `list_arcs`, `list_realms`, `update_style`. The modes spec removes
`update_style` and adds `set_mode`; the time spec adds `update_profile`.

## 3. P1. Session summaries do not carry the key `read_transcript` needs

### The defect, as found

`recentSummariesSection` (`context.ts:98-102`) renders each summary as
`${summary.date}: ${summary.body.trim()}`. The `sessionId` is present on the object
(`SessionContext.recentSummaries`, `engine.ts:154`, pushed at `engine.ts:597`) and is not rendered.
`read_transcript` takes exactly one argument, `sessionId` (`tools.ts:45-47`, `:334-340`), and no
tool anywhere returns one. There is no `list_sessions` tool. Session ids are ULID-based, so the
model cannot construct one. The verbatim transcript layer, which the design treats as sacred and
never lossy, is therefore dead weight in an ordinary session.

### Who fixes it

**2026-08-16-time-as-first-class-design.md owns this fix and already carries it.** That spec's own
justification for adding `utcOffsetMinutes` rests on the model being able to read a transcript's
timestamps on demand, and that justification only holds if the model can obtain a session id in the
first place. Its section 7, "Transcript timestamps," specifically the "Does the model ever see these
timestamps? (Investigated)" subsection, works through exactly this gap and closes it by changing
`recentSummariesSection` to render
`` `${summary.date} (${summary.sessionId}): ${summary.body.trim()}` ``, with its own falsification
test: an assembled prompt containing a recent session summary must contain that session's id as a
recoverable substring, and the id parsed back out of the rendered prompt must be one
`engine.readTranscript` accepts.

This spec does not re-implement or re-test that rendering. The defect is kept here, described rather
than deleted, because it is the concrete case that motivated the general principle in section 1:
every listing must hand back the key needed to fetch. That principle is this spec's own; the
`## Recent sessions` instance of it is a sibling spec's fix, not this one's.

## 4. P2. `list_arcs` and `list_realms` hand back nodes with no `docId`, and one of them lies

### The defect

`MemoryEngine.listArcs()` and `listRealms()` (`engine.ts:786-792`) return raw `GraphNode[]`.
`graphQuery` (`engine.ts:681-691`) passes every node through the private `withDocId` helper
(`engine.ts:698-702`); these two do not. A `GraphNode` is `{ id, type, label, doc?, ts }` (`graph.ts:69-75`),
so the model receives `doc`, a filesystem path, and never the `docId` that `read_document` requires.
The two tools whose stated purpose is "cheap orientation before deciding whether to search or read
further" cannot lead to a read.

Second defect, found while checking the first. `list_arcs`'s description promises "its id, name, and
status" (`tools.ts:199`). `GraphNode` has no status field. Arc status lives in the arc page's
frontmatter, which `sessionContext` reads per arc (`engine.ts:540` onward) and `listArcs` does not.
The tool has been promising a field it never returned.

### The design

**Row shape.** Both tools return the projection `graphSnapshot` already uses for the web
(`engine.ts:748-760`), plus `docId`: `{ id, type, label, assertedAt, docId? }`. The raw `doc`
filesystem path is dropped. This is not a leak fix (the model provider is the sanctioned
destination for memory contents); it is dropped because it is unusable noise. The model cannot open
a path, and a path in a tool result invites the model to quote it back to the user as though it were
meaningful. Reusing an existing projection also means there is one answer in this codebase to "what
does a graph node look like to a consumer outside memory."

**Status becomes real.** `listArcs` becomes async and reads each arc page's frontmatter for `status`
and `lastTouched`, using the same fallback `sessionContext` already uses: if the page cannot be read,
omit the fields rather than defaulting them, because defaulting an unreadable arc to `active` is how
a broken file becomes a wrong answer. Arc counts are in the dozens, so a bounded set of document
reads per call is acceptable.

**A status filter.** `list_arcs` gains `status?: 'active' | 'dormant' | 'closed'`, defaulting to all.
The prompt preloads active arcs only (`engine.ts:547`), so this tool is the only path to a dormant or
closed arc, and it should be able to answer "what did we close" without returning everything.

**The listing envelope.** All four listing tools (`list_arcs`, `list_realms`, and the two added in
section 6) share one result shape:

```json
{
  "total": 137,
  "offset": 0,
  "limit": 50,
  "returned": 50,
  "hasMore": true,
  "rows": []
}
```

`total` is always the true count, so the model can tell how much it has not seen. Arcs and realms are
few today and the paging fields will usually be trivial, but a shared envelope means no listing in
this system can ever silently truncate again, which is the whole point of the spec.

### What is deliberately not done

Adding `docId` to the prompt's own `## People`, `## Active arcs`, and `## Realms` sections. Those are
listings too, and by the thesis of section 1 they should hand back fetch keys. They are not changed
because a 26-character id per row against a 40-person list is roughly 1,100 characters of every
prompt, and the fetch path already exists through the listing tools: the node id is rendered, and
`list_people` (section 6) accepts a name filter and returns the `docId`. A fourth `graph_query` kind
that resolves a single node id to its `docId` was considered and rejected as redundant with
`list_people`. If use shows the extra hop is a real cost, adding `docId` to the People section is a
one-line change and a budget adjustment.

## 5. P3. The date filter over-includes, and the tool description says otherwise

### The defect

`passesDateFilters` (`retrieval.ts:112-124`) reads a date with `dateFromPath` (`:137-146`), which
matches `^(\d{4}-\d{2}-\d{2})` at the start of a path segment. That covers exactly two layouts:
`rollups/daily/<date>.md` and `sessions/<date>-<sessionId>/summary.md`. It does not cover weekly
rollups, which are written to `rollups/weekly/<week>.md` with names like `2026-W33.md`
(`rollups.ts:174`). It cannot cover arc, realm, person, journal, or constitution pages, whose paths
carry no date. When no date is found the function returns `true` (`:114-116`), so an undated hit
passes every filter.

The consequence: `search_memory` with `after: "2026-08-01"` returns arc pages last rewritten in
January, person pages from a year ago, the constitution, and every weekly rollup ever written. The
schema (`tools.ts:92-98`) says "Only include results dated on or after this date" with no caveat.

This is not a bug that was overlooked. The module comment at `retrieval.ts:8-16` documents the
over-inclusion as a deliberate reading of "when present": document meta is never persisted to
SQLite, so the path is the only surviving date, and undated hits are "never excluded, which matches
'when present' in the brief." The decision was made in one place and never propagated to the tool
description in another. Any fix that changes the semantics must rewrite that module comment too. A
spec that changes the behavior and leaves a comment asserting the old behavior recreates exactly the
class of defect it is fixing.

### The design: index a real date, and narrow the description to match

Both, not either. The recommendation is to do the indexing work and also make the description
precise, because indexing alone cannot resolve the honest ambiguity described below.

**A date is added to the index.** The `documents` table (`sqlite.ts:83-88`) gains two nullable
columns, `date_start TEXT` and `date_end TEXT`, populated at `upsertDocument` time by a new pure
function:

```ts
export function documentDateSpan(
  kind: DocKind,
  meta: DocumentMeta,
): { start: string; end: string } | null
```

| Kind | Span | Source |
| --- | --- | --- |
| `summary` | Single day | `meta.date`, written by reflection (`reflection.ts:709-716`) |
| `rollup_daily` | Single day | `meta.date` (`rollups.ts:143`) |
| `rollup_weekly` | Monday through Sunday | derived from `meta.week` (`rollups.ts:177`) |
| `journal` | Single day | entry date, per the journal spec |
| `constitution`, `realm`, `arc`, `person`, `journaling` | `null` | Living documents, see below |

For a single-day artifact `start === end`. Filtering uses span overlap, not point comparison: a hit
passes when `date_end >= after` and `date_start <= before`. A weekly rollup covering 2026-08-10 to
2026-08-16 is correctly returned for `after: "2026-08-14"`, which a point comparison against the
Monday would drop.

Deriving Monday from an ISO week id is new work. `isoWeekOf` (`rollups.ts`) goes date to week; the
inverse does not exist and must be written and tested alongside it, including the year-boundary cases
that make ISO weeks unpleasant (2026-W01 starting in December 2025).

**Living documents get no date, and mtime is not used as a fallback.** An arc opened in January and
rewritten in August carries both `opened` and `updated` in its frontmatter, and neither one is "when
this content is about." Under `updated` it satisfies `after: "2026-08-01"`; under `opened` it fails.
Both readings are defensible, which is proof that no single date is correct. File mtime is worse: it
records when reflection last rewrote the page, which for a page rewritten every session that touches
it means the filter would be answering "was this page edited recently", not "is this about that
period." A filter that is confidently wrong is worse than one that is honestly narrow. So living
documents carry `null` and are never excluded by `after` or `before`. That is the same
over-inclusion the current code has, but now it is a stated, documented, tested property of exactly
four kinds instead of an accident that swallows most of the corpus.

**Filtering moves into SQL.** With dates in the index, `passesDateFilters` and `dateFromPath` are
deleted from `retrieval.ts` and the predicate joins the existing kind predicate in the `WHERE`
clauses of `searchText` (`sqlite.ts:262-297`) and `searchVector` (`:299-330`):

```sql
AND (d.date_start IS NULL OR (d.date_end >= :after AND d.date_start <= :before))
```

with each half omitted when the corresponding filter is absent. This fixes a second latent problem
by the same argument the module comment already makes for kinds: post-fusion filtering discards
candidates after the top-20 window has been chosen, so a date-matching document that ranks 25th
overall is never seen, and a query with a narrow date range can come back empty while matching
documents exist. Pushing the predicate into the index is the same correction, for the same reason.

The `retrieval.ts` module comment at lines 8-16 is rewritten to describe the new contract. This is
not optional cleanup; it is part of the fix.

**The description becomes true.** New text for `after` and `before` in `tools.ts`:

> Only include dated artifacts on or after (respectively, on or before) this date, YYYY-MM-DD.
> Dated artifacts are session summaries, daily rollups, weekly rollups, and journal entries; a
> weekly rollup matches if any day of its week falls in range. Living documents that are rewritten
> over time (the constitution, and realm, arc and person pages) have no single date and are never
> excluded by these filters. To search only within a date range, combine these with `kinds`.

The last sentence is the practical instruction. A model that wants "what happened in July" should
pass `kinds: ["summary", "rollup_daily", "rollup_weekly"]` together with the dates, and the
description now tells it so.

### Index schema migration

There is no `PRAGMA user_version` anywhere in `sqlite.ts` today, and `initSchema` uses
`CREATE TABLE IF NOT EXISTS`, which will not add a column to an existing table. An unmigrated
`index.db` would make every search throw on `no such column: d.date_start`.

Design: introduce `INDEX_SCHEMA_VERSION = 2` and read `PRAGMA user_version` in `initSchema`. If the
stored version is lower, drop and recreate the four derived document tables (`documents`, `chunks`,
`chunks_fts`, `embeddings`), set `user_version`, and set a flag the engine can read. `nodes` and
`edges` are untouched, because `replaceGraph` (`sqlite.ts:231`) already rewrites them wholesale on
every `MemoryEngine.open`.

`MemoryEngine.open` (`engine.ts:234-244`) then calls `reindexAll()` when the flag is set, and records
a warning describing what happened. It rebuilds rather than leaving the index empty because a
silently empty search index is precisely the failure this spec exists to remove. The cost is honest
and should be stated in the warning: one embedding pass over the whole folder, once, on the first
open after upgrade. At a year of daily use that is on the order of ten thousand chunks, a few
minutes and a few cents. Nothing is lost if it is interrupted, since the index is derived and the
next open finds the version still stale and tries again.

## 6. P4. People and entities past the cap are unreachable

### The defect

`capPeople` (`engine.ts:1711-1719`) keeps 40, paged first. `capEntities` (`:1724-1727`) keeps 30.
Both set a `truncated` flag that `context.ts` renders as a marker telling the model that older,
unpaged people and entities exist. Nothing anywhere lets it reach them.

The root cause is not the cap. It is that a node with no page has no document, so it is not in the
`documents` table, so it has no chunk, so it has no FTS row and no embedding, so `search_memory`
cannot find it under any query. Entities never get a page at all in this release, by the deliberate
decision recorded in the remember-by-default spec, section 4. Unpaged people are in the same
position. There is no `list_people` and no `list_entities`.

So the answer to "who is the 41st person" is: nobody can find out, including through the graph,
unless that person happens to be linked to something the model is already looking at.

The project owner's framing, which this section implements: the model should be able to search by
name or ask for the next page or something of that kind, and data the user has given the system must
not be inaccessible to the model.

### The design: two mechanisms, because one does not do the job

A listing tool alone cannot find the 41st person: a tool that returns a page of 40 has the same
problem the prompt has, one page further along. A search alone cannot enumerate: ranked results are
not a roster. Both are needed and they answer different questions.

#### 6a. Node names become searchable

`search_memory` gains a second result lane over graph node labels, independent of the document
index.

**Implementation choice: a case-folded substring scan over `nodes.label`, not an FTS5 table.**
The alternative was an external-content `nodes_fts` virtual table synced inside `replaceGraph`.
Reasons for the scan:

- Scale. Node counts are hundreds to low thousands after years of daily use. A full scan of a table
  that size, in SQLite, is sub-millisecond and is dwarfed by the embedding round trip the same
  search already makes.
- Sync surface. `replaceGraph` wipes and refills `nodes` on every engine open and every graph
  change. Keeping an external-content FTS5 table correct across that requires delete bookkeeping
  that buys nothing at this size, and a desynced FTS index is a silent-wrong-answer bug of exactly
  the kind this spec is about.
- Semantics. Name lookup wants substring and prefix behavior. FTS5 matches whole tokens, and gives
  prefix matching only with an explicit trailing `*` and never mid-token. "ren" should find
  "Renata"; under FTS5 it does so only if the caller remembers to write `ren*`.
- No migration. The `label` column already exists, so 6a adds no schema change on top of section 5's.

**Matching rule.** The query is case-folded and split on non-word characters. Tokens shorter than
three characters are dropped, unless the entire query is a single short token, in which case it is
kept (a two-letter nickname is a real name). A node matches if any surviving token is a substring of
its case-folded label. Results are ordered by match quality (whole-label equality, then label
prefix, then substring), then by node `ts` descending, then by node id descending. Capped at
`NODE_HITS_CAP = 10`.

**Result shape.** `MemoryEngine.search` changes from returning `SearchHit[]` to returning:

```ts
{ documents: SearchHit[]; nodes: NodeHit[] }

interface NodeHit {
  nodeId: string
  name: string
  type: NodeType          // person, entity, arc, realm, item
  hasPage: boolean
  docId?: string          // present only when hasPage is true
}
```

`engine.search` is called from exactly one place, `tools.ts:303`, so the shape change costs nothing
elsewhere. Verified by grep across `server`, `cli`, and `core`.

**Node hits are not fused into the RRF ranking.** Reciprocal rank fusion (`retrieval.ts:66-95`)
combines two lists that both rank the same population of chunks. A node has no chunk, no FTS rank
and no cosine score, so any score assigned to it for fusion would be invented. Mixing an invented
score into a real ranking is how a retrieval system starts lying quietly. The node lane is returned
separately, capped, and clearly labelled.

**Every node type is included**, not just person and entity. An arc or realm that also has a page
will appear in both lanes, which is not waste: the document lane answers "what does this page say",
the node lane answers "what is this node's id", and `graph_query` needs the id. Item nodes are the
interesting third case: item text is already indexed, because `buildChunks` appends
`itemChunkText(item)` for every item in a summary's frontmatter (`sqlite.ts:408-417`), but the item's
node id is not recoverable from a document hit. The node lane makes it recoverable.

**Description change.** `search_memory`'s description gains a sentence explaining the two lanes and
what a node-only hit means:

> Results come back in two parts. `documents` are ranked passages from pages, summaries and rollups,
> each with a snippet. `nodes` are graph nodes whose name matches the query, including people and
> things that have no page of their own; a node hit carries an id you can pass to `graph_query`, and
> a `docId` only when a page exists. A node hit with `hasPage: false` means this person or thing is
> known and recorded, and there is nothing written about them beyond their name and their links.

That last clause matters. Without it a model that receives a bare node hit will either ignore it or
assume a page failed to load.

#### 6b. `list_people` and `list_entities`

```
list_people(nameContains?: string, hasPage?: boolean, offset?: number, limit?: number)
list_entities(nameContains?: string, offset?: number, limit?: number)
```

Both return the shared envelope from section 4. Rows:

- `list_people`: `{ id, name, hasPage, docId?, firstSeen }`, where `firstSeen` is the node `ts`.
- `list_entities`: `{ id, name, firstSeen }`. No `hasPage`, no `docId`, because entities have no
  pages in this release and emitting `hasPage: false` on every row would be noise that implies a
  page might exist. If entity pages ever arrive, the shape gains the fields then.

**Ordering, and why it differs from the prompt's.** Rows are ordered by node `ts` descending, tie
broken by node id descending. `capPeople`'s paged-first rule is explicitly not inherited. That rule
decides *who survives truncation* in a fixed-size prompt list, where a maintained page is better
evidence of importance than raw recency. It is not a render order, and the comment at
`engine.ts:1701-1710` says so. A paging tool truncates nothing, so it has no use for a priority
rule; what it needs instead is a total order stable across calls and across index rebuilds, which is
what the id tiebreak provides. `hasPage` is exposed as a filter argument so a model that wants the
paged-first view can ask for it directly.

`limit` defaults to 50 and is clamped to 200. `total` is the true count regardless of `nameContains`
filtering; when a filter is applied, `total` is the count of matching rows, so `hasMore` stays
meaningful.

#### 6c. The prompt's truncation markers gain the escape hatch

The existing markers say more exist. They must say how to get them. `SessionContext` gains
`peopleTotal` and `entitiesTotal`, and the markers become:

```
(showing 40 of 137 people, paged people first then most recently added. Call list_people to page
through the rest, or search_memory by name.)
```

```
(showing 30 of 84 entities, most recently added first. Call list_entities to page through the rest,
or search_memory by name.)
```

This is the single change that closes the loop the current code opens.

## 7. P5. The system prompt has no budget

### The defect

`constitutionSection` (`context.ts:67-71`), `latestDailyRollupSection` (`:92-96`), and
`recentSummariesSection` (`:98-102`) render full bodies with no cap. Three summaries plus a rollup
plus a constitution grown over two years is an unbounded prefix on every model call in every session.
`## Active arcs` and `## Realms` are unbounded in row count as well: active-only filtering bounds
arcs against closed ones, but nothing stops thirty active arcs.

### Measurement, honestly

There is no tokenizer anywhere in this repository. Grep across all six packages finds `maxTokens` as
a pass-through request field and nothing that counts. So the budget is specified and enforced in
**characters**, and the token figures below are an assumption, not a measurement: roughly four
characters per token for English prose. Everything the code asserts is in characters. Nothing claims
to count tokens.

### The design: independent hard per-section caps, no global arbitration

| Section | Cap (characters) | Notes |
| --- | --- | --- |
| `profile.md` prose body | 2,000 | Owned and enforced by the modes spec (2026-08-16-modes-profile-settings-design.md, section 3.2), which caps the prose body at prompt-assembly time with its own truncation marker. Carried here only so the running total accounts for it |
| `## Constitution` | 6,000 | Chat prompt only. See the reflection carve-out below |
| `## Realms` | 4,000 | Plus a per-realm first-line cap of 160 characters. See below |
| `## Active arcs` | 2,000 | New `ARCS_CAP = 30` rows. See below |
| `## People` | 2,500 | Row cap unchanged at 40 |
| `## Entities` | 1,200 | Row cap unchanged at 30 |
| `## Recent intentions` | 800 | Row cap unchanged at 5 |
| `## Latest daily rollup` | 2,500 | |
| `## Rollups available` | 800 | New, section 8 |
| `## Recent sessions` | 6,000 | 2,000 per summary, 3 summaries |
| **Sum** | **27,800** | Target for the whole assembled body: **28,000** |

The persona is excluded. It is authored, fixed in size, and cannot grow with use. The time spec's
`## Right now` block is excluded for the same reason, and because it is appended per round rather
than assembled here.

**Two new row caps.** `## Active arcs` gains `ARCS_CAP = 30`. Active-only filtering
(`engine.ts:547`) bounds arcs against closed ones and nothing bounds them against each other, so a
user with many open storylines has an unbounded section today. Rows are ordered by `lastTouched`
descending. `lastTouched` is optional on `SessionContext.arcs` (`engine.ts:126`) and the engine omits
it when the arc's page cannot be read, so arcs without it sort last, ordered among themselves by node
`ts` descending. Without that rule the cap would drop a nondeterministic arc.

`## Realms` gains no row cap. Realms are life domains, curated by reflection and few by nature; the
4,000-character section cap is roughly 24 realms at the 160-character per-realm first-line cap, so it
should never trigger. It is specified anyway, with a marker, because an uncapped section is how
`## Constitution` got here.

**There is no cross-section arbitration, and that is the design choice.** Because every cap is hard
and applied independently, the sum can never exceed 27,800, so no priority ordering is ever needed
at runtime. A global squeeze (a total budget with sections yielding to each other) would make the
prompt's content depend on the size of unrelated sections, which is non-deterministic to reason about
and unpleasant to test: the same constitution would render differently depending on how many people
exist. The 28,000 target is therefore not runtime behavior. It is an invariant asserted by a test
over the constants (section 12, test 7), which fails if anyone raises a cap past the total.

**Truncation is always signalled, and always with a fetch key.** Two forms, extending the existing
house convention at `context.ts:109-113`.

List truncation, as shown in section 6c for people and entities, and in the same form for the two
new caps:

```
(showing 30 of 47 active arcs, most recently touched first. Call list_arcs for the rest, including
dormant and closed ones.)
```

```
(showing 22 of 26 realms. Call list_realms for the rest.)
```

Both name the tool that fixes the gap, which is what makes section 4's work on those two tools pay
for itself. Every capped list section in the prompt now has a marker and every marker names a tool.

Prose truncation, new:

```
(truncated: showing the first 6,000 of 18,432 characters. Call read_document with docId
doc_01JAB7QK3M9XZ2R4T6V8W0YCDE for the full text.)
```

The docId is required, not decorative. A truncation marker without one reproduces P1 exactly: the
model is told something exists and given no way to fetch it. Every truncatable section this spec caps
is a document with an id (the constitution, the daily rollup, each session summary), so the key is
always available.

One row in the budget table above is a deliberate exception: `profile.md`'s prose body. It is
unindexed by design, per the time spec, so it has no docId to hand back. The modes spec, which owns
that cap, uses a bare `… [truncated]` marker with no fetch key, and that is correct given the file has
no read path through any tool. `capBody`, as specified here, is not applied to it.

Prose is cut from the start of the body forward, at the last paragraph boundary at or before the cap;
if there is no paragraph boundary before the cap, it is cut at the cap. Keeping the head rather than
the tail is deliberate for the constitution, whose opening carries the most stable identity material,
and neutral for rollups and summaries, which are written as narrative.

A single shared pure function does this, so there is one truncation implementation and one marker
format:

```ts
export function capBody(
  body: string,
  limit: number,
  docId: string,
): { text: string; truncated: boolean }
```

### The reflection carve-out, which is a safety property

`buildReflectionContext` (`engine.ts:1704` onward) builds a second prompt from the same constitution,
also unbounded. It would be natural to apply the same cap there. **It must not be applied to the
constitution in the reflection path.** Reflection's second pass emits `out.constitutionUpdate` as a
complete replacement body, which `reflection.ts:655-662` writes over the existing file. If the model
is shown a truncated constitution and asked to produce the updated one, the tail it never saw is
deleted from disk. That is silent data loss in the one document that is meant to be the living record
of the person.

So: `capBody` applies to `assembleSystemPrompt` only. Reflection continues to receive the full
constitution. This is stated as a rule in code comments at both call sites, because it is the kind of
asymmetry a later refactor removes for tidiness.

Reflection's other unbounded inputs (arcs, realms, people, entities) are already capped by the same
`capPeople` and `capEntities` helpers the prompt uses, and stay as they are. The consequence, that a
constitution can grow until it alone dominates the reflection call, is real and unaddressed here.
It is open question 2.

## 8. P6. Weekly rollups: preload a compact index, not the content

### The question asked

Is it acceptable that a user says something about a month ago and nothing about weekly rollups is in
context?

### The answer, and the honest part first

There are no monthly or yearly rollups. The README says so at line 47: "Monthly and yearly rollups
(only daily and weekly exist)." So "a month ago" has no artifact of its own. The closest thing that
exists is four or five weekly rollups, and the model has no way to know they exist, because weekly
rollups are preloaded nowhere and appear in no listing. Today the only path to one is a
`search_memory` query that happens to match its prose, with a `kinds` filter the model has to guess
at, and a date filter that (before section 5) does not work on weeklies at all.

### The design: a compact index, and the fetch path that makes it useful

Do not preload weekly rollup content. Weekly rollups accumulate at 52 per year forever, and each is
several paragraphs. Preloading them re-creates the unbounded-prompt problem section 7 exists to fix,
and preloading only the newest one (the daily rollup's pattern) answers "last week" and nothing else.

Preload a shelf listing instead. New section, after `## Latest daily rollup`:

```
## Rollups available

Weekly rollups, most recent first: 2026-W33 (doc_01JAB…), 2026-W32 (doc_01JAB…), 2026-W31 (doc_01JAB…)
… 12 shown, 61 exist, running back to 2025-W25.
Daily rollups: 214 days covered, from 2025-06-14 to 2026-08-15. The newest is shown above in full.
Read any of these with read_document, or find one by period with search_memory using kinds and a date range.
```

Rules:

- The most recent `WEEKLY_INDEX_CAP = 12` weeks are listed, each with its `docId`. Twelve is a
  quarter, which covers "a month ago" and "earlier this season" without listing years.
- The docId per period is mandatory. A listing of period names without keys reproduces P1 for the
  third time: the model would learn the shelf exists and still have no way to take anything off it.
- Older weeks are stated as a count and a range, not enumerated. That is what keeps the section
  inside its 800-character budget.
- Daily rollups get a count and a range and no ids, because the newest is already rendered in full
  and the rest are found by date.

**Where the data comes from.** `SessionContext` gains:

```ts
weeklyRollups: { week: string; docId: string }[]   // newest first, at most WEEKLY_INDEX_CAP
weeklyRollupsTotal: number
earliestWeek?: string
dailyRollups: { total: number; earliest: string; latest: string }
```

The daily figures are free. `sessionContext` already walks `rollupsDailyDir` to find the newest
rollup (`engine.ts:565-571`), and counting and range-tracking during that same walk costs nothing.

The weekly figures are not free. They require a new `listDocuments` walk of `rollupsWeeklyDir` on
every session start, plus a `docIdByPath` lookup per week to turn each path into a `docId`. That is
one directory read and up to 12 map lookups per session start, against a directory that holds one
small file per week (61 files after five years). The cost is stated rather than hidden: it is a
directory listing and a frontmatter parse per weekly file, on the same order as the daily walk
already performed beside it. If that walk ever becomes noticeable, the fix is to cache the shelf and
invalidate it when `runMaintenance` writes a new weekly, not to drop the section.

**The fetch path for anything older than twelve weeks depends on section 5.** Once weekly rollups
carry `date_start`/`date_end` in the index, `search_memory` with
`kinds: ["rollup_weekly"], after: "2026-05-01", before: "2026-05-31"` returns exactly the weeks
overlapping May, each with a `docId`. That path does not exist today, for two independent reasons:
weekly paths carry no parseable date, and the filter over-includes anyway. This is why P6 is not
solvable on its own and is specified after P3.

**On monthly rollups.** A monthly rollup would give "a month ago" a real artifact instead of five
weeklies. It is not in this spec. Adding a rollup tier means a new `DocKind`, a new build prompt, a
new pending-rollup trigger, and a decision about whether monthlies summarize weeklies or dailies.
Deferred, and listed as such.

## 9. P7. Vector search loads every embedding row

This section documents a known ceiling. No work is proposed.

### What the code does

`MemoryIndex.searchVector` (`sqlite.ts:299-330`) runs an unbounded
`SELECT ... FROM embeddings JOIN chunks JOIN documents` with no `LIMIT`, converts every blob to a
`Float32Array`, computes cosine similarity in JavaScript for each row (`cosineSimilarity` at
`sqlite.ts:494`), sorts the whole array, and slices the top 20. There is no ANN index, no quantization, no
early termination. Every `search_memory` call reads and scores the entire corpus.

At personal-memory scale this is the correct engineering trade. It is exact rather than approximate,
it has no index to keep in sync, and it works identically on a rebuilt folder.

### Where it starts to hurt

Rough arithmetic, stated as an estimate, not a measurement. With `text-embedding-3-small` at 1,536
dimensions, one Float32 vector is 6,144 bytes. Chunking packs paragraphs to
`MAX_CHUNK_CHARS = 1200` and adds one chunk per item (`sqlite.ts:408-444`). A heavy user at two
sessions a day generates roughly: 2 to 3 chunks per summary plus one per item, one or two for the
daily rollup, and a handful more as arc and person pages are rewritten. Call it 30 chunks a day, so
about 11,000 chunks and 67 MB of vectors per year.

At one year, a search reads 67 MB out of SQLite, allocates 11,000 typed arrays, and does about 17
million multiply-adds. The floating-point work is tens of milliseconds; the blob read and the
Buffer-to-Float32Array conversion dominate and are likely the larger share. Under a few hundred
milliseconds per search is plausible, and a turn may issue several searches.

At three to five years (35,000 to 55,000 chunks, 200 to 340 MB) the same operation is plainly into
seconds, and the allocation churn starts producing garbage collection pauses inside a turn the user
is waiting on. So the ceiling starts to bite somewhere between one and three years of daily use for
a single user, earlier if page rewrites are frequent, later for a light user. Those are estimates
from arithmetic, and the point of the next subsection is that nobody should act on them without
numbers.

### What would be measured to know

Three things, none of which exist today.

1. **Corpus size.** `SELECT count(*) FROM embeddings` and the total blob byte count. The natural
   place to surface this is `reverie doctor`, which the CLI polish spec owns; this spec states the
   measurement, not where it prints.
2. **A timing split inside `searchVector`**, behind a debug flag: milliseconds spent in the SQL read,
   in blob decoding, and in cosine computation. The split matters because the three have completely
   different fixes (a covering index, a stored format change, and an ANN index respectively), and
   guessing wrong means rewriting the wrong layer.
3. **End-to-end `search_memory` latency per turn**, at the p95, alongside the count of searches per
   turn. A 200 ms search called five times in one turn is a worse experience than a 600 ms search
   called once.

A reasonable trigger for revisiting: median `searchVector` above 300 ms, or observable GC pauses
during a turn. The obvious directions when that day comes are an ANN extension such as `sqlite-vec`,
or scalar quantization to int8 with an exact rescoring pass over the top candidates. Both are real
work with real trade-offs and neither is designed here.

## 10. P8. Every new document type declares how the model reads it

### The standing rule

**Any new document type must declare, at design time, how the model reads it: preloaded into the
system prompt, reachable through a tool, or both. A document type that declares neither is a defect,
not a gap.**

The user's memory folder is the product. A file that the system writes and the model can never read
is a file the user is being charged for, in disk and in reflection calls, that does nothing.

### What declaring actually means

A principle without touchpoints does not get followed. Concretely, a new document type must account
for each of these six, either by doing it or by stating in writing why it does not.

1. **`DocKind`** (`sqlite.ts:12-19`) is a closed union. A type absent from it cannot be indexed at
   all. Not being indexed is a legitimate choice; `profile.md` makes it, explicitly, in the time
   spec. Making it silently is not.
2. **`walkAllDocuments`** (`engine.ts:1238-1276`) enumerates every directory by hand. A type missing
   here survives `upsertDocument` on write but vanishes on the next `reindexAll`, which is the
   nastiest version of this bug: search works until someone repairs the index, and then stops.
3. **The `kinds` enum text in `search_memory`'s description** (`tools.ts:89-90`) is a hand-maintained
   string listing valid kind values. A type missing here is filterable but undiscoverable, because
   the model is reading a list that does not contain it.
4. **`documentDateSpan`** (new, section 5) must classify it as point-in-time or living, so date
   filtering treats it honestly rather than by whatever its path happens to look like.
5. **`assembleSystemPrompt` and a per-section character cap** (section 7), if it is preloaded.
6. **The web read-only document API** (`listPublicDocuments` / `getPublicDocument`), if the user
   should be able to see it in the atlas.

### Applied to the three types currently in flight

Stated here for completeness. None of this changes what the sibling specs decide.

- **`profile.md`** (time spec): preloaded, deliberately not indexed, not in `walkAllDocuments`. Fully
  declared. Living, so `documentDateSpan` returns `null`. Its cap belongs to the modes spec, which
  caps the prose body at 2,000 characters at prompt-assembly time (that spec, section 3.2); section
  7's budget table carries that number only so the running total accounts for it.
- **`journaling.md`** (journal spec): indexed as `DocKind 'journaling'`, added to
  `walkAllDocuments`, and read at the start of a journal-mode session into the mode paragraph. Both
  preloaded and tool-reachable. Declared. Living, so `documentDateSpan` returns `null`.
- **`journal/<entryDate>-<ulid>.md`** (journal spec): indexed as `DocKind 'journal'`, added to
  `walkAllDocuments`, tool-reachable only, not preloaded. Declared. Point-in-time, so
  `documentDateSpan` returns the entry date for both ends.

Two touchpoints those specs do not currently mention, raised here rather than edited into their
files: neither `'journal'` nor `'journaling'` appears in the hand-maintained `kinds` list in
`search_memory`'s description, and neither is classified for date filtering. Both are covered by the
structural test in section 12, test 14, which is the reason to have that test rather than a
convention.

## 11. How the retrieval pipeline actually works

Written to be linked from the README, which currently says less about this than the code does.

**Status, stated first because this section is meant to be linked.** Everything below describes code
that exists and runs today, with two exceptions, both marked inline as new: the node lane in the
query step, and the date-span filter pushed into SQL. Neither is implemented at the time of writing.
Until they are, a reader following a link here should treat those two paragraphs as design and the
rest as description.

**Indexing.** Whenever a document is written (a session summary, a rollup, a rewritten arc or person
page, the constitution), `MemoryEngine.reindexDocument` removes any stale row at that path and calls
`MemoryIndex.upsertDocument`. That splits the body into chunks by packing whole paragraphs up to
`MAX_CHUNK_CHARS = 1200` (`sqlite.ts:419-444`), never splitting mid-paragraph, and appends one extra
chunk per item in the document's frontmatter. Each chunk is inserted into `chunks`, mirrored into
the FTS5 virtual table `chunks_fts`, and embedded. Embeddings are real: `MemoryIndex.upsertDocument`
calls the injected `embed` function, which reaches `OpenAiEmbeddingProvider.embed`
(`providers/src/openai.ts:305-335`) in batches of 100, and the returned vectors are stored as
Float32Array blobs in `embeddings(chunk_id, vector)` (`sqlite.ts:103-106`). `reindexAll`
(`engine.ts:1084-1098`) wipes every derived row and rebuilds the whole thing from the markdown on
disk, which is what makes the SQLite file genuinely disposable.

**Query.** `searchMemory` (`retrieval.ts:31-51`) runs two searches over the same corpus.

1. **Lexical.** `MemoryIndex.searchText` runs an FTS5 `MATCH` over `chunks_fts`, joined to
   `documents`, ordered by FTS rank, limited to 20 candidates (`sqlite.ts:262-297`). It returns a
   generated snippet per hit.
2. **Semantic.** The query string is embedded through the same provider (`retrieval.ts:40`).
   `MemoryIndex.searchVector` reads every stored vector, computes cosine similarity in JavaScript
   (`sqlite.ts:299-330`, using `cosineSimilarity` at `sqlite.ts:494`), sorts, and takes the top 20.
   See section 9 for the ceiling this implies.

Both apply the caller's `kinds` filter, and (new, section 5) the `after`/`before` span filter, inside
SQL rather than afterwards, so a filtered-out document never consumes a candidate slot.

**Fusion.** The two lists are merged by reciprocal rank fusion (`retrieval.ts:66-95`): each list is
first collapsed to one row per document, then each document scores the sum over both lists of
`1 / (60 + rank)`, with `RRF_K = 60`. Collapsing before ranking is deliberate; without it a document
with many matching chunks in one list could out-accumulate a document that genuinely tops both. The
fused list is sorted by score and cut to the caller's limit, default 8.

**Node lane (new, section 6).** Independently of all of the above, graph node labels are matched by
case-folded substring against the query's tokens and returned as a separate, capped list. Node hits
are never fused into the ranking, because they have no rank in either list and any score given to
them for fusion would be fabricated.

**What is deliberately absent.** There is no reranking model, no query rewriting, no HyDE, no
chunk-overlap window, and no ANN index. Retrieval is one round trip: two searches, one fusion, one
cut.

## 12. Testing plan

TDD for all of it, since every behavior here is deterministic. None of it is LLM-dependent: whether
the model *chooses* to page through `list_people` is an evaluation question, not a unit test, and is
called out honestly as such at the end. Each test below names its falsification, per AGENTS.md.

1. **Date filter actually excludes.** Fixture with two daily rollups, 2026-05-01 and 2026-08-01,
   both matching the query text. Two assertions in one test: with no filter, both are returned; with
   `after: "2026-07-01"`, only the August one is. The first assertion is what makes it falsifiable,
   because a test asserting only "all results are in range" passes when the filter is deleted if no
   out-of-range document ranked. *Falsify: remove the date predicate from the SQL, the second
   assertion fails while the first still passes.*

2. **Living documents survive a date filter.** Same fixture plus an arc page matching the query,
   with `opened` and `updated` frontmatter both well outside the range. With `after: "2026-07-01"`
   the arc page is still returned. *Falsify: drop the `date_start IS NULL OR` branch from the SQL,
   test fails.*

3. **Weekly rollup spans overlap correctly.** A weekly rollup for `2026-W33` (Monday 2026-08-10
   through Sunday 2026-08-16). Assert it is included by `after: "2026-08-14"`, included by
   `before: "2026-08-11"`, and excluded by `after: "2026-08-17"`. *Falsify: store only the Monday
   and compare as a point, the first case fails.*

4. **ISO week inverse.** Unit tests for week-id-to-Monday across year boundaries (2026-W01,
   2025-W53), round-tripped against the existing `isoWeekOf`. *Falsify: use a naive
   week-number-times-seven offset, the year-boundary cases fail.*

5. **Truncation marker appears, and only when it should.** Two fixtures. Over budget: a constitution
   of 12,000 characters whose last paragraph is a distinctive sentinel sentence. Assert the marker is
   present, the sentinel is absent from the prompt, and the docId named in the marker resolves
   through `read_document` to a body containing the sentinel. Under budget: a 500-character
   constitution, assert the marker is absent. The under-budget case is what makes this falsifiable;
   marker-present alone passes against a hardcoded string. *Falsify: delete the cap, the over-budget
   test fails on both the marker and the sentinel.*

6. **The new row caps signal, and only when they bite.** Two fixtures. 47 active arcs: assert 30 are
   rendered, that the marker states "30 of 47" and names `list_arcs`, and that the 31st by
   `lastTouched` is absent. 5 active arcs: assert no marker. Third case, two arcs with no
   `lastTouched` and one with: assert the dated arc sorts first and the two undated ones follow in
   node `ts` order. *Falsify: delete `ARCS_CAP` and the first fixture fails on both the marker and
   the count while the second still passes; remove the undated ordering rule and the third fails.*

7. **The budget arithmetic holds.** Assert the sum of the per-section caps is at most the stated
   total. *Falsify: raise any cap past the total, test fails.* Cheap, and it is the only thing
   stopping the caps drifting apart from the target they were chosen against.

8. **Reflection is not truncated.** With a 12,000-character constitution, assert
   `buildReflectionContext` returns the full body including the sentinel while
   `assembleSystemPrompt` returns a truncated one. *Falsify: apply `capBody` in
   `buildReflectionContext`, test fails.* This test exists to stop a future tidying refactor causing
   silent data loss when reflection rewrites a constitution it was only shown half of.

9. **The 41st person is reachable, end to end.** Fixture graph with 45 person nodes, of which 5 have
   pages. Four assertions: the 41st by the prompt's own ordering does not appear in the assembled
   prompt; the prompt's truncation marker states "40 of 45" and names `list_people`; `list_people`
   with `offset: 40` returns that person with `hasPage: false`; and `search_memory` with a query
   containing that person's name returns them in the `nodes` lane with no `docId`. *Falsify: revert
   the node lane and the fourth assertion fails; revert paging and the third fails; revert the marker
   change and the second fails.* This test encodes the complaint that motivated section 6.

10. **Paging covers everything exactly once.** 45 person nodes of which 5 share an identical `ts`.
    Page through with `limit: 7` and assert the concatenation contains 45 distinct ids and equals the
    single unpaged ordering. *Falsify: remove the id tiebreak and rebuild the engine between page
    calls from a differently-ordered graph log, so the two calls disagree about the tied group; the
    union then has both a duplicate and a gap and the test fails.* Stated honestly: with a stable sort
    and a single process the tiebreak may not be observable, which is why the falsification requires
    the rebuild. The property being pinned is coverage, not the comparator.

11. **`list_arcs` and `list_realms` chain into `read_document`.** Fixture with an arc that has a page.
    Assert the returned row carries a `docId`, carries no filesystem `doc` path, and that
    `read_document` with that id returns the arc's body. *Falsify: return raw `GraphNode`s, the first
    and third assertions fail.*

12. **`list_arcs` returns the status it promises.** Fixture with one active and one closed arc.
    Assert both are returned with correct `status` when unfiltered, only the active one with
    `status: 'active'`, and that an arc whose page cannot be read comes back with `status` absent
    rather than defaulted. *Falsify: return nodes without reading frontmatter, all three fail.*

Session-id reachability itself is not tested here a second time. The time spec's testing plan already
carries the falsifiable version of that assertion (an assembled prompt containing a recent session
summary must contain that session's id as a recoverable substring, and the id parsed back out must be
one `engine.readTranscript` accepts); repeating it in this plan would test the same renderer through
two specs.

13. **The rollup shelf hands back keys.** Fixture with 15 weekly rollups. Assert the section lists
    the newest 12 with docIds, states the true total and the earliest week, and that every listed
    docId resolves through `read_document`. Then assert `search_memory` with
    `kinds: ["rollup_weekly"]` and a date range covering week 3 returns that week's rollup. *Falsify:
    render period names without docIds, the resolve assertion fails; revert section 5, the search
    assertion fails.*

14. **Every `DocKind` is wired end to end.** Table-driven over the `DocKind` union. For each value,
    assert it appears in `search_memory`'s hand-maintained kinds list, that a fixture folder
    containing one document of that kind produces it from `walkAllDocuments`, and that
    `documentDateSpan` returns either a span or an explicit `null` (never `undefined`, so a kind
    cannot be forgotten by falling through a switch). *Falsify: add a `DocKind` value without wiring
    it, the test fails on the first assertion.* This is the enforcement mechanism for section 10's
    standing rule, and the reason it is a rule rather than a hope.

15. **Index schema migration rebuilds rather than emptying.** Open an engine, index documents, close
    it, rewrite `PRAGMA user_version` to 1, reopen. Assert the derived tables were rebuilt, that a
    search that worked before still works, and that a warning was recorded. *Falsify: skip the
    rebuild call after the reset, the search assertion fails against an empty index.*

**Not covered by tests, stated plainly.** Whether the model actually calls `list_people` when it sees
the truncation marker, whether it thinks to combine `kinds` with a date range, and whether node-lane
hits improve answers are all model-behavior questions. They belong in fixture-transcript evaluation
of tool selection, not in unit tests, and this spec does not claim they are verified by the plan
above. What the plan verifies is that the mechanism exists, is reachable, and does what its
description says.

## 13. Deferred, and out of scope

- **An ANN index or quantized vectors.** Section 9 documents the ceiling and the measurements. No
  rewrite is designed, and none should be attempted before those numbers exist.
- **Monthly and yearly rollups.** They would give "a month ago" and "last year" real artifacts. New
  `DocKind`s, new build prompts, new pending triggers, and a decision about what they summarize.
- **Reranking, query rewriting, and chunk overlap.** No evidence yet that fusion of FTS and cosine is
  the weak link.
- **Constitution compaction.** Section 7 caps what the chat prompt sees and deliberately does not cap
  what reflection sees, which leaves an unbounded constitution growing inside the reflection call.
  See open question 2.
- **`docId` in the prompt's People, Realms and Arcs sections.** Considered in section 4 and rejected
  on budget grounds, with the listing tools as the fetch path.
- **Pages for entities.** Still deferred, per the remember-by-default spec section 8. Section 6 makes
  unpaged entities reachable without changing that decision.
- **A `graph_query` kind that resolves one node id to its `docId`.** Redundant with `list_people`
  today. Revisit if the extra hop shows up in practice.
- **Retrieval that varies by mode.** The modes spec explicitly leaves this alone and so does this one.

## 14. Open questions

1. **Is 6,000 characters the right constitution cap?** It is roughly 1,500 tokens under the stated
   assumption, and roughly two pages of prose. No real constitution has been measured against it,
   because no long-running folder exists yet to measure. The number should be revisited against a
   real folder before v0.5.0 ships, and the test in section 12 item 6 makes changing it cheap.

2. **What bounds the constitution inside reflection?** Section 7 explains why truncating it there
   would delete the tail on the next rewrite. That leaves the reflection prompt growing without
   bound, which is a real cost on every session end. A compaction pass (the model rewriting the
   constitution shorter, deliberately, as its own operation) seems like the right shape, but it is a
   change to the one document the project treats as the living record of the person and should not be
   designed casually.

3. **Should `list_people`'s default order be recency or alphabetical?** Section 6 chose recency
   descending for consistency with the prompt and with `capPeople`. Alphabetical is arguably better
   for a human reading the same listing through the web atlas. If the atlas ever renders this, the
   two consumers may want different orders, and the tool should probably take a sort argument rather
   than pick one.

4. **Is `WEEKLY_INDEX_CAP = 12` enough?** Twelve weeks covers a quarter. A user asking about "last
   winter" gets the count-and-range line and has to search. Raising it to 26 costs roughly 500 more
   characters per prompt, forever. This is the kind of number that should be set by watching what
   people actually ask about.

5. **Resolved: the profile prose cap belongs to the modes spec, not here.** It owns `profile.md`'s
   prose body and caps it at 2,000 characters at prompt-assembly time. See
   `2026-08-16-modes-profile-settings-design.md`, section 3.2. Section 7's budget table carries that
   number only so the running total accounts for it; this spec does not enforce or test it.
