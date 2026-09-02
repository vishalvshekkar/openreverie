# Modes, profile, and settings design

Date: 2026-08-16
Status: decisions approved by the project owner; the design detail below is written for review
Target release: v0.6.0, after the time spec it depends on
Scope: separate per-session intent from persistent preference, move every personal setting out of
`config.toml` into `profile.md`, give the CLI a real command parser and a session status line, give
the web interface a mode picker and a settings pane, and add a settings endpoint that cannot expose
the API key.

Extends [Time as a first class concern](2026-08-16-time-as-first-class-design.md), which introduces
`profile.md` at the root of the memory folder (a zod schema, one loader, atomic writes, `timezone` as
its first field) and the `reverie migrate` command built as a migration registry. This spec does not
redefine either of those. It adds fields to that schema and one step to that registry.

If you have not read that spec: `profile.md` is a markdown file at `<memoryDir>/profile.md` holding
machine-readable frontmatter about the person plus a short prose body. It uses the same document
primitive as everything else in the folder (`readDocument`, `writeDocumentAtomic`), is loaded through
`loadProfile(paths)`, is validated by a deliberately non-strict zod schema, and is not indexed. The
time spec owns all of that; everything below builds on it.

Two sibling specs written the same day touch this one:

- [Journal mode](2026-08-16-journal-mode-design.md) owns everything about the `journal` mode beyond
  its existence in the catalogue: its protocol, its `journal/` directory, its `journaling.md`
  configuration file, and its safety gates. It assumes this spec provides a `journal` mode value and
  makes a session's mode reachable from the memory layer. Section 9.4 provides both.
- [CLI polish and CI flake fix](2026-08-16-cli-polish-and-ci-fix-design.md) owns the argv surface
  (`--version`, `--help`, `doctor`, exit codes, `--config`). It does not touch in-session slash
  commands, which are this spec's section 10. The two parsers are separate and stay separate: one
  reads `process.argv` before a session exists, the other reads lines typed into a running session.

## 1. What is wrong today

**Personal preference is stored in the infrastructure file.** `style` (engagement, tone,
orientation) lives in `config.toml` (`packages/core/src/config.ts:23-27`, `:66-70`, `:77`), asked
during `reverie setup` (`packages/cli/src/setup.ts:127-206`) and rendered into the system prompt one
paragraph per axis (`packages/core/src/personas.ts:69-114`). The same file holds the provider API
key and is written with mode 0600 for exactly that reason (`config.ts:156`). A preference about how
someone likes to be spoken to now sits in the file that must never be read out over HTTP.

**There is no settings surface at all.** The web interface has three destinations, Talk, Atlas and
Record (`packages/web/src/App.tsx:7-15`), and the server exposes no config or profile endpoints
(`packages/server/src/app.ts:97-348`). The only ways to change style are to ask the model in
conversation or to hand-edit TOML.

**Asking the model does not work in the browser.** `update_style` is dispatched through an injected
persister (`packages/core/src/tools.ts:24-26`, `:366-391`), which only the CLI wires up
(`packages/cli/src/index.ts:171`, `packages/cli/src/chat.ts:327-337`). The server starts sessions
with no tool dependencies at all (`packages/server/src/registry.ts:149`), so in the web interface
every `update_style` call returns `update_style is not available in this session: no persister is
configured` (`tools.ts:370-372`). The user asks the companion to be more direct, the companion says
it has done so or reports a confusing failure, and nothing changes. That is a live bug, not a
missing feature.

**Nothing expresses what a particular conversation is for.** Every session has the same shape. A
user who wants to be listened to without being fixed, or who wants a problem worked to a decision,
has no way to say so except in words the model may or may not honour for the rest of the session.
`update_style` conflates the two: "be more direct with me today" rewrites the config file
permanently.

**Facts about the person have no machine-readable home.** Reflection is instructed that name,
pronouns, location, timezone and occupation belong in the constitution
(`packages/memory/src/reflection.ts:230`), and the constitution reaches the model as prose
(`packages/core/src/context.ts:67-71`). Nothing can read those facts back as data. A status line
cannot render the user's local time, `/whoami` would have nothing to read, and the same fact can
drift across two paragraphs of prose with no arbiter.

**Onboarding collects facts and then loses them.** The first-conversation prompt asks for name and
pronouns, then location and timezone, then one current thing, one question at a time
(`context.ts:53-60`). The answers land in prose or nowhere. Birthday is never asked and never
stored.

**The CLI has one command.** `/bye` is compared as a string in the input loop
(`packages/cli/src/chat.ts:237`); everything else is sent to the model (`chat.ts:223-234`).

**Correction to the brief for this spec.** The brief states that the CLI "already has a status line
with a timer" and describes the work as extending it. That is not what the code does.
`createStatusLine` (`packages/cli/src/status.ts:34-79`) is a transient spinner: it runs only between
the end of a turn and the first output, its elapsed counter starts at the current label rather than
at the session, and it returns no-op `start`/`stop` when `colorEnabled` is false
(`status.ts:35-40`), so it never renders at all when stdout is not a TTY or `NO_COLOR` is set. The
persistent strip this spec asks for is a second, separate component. Section 11 specifies both and
how they coexist.

## 2. Style and mode are two different things

| | Style | Mode |
| --- | --- | --- |
| What it is | How reverie talks with this person in general | What this particular conversation is for |
| Lifetime | Persistent, across sessions | One session, discarded at session end |
| Stored | `profile.md` frontmatter | Nowhere. Session state only |
| Changed by | `/style`, the web settings pane, `reverie setup` | `/mode`, the web mode picker, asking the companion mid-conversation |
| Changed by asking the model | Never | Yes, that is the point |
| Default | Whatever is in `profile.md` | `general` |
| Visible where | `/whoami`, settings pane, status line (tone) | Status line, `/mode`, the mode picker |

The split resolves the ambiguity in "be more direct." Said as a lasting preference it belongs in
`profile.md` and should be a deliberate act, not a side effect of one sentence in one conversation.
Said as an intent for right now it belongs to the session and should take effect immediately without
touching any file.

So the model can no longer change style. When someone asks it to talk differently in a lasting way,
it points them at `/style` (or the settings pane in the browser) and says plainly that it does not
change that setting itself. When someone asks for something this conversation needs, it calls
`set_mode` and the conversation changes shape at once.

## 3. `profile.md`, and the three-file ownership rule

### 3.1 Ownership

Three files, three jobs, no overlap:

- **`config.toml` holds infrastructure.** Provider, API key, model names, memory folder path, safety
  mode, crisis resources. Nothing personal. No code that reflection runs ever writes to it.
- **`profile.md` holds machine-consumable facts about the person.** Short, structured, individually
  addressable values, plus a short prose body for nuance that does not fit a field.
- **`constitution.md` holds meaning and narrative.** Who this person is, what holds steady, what
  changed and what it meant.

The dividing line, with one example: `location: Bangalore` is profile.
"Moved to Bangalore and the move landed harder than expected" is constitution. The fact is a field.
What the fact means is prose.

The time spec draws the same three-file line but places it differently, and the difference is
deliberate rather than accidental. It moves exactly one field, `timezone`, on the narrower rule that
only a value code has to feed into `Intl.DateTimeFormat` belongs in frontmatter, and it says so while
noting that "more fields may migrate later." This spec is that later. The rule widens from "code has
to parse it" to "it is a fact rather than a meaning," because a status line has to render a name, a
settings pane has to show a location, and `/whoami` has to list what is known without a model in the
loop. Where the two specs disagree, this one is the later decision and wins.

`occupation` moves to `profile.md` as a field, not a boundary marker held back in the constitution.
The general rule, restated: **profile holds the current value of a fact; constitution holds its
history and its meaning.** `occupation: nurse` is the value code needs today: it renders in
`/whoami`, the settings pane, and the assembled prompt like any other profile fact (section 3.2).
"Left the old place after two years and it took months to stop feeling like a failure" is
constitution regardless of what the field currently says, and a later profile write must not touch
it. A job change is the test case: the field is overwritten to the new value, the constitution
narrative about the old job stays exactly as it was written. Overwriting the field is safe because
the memory folder is git-backed and reflection commits it on every maintenance pass: the prior value
is one commit away, not gone.

A fourth root-level file, `journaling.md`, is introduced by the journal spec and holds that mode's
configuration. It follows the same rule: structured configuration in frontmatter, no facts about the
person duplicated from `profile.md`.

Safety mode stays in `config.toml` even though it is personal. It is safety-critical, it is chosen
deliberately at setup with no default offered (`setup.ts:81-93`, `config.ts:59-60`), and reflection
writes to `profile.md`. A file a model writes into must not be the file that decides crisis
behaviour.

### 3.2 Fields

The time spec introduces the file with `timezone`. This spec adds the rest. Every field is optional,
every unset field means unknown, and no field is ever inferred:

