# Commitments: bounded things the person means to do

Date: 2026-08-24. Status: approved by the owner on 2026-08-24, with the three decisions in Section 11.
Not yet planned or implemented.

## What this is

A new first-class memory entity for a bounded thing the person has said they mean to do, which can
later resolve. "I'm going to the Nightfall screening on Sunday." "I should file the tax paperwork."
"Come summer I want to start swimming again."

It is not a todo list, and the difference is not cosmetic. Sections 6 and 7 exist to make it
structurally impossible for this to become one.

## Why it needs to exist

The obvious pitch, that the companion should keep track of what you meant to do, is not the real
argument. The real argument is narrower and stronger.

Reflection already captures these. `ReflectionItem` has `kind: 'intention'` and a free-text
`eventTime`, and both reflection and the live `remember` tool populate them. Capture is not the
problem.

The problem is that an item is a fact, and a fact can only be appended. It has no identity, so it can
never be revised. The dogfooding memory folder holds, right now, four live and mutually contradictory
records of one cinema booking:

```
2026-08-18  Wants help picking an IMAX Westgate showtime for Nightfall on Fri Aug 21 with Arjun
2026-08-20  Friday's plan to see Nightfall with Arjun remains open and has not yet been confirmed
2026-08-20  Tickets are booked with Arjun for Nightfall on Sunday, 23 Aug 2026 at 7:20pm
2026-08-22  Nightfall showtime is booked for Sunday, Aug 23, 2026 at around 7:15 pm
```

Three of those are dead and nothing says so. All four are equally retrievable and equally ranked. On
2026-08-22 the companion opened a session by asking how a film had been, a day before the screening.

A thing with identity can be revised. A fact can only be appended. That is the whole case for this
feature, and it is enough on its own.

## 1. Scope: one entity, not three

The original framing was projects, plans, and tasks. This spec ships **one** entity type, called a
commitment.

**Task and plan are the same object.** A task with a time is a plan; a plan without a time is a task.
The difference people feel is real but it is not structural, and encoding it as two node types would
force every consumer (reflection prompt, retrieval, prompt assembly, the web record) to branch twice
for no behavioral difference. It is a `flavor` field on one entity, and even that exists only to
shape how the companion speaks about it, never to change how it is stored or selected.

**Project is deliberately not introduced.** `arcs/solo-business-build.md` is already a project
wearing an arc's clothes. Adding a project type means every reflection call must first answer "is
this an arc or a project", and that answer will be inconsistent across sessions, which is how an
ontology rots. The distinction people reach for is not long-running versus bounded, it is whether the
thing has a completion condition: an arc is a theme that never completes and can only go quiet, while
a project completes or is abandoned. If that turns out to matter, the cheap version is an optional
completion condition on arcs, not a sibling type. Revisit only after commitments have been used for
real.

## 2. The commitment record

A commitment is a graph node of type `commitment`. It carries:

- `label`: what the person means to do, in plain language.
- `flavor`: `errand` or `plan`, affecting tone only, never storage or selection.
- `timing`: absent, or the structure in Section 3.
- `waitsOn`: absent, or a graph edge, see Section 5.
- `state`: `open`, `done`, `dropped`, `unknown`, `quiet`. There is deliberately no state meaning
  overdue. See Section 6.
- `askedAt`: absent, or the date the companion asked about it once. See Section 6.
- `source`: the session and item this came from, so the testimony behind it is always reachable.

No new graph operations are required. The log has `assert` and `retract`, and `assert` on an existing
node id is the revision. Every version stays in `graph.jsonl`, so the history of how a commitment
changed is free and permanent, which is exactly what the four-line Nightfall mess above was missing.

Prose stays where it is. Session summaries keep recording what was said, as testimony. The commitment
node is the record. This is the existing rule in AGENTS.md, unchanged.

## 3. Time: what was stated, and what we think it means

This section amends the deferral in
[time as first class](2026-08-16-time-as-first-class-design.md) at lines 107 to 115 and 1026, which
ruled structured event-time resolution out of scope. That deferral was correct for that spec and is
narrowed here, deliberately and with sign-off, not silently.

### The invariant that makes this safe

> **The bracket selects. The gloss speaks.**
>
> A derived time bracket decides only whether a commitment is worth loading into the prompt. It is
> never rendered, never spoken, and never stated to the person. Everything the companion says about
> when a thing is supposed to happen comes from the person's own words and the written gloss.

The consequence is the point: a wrong bracket costs a slightly mistimed mention. It can never produce
a false statement, because nothing is ever said from it. That is what makes resolving vague time
acceptable at all, and it is the property to protect if anything in this design has to give.

### Three cases

**Stated absolutely, or unambiguously relative to a known anchor.** "August 23", "at 6:40pm",
"tomorrow", "tonight", "in three days", and a named weekday where the anchor removes the ambiguity
("Sunday", said on a Saturday). These resolve to a real window. The person's exact words are stored
alongside, always, and are never overwritten.

