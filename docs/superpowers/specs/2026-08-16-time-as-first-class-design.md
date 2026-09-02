# Time as a first-class design

Date: 2026-08-16
Status: proposed
Target release: v0.5.0
Scope: give the model a real clock, not a bare date; introduce local calendar days everywhere a day
boundary is computed; introduce `profile.md` as the home for personal facts like timezone; carry
event time alongside record time so a thing that happened at a stated hour can be reasoned about
correctly. Design only. No implementation in this document.

## 1. What is wrong today

Three defects stack on top of each other, and a fourth already-honored discipline (context.ts:10-16)
constrains how any of them can be fixed.

**Defect 1: the model has a date, not a clock.** `todaySection` in `packages/core/src/context.ts:63-65`
renders exactly one sentence: `"Today's date is ${context.today}."` No hour, no day of week, no
timezone. `context.today` comes from `MemoryEngine.sessionContext`
(`packages/memory/src/engine.ts:665`), which computes it as `formatDateUTC(now)`
(`packages/memory/src/engine.ts:1738-1743`), a bare `getUTCFullYear/getUTCMonth/getUTCDate` triple.
A model told only a calendar date cannot reason about elapsed time within a day. A user who says at
4:19pm local "I'm watching Halcyon tonight at 7.25pm" is describing something in the future; the
model has no way to know that, because it has no concept of 4:19pm at all. In a real session on this
codebase, the companion later asked "how was Halcyon tonight?" before 8:10pm had happened.

**Defect 2: every day boundary in the system is UTC, not local.** For a user at UTC+5:30 (India),
every local hour from 00:00 to 05:29 is still the previous UTC day. A midnight-to-1am journal entry
files under yesterday's session directory, yesterday's daily rollup, and drops out of the
recent-sessions window a day early. This is wrong for a reflection app specifically: the day a
person's entry belongs to is the day they lived it, not the day UTC happened to be showing.

**Defect 3: nothing in the request carries a current time.** The one place the model is told anything
about when it is, is the system prompt, and that prompt is assembled once: `AgentSession.start`
(`packages/core/src/agent.ts:170`) calls `assembleSystemPrompt` and stores the result in
`this.system`, and every subsequent call to `chat.stream` in `runTurn`
(`packages/core/src/agent.ts:272`) reuses that same string. The only thing that ever reassembles it
is `update_style` (`packages/core/src/agent.ts:328-331`), and that reassembly still carries no time
component. So a session that runs long keeps asserting whatever date it was when the session opened.

The fix is not to unfreeze the system prompt. A frozen system prompt is worth keeping (Section 5
explains why in detail: it is what makes prefix caching work at all). The fix is that the *messages*
must carry the time, because the messages are the part of the request that legitimately grows every
turn. Today they carry none: `AgentSession.appendBoth` (`agent.ts:357-366`) writes a `ts` to the
on-disk transcript line and then pushes a `SessionMessage` with only `role` and `content` into
`this.history`, which is what `chat.stream` receives (`agent.ts:276`). The time is recorded and then
discarded on the way to the model.

**The constraint these three defects must be fixed inside:** `context.ts:10-16` establishes that the
model is never told the current date anywhere but `context.today`, and that the assembler itself
never makes a second call to `Date()`. This is single-clock discipline, and it exists because two
independently-read clocks can disagree by the width of a network hop or an event loop tick, and a
model that has been told two different "now"s trusts neither.

**This spec changes that discipline rather than preserving it verbatim, and the change is a
tightening, not a relaxation.** Stating the difference honestly:

- The old rule: one channel (`context.today`), one clock read, at prompt assembly.
- The new rule: still exactly one channel, but it moves. The current time reaches the model only as
  the stamp on the newest user message (Section 5). `assembleSystemPrompt` stops reading a clock for
  the model's benefit entirely; what it renders about time is a static timezone line.
- The number of clock reads goes from one per session to one per appended message. That is more
  reads, but it is not more channels, and no two of them are ever shown to the model at once as
  competing claims about "now": each read stamps exactly one message, permanently, and every earlier
  message keeps the stamp it was written with.
- Each of those reads is the *same* read that writes the transcript line's `ts`
  (`agent.ts:357-366`). Under the old design the assembler's clock (via `sessionContext`) and
  `appendBoth`'s clock were two independent reads, and the prompt asserted a date from the first
  while the durable record used the second. Now the value the model sees and the value on disk come
  from one `new Date()`, which is a stronger guarantee than the old rule gave.
- `sessionContext(now)` still reads a clock, for the recent-summaries cutoff and the rollup dates.
  That read is never rendered to the model as the current time, so it cannot disagree with anything;
  it only decides which records to include, exactly as it does today.

The header comment at `context.ts:10-16` is rewritten as part of this spec to say the new rule,
rather than being left describing a discipline the code no longer follows.

## 2. The event-time / record-time model

Two different timestamps exist for anything a person tells the companion about, and today the system
only has one of them.

- **Record time**: when a thing was written down. This is what every timestamp in the codebase
  currently means: `TranscriptLine.ts` (`packages/memory/src/transcripts.ts:16`), the `ts` on a
  `ReflectionItem` (`packages/memory/src/engine.ts:290`), every `ts` in `graph.jsonl`. It answers
  "when did this enter memory," never "when did this happen."
- **Event time**: when a thing happened or will happen, as stated by the person. "Tonight at 7:25,"
  "last Tuesday," "next month." It can be in the past, present, or future relative to record time. It
  is often fuzzy (a day, not a minute) and sometimes absent entirely (an observation with no
  particular moment attached, like "I've been feeling behind lately").

Every timestamped thing in the memory model should be able to carry both, independently. A `remember`
call happening at 16:19 local for something the person says will happen at 19:25 local the same day
is not a contradiction to resolve; it is two different facts about the same item, and the model
needs both to answer "how was it" correctly (not until after 19:25) and to answer "when did you tell
me this" correctly (at 16:19).

This spec does not attempt to build full event-time extraction or a scheduling system. What it does:

- Stamps every user message with the local time it was sent (Section 5), so the model can reason
  about elapsed time without any structured event-time field existing at all. This alone fixes the
  Halcyon case, and it fixes it in the form the failure actually took. The reported failure was
  not "the model did not know the time"; it was "the model did not notice that seven hours had
  passed between two messages." A message stamped 16:19 saying "watching Halcyon tonight at
  7.25pm", followed by a message stamped 23:30, makes the elapsed gap visible in the request itself,
  which is what "how was it?" needs to be asked at the right moment.
- Extends `ReflectionItem` (`packages/memory/src/engine.ts:290`, written by `MemoryEngine.remember`)
  with an optional `eventTime` field, distinct from the `ts` it already carries as record time.
  `eventTime` is a free-text string, not a parsed instant: reflection or the live `remember` tool
  populates it only when the person stated a time and leaves it absent otherwise. No schema promises
  a resolved timestamp here, because "tonight," "next week," and "sometime in the fall" cannot
  honestly be reduced to one. Structured event-time resolution (turning "tonight at 7:25" into an
  actual instant) is future work, not this spec's job, and is not required to fix the observed
  failure: a local time on each message is what the failure actually needed.
- Makes reflection able to see time at all (Section 7), which it currently cannot, and which is the
  precondition for it ever populating `eventTime` sensibly.

This is the foundation the rest of the spec builds on: record time answers "when did memory learn
this," event time answers "when did this happen in the person's life," and they are allowed to
differ.

## 3. `profile.md`: structured personal facts

### Where it lives and what it is

A new file at the memory folder root, alongside `constitution.md`: `<memoryDir>/profile.md`. Same
document primitive as everything else in the folder (`packages/memory/src/documents.ts`): YAML
frontmatter plus a markdown body, read with `readDocument`, written atomically with
`writeDocumentAtomic` (temp file, then rename, per AGENTS.md's atomic-write rule for prose files).

`MemoryPaths` (`packages/memory/src/paths.ts:9-21`) gains a `profile: string` field, set in
`memoryPaths()` to `join(root, 'profile.md')`. `ensureMemoryTree`
(`packages/memory/src/paths.ts:41-61`) seeds it the same way it seeds `constitution.md`: if absent,
write a starter document. Unlike the constitution's starter (an empty sentence, since a person's
identity is unknown at folder creation), the profile starter is not empty: it is seeded with a
`timezone` field defaulted from the machine running `ensureMemoryTree` at that moment
(`Intl.DateTimeFormat().resolvedOptions().timeZone`), marked as unconfirmed (Section 4). The body is
a short comment noting the file is machine-managed and safe to hand-edit.