| Field | Type | Set by | Notes |
| --- | --- | --- | --- |
| `preferredName` | string | onboarding, reflection, settings | What to call them, which is not necessarily their legal name |
| `pronouns` | string | onboarding, reflection, settings | Free text, not an enum. "they/them", "she/her", "he/him or they/them" are all valid |
| `location` | string | onboarding, reflection, settings | Where they live, as they say it |
| `timezone` | IANA zone | time spec | Defined there, with `timezoneSource`. Named here only because the status line reads both |
| `birthday` | `MM-DD` or `YYYY-MM-DD` | reflection, settings | Year optional. Never asked during onboarding (section 15) |
| `occupation` | string | reflection, settings | Current role, as they describe it. Holds the current value only; the history and the meaning of a job stay in the constitution (section 3.1) |
| `birthdayGreetings` | boolean | settings, and once when birthday is first recorded | Defaults to true when a birthday is first recorded, with an offered opt-out. Once answered, never asked again |
| `style.engagement` | `leading` / `balanced` / `following` | `/style`, settings, setup | Same enums as today (`config.ts:66-70`), before the move described just below |
| `style.tone` | `warm` / `playful` / `snarky` / `direct` / `formal` | `/style`, settings, setup | |
| `style.orientation` | `listening` / `balanced` / `solutions` | `/style`, settings, setup | |

**The style types move with the field.** `StyleConfig` and its three enums (`engagement`, `tone`,
`orientation`) live today in `packages/core/src/config.ts:23-27` and `:66-70`. This spec moves
`style` into `profile.md`, whose schema lives in `@openreverie/memory`, and AGENTS.md's dependency
rule is downward-only: `core` depends on `memory`, never the reverse. So the types move down, not
sideways: the three enums and the `StyleConfig` type relocate into `@openreverie/memory`, exported
alongside `Profile` and `ProfileMeta`, and `packages/core/src/personas.ts`, which renders the axis
paragraphs, imports them from there. Nothing in `@openreverie/memory` imports anything from
`@openreverie/core`, before or after this change; a lint rule, or an import-graph test alongside the
existing package-boundary tests, fails the build if it ever does. `config.ts` keeps no reference to
the enums once the migration in section 4 removes the `[style]` table, so there is nothing left there
to import.

These are added to `ProfileMeta` and `profileMetaSchema` as defined by the time spec, keeping its
`.passthrough()` posture: a key this schema does not know about is preserved on read and on write
rather than rejected, because the profile is an open, growing set by design. Strictness belongs at
the boundaries a mistake can actually arrive at instead: the two MODEL-WRITE schemas below, and the
HTTP schema in section 13.2, which is a third, separate strict object again, not either of the
MODEL-WRITE ones, since the settings pane is not a model surface and its `PATCH` body legitimately
includes `style` and `prose`.

**Two schemas, not one.** The FILE schema, `profileMetaSchema`, owned by the time spec, stays
`.passthrough()` as above: it governs reading `profile.md` and hand edits to it, and the file is
meant to grow keys the schema does not yet know about. It is not the schema that decides what a
model may write.

Two separate MODEL-WRITE schemas govern that instead, one for each write surface: the live
`update_profile` tool's arguments (`updateProfileArgsSchema`), and reflection's `profileUpdates`
field in `RESPONSE_SHAPE` (`profileUpdatesSchema`). Both are `z.strictObject`s over the same
enumerated allowlist: `preferredName`, `pronouns`, `location`, `timezone`, `birthday`, `occupation`,
`birthdayGreetings`, every key optional. `style.engagement`, `style.tone` and `style.orientation` are
absent from that allowlist by type, on both schemas, so there is no representable call, from either
surface, that sets one. That absence is what makes the rule enforceable rather than a convention: add
`style` to either allowlist and the corresponding test in section 16.2 fails, because the schema
itself would accept what the rule says it must not.

The two write schemas are declared separately, not shared as one object, because they answer to two
different boundaries (a tool call's arguments, and a structured-output field validated the same way
`constitutionUpdate` is) and a mistake in one must not be silently papered over by the other.

Three rules about who may write what:

- **The model may write facts it was told and consent answers it collected. It may never write
  style.** That is the whole rule for both MODEL-WRITE schemas: `preferredName`, `pronouns`,
  `location`, `timezone`, `birthday` and `occupation` are facts, `birthdayGreetings` is a consent
  answer, and none of the three style axes appear on either allowlist, at all, ever. This is
  structural rather than instructional: neither schema has a `style` key, so there is no
  representable call that sets one. Style changes only through `/style`, the web settings pane, and
  `reverie setup`. This is what makes the split in section 2 real rather than a convention the model
  can quietly ignore.
- **Reflection may fill an unset field, and may change a set field only when the user has said
  something that contradicts it.** There is no provenance tracking in this release, so the effective
  rule is last write wins. Provenance (which surface set a field, and when) is deferred; section 17.
- **Nothing is inferred.** No field is ever populated from a guess: not pronouns from a name, not
  location from a timezone, not a birthday from an offhand "I'm turning thirty this year." The one
  exception is `timezone`, which the time spec seeds from the host machine and marks
  `timezoneSource: 'system-default'` precisely so the guess is labelled as one.

**The fields reach the model too, not only the prose.** `assembleSystemPrompt` renders a `## Profile`
section holding whichever of these fields are set, one line each, in this fixed order:
`preferredName`, `pronouns`, `location`, `birthday`, `occupation`, `birthdayGreetings`. An unset
field renders nothing at all: no line, no placeholder, never `unknown`, because a field the prompt
claims is unknown when it is actually just absent is indistinguishable from one that failed to load.
`birthdayGreetings` renders only once `birthday` is itself set, since the value is meaningless before
that (section 15.2). `timezone` is deliberately excluded here: the time spec's now-block already
carries it, and duplicating it in a second block invites the two to drift. `style.*` is excluded too,
structurally, because the style axes render through their own paragraphs in `personas.ts`, not as raw
values. When every field is unset the whole `## Profile` heading is omitted rather than printed
empty. This is the fix for the regression this spec's own review turned up: section 14 states plainly
that once the user gives their pronouns "the model uses them from then on," and that is only true if
the assembled prompt actually contains them.

The prose body carries what a field cannot: "prefers to be called Vish by everyone except his
mother", "recently moved and still says the old city by accident." It sits in the same `## Profile`
section, after the fields, and goes into the system prompt the way the constitution already does
(`context.ts:67-71`). The file stays out of the index either way, per the time spec: this block
reaches the model because it is assembled into the prompt, not because `search_memory` can find it.

The prose body is capped at 2,000 characters when it is assembled into the prompt. That is long
enough for several sentences of real nuance, the kind the `Vish` and `recently moved` examples show,
and short enough that a body straining past it is drifting into constitution territory rather than
staying the short block section 3.1 describes it as. `profile.md` on disk is never truncated: the cap
applies only at prompt-assembly time, in `assembleSystemPrompt`, the same file that already has three
other unbounded-prompt cases a separate, fifth spec owns. A body over the cap is cut at the character
limit and gets a trailing marker, `… [truncated]`, appended, so the model and anyone reading the
assembled prompt can tell the block was cut rather than complete; it is never silently dropped.

### 3.3 Reflection changes

The time spec already edits `reflection.ts:230` once, removing "their timezone" from the list of
identity facts that "always belong in the constitution when first learned or when they change," and
already adds a `profileUpdates` object to reflection's structured output holding `timezone` alone.
This spec finishes both edits.

The sentence is **replaced**, not trimmed further. The replacement says that name, pronouns,
location, occupation and birthday belong in `profileUpdates` as their current values, that the
constitution holds the history and the meaning behind any of them, including a job, and it gives the
Bangalore example so the boundary is concrete rather than a category the model has to guess at. A job
change is the same shape: the new title is a `profileUpdates.occupation` write, what the change meant
is a constitution write, and the two are not in tension because they answer different questions
(section 3.1).

`profileUpdates` in `RESPONSE_SHAPE` (`reflection.ts:199-207`) widens from `{timezone}` to the full
MODEL-WRITE allowlist from section 3.2: `{preferredName, pronouns, location, timezone, birthday,
occupation, birthdayGreetings}`, every field optional and absent by default, validated by
`profileUpdatesSchema`, the reflection-side MODEL-WRITE schema. There is no `style` key on it, and
there never can be: style is never model-writable at all, from either surface, which is what the
restated principle in section 3.2 says (facts and consent answers, never style).

The live `update_profile` tool widens the same way, to the same allowlist, validated by
`updateProfileArgsSchema`, the tool-side MODEL-WRITE schema, for the same reason `remember` exists: a
fact learned in conversation is written when it is learned, not held until the session ends. In
practice `birthdayGreetings` is almost always set here, live, in the one sentence described in
section 15.2, because a consent answer belongs where it was given. `profileUpdatesSchema` allows the
same key structurally, as a backstop for the rare case where a consent answer was given but the live
write was missed, on the same reasoning reflection already backstops every other field the live path
did not catch.

