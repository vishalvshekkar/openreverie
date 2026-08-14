# Phase A design: companion quality

Date: 2026-08-14
Status: approved (brainstormed and confirmed with the project owner)
Target release: v0.3.0
Scope: five changes to the memory engine, agent core, and terminal client, all aimed at making
daily use feel like talking to a companion rather than operating a tool.

This spec builds on [the 2026-08-13 design spec](2026-08-13-openreverie-design.md) and amends it
where noted. Where the two disagree, this one wins, because it is newer. The older spec stays in
place as the description of the engine's foundations.

## 1. Amendments to the 2026-08-13 spec

Three statements in the original design no longer hold.

| Original | Replacement |
| --- | --- |
| §2 goal: "A confirmation flow that keeps the user in control of how their record is structured." | Memory saves by default. Removal is parked: see the forget section below. |
| §3 decisions log, Attribution: "Confidence split: auto-assert high-confidence links, queue proposals for new arcs and uncertain links." | Save by default: reflection asserts arcs, people, and links directly. |
| §6: "New arcs, new persons of significance, and uncertain links go to `proposals.jsonl`." | Reflection writes them straight to the record. Nothing new is added to the proposal queue. |

The reason: asking permission to remember does not fit a companion whose defining property is that
it remembers. In practice the asking was also doing less than it appeared. Only three things ever
went through it (new arcs, new people, and links the model was under 80% sure of), while every
item, every session summary, every arc rewrite, every constitution update, and every confident
link already saved with no human step. The `confirmed` flag those approvals produced is written to
`graph.jsonl` and never read by any query, so an approved edge and an auto-asserted one behave
identically. The gate was ceremony, and it made a companion feel like a form.

Everything else in the 2026-08-13 spec still stands, in particular: files are truth, SQLite is
derived and disposable, transcripts are append-only and never modified, prose relationship claims
are testimony while the graph log is the record, and both safety modes ship unweakened.

## 2. Item one: remember by default, and forget

### Reflection stops proposing

`applyReflection` no longer creates proposals. Concretely:

- Every attribution becomes an asserted `part_of` edge, carrying the model's confidence value,
  whatever that value is. The `CONFIDENCE_THRESHOLD` branch goes away.
- `newArcs` are materialized during reflection: realm resolved or created, arc document written,
  arc node asserted with its `doc` pointer, `in` edge to the realm, `part_of` edges from the
  cited items. This is the work `materializeProposal` does today on acceptance, moved to happen
  directly.
- `newPersons` are materialized during reflection: person node asserted, `involves` edges from
  the cited items, and a person page written (section 3).
- The `confirmed` flag stays in the record format and is always `false`, now meaning "not
  explicitly affirmed by the user" rather than "awaiting approval". Nothing reads it. It stays
  because removing a field from an append-only log format is a breaking change for no benefit.

### The proposal machinery stays, dormant

`proposals.jsonl`, `pendingProposals`, `resolveProposal`, `materializeProposal`, the
`resolve_proposal` tool, and `pendingProposalsSection` all remain and keep working. Memory folders
that predate this release have pending proposals in them; those still surface at session start and
still resolve conversationally. Nothing new is ever appended to the queue.

Removing the machinery is a roadmap item for after existing queues have drained. This is not
tidiness deferred, it is a compatibility guarantee: the owner's real memory folder predates this
work, and a release that silently strands pending proposals would be a data-honesty failure.

### The forget tool, parked

**Status: parked during implementation, on the owner's decision. Not shipping in v0.3.0.**

The design below was implemented and tested, then deliberately left unexposed. `MemoryEngine.forget`
exists in the memory package with its tests; no tool, persona instruction, or CLI path reaches it.
The companion has no way to remove anything, and does not claim otherwise.

So v0.3.0 is remember-everything with no product removal path. The one way to take something out of
the record is editing the markdown in the memory folder by hand, which works because the files are
the user's and readable in any editor, but it is manual and the documentation must say so plainly
rather than implying reverie can do it.

Two gaps found in review must be resolved before this is ever exposed:

- Retracting a node that has a page left the page on disk and fully searchable, so reverie would
  report someone forgotten while their page still surfaced in the next conversation. Fixing it means
  deciding whether forget may delete a prose file, which the index-rebuildable-from-the-folder rule
  makes unavoidable: dropping index rows while leaving the file means `reverie reindex` resurrects it.
- A partial multi document failure was not atomic. Graph retractions and earlier document writes had
  already landed while the call reported failure and never committed.

