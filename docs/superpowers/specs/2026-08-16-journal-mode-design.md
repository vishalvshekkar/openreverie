# Journal mode design

Date: 2026-08-16
Status: proposal, written for review
Target release: TBD, after the two companion specs below land

This specification depends on two companion specs being written in parallel and does not
redefine what they own:

- **2026-08-16-time-as-first-class-design.md** owns the EVENT TIME vs RECORD TIME model, local
  day boundaries, `profile.md`, and the `reverie migrate` registry. This spec uses that
  vocabulary (entry date is event time, recorded-at is record time) and assumes local day
  boundaries are available to compute "today" for a journal entry, rather than the UTC-only
  `formatDateUTC` helper `MemoryEngine.sessionContext` uses today.
- **2026-08-16-modes-profile-settings-design.md** owns per-session MODES, the `set_mode` tool,
  the `/mode` slash command, the status line, and web settings. This spec assumes a `journal`
  mode value exists there and depends on two things that spec's own patches are adding: a
  session's mode persisted to disk at `startSession` time, not held only in the live process's
  memory, so a crash before `endSession` does not lose it (section 11); and a structural
  `synthetic` marker on a `TranscriptLine`, so the `/mode <name>` line that spec synthesizes on
  the person's behalf can be told apart from a line the person actually typed (section 11). Where
  this spec needs that plumbing, it says so and treats the exact mechanism as the modes spec's
  responsibility.

## 1. Problem statement

Reverie already remembers what a person says about their life in conversation. Journal mode is
a different act: the person sits down specifically to write, often about themselves rather than
to a companion, using one of a handful of methods that either have research behind them or
don't. Two things are missing today.

First, there is no first-class place to keep what someone writes as the entry itself, in their
own words, separate from the mined, third-person items and summaries reflection already
produces from any session. A gratitude entry, a page of stream-of-consciousness, a completed
thought record: these are documents a person may want to open and reread as what they wrote,
not as what the model extracted from what they wrote.

Second, there is no protocol for how journaling should run: which method, what prompts, how
long, how often, how active the companion should be while it happens. Today every session runs
through the same companion persona with no notion that a person specifically wants to journal
right now, and no memory of what they decided about journaling the last time they set it up.

Journal mode is a session mode (see the modes spec) that, when active, has the companion lead a
structured or open journaling session using a method the person chose, write the result to a
new `journal/` directory as a first-class document, and follow safety rules specific to what
each method can do to someone.

## 2. The `journal/` directory

### 2.1 Location and file naming

`journal/` sits at the memory folder root, alongside `realms/`, `arcs/`, `people/`, `sessions/`,
`rollups/`. `MemoryPaths` (`packages/memory/src/paths.ts`) gains a `journalDir` field, and
`ensureMemoryTree` creates it the same way it creates the other five directories today.

`journal/` holds entries and nothing else: no index file, no per-method subfolders. One markdown
file per entry, named:

```
journal/<entryDate>-<ulid>.md
```

`entryDate` is `YYYY-MM-DD`. The ulid suffix guarantees uniqueness on days with more than one
entry and keeps a directory listing sorted in write order within a day, matching the existing
`sessions/<date>-<sessionId>` convention. No slug: unlike an arc or a person, a journal entry has
no name of its own to slugify.

### 2.2 Frontmatter schema

```yaml
id: doc_<ulid>          # newId('doc'), same id space every other document uses
kind: journal
method: expressive_writing | gratitude | examen | thought_record | morning_pages | open
mode: journal            # the session mode active when this entry was written; carried for
                          # forward compatibility if journal-style writing is ever reachable
                          # from a mode other than journal itself
entryDate: 2026-08-16     # event time: the date this entry is ABOUT
recordedAt: 2026-08-16T21:04:00.000Z   # record time: when it was actually written
session: session_<ulid>  # the session this entry came from, same field name and meaning as
                          # summary.md's own `session` key
```

`id`, `kind`, `method`, `entryDate`, `recordedAt`, and `session` are required. No new
`IdPrefix` is needed in `documents.ts`: journal entries are documents like any other and use
`newId('doc')`, the same as arcs, person pages, and session summaries.

Body: the entry itself, in the person's own words wherever the method calls for that (expressive
writing, morning pages, open format, the gratitude list, the examen's own answers, the thought
record's filled-in fields). See section 11 for how the body is assembled for each method.

### 2.3 Atomic writes

Journal entries are written with `writeDocumentAtomic` (`packages/memory/src/documents.ts`),
temp file then rename, the same as every other prose document in the folder. A journal entry is
never edited in place after it is written; if the person wants to add to an entry later, that is
a new entry, not a rewrite of an old one. This matches the treatment of transcripts and session
summaries: what someone actually wrote or said on a given day does not get silently revised by a
later pass.

## 3. Why entryDate and recordedAt are separate

A journal entry written live, today, has `entryDate` equal to today's local date and
`recordedAt` equal to the moment the session ended. In live use the two are always the same
calendar day; the split earns nothing yet.

It earns something the moment import exists. Import itself is explicitly deferred (see section
14), but the reason this split is in the schema now, not added later, is that adding it later
means migrating every entry already on disk, and the modes/time specs already establish that
migrations go through a registry (`reverie migrate`, owned by the time-as-first-class spec) that
this project would rather not lean on for a distinction this cheap to get right up front.

Concretely, when journal or note import ships: a person imports a page from a paper journal or a
Day One export dated March 2019. The importer sets `entryDate: 2019-03-14` (from whatever date
the source carries) and `recordedAt` to the actual import timestamp, today. Every place that
reads a journal entry, and every place that reasons about the person's life from it (reflection,
retrieval, the atlas), must read `entryDate` to place the entry in the person's life and must
never assume `entryDate` and `recordedAt` are the same day. This spec does not build an importer.
It builds the field split and writes down the rule so nothing built between now and import
implicitly assumes same-day, which is the mistake this split exists to prevent.

## 4. journaling.md

### 4.1 Location and role

`journaling.md` lives at the memory folder root, beside `constitution.md` and `profile.md`
(the latter owned by the time-as-first-class spec). It is not inside `journal/`; `journal/` holds
entries only. `MemoryPaths` (`packages/memory/src/paths.ts`) gains a `journaling` field, joining
`constitution`, pointing at `<root>/journaling.md`. Unlike `constitution`, this path is **not**
created by `ensureMemoryTree`: `journaling.md` does not exist on disk until the first-time setup
conversation in section 7 concludes and writes it in full (section 4.3). This is a deliberate
difference from the constitution, which is always seeded with `CONSTITUTION_STARTER` so it always
exists, because a person who never journals should never accumulate a root-level file for a
feature they have not touched.