Reflection also sees the current profile in its prompt context, the way it already sees the
constitution and known people (`reflection.ts:209-224`), so it can tell "not yet known" from
"already recorded" and not propose a field that is already correct.

## 4. Migration: style leaves `config.toml`

Removing `style` from the config schema is a breaking change to every existing install, and the
current code makes it a hard failure in two separate places:

- `configSchema` is a `z.strictObject` (`config.ts:72-78`). The moment `style` is removed from it, a
  config file that still has a `[style]` table fails to load with `style: unknown key "style"`.
- `withNestedDefaultsFillable` (`config.ts:84-93`) *injects* `style: {}` when the key is absent, so
  even a config file that never had a `[style]` table would fail after the field is dropped.

Both must be handled in the same change:

1. `withNestedDefaultsFillable` stops injecting `style`.
2. `loadConfig` checks for a `style` key before validating, and when it finds one raises a specific
   error: the style settings have moved to `profile.md`, run `reverie migrate`. Not the generic
   invalid-config message, which would send people to hand-edit TOML.
3. A migration step, `style-to-profile`, is registered in the `reverie migrate` registry the time
   spec introduces (`packages/memory/src/migrations/index.ts`, a `Migration` with `id`,
   `description`, `isPending`, `apply`). It reads `style` from `config.toml`, merges it into
   `profile.md` through the profile writer, and rewrites `config.toml` without the table. Its
   application is recorded in `migrations.jsonl` like any other step, so `reverie migrate --list`
   shows it and `--dry-run` reports what it would move without moving it.

**This step needs one change to the registry mechanism.** The time spec's `Migration` interface
takes `MemoryPaths` alone (`isPending(paths)`, `apply(paths, opts)`), and states that a later
config-to-profile move will register "with no change to the registry mechanism itself." That turns
out not to hold: this step is the first migration that has to read and rewrite `config.toml`, which
is not in `MemoryPaths` and whose location can be overridden (`defaultConfigPath()`, plus the
`--config <path>` flag from the CLI polish spec). The context passed to `isPending` and `apply`
widens from `MemoryPaths` to `{ paths: MemoryPaths; configPath: string }`. Every existing migration
ignores the new field. Flagged here rather than discovered during implementation.

The step must be idempotent, because a registry entry can be run more than once:

- Config has no `style` table and profile has style: no-op, reported as already done.
- Config has `style` and profile has none: move it.
- Config has `style` and profile already has style: profile wins, the config table is dropped
  anyway, and the step says plainly which values it kept and which it discarded. Silently
  overwriting a value the user set in the settings pane with a stale one from TOML would be worse
  than saying so.
- Config has no `style` and profile has none: no-op. The defaults in the profile schema apply.

Running `reverie` without migrating gives the error from step 2 and nothing else runs. That is the
right failure: it is loud, it names the fix, and it cannot half-work.

## 5. The mode catalogue

Ten modes. `general` is the default for every session and is what a session starts in unless one is
picked at start.

| Mode | What it is |
| --- | --- |
| `general` | Open conversation, no agenda. The default. |
| `listen` | You talk it through, it stays out of the way. It absorbs. It does not fix, does not reframe, does not look for the lesson. |
| `solve` | A concrete problem, worked toward real options and a decision. |
| `real` | It pushes back and names what it sees. It does not soften. |
| `deep` | It asks the questions. It is trying to understand you, not answer anything. |
| `brainstorm` | Quantity over judgment. Ideas riffed on, evaluation deferred. |
| `boost` | Your corner talked up, from things it actually knows about you. |
| `decompress` | Winding down. Light, low-stakes, deliberately not going deep. |
| `process` | Working through one specific thing until it settles. |
| `journal` | Structured written reflection. |

`listen` is deliberately one mode, not two. It was proposed as a separate "listen" and "vent";
merged, because the difference is the user's volume, not the companion's behaviour, and two modes
that produce the same instructions are two ways to get the same thing wrong.

`journal` is defined here as a name in the catalogue and nothing more. Its protocol, its six writing
formats, its `journal/` directory, its `journaling.md` configuration, its cadence prompts and its
per-method safety gates all belong to [the journal mode
spec](2026-08-16-journal-mode-design.md), written the same day. This spec owns the mode value, the
catalogue entry, the picker, and the axis overrides in section 6.2. It owns none of the behaviour.

The handoff is concrete rather than a promise: that spec needs a session's mode to be readable from
the memory layer at `endSession` time, so a journal-mode session writes its entry and every other
session writes nothing. Section 9.4 specifies how the mode gets there.

If the journal spec has not shipped when this one does, `journal` is dropped from the catalogue
rather than shipped as a name with nothing behind it. Nine modes and an honest gap is better than ten
and a lie, which is the kind of overstatement AGENTS.md calls a defect.

### 5.1 Prompt treatment

Each mode contributes one paragraph to the system prompt, inserted after the style section and
before the crisis section (see section 8 for why that ordering is load-bearing). `general`
contributes nothing at all: no paragraph, no mention, so the default session prompt is byte-identical
to today's apart from the changes elsewhere in this spec.

What each paragraph must contain, as requirements rather than final copy. A mode's paragraph must
carry an instruction for **every** axis it suppresses (section 6.1), because a suppressed axis leaves
nothing else saying anything about it. The orientation clause is listed first, then the engagement
clause where there is one:

- **`listen`.** Orientation: absorb. Do not offer a next step, do not reframe what they said into
  something more manageable, do not look for what this teaches them. Reflect back what was actually
  said when it helps them keep going. Questions only to keep them talking, not to redirect. Say the
  thing that shows you heard it, and then stop. Engagement: do not raise a thread of your own, do not
  bring up something from a past session, do not change the subject. Where they take it is where it
  goes.
- **`solve`.** Orientation: there is a concrete problem here. Get it stated clearly first, including
  what would count as solved. Then work toward real options with real trade-offs, and toward a
  decision. Not a plan with time blocks; the voice rules at `personas.ts:24-34` still hold.
- **`real`.** Engagement: say what you actually see, including the part they would rather not hear,
  without waiting to be invited. Name the pattern, name the contradiction, name the thing they are
  avoiding. Do not cushion it into meaninglessness. This is not permission to be cruel and it is not
  permission to be cold: it is candour from someone on their side.
- **`deep`.** Orientation: you are trying to understand this person, not answer anything. Resist
  summarizing, resist concluding, resist the urge to hand back an insight. Engagement: you are the
  one asking. Ask, follow, ask again, and go for the thing under the thing rather than waiting to see
  what they offer. One question at a time still applies.
- **`brainstorm`.** Orientation: generate. Quantity first, evaluation later. Build on their ideas
  rather than judging them, offer the bad ones too, and do not narrow to one recommendation unless
  asked. Explicitly defer the "which of these is best" question.
- **`boost`.** Engagement: you are the one bringing things up, from the record rather than from the
  conversation in front of you. See section 7 for the constraint that governs what you may say.
- **`decompress`.** Orientation: they are winding down. Keep it light and low-stakes. Do not open
  anything heavy, do not follow a thread toward something painful, do not ask what is really going
  on. If they take it somewhere deeper themselves, follow them, but do not lead there.
- **`process`.** Orientation: there is one specific thing. Stay on it until it settles. Do not change
  the subject, do not broaden, do not add a second thread. Circling back over the same ground is the
  work here, not a failure of the conversation.
- **`journal`.** Owned by the journal spec. It supplies the paragraph, built from `journaling.md` and
  the chosen format, and it must cover both axes it suppresses. This spec supplies only the slot it
  goes in.

## 6. Mode overrides style, one axis at a time

### 6.1 The mechanism

A mode declares which style axes it overrides. An overridden axis has its configured paragraph
(`personas.ts:69-103`) **suppressed**, and the mode's own paragraph stands in its place for that
axis. An axis that is not overridden renders exactly as it does today, from `profile.md`.

Suppress, rather than pin the axis to a different enum value. Pinning would be less code, but the
enum values are the wrong vocabulary for what modes actually do: `brainstorm` is not `solutions` (the
solutions paragraph asks for one concrete next step, which is the opposite of quantity over
judgment), and `deep` is not `leading` in the sense that paragraph means. So the mode says its own
thing and the axis paragraph gets out of the way.

The obligation that comes with suppressing is stated in section 5.1 and repeated here because it is
the easy thing to get wrong: **a mode's paragraph must instruct on every axis it suppresses.** A mode
that suppresses engagement and then says nothing about who raises what has deleted the user's setting
and put nothing in its place.

That obligation is made checkable by the shape of the catalogue entry rather than left to review:

```ts
interface Mode {
  id: ModeName
  summary: string                        // the one-liner in section 5, reused by /mode and the picker
  clauses: Partial<Record<'engagement' | 'orientation', string>>
  body?: string                          // anything belonging to no single axis
}
```

`overrides` is derived from `Object.keys(clauses)` rather than declared separately, so an axis cannot
be suppressed without a clause to replace it. The assembled paragraph is the clauses plus the body,
joined.