**Stated vaguely.** "Come summer", "next fall", "over the holidays", "after the rains", "sometime in
the coming week". These do **not** resolve to a date. Instead the companion that heard it writes a
gloss: a short sentence recording what was said, when it was said, and what it plausibly means for
this person in the place they live. Alongside the gloss sits a coarse bracket, internal only, subject
to the invariant above.

The gloss must be written by a model that has read `profile.md`, because this is geography, not
arithmetic. Summer in Bangalore runs roughly February to May. A hardcoded season table would be wrong
for this project's own first user, which is the clearest possible argument that the interpretation
has to be written rather than computed.

**Not stated at all.** "Someday", "at some point", "I should really". No timing, no bracket. Surfaced
only when the conversation touches the subject, never by the calendar.

### The taxonomy this has to cover

| Kind | Examples | Treatment |
|---|---|---|
| Absolute | "August 23", "at 6:40pm" | Resolve |
| Deictic | "tomorrow", "tonight", "in three days" | Resolve against the anchor |
| Named weekday | "Sunday", "this Friday" | Resolve only when the anchor disambiguates. "Next Friday" is genuinely ambiguous in English and must not be resolved |
| Deadline shaped | "by Friday", "before month end" | A range ending at a point, not a point. Distinct from "on Friday" |
| Seasonal or period | "come summer", "after the rains" | Gloss plus bracket |
| Event anchored | "after the wedding", "once the app ships" | Section 5 |
| Open ended | "someday", "at some point" | No timing, no bracket |
| Recurring | "every Sunday", "workout daily" | Out of scope, Section 10 |

### Two fields, not one

An earlier draft proposed a single `precision` label. That was wrong: it conflates how precisely the
person spoke with how confident we are in our reading of it. Those come apart. "Come summer" is vague
but our bracket for it may be quite good. "Next Friday" sounds precise and our bracket for it is a
coin flip. So:

- `statedPrecision`: how precisely the person expressed it. A property of their words.
- `interpretationConfidence`: how sure the gloss's bracket is. A property of our reading.

And one explicit marker recording whether the window was **stated** or **interpreted**. Without it, a
model six months from now reads a bracket and cannot tell whether the person said "February to May"
or whether an earlier model guessed it. That marker is the difference between a record and a rumour.

### Re-glossing

"Next summer", said in August 2026, means summer 2027. As that approaches, a later model may append a
new interpretation carrying its own date and reasoning. The original gloss is testimony and is
**never rewritten**, matching the append-only discipline the graph log already has. What was
understood, and when, stays legible.

## 4. Selection: how something surfaces at the right moment

A commitment becomes eligible to enter the session prompt when today falls within its bracket, or
within a lead time before it.

**Lead time scales with vagueness.** A day-precision commitment becomes eligible the day of. A
season-precision commitment becomes eligible weeks out. This is the right shape rather than a
convenience: something mentioned vaguely deserves an early, low-pressure mention, not a punctual one.
"You said you wanted to start swimming come summer, how are you feeling about that" is a good
sentence in April and a strange one on a specific Tuesday.

Eligibility is capped like every other prompt section in this codebase, and the cap is stated in the
same style as `RECENT_INTENTIONS_SECTION_CAP` and its siblings.

## 5. Event-anchored commitments

"After the wedding." "Once the app ships." "When Arjun visits." These have no time component at all,
and inventing one would be a lie.

The honest representation is a graph edge: the commitment `waitsOn` another node, which usually
already exists. The graph is already there and already does this. A commitment that waits on
something is not eligible for time-based surfacing at all. It becomes eligible only once the thing it
waits on is recorded as having happened.

This also gives the right behavior for free: the companion notices the wedding happened, and only
then does the commitment behind it become live.

## 6. The anti-taskmaster guarantees

These are structural. Prompt text alone will fail at this, because prompt text is advice and a model
having a chatty day will talk past it.

**There is no overdue state, anywhere in the schema.** Not a field, not a computed property, not a
derived flag. If the data cannot express "you failed to do this", nothing downstream can render it,
and no future prompt can nag from it. A commitment whose window has passed with no outcome is not
late. It is simply unresolved, which is an ordinary and unjudged condition.

**One ask, then permanent silence.** A commitment whose window has passed with no recorded outcome
becomes eligible for exactly one natural follow-up. Asking it sets `askedAt`. It is never raised
again and resolves to `unknown`. The marker lives in the data precisely so it survives across
sessions and cannot be relitigated.