`journaling.md` is a protocol document on the constitution pattern: written with
the person the first time they journal, revised by the person asking the agent to change it
mid-session or at the start of a later one (section 4.5 specifies the mechanism concretely), and
read at the start of every journal-mode session after that (section 4.4 specifies the loading path
concretely).

It is prose, not structured config, for the same reason the constitution is prose: it is meant
to be read by the model as context and by the person as a plain description of what they asked
for, not parsed as a settings object. It is a normal `Document` (frontmatter plus markdown body),
written with `writeDocumentAtomic`, indexed like the constitution is (`DocKind` gains
`'journaling'`, alongside the existing `'constitution' | 'realm' | 'arc' | 'summary' |
'rollup_daily' | 'rollup_weekly' | 'person'` in `packages/memory/src/sqlite.ts`), and reindexed
whenever it is rewritten, the same way `_doEndSession` reindexes the constitution when
`constitutionUpdate` is non-null.

### 4.2 Schema

Frontmatter:

```yaml
id: doc_<ulid>
kind: journaling
updated: 2026-08-16T21:04:00.000Z
```

Body, free-form prose, expected to cover in practice (not enforced by a schema, since this is a
document a person can hand-edit like the constitution):

- Chosen method or methods, and for each, the cadence agreed on (see section 6).
- The prompt sequence for that method if not freeform, or an explicit statement that the person
  wants freeform.
- What they said they want out of journaling (processing something specific, a daily habit, just
  a place to think out loud).
- Rough session length they are comfortable with.
- **Agent activity level**: how active the companion should be during a journal session. See
  section 8 for the axis and how it differs from `style.engagement`.

### 4.3 Creation

`journaling.md` does not exist until the first time the person wants to journal, full stop: there
is no pre-seeded starter body, unlike the constitution. Its absence on disk is exactly what tells
the companion a first-time setup conversation is owed, described in section 7. Once that
conversation ends, the companion writes `journaling.md` in full, through the mechanism section 4.5
specifies, the same way reflection writes a constitution update: this is not a form with fields to
fill in, it is a document written from what was actually said. There is no intermediate state
where the file exists but is empty; a memory folder either has no `journaling.md` yet (nobody has
journaled) or has one written from a real setup conversation.

### 4.4 Loading into the prompt

This is the mechanism section 4.1 promises and the piece that was missing from the first draft of
this spec: without it, `journaling.md` is written and indexed but nothing ever puts it in front of
the model, which defeats the file's entire purpose.

The modes spec (section 9.2 there) widens `assembleSystemPrompt` (`packages/core/src/context.ts`)
and `buildPersona` (`packages/core/src/personas.ts`) to take the session's active mode. This spec
uses that: when `assembleSystemPrompt` is called with `mode === 'journal'`, it asks
`MemoryEngine` for the journaling protocol alongside the rest of session context, on the exact
pattern the constitution already uses (`context.ts:67-71` for the render, `engine.ts`'s
`sessionContext` for the read).

Concretely:

- `MemoryEngine.sessionContext` (`packages/memory/src/engine.ts:526`) gains a second, optional
  parameter: `sessionContext(now = new Date(), mode?: ModeName)`. The one production call site
  (`context.ts`'s `assembleSystemPrompt`) passes the mode it was itself called with; every other
  existing caller and every existing test keeps compiling unchanged, since the parameter is
  optional and defaults to no mode at all.
- `SessionContext` gains one field: `journalingProtocol: string | undefined`.
- When `mode !== 'journal'`, `journalingProtocol` stays `undefined` and `sessionContext` never
  reads `paths.journaling` at all. A session that never touches journal mode pays no extra file
  read for this, ever.
- When `mode === 'journal'`, `sessionContext` attempts `readDocument(this.paths.journaling)`:
  - **File exists**: `journalingProtocol` holds the document's trimmed body.
  - **File does not exist** (the first-ever journal-mode session for this memory folder, per
    section 4.3): `journalingProtocol` holds a fixed constant, not an ad hoc string assembled per
    call, so its wording cannot drift between call sites:

    ```
    const JOURNALING_PROTOCOL_ABSENT =
      "journaling.md does not exist yet: this person has never set up journal mode before. " +
      "Run the first-time setup conversation before beginning any method (see the journal mode " +
      "spec, section 7), and once it concludes, write journaling.md in full."
    ```

    Any other read failure (a permissions error, a corrupt file) is not caught here and propagates
    the way any other document-read failure in `sessionContext` already does; only the specific
    "file does not exist" case is handled, because that is the one case this spec defines a
    meaning for.
- `context.ts` gains `journalingProtocolSection(context)`, the same optional-section pattern as
  `constitutionSection`: returns `undefined` when `context.journalingProtocol` is `undefined`
  (which covers both "mode was not journal" and any future case where the field is intentionally
  absent), otherwise returns `` `## Journaling protocol\n\n${context.journalingProtocol}` ``. It is
  inserted into the `sections` array in `assembleSystemPrompt` immediately after
  `constitutionSection`, since both are identity-and-protocol documents read the same way and
  belong in the same part of the prompt.
- The first-conversation branch (`context.ts`, `if (context.isFirstSession)`) is unaffected and
  renders no journaling section: onboarding takes over regardless of a chosen mode, and
  `journaling.md` cannot exist yet on someone's literal first-ever session with reverie.

### 4.5 Revision

The person can ask to change anything in `journaling.md` at any point, inside a journal session
or outside one ("let's switch to the examen instead," "actually make gratitude three times a
week instead of daily," "stop suggesting prompts, I want it fully freeform now"). This spec owns
the rewrite mechanism, not an implementation plan following it, because a mechanism that is not
specified here is exactly how section 4.1's loading path went unbuilt in the first draft.

**Both a live tool and a reflection field, mirroring the modes spec's own resolution of the same
tension.** The modes spec (section 3.3 there) gives the profile a live `update_profile` tool for
facts learned in conversation, "for the same reason `remember` exists: a fact learned in
conversation is written when it is learned, not held until the session ends," with reflection's
`profileUpdates` as the backstop for whatever the live path missed. `journaling.md` has the exact
same shape of problem, so it gets the exact same shape of answer:

- **Live tool, `update_journaling_protocol(body: string)`.** Available in every session,
  regardless of the active mode: the person can ask to change their journaling setup from an
  ordinary conversation too, per the "inside a journal session or outside one" requirement above.
  Its description tells the model to call it with the complete new document body (full prose, a
  whole rewrite, never a diff or an append, matching the "never edited in place" rule journal
  entries themselves follow in section 2.3) only after an actual conversation about what changed,
  the same way the first-time setup conversation in section 7 is a conversation and not a form.
  Dispatch reads the existing `journaling.md` if present (to preserve its `id`) or mints a new
  `newId('doc')` if this call is itself the write that concludes a first-time setup conversation,
  writes the full body with `writeDocumentAtomic`, sets `updated` to the current time, and
  reindexes it (`reindexOrWarn(doc, 'journaling', ...)`) so search stays current. It then calls the
  session's `refreshSystemPrompt()` (introduced by the modes spec, section 9.2 there), the same way
  `/style` already does, so a rewrite made mid-journal-session takes effect on the very next turn
  instead of waiting for a session that has not started yet. This is why a live tool is required at
  all and a reflection field alone would not do: `journaling.md` is loaded once, at session start
  (section 4.4), and `refreshSystemPrompt()` is the only mechanism that makes a mid-session rewrite
  visible to the model before that same session ends.
- **Reflection field, `journalingUpdate: string | null`.** Added to `ReflectionOutput` and
  `reflectionOutputSchema` alongside `constitutionUpdate`, same shape and same meaning: `null` when
  nothing changed, otherwise the full new document body. Written at end-of-session on exactly the
  pattern `constitutionUpdate` already uses in `resolveNarratives` (`reflection.ts`: read the
  existing document to preserve its `id`, or mint one if none exists yet, replace the body, write).
  This is the backstop, not the primary path, for a session where the person clearly renegotiated
  their journaling setup in conversation but the model never called `update_journaling_protocol`
  for it; it cannot substitute for the live tool because a session-end-only write can never affect
  how the rest of that same session is conducted. Reflection's prompt gains a read of the current
  `journaling.md` content, or its absence, as its own context, on the same pattern reflection
  already sees the constitution and known people (`reflection.ts:209-224`), so it can propose an
  update only when there is a real reason to and can tell "not yet set up" apart from "already
  correct."

Both surfaces write through the same small helper (read-existing-id-or-mint-one, replace body,
`writeDocumentAtomic`) rather than duplicating that logic twice, on the same "generalize, don't
fork" instinct the constitution-write pattern already follows for the reflection path. What this
spec fixes, concretely, is that the rewrite is always a full, atomic rewrite of the document, on
the constitution's own pattern, never a diff or an append, from either surface.

## 5. The six formats

Evidence levels below are stated as found; where evidence is thin or absent, the spec says so
directly and the product must say so directly too, per section 7 and the honesty requirement in
`AGENTS.md`.

### 5.1 Expressive Writing (Pennebaker)

**Evidence**: the best evidenced of the six. Over 200 studies and multiple meta-analyses
(Frattaroli 2006; Baikie & Wilhelm 2005) show a real but modest average effect (around d = 0.16),
with meaningful heterogeneity across studies and populations. Pennebaker's own 2018 retrospective
notes limits in clinical populations. Read as: real, replicated, small on average, not a cure.

**Structure**: write continuously for 15 to 20 minutes on the same difficult topic, across 4
consecutive days. Include facts, thoughts, and feelings about it. Ignore grammar and spelling
entirely; this is not for anyone else to read.

**Shippable prompt sequence** (day 1 of 4, repeated with the same topic reconfirmed each day):

1. "What's something that's been weighing on you that you haven't fully let yourself think
   through? Write about it for the next 15 to 20 minutes: what happened, what you think about it,
   and how it makes you feel. Don't worry about grammar or whether it makes sense to anyone else.
   Just keep writing."
2. On days 2 to 4: "Same topic as before. Write again, for the same length of time. It's fine if
   today's version says something different than yesterday's."
3. Closing prompt on every day, mandatory (see the safety gate in section 10): "Before we stop,
   take a breath. What's one small, true thing that's okay right now, even next to all of that?"

### 5.2 Gratitude (Emmons & McCullough)

**Evidence**: well replicated, modest effect (g roughly 0.19 to 0.22). The original 2003 study
used **weekly** journaling, not daily. A 2025 meta-analysis (Choi, McCullough & Oishi; 145
studies, 24,000+ participants) found that 3 to 4 times a week outperforms daily practice, and
attributes this to a "wallpaper effect" where daily repetition of the same kind of entry stops
registering emotionally. The product must not let someone silently default to daily gratitude
journaling without being told the evidence points the other way. See section 6.

**Structure**: list a small number of things (3 is typical) the person is grateful for, with
enough specificity to be more than a label.

**Shippable prompt sequence**:

1. "What are a few things from the last few days that you're genuinely glad happened, big or
   small?"
2. For each one raised, one light follow-up, only if it feels natural, not mechanically for
   every item: "What made that one land for you?"
3. No closing prompt required; gratitude entries are typically short and low-risk (see section 10).

### 5.3 Daily Examen (secularized)

**Evidence**: thin but suggestive. One small RCT (n = 57 students, a 2-week secularized version)
found gains in meaning in life, life satisfaction, and hope. That is one study, small, on a
specific population; it is not the evidence base expressive writing or gratitude have. Say so
plainly rather than borrowing gratitude's or CBT's weight for it.

**Structure**: five steps, in order: notice how you feel right now; review the day with
gratitude; notice one moment that stirred strong emotion; reflect on what that moment is telling
you; look to tomorrow with intention.

This is the method whose structure best matches a conversational agent: it is a fixed question
sequence, not a blank page, which is exactly the shape a turn-based conversation already knows
how to run. It is the recommended default suggestion in the first-time setup conversation for
that reason, stated as a suggestion, not a default silently applied (section 7).

**Shippable prompt sequence**:

1. "Before we look back at the day, just notice: how are you feeling right now, in this moment?"
2. "Walking back through today, what are you grateful for, even something small?"
3. "Was there a moment today that stirred something strong in you, good or hard?" (skippable with
   no pressure to resolve it; see section 10)
4. "What do you think that moment is telling you?" (only asked if step 3 surfaced something)
5. "Looking ahead to tomorrow, is there anything you want to carry into it, or set an intention
   about?"

### 5.4 CBT Thought Record (Beck)

**Evidence**: CBT as a whole has an enormous evidence base across decades and populations. The
thought record specifically, used in isolation from the rest of a CBT course or a therapist, is
thinly studied on its own. The product should say the general claim (CBT is well evidenced) and
the specific one (this worksheet in isolation is not separately validated) rather than letting
the general claim imply the specific one.

**Structure**: situation; emotion and its intensity (0 to 100); the automatic thought; evidence
for it; evidence against it; a more balanced alternative thought; re-rate the emotion.

**Shippable prompt sequence**:

1. "What's the situation you want to look at?"
2. "What did you feel in that moment, and how strong was it, from 0 to 100?"
3. "What was the thought that went through your mind right then?"
4. "What's the evidence that thought is true?"
5. "What's the evidence against it, or that complicates it?"
6. "Given both sides, is there a more balanced way to put it?" **Must accept "I can't find one
   yet" as a valid, complete answer.** See section 10: forcing a positive reframe is a known
   failure mode and is explicitly disallowed.
7. "If you re-rate that original feeling now, where is it, 0 to 100?" (only if the person found
   an alternative thought to hold; skip if step 6 ended in "I can't find one yet")

### 5.5 Morning Pages (Julia Cameron)

**Evidence**: none. No clinical studies. Widely practiced, popular, part of a specific creative
recovery tradition (The Artist's Way, 1992), but unstudied. State this as "widely loved, never
studied," not as a lesser version of the other methods, and not silently omit the absence of
evidence.

**Structure**: three pages, stream of consciousness, no editing, done first thing in the morning,
20 to 40 minutes.

**Shippable prompt sequence**: minimal by design, since the method's whole premise is
unstructured writing.

1. "Whenever you're ready, just start writing. Doesn't need to go anywhere, doesn't need to make
   sense. Three pages or however long feels right."
2. No follow-up prompts during the session; the companion's activity level here should default
   toward the "hang back" end of the axis in section 8 regardless of the person's general
   setting, since prompting during morning pages works against the method's own premise.
3. No closing prompt required, but see section 10: unprompted writing can surface heavy material
   unexpectedly, and the normal crisis pathway applies exactly as it would in any conversation.

### 5.6 Open format

**Evidence**: not applicable; this is not a method with a research question attached to it, it is
the absence of one.

**Structure**: none. The person asked for exactly this: "I don't know, I just want to record
thoughts." It differs from Morning Pages in that Morning Pages carries ritual constraints (three
pages, morning, no editing); open format carries none of that.

**Shippable prompt sequence**:

1. "Go ahead, write whatever's on your mind." No structure offered unless asked for.

## 6. Cadence proposal behavior

Each method above has a cadence the evidence supports where evidence exists (weekly for
gratitude in the original study, 3 to 4 times a week per the 2025 meta-analysis; daily is
traditional for morning pages but carries no evidence either way; expressive writing is a bounded
4-day arc, not an ongoing cadence; the examen and open format carry no cadence evidence at all).

The setup conversation (section 7) proposes the research-backed cadence for whichever method the
person leans toward, then asks whether they want it more or less often. If the person chooses a
cadence the evidence argues against (daily gratitude, most notably), the companion says so once,
plainly, in the same conversation: something like "worth knowing, the research on gratitude
journaling actually found three to four times a week works better than daily, people seem to
stop really feeling it once it's an everyday thing. Totally fine if you still want daily, just
didn't want you picking it without knowing that." Then it accepts whatever the person decides.
This is a single, honest disclosure, not a recurring nag: `journaling.md` records the cadence the
person actually chose, and nothing in the ongoing journal session behavior revisits this
disclosure once it has been made.

## 7. First-time setup conversation

Triggered when the person first wants to journal and `journaling.md` does not yet exist, or
still holds its starter body. This is a conversation the companion has, in journal mode or on the
way into it, not a form. In rough order:

1. Ask what they're hoping to get out of journaling right now (processing something specific,
   building a regular habit, a place to think without an audience). This shapes which method to
   suggest, not a required first question with a fixed script.
2. Briefly explain the choices, in plain terms, with the evidence stated honestly per section 5:
   not six equally-weighted bullet points recited in a row, but a short conversational pass that
   names the options and is honest about which are well studied (expressive writing, gratitude),
   which are thin but suggestive (the examen), which are well-evidenced as a broader practice but
   not validated in isolation (the thought record), and which are unstudied (morning pages), plus
   the open option with no structure at all.
3. Make a suggestion based on what they said in step 1. The examen is the reasonable default
   suggestion when nothing in step 1 points elsewhere, because its fixed question sequence suits
   a conversational agent best; expressive writing when they specifically want to process
   something difficult (after the safety gate in section 10 is confirmed clear); gratitude when
   they want a lighter regular practice; morning pages or open format when they say, in effect,
   "I just want to write" with no interest in structure.
4. Ask whether they want prompts (a guided sequence) or freeform, if not already implied by the
   method chosen.
5. Propose the cadence per section 6, and adjust to what they want.
6. Ask roughly how long they want sessions to run.
7. Ask, directly or by reading the shape of the conversation so far, how active they want the
   companion to be during a session: prompting and pushing gently, or mostly staying quiet and
   letting them write. This becomes the agent activity level in `journaling.md` (section 8).
8. Write the result to `journaling.md` in full prose, not a bullet list of settings.

This avoids feeling like a form because none of these are separate questions fired in sequence
with no acknowledgment; the companion responds to what the person actually says at each step
before moving to the next, and steps can merge naturally (a person who says "I want to process
something from last year that's been sitting with me" has effectively answered steps 1 and 3 in
one breath, and the companion should recognize that rather than asking a redundant question). The
gate in section 10 for expressive writing still applies regardless of how naturally the
conversation flows to it.

## 8. Agent activity level

`journaling.md` carries an axis, separate from and orthogonal to the existing global
`style.engagement` setting (`packages/core/src/config.ts`), for how active the companion should
be specifically during a journal session.

**Why separate**: `style.engagement` (leading, balanced, following) governs the companion's
general posture across ordinary conversation, where "leading" means proactively raising threads
the person has not brought up. Journal mode is structurally different even when the companion is
guided by a fixed prompt sequence (the examen, the thought record): the point of a journal entry
is the person's own writing, not a dialogue, so "leading" behavior here does not mean raising
unrelated threads, it means how much the companion nudges within the chosen method itself. A
person who is generally a "leading"-engagement conversationalist outside journal mode may still
want the companion to go quiet once they start expressive writing, and a "following"-engagement
person may still want firm prompting through the examen's five steps. Collapsing this into
`style.engagement` would force one global setting to do two jobs that pull in different
directions for the same person.

**Values**, stored as prose in `journaling.md`, not a new enum in `config.ts` (this setting is
per-method and revisable by conversation, which is exactly what `journaling.md` as a document is
for, not what a global TOML config field is for):

- **Active**: the companion prompts through the chosen sequence, follows up on what's written
  with genuine curiosity, and gently pushes deeper when the person seems to be skimming the
  surface of something.
- **Hang back**: the companion offers the opening prompt (or nothing, for morning pages and open
  format) and otherwise stays quiet, checking in only if the person seems to want a response or
  seems to have stopped.
- A person can also set this per method rather than once globally ("push me on the thought record
  but leave me alone during morning pages"), since `journaling.md` is free prose and can express
  that distinction; the schema does not force a single value.

## 9. Session conduct

The companion prompts through the chosen method's sequence (section 5) but does not march through
it as a checklist. It tracks, for the duration of the session, which prompts in the sequence have
been covered (a straightforward in-session tally, not a persisted document field: this is
conversational bookkeeping for the current session, not durable memory) and raises an uncovered
one as the session winds down rather than interrogating the person up front with every question
before they've had room to answer the first one.

The companion backs off when it senses resistance (short answers, a change of subject, an
explicit "I don't want to get into that") or when the person says they're done. Backing off means
moving toward closing the session, not repeating the same prompt more gently. Winding down
follows the pattern above: if prompts remain uncovered and the person still seems willing, they
get raised once, plainly, framed as optional ("there's one more thing in the usual sequence if
you want it, or we can leave it there today").

## 10. Safety gates, per method

Existing safety modes (companion and firewall) always win. Journal mode must never weaken or
bypass crisis behavior; the crisis detection and stance text in `packages/core/src/personas.ts`
(`CRISIS_DETECTION`, `COMPANION_CRISIS_STANCE`, `FIREWALL_CRISIS_STANCE`, and the
`CRISIS_OUTRANKS_TONE` rule that style preferences yield entirely to the active safety mode) is
unmodified by this spec and applies inside a journal session exactly as it does in any other
conversation. This is a hard requirement per `AGENTS.md`, and section 13 specifies a test for it.

Per method:

- **Expressive writing**: gated before it can be offered or selected. Documented short-term harm
  is real: it reliably raises negative affect and physiological arousal before benefit appears,
  in the research literature itself, not a hypothetical risk. The gate:
  - Before offering expressive writing as a choice, or before starting a session using it, the
    companion checks for active crisis or suicidality in the current context (recent
    conversation, not a separate screening form) using the same judgment-based detection
    `CRISIS_DETECTION` already describes, not a keyword scan. If that judgment says the person is
    in crisis territory right now, expressive writing is not offered, and the active safety mode's
    normal crisis stance takes over instead.
  - Expressive writing is not offered for very recent or acute trauma without clinical support in
    the picture; if the person describes something that just happened and sounds acute, the
    companion says plainly that this method is meant for something you have some distance from,
    and suggests waiting or an alternative method instead.
  - Session length is capped at the method's own structure (15 to 20 minutes of continuous
    writing); the companion does not extend it.
  - The 4-day arc is never forced to continue: a person who does day 1 and does not come back for
    day 2, or wants to stop mid-arc, is never made to feel they owe the rest of it. `journaling.md`
    or the entry's own frontmatter can note where they are in an arc, but nothing in the product
    pressures completion.
  - Every session using this method closes with the grounding prompt in section 5.1, step 3,
    unconditionally, before the session ends.
- **CBT thought record**: "I can't find a counter-thought yet" is a valid, complete ending to
  step 6 (section 5.4). The companion must not push for a positive reframe once the person has
  said this; forcing one is invalidating and a known failure mode of this method done badly.
- **Daily Examen**: step 3 (the moment that stirred strong emotion) is skippable, with no
  pressure to resolve it in-session. If it surfaces real distress, normal crisis judgment applies;
  otherwise the companion can simply move to step 5 if the person wants to skip.
- **Morning Pages and open format**: unprompted by design, so heavy material can surface with no
  warning. The normal crisis pathway (judgment-based detection, the active safety mode's stance)
  applies exactly as it would in any other conversation; there is no method-specific gate beyond
  that, because there is no structure to gate.
- **Gratitude**: no specific gate; lowest-risk of the six by construction.
- **All methods**: journaling is never presented as a substitute for therapy. This is stated once,
  plainly, in the first-time setup conversation (section 7), not repeated every session as a
  disclaimer that would itself start to read as administrative throat-clearing, which
  `2026-08-15-remember-by-default-design.md` already establishes the product should avoid.

## 11. Interaction with reflection, the graph, and rollups

Read concretely against `packages/memory/src/reflection.ts` and `packages/memory/src/engine.ts`:

**A journal-mode session is still a session.** It has a transcript (`SessionStore`), and when it
ends, `MemoryEngine.endSession` runs exactly the pipeline it runs for any other session:
`reflectSession` over the transcript, `resolveNarratives`, `applyReflection`. Journal mode does
not fork the reflection pipeline. The one addition to `ReflectionOutput` and
`reflectionOutputSchema` is `journalingUpdate` (section 4.5), the backstop half of the
`journaling.md` rewrite mechanism, on exactly the same pattern `constitutionUpdate` already uses;
it is not a journal-specific fork of the pipeline's shape, it is the same "a document can be
rewritten by reflection" capability the constitution already has, extended to one more document.
Nothing else about reflection's output shape changes. This matters for two reasons: first, per
AGENTS.md, the pipeline is deterministic-plus-fixture-tested machinery that this spec should not
fork without a real need, and there is none beyond the one addition just named; second, whatever a
person works through in a journal session (a difficult event in expressive writing, a recurring
worry in the thought record) deserves the same chance to become an item, get attributed to an arc,
or earn a new person or entity node that any other session's content gets. A journal session is
not memory-exempt.

**A journal entry does produce items and graph activity, indirectly, through the normal
pipeline**, not through a separate journal-specific graph node type. This spec does not add
`'journal_entry'` to `NodeType` in `packages/memory/src/graph.ts`, and does not add a new
`ReflectionItemKind`. The existing kinds (`observation`, `feeling`, `event`, `intention`) already
cover what reflection is likely to pull from a journal session; if a real dogfooding gap shows
this is not enough (for example, a use case for querying "every item that came from a journal
session" as its own graph traversal), that is future work, tracked in section 15, not something
this spec should speculatively build now.

**The `journal/` document itself is a separate, additional artifact, not a replacement for
`summary.md`.** `_doEndSession` writes `summary.md` exactly as it does today, from
`out.summary`, and journal mode adds one more write after the existing pipeline completes for a
session whose mode was `journal`: the journal entry document itself, in `journal/`. Its body is
assembled deterministically, not by another LLM call, and never contains transcript-sourced
`assistant` or `tool` content, only the person's own `user`-role lines that the person actually
typed or spoke, verbatim and never paraphrased, and explicitly excluding any `user`-role line
marked synthetic. This is a non-negotiable design choice, not a simplification of convenience:
several of these methods (expressive writing, morning pages, open format) are specifically about
the person's own unfiltered words, and an LLM-summarized or paraphrased version of what they wrote
would defeat the method and would misrepresent testimony as something it is not.

**The synthetic exclusion, and why it exists.** The modes spec's `setMode` (section 9.3 there)
appends a synthesized `user`-role transcript line reading exactly `/mode <name>` when a mode
change comes from `/mode` or the web picker rather than a `set_mode` tool call. If the body
assembler here only checked `role === 'user'`, every journal entry started from a session where
the mode was set that way would begin with the literal string `/mode journal`, and this spec's own
body-assembly rule would have enforced that as correct output, which is exactly the failure mode
AGENTS.md names: a test asserting the bug as the expectation. This spec depends on the modes
spec marking such a line structurally, a `synthetic?: boolean` field added to `TranscriptLine`
(`packages/memory/src/transcripts.ts`), true only for a line the product wrote on the person's
behalf, rather than having the assembler pattern-match a leading slash: a person can legitimately
open a real line of their own writing with a slash (a checklist item, a note to self starting
"/reminder", a stray keystroke), and a leading-character heuristic would silently swallow that
legitimate content instead of the synthesized line it was meant to catch. The body assembler's
filter is exactly `line.role === 'user' && !line.synthetic`, nothing cleverer.

For the two unstructured methods with no fixed question sequence (open format has none by
definition; morning pages has none by method), the body is simply the person's non-synthetic
`user`-role lines, in order, with nothing else added. For the two prompted methods (expressive
writing, gratitude, whose prompts in section 5 are few and largely self-explanatory in sequence)
the same applies: just the person's own lines, in order, synthetic lines excluded.

For the two *structured* methods, the examen and the CBT thought record, that rule alone would
produce an entry of disembodied answers with no way to tell, a year later, which line was the
counter-evidence and which was the automatic thought. For these two, the assembled body
interleaves the static, method-defined field labels from section 5's own prompt sequence (fixed
strings the implementation already owns, not anything read back out of the transcript) with the
person's own answer to each, in order: for example `**Automatic thought:** <what they wrote>`,
then `**Evidence for:** <what they wrote>`, and so on through the sequence. The label text is
code, not model output; the answer text is still exactly what the person wrote, verbatim. No
transcript-sourced `assistant` or `tool` line, and no synthetic `user` line, is ever copied into
the body under any method; `frontmatter.method` says which method produced it, and for the
structured methods the labels in the body say which answer is which. This keeps the write
deterministic and testable per AGENTS.md's TDD requirement (section 13), and keeps faith with the
"transcripts are sacred" rule by never editing or paraphrasing the person's own words into the
entry that is supposed to be theirs.

Three consequences follow from "journal mode adds one write, gated on session mode":

- `MemoryEngine.endSession` (and its internal `_doEndSession`) needs to know the session's mode
  by the time it runs. This is resolved by the modes spec, not merely assumed: its section 9.4
  pushes the mode down into `MemoryEngine` itself (`engine.setSessionMode(sessionId, mode)`,
  called by `AgentSession.setMode` at session start and on every change), specifically because
  `core` depends on `memory` and never the reverse, so session state living only on `AgentSession`
  could never reach `_doEndSession`. This spec's gated write is a plain conditional on a value
  `MemoryEngine` already has, for the ordinary path: a session that ends through `endSession`
  while its own process is still the one that called `setSessionMode`.
- **The crash path is the case ordinary-path testing misses, and this spec depends on the modes
  spec closing it.** `runMaintenance` (`packages/memory/src/engine.ts:990-1013`) reflects any
  session left unreflected, via `_doEndSession`, but it can do so in a **later process**: someone
  journals for forty minutes, the process dies (a crash, a forced quit, a laptop put to sleep
  mid-write) before `/bye` or an orderly `endSession` ever runs, and the next time reverie starts,
  `runMaintenance` finds that session's transcript still unreflected and reflects it then. If the
  session's mode lived only in the process that died, in-memory state on `MemoryEngine` with
  nothing written to disk, the mode is gone by the time the next process's `runMaintenance` runs:
  the gated write sees an absent mode exactly as if the session had never been in journal mode at
  all, and no journal entry is ever written for those forty minutes of expressive writing or a
  completed examen. That is worse than the benign cases below: it is silent loss of something the
  person actually wrote, not an honest gap in coverage. So this spec depends on the modes spec
  persisting the mode to disk at `startSession` time, not only holding it in the live
  `MemoryEngine` process state, specifically so a later process's `runMaintenance` pass can recover
  it. This spec treats that persistence as a hard dependency, not optional hardening: without it,
  "the app was closed mid-session" is not a corner case, it is the normal shape of how a real
  session on a laptop actually ends most of the time.
- The write is additive and gated: a non-journal-mode session writes nothing to `journal/`, and
  the existing pipeline for every other mode is completely unchanged. If the mode is genuinely
  unavailable (an older memory folder from before this feature existed, or a session opened by
  something that is not an `AgentSession` at all, per the modes spec's own section 9.4), no
  journal entry is written and nothing else about `endSession` changes; this degrades to "no
  journal document was captured for that session," not an error. The crash path above is
  explicitly not one of these benign cases: it has a real, recorded mode, just one this spec now
  depends on being readable from disk rather than only from a process that no longer exists.

**Journal entries are indexed for search, not queried through the graph.** `DocKind` gains
`'journal'` (alongside `'journaling'` from section 4.1), and the entry is reindexed the same way
a summary or constitution update is today (`reindexOrWarn`), making it reachable through
`search_memory`. It carries no graph node of its own; `frontmatter.session` is enough to trace an
entry back to the session (and from there, to whatever items and arc attributions that session's
own reflection produced), the same way `summary.md`'s own `session` field already links a session
summary back to its transcript with nothing more than a frontmatter key.

**`search_memory`'s `kinds` parameter must document the new kinds, or they are unusable.**
`packages/core/src/tools.ts`'s `search_memory` tool definition spells out its valid `kinds` values
in the parameter description itself: `"Restrict results to these document kinds. Valid values:
constitution, realm, arc, summary, rollup_daily, rollup_weekly, person. Omit to search across all
kinds."` (`tools.ts:88-90`). That description gains `journal, journaling` in the same list, same
style. Without this one-line change, `journal` and `journaling` are filterable through the index
the moment `walkAllDocuments` includes them, but undocumented: a model passing `kinds: ['journal']`
would be guessing at a value nothing ever told it exists.

Worth stating as a positive, not only a gap being closed: `journal/<entryDate>-<ulid>.md` matches
`dateFromPath`'s segment regex directly (`packages/memory/src/retrieval.ts:136-146`,
`DATE_AT_SEGMENT_START`), because the filename itself starts with `YYYY-MM-DD`. That means
`search_memory`'s `after`/`before` date filters work honestly for journal entries, unlike every
other document kind today, whose date filtering is silently inert (a separate, existing gap,
being fixed by a fifth spec, not this one). Journal entries are the one kind where filtering by
date does exactly what it appears to do, and that is worth knowing rather than discovering later.

`journal/` also needs to be added to `MemoryEngine.walkAllDocuments` for indexing to happen at
all, and `walkAllDocuments` is the same list `listPublicDocuments` and `getPublicDocument` read
from for the web server's read-only document API. Adding `journal/` there is therefore a decision,
not a side effect: journal entries become listable and readable through that existing HTTP
surface the same way an arc or a person page already is.

This is no longer an open question left for an implementation plan to confirm: the person
commissioning this spec resolved it directly. Journal entries are readable over the local HTTP API,
deliberately, on the same basis realms and people pages already are: the web client is a sibling
reader of the same memory folder, not a separate trust boundary, and the reasoning is that this is
a personal, local instance; if it is ever served remotely, that gets real authentication before
anything about what is exposed changes. Section 12 specifies what the web interface does with this
now that the question is settled: a dedicated journal tab, not merely an unused capability sitting
in the API surface.

**Rollups are unaffected.** `buildDailyRollup` and `buildWeeklyRollup`
(`packages/memory/src/rollups.ts`) read reflected session summaries from `sessions/`, not
`journal/`. A journal session's content already reaches the daily rollup through its normal
`summary.md` and items, exactly like any session; the rollup pipeline does not need to read
`journal/` directly, and this spec does not add that read. If a future need arises to reflect
journaling cadence itself in a rollup ("you journaled three times this week"), that is a
`journal/` directory scan a rollup builder could add later, not something this spec builds now.

## 12. Web navigation and the journal tab

Journal gets its own destination in the nav rail, alongside Talk / Atlas / Record
(`packages/web/src/App.tsx:7-15`), per the human decision recorded in section 11: entries are
listed and openable there, over the local HTTP API, deliberately.

This spec owns what the tab contains. The modes spec owns the nav rail mechanics themselves: it
adds a fourth destination of its own (Settings, hash-routed at `#/settings`), and this journal tab
is a sibling addition to that same rail, following whatever pattern the modes spec's Settings tab
establishes for mounting a new destination without ending the live session (`App.tsx:124-139`),
not something this spec builds separate plumbing for.

### 12.1 Contents

- **Entry list.** Every document under `journal/`, read through the existing
  `listPublicDocuments`/`getPublicDocument` surface (section 11) once `journal/` is added to
  `walkAllDocuments`. Each row shows: the method, in plain words ("Gratitude", not `gratitude`),
  the entry date, and a short excerpt (the first line or two of the body, truncated) so scanning
  the list is not reading a full page of markdown per row.
- **Entry view.** Opens one entry in full: its markdown body rendered plainly, its method, its
  entry date, and its recorded-at timestamp shown as a smaller, secondary line (section 12.2
  explains why both appear). Read-only, with no edit affordance anywhere in this view, matching
  section 2.3's rule that a journal entry is never edited in place; a person who wants to add to it
  writes a new entry instead.
- **No delete, no compose-from-the-web.** This tab is a reader for entries a journal-mode session
  already produced. Starting a journal session (picking the mode through the modes spec's picker)
  is how an entry gets created; this tab is not a second way to write one.

### 12.2 Ordering

Entries sort by `entryDate` descending, not `recordedAt`. `entryDate` is what the entry is about
(event time); `recordedAt` is when it was actually written (record time), and in live use today
the two are always the same calendar day, so the choice is currently invisible. It stops being
invisible the moment import ships (deferred, section 14, but designed for since section 3): an
imported page from 2019 gets an old `entryDate` and a `recordedAt` of today, and a list sorted by
`recordedAt` would put that 2019 entry at the top of the list on the day it happens to be imported,
ahead of everything written yesterday, which is backwards for a screen whose whole point is "what
did I write, and when was it about." Sorting by `entryDate` keeps the list telling the story of the
person's life in order, not the story of when they happened to import things into reverie.
`recordedAt` still earns its place as the secondary line in the entry view (section 12.1), because
"written today about March" and "written in March" are genuinely different facts worth being able
to see, just not the ones the list itself sorts on.

## 13. Testing plan

Per `AGENTS.md`: TDD for deterministic logic, fixture transcripts and schema assertions (never
golden text) for LLM-dependent behavior, and every test must be falsifiable, meaning a reviewer
can delete the fix, watch the named test fail for the right reason, and restore it.

**Deterministic logic, test-first:**

- `memoryPaths()` includes `journalDir`; `ensureMemoryTree()` creates it. Falsify by deleting the
  `mkdir` call for it and confirming the test fails.
- Journal entry filename format (`journal/<entryDate>-<ulid>.md`) is a pure function of
  `entryDate` and a generated id; test that two entries on the same `entryDate` get distinct
  filenames and both sort by `entryDate` first.
- Journal entry body assembly from a transcript is a pure function: given a fixture transcript
  with `user` and `assistant` (and `tool`) lines, the assembled body contains every non-synthetic
  `user` line's content, verbatim and in order, and never contains any transcript-sourced
  `assistant` or `tool` content. Falsify by having the implementation copy a transcript `assistant`
  line into the body and confirming the test catches it (this is exactly the class of bug
  AGENTS.md warns about: a test that would still pass if the wrong lines leaked in must be written
  to fail on that specific mistake).
- **A second, separate test, not implied by the first: exclusion of synthetic lines.** Given a
  fixture transcript that also contains a synthetic `user` line (`synthetic: true`, the field the
  modes spec adds to `TranscriptLine` for its `/mode <name>` line, section 9.3 there, and section
  11 of this spec depends on), the assembled body excludes that line's content specifically, while
  still including every ordinary `user` line around it. This has to be its own test because "every
  user line's content is in the body" is exactly the assertion that would pass with a literal
  `/mode journal` line sitting at the top of every journal entry, which is the bug this fix exists
  to prevent: a synthetic line is a `user`-role line, so an inclusion-only test cannot distinguish
  correct behavior from the bug. Falsify by dropping the `!line.synthetic` half of the filter (so
  the assembler reads only `role === 'user'`) and confirming this test fails specifically, whether
  or not the first bullet's inclusion test still passes.
- For the examen and the thought record specifically, a third test asserts the assembled body
  interleaves the method's own static field labels (owned by the implementation, not read from the
  transcript) with the person's answers in the fixed order section 5 defines, and that every label
  present in the body is one of that method's own labels, never text pulled from an `assistant`
  transcript line.
- `entryDate` vs `recordedAt`: a test asserts these are two independently settable frontmatter
  fields, not derived from one another, by constructing a journal document with different values
  for each and confirming both round-trip through `writeDocumentAtomic`/`readDocument` unchanged.
  This is the test that guards import readiness described in section 3, even though import itself
  is not built yet.
- Journal-mode gating: given a session whose mode was not `journal`, `endSession` writes no file
  under `journal/`. Given a session whose mode was `journal`, exactly one file is written. Both
  directions need their own test; asserting only the positive case would pass even if the gate
  were deleted entirely.
- **The crash path (section 11).** A session whose mode is set to `journal`, whose engine is then
  closed and reopened (simulating the process dying before `/bye`), still produces a journal entry
  when the reopened engine's `runMaintenance` reflects that session via `_doEndSession`. This is
  the test that exercises the dependency on the modes spec persisting mode to disk rather than
  holding it only in `MemoryEngine`'s live process state: it must fail if that persistence is
  missing, because a fresh, reopened engine would otherwise have no way to know the closed
  session's mode was ever `journal`. Falsify by having the fixture only set the mode through the
  in-memory path and skip persisting it before closing the engine, and confirming the reopened
  engine's `runMaintenance` pass produces no journal entry, which is the exact bug this test exists
  to catch.
- `DocKind` additions (`'journal'`, `'journaling'`) are exercised through `reindexOrWarn` and
  `search_memory`, with a test confirming a written journal entry is findable by
  `search_memory` and a written `journaling.md` is not accidentally excluded from
  `walkAllDocuments`.
- Cadence-evidence disclosure (section 6): `journaling.md` is free prose, so nothing parses it
  and no code branches on "the person picked daily gratitude." What is deterministic, and
  therefore testable here, is that the journal-mode setup prompt construction always includes the
  gratitude cadence instruction (the evidence claim, plus an instruction to say it once and then
  accept whatever the person decides) whenever gratitude is a candidate method being presented.
  A test asserts that instruction's presence in the assembled setup-conversation prompt. Falsify
  by deleting the instruction and confirming the test fails. Whether the model actually surfaces
  the disclosure in a given conversation, and whether it correctly ties the disclosure to a
  specifically daily choice, are model behavior and belong in the fixture-transcript bucket below,
  not here.

**LLM-dependent behavior, fixture transcripts and schema assertions, never golden text:**

- Reflection's existing schema and pipeline are asserted, using a fixture journal-mode transcript,
  to still produce a valid `ReflectionOutput` that passes `reflectionOutputSchema`. This is not a
  new schema; it is confirmation that journal-mode content flows through the existing one without
  special-casing breaking it.
- A fixture transcript representing an expressive-writing session that shows signs of active
  crisis is used to assert the safety gate in section 10 behaves: the persona/prompt construction
  under test must not offer or continue expressive writing, and the crisis stance from
  `personas.ts` must be present in the assembled prompt for that turn. This asserts the shape and
  presence of the crisis stance section (a schema/structural assertion: is the resource block
  there, is the mode-appropriate stance text there), not a fixed string of what the model says in
  response, since the model's actual reply is not something a test should pin to golden text.

**A test that journal mode cannot weaken safety behavior, specifically:**

An earlier draft of this test built the prompt with journal mode active and without, then asserted
the crisis sections were byte-identical between the two. That test is anti-falsifiable, which is
worse than having no test at all: delete every line of journal-mode prompt construction and the
two arms become *more* identical, not less, so the test passes harder with the feature removed
than with it present, and it already passes today, before journal mode exists in the codebase at
all. A test that strengthens when the implementation is deleted is not testing the implementation.

The fix is the form the modes spec's own safety test already uses (that spec, section 16.4):
position plus bytes, asserted against a prompt that actually contains journal-mode content, not an
emptied one.

- Construct the journal-mode arm with a **real, non-trivial fixture**: a `journaling.md` body and a
  chosen method, so the assembled journal-mode prompt genuinely differs from the no-mode baseline
  outside the crisis section (the journal-mode paragraph is present, section 4.4's protocol section
  is present, section 5's method content is present). Build the assembled system prompt for a
  companion-mode and a firewall-mode session, once with this journal-mode fixture active and once
  with no mode at all, for the same safety mode. Assert two things, not one: the crisis-relevant
  sections (`CRISIS_DETECTION`, the mode-appropriate stance, `CRISIS_OUTRANKS_TONE`) are
  byte-identical between the two, **and** the crisis section remains the **last** section of the
  journal-mode prompt, exactly as it is in the no-mode baseline. Falsify by moving the crisis
  section's insertion point in the section-assembly list (mirroring the modes spec's own
  falsification: inserting the mode paragraph after `crisisSection` in the section list at
  `packages/core/src/personas.ts:121-130`) and confirming the ordering half of the assertion fails,
  while a presence-only assertion ("the crisis text appears somewhere in the prompt") would still
  pass. That gap between the two assertions is the entire reason position is checked and not just
  presence, and it is also the reason the journal-mode arm must have real content: an emptied arm
  makes both assertions trivially pass regardless of where the crisis section ends up, since there
  is nothing to insert after it.
- Strengthen the presence-only check from the earlier draft into the same position-plus-bytes form,
  applied across the full combination space rather than a single arm: construct prompt assembly
  across every combination of {companion, firewall} x {no mode, journal mode with the
  `journaling.md` fixture above, journal mode with `journaling.md` absent (the
  `JOURNALING_PROTOCOL_ABSENT` sentinel from section 4.4)}, and confirm the crisis section is
  present, in the same last position, and byte-identical to that safety mode's baseline in every
  one of those six cases, not merely the common one. This is what makes the earlier draft's second
  bullet ("no new tool this spec could plausibly need is capable of suppressing the crisis
  section") checkable rather than asserted: a bug that only shows up when `journaling.md` is
  absent, say, cannot hide behind a single passing case the way it could behind a presence-only
  assertion on the common path alone.

## 14. Deferred

**Journal and note import** is explicitly parked by the human who commissioned this spec. It is
out of scope here entirely: no importer, no format detection for external journal exports (Day
One, plain text folders, etc.), no bulk-write path into `journal/`. What this design already does
to keep that door open without building it:

- `entryDate` and `recordedAt` are already separate fields (section 3), so an importer can set
  historical dates correctly on day one of building it, instead of a later migration having to
  retrofit every already-imported entry.
- `journal/` file naming is already date-prefixed and collision-safe for many entries on the same
  date (section 2.1), which an importer producing many entries at once needs.
- The frontmatter schema (section 2.2) already has a `method` field broad enough to carry an
  `'imported'` or similar value later, without a schema-breaking change, though this spec does
  not define that value now.
- Journal entries are already indexed and searchable (section 11) through the same `DocKind`
  mechanism every other document uses, so imported entries need no separate retrieval path built
  for them later.

## 15. Open questions

This section previously listed "where exactly the session mode is read from at `endSession` time"
as open. It no longer is: the modes spec's section 9.4 resolves it (`MemoryEngine` holds the mode
against the open session), and section 11 of this spec now states the remaining real dependency
concretely, that persistence to disk is required for the crash path, rather than leaving it as a
question. What is left open:

- **Per-method activity level inside `journaling.md`** (section 8) is specified as free prose the
  companion reads and reasons about, not a structured per-method map. Whether that turns out to
  be reliable enough in practice, versus needing a small structured table inside the document's
  frontmatter, is worth revisiting after real dogfooding, the same way several decisions in
  `2026-08-15-remember-by-default-design.md` were revised after a real session exposed a problem
  a design review alone did not catch.
- **Whether journal-session items should be visually or structurally distinguishable later**
  (for example, in the web atlas or in `search_memory` filters) from items originating in
  ordinary conversation is left open. Section 11 deliberately does not add a new item kind or
  node type for this now; if it turns out to matter once journal mode is in real use, that is an
  additive follow-up, not a reason to add speculative structure today.