`tone` is never overridable, by any mode. This is structural, not a convention: the type of a mode's
`overrides` list is `('engagement' | 'orientation')[]`, so a mode that tried to override tone would
not compile, and a runtime check asserts the same for the catalogue. A snarky companion stays snarky
while it listens. That is the whole point: mode changes what the conversation is doing, not who is
talking.

### 6.2 The table

| Mode | engagement | tone | orientation |
| --- | --- | --- | --- |
| `general` | unchanged | unchanged | unchanged |
| `listen` | overridden | unchanged | overridden |
| `solve` | unchanged | unchanged | overridden |
| `real` | overridden | unchanged | unchanged |
| `deep` | overridden | unchanged | overridden |
| `brainstorm` | unchanged | unchanged | overridden |
| `boost` | overridden | unchanged | unchanged |
| `decompress` | unchanged | unchanged | overridden |
| `process` | unchanged | unchanged | overridden |
| `journal` | overridden | unchanged | overridden |

Most cells are "unchanged" on purpose. A mode that quietly rewrites everything is indistinguishable
from a different persona, and it makes the user's own settings feel arbitrary.

### 6.3 Full precedence order

Highest wins:

1. **The safety mode's crisis stance** (`personas.ts:38-51`). Section 8.
2. **The first-conversation guidance** (`context.ts:53-60`), which already states that it outranks
   the engagement setting. It outranks mode too: the first conversation is onboarding regardless of
   what mode someone picked.
3. **The personal-register rule** (`personas.ts:30`), which already states that it outranks
   orientation on personal topics. It outranks mode as well. `solve` does not turn someone's sick
   parent into a project plan.
4. **Mode**, for the axes it overrides.
5. **Style**, from `profile.md`, for every axis a mode did not override.

The assembled prompt states this order in one sentence, so the model is not left inferring it from
paragraph adjacency.

### 6.4 The override is visible and is never written down

Two requirements, both testable:

- The active mode appears in the status line (section 11) at all times, and updates the moment it
  changes. A stance change the user cannot see is indistinguishable from the model drifting.
- Setting a mode never writes to `profile.md` or `config.toml`. The override is computed at prompt
  assembly time from session state. A test reads `profile.md` bytes before and after a `set_mode`
  call and asserts they are identical.

## 7. `boost`, and the sycophancy constraint

`boost` is the mode most likely to do damage, and its constraint is a hard requirement rather than
guidance.

An agent that produces praise on demand is a sycophancy machine. In a tool whose entire value rests
on the user believing what it says about their own life, praise that is not grounded in anything
corrodes trust in everything else the tool says, including the parts that are true and the parts
that matter. A user who catches the companion inventing a strength once has no reason to believe its
account of anything.

So `boost` mode's paragraph must require all of the following:

- **Evidence first.** Before saying anything, search memory: the graph, arcs, person pages, session
  summaries. What is said must come from the record.
- **Specifics, not adjectives.** Name the thing that happened, when, and what it showed. "You are
  resilient" is not allowed. "In March you kept showing up for that on the days it was clearly
  costing you, and you did not make it anyone else's problem" is.
- **Admitting the absence.** If the record does not support it, say so plainly: there is not enough
  here yet to draw on, and here is what there is. Saying "I do not have much to go on yet" is a
  correct answer in this mode. Filling the gap with generic praise is a failure, not a fallback.
- **No manufacturing.** Do not generalize one incident into a character trait. Do not restate their
  own words back as if it were your observation. Do not praise the act of opening the app.

The paragraph says all of this to the model directly, in the imperative, rather than describing
`boost` as "encouraging" and hoping. Section 16 is honest about what can and cannot be tested here.

## 8. Safety invariant

**A mode adjusts style within the safety stance. It never adjusts the safety stance.** AGENTS.md
forbids removing, weakening or bypassing either safety mode, and this is where that rule bites
hardest: `real` must not mean harsh with someone in distress, `listen` must not mean suppressing
crisis behaviour, and `decompress` must not mean steering away from something that has become
serious.

Three enforcement points:

1. **Ordering.** The crisis section stays last in `buildPersona` (`personas.ts:121-130`). The mode
   paragraph is inserted before it, never after. Prompt position is not a formality: an override
   paragraph appended after the crisis stance reads as amending it.
2. **Text.** `CRISIS_OUTRANKS_TONE` (`personas.ts:105`) currently reads "Tone, engagement, and
   orientation are configured preferences, not permission slips." It must name mode as well, and
   must say that mode yields entirely when a conversation moves into crisis territory. That single
   sentence is where the invariant lives in the prompt.
3. **Structure.** Modes can only override `engagement` and `orientation` (section 6.1). There is no
   representable way for a mode to touch the crisis section, the safety mode, or tone.

Test requirement, specified concretely in section 16: for all ten modes against both safety modes,
the crisis section of the assembled persona is byte-identical to the no-mode baseline for that
safety mode, and it is the last section of the prompt.

## 9. `set_mode` replaces `update_style`

### 9.1 `update_style` is removed

Removed entirely, not deprecated:

- The tool definition (`tools.ts:218-248`) and its dispatch case (`tools.ts:279-280`, `:366-391`).
- `ToolDeps.updateStyle` (`tools.ts:24-26`) and, since nothing else uses it, the injected
  `ToolDeps` parameter threaded through `AgentSession.start` (`agent.ts:164-173`).
- `createStylePersister` (`chat.ts:327-337`) and its wiring (`index.ts:171-173`).
- The `update_style: 'adjusting style'` entry in `TOOL_NOTICES` (`chat.ts:36`).
- The setup copy promising that style can be changed "just by telling reverie in conversation"
  (`setup.ts:129-132`), which becomes false.

A dispatched call named `update_style` falls through to the existing unknown-tool error
(`tools.ts:281-282`), so a stale build or a confused model gets a plain error rather than silence. A
test asserts `toolDefinitions()` contains no tool by that name, mirroring the `resolve_proposal`
absence test from the remember-by-default spec.

The persistence path that `createStylePersister` served does not move anywhere. It disappears. Style
is persisted by `/style`, by the settings pane, and by `reverie setup`, all of which write
`profile.md` through the profile writer. No tool writes it.

### 9.2 `set_mode`

```
set_mode(mode: 'general' | 'listen' | 'solve' | 'real' | 'deep' | 'brainstorm' | 'boost' |
               'decompress' | 'process' | 'journal')
```

Its description tells the model to use it when the person asks for something this conversation
needs, gives the ten modes with their one-line definitions, and says the change lasts for this
conversation only and is not saved. It also says what to do when someone asks for a lasting change
instead: point them at `/style` in the terminal or the settings pane in the browser, and say plainly
that you do not change that setting yourself.

**Mode state lives on `AgentSession`, not in an injected dependency.** This is the design fix for
the bug in section 1: because mode is session-scoped it needs no persister, so `AgentSession` can
own it, supply the dispatch hook itself, and work identically in the CLI and the server by
construction. There is no configuration under which `set_mode` is unavailable.

Changes required:

- `AgentSession` gains a private `mode` field, defaulting to `general`, settable at start
  (`AgentSession.start(engine, config, chat, { mode })`) and readable by the caller.
- `AgentSession.setMode(name)` sets the field, re-assembles the system prompt, appends a transcript
  line (below), and emits a `mode` event.
- `dispatchTool` gains a `setMode` hook that `AgentSession` passes in from `runTurn`, replacing
  `ToolDeps`. An unknown mode name returns the usual `{"error": ...}` shape and changes nothing.
- The re-assembly at `agent.ts:328-331`, currently keyed on `update_style` and the only thing in the
  codebase that re-assembles a live system prompt, is keyed on `set_mode` instead.
- `assembleSystemPrompt` (`context.ts:22-27`) and `buildPersona` (`personas.ts:116-120`) take the
  profile and the active mode. Style no longer comes from `config`.
- `AgentEvent` (`agent.ts:23-27`) gains `{ type: 'mode'; mode: ModeName }` so both interfaces can
  update their status line the moment the model switches. The CLI prints a one-line confirmation and
  refreshes the strip; the web updates the picker.
- `AgentSession` gains a public `refreshSystemPrompt()`. Today the only thing that re-assembles is
  buried inside `runTurn` (`agent.ts:328-331`), which is enough for a tool call and not enough for
  anything else. `/style` and the settings pane both change the profile from outside any turn, and
  without a public entry point an implementer has to either re-add an injected dependency (undoing
  the fix above) or ship a `/style` that only takes effect next session. It reloads the profile
  through the engine's cached copy and rebuilds `this.system`. `setMode` uses it too, rather than
  duplicating the assembly call.

### 9.3 A mode change is recorded in the transcript

A stance change that leaves no trace in a permanent record is worse than a slightly noisy record.
When the model calls `set_mode`, the assistant tool-call line and the tool result line already
record it (`agent.ts:316-334`). When the change comes from `/mode` or the web picker, nothing would.