The original design follows, unchanged, as the starting point for whenever this is picked up.

New tool, available to the companion:

```
forget({
  what: string,                                    // plain description, for the commit message
  nodeIds?: string[],                              // person, arc, or entity nodes to retract
  edges?: { edge, from, to }[],                    // specific edges to retract
  documents?: { docId: string, body: string }[],   // prose documents to rewrite without the fact
})
```

Behavior:

- Node and edge removals append `op: 'retract'` records to `graph.jsonl`. The retract op already
  exists and is already correctly folded; nothing in the codebase has ever emitted one. Both the
  original assertion and the retraction stay in the file, so the history of the forgetting is
  itself preserved.
- Document rewrites go through `writeDocumentAtomic`, the same full-body replacement path
  reflection already uses for the constitution and arc narratives. The companion supplies the new
  body, having read the document in the same conversation. A rewrite that would leave an empty
  body is rejected.
- The whole operation ends in one git commit, message `forget: <what>`.
- The tool returns what it actually changed, so the companion can say it accurately.

What forget does not touch, by design:

- **Transcripts.** Append-only is the foundation the entire design rests on. The companion must
  say this plainly when it forgets something: the record has been changed, the original
  conversation has not, because it never edits those.
- **Session summaries and their items.** A summary is the record of a session, sitting closer to
  the transcript than to the forward-looking record. Extending forget to reach items is a roadmap
  item, not part of this release.
- **Git history.** Removed content remains recoverable from the memory folder's git history. This
  is a forward-only redaction and the documentation says so rather than implying deletion.

The persona gains a short instruction: when the user asks you to forget something, do it, confirm
what was removed, and say plainly that the transcript of the conversation itself is unchanged.

## 3. Item two: person pages

Significant people get a narrative document that reflection maintains, the way arcs do.

### Storage

- `MemoryPaths` gains `peopleDir`, at `people/` inside the memory folder. `ensureMemoryTree`
  creates it, so existing memory folders gain the directory on next open with no migration.
- A page is `people/<slug>.md`, slug computed by the existing `uniqueSlug` helper.
- Frontmatter: `id` (a `doc_` id, as every document has), `name`, `node` (the `person_` graph node
  id), `opened`, `updated`.
- `DocKind` gains `'person'`. `walkAllDocuments` walks `peopleDir` and tags it. The
  `search_memory` tool's description of valid kinds gains `person`.

### Graph link

The person node's `doc` field is set to the page's file path, matching what arc and realm nodes
already do. The node schema already supports this; nothing has ever set it for people.

`GraphNode.doc` holds a path, but `read_document` takes a document id, so a node found through the
graph cannot currently be opened. The engine gains a reverse path-to-id map alongside the existing
`docPaths` map, and `graph_query` results include `docId` for any node that has a `doc`. This
closes the gap for people now and is a prerequisite for the web graph view in Phase C.

### Creation

Reflection creates a person page directly, with no confirmation step, when it judges the person
significant. Significance stays the model's judgment, as it already is for `newPersons` today.
There is no mention count and no threshold in code.

To keep that judgment honest, the reflection prompt defines what significance means: someone who
recurs in this person's life and whom they actually talk about, not every name that appears in a
sentence. If dogfooding shows `people/` filling with one-line pages, a deterministic threshold
(for example, items from at least two distinct sessions) is the fallback, recorded on the roadmap
rather than built now.

`newPersons` gains a required `narrative` field so the reflection that creates a person also
writes the first draft of their page, instead of the page sitting on a starter sentence until the
next session. `newArcs` gains the same field for the same reason.

This field was specified as optional in the first draft of this spec, and was made required
during implementation. Required is correct: section 4 has new arcs and people skip the second
pass entirely, on the grounds that their pass-one narrative is their whole first body. That only
holds if the field is always populated, so optional would have left a new page sitting on its
starter sentence exactly in the case the field exists to prevent. Because a required string can
still arrive empty, a narrative that is empty or whitespace only falls back to the starter body
rather than writing a blank page.

### Maintenance

The narrative rewrite gate at `reflection.ts:405` currently accepts only nodes of type `arc`, with
a test asserting a person node is refused. That gate widens to accept `person` as well. The
reflection prompt gains a "Known people" listing beside the existing arc and realm listings, and
the output schema gains `personUpdates` alongside `arcUpdates` (section 4 covers both).

## 4. Item three: narrative continuity (a defect this phase fixes)