**Never volunteered as a list.** Commitments inform what the companion says. They are never
enumerated at the person. This is the rule the greeting already enforces ("Never open with a list.
Never summarize the record.") and it extends here unchanged. If the person wants the list, it is in
the browser's Record section, where they went looking for it deliberately.

**The person can mark a thing quiet.** An explicit way to say stop tracking this, honored
permanently, with no follow-up question about why. State becomes `quiet` and nothing surfaces it
again.

Note that these rules would also have prevented the observed failure directly. With a window of
23 August, "did you end up going" is not eligible to be asked on 22 August at all.

## 7. Capture: two channels, and the second is the one that must work

**Live, during conversation**, when the person says they mean to do something. This is the
responsive path and it is the one that feels good.

**Reflection, at session end**, as the backstop. This is the one that must work, because live tool
calls are not guaranteed. The finding recorded in ROADMAP.md is exactly this: a chat model can be
swapped and quietly stop calling tools, with no error and no visible symptom. A commitment system
that exists only on the live path is one model swap away from silently capturing nothing. Reflection
attaches no tools and is unaffected, so reflection must be able to create and revise commitments on
its own, from the transcript, whether or not the live tool was ever called.

Both paths write the same record through the same code. Where the live path and reflection disagree
about the same commitment, reflection wins, because it has read the whole session rather than one
turn of it.

**Decided: extend `remember`, do not add a sibling tool.** `toolDefinitions()` already returns
thirteen tools on every round of every session, and ROADMAP.md already carries an item noting that
tool exposure is gated by prompt text rather than by code. A fourteenth tool makes that worse, and
`remember` is a path the model already reaches for.

The condition on that decision matters more than the decision. **Extending must not flatten the
operation.** A commitment is not an item with an extra string on it, and the tool must not degrade
into one. Specifically:

- The commitment-shaped fields are real, distinct parameters, not overloaded prose in `text`:
  `flavor`, the stated timing wording, the gloss, the waits-on reference, and the resolution being
  recorded. A model that packs "by Friday" into the free-text label has produced an item, not a
  commitment, and the schema should make that hard rather than merely discouraged.
- Recording a commitment, revising one, and resolving one are three different operations, and they
  stay three distinguishable operations at the boundary. Revising must reference the commitment being
  revised. Resolving must name an outcome. Neither can be expressed as "remember this new fact",
  because that is exactly the flattening that produced four contradictory Nightfall records.
- Validation is per-shape. A commitment payload is validated against the commitment schema at the
  zod boundary, not against a loosened union that accepts anything an item would accept. If the
  combined schema starts needing optional-everything to typecheck, that is the signal the extension
  has flattened and should be revisited.

The tool description carries the distinction in plain language, since the model chooses the shape.

## 8. What the person sees

The CLI surfaces nothing new by default. Commitments change what the companion knows and therefore
what it says, which is the entire intended effect.

The browser's Record section gains a commitments view: what is open, what resolved, what is quiet. It
is read-only in this round, consistent with how the Journal tab shipped. It is the deliberate place
to go looking, and it is the only place a list ever appears.

## 9. Testing

- Deterministic logic gets TDD: the record, the state transitions, selection and lead time, the
  waits-on edge, the append-only revision behavior.
- Resolution of stated time is deterministic and gets a real table of cases, including the ones that
  must **not** resolve. "Next Friday" not resolving is a test, not an omission.
- Gloss writing is LLM-dependent and is tested with fixture transcripts and schema assertions, never
  golden text, per AGENTS.md.
- The anti-taskmaster guarantees get explicit tests. In particular: that no code path can produce an
  overdue state, and that a commitment with `askedAt` set is never selected again. Falsify these
  rather than reading them.

## 10. Out of scope

- **Projects.** Section 1. Revisit after commitments have been used.
- **Recurring commitments.** "Every Sunday", "workout daily". A different shape that needs its own
  thinking. A single commitment is not the right container.
- **Duration and effort.** "It will take a couple of weeks" is not a when.
- **Notifications or reminders of any kind.** Nothing in this project reaches out. The companion
  speaks when a session opens, and that is the only channel.
- **Editing commitments from the browser.** Read-only this round.
- **A page for a commitment.** Decided against for this round, Section 11, and worth revisiting. A
  commitment that keeps being revised over months, gathering context each time, starts to look like
  the thing arcs and people earn a page for. The trigger to reconsider is seeing that happen in real
  use, not deciding it in advance.

## 11. Decisions, resolved 2026-08-24

1. **Extend `remember`, do not add a sibling tool.** With the anti-flattening conditions stated in
   full at the end of Section 7. Those conditions are part of the decision, not commentary on it.
2. **No page for a commitment in this round.** Arcs and people earn pages once they recur or clearly
   matter, and a commitment revised repeatedly over months is a plausible future candidate. It is
   easy to add later and awkward to remove, so it is recorded in Section 10 as a future addition
   rather than built now.
3. **No backfill from existing `intention` items.** They stay exactly as they are, as testimony.
   Commitments populate from this release forward. There is no reliable way to know which of the four
   Nightfall lines was live at any given moment, and a guess presented as a record is worse than an
   honest gap. This is the same reasoning the time spec used when it declined to backfill
   `utcOffsetMinutes` onto existing transcript lines.

## Relationship to the recall fixes

[The recall and event time fixes](../plans/2026-08-24-recall-and-event-time-fixes.md) are the
foundation and land first. Defect 4 in that plan, which gives the prompt a rule that a recorded
intention is not evidence something happened, is a stopgap that this design eventually replaces with
something real. Nothing is wasted: reviving the keyword lane, returning chunk-level results, and
putting dates on search hits are prerequisites either way.