### Ownership rules

Three files now hold facts about the person, and this spec draws the line between them explicitly,
because letting the same fact live in two places is how reflection.ts:230 ended up telling the model
to write timezone into constitution prose in the first place:

- **`config.toml`** (`packages/core/src/config.ts:29-35`) is infrastructure: provider, API key
  handling, model names, `memoryDir`, safety mode, crisis resources. It is validated with
  `z.strictObject`, which rejects unknown keys by design. Timezone is not infrastructure and does not
  belong here; this is why decision 6 puts it in a new file instead of adding a field to
  `ReverieConfig`.
- **`profile.md`** is machine-readable structured fact: something a formatter or a piece of code
  needs to parse reliably, starting with `timezone`. If code has to feed a value into
  `Intl.DateTimeFormat`, it belongs in profile frontmatter, not prose, because prose is not reliably
  machine-parseable and was never meant to be.
- **`constitution.md`** is meaning: testimony about who the person is, prose a human wrote or a model
  synthesized from what the person said, in the register `reflection.ts` already writes it in
  (`packages/memory/src/reflection.ts:230` currently instructs identity facts, including timezone,
  into this file). It is not a reliable machine-parseable source and never should be one.

**Reflection must not duplicate profile facts into constitution prose.** This spec makes exactly one
requirement of the identity-fact sentence in `reflection.ts:230` ("name, pronouns, where they live,
their timezone, their occupation or work situation... always belong in the constitution"): **"their
timezone" must no longer appear in it.** That is the whole of this spec's claim on that sentence.
Timezone is the one fact in the list that the codebase itself has to read back out and feed to
`Intl.DateTimeFormat`, which is why it moves here.

This spec deliberately makes no claim about what happens to the rest of that sentence. The companion
spec, [Modes, profile, and settings](2026-08-16-modes-profile-settings-design.md), rewrites it and
owns the decision about which of the remaining identity facts move into `profile.md` and which stay
in the constitution. Do not read this section as asserting that any of them stay. An implementer
landing both specs should take the sentence's final wording from the modes spec, and check only that
"their timezone" is gone from whatever it ends up saying.

### Schema

```ts
export interface ProfileMeta {
  id: string
  timezone?: string
  timezoneSource?: 'system-default' | 'user-confirmed'
}
```

Validated with a zod schema that is deliberately **not** `.strict()`, unlike `configSchema`. Config
is a closed set of infra knobs and an unknown key there is almost always a typo worth rejecting hard.
Profile is an open, growing set of personal facts by design (decision 6 says a later spec adds more
fields), and a stray or forward-written key here should not make the file fail to load. The schema
validates the fields it knows about and passes the rest through untyped, the same posture
`DocumentMeta`'s `[key: string]: unknown` already takes for every other document in the folder.

```ts
const profileMetaSchema = z
  .object({
    id: z.string(),
    timezone: z.string().refine(isValidIanaTimeZone).optional(),
    timezoneSource: z.enum(['system-default', 'user-confirmed']).optional(),
  })
  .passthrough()
```

`isValidIanaTimeZone` is a small helper: `new Intl.DateTimeFormat('en-US', { timeZone: value })`
throws `RangeError` for an unrecognized zone name, which is the validation. No external timezone
database dependency is needed; Node's built-in `Intl` carries the IANA database already.

### Loader

`loadProfile(paths: MemoryPaths): Promise<Profile>` reads `paths.profile` with `readDocument`,
parses `meta` through `profileMetaSchema`, and returns a typed `Profile`. Because `ensureMemoryTree`
guarantees the file exists (seeded with a system-default timezone the first time a memory folder is
created), the loader does not need an absent-file branch for any folder created after this spec
ships; it does need one for a pre-existing folder opened for the first time post-upgrade, which is
exactly what `reverie migrate` exists to backfill (Section 8). A schema validation failure on a
hand-edited `profile.md` is reported the same way a broken document anywhere else in the folder is:
attributed to the path, not swallowed.

### Writer and indexing

`profile.md` is written atomically like every other document. It is **not** indexed: it carries no
prose worth retrieving through `search_memory`, only structured fields the code reads directly, so it
is excluded from `walkAllDocuments` and `reindexAll`
(`packages/memory/src/engine.ts:1084-1101`) the same deliberate way `writeSkippedSummary`'s
placeholder summaries already are (`packages/memory/src/engine.ts:1173-1180`). `MemoryEngine` caches
the loaded profile on `open()` and reloads it whenever something writes to it (the live
`update_profile` tool, Section 4, and reflection's `profileUpdates`, Section 4), the same pattern
`AgentSession` already uses for `config.style` after `update_style`
(`packages/core/src/agent.ts:328-331`): write, then refresh the in-memory copy, so the next read
inside the same process sees the new value without a second file read racing the first.

## 4. Timezone acquisition

Three moments, in order:

1. **System default at folder creation.** `ensureMemoryTree` seeds `profile.md` with
   `Intl.DateTimeFormat().resolvedOptions().timeZone` read from the machine reverie is running on,
   `timezoneSource: 'system-default'`. This is a guess, not a fact the person confirmed; it exists so
   the per-message stamp (Section 5) has something to render from the very first session rather than
   falling back to a bare UTC instant with no local rendering at all.
2. **Conversational confirmation.** The first-conversation onboarding prompt already asks for this:
   `firstConversationSection` in `context.ts:58` tells the model to ask "where they live and their
   timezone" as one of its early questions. Today that answer is unusable structurally: it lands only
   in constitution prose (`reflection.ts:230`), which nothing reads back to render a local time. This
   spec gives the model a live tool, `update_profile`, parallel to the existing `update_style`
   (`packages/core/src/tools.ts`, `packages/core/src/agent.ts:328-331`): the model calls it with the
   confirmed IANA zone as soon as it has one, `MemoryEngine` validates and writes it to `profile.md`
   with `timezoneSource: 'user-confirmed'`, and refreshes its cached copy so every message stamped
   after that point in the same session, including the rest of the first conversation, renders
   correctly right away. Messages already stamped keep the stamp they were written with; they are not
   re-rendered (Section 5 explains why that immutability is the point).
   Writing immediately rather than waiting for end-of-session reflection matches the remember-by-default
   posture this codebase already committed to (`2026-08-15-remember-by-default-design.md`): capture it
   the moment it is known, do not sit on it.
3. **Reflection as backstop.** Not every session is the first conversation, and a person can mention
   they moved, or correct a wrong guess, at any point later. `reflection`'s structured output gains an
   optional field:

   ```
   "profileUpdates": {"timezone": string | null}
   ```

   `null` or the field's absence means nothing to update. When present, `MemoryEngine` writes it to
   `profile.md` with `timezoneSource: 'user-confirmed'` the same way the live tool does, at end of
   session (`_doEndSession`, `packages/memory/src/engine.ts:318`), validated by the same zod schema
   used everywhere else structured LLM output crosses a boundary, per AGENTS.md. This is a backstop,
   not the primary path: a model that used `update_profile` live during the conversation has already
   written it, and reflection's own materialization is naturally idempotent (writing the same
   confirmed value twice is a no-op in effect).

**What happens when unknown.** It is never actually unknown in the sense of "no value at all":
`Intl.DateTimeFormat().resolvedOptions().timeZone` always returns something, worst case `'UTC'` on a
misconfigured machine. What can be unconfirmed is whether that value is right. The static timezone
section of the system prompt (Section 5) is explicit about this distinction rather than pretending
confidence it does not have: when `timezoneSource` is `'system-default'`, that section says so, so the
model knows this is a guess still worth confirming rather than a settled fact, and does not silently
assert a local time to the person that might be wrong. The caveat belongs there, once, and not on
every message stamp: a stamp is written permanently into a past message, and a caveat baked into a
stamp would still be claiming "not yet confirmed" long after the person confirmed it.

## 5. Per-message local time

### The design that was rejected, and why it was wrong

An earlier draft of this section put a refreshed "now" block at the **end** of the system prompt,
re-rendered on every model call, and argued that the tail position protected OpenAI's prefix cache.
That reasoning was backwards, and the design is not what this spec adopts. Recording why, because the
mistake is easy to make again:

OpenAI's prompt caching is prefix-based over the **whole request**, not over the system message alone.
The request is `[system][turn 1][turn 2] ... [turn N]`. The cache matches the longest identical
leading run of tokens and stops at the first byte of divergence. If any byte of the system message
changes between turns, divergence happens inside the system message, which sits in front of every
conversation turn. Everything after that point reprocesses, and that includes the entire conversation
history.

So moving the clock from the front of the system block to the back of it saves the persona and the
memory snapshot and then throws away every conversation turn, on every turn. In a short session that
is cheap. In a long session the history is the large part, and the tail-position design pays for it
again on every single call. It is worse than useless: it optimizes the part that was already small.

### What this spec does instead

**Stamp each user message with its own local time, in the message itself, immutable once written.**

Past messages never change, so the request prefix stays byte-identical from one turn to the next. The
only new content each turn is the newest message, which was never cacheable in the first place because
it did not exist yet.

This is strictly better than the now-block on three counts:

1. **Caching is preserved completely, by construction.** No byte that has already been sent to the
   provider is ever rewritten. The system message is frozen for the life of the session, apart from
   two deliberate exceptions named below (a `update_style` or `update_profile` reassembly, and the
   greeting's one-call suffix), and `this.history` is append-only. Every request is therefore a strict
   extension of the previous request, which is the exact shape prefix caching is built to serve. This
   is a structural property of the design, not a measurement: this spec still has not measured cache
   hit rates against OpenAI's API, and it does not depend on any particular hit rate for correctness.
2. **It solves the actual bug better.** A single now-block tells the model one thing: what time it is
   right now. Per-message stamps tell it that *and* how much time passed between any two messages.
   The reported failure needed the second one. The user said at 16:19 "watching Halcyon tonight at
   7.25pm" and came back at 23:30; the companion asked how it was before 19:25 had happened. A
   now-block rendered at 23:30 would have shown 23:30, but nothing in the request would have shown
   that the plan was stated seven hours earlier, which is the reasoning step that was missing. Two
   stamped messages make the gap visible in the request itself.
3. **It mirrors what is already on disk.** Every transcript line already carries a `ts`, written at
   `packages/core/src/agent.ts:359`. The transcript has had per-message record time since the
   beginning; the model just never saw it. This design stops discarding a value the durable record
   already keeps, rather than inventing a parallel one.

### The static timezone section

`todaySection` (`context.ts:63-65`) is replaced, not by a now-block, but by a section that contains no
clock at all and therefore stays byte-stable for the whole session:

```
## Time

This person's timezone is Asia/Kolkata. Every message from them is stamped with the local date and
time it was sent, in square brackets at the start of the message. Read the newest stamp as the current
time, and read the gaps between stamps as elapsed time: something the person described as happening
later in the day may already have happened by a later message.
```

When `timezoneSource` is `'system-default'` (not yet conversationally confirmed), one more sentence is
appended:

```
This timezone is a system default, not yet confirmed by the person. Confirm it naturally if the
moment allows, rather than assuming it is correct.
```

Nothing in this section moves on its own. It changes only when `profile.md`'s timezone changes, which
already triggers a full `assembleSystemPrompt` reassembly through the same path `update_style` uses
(`agent.ts:328-331`). That reassembly costs one cache miss, once, typically during the first
conversation. It is a real cost and it is worth naming, but it happens on the order of once per memory
folder, not once per turn.

### `## Today`: recommendation

**Remove it.** `todaySection` goes away entirely, and `SessionContext.today` (`engine.ts:160`,
computed at `engine.ts:665`) goes with it. Justification:

- It is now redundant. Everything `## Today` existed for, per the header comment at `context.ts:10-16`
  (letting the model read an absolute date like "2026-08-12" in the recent-sessions list as recent or
  old), is served better by the newest message's stamp, which carries the same calendar date plus the
  hour, and sits at the end of the request where the model's attention is strongest.
- Keeping it actively hurts. It is a moving value inside the one region of the request that must stay
  byte-stable. Left frozen it goes stale across local midnight, which is defect 3 in miniature; kept
  fresh it costs the entire history cache every turn, which is the mistake this section exists to
  avoid.
- It has exactly one production reader. Verified by grepping `packages/` for `today` in full, not
  just for `.today`, so a destructured `const { today } = context` would have shown up: `context.ts:64`
  is the only consumer of `SessionContext.today`. Nothing in `reflection`, `server`, or `web` reads it.
  Three existing tests do assert on it and have to be rewritten rather than deleted, and the spec is
  not going to pretend that is free: `context.test.ts:423-454` ("states today's date near the top"),
  `context.test.ts:551-557` ("still states today's date during a first conversation"), and
  `agent.test.ts:474-479` (the greeting request's system must carry today's date). The first two become
  assertions about the static `## Time` section and about a stamped user message; the third becomes an
  assertion about the greeting's time suffix, which is still the right claim in the new design.
- `sessionContext` still needs a local "today" internally, for the recent-summaries cutoff
  (`engine.ts:575`) and for `runMaintenance` (`engine.ts:1016`). That value stays; it simply stops
  being exported to the prompt.

The greeting is the one call with no user message to carry a stamp, and is handled separately below.

### Exact rendering of the stamp

One line, prefixed to the message content:

```
[Sun 2026-08-16 16:19 Asia/Kolkata] I'm watching Halcyon tonight at 7.25pm
```

- Weekday abbreviation, local date as `YYYY-MM-DD`, local time as `HH:MM` on a 24-hour clock, then the
  IANA zone name, all inside one pair of square brackets, followed by a single space, followed by the
  message text verbatim.
- All four fields come from one `Intl.DateTimeFormat` render against the stored IANA zone, applied to
  one `Date`, read once. No second clock read, and no separate UTC instant: the transcript keeps the
  UTC instant in `ts`, and repeating it in the prompt would be bytes spent on something the model does
  not need to reason with.
- Seconds are omitted deliberately. They add a byte cost per message and there is no reasoning task in
  this application that turns on them.

The renderer lives in `@openreverie/memory` (a new `packages/memory/src/time.ts`) rather than in
`core`, because Section 7's `renderTranscript` in `reflection.ts` needs the same format and lives in
`memory`. `core` may import from `memory` under the package rules (`cli` -> `core` -> `memory` ->
`providers`); the reverse would not be allowed. One format, one function, two callers:

- Live path (`agent.ts`), which knows the IANA zone: renders the zone name, as above.
- Stored-line path (`reflection.ts`, and any other rendering of a past transcript line), which knows
  only `ts` and `utcOffsetMinutes`: renders `UTC+05:30` in place of the zone name, because the zone
  name at write time was not recorded, only the offset. When `utcOffsetMinutes` is absent, it renders
  the labeled UTC form described in Section 7 and never guesses a local time.

### Content, not a structural field

The stamp goes in the message **content**. `ChatMessage` (`packages/providers/src/types.ts:14-19`) has
`role`, `content`, `toolCalls`, and `toolCallId`, and no timestamp field; neither does the OpenAI chat
wire format. A structural field would therefore have to be flattened into content by the provider
adapter anyway, and would put a rendering decision inside `providers`, where a formatting rule about
the person's local time does not belong. Adding one to `ChatRequest` is not proposed.

The obvious cost of putting it in content: a person can type a line that looks like a stamp, and the
model has no cryptographic way to tell theirs apart from a real one. This is the same class of risk as
any other user-authored text in a prompt, it is not made worse by this design, and the durable record
is unaffected, because the true `ts` is a separate field on the transcript line and is never derived
from content.

### Where it is injected

The call path that builds the messages array is short and has exactly one seam:

`AgentSession.runTurn` (`agent.ts:261`) calls `this.chat.stream({ ..., messages: [...this.history] })`
(`agent.ts:270-278`). `this.history` is a `SessionMessage[]` (`agent.ts:120-125, 133`) appended by
exactly one method, `appendBoth` (`agent.ts:357-366`). Nothing else ever writes to it.

`appendBoth` is the seam. It becomes:

- Read the clock once: `const now = new Date()`. That single instant produces the transcript line's
  `ts`, its `utcOffsetMinutes` (Section 7), and the rendered stamp. This is the one clock read per
  appended message described in Section 1.
- Write the transcript line exactly as today, with the **verbatim** content, plus the two time fields.
- Push into `this.history` a message whose content is the stamped string for `role: 'user'`, and the
  verbatim content for `role: 'assistant'` and `role: 'tool'`.

**Only user messages are stamped.** Assistant and tool messages are stamped nowhere, for two reasons.
They are produced within seconds of the user message that prompted them, so their own time adds
nothing the preceding user stamp does not already give. And an assistant message whose content the
model receives back with a bracket prefix it did not write teaches the model that it writes stamps,
which it then starts emitting into its own replies to the person.

The tool-call loop keeps a byte-stable prefix as a result: each round of `runTurn` appends to
`history` and re-sends it, so round N+1's messages array is a strict extension of round N's. **The
per-round `new Date()` that the rejected design introduced at `agent.ts:264` is dropped entirely.**
There is no per-round clock read and no per-round system-string change. A tool loop that spans real
wall-clock time is covered by the deferred `current_time` tool (Section 10), not by rewriting the
request on every round.

**The greeting.** `runGreeting` (`agent.ts:218-259`) calls the model with `messages: []`, so there is
no user message to stamp, and it is the first model call of the session. It already appends a per-call
suffix to the system string (`` `${this.system}\n\n${GREETING_INSTRUCTION}` ``, `agent.ts:225`). One
line carrying the current local time is appended to that suffix, from a single `new Date()` read at
the top of `runGreeting`. This is safe for caching precisely because it is the first call and nothing
later reuses that string: every later request's prefix is `this.system` plus messages, and the
greeting's extra suffix is never part of it. No other call site gets a system-string suffix.

One consequence of that, stated so it does not read as an oversight later: in a greeting-opened
session, the first entry in `history` is an unstamped assistant message, and the time the greeting was
written survives only in that dropped system suffix and in the transcript line's own `ts`. It is not
visible to the model on any subsequent turn. That is accepted. The greeting happens seconds before the
person's first message, which is stamped, so the elapsed-time reasoning this spec exists for is
unaffected.

### Invariant: history content and transcript content deliberately differ

Today `appendBoth` pushes the same `content` to both places, and the module comment at
`agent.ts:11-15` describes the transcript and history as holding the same messages. After this change
that is no longer literally true, so it is stated as a named invariant and the comment is rewritten:

> The transcript line stores content verbatim, plus structural time fields (`ts`,
> `utcOffsetMinutes`). The in-memory history stores the same content, with that same time rendered
> into it for user messages. Both come from one clock read per message; the transcript is the record,
> the history is the rendering, and neither is ever built from a different read than the other.

Keeping the stamp out of the on-disk content is deliberate, on four grounds:

- The transcript is the verbatim record of what the person said. A rendered prefix is presentation.
- `read_transcript` (`tools.ts:334-340`) returns lines as stored, `ts` included, so a stamp in
  content would duplicate a field already on the same line.
- `packages/server/src/app.ts:226` and `registry.ts:441` send transcript lines to `web` for display; a
  stamped content string would render as literal bracket text inside the person's own message bubble.
- Section 7's `renderTranscript` builds its own stamp from `ts` and `utcOffsetMinutes` for reflection;
  a stamp already in content would be rendered twice.

### Replay of an old transcript

There is no replay path in the code today. `AgentSession.history` is private, is only ever appended by
`appendBoth`, and is never reconstructed from disk: `AgentSession.start` (`agent.ts:164-173`, called at
`cli/src/chat.ts:175` and `server/src/registry.ts:149`) always opens a fresh session. So "replay"
currently means only the three read paths named above (`read_transcript`, reflection's
`renderTranscript`, and the web transcript view), and the rule for all three is the same: render from
the line's own `ts` and `utcOffsetMinutes`, and when the offset is absent, show the labeled UTC form
from Section 7 rather than guessing a local time from today's profile.

If a resume path is ever added, the rule it must follow is fixed here: **rebuild each stamp from that
line's stored `ts` and `utcOffsetMinutes`, never from the current clock.** That is what keeps a resumed
session's prefix byte-identical to the prefix the same messages produced before the resume, and it is
the same immutability property that makes the live path cacheable. A resume that re-stamped history
with today's time would invalidate the cache on every resume and would also lie about when the person
said what they said.

## 6. Local day boundaries

Every place the codebase currently computes a calendar day from UTC, and what it becomes. The
underlying fix is the same everywhere: feed the same calendar-arithmetic functions **local** year,
month, and day components (derived from the stored timezone via `Intl.DateTimeFormat`) instead of
**UTC** year, month, and day components. This is not a rewrite of the arithmetic, which is already
correct pure calendar math; it is a correction of its inputs.

- **`formatDateUTC`** (`packages/memory/src/engine.ts:1738-1743`). Becomes `formatLocalDate(date:
  Date, timezone: string): string`, using `Intl.DateTimeFormat('en-CA', { timeZone: timezone,
  year: 'numeric', month: '2-digit', day: '2-digit' })`, whose `en-CA` locale formats as
  `YYYY-MM-DD` directly. Every call site listed below switches to this function and now passes the
  profile's timezone alongside the clock.
- **`addDaysUTC`** (`packages/memory/src/engine.ts:1745-1750`), used at `engine.ts:575` to compute
  the recent-summaries cutoff (`RECENT_SUMMARIES_WINDOW_DAYS` days back from today). Becomes
  `addDaysLocal(date: Date, days: number, timezone: string): string`: derive the local
  year/month/day via `Intl.DateTimeFormat`, do the day arithmetic with `Date.UTC(year, month - 1,
  day + days)` exactly as today (this remains a pure calendar-arithmetic scratch calculation, not a
  real instant, so using `Date.UTC` as its internal engine is still correct), and format the result
  with `formatLocalDate`'s same `en-CA` approach. The change is which calendar the input digits come
  from, not how the arithmetic itself works.
- **`packages/memory/src/engine.ts:526`**, `sessionContext(now: Date = new Date())`. Signature grows
  a `timezone: string` parameter (or, more likely given the profile is already cached on the engine,
  `sessionContext` reads `this.profile.timezone` internally rather than taking it from the caller,
  keeping `now` as the only externally injected clock argument, consistent with every other method
  below).
- **`packages/memory/src/engine.ts:1016`**, `const today = formatDateUTC(now)` inside
  `runMaintenance`. Becomes `formatLocalDate(now, timezone)`. Everything downstream of this line,
  `pendingDailyRollups` (`engine.ts:1031`) and `pendingWeeklyRollups` (`engine.ts:1059`), is fed a
  correctly local `today` without needing to change `rollups.ts` itself (see below).
- **`packages/memory/src/engine.ts:1184`**, `formatDateUTC(now)` used as a fallback date in
  `writeSkippedSummary` when a session's own recorded date cannot be found. Becomes
  `formatLocalDate(now, timezone)`, consistent with every other date computed for that same session.
  Note that this line's value is used for two different jobs today (the `date` written into the
  summary's frontmatter, and the directory path on the next line), and Section 8 splits them: the
  local date is only ever the frontmatter value, never a path component.
- **`packages/memory/src/transcripts.ts:192-197`**, `formatDate`: a second, independently
  maintained duplicate of the same UTC logic as `formatDateUTC`, used at `transcripts.ts:58` to name
  the session directory itself: `sessions/YYYY-MM-DD-<sessionId>`. This is the highest-stakes site in
  this list and gets its own discussion in Section 8, because unlike a rollup (derived, cheap to
  regenerate) the session directory name is load-bearing for every consumer that parses it back
  (`SESSION_DIR_PATTERN`, `transcripts.ts:45`, `transcripts.ts:151-153`) and touches the transcript's
  own path, which AGENTS.md calls sacred.
- **`packages/memory/src/rollups.ts:36`**, `isoWeekOf`'s internal `Date.UTC(year, month - 1, day)`.
  **This one does not change.** It receives an already-computed date string and does pure ISO-week
  arithmetic on its year/month/day components; it has no opinion about which calendar produced those
  components. Once every caller above feeds it local dates instead of UTC dates (which happens
  automatically, since `pendingWeeklyRollups` in `engine.ts:1059` is fed `today` from the now-local
  `formatDateUTC` replacement), `isoWeekOf` correctly reports the local ISO week without a single line
  of its own code changing. Naming this explicitly, rather than leaving it to look overlooked: it was
  checked, and it is already correct by construction as long as its inputs are local.
- **Graph log timestamps** (`packages/memory/src/engine.ts:290, 322, 1311, 1350, 1428, 1532, 1577`,
  every `new Date().toISOString()` feeding a `ts` field in `graph.jsonl` or a `ReflectionItem`).
  **These also do not change**, and for a different reason than `isoWeekOf`: they are record-time
  instants in an append-only log, never rendered as a calendar day boundary anywhere, and UTC instants
  are exactly the right representation for a log meant to be sortable and unambiguous regardless of
  who reads it later or from where. The only one of these that is directly relevant to this spec is
  `engine.ts:290` (`MemoryEngine.remember`'s `ts` on a `ReflectionItem`), which gains the sibling
  `eventTime` field described in Section 2; its existing `ts` stays a UTC instant, correctly, as
  record time always should be.

## 7. Transcript timestamps

### What changes on the line itself

`TranscriptLine` (`packages/memory/src/transcripts.ts:15-21`) gains one optional field:

```ts
export interface TranscriptLine {
  ts: string          // unchanged: UTC instant, ISO 8601
  utcOffsetMinutes?: number  // new: the local UTC offset at the moment this line was written
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}
```

`ts` stays exactly what it is today: a UTC instant, the record-time anchor. `utcOffsetMinutes` is new:
the offset from UTC, in minutes, of the profile's timezone at the moment the line was written (for
example `330` for IST, `-300` for US Eastern in winter). It is captured alongside `ts` wherever a line
is appended (`AgentSession.appendBoth`, `agent.ts:357-365`, and the analogous write inside
`MemoryEngine`), computed once from the same clock read that produced `ts`, not a second lookup.

This is what makes the design honest for a person who later moves. `ts` alone can always be rendered
in whatever the *current* profile timezone is, but that would silently rewrite history: a session
that happened at 9pm Mumbai time, read back after the person moved to New York, would appear to have
happened at 10:30am, in a timezone the person was not living in when they wrote it. Storing the offset
that was actually in effect at write time means a past session can always be rendered in the wall-clock
time it actually happened in, independent of where the profile's timezone points today.

**Existing lines have no `utcOffsetMinutes`.** This spec does not backfill it, and does not guess it.
A missing offset means genuinely unknown, not "assume the current profile timezone": assuming the
current value is exactly the bug this field exists to prevent, applied retroactively. The rule: when
`utcOffsetMinutes` is absent, any rendering of that line shows only the UTC instant, labeled plainly
as UTC (for example `2026-08-16T20:12:03Z (UTC; local time unknown)`), and never a computed local time
built from a timezone the line does not actually carry. `reverie migrate` (Section 8) does not attempt
to retrofit this field either, for the same reason: there is no source of truth for what the person's
timezone was on some past date, and a wrong guess presented with the same confidence as a real value
is worse than an honest gap.

### Does the model ever see these timestamps? (Investigated)

Two different consumers read transcript lines, and they behave differently today, which matters for
whether this new field buys anything at all.

**`read_transcript` already surfaces `ts` to the chat model, unchanged.** The tool is registered in
`packages/core/src/tools.ts:156-169`, and its dispatch, `dispatchReadTranscript`
(`tools.ts:334-340`), calls `engine.readTranscript(sessionId)` and returns
`JSON.stringify(lines)` directly, with no field stripped. `MemoryEngine.readTranscript`
(`packages/memory/src/engine.ts:774-776`) is a thin pass-through to
`SessionStore.readTranscript`, which returns the raw `TranscriptLine[]`, `ts` included. So when the
model calls `read_transcript` for full fidelity on a past session, it already receives every line's
UTC instant today, and will receive `utcOffsetMinutes` the same way once this field exists, with no
change needed to `tools.ts` at all. The premise that storing time the model cannot read would buy
nothing does not hold here: it can already read it, on demand.

**Except the model has no way to obtain a session id, so "on demand" is currently unreachable, and
this spec fixes that.** `read_transcript` takes exactly one argument, `sessionId`
(`tools.ts:156-169`). The only place a session id could come from is the assembled prompt, and the
prompt drops it. `SessionContext.recentSummaries` carries `sessionId` on every entry
(`engine.ts:154`, pushed at `engine.ts:597`), but `recentSummariesSection`
(`context.ts:98-102`) renders each entry as `` `${summary.date}: ${summary.body.trim()}` `` and
discards the id. No other section renders one either. A model that decides it needs the verbatim
transcript of a past session has nothing to pass.

This is a one-line fix, and it is folded into this spec rather than deferred, because the paragraph
above is this spec's stated justification for adding `utcOffsetMinutes` at all. A justification that
depends on a broken path is not a justification. `recentSummariesSection` renders:

```ts
`${summary.date} (${summary.sessionId}): ${summary.body.trim()}`
```

producing, for example:

```
## Recent sessions

2026-08-14 (session_01K2M7X8QW9): We talked about the move and how unsettled it left him.
```

Nothing else changes: the section keeps its shape, its ordering, and its blank-line joining. The id is
already in `SessionContext`, so no new data has to be plumbed anywhere. Section 9 adds a test that an
assembled prompt contains a recoverable session id.

**Reflection cannot see any of it, and this is a real gap this spec closes.** `renderTranscript` in
`packages/memory/src/reflection.ts:191-193` is what the reflection pass actually sends to the model:

```ts
function renderTranscript(transcript: TranscriptLine[]): string {
  return transcript.map((line) => `${line.role}: ${line.content}`).join('\n')
}
```

Only `role` and `content`. `ts` is discarded entirely before reflection ever sees the transcript.
Reflection is precisely the component that would need to distinguish "the person said this at 16:19"
(record time) from "the person is describing something happening at 19:25" (event time, Section 2),
and today it has zero time information to do that with, on any line, ever. This is the actual
instance of "storing time the model cannot read buys nothing," and the fix belongs in this spec, not
deferred: `renderTranscript` is changed to prefix each line with its local wall-clock time, using the
shared renderer from `packages/memory/src/time.ts` (Section 5), rendered from `ts` and
`utcOffsetMinutes` when both are present and falling back to a labeled UTC instant when the offset is
missing:

```
[Sun 2026-08-16 21:42 UTC+05:30] user: I'm watching Halcyon tonight at 7.25pm
[Sun 2026-08-16 22:15 UTC+05:30] assistant: That sounds like a fun evening plan!
[2026-08-14T09:03:11Z (UTC; local time unknown)] user: a line written before this spec shipped
```

The zone is rendered as an offset rather than an IANA name here because an offset is all the stored
line carries; the live stamp in Section 5 renders the name because the live path knows it. Same
bracket format, same field order, one function.

This is what actually makes reflection able to populate `ReflectionItem.eventTime` sensibly: it can
now see when in the day something was said, and can reason about a stated future time relative to
that, the same way the per-message stamps let the chat model do the equivalent reasoning mid-session.

## 8. `reverie migrate`

### Command surface

A new CLI subcommand, `reverie migrate`, alongside the existing `setup`, `reindex`, `reflect`, `read`,
and `web` subcommands in `packages/cli/src/index.ts:119-181`. Run deliberately, never automatically:
`MemoryEngine.open`'s `maintenance` option (`engine.ts:234-268`) and `ensureMemoryTree` continue to
run unconditionally on every open exactly as today, but neither of them runs a migration.
`reverie migrate` is a separate, explicit command, matching decision 3: the user runs it once before
starting, not on every startup.

```
reverie migrate            # apply every pending migration
reverie migrate --dry-run  # report what would change, change nothing
reverie migrate --list     # list pending and already-applied migrations
```

### Migration registry

A migration is a small, named, idempotent unit:

```ts
export interface MigrationContext {
  paths: MemoryPaths
  configPath: string
}

export interface Migration {
  id: string                 // stable, e.g. "2026-08-local-day-rollups"
  description: string
  isPending(ctx: MigrationContext): Promise<boolean>
  apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult>
}
```

A migration takes a context object, not a bare `MemoryPaths`, and the reason is concrete. `config.toml`
is not in `MemoryPaths`: that interface (`packages/memory/src/paths.ts:9-21`) holds `root`,
`constitution`, `realmsDir`, `arcsDir`, `peopleDir`, `sessionsDir`, `rollupsDailyDir`,
`rollupsWeeklyDir`, `graphLog`, `proposals`, and `indexDb`, and nothing else. The config file lives
outside the memory folder entirely (`~/.reverie/config.toml` by default, `config.ts:108`) and is
overridable per invocation (`loadConfig(configPath?)` at `config.ts:111`, threaded from the CLI's
`deps.configPath` at `cli/src/index.ts:114, 196` and from `server/src/launch.ts:19`). A migration that
needs to read or rewrite `config.toml`, which the companion modes spec's config-to-profile move does,
cannot find it from `MemoryPaths` and must not guess the default path, because the user may have
passed `--config`. Widening the context now costs one field and avoids changing every migration's
signature later.

A registry (`packages/memory/src/migrations/index.ts`, a plain ordered array of `Migration` objects)
is what `reverie migrate` iterates. Applied migrations are recorded, one line each, in a new
append-only log at `<memoryDir>/migrations.jsonl` (`{ id, appliedAt }`), read at the top of `apply`
to make `isPending` cheap (a set-membership check) rather than requiring every migration to inspect
the whole folder on every run. This log is the reason `reverie migrate --list` can distinguish
"pending" from "already applied" without re-deriving it from folder contents each time, and it is
what decision 3 means by "design it as a migration registry so later specs can register additional
steps": the config-to-profile move in
[Modes, profile, and settings](2026-08-16-modes-profile-settings-design.md) registers its own
`Migration` entry in this array later.

This spec registers two migrations:

**Migration 1: `profile-seed`.** For any memory folder opened for the first time after this spec
ships that predates `profile.md` (detected by the file's absence), writes it with a system-default
timezone, `timezoneSource: 'system-default'`, exactly as `ensureMemoryTree` would for a brand-new
folder. This exists because `ensureMemoryTree` only seeds a missing file on the *next* open, and an
explicit migration step makes that seeding an auditable, listed action rather than a silent side
effect the user never sees named.

**Migration 2: `utc-to-local-rollups`.** Every existing `rollups/daily/<date>.md` and
`rollups/weekly/<week>.md` file was dated by UTC day/week arithmetic. Rollups are derived documents,
synthesized by an LLM call from session summaries (`buildDailyRollup`, `buildWeeklyRollup`,
`rollups.ts:109-181`); they are not sacred the way transcripts are, and are already documented as
rebuildable from source. This migration does not try to re-date existing rollup files in place
(a `2026-08-16.md` file renamed to `2026-08-15.md` based on a session that turns out to belong to a
different local day is not a safe filename operation to script correctly for every edge case, and the
LLM-synthesized prose inside would still describe whatever the old boundary grouped together). Instead
it **deletes every existing daily and weekly rollup file** and lets the next `runMaintenance` pass
regenerate them from session summaries using local-day boundaries. Session summaries themselves are
untouched (they are keyed by the session directory, addressed separately below); only the derived
rollups are discarded and rebuilt. This is reported plainly in `--dry-run` output: "would delete N
daily and M weekly rollup files; they will be regenerated with local-day boundaries on next use," so
the user knows their next `reflect` or session-close call does real LLM work before it runs.

### The hard case: session directory names

Rollups are cheap to discard and regenerate. The session directory is not: `sessions/YYYY-MM-DD-
<sessionId>` is the address `transcript.jsonl` lives at, parsed back by `SESSION_DIR_PATTERN`
(`transcripts.ts:45`) and by `listSessions` (`transcripts.ts:151-153`), and that date feeds
`recentSummaries`, `isFirstSession`, and every rollup date computed above. Under a local-day switch, a
session that started at 2:00am IST is currently filed under the UTC date, which is the previous
calendar day; after this spec, the correct local date is one day later than what the directory name
says.

Renaming the directory would move `transcript.jsonl` to a new path. AGENTS.md's "transcripts are
sacred: append-only, never modified, never deleted by code" is about content, not filesystem location,
but a path rename is exactly the kind of structural change to a sacred artifact that this spec will
not wave through without saying so plainly, so the choice is stated rather than assumed:

**Decision: the session directory name is left alone. `reverie migrate` does not rename any session
directory, ever.** Instead, the directory's date prefix is treated as what it always practically was
underneath the parsing code: an opaque disambiguator, not a claim about which calendar day the
session belongs to. The one place a session's day is treated as authoritative for local-day logic
(recent-summaries windowing, rollup grouping) already reads `session.date` off `listSessions`
(`transcripts.ts:140-177`), and that becomes the seam: `listSessions` derives `date` as a **logical**
local date rather than reading it off the directory name.

**`listSessions` must return the directory name too, and every path must be built from that.** This is
not optional polish; without it the change silently breaks context assembly. `listSessions`' return
type becomes:

```ts
{ sessionId: string; dirName: string; date: string; reflected: boolean; skipped: boolean }[]
```

`dirName` is the directory name exactly as `readdir` produced it, prefix included. `date` is the
derived logical local date. **`dirName` is the only thing that may ever be used to build a path;
`date` is only ever used for windowing, grouping, and display.** Three call sites reconstruct the
on-disk directory today by concatenating `date` and `sessionId`, and all three break the moment the
two disagree, which is the entire point of the change:

- **`packages/memory/src/engine.ts:591-595`**, `sessionContext`. Builds
  `` join(this.paths.sessionsDir, `${session.date}-${session.sessionId}`, 'summary.md') `` and calls
  `readDocument` on it. `readDocument` throws on a missing file, and this is inside context assembly,
  which runs on every session start. A derived date one day off the directory prefix means every
  session start throws. Becomes `join(this.paths.sessionsDir, session.dirName, 'summary.md')`.
- **`packages/memory/src/rollups.ts:125-129`**, `buildDailyRollup`. Identical construction, identical
  throw, this time inside rollup synthesis. Becomes `join(deps.paths.sessionsDir, session.dirName,
  'summary.md')`.
- **`packages/memory/src/engine.ts:1183-1186`**, `writeSkippedSummary`. Worse than the other two,
  because it **writes**: `const date = session?.date ?? formatDateUTC(now)` and then
  `` join(this.paths.sessionsDir, `${date}-${sessionId}`) ``. A derived date creates a second
  directory beside the real one, holding a `summary.md` for a session whose transcript lives
  elsewhere, which then makes that session look permanently unreflected and get retried forever. This
  site stops reconstructing the path at all: it resolves the directory the same way everything else
  that opens a session by id does, by suffix match on `-${sessionId}`, which `transcripts.ts:199-206`
  already implements privately as `findSessionDir` and which this spec exposes as
  `SessionStore.sessionDir(paths, sessionId)`. The local date computed from `now` remains, but only as
  the `date` value written into the summary's frontmatter, never as a path component.

A fourth site was found during this pass and is the one that makes the design work: **`applyReflection`
(`packages/memory/src/reflection.ts:590-591`)** already resolves the directory correctly, by its own
private `findSessionDir` (`reflection.ts:342-350`), so its path construction is safe as it stands. But
that same function returns `date` by parsing the directory name's prefix (`reflection.ts:348-349`), and
that `date` is what gets written into `summary.md`'s frontmatter at `reflection.ts:713`. That is the
one place the logical date is durably recorded, so that is where it must be derived from the
transcript's first line instead of from the directory string. It also collapses to
`SessionStore.sessionDir`, with the date computed separately.

### What the derived date costs, honestly

`listSessions` today reads no transcript at all. It does one `readdir`, then per directory an `access`
on `summary.md` and, when that exists, a `readDocument` of it (`transcripts.ts:143-176`). Deriving a
date from the transcript would mean opening and parsing transcripts on a path that runs on every
session start (`sessionContext`), on every maintenance pass, inside `buildDailyRollup`, inside
`describe`, and on every server session create. Implemented naively through
`SessionStore.readTranscript`, which `readFile`s the entire file and `JSON.parse`s every line, this is
O(total bytes of every transcript ever written) per call. For a person a year in, that is tens of
megabytes read and parsed before the first token of a new session. That is not acceptable, and the
spec is not going to pretend otherwise.

The derivation is therefore layered, cheapest source first:

1. **Reflected sessions read it from `summary.md`'s `date` frontmatter**, which `listSessions` is
   already reading for its `skipped` check (`transcripts.ts:165-166`). Zero additional file reads.
   This is sound because `summary.md`'s `date` is written from the transcript's first line by
   `applyReflection` (above) and by `writeSkippedSummary`, so it is the derived value, cached at the
   moment it was computed. `listSessions` already wraps that `readDocument` in a `try/catch`
   (`transcripts.ts:167-172`) that swallows a parse failure and defaults `skipped` to `false`. That
   same catch now also means "no date available," and it falls through to step 2 rather than inventing
   one, which keeps a corrupt or hand-broken `summary.md` from silently re-dating its session.
2. **Unreflected sessions read the first line of `transcript.jsonl` only**, through a bounded read: a
   file handle, one chunk (8KB is more than enough for a first line), split at the first newline,
   `JSON.parse` of that one line, handle closed. Not `readTranscript`. There are only ever a handful
   of unreflected sessions at a time (reflection runs at session end), so this is a small constant.
   The local date comes from that line's `ts` and its own `utcOffsetMinutes`.
3. **A transcript with no lines at all** (possible after a crash mid-`SessionStore.start`), or a first
   line with no `utcOffsetMinutes` (an unreflected session written before this spec), falls back to
   the directory's own date prefix, exactly as today. The second case follows Section 7's rule
   directly: with no recorded offset there is no honest local date to compute, so none is invented.

**Freezing the date at write time is a correctness requirement, not only a performance one.** If the
logical date were recomputed on every call from the *current* profile timezone, then a person moving
from Mumbai to New York would silently re-date every past session. Sessions would move between days,
`pendingDailyRollups` would see uncovered dates it had already rolled up under the old grouping, and it
would synthesize duplicate rollups beside the now-orphaned originals. Reading the date from
`summary.md` avoids this: it is computed once, from that session's own first line and the offset in
effect then, and never recomputed.

### This fix is forward-only, and that is deliberate

Sessions written before this spec have a `summary.md` whose `date` is the old UTC-derived value, equal
to the directory prefix. **Those stay as they are.** No migration re-dates them.

The alternative would be a migration that recomputes every past session's date from its transcript's
first line. It cannot be done honestly: pre-spec transcript lines carry no `utcOffsetMinutes`
(Section 7), so the only available conversion is through the *current* profile timezone, which is
precisely the "assume the current value" guess that Section 7 refuses for `utcOffsetMinutes` itself.
Doing in Section 8 what Section 7 forbids would be incoherent. A past session keeps the date it was
filed under; new sessions get the correct local date from the day this ships.

`reverie migrate` therefore needs no step for session directories at all, and this spec still registers
exactly two migrations.

Every other consumer of a session directory name was audited and needs no change:
`SESSION_DIR_PATTERN` (`transcripts.ts:45`) keeps parsing the prefix, now understood as a
disambiguator; `findSessionDir` (`transcripts.ts:199-206`) matches on the id suffix and never on the
date; the reindex walk (`engine.ts:1259-1265`) reads directory names straight from `readdir` and joins
`summary.md` onto them, which is already dirName-based and correct. One cosmetic note:
`SessionStore.describe` (`transcripts.ts:124`) uses `` `${session.date}T00:00:00.000Z` `` as a
`createdAt` fallback, so that fallback now means local-midnight-as-if-UTC. It is only reached when the
session id is not a decodable ULID, which is effectively never, and it is a display value, not a key.

### Dry run and idempotency

`--dry-run` runs every registered migration's check-and-report path (what `profile-seed` would write,
how many rollup files `utc-to-local-rollups` would delete) without calling `apply`. Every migration's
`isPending` check is what makes re-running `reverie migrate` on an already-migrated folder a no-op:
`profile-seed` checks for `profile.md`'s existence, `utc-to-local-rollups` checks `migrations.jsonl`
for its own id. Running `reverie migrate` twice in a row does the work once and reports "nothing
pending" the second time.

## 9. Testing plan

AGENTS.md requires TDD for deterministic logic: write the failing test first for every pure function
this spec introduces or changes, and validate LLM-dependent behavior (reflection's `profileUpdates`,
the live `update_profile` tool's argument shape) with fixture transcripts and schema assertions, not
golden text.

**Determinism requires two injected values everywhere, not one.** Every function touched by this spec
already takes (or gains) an injectable `Date`, per the existing `now: Date = new Date()` pattern
(`engine.ts:274, 526, 990`). This spec adds a second injected value alongside it wherever local-day or
stamp-rendering logic is involved: the IANA timezone string, passed explicitly rather than read from
`Intl.DateTimeFormat().resolvedOptions().timeZone` inside the function under test. **Do not use the
`TZ` environment variable to control timezone in tests.** It is process-wide, and vitest tests can run
with parallelism inside one process; a `TZ`-dependent test racing another test that also touches `TZ`
is exactly the kind of flake this codebase's testing discipline exists to avoid. Every test threads
the zone as a plain string argument.

Representative test cases:

- `formatLocalDate(new Date('2026-08-16T20:12:00Z'), 'Asia/Kolkata')` returns `'2026-08-17'`, not
  `'2026-08-16'`. This is the direct falsification of defect 2: written against `formatDateUTC` before
  the change, this exact input returns `'2026-08-16'`, and the test fails. Restoring the old function
  under the new test name must fail visibly, per AGENTS.md's falsify-do-not-read discipline.
- The message stamp renderer, with a fake clock at `2026-08-16T20:00:00Z` and a timezone of
  `Asia/Kolkata`, produces exactly `[Mon 2026-08-17 01:30 Asia/Kolkata]`. Swapping the implementation
  back to a UTC render must make this test fail on the date specifically (`2026-08-16`, and a Sunday),
  not merely on formatting, which is the falsification for defect 1.
- `AgentSession` prefix stability, which is the falsification for the caching claim in Section 5 and
  replaces the old per-round now-block test with its opposite: a fake `ChatProvider` records every
  `{ system, messages }` it receives across two rounds of a single `send()` call (round 1 returns a
  tool call, round 2 returns text), with the injected clock advanced between rounds. Two assertions.
  First, the `system` string must be **byte-identical** across both rounds. Reintroducing a per-round
  `new Date()` into the system string, which is exactly the design this spec rejected, must make it
  fail. Second, round 2's `messages` array must begin with round 1's, element for element by deep
  equality, and be longer by exactly the assistant tool-call line and the tool result line that the
  round appended. Any rebuild of `history` between rounds (from disk, or with re-rendered stamps)
  must make it fail.
- `AgentSession` stamping, across two `send()` calls with the clock advanced between them: the fake
  provider's second request must contain two user messages whose stamps differ, in the order they
  were sent, and the first user message's stamp must be byte-identical to what the first request
  carried. Separately, the transcript on disk must hold the **unstamped** content for those lines,
  with the time in `ts` and `utcOffsetMinutes`. Making `appendBoth` write the stamped string to disk
  must fail that half; re-rendering the first stamp on the second call must fail the first half.
- `pendingDailyRollups` and `pendingWeeklyRollups` (`rollups.ts`) are already pure and already tested
  against injected date-string arrays; their existing tests continue to pass unmodified, since their
  own logic does not change (Section 6). New tests cover only their callers in `engine.ts` now
  supplying local dates.
- `isoWeekOf` is not tested in isolation for being unchanged, because "the same before and after this
  spec" is not observable from inside one version of the code, and a test that reads
  `isoWeekOf('2026-08-16') === '2026-W33'` would pass identically whether or not its callers were
  fixed. The claim that matters is about its caller, so the test is at caller level:
  `runMaintenance` with an injected clock of `2026-08-16T20:00:00Z`, a timezone of `Asia/Kolkata`, a
  fixture folder holding one reflected non-skipped session dated `2026-08-16`, and no existing rollup
  files. Local today is `2026-08-17`, so `2026-08-16` is strictly before today and a daily rollup is
  built for it; `2026-08-16` is a Sunday in ISO week `2026-W33` while `2026-08-17` is a Monday in
  `2026-W34`, so that freshly written daily is in a completed week and the weekly `2026-W33` is built
  in the same pass. Assert both files exist, at `rollups/daily/2026-08-16.md` and
  `rollups/weekly/2026-W33.md`. Reverting the caller to `formatDateUTC` makes local today
  `2026-08-16`, which is neither strictly after the session date nor in a later ISO week, so **zero**
  rollups are built and both assertions fail. Two implementation notes for whoever writes it: the
  weekly leg only fires in the same pass because `runMaintenance` re-reads `dailyDates` from disk
  after the daily loop (`engine.ts:1050-1053`), and the fake `ChatProvider` must therefore serve two
  completions, daily then weekly.
- `listSessions`' date derivation and `dirName`: a session directory named with one date, containing a
  `summary.md` whose `date` frontmatter is a different date, must report the summary-derived date as
  `date` **and** the directory's own name as `dirName`. Reverting to reading the directory prefix for
  `date` must make this test fail.
- **End-to-end against a divergent session, which the `listSessions` test above cannot catch.** The
  isolated test asserts on `listSessions`' return value, so it would pass unchanged even if all three
  path-building call sites in Section 8 were left reconstructing `` `${date}-${sessionId}` `` and
  throwing on every call. Three tests exercise the consumers directly, against a fixture where the
  directory is `sessions/2026-08-15-session_X` and the `summary.md` inside it carries
  `date: 2026-08-16`:
  - `sessionContext()`, with its injected clock set close enough to that date that the session falls
    inside the recent-summaries window, returns without throwing, and its `recentSummaries` entry for
    that session carries `date: '2026-08-16'` with the body read out of the file that actually exists.
    Reverting `engine.ts:591-595` to the concatenated path makes `readDocument` throw `ENOENT` and
    fails the test at session-start, which is exactly the production failure being guarded against.
  - `buildDailyRollup(deps, '2026-08-16')` finds that session's summary and synthesizes from it.
    Reverting `rollups.ts:125-129` to the concatenated path makes it throw.
  - A third, for the write path: `writeSkippedSummary` on a session whose directory prefix differs
    from its logical date writes `summary.md` into the existing directory, and the sessions directory
    afterwards contains exactly one directory for that session id. Reverting `engine.ts:1183-1186`
    creates a second directory and fails the count assertion.
- An assembled system prompt containing a recent session summary must contain that session's id as a
  recoverable substring: build a `SessionContext` whose `recentSummaries[0].sessionId` is a known
  literal, call `assembleSystemPrompt`, and assert the exact id string appears in the output.
  Reverting `recentSummariesSection` to `` `${summary.date}: ${summary.body}` `` must make it fail.
  This is the falsification for Section 7's claim that the model can reach `read_transcript` on its
  own, which is that section's justification for storing `utcOffsetMinutes` at all.
- `profileMetaSchema` rejects an invalid IANA string (e.g. `'Nowhere/Fake'`) and accepts a valid one;
  a schema fixture test with `.passthrough()` verified by asserting an unrelated extra key survives
  parsing unchanged, falsifying that a future spec's field addition would not be silently dropped.
- `reverie migrate --dry-run` against a fixture folder with three existing rollup files reports three
  pending deletions and **changes nothing on disk**, asserted by hashing the entire memory folder
  before and after the run and comparing the two hashes for byte equality, the same technique this
  section already uses for transcripts below. A report-versus-report comparison across two dry runs
  only catches a dry run that is stateful in its own reporting; a folder hash catches a dry run that
  writes anything at all, including a file the report never mentions. The hash walks the folder
  recursively in sorted path order and hashes each file's path and bytes, excluding `index.db` and
  `*.tmp-*`, the two entries the seeded `.gitignore` already names (`paths.ts:63-68`): the SQLite
  index is a derived artifact an open engine can touch for reasons unrelated to the migration, and
  hashing it would make the test flaky rather than strict.
- `reverie migrate` run twice against the same fixture folder: the second run's migration list is
  empty (idempotency), and the transcript files present before the first run are byte-identical after
  both runs (a hash comparison, not a visual read), which is the concrete evidence behind Section 8's
  claim that no transcript is ever touched.

## 10. Deferred

- **A `current_time` tool.** Not built now. The gap it would cover is narrow and known: a single turn
  whose tool-call loop runs long (`MAX_TOOL_ROUNDS = 8`, `agent.ts:29`) has only one stamp for the
  whole turn, the one on the user message that opened it, because Section 5 deliberately does not
  re-stamp per round. If that turns out to matter in practice, a tool the model can call mid-reasoning
  for an on-demand timestamp is the documented fallback. Held back deliberately: adding a tool the
  model may or may not call reliably is a weaker guarantee than a value that is simply always present
  in context, and per-message stamps should be given a real chance to be sufficient on their own
  before a second, optional mechanism is layered on top of them.
- **Structured event-time resolution.** `ReflectionItem.eventTime` (Section 2) is free text, not a
  resolved instant. Parsing "tonight," "next Tuesday," or "sometime in the fall" into an actual
  timestamp, and reasoning about relative dates reliably, is a meaningfully larger project (it implies
  a resolution model, ambiguity handling, and probably a re-resolution pass as record time moves
  forward) and is out of scope here. This spec's job was giving the model a clock to reason with in
  plain language; formalizing that reasoning into structured data is future work.
- **Migrating the remaining identity facts out of constitution prose and into `profile.md`.** Section
  3 moves exactly one fact, `timezone`, because it is the only one this spec's code needs to parse back
  out. Which of the others move, and where each lands, is owned by
  [Modes, profile, and settings](2026-08-16-modes-profile-settings-design.md), which rewrites the
  `reflection.ts:230` sentence in full. This spec takes no position on that list.
- **Backfilling `utcOffsetMinutes` on existing transcript lines**, and, for the same reason,
  re-dating existing sessions (Section 8). Neither is attempted, because there is no reliable source
  for what timezone a past session was actually written in, and a guess presented as fact is worse
  than an honest gap.
- **Cache-control breakpoints in `@openreverie/providers`.** Section 5's per-message stamping keeps the
  request prefix byte-stable by construction, which is what OpenAI's automatic prefix caching needs,
  but this spec does not add explicit `cache_control` plumbing to `ChatRequest`
  (`packages/providers/src/types.ts:27-34`), and it has not measured actual cache hit rates against
  any provider. If a future provider or a measured cache-hit-rate problem calls for explicit
  breakpoints, that is a `providers` change on its own.

## 11. Open questions

- **Where exactly does `MemoryEngine` cache the loaded profile, and what invalidates it across process
  boundaries?** This spec assumes one `MemoryEngine` instance per running process (true for the CLI
  and, per package boundaries, presumably true for `server` as well), so an in-memory cache refreshed
  on write is sufficient. If a future architecture runs multiple `MemoryEngine` instances against the
  same memory folder concurrently (two CLI sessions, or a CLI session alongside a running server), a
  profile update from one would not be visible to the other until it happens to reload. This is not
  new to this spec (`config.style` already has the identical property today), but it is worth naming
  as a boundary this spec does not solve, in case `server`'s existing concurrency story already has an
  answer that should be reused rather than re-invented later.
- **Does the web package (`packages/web`) need its own local-time rendering, or does it only ever
  display what `server` sends it?** This spec is scoped to `core`, `memory`, and `cli`; if `server`'s
  HTTP responses currently carry raw UTC transcript timestamps out to `web` for display, that surface
  would want the same local-rendering treatment described in Section 7, but auditing `server`'s
  response shapes was out of scope for this pass and is worth a follow-up look before implementation
  begins.