So `setMode` appends one user-role transcript line reading exactly `/mode <name>` before
re-assembling, in both the CLI and the web: reflection sees it, and the model sees it in history,
which is correct in both cases, and the alternative is a session whose shape changed for reasons the
record does not explain.

**But that line is not what the user typed, in one of the two callers, and the transcript has to say
so.** In the CLI, `/mode <name>` typed at the prompt is genuinely a user-role line, verbatim. In the
web, `setMode` is called directly from a picker click, and the same line is synthesized on the
user's behalf, which is the one place in this codebase where a user-role line is written that the
user did not type verbatim. The sibling journal spec builds a journal entry's body from "only the
person's own user-role lines, verbatim and never paraphrased," and tests that the body contains every
user line's content in order. A synthesized `/mode <name>` line with no marker would satisfy that
test's shape while failing its intent: every journal entry would open with a line the person never
wrote, which is a record claiming something about itself that is not true, the same failure
AGENTS.md's honesty rules name for the README applied one level down, to a single record instead of
a whole status section. Pattern-matching a leading slash in the journal spec is not the fix, because
a person can legitimately write a line that starts with a slash inside a journal entry, and the two
cases would then be indistinguishable by content alone.

So `TranscriptLine` gains an additional optional field, `synthetic: true`, set only on lines the
system wrote on the user's behalf rather than lines the person typed or spoke. Wherever transcript
lines are validated by a zod schema on read, that schema's `synthetic` key is `.optional()` in the
same change, for the same reason `profileMetaSchema` and the others stay optional-by-default: an
older line on disk must still parse. `setMode` sets it when called from the web (a click, no
keystroke behind it) and leaves it unset when called from the CLI's own `/mode` command (the user did
type it). Every existing transcript line, and every line written by any other path in the codebase
today, has no `synthetic` key at all; its absence means the same thing `false` would, so no existing
transcript needs migrating and no existing reader breaks. This is an additive field on an
append-only structure: nothing already on disk is rewritten or changes shape, and a reader written
before this field existed still parses every line correctly because the field is optional. The
journal spec's body assembly excludes any line with `synthetic: true`; that exclusion rule belongs to
that spec, this spec only guarantees the field exists and is set correctly at the one place,
`setMode`, that needs it.

The server's `StreamEvent` union (`registry.ts:20-32`) and the web's `streamEventSchema`
(`packages/web/src/api.ts:111-144`) both gain the `mode` event. Both are discriminated unions that
reject an unknown `type` today, so they must change in the same release. That is safe here because
the server serves the web build from the same install, but it is worth stating rather than
discovering.

### 9.4 The memory layer can read a session's mode

The journal spec needs the mode at `endSession` time, and needs it in the memory layer rather than in
`AgentSession`, because that is where the write happens (`_doEndSession`,
`packages/memory/src/engine.ts:318`). Session state on an object in `@openreverie/core` is not
reachable from `@openreverie/memory`, and it must not become reachable: `core` depends on `memory`,
never the other way round.

So the mode is pushed down rather than read up. `AgentSession.setMode` tells `MemoryEngine`:
`engine.setSessionMode(sessionId, mode)` at start and on every change.

**The mode is persisted to disk at `startSession`, not held only in memory.** `runMaintenance`
(`engine.ts:990-1013`) reflects stale, unreflected sessions through `_doEndSession` in a later
process: the user journals for forty minutes, the process dies or is interrupted before `/bye`,
reflection runs on the next startup with no live session object anywhere, and an in-memory-only mode
would mean no journal entry is ever written for that session. That is data loss, not an edge case.

So `MemoryEngine.setSessionMode(sessionId, mode)` writes a small `session.json` into the session
directory, holding `{ mode: ModeName }`, using the same atomic temp-file-then-rename write every
other document write in this codebase uses. Nothing else writes it. `AgentSession.start` already
takes a `{ mode }` start parameter (section 9.2) and calls `setSessionMode` as the first thing it
does, so a session backed by an `AgentSession` has `session.json` from its first moment, written at
"the moment the session starts" in effect, without a second write path that could disagree with the
first. `SessionStore` currently records no metadata at all (`transcripts.ts:56-61`): the session
directory holds only `transcript.jsonl` until reflection writes `summary.md`. `session.json` is new.

A separate file rather than a marker line in the transcript, for two reasons. First, the transcript
is sacred and append-only by AGENTS.md's own rule; mixing a mutable piece of session metadata into
that stream, rewritten every time the mode changes, means either violating append-only or
accumulating one line per mode change that every transcript reader then has to filter out. Second,
section 9.3 already needs a way to mark a `/mode` line as synthesized, and conflating "is this line
real" with "what is the session's current mode" would be two concerns in one mechanism.

`_doEndSession` reads the mode from `session.json` on disk, not from any in-memory session registry.
That makes same-process and later-process reflection go through the identical path: there is exactly
one place that knows how to answer "what mode was this session in," and it works whether the process
that started the session is the one ending it or not. A session directory with no `session.json`, or
one that fails to parse, means the mode is absent, on the same reasoning as the second consequence
below.

Two consequences worth stating:

- The mode at session end is the mode in force when the session ended, not a list of every mode the
  session passed through. A session that started in `general` and switched to `journal` ends as
  `journal`. The full sequence is recoverable from the transcript (section 9.3) if that ever matters.
- A session opened by anything that is not an `AgentSession` (a test, a future batch tool) never
  calls `setSessionMode`, and this is a direct consequence of the write path above rather than a
  separate exception to it: no `session.json` is written, and the engine must treat the mode as
  absent rather than assume `general`. The journal spec's write is gated on the mode being exactly
  `journal`, so absent behaves correctly by default.

## 10. CLI commands

### 10.1 A parser, not another string comparison

Today the loop compares `trimmed === '/bye'` (`chat.ts:237`) and sends everything else to the model.
Adding five more comparisons next to it is how the loop becomes unreadable. Instead:

```
parseInput(line):
  -> { kind: 'command', name: string, arg: string | undefined }
  -> { kind: 'text', text: string }
```

Rules, in order:

1. Trim. Empty input is `text` with an empty string, and the loop keeps skipping it
   (`chat.ts:256-258`).
2. A leading `//` means the user meant a literal slash: strip one slash and return `text`. Typing
   `//mode` sends `/mode` to the model.
3. `/` followed by a token matching `^[A-Za-z][A-Za-z0-9-]*$` (no slash inside it) is a command
   attempt. The token, lowercased, is the name; everything after the first run of whitespace,
   trimmed, is the argument, or undefined when there is none.
4. Anything else beginning with `/` is `text`. A pasted path like `/usr/local/bin` contains a slash
   in its first token, so it reaches the model unchanged.
5. Everything else is `text`.

Commands are then dispatched from one table. `/bye` moves into that table, including the
end-of-input path at `chat.ts:227-230`, which synthesizes `line = '/bye'` on readline EOF: the
synthesized value goes through the same parser and the same table, so there is exactly one place
that knows what `/bye` does.

**An unknown command does not reach the model.** `/moed listen` prints `Unknown command: /moed. Type
/help to see what there is.` and returns to the prompt. This is a behaviour change: today that line
would be sent to the model, which would try to interpret it. Sending a typo'd command to a companion
that then improvises around it is worse than one plain line of correction.

### 10.2 The commands

- **`/help`.** One line per command, and one line saying that a message starting with a literal
  slash can be sent by doubling it.
- **`/mode`.** With no argument: the ten modes with their one-line definitions, the current one
  marked, and a line saying the mode lasts for this conversation only. With an argument: switch,
  confirm in one line naming which style axes this mode overrides for the session, and refresh the
  strip. An unrecognized name lists the valid ones and switches nothing.
- **`/style`.** With no argument: the three axes, their current values from `profile.md`, and the
  usage line. With `<axis> <value>`: validate against the enums, write `profile.md` through the
  profile writer, confirm, and call `AgentSession.refreshSystemPrompt()` (section 9.2) so the change
  applies to the rest of this conversation rather than only the next one. An invalid axis or value
  lists the valid ones and writes nothing.
- **`/settings`.** Prints what is set and where it lives: safety mode, the fact that it is changed
  by hand in the config file and deliberately not from here, the memory folder path, and a pointer
  to `/style` and `/whoami`. Read-only in this release.
- **`/whoami`.** Prints what reverie knows about the user from `profile.md`: each field with its
  value or `not known`, then the prose body when it is non-empty. Reads through the time spec's
  profile loader; it does not re-parse the file. It ends with one line saying that nothing here is
  guessed, only recorded from what the user has said or set.
- **`/bye`.** Unchanged: reflect, print warnings, exit (`chat.ts:237-255`).

## 11. Status line

### 11.1 What it shows

```
general · warm · Bengaluru 4:19pm IST · 12m
```

Mode, tone, local place and time, session elapsed. Four segments and nothing else. The temptation to
add token counts, memory statistics and a hint of the day is real and is being refused here: this
line exists so the user can see the two things the model's behaviour depends on that are otherwise
invisible, plus enough orientation to know how long they have been at it.

