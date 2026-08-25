# Dreaming: design

## Context

Dreaming is a background process that revisits stored memory, recombines it across time and
theme, and writes back two artifacts per run: a short creative narrative for the person to read,
and a set of hedged, evidence-pointed insights for the companion to draw on in later
conversations. The full idea space, the prior art, the three approaches weighed, and the dated
decision log live in `docs/dreaming.md`, the working record for this feature. This spec says
what v1 builds. Where the two disagree, this spec wins for v1 and the working record gets a
correction.

Design decisions here were made with the human in a brainstorming session on 2026-08-24, per
AGENTS.md. Approach 1 from the working record was chosen: dreaming as a maintenance-style module
in `packages/memory` beside `reflection.ts` and `rollups.ts`, extended with a bounded read-only
tool loop.

Verified against the code before writing this spec:

- No scheduler exists for memory work. Reflection and rollups run synchronously inside
  `MemoryEngine.open` (`packages/memory/src/engine.ts:417-476`); the only timer is the server's
  60-second sweep (`packages/server/src/registry.ts:125`, injectable `RegistryScheduler`).
- Completion state is the artifact: pending rollups are computed by diffing session dates
  against existing rollup files (`engine.ts:1607-1640`). No job table exists anywhere.
- `DOC_KINDS` is a closed enum (`packages/memory/src/sqlite.ts:18-30`) enforced by the P8 wiring
  test (`packages/core/src/docKinds.test.ts`): every kind needs a `search_memory` description
  entry, a defined `documentDateSpan`, and a prompt cap or an explicit exemption.
- `config.toml` validates with `z.strictObject` and fills nested defaults by pre-seeding absent
  sections (`packages/core/src/config.ts`). `profile.md` is deliberately passthrough
  (`packages/memory/src/profile.ts`).
- The prompt budget is measured in characters, every cap is hard and independent, and a test
  asserts the section caps sum to `PROMPT_BUDGET_TOTAL` (`packages/core/src/budget.ts`).
- The LLM structured-output house pattern is zod schema, one corrective retry, then degrade
  (`packages/memory/src/reflection.ts:366-401`).

## Goals

- Old memory circulates: nothing goes too long without being reachable by a dream.
- Each dream connects distant material (across time, realms, people) rather than summarizing
  recent material; rollups already do recency.
- Insights are grounded: every claim carries evidence pointers that are verified to resolve.
- The narrative is deliberately non-literal, vivid, and positively oriented. Never a nightmare.
- Everything is appended, inspectable, and attributable. Nothing existing is modified.
- Runs are best effort on a machine that is not always on, idempotent per cadence period, and
  bounded in cost.

## Non-goals for v1

Graph writes of any kind, relevance-ranked prompt injection, transcript-level attribution
tagging, cross-dream consolidation, dream series, user-seeded dreams, bandit-style selection
tuning from feedback. All recorded in `docs/dreaming.md` sections 5, 9, and 10 as later work.

## Vocabulary

- **Dream run**: one execution of the pipeline, producing one dream directory.
- **Period**: the cadence unit, a local day (`YYYY-MM-DD`) or a local ISO week (`YYYY-Www`),
  computed in the profile timezone. A period is **due** when dreaming is enabled, the memory
  folder has at least `MIN_REFLECTED_SESSIONS` reflected sessions, and no dream directory for
  that period exists.
- **Seed**: a starting entity for a run: a document or graph node chosen by weighted sampling.
- **Insight**: one observation inside `insight.md`, with its own stable id, kind, confidence,
  and evidence pointers.

## Storage

Mirrors the sessions layout: one directory per dream under `dreams/`.

```
dreams/
├── log.jsonl                     Append-only dream log (coverage, feedback, mentions)
└── 2026-08-24-dream_01H.../      One directory per dream run
    ├── dream.md                  The narrative, kind: dream
    ├── insight.md                The insights, kind: dream_insight
    └── process.jsonl             Per-run process log (seeds, walk, tool calls, outcome)
```