Reflection's prompt includes the constitution's current body, but never includes any arc's current
body, and `arcNarratives` overwrites the arc document wholesale. Every session that touches an arc
therefore replaces its accumulated narrative with one written blind from that session alone. The
arc file does not grow; it gets rewritten. Only git holds what was there before.

No test catches this because every test asserts the arc body equals the new narrative, which is
the buggy behavior recorded as the expectation. What is missing is a test for continuity across
two consecutive reflections.

Person pages would inherit the defect, so it is fixed here rather than deferred.

### The fix: a second pass

Reflection becomes two passes.

**Pass one** is the existing call. Its `arcNarratives` field is replaced by
`arcUpdates: [{ arcId, note }]`, and `personUpdates: [{ personId, note }]` joins it. Neither
carries narrative prose any more. Each entry names a document this session gave something new and
carries a one-line note on what changed, which pass two uses as its brief.

**Pass two** runs once per document named in pass one, each an independent small call receiving:

- the document's full current body, never truncated,
- the session summary from pass one,
- the items attributed to that arc or person in this session,
- an instruction that the returned body replaces the file and must carry forward everything that
  still matters, changing what this session actually changed.

Output is validated by a zod schema (`{ body: string }`) with the same one-retry-then-degrade
policy reflection already uses. A pass-two failure leaves that document untouched, which is the
correct degradation: the old narrative survives.

Typical cost is zero to two extra calls per session. Reflection runs after the conversation ends,
so the added latency is invisible.

New arcs and new people skip pass two, since their `narrative` field from pass one is their first
body and there is nothing to carry forward.

## 5. Item four: the proactive greeting

Reverie speaks first.

### Mechanism

`AgentSession` gains `greet(): AsyncIterable<AgentEvent>`. It streams a model turn using the
session's assembled system prompt plus a greeting instruction section, with no user message and no
tools, and appends the resulting text to the transcript and to history as an assistant line.

Two implementation details the implementer must verify against the provider adapter rather than
assume: that a request with an empty `messages` array is accepted once the system prompt is mapped
in, and that an empty `tools` array is accepted. If either is not, the fallback is a synthetic
kickoff message that is passed to the provider but written to neither the transcript nor history,
because a message the user never sent must never appear in a transcript.

Transcripts already accept an assistant-first line with no format change.

### Content

The greeting always speaks, even when nothing is pressing. A companion that opens its mouth only
when it has business to raise reads as a task manager. When there is nothing to raise it is one or
two warm sentences with no agenda.

When something is pressing it opens with exactly one thing, chosen in this order:

1. Something left unresolved in the most recent session.
2. Something notable in the recent record: a day that sounded hard, a milestone coming up.
3. Nothing. A short hello.

Never a list. Never a summary of the record. Never a status report. The engagement style setting
governs how much it reaches for a thread: `following` stays light, `leading` is more willing to
name one.

On a first session the existing guided first-conversation instruction applies, now delivered
proactively rather than waiting for the user to speak into an empty folder.

### Degradation

The greeting must never block or break session start. On any provider error, and on a timeout of
20 seconds, the greeting is abandoned silently and the prompt appears. Nothing is half-written to
the transcript. The user's first real message will surface any provider problem clearly, so a
silent skip here is honest rather than hiding a failure.

### Two consequences

**Recent context is currently too narrow.** `sessionContext` gathers session summaries from
literally yesterday in UTC. If the last conversation was three days ago the greeting has nothing
recent to open from. The field widens to the most recent summaries within the last seven days,
capped at three, most recent first, and is renamed `recentSummaries` to say what it is.

**Empty sessions must not cost a reflection.** With a greeting, every session the user opens and
abandons contains an assistant message, so "empty" must mean "no user messages", not "no
messages". A session whose transcript contains no `user` line is skipped by reflection, which
writes a minimal `summary.md` carrying `skipped: true` and a reason. Writing the summary matters:
an unreflected session is detected by the absence of that file and would otherwise be retried
forever. This closes a roadmap item that becomes mandatory here.

## 6. Item five: reading your own record from the CLI

```
reverie read                    lists the constitution, arcs, realms, and people
reverie read constitution
reverie read arc <name>
reverie read person <name>
reverie read realm <name>
reverie read <name>             searches all three kinds, when unambiguous
```

Matching is case-insensitive substring. Ambiguity lists the candidates and exits rather than
guessing.

### It must not open the engine

`MemoryEngine.open()` unconditionally runs `runMaintenance()`, which can fire live reflection and
embedding calls, and constructing the providers requires a resolvable API key. Reading your own
record must not do any of that.