The time and zone come from the time spec's own formatting of `timezone`, not from a second
implementation here. Per that spec a timezone is effectively always present, seeded from the host
machine and marked `timezoneSource: 'system-default'` until the user confirms it, so the interesting
cases are about confidence and about the parts that really can be unset:

- `location` set and `timezoneSource` is `user-confirmed`: `Bengaluru 4:19pm IST`, the full segment.
- `location` unset, or the timezone is still a system default: the time and zone render without a
  place name (`4:19pm IST`). A guessed zone is shown because it is almost always right and the user
  can see at a glance if it is not, but it is never dressed up with a place the user never gave.
- The profile fails to load, or holds a zone `Intl` rejects: the segment is omitted entirely. It
  never falls back to the host zone at that point, because a silent substitution is how a wrong local
  time becomes invisible.
- Elapsed under one minute: `0m`.

### 11.2 The CLI

The strip and the spinner are two components. The spinner (`status.ts`) is unchanged: transient,
only between the end of a turn and the first output, still gated on `colorEnabled`.

The strip is printed once, on its own dim line, immediately before each `you> ` prompt. It is not
animated and it does not repaint in place. That gives a fresh value at every turn and immediately
after a mode change, and it means the two components never write to the funnel at the same moment:
the spinner only runs while a reply is streaming, the strip only prints while nothing is. No cursor
addressing, no fighting readline.

Gating: the strip is shown when stdout is a TTY, and its dim styling is applied only when
`colorEnabled`. These are two different conditions today, collapsed into one at `index.ts:41-43`
where `colorsEnabled()` is `isTTY && !NO_COLOR`. A user who sets `NO_COLOR` wants no colour, not less
information, so `runChat` takes `interactive: boolean` alongside `colorEnabled`. Piped and redirected
output gets no strip, which keeps existing captured-output tests honest.

Session elapsed is computed from the injected `now` (`chat.ts:162`), sampled once when `runChat`
starts. Rendering is a pure function so it can be tested without a clock:

```
renderStatusStrip({ mode, tone, location, localTime, zoneAbbrev, elapsedMs }): string
```

The now-block the time spec assembles into the prompt and this strip render the same facts for two
different readers, the model and the person. They share the formatter and nothing else: the block is
prose for a model that needs to know a zone is unconfirmed, the strip is four short segments for
someone glancing at a terminal.

### 11.3 The web

The same four segments in a strip near the composer, where the mode segment is the picker itself
(section 12). Elapsed ticks in the browser from the session's `createdAt`. The same degradation
rules apply, from the same profile fields, fetched once per session.

## 12. Web interface

The nav rail (`App.tsx:7-15`, `:105-116`) gains two destinations, not one: `journal`, and `settings`.
They are not the same kind of destination. Journal is a peer of Talk, Atlas and Record: a section
holding a kind of content, mounted and unmounted the way those already are, opened, browsed and read
like the others. Settings is a pane launched from the rail rather than a fourth content section:
there is nothing to browse chronologically in it, it holds the account-level configuration described
in section 12.2, and it is the one destination that is not itself a record of anything the person
did. The journal spec owns everything the journal tab contains: what it lists, how an entry opens,
how it renders. This spec owns only that it exists as a nav destination and where it sits, alongside
Talk, Atlas and Record.

The reasoning for putting journal in the nav at all rather than behind an in-conversation view: this
is a personal, local instance today, and if it is ever served remotely it gets proper auth first. A
local single-user app has no reason to hide someone's own written reflections behind an extra click.

### 12.1 Mode picker, with the conversation

The picker sits with the chat, near the composer, not in settings. Mode is a property of this
conversation, so it belongs where the conversation is, and it must be changeable mid-conversation
without leaving the view.

It is a plain select or a small popover listing the ten modes with their one-line definitions.
Changing it calls the session mode endpoint (section 13), which drives `AgentSession.setMode`, so a
click and a `set_mode` tool call take exactly the same path. When the model changes the mode itself,
the `mode` stream event updates the picker, so the two never disagree.

### 12.2 Settings pane

The settings pane, hash-routed at `#/settings`, labelled Settings, sitting in the nav rail alongside
Talk, Atlas, Record and the journal tab described above (hash-routed at `#/journal`, whose contents
the journal spec owns). It contains:

- **Style.** Three selects, one per axis, with the same honest one-line descriptions the setup wizard
  uses (`setup.ts:134-203`) rather than bare enum names.
- **Profile.** Preferred name, pronouns, location, occupation, timezone, birthday, and the
  birthday-greeting toggle. Every field can be left blank, and blank renders as "not known" rather
  than an empty box that looks like a mistake.
- **Safety mode, read-only.** Shown with one line saying it is changed by hand in the config file,
  deliberately.

Like Atlas, Record and Journal, the pane is mounted only while it is on screen, while Conversations
stays mounted behind it (`App.tsx:124-139`), so opening settings mid-conversation does not end the
session.

The journal spec's settings (chosen format, cadence, agent activity level) belong in this pane and
are edited through `journaling.md`, not `profile.md`. That spec owns their shape; this one owns the
pane they sit in and the endpoint pattern they follow.

## 13. Server endpoints

### 13.1 The API key must not be reachable

`config.toml` holds the provider API key and is written with mode 0600 (`config.ts:156`). No
endpoint may return the provider block, in whole or in part, under any circumstance. This is a hard
requirement, and section 16 specifies a test that checks it by value rather than by field name.

Because style moves to `profile.md`, the settings surface is almost entirely a profile surface. The
config surface is one read-only field.

### 13.2 The endpoints

**`GET /api/v1/profile`** returns exactly:

```
{ preferredName, pronouns, location, timezone, birthday, birthdayGreetings, occupation,
  style: { engagement, tone, orientation },
  prose }
```

Unset fields are `null`. Nothing else is included, ever. The file's schema passes unknown keys
through (section 3.2), so a hand-added or forward-written key can exist in `profile.md`; the
endpoint does not echo it. The response is built from the whitelist, key by key, never by
serializing the loaded object. `timezoneSource` is not exposed: it is an implementation detail of how
confident the zone is, not a setting.

**`PATCH /api/v1/profile`** accepts a `z.strictObject` over exactly the same field set, every key
optional, and writes the merged result through the profile writer atomically. It returns the same
shape `GET` returns. Unknown keys fail the strict object and become the existing
`ApiError(400, 'invalid_request')` (`app.ts:104`), so a body carrying `provider`, `safety`,
`memoryDir`, or `models` is rejected rather than partially applied. Strictness here and passthrough
in the file are not in tension: an unrecognized key in a file the user may hand-edit is probably
intentional, an unrecognized key arriving over HTTP is probably a mistake or an attempt.

This request schema is its own, third strict object, distinct from both MODEL-WRITE schemas in
section 3.2, not a reuse of either. It legitimately includes `style` and `prose`, which neither
MODEL-WRITE schema may ever accept, because a settings-pane `PATCH` is not a model surface: it is the
same kind of write `/style` and `reverie setup` already make. An implementer reaching for a schema to
validate this body should reach for this one, not for `updateProfileArgsSchema` or
`profileUpdatesSchema`.

A write goes through the same engine path the live `update_profile` tool uses, so the engine's cached
profile is refreshed rather than left stale behind a direct file write. Setting `timezone` here marks
`timezoneSource: 'user-confirmed'`, the same as confirming it in conversation: typing it into a
settings field is a confirmation.

**`GET /api/v1/settings`** returns exactly `{ safetyMode: 'companion' | 'firewall' }`. No memory
folder path, no config file path, no model names. There is no `PATCH /api/v1/settings` in this
release: safety mode is not settable over HTTP, for the same reason it stays in `config.toml`.

**`POST /api/v1/sessions/:id/mode`** with body `{ mode }` sets the mode on a live session and returns
`{ mode }`. Unknown mode is a 400. Unknown or ended session is the existing 404.

**`POST /api/v1/sessions`** (`app.ts:253-257`) accepts an optional `{ mode }` body to start a session
in a mode.

`PublicSession` gains an optional `mode`, present for live sessions only, so a browser reload can
recover the current mode. Both the server schema and the web's `sessionSchema`
(`packages/web/src/api.ts:29-40`) are `strictObject`, so both change together.

All of these sit under the existing auth split: `GET` needs read auth, the rest need write auth
(`app.ts:123-127`). The router is hand-rolled path matching; the new routes follow the same shape.

## 14. Stance doctrine

A new section in `personas.ts`, present in both safety modes, part of the shared prefix so the two
prompts stay identical outside the crisis stance:

- Never assume gender, age, or pronouns.
- Use they/them until told otherwise. Never infer pronouns or gender from a name, from an occupation,
  from a relationship, or from how someone writes.
- This applies to third parties in the user's life, not only to the user. The colleague, the
  partner's sibling, the therapist: they/them until the user says otherwise.