- The directory name is `<local-date>-<dreamId>`, `dreamId = newId('dream')` (new id prefix).
- `dream.md` frontmatter: `{ id, kind: 'dream', dream: dreamId, date, period, voice, seeds }`.
  Body: the narrative, 300 to 600 words.
- `insight.md` frontmatter: `{ id, kind: 'dream_insight', dream: dreamId, date, period, seeds,
  rngSeed, insights: [...] }`. The `insights` array is the machine-readable record, one entry
  per insight: `{ id: 'ins_<ulid>', kind, confidence, evidence: [...pointers], headline }`.
  The body carries the prose for each insight under a heading that names its id. Machine data
  in frontmatter, meaning in prose, the same posture profile.md takes.
- Insight kinds: `pattern | change_over_time | connection | open_question | strength`.
- Evidence pointers are typed: `{ doc: docId }`, `{ session: sessionId }`, or
  `{ node: nodeId }`. At least one per insight, enforced by schema, and each pointer is
  resolved against the folder/index before the file is written. An insight with no resolvable
  pointer is dropped, not written.
- Both files are written with `writeDocumentAtomic`, once, and never edited afterward.
- `process.jsonl` records, one line per event: run start (trigger, model, rngSeed), each seed
  with its selection weight, each walk step, each tool call and its truncated result size, each
  model call (model, duration, token usage when the provider reports it), the tone-check
  verdict, and the outcome. This is the user-visible audit trail (working record idea 24).

### The dream log (`dreams/log.jsonl`)

Append-only jsonl, zod-validated on write and read like `graph.jsonl`. Record types:

- `{ ts, type: 'dreamt', dream, period, entities: [...] }`: which entities a run touched
  (seeds plus walk plus anything read in the tool loop). This is what `dream_state` derives
  last-dreamt times from.
- `{ ts, type: 'feedback', insight, dream, verdict: 'right' | 'wrong' | 'do_not_bring_up',
  note?, source: 'ui' | 'tool' }`.
- `{ ts, type: 'mentioned', dream }`: the opener mentioned this dream (mention-once semantics).

Records are never rewritten. Later feedback on the same insight wins by fold order.

## Doc kinds and index wiring

Two new kinds join `DOC_KINDS`: `dream` and `dream_insight`. Both are indexed (FTS plus
embeddings), searchable through `search_memory`, and readable through `read_document`. P8 wiring:

- `search_memory` kinds description names both.
- `documentDateSpan` returns the dream's date for both (point-in-time documents, like
  summaries).
- Prompt caps: `dream` is prompt-exempt like `journal` (never injected; reached only through
  search and read; the narrative is for the person, not the model). `dream_insight` material is
  injected through a new section with its own cap (see Surfacing), but the documents themselves
  are not injected wholesale; the section renders selected insights. The kind is declared
  prompt-exempt in `PROMPT_SECTION_CAP` with a comment pointing at `DREAM_INSIGHTS_SECTION_CAP`,
  which joins `SECTION_CAPS`, and `PROMPT_BUDGET_TOTAL` is raised by the same amount.

Dream coverage state (last-dreamt time per entity, latest feedback per insight, mentions) is
derived by folding `dreams/log.jsonl` in memory at the moment it is needed. At one dream per
period the log stays small for years, so v1 has no `dream_state` SQLite table; if the fold ever
becomes measurable, a derived table is the optimization, and like `nodes` and `edges` it would
never be a source of truth. (Amended 2026-08-24 during planning; the working record has the
reasoning.)

## Selection

Deterministic given the memory folder and a recorded RNG seed. A small seeded PRNG
(mulberry32-style, no `Math.random`) drives all sampling; the seed is recorded in
`insight.md` frontmatter and `process.jsonl`, so any dream's selection is reproducible.

1. **Candidate pool**: every indexed document (except `journaling`, `dream`, and
   `dream_insight`) and every graph node. Journal entries are included; their prompt exemption
   is about injection, not about dreaming. Dream documents are excluded on purpose: past dreams
   reach a run only through the digest, as context, so a dream can never select itself or a
   sibling as source material, which closes the reflect-on-reflections loop structurally.
   (Amended 2026-08-24 during planning.)