The read path uses `loadConfig` (only to learn the memory folder location), `memoryPaths`,
`listDocuments`, and `readDocument`. All are pure filesystem. No network, no API key, no index, no
maintenance. Reading your record works with the provider offline or unconfigured.

Names come from document frontmatter, not the graph, which keeps the whole path engine-free.

### Shape

Logic lives in a new `packages/cli/src/read.ts` as a pure function taking an injected writer, and
is unit tested there. `index.ts` gains one dispatch branch and stays thin, per its own header
comment. This is the first subcommand to take arguments beyond `argv[2]`, so it adds a small
hand-rolled parse of the remaining argv; no CLI framework is introduced.

Output is a short header line (name, and status or last updated where present) followed by the
document body as plain markdown, so it pipes into a pager. Color only when the existing
`colorEnabled` check passes. No pager, no markdown rendering, no box drawing.

## 7. Item six: the thinking indicator

The terminal is currently silent between the user pressing enter and the first token, for however
long that takes. There is no spinner, timer, or placeholder anywhere in the CLI.

### Mechanism

`AgentEvent` gains `{ type: 'thinking' }`, emitted at the start of every model round in `runTurn`
and in `greet`. Today's events are only `text`, `tool`, and `done`, which leaves no way to know the
model has resumed after a tool result.

A new `packages/cli/src/status.ts` holds a `StatusLine` with `start(label)` and `stop()`. It
writes a dim animated line through the existing `ChatIo.write` funnel using `\r` and `\x1b[K`,
advancing frames on an injected interval so tests drive it deterministically rather than waiting
on real timers.

### Rules

- Gated entirely on `colorEnabled`, which already means "stdout is a TTY and NO_COLOR is unset".
  When it is false the indicator is a complete no-op. This preserves the existing invariant, which
  a test asserts, that no escape sequence ever reaches a non-TTY stream.
- Never runs while `io.question()` is outstanding. Readline owns the cursor while the user is
  typing. The indicator starts only after `send()` or `greet()` begins and stops before any text,
  tool, or done output is written.
- Label is `thinking` on a `thinking` event, and the existing honest tool notice text
  (`remembering`, `reading memory`, `updating memory`) while a tool runs.
- After three seconds the label gains an elapsed-seconds counter, so a slow call looks slow rather
  than looking stuck.
- The permanent dim tool notice line still prints, so the record of what touched memory survives
  the animation disappearing. Honest disclosure outranks tidiness here.

## 8. Testing

Following AGENTS.md: TDD for deterministic logic, fixtures and schema assertions for anything
LLM-dependent, never golden text.

Deterministic, test first:

- `peopleDir` creation, person page write and read round-trip, slug collisions.
- Person node carries its `doc` path; `graph_query` returns a resolvable `docId`.
- Reflection materializes arcs and people directly and appends nothing to `proposals.jsonl`.
- Pre-existing pending proposals still surface and still resolve.
- `forget` appends retract records, rewrites documents atomically, rejects an empty body, and
  never writes to a transcript.
- **Narrative continuity**: two consecutive reflections over the same arc, asserting the second
  body still carries what the first established. This is the test whose absence hid the defect.
- Empty-session detection: a transcript with an assistant greeting and no user line is skipped and
  never retried.
- `recentSummaries` window and cap.
- The read command: matching, ambiguity, missing names, and that it never constructs a provider or
  opens the engine.
- `StatusLine` frame advance on an injected clock, and total silence when `colorEnabled` is false.

LLM-dependent, fixtures and schemas:

- Pass-two narrative rewrite: schema conformance, one-retry behavior, and that a failure leaves the
  existing document untouched.
- The greeting: that it produces an assistant transcript line, that a provider error produces no
  line at all, and that a timeout does not block session start.

## 9. Compatibility

The owner's memory folder predates this work, so:

- No existing file changes format. `people/` is additive and created on open.
- Pending proposals in existing folders still work end to end.
- `graph.jsonl` gains retract records, which the fold already handles correctly.
- `index.db` is derived, and `reverie reindex` rebuilds it including the new person kind.
- Sessions recorded before this release have no greeting line and reflect exactly as they do now.

## 10. Deferred to the roadmap

Recorded rather than built:

- Removing the proposal machinery once existing queues have drained.
- Extending `forget` to session summaries and the items inside them.
- A deterministic significance threshold for person pages, if LLM judgment proves too loose.
- Merging person aliases when the same human ends up with more than one node.
- Purging forgotten content from the memory folder's git history.