- Asking is fine. Interrogating is not. It arises when it fits the conversation, once, and then it is
  recorded and never asked again.
- No assumptions about living situation, relationships, family structure, or life stage. Nothing in
  the way you speak should imply a default shape for someone's life.
- Not judgmental. This is not a stance you announce; it is how you already talk.

When the user gives their pronouns, they go into `profile.md` and the model uses them from then on,
because they render in the assembled prompt's `## Profile` section (section 3.2), not only on disk.
Third-party pronouns belong on that person's page and in the graph, not in the user's profile.

## 15. Onboarding

### 15.1 Collection stays conversational, storage becomes structural

The first-conversation prompt (`context.ts:53-60`) keeps its current shape exactly: a short warm
welcome including the plain statement that reverie is not a therapist, then name and how they would
like to be addressed with pronouns, then where they live and their timezone, then one thing
currently going on, one question at a time with an answer before the next. That copy is good and it
is not becoming a form.

What changes is only where the answers go. The model writes them with `update_profile` as it hears
them, and reflection backfills anything missed at the end of the session (section 3.3), instead of
either of them landing in constitution prose. The prompt itself does not mention profile fields, does
not read like data collection, and does not ask the user to confirm anything was saved. It certainly
does not narrate the writing: the no-asking rule (`personas.ts:20`) covers this too, and "I have
noted your pronouns" is exactly the housekeeping the greeting rules already forbid.

The timezone question already in that prompt is the same field the time spec introduces, captured by
the same live tool. This spec does not add a second question or a second field.

Onboarding does not ask for style. Its three axes are asked once, in `reverie setup` (section 15.3),
where the person is already configuring something. Asking a stranger in the first two minutes how
warm they would like you to be is a worse question than simply being warm and letting them change it
later.

### 15.2 Birthday is not asked during onboarding

Asking someone's birthday in the first conversation reads as form-filling, and it is the question
most likely to make a warm opening feel like an account signup. It is not asked, in onboarding or
anywhere else.

It is recorded when it comes up naturally: they mention a birthday coming up, they say what year they
were born, a session lands on the day itself. It goes into `profile.md` like any other profile fact.

When a birthday is first recorded, `birthdayGreetings` defaults to true, and the companion says so
once, in one sentence, with an easy way to decline: it will say something on the day, and they can
tell it not to. The answer is stored either way, so the question is never asked again. Silently
opting someone into a yearly message is wrong; asking them about it every year is worse.

This is the one place the model both records a fact and mentions that it did, which is a deliberate
exception to the no-narration rule rather than an oversight. Recording a birthday silently is fine;
signing someone up for a message on it silently is not, because that one has a visible consequence
they never agreed to. The exception is narrow: one sentence, the first time only, and the consent
answer is written with `update_profile` immediately so it is never asked twice. This is consistent
with the restated write-permission principle in section 3.2: a consent answer is a fact-like thing
the model was told, not a style preference, so writing it live is exactly what that rule allows. The
natural place to say "please don't wish me" is in conversation, the same place the birthday itself
came up, which is why `birthdayGreetings` sits on the MODEL-WRITE allowlist openly rather than as an
unnamed exception.

Whether a birthday greeting actually fires is a scheduling question the time spec owns. This spec
owns the fields and the consent.

### 15.3 `reverie setup`

The brief does not say what happens to setup's three style questions
(`setup.ts:127-206`). This spec keeps them and changes only their destination.

Setup remains the one deliberate configuration moment, and its copy for the three axes is good and
honest. But style now lives in `profile.md`, which lives in the memory folder, so setup writes there
in addition to `config.toml`, in this order: create the memory tree with `ensureMemoryTree`, which
per the time spec seeds `profile.md` with a system-default timezone if the file is absent; then load
that profile; then merge the chosen style into it and write it back. Never the other way round, and
never a fresh write: writing a profile before `ensureMemoryTree` runs means the seeding step finds a
file and skips, and writing a fresh one on a rerun discards every other field the person has.

One copy change is required: setup currently says style can be changed later "just by telling
reverie in conversation" (`setup.ts:129-132`). That is now false. It says `/style` in the terminal,
or the settings pane in the browser.

## 16. Testing plan

TDD applies to everything deterministic here, which is most of it. Most of the tests below are
written to fail if the thing they name is deleted, and each of those names its falsification, because
a test that passes with the wiring removed is the exact failure mode AGENTS.md calls out. Two tests in
this plan are not falsifications by that standard: they pass with the whole mode feature absent, which
makes them regression guards rather than proof the feature exists. Both are marked **Guard** rather
than removed: a check that catches something going backward is still worth having, and the point here
is being honest about what each one actually catches.

### 16.1 Config and migration

- Loading a `config.toml` that still contains `[style]` produces the specific "run `reverie migrate`"
  error, not the generic invalid-config message. Falsify: delete the check, the test fails on the
  message text.
- Loading a config with no `[style]` table succeeds and the returned object has no `style` property.
  Falsify: restore the injection in `withNestedDefaultsFillable`, the test fails.
- Migration step, four cases from section 4, each asserted on the resulting file contents. Running
  the step twice leaves both files byte-identical to after the first run. Falsify: make the step
  unconditionally write, the idempotence case fails.
- The step reports which values it kept when both files have style. Falsify: silently overwrite, the
  reported-output assertion fails.

### 16.2 Profile schema

- `StyleConfig` and its three enums are exported from `@openreverie/memory`, not
  `@openreverie/core`, and `personas.ts` imports them from there. Falsify: reintroduce the enums in
  `config.ts` and import from there instead, the import-direction test fails.
- Every field is optional and a profile holding only the seeded timezone yields all-unknown for the
  rest, with no invented defaults. In particular, tone does not come back as `warm` from a file that
  has no style block.
- An unknown key round-trips: it survives a load and a write unchanged, per the time spec's
  passthrough posture. Falsify: make the schema strict, the test fails.
- Both MODEL-WRITE schemas, `updateProfileArgsSchema` (the live `update_profile` tool's arguments)
  and `profileUpdatesSchema` (reflection's `profileUpdates` field), reject a `style` key with a
  validation error, and neither has one at the type level, only the allowlist from section 3.2.
  Falsify: add `style` to either allowlist, the corresponding test fails because the schema now
  accepts what the rule says it must not. This is the test that keeps section 2's split real.
  `profileMetaSchema`, the FILE schema, is untouched by this test: it already accepts `style` as a
  known field, because `/style`, the settings pane and `reverie setup` write it directly, outside any
  model surface.
- A `/style` write and a settings-pane write both leave the non-style fields byte-identical.
- Writes are atomic (temp file then rename), following the existing document-write tests.
- `assembleSystemPrompt` renders the `## Profile` section from section 3.2: a profile with
  `preferredName` set produces an assembled prompt that contains that name, and a profile with
  `pronouns` unset produces a prompt that does not mention pronouns at all, not `unknown`. Falsify:
  delete the render call, the set case fails because the name disappears and the unset case still
  passes only by coincidence, which is why both are asserted together.
- A prose body over the 2,000-character cap is truncated in the assembled prompt with the trailing
  marker, and `profile.md` on disk is untouched. Falsify: drop the cap or the marker, either half of
  the test fails independently.

### 16.3 Mode overlay and precedence

- Table-driven over all ten modes: for each mode, the axis paragraphs listed as overridden in
  section 6.2 are absent from the assembled persona and the mode's own paragraph is present, and the
  axis paragraphs listed as unchanged are present verbatim. Falsify: flip any single cell, that row
  fails.
- For all ten modes, with tone set to each of its five values, the configured tone paragraph appears
  verbatim. Falsify: let any mode suppress tone, the test fails.
- The mode catalogue's suppressed axes are only `engagement` and `orientation` at runtime, in
  addition to the type-level constraint.
- Every suppressed axis has a non-empty clause, for every mode. Falsify: delete `listen`'s engagement
  clause, and the test fails where a prompt-content test would not, because the resulting prompt is
  still perfectly well-formed and just quietly says nothing about who leads.
- The overrides in section 6.2's table match the catalogue's clause keys, mode by mode. This is the
  test that keeps the spec and the code from drifting apart.
- **Guard.** `general` produces a persona byte-identical to one assembled with no mode at all. This
  passes with the mode feature entirely absent, so it is not a falsification by this section's
  standard; it is a regression guard against `general` quietly growing a paragraph of its own.

### 16.4 Safety, the required invariant test

- For all ten modes against both safety modes (twenty cases): the crisis section of `buildPersona`
  output is byte-identical to the no-mode baseline for that safety mode, and it is the final section
  of the prompt. Falsify: insert the mode paragraph after `crisisSection` in the section list at
  `personas.ts:121-130`, and the ordering half fails while a naive "crisis text is present"
  assertion would still pass. That is why the assertion is position plus bytes, not presence.
- `CRISIS_OUTRANKS_TONE` names mode. Falsify: delete the word from `personas.ts:105`, the test fails.
- The shared prefix of the two personas remains identical outside the crisis stance, with a mode
  active. This extends the existing persona test rather than replacing it.

### 16.5 `set_mode` and the removal of `update_style`

- `toolDefinitions()` contains no tool named `update_style`, and dispatching a call by that name
  returns the unknown-tool error.
- `set_mode` with a valid name changes the session mode and the next provider request carries a
  system prompt containing that mode's paragraph. Falsify: delete the re-assembly at the dispatch
  site, the test fails because the second request still carries the old prompt. Assert on the system
  prompt the fake provider received, not on any return value, since a return value can be right while
  the prompt is stale.
- `set_mode` with an unknown name returns the error shape and leaves the mode unchanged.
- `set_mode` works with a session created the way the server creates one (`registry.ts:149`, no
  injected dependencies). Falsify: reintroduce an injected persister requirement, the test fails.
  This is the regression test for the bug in section 1.
- **Guard.** `profile.md` is byte-identical before and after a `set_mode` call. This passes with the
  mode feature entirely absent too, so it guards against a future regression, a change that makes
  `set_mode` start writing the file, rather than proving `set_mode` exists.
- A mode change appends exactly one `/mode <name>` user line to the transcript, and the transcript is
  otherwise unchanged. The line carries `synthetic: true` when the call originates from the web mode
  endpoint (a click, not a keystroke), and no `synthetic` key at all when it originates from the
  CLI's own `/mode` command (the user's literal input). Falsify: set the flag unconditionally, or
  never, and one of the two cases fails.
- The engine has the session's mode at `endSession` time, from every path that can set one (session
  start, `set_mode`, `/mode`, the web endpoint). Falsify: drop the `setSessionMode` call from any one
  of them, that case fails. This is the contract the journal spec's gated write depends on, so it is
  tested here rather than assumed there.