2. **Weight** per candidate: `staleness * significance + jitter`.
   - Staleness: days since `last_dreamt_ts` (never dreamt counts from the entity's own date),
     with a soft cap so ancient untouched entities do not drown everything else.
   - Significance: graph degree for nodes; for documents, a small per-kind base weight
     (constitution and open arcs above rollups) plus recency-independent signals like session
     count for a person. Exact constants are implementation detail, tested as invariants
     (an undreamt old arc must eventually outweigh a freshly dreamt recent one).
   - Jitter: a bounded random term from the seeded PRNG, the deliberate element of chance.
3. **Seed pairing**: two or three seeds, sampled by weight with a distance constraint: not the
   same realm, not the same person, and when dates are known, at least 60 days apart, relaxed
   progressively if the pool is too small to satisfy it. One seed slot is reserved for a
   low-recency candidate (older than the median candidate age) so every dream reaches back.
4. **Walk**: from each seed that is a graph node, a bounded random walk over folded graph state
   (default 3 hops, degree-weighted, no revisits) collects the surrounding cast. Document seeds
   contribute their linked nodes first. The walk path is recorded in `process.jsonl`.
5. **Calendar resonance**: if any candidate's date span lands within seven days of "exactly one
   or more years ago this week," it gets a weight boost. Cheap, and very human.

## The dream run pipeline

All in `packages/memory/src/dreaming.ts`, driven by engine deps plus a narrow read-only lookup
interface the engine implements (search, read document, read transcript, graph neighbors).

1. **Assemble the packet**: constitution (capped as in the prompt path), profile summary, the
   seeds' documents, walk results, and a digest of the last few dreams (their seeds, insight
   headlines, open questions, and any feedback verdicts). Past dreams are context for
   continuity and non-repetition, never evidence: the prompt says so explicitly, and the
   insight schema's evidence pointers cannot reference dream documents.
2. **Dig deeper, bounded**: a tool loop against a read-only roster: `search_memory`,
   `read_document`, `read_transcript`, `graph_query`. No write tools exist in this loop. Hard
   cap of `maxToolCalls` (default 10) enforced in code; the prompt instructs restraint (follow
   what the seeds raise; do not attempt to read the whole record). Every call is logged to
   `process.jsonl`.
3. **Insights call**: one structured-output call producing the `insights` array plus prose,
   validated by zod using the house pattern: retry once with the validation error, then on
   second failure abort the run (no artifact, period stays due; unlike reflection there is
   nothing safe to degrade to). Evidence pointers are then resolved; insights that fail
   resolution are dropped, and if none survive, the run aborts.
4. **Narrative call**: one call producing the dream narrative in the configured voice, at a
   higher temperature than the insights call, prompted toward recombination, atmosphere, and a
   gently positive or curious register. Counterfactual framings are allowed here and only here.