- The same case survives closing and reopening the engine between `setSessionMode` and `endSession`:
  start a session, set its mode, tear down the `MemoryEngine` instance entirely (simulating the
  process dying before `/bye`), construct a fresh one against the same memory folder, and call
  `_doEndSession` on it. The mode read is the one that was set, not absent. Falsify: hold the mode in
  an in-memory map instead of `session.json`, and this case fails while the same-process case above
  keeps passing, which is exactly the gap section 9.4 exists to close.
- A session the engine opens without an `AgentSession` reports its mode as absent, not `general`.

### 16.6 CLI

- Parser table: `/bye`, `/mode`, `/mode listen`, `/mode   listen  `, `/MODE`, `/moed`, `//mode`,
  `/usr/local/bin`, `/`, empty, and ordinary text. Each maps to a stated outcome.
- An unknown command does not reach `session.send`. Assert with a fake session that records every
  call. Falsify: fall through to the model, the test fails.
- EOF at the prompt still reflects and exits, and does so through the command table rather than a
  separate branch. Falsify: leave a second `/bye` comparison in the loop and delete the table entry,
  the test fails.
- `/style tone direct` writes `profile.md` and the next provider request carries the direct tone
  paragraph. Falsify: skip the re-assembly, the test fails.
- `/style` with an invalid value writes nothing. Assert on file bytes.
- `/whoami` prints `not known` for unset fields and never prints an invented value.
- `reverie setup` writes the chosen style into `profile.md` and no `[style]` table into
  `config.toml`. Falsify: leave the old write in place, the config assertion fails.
- `reverie setup` run twice on an existing memory folder preserves every non-style profile field.
  Falsify: write a fresh profile instead of merging, the test fails.

### 16.7 Status line

- `renderStatusStrip` unit tests: full case, unconfirmed timezone (time renders, place name does
  not), missing location, unloadable profile (segment omitted entirely, and the output contains
  neither UTC nor the host machine's zone), elapsed under a minute.
- The strip is absent when `interactive` is false, and present without ANSI codes when `interactive`
  is true and `colorEnabled` is false. Falsify: gate the strip on `colorEnabled`, the second case
  fails.
- After a mode change, the next strip shows the new mode. Falsify: cache the mode at start, the test
  fails.
- The spinner and the strip never write in the same frame: assert the write sequence around a turn.

### 16.8 Server

- **API key non-exposure, by value.** Configure `provider.apiKey` to a sentinel string, call every
  endpoint the server exposes, including the new profile, settings, session and mode routes, and
  assert the serialized response body of each never contains the sentinel anywhere. Falsify: spread
  the config object into any response, the test fails. A field-name assertion would not catch a
  nested or accidental spread, which is why this is by value.
- `PATCH /api/v1/profile` with an unknown key returns 400 and writes nothing. Assert on file bytes.
- `PATCH /api/v1/profile` with `provider`, `safety`, `models` or `memoryDir` in the body returns 400.
- `GET /api/v1/settings` returns exactly one field.
- There is no route that writes config: assert `PATCH`/`POST` to `/api/v1/settings` returns 404.

### 16.9 Web

- Reducer handles the `mode` event and updates state.
- The picker and the model stay in agreement: a `mode` stream event updates the picker without a
  refetch.
- The settings pane sends only whitelisted keys in its `PATCH` body.
- Switching to the settings pane leaves the Conversations view mounted and the session alive.
- The nav rail renders a journal destination alongside Talk, Atlas, Record and Settings, and
  switching to it, like switching to Atlas or Record, leaves the Conversations view mounted and the
  session alive. This spec asserts only that the destination exists and mounts this way; what it
  renders once open belongs to the journal spec.

### 16.10 LLM-dependent behaviour

Fixture transcripts and schema assertions, never golden text:

- Reflection on a fixture where the user states their name and city produces `profileUpdates` with
  those fields set, validated against the schema. The assertion is on which fields are populated, not
  on their exact strings and not on the constitution text.
- Reflection on a fixture with a meaning-laden statement ("moving there unsettled me") produces a
  non-null `constitutionUpdate`, and `profileUpdates.location` holds a place name or is absent. Never
  a whole sentence.
- Reflection never emits `style` in `profileUpdates` across the fixture set.
- Reflection on a fixture where the user describes a job change, with a prior fixture already having
  recorded the old job in the constitution along with what it meant, produces `profileUpdates`
  holding the new `occupation` value, and applying the resulting `constitutionUpdate` leaves the
  existing narrative about the previous job intact rather than replacing or erasing it. This is the
  test that keeps section 3.1's fact/meaning rule from drifting: the field changes, the history does
  not.

`boost` is the honest limit of this plan. Whether the model manufactures praise cannot be settled by
a unit test, and a test that asserts the presence of specific praise text would be a golden-text
test of exactly the kind AGENTS.md forbids. What is tested is what is deterministic: the boost
paragraph is present and carries the evidence requirement and the admit-the-absence requirement, and
it is present even when the memory folder is empty, which is the case where manufacturing is most
tempting. The behavioural property is checked by a documented dogfooding pass on a folder with
almost no history before release, and the outcome of that pass is written into the release notes
whether it goes well or not.

## 17. Deferred

- **Journal protocol.** Owned by the journal spec. This spec ships the mode value, the catalogue
  entry and the axis overrides, and nothing else about it.
- **Provenance on profile fields.** Which surface set a field and when, so reflection can be
  prevented from overwriting something the user set by hand. Last write wins until then.
- **A default mode in `profile.md`.** Every session starts in `general` in this release.
- **Per-browser mode memory.** The web does not remember the last mode used.
- **Editing safety mode from any interface.** It stays a deliberate hand edit of `config.toml`.
- **Editing crisis resources from the settings pane.** Same reasoning.
- **Custom or user-defined modes.** Ten fixed modes is the whole catalogue.
- **Mode-aware retrieval.** Modes change the prompt, not what is fetched from memory. `boost` searches
  more, but through the ordinary tools.

## 18. Open questions

1. **Should `/style` use setup's numbered menus instead of `<axis> <value>` arguments?** The
   argument form is specified above because it is one round trip and trivially testable. The menu
   form matches setup and needs no memorized enum values. Either is compatible with everything else
   here.
2. **Should the strip mark an unconfirmed timezone rather than just dropping the place name?**
   Section 11.1 drops the place name, which is quiet and honest but gives the user nothing to act on.
   A marker (a trailing `?`, a different colour) would prompt a correction sooner and clutter the
   line more. Left open because it depends on how often a system-default zone actually survives the
   first conversation, which is not knowable until the time spec ships.
3. **What happens to a live session's mode when the same memory folder is open in the CLI and the
   browser at once?** Modes are per session and sessions are independent, so nothing breaks, but two
   sessions in different modes writing to the same transcript store is worth confirming against the
   registry's live-session handling before implementation rather than after.
4. **Does `boost` need its own retrieval budget?** It is the one mode whose quality depends directly
   on how much of the record it reads, and the tool-round limit (`MAX_TOOL_ROUNDS = 8`,
   `agent.ts:29`) applies to it exactly as to every other mode. Raising it for one mode is a change
   to the loop's shape, so it is not being done blind; it is worth measuring during the dogfooding
   pass in section 16.10 before deciding.