5. **Tone check**: one cheap structured call classifying the narrative: positive orientation,
   no nightmare content, no crisis or self-harm content, no diagnosis, no second-guessing the
   user's character. On failure, regenerate the narrative once. If it fails again, the run
   completes with `insight.md` only, `dream.md` withheld, and `process.jsonl` says so. The
   insights themselves are constrained by their schema and prompt (hedged, falsifiable, "it
   looks like" framing, never "you are") and are checked by the same tone pass: an insight the
   pass flags is dropped like an unresolvable one, and if none survive, the run aborts.
6. **Write**: create the dream directory, write `dream.md`, `insight.md`, and `process.jsonl`
   atomically, append the `dreamt` record to `log.jsonl`, index the new documents, release the
   lock. Process events are buffered in memory during the run and written as `process.jsonl`
   at the end; the directory is created only after every model call has succeeded, so a crashed
   or failed run leaves nothing in the memory folder but the lock, which goes stale. Failure
   diagnostics go to the process's normal logging, not the folder.

Model: `models.dreaming` when set, else `models.reflection`. Plumbed as `dreamingModel` in
`EngineDeps` beside `reflectionModel`. The persona for the active safety mode is prepended to
every model call in the pipeline, exactly as `assembleSystemPrompt` does for turns; there is no
other safety gate to lean on.

Budget per run, all configurable with defaults: 2-3 seeds, 3 hops, and a tool loop of at most
10 tool calls (each loop turn is itself a model call), then at most two attempts each for the
insights call, the narrative call, and the tone check. Everything that spends money is bounded
by a constant.

## Scheduling

The cadence names a period, not a time. Every trigger asks one question: is the current period
due? If yes, run; if no, do nothing. Consequences, all deliberate:

- At most one dream per period regardless of how many triggers fire.
- Missed periods are never backfilled. After a two-week laptop shutdown under daily cadence,
  exactly one dream runs, and per-entity staleness makes it range widely. Dreaming is about the
  present state of memory, not an artifact per calendar slot.
- Provider failure means no artifact, so the period stays due and the next trigger retries. A
  process attempts a given period at most once per invocation, so a hard failure does not spend
  money in a loop.
- The off switch makes no period due. Switching on makes the current period due. Nothing is
  deleted, and the gap is not backfilled.

Triggers, each individually switchable in config:

1. **After reflection** (`afterSession`): when a session ends and its reflection completes, in
   the same process, after the reflection write. Default on.
2. **At startup** (`onStart`): after `runMaintenance` in `MemoryEngine.open`, started in the
   background (fire-and-forget promise with error logging), never blocking the first turn or
   the CLI prompt. Default on.
3. **Server timer** (`serverTimer`): the server's existing sweep pattern, a second scheduled
   callback checking period dueness every 30 minutes. Default on. Uses the same injectable
   `RegistryScheduler` shape so tests drive it manually.
4. **On demand**: `reverie dream` runs immediately. Manual runs are exempt from the
   once-per-period rule (they run even when the period is done and are marked
   `trigger: 'manual'` in the process log) but respect the switch being off with a clear
   message and a `--force` escape hatch. `--dry-run` prints seeds, weights, and the walk
   without any model call.

**Concurrency**: a lock file `dreams/.lock` created with exclusive create (`wx`). It contains
the period, pid, and timestamp. A lock older than 15 minutes is stale and may be taken over.
The lock is removed on completion or failure. CLI and server processes share it through the
filesystem.

**Minimum memory**: dreaming does not run until the folder has at least 5 reflected sessions
(summary documents). Below that, triggers no-op and `reverie dream` explains why.

## Configuration

Split by what it governs. System-level knobs (cost, what runs) live in `config.toml`, validated
strictly; reading preferences live in `profile.md`, passthrough like everything else there.

`config.toml` additions:

```toml
[models]
dreaming = "gpt-5-mini"     # optional; falls back to models.reflection

[dreaming]
enabled = false              # default off until the person turns it on
cadence = "daily"            # "daily" | "weekly"
triggers = { afterSession = true, onStart = true, serverTimer = true }
maxToolCalls = 10            # optional overrides, defaulted
```

The `[dreaming]` section is absent-safe via the same nested-defaults fill `models` uses.
`enabled = false` by default: dreaming spends the person's money on a background process, so it
is opt-in, surfaced during `setup` and in settings.

`profile.md` additions (typed in `ProfileMeta`, optional):

```yaml
dreams:
  voice: first        # first | second | third, narrative voice
  openerMention: true # may the session opener mention a fresh dream
  promptSection: true # inject dream insights into the system prompt
```

All three are changeable from the CLI settings surface and the web Settings view.

## Surfacing

1. **Prompt section**: a new `dreamsSection` in `assembleSystemPrompt`'s ordered list, rendered
   from `SessionContext`. Content: the most recent insights (newest first) whose latest
   feedback verdict is not `wrong` or `do_not_bring_up`, each as its headline plus claim prose,
   with open questions listed last as things worth asking when natural. Capped by
   `DREAM_INSIGHTS_SECTION_CAP = 1800` characters, added to `SECTION_CAPS`, with
   `PROMPT_BUDGET_TOTAL` raised to match. Omitted entirely when empty, when
   `profile.dreams.promptSection` is false, or when dreaming has never run. Clock-free like
   every other section: it reads state as of `sessionContext`'s date argument.
   The section's preamble tells the model these are its own tentative between-session
   reflections, to be drawn on naturally, attributed honestly when used ("going back over
   what you told me..."), and dropped when the person says they are wrong, recording that
   through `dream_feedback`.
2. **Opener mention**: when `profile.dreams.openerMention` is true, a dream exists for the
   current or previous period, and no `mentioned` record exists for it, the opener may mention
   it lightly, and a `mentioned` record is appended so it happens once. Never in `decompress`
   mode. There is no runtime crisis flag to key off, so restraint in distress is prompt-level:
   the opener guidance tells the model to leave the dream unmentioned when the person arrives
   in distress, and the safety persona already governs everything it says.
3. **Search and read**: both kinds are reachable through `search_memory` and `read_document`
   like any other document, so the companion can pull older dream material when a topic calls
   for it.
4. **CLI**: `reverie dream` (run now), `reverie dream --dry-run`, `reverie dream --list`
   (table: date, period, seeds, insight count, feedback counts), `reverie dream --show <id>`
   (renders dream.md, insight.md, or the process log).
5. **Web**: a Dreams view beside Journal, backed by new read-only server endpoints
   `GET /api/v1/dreams` and `GET /api/v1/dreams/:id`, plus
   `POST /api/v1/dreams/:id/feedback` for the controls below. The view shows the narrative and
   the insights separately, matching the two-file split, plus the process log behind a
   disclosure. The web package talks HTTP only, as always.

## Feedback

Two paths, one record:

1. **On the artifact**: the web Dreams view (and `reverie dream --show`) offers right / wrong /
   do not bring this up per insight. The web posts to the feedback endpoint; the CLI appends
   directly through the engine. Both append `feedback` records to `log.jsonl`. (Corrected
   2026-08-25: v1 ships `reverie dream --show` read-only, displaying verdicts recorded through
   the web view or the `dream_feedback` tool rather than appending its own. A CLI write path
   needs either a third value on the `feedback` record's `source: 'ui' | 'tool'` field or a
   dishonest `'ui'` label for a terminal-issued verdict, a log-format decision left to the human
   rather than resolved during implementation; the working record has the full reasoning.)
2. **In conversation**: a new `dream_feedback` tool in the companion's roster, args
   `{ insightId, verdict, note? }`, zod-validated, appending the same record with
   `source: 'tool'`. The prompt section's preamble licenses its use when the person reacts to
   a dream-derived observation.

Effects in v1: `wrong` and `do_not_bring_up` permanently exclude the insight from the prompt
section and the opener; the dream digest handed to future runs includes verdicts so new dreams
do not re-raise rejected framings. Feedback does not alter selection weights in v1; the log
retains everything a later bandit-style tuner would need (working record, idea 18).

## Safety and honesty

- The active safety mode's persona is part of every dreaming model call. Dreaming never reads
  the safety mode as data to change, never adjusts conversational tone on its own, and its
  outputs reach conversations only through the capped, switchable section and opener.
- The tone check gates the narrative for nightmare, crisis, and self-harm content, and gates
  insights for unhedged character claims. Insights must be falsifiable observations with
  evidence, never verdicts about who the person is.
- Everything is appended: dream files are write-once, the dream log is append-only, and
  `dream_state` is derived. There is no rewrite path, which is the structural answer to the
  silent-rewriting failure ChatGPT's dreaming feature was criticized for (working record,
  section 4).
- The README gains a Dreaming subsection saying what it is, that it is off by default, what it
  costs (model calls on a cadence), that insights are the model's guesses and can be marked
  wrong, and where the files live. The Status section is updated honestly as pieces land.

## Interactions with the recall-and-event-time work

A concurrent worktree (`recall-and-event-time`) carries an execution plan
(`2026-08-24-recall-and-event-time-fixes.md`, partially landed) and an unapproved design
(`2026-08-24-commitments-design.md`). Reviewed on 2026-08-24. Four interactions bind this spec;
the rest is merge-order housekeeping.

1. **Event time is stated, never resolved.** That work establishes the convention that a
   person's stated event time ("tonight", "come summer") is carried as words paired with the
   date it was said, rendered as `(eventTime: "...", as stated on <date>)`, and never resolved
   to a timestamp. Dreaming adopts it: a document's date is when something was recorded, not
   when it happened or will happen. The pipeline prompt states this, insights about intentions
   inherit the same rule that work added to the prompt ("a recorded intention is evidence the
   person said they meant to do something, never evidence that they did it"), and an insight
   that turns a stated plan into a completed fact is exactly the kind of unhedged claim the
   tone check rejects. Calendar resonance keys off record dates and says so ("around this time
   last year you were talking about...", not "a year since you did...").
2. **Commitments, when they land, get dreamed about but never nagged about.** The commitments
   design's structural guarantees (no overdue state, one follow-up ask recorded in `askedAt`,
   quiet state, never enumerated as a list, the interpreted time bracket selects but only the
   stated gloss speaks) bind dreaming too. The candidate pool is defined over all graph node
   types, so a future `commitment` node joins selection and walks automatically. But an
   `open_question` insight must never target a commitment whose one ask is spent or that is
   marked quiet, and dream prose never renders an interpreted time bracket. Nothing to build in
   v1 (no commitment type exists in code yet); this paragraph is the contract for whichever
   lands second.
3. **`dream_feedback` needs a CLI tool notice.** That worktree adds a completeness test over
   the CLI's `TOOL_NOTICES` table: every tool must have a notice entry. The `dream_feedback`
   tool ships with one.
4. **Search results now carry optional date spans.** `SearchHit` gained `dateStart`/`dateEnd`
   (present together or absent together). The dream tool loop treats absent dates as a living,
   continuously rewritten document, never guesses a date for one.

Merge order: both branches touch `context.ts`, `engine.ts` (`SessionContext`), `sqlite.ts`, and
the CLI chat module. Conflicts are routine but real; the dreaming implementation plan starts by
rebasing onto whatever of that work has merged.

## Package placement

- `packages/memory`: `dreaming.ts` (selection, pipeline, storage), dream log read/write,
  `dream_state` in `sqlite.ts`, new doc kinds, id prefix, paths. Follows `reflection.ts` and
  `rollups.ts` in shape and deps.
- `packages/core`: `dreamsSection` in `context.ts`, budget constant, `SessionContext` fields,
  `dream_feedback` tool in `tools.ts`, config schema additions, trigger wiring in the engine
  open path and session close path, docKinds wiring test updates.
- `packages/server`: the timer trigger, three endpoints.
- `packages/cli`: the `dream` command and settings surface.
- `packages/web`: the Dreams view, Settings additions.

Dependencies stay downward-only. The tool loop in `memory` calls engine-level lookup functions
directly; it does not import `core`'s tool dispatch.

## Testing

Per AGENTS.md: TDD for everything deterministic, fixtures and schema assertions for LLM
behavior, and falsification for every test (delete the behavior, watch the test fail).

- Deterministic, test-first: period math across timezones and cadences (including the week
  boundary), dueness, the once-per-period and manual-exemption rules, lock acquisition and
  staleness, selection weights and the distance constraint given a fixed rngSeed and fixture
  folder, walk boundedness, dream log fold semantics, feedback exclusion, `dream_state`
  rebuild, evidence-pointer resolution dropping unresolvable insights, budget invariants.
- Fixture-driven: the pipeline against `FakeChatProvider` scripts covering the happy path,
  schema failure then retry, double failure aborting with no artifact, tone-check failure
  withholding the narrative, tool-loop cap enforcement.
- Wiring: the P8 docKinds test extended for both kinds; the SECTION_CAPS sum test updated; a
  `TOOL_NOTICES` entry for `dream_feedback` so the CLI notice completeness test passes.
- Manual checks (deferred to the manual testing queue): reading actual dreams for tone and
  quality across the three voices, opener behavior, web view.

## Out of scope for v1, recorded for later

Graph writes (unconfirmed `relates_to` edges, `theme` nodes, retract-on-feedback), relevance-
ranked injection, transcript-level attribution, insight decay, cross-dream consolidation, dream
series, user-seeded and in-conversation-requested dreams, feedback-driven selection tuning.
Each is expanded in `docs/dreaming.md` sections 5 and 10.
