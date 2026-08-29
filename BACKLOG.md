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

- **`journaling.md` is being overwritten with a session summary every journal session, destroying
  the person's actual journaling setup.** `journaling.md` is a maintained document: it is meant to
  hold how this person journals, the format they settled on and the frame around it. Instead, each
  journal-mode session rewrites the whole file with prose summarizing what happened in that
  session. The real setup survived for one commit and has been gone since.
  - Why deferred: not deferred by anyone's decision. Reported by the owner on 2026-08-25 ("my
    journaling methodology choice I'd made about four or five days ago has gotten erased into like
    a journal file markdown file with like just boilerplate text"), asked to be recorded and
    investigated rather than fixed on the spot, with the explicit instruction that it must not be
    called a non-issue without investigation.
  - Evidence, from `git log --follow -- journaling.md` in the owner's own memory folder, which
    makes this recurring rather than a one-time loss. The correct content appears once, at
    `942cc40` (2026-08-20 13:49): "Journaling is set up as an open-format practice with a very
    light frame: one or two simple openers, responsive follow-ups, gentle nudging, and backing off
    when Vishal shows resistance. The target is most evenings for about 5-10 minutes, adjustable as
    needed." Every commit after that replaces it with a session narrative instead:
    `aecce52` (08-21 21:00) "This conversation was recorded as Vishal's journal entry for the
    evening..."; `7b1e04c` (08-22 16:33) "Corrected the movie timeline: Halcyon was the Ashford
    family outing..."; `9c3ab27` (08-25 16:55) "Nightfall with Arjun took place on Sunday..."; and
    finally `59f2d15` (08-25 22:30) "Vishal selected journal mode for this session." Eight rewrites
    in five days, none of which describe a journaling method.
  - Where the thinking already lives: the `update_journaling_protocol` tool in
    `packages/core/src/tools.ts`, whose own description says to call it "with the complete new
    document body, full prose, a whole rewrite, never a diff", which is exactly the shape that
    turns one wrong call into total loss; `buildJournalModeParagraph` and
    `JOURNALING_PROTOCOL_ABSENT` in `packages/core/src/journaling.ts`; the journal-mode branch of
    `_doEndSession` in `packages/memory/src/engine.ts`, which writes a journal entry on session
    end; and `docs/superpowers/specs/2026-08-17-modes-profile-settings-plan.md` for the original
    design of what this document is for.
  - Two things to establish before fixing. First, whether the bad write comes from the model
    calling `update_journaling_protocol` with a session summary (a prompt problem) or from
    reflection writing session prose into this path (a code problem); the transcripts and
    `graph.jsonl` for the sessions named above will say which. Second, whether a whole-document
    rewrite tool is the right shape at all for a document whose whole value is that it persists:
    every other maintained document in this project is revised, not replaced wholesale, and the
    same class of "one bad call erases everything" risk applies to `update_profile` and to arc
    narratives.
  - Trigger to pick up: already triggered. The owner's setup is currently lost and the next journal
    session will overwrite the file again.
  - Rough size: small to medium to diagnose and fix once the cause above is known. Recovering the
    owner's own lost setup is separate and trivial, since `git show 942cc40:journaling.md` in the
    memory folder still has it.

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

- **Seven open deviations between the approved dreaming spec and what shipped in v1.** Each was
  caught during implementation or the final whole-branch review, recorded, and deliberately left
  for a human decision rather than resolved on an implementer's own judgment: "Both are format and
  data-honesty decisions, not implementation work, so the choice is left to the human." Full detail
  is in `docs/dreaming.md` section 14 (the changelog, the two 2026-08-25 entries and the final
  whole-branch review entry).

  1. **The CLI cannot record dream feedback, only display it.** The spec says the CLI "appends
     directly through the engine," matching the web path; `reverie dream --show` displays verdicts
     recorded elsewhere (the web UI, the `dream_feedback` tool) but has no command to record a new
     one. Deciding this means choosing how a terminal-issued verdict is represented: the
     `feedback` record's `source` field is typed `'ui' | 'tool'`, so either that enum gains a
     third value (changing an append-only log's record shape) or a CLI verdict is written under
     `source: 'ui'`, which would be false.
     - Why deferred: "the `feedback` record's `source` field is typed `'ui' | 'tool'`... Both are
       format and data-honesty decisions, not implementation work, so the choice is left to the
       human rather than resolved on the implementer's own judgment."
     - Where: `docs/dreaming.md`, section 14, the 2026-08-25 entry recording this deviation;
       `docs/superpowers/specs/2026-08-24-dreaming-design.md`, Feedback section.
     - Trigger: not stated.
     - Size: small, once the `source` field's shape is decided.

  2. **No CLI settings surface for the three dream preferences.** The spec says voice, opener
     mention, and prompt section are changeable "from the CLI settings surface and the web
     Settings view." The web half works (the 2026-08-25 review also fixed a bug where it silently
     did not); hand-editing `profile.md` is the only other route from the CLI.
     - Why deferred: not stated beyond it being one of the six deviations the final review left
       for a human decision.
     - Where: `docs/dreaming.md`, section 14, final whole-branch review entry, deviation 1.
     - Trigger: not stated.
     - Size: not stated.

  3. **Calendar resonance (selection step 5) was never built.** The spec calls for a weight boost
     when a candidate's date lands within about a week of "one or more years ago this week." This
     was already absent from the implementation plan before v1 shipped; it was not written down as
     a gap until the final review.
     - Why deferred: not stated.
     - Where: `docs/dreaming.md`, section 14, final whole-branch review entry, deviation 2;
       `docs/superpowers/specs/2026-08-24-dreaming-design.md`, selection step 5.
     - Trigger: not stated.
     - Size: not stated.

  4. **The dream packet omits the constitution and profile summary the spec lists as pipeline
     inputs.** What shipped is narrower: the exploration prompt tells the model that reading the
     constitution is fine, and the bounded tool loop can reach both the constitution and the
     profile through `read_document` if a seed calls for them. They are tool-reachable, not
     injected up front.
     - Why deferred: not stated.
     - Where: `docs/dreaming.md`, section 14, final whole-branch review entry, deviation 3;
       `docs/superpowers/specs/2026-08-24-dreaming-design.md`, Pipeline step 1.
     - Trigger: not stated.
     - Size: not stated.

  5. **`reverie dream` (`dreamNow`) lacks the spec's manual once-per-period exemption.** The spec
     says a manual run should be exempt from the once-per-period rule. The code still refuses an
     unforced manual run when the period is already covered, the same as a background trigger
     would; `--force` is the current workaround.
     - Why deferred: not stated.
     - Where: `docs/dreaming.md`, section 14, final whole-branch review entry, deviation 4
       (`dreamNow` in `packages/memory/src/engine.ts`).
     - Trigger: not stated (confirming whether the exemption is still wanted given the `--force`
       workaround).
     - Size: not stated.

  6. **The opener has no period bound.** The spec says the opener may mention a dream from the
     current or previous period. The code offers the newest dream that has a narrative and has not
     yet been mentioned, regardless of age, so a dream from months ago can still surface in an
     opener.
     - Why deferred: not stated.
     - Where: `docs/dreaming.md`, section 14, final whole-branch review entry, deviation 5.
     - Trigger: not stated.
     - Size: not stated.

  7. **The `dreamt` log record stores seeds only, not seeds plus walk plus tool-read entities.**
     The spec says it should store all three, since a `dream_state` fold would derive "last
     dreamt" times from that record. As shipped, anything reached only by the graph walk or by a
     tool call during the dig-deeper loop is never marked dreamt, so its staleness keeps accruing
     even after a dream actually touched it.
     - Why deferred: not stated.
     - Where: `docs/dreaming.md`, section 14, final whole-branch review entry, deviation 6.
     - Trigger: not stated (widening the `dreamt` record's shape touches the append-only dream
       log's format).
     - Size: not stated.

- **`PROMPT_BUDGET_TOTAL` is a convention held up by a comment, not an invariant a test can
  fail.** `packages/core/src/budget.test.ts` asserts `sum(SECTION_CAPS) <= PROMPT_BUDGET_TOTAL`
  over the constants alone. Raising the total always satisfies it, so the ceiling cannot bind
  anyone who does not want it to. It moved twice in two days: 28000 to 28800 when the commitments
  section landed on 2026-08-24, then to 30600 when dreaming landed on 2026-08-25. Both raises were
  deliberate and both are argued in comments, which is the most the current design allows.

  Worth stating plainly, because it changes what a fix should do: the number that moved is the sum
  of per-section caps (30400 today), a worst case in which every section simultaneously hits its
  ceiling. That almost certainly never happens, since `CONSTITUTION_CAP` and
  `RECENT_SUMMARIES_SECTION_CAP` are 6000 each and few memories fill either. So the raises are less
  alarming than the percentage suggests, and at the same time nobody knows what a real assembled
  prompt actually costs, because nothing has ever measured one. The system prompt sits in front of
  every turn, so whatever that real number is, it is paid on every message of every session.

  Three options, in the order they seem worth trying:

  - **Measure a real prompt first.** Render `assembleSystemPrompt` against a realistic fixture
    memory and report the assembled size. That turns an argument about a hypothetical maximum into
    a number, and it may show that 30600 worst-case is nowhere near what anyone pays.
  - **Assert against the rendered prompt rather than the constants**, once there is a fixture worth
    asserting on. That makes the budget bind on reality instead of on arithmetic.
  - **Freeze the total and force trimming.** The bluntest option, and the weakest of the three
    until the first is done: it would make people trade away caps against a ceiling that may not
    reflect any real prompt.
  - Why deferred: raised between the two branches merging on 2026-08-25 rather than inside either.
    The dreaming branch declined to pay for its section by trimming an established cap, on the
    stated grounds that "trimming an established section is a judgment about the existing prompt
    that did not belong in a merge", and both agents landed on that independently. Recorded here
    rather than acted on because the fix is a measurement question, not a merge question.
  - Where: `packages/core/src/budget.ts` (the `PROMPT_BUDGET_TOTAL` comment records the 28800 raise
    as a decision and explicitly not a rule), `packages/core/src/budget.test.ts` (the spelled-out
    literal exists to force someone to change it on purpose).
  - Trigger: a third raise. Two is fine, five is a problem, and a comment asking the next person to
    argue is weaker than a test that makes them.
  - Size: small for the measurement, medium if the assertion moves onto a rendered prompt.

- **config.toml has no live reload for dreaming settings.** `launchServer` calls `loadConfig`
  exactly once and bakes `config.dreaming` into the registry's `dreamTrigger` wiring at
  construction time; `MemoryEngine.open()`'s own `onStart` trigger is likewise decided once, at
  open time. Editing `[dreaming]` in config.toml while `reverie web` or a long-running CLI session
  is up has no effect until that process is restarted. The web Settings page now says this
  plainly, but the underlying limitation is still there.
  - Why deferred: found as a side discovery while fixing why the web never dreamt (2026-08-25
    dreaming investigation); not requested to be fixed, and a config watcher plus safe re-wiring
    of the live engine's dependencies is a larger change than this task's five named defects.
  - Where: `docs/dreaming.md`, 2026-08-25 changelog entry; `packages/server/src/launch.ts`.
  - Trigger: not stated.
  - Size: medium (a file watcher, plus a way to re-wire `dreamTrigger` and `EngineDeps.dreaming`
    on a live `MemoryEngine`/registry without restarting either).

- **`OpenAiChatProvider`'s temperature-preference retry covers `complete()` only, not `stream()`.**
  Fixed 2026-08-25: a model that rejects a non-default `temperature` (an HTTP 400 naming
  `error.param === 'temperature'`) is retried once without it in `complete()`, with the drop
  recorded on `ChatResult.warnings`. `stream()` has no equivalent, since nothing in the codebase
  currently sets `temperature` on a streamed call (only dreaming's narrative step ever sets
  `temperature` at all, and it always uses `complete()`).
  - Why deferred: no current caller exercises the streaming path with a temperature set, so
    building and testing a second retry path now would be speculative code with no real coverage.
  - Where: `packages/providers/src/openai.ts`; `docs/dreaming.md`, 2026-08-25 changelog entry.
  - Trigger: a future caller that sets `temperature` on a `ChatProvider.stream()` call.
  - Size: small (mirror `complete()`'s retry-and-warn logic; `ChatEvent` has no warnings-carrying
    variant yet, so that shape needs deciding too).

- **A host-supplied `dreamPersona` is not validated for content, so a persona with no crisis stance
  in it still reaches all four dream stages silently.** The empty-persona half of this entry is
  fixed: `packages/memory/src/engine.ts:3200` now throws, recording the attempt as `'failed'` first,
  whenever the rendered persona is empty or whitespace-only, mirroring the `dreamingModel` guard
  eight lines above it. It guards the rendered value, not whether the dependency is present, so a
  host stubbing `dreamPersona: () => ''` cannot land back in the silent state. What remains open:
  `dreamPersona` is still typed `(style: StyleConfig) => string` with no content validation
  (`engine.ts:330`), so a host can supply a persona that renders real prose and still omit the
  crisis stance, and this guard will not notice. Composing the crisis stance in the engine itself on
  the dream path, rather than trusting it to arrive inside a host-supplied string, is still unbuilt,
  because `packages/memory` sits below `packages/core` and cannot import `buildPersona`.
  `buildDreamPersona(mode, resources, options)` in `packages/core/src/personas.ts:288` remains the
  supported one-line way for a host to build the callback, called by
  `packages/server/src/launch.ts:134` and `packages/cli/src/chat.ts:583`, so a host going through
  either launcher gets its deployment context in dreams for free; a host opening `MemoryEngine`
  directly and building a persona some other way is exactly the case still exposed.
  - Why deferred: not a scoping decision, found and recorded during the Reverie Cloud round-two
    review. In our own words at the time: "the sibling hook `dreamingModel` is enforced with a loud,
    specific error... `dreamPersona` gets no equivalent guard, and degrades silently instead... This
    is a live hazard for you specifically... you are one forgotten dependency away from four
    unguarded model calls per dream, on a mental wellbeing product." The fail-loud half of that was
    shipped on 2026-08-29 (`a18fd10`). What is left open is exactly the half Reverie Cloud flagged as
    not yet closed even once the required-dependency guard shipped: "We would rather wait for the
    real fix than have the required-dep half shipped as though it closed the hole. It does not: it
    converts 'silently empty' into 'whatever the host returns, unvalidated', which is the same
    fail-open shape one step along." The "real fix" they mean is composing the crisis stance in the
    engine itself on the dream path rather than trusting it to arrive inside a host-supplied string,
    which both sides agree is a design round because `memory` cannot import `buildPersona`.
  - Reverie Cloud's round-three reply had confirmed the hazard was live for them before this fix,
    and their stated position on the fail-loud half was: "making `dreamPersona` required when
    dreaming is enabled, failing the way `dreamingModel` fails, is right and we would take it
    tomorrow." That half is now shipped in `a18fd10`; the content-validation half they described in
    the same reply is what this entry now covers.
  - Where: `packages/memory/src/engine.ts:3183` (where the persona is rendered), `:3200` (the guard
    that now ships), `:330` (the hook's type, still unvalidated for content);
    `packages/memory/src/engineDreaming.test.ts` (the guard's tests); `packages/core/src/personas.ts:288`
    (`buildDreamPersona`); `packages/server/src/launch.ts:134` and `packages/cli/src/chat.ts:583`
    (both call it); `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 1 ("Two places
    where you are wrong"), "1.2 Part B2 closes the front door while the back door is open";
    `reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, section 4.
  - Trigger: not stated for the remaining, engine-composed half. Reverie Cloud's stated blocking
    condition was about the half that has now shipped: "this is now a blocking prerequisite on
    slice 2 rather than a task inside it: we do not wire `dreamingModel` until `dreamPersona` is
    wired in the same change, and the hosted deployment string reaches both."
  - Size: medium. Needs a way for `memory` to receive the crisis text without importing `core`.

- **The test suite mints a temp fixture directory per test and a full run leaves hundreds of them
  behind, some never removed by any code path.** A single full `pnpm test` run left 289 `openreverie-*` directories behind in
  `$TMPDIR`, and repeated runs filled the machine's disk completely, to the point where no command
  could run at all. Tests create these directories with `mkdtemp(join(tmpdir(), 'openreverie-...'))`
  across `packages/memory`, `packages/core`, `packages/cli`, and `packages/server`; most pair that
  call with an `afterEach` that calls `rm(dir, { recursive: true, force: true })` (or, in
  `packages/memory/src/engine.test.ts`, a retrying `rmWithRetry` wrapper around the same call, added
  there specifically to ride out a flaky `ENOTEMPTY`), but that pattern is not applied everywhere a
  directory is minted. Confirmed by reading: `packages/memory/src/reflection.test.ts:1297` mints a
  second, inline temp directory inside one test (distinct from the suite's own `dir` fixture, which
  its `afterEach` at `:312`-`313` does clean up), holds it open only in a `try`/`finally` that closes
  the `MemoryIndex` at `:1323` and never removes the directory itself, so that one leaks on every run
  regardless of pass or fail.
  - Why deferred: found while running verification for the three-defects pass on 2026-08-29, not
    scoped out of an existing task. The fix is mechanical (spread the existing `afterEach` /
    `rm(dir, { recursive: true, force: true })` pattern, or the retry wrapper where a database file
    is involved, to every `mkdtemp` call that lacks it), but it touches many test files.
  - Where: `packages/memory/src/*.test.ts` and others using
    `mkdtemp(join(tmpdir(), 'openreverie-...'))`; the confirmed leak at
    `packages/memory/src/reflection.test.ts:1297` (directory minted), `:1322`-`1324` (`finally`
    block that closes the index but never removes the directory); the cleanup pattern to spread is
    `packages/memory/src/reflection.test.ts:312`-`313` (plain `afterEach` + `rm`) or
    `packages/memory/src/engine.test.ts:27`-`37` (`rmWithRetry`, for cases hitting the `ENOTEMPTY`
    flakiness that motivated the retry).
  - Trigger: not stated.
  - Size: small per file, medium across the suite.

- **The rollup prompts duplicate `PROSE_VOICE_RULE` and have already diverged, with no test
  coverage.** `DAILY_ROLLUP_PROMPT` and `WEEKLY_ROLLUP_PROMPT` at `packages/memory/src/rollups.ts:154`
  reimplement one clause of `PROSE_VOICE_RULE` (`packages/memory/src/voice.ts:15`) inline ("Plain
  prose, no headings, no em dashes") instead of importing it, and the two no longer say the same
  thing: the canonical rule also covers sentence-length variation, rhetorical triads, the "it's not
  just X, it's Y" construction, and a named list of filler words, none of which the rollup prompts
  mention. `rollups.test.ts` asserts nothing about this text. Also: neither rollup prompt states the
  actual date or week being summarized, so the model synthesizes "this day" or "this week" with no
  date grounding at all, relying entirely on the summary bodies handed to it.
  - Why deferred: not stated (found during the round-two review as a defect, not a scoping
    decision).
  - Where: `packages/memory/src/rollups.ts:154` (`DAILY_ROLLUP_PROMPT`, `WEEKLY_ROLLUP_PROMPT`);
    `packages/memory/src/voice.ts:15` (`PROSE_VOICE_RULE`); `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`,
    section 8 ("What you have not thought of"), item 5.
  - Trigger: not stated.
  - Size: small.

- **`set_mode`'s computed description has no drift guard.** `packages/core/src/tools.ts:611`
  enumerates `MODE_NAMES` into the tool description, correct by construction today, but no test
  checks the content of what it builds: the existing tests check only the nested
  `parameters.properties.mode.enum` array against `MODE_NAMES`, unaffected by the description
  string, and three fixed phrases in the description unrelated to the per-mode list. Nothing in the
  suite would catch a bug in the string-building logic itself listing nine modes instead of ten.
  Contrast `search_memory`'s `kinds` parameter description, a hand-typed copy of `DOC_KINDS` that
  `docKinds.test.ts` does guard by asserting the description contains every enum value.
  - Why deferred: not stated (found during the round-two review as a gap, not a scoping decision).
  - Where: `packages/core/src/tools.ts:611` (`set_mode`); `packages/memory/src/sqlite.ts:86`
    (`DOC_KINDS`) and `docKinds.test.ts` (the contrasting guard that exists);
    `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 4 ("Part C, tool
    descriptions").
  - Trigger: not stated. Relevant if tool description overrides (section 4 below, "A
    host-configurable prompt and tool-description surface") are ever built: any override seam must
    special-case `set_mode` and keep this live enumeration, since a naive full-replace would freeze
    the mode list.
  - Size: small.

- **`timeSection`'s system-default timezone caveat inverts meaning on a hosted server.**
  `packages/core/src/context.ts:178` appends "This timezone is a system default, not yet confirmed
  by the person. Confirm it naturally if the moment allows, rather than assuming it is correct."
  whenever `context.timezoneSource === 'system-default'`. Written for the CLI, where the system zone
  is a decent guess about the person (their own machine's clock). On a hosted server, "system
  default" is a fact about the datacentre, not a guess about the person, so the caveat's implicit
  reasoning ("probably close, just double check") reads backwards: the default could be many hours
  off with nothing marking that distinction.
  - Why deferred: not stated (found during the round-two review; not a launch blocker, but "the
    same category of bug" as the deployment-claim launch blocker fixed in the same change).
  - Where: `packages/core/src/context.ts:178` (`timeSection`); `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`,
    section 8, item 3.
  - Trigger: not stated.
  - Size: small.

- **Search cannot fall back to its lexical half when embeddings are unavailable.** `searchMemory`
  (`packages/memory/src/retrieval.ts`) awaits `embeddings.embed` unconditionally with no `try`, and
  the lexical hits it has *already computed* are discarded when that call throws. So a provider
  outage, or a bundled Node server with no API key configured, loses hybrid search entirely rather
  than returning the half that needs no model at all.
  - Why deferred: found while building `GET /api/v1/search`. Adding a lexical fallback is a
    retrieval design decision nobody asked for, and it changes what a search result means (a
    partial result that does not say it is partial is worse than an honest failure). The route has
    a defined answer in the meantime: it maps `ProviderUnavailableError` to a `503
    search_unavailable` rather than letting it fall through as an unhandled 500.
  - Where: `packages/memory/src/retrieval.ts` (`searchMemory`); the route's own catch in
    `packages/server/src/http-core.ts`.
  - Trigger: not stated. The case that would force it is a self-hosted person with no configured
    provider who wants to search their own memory, which is now reachable from the browser and was
    not before.
  - Rough size: small, plus a decision about how a partial result declares itself.

- **`EngineSearchResult.documents` is declared narrower than what it actually carries.** It is typed
  `SearchHit[]` (`packages/memory/src/engine.ts`) while `searchMemory` really returns
  `DocumentHit[]`, a superset carrying `chunks` and `chunksTotal`. TypeScript's structural typing
  lets the superset satisfy the narrower declaration without dropping those fields at runtime, so
  the declared type understates the payload. The original compat reasoning is recorded at
  `packages/memory/src/retrieval.ts:81-105` and was sound when the payload was internal.
  - Why deferred: it stopped being internal only just now, and widening the declaration touches
    every test fake that constructs one. Not worth folding into the release benchmark's own items.
  - Why it matters more than it did: that payload is public over HTTP as of `GET /api/v1/search`. A
    response schema built against the *declared* type would fail validation on every real query and
    return a 500. There is a comment at `searchDocumentHitSchema` in
    `packages/server/src/http-core.ts` warning about exactly that, which is a trap sign rather than
    a fix.
  - Where: `packages/memory/src/engine.ts` (`EngineSearchResult`);
    `packages/memory/src/retrieval.ts:81-105` (`DocumentHit`).
  - Trigger: not stated.
  - Rough size: small.

- **`packages/web/src/views/settings.test.tsx` flakes rarely under full-suite load.** Seen once, as
  a `waitFor` timing failure, during a full `pnpm test` run on 2026-08-30. Not reproduced in two
  further full runs or three web-only runs immediately afterwards.
  - Why deferred: not reproduced, so there is nothing yet to fix against. Recorded rather than
    dropped because an intermittently failing test is a real defect here, and because a flake that
    gets waved off is how a genuine ordering bug hides: one was found on this same branch when an
    intermittent ENOTEMPTY in `app.test.ts` turned out to be a real shutdown-drain defect in
    `LiveSessionRegistry.close`.
  - Where: `packages/web/src/views/settings.test.tsx`. Last modified in v0.7.3 (`1f8bef5`) and
    untouched by the host-configurable-deployment-context branch, so it predates that work.
  - Trigger: seeing it again, or a `waitFor` in that file failing in CI.
  - Rough size: small, once it is reproducible.

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
  - Hosted-deployment measurement, added 2026-08-28: Reverie Cloud's own round-two request calls
    this same code path `searchSemantic` (it is `MemoryIndex.searchVector`, reading every embedding
    row into memory, the function this entry already names) and measured it directly against its own
    target scale: "At 50,000 chunks that is around 102 MB against a 128 MB isolate cap that no local
    runtime enforces, so it passes locally and fails in production." Their design target is 20,000
    chunks; the finding was "raised in the previous round, still open," and our own reply confirms it
    remains open: "Still open, still real, still ours. Your 20,000 chunk target does not make it not
    a bug." This sharpens the trigger above for a hosted deployment specifically: a fixed per-request
    memory cap can be exceeded well short of "roughly one to three years of daily use" for one
    person, if a host's corpus is a tenant's, or otherwise larger. Where (added):
    `reverie-cloud/docs/specs/2026-08-28-openreverie-request-round-two.md`, part G;
    `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 7 ("Part G, your findings,
    acknowledged").
  - Size: large.

- **No proactive warning when a corpus holds vectors from more than one embedding model.** P0-6
  (`docs/superpowers/specs/2026-08-27-hostable-engine-design.md`) gave the `embeddings` table
  `model` and `dims` columns, and `MemoryIndex.searchVector` now rejects a stored row whose `dims`
  does not match the current query vector rather than comparing a truncated prefix of two
  incompatible vector spaces. That stops a wrong answer; it does not tell the person anything. If
  someone changes `embeddingModel` in their config without also deleting `index.db`, older
  documents keep their old vectors, `reindexAll` only runs when `INDEX_SCHEMA_VERSION` itself
  bumps, and search silently returns fewer results for old documents from then on, the same way an
  empty result already fails silently elsewhere in this codebase. Nothing surfaces that the corpus
  is now mixed, or suggests `reverie reindex`.
  - Why deferred: not stated. Out of scope for the task that added the `model`/`dims` columns and
    the read-time dims rejection; that task's brief asked only that a mismatch be "detectable" in
    the schema and "rejected... rather than compared" at query time, both of which are done.
  - Where: `packages/memory/src/sqlite.ts` (`MemoryIndex.searchVector`'s dims-rejection comment,
    and `upsertDocument`'s `model`/`dims` columns), `packages/memory/src/engine.ts` (`EngineDeps.embeddingModel`,
    threaded into every `upsertDocument` call). Design source:
    `docs/superpowers/specs/2026-08-27-hostable-engine-design.md`, P0-6.
  - Trigger: not stated. A real person changing their configured embedding model and noticing
    degraded recall would be the natural discovery path; `reverie doctor` (already the place that
    reports the search index schema version, per v0.6.0) is the natural place to add a check like
    `SELECT DISTINCT model FROM embeddings` and warn when it returns more than one row.
  - Size: small (a `doctor` check plus a warning message); larger if it should also compare the
    corpus's recorded model(s) against `EngineDeps.embeddingModel` on every `MemoryEngine.open`/`fromPaths`
    call, which would need to decide what to do about it beyond warning (auto-reindex, refuse to
    start, or leave it to the person).

- **The dream RNG seed is deterministic within one pinned-clock request, so two dreams triggered
  in the same request would draw the identical seed.** P0-3 (`docs/superpowers/specs/2026-08-27-hostable-engine-design.md`)
  moved `maybeDream` and `dreamNow`'s `rngSeed` from a raw `Date.now() >>> 0` read to
  `this.now().getTime() >>> 0`, so the seed now comes from the injected clock rather than the
  ambient one. That was the task: stop the engine from reading the machine's clock, not add a real
  entropy source. Inside a Cloudflare Durable Object, `Date.now()` is pinned for the life of one
  request, which is exactly why the injection was needed for correctness (a repeated real clock
  read would drift, not repeat) and exactly why it now has this side effect: a host that opens the
  engine once per request with `deps.now` fixed to the request's start time, and somehow triggers
  two dream runs inside that one request, draws the same `rngSeed` for both, and therefore the same
  seed-picking and walk order.
  - Why deferred: not stated. The task's own scope note said only that the RNG seed sites "ARE in
    scope" for clock injection, with no mention of entropy uniqueness across calls; folding that in
    would have gone beyond "stop reading the ambient clock" into a different guarantee.
  - Where: `packages/memory/src/engine.ts`, the two `const rngSeed = this.now().getTime() >>> 0`
    lines in `maybeDream` and `dreamNow`. Design source:
    `docs/superpowers/specs/2026-08-27-hostable-engine-design.md`, P0-3.
  - Trigger: Reverie Cloud actually running two dream attempts inside one Durable Object request
    with a pinned clock, once that hosting path exists.
  - Size: small. An optional injected entropy source (or a counter mixed into the seed) alongside
    `EngineDeps.now`, defaulting to today's behavior when not supplied.

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
  yet planned or implemented" as of 2026-08-24). See [docs/commitments.md](docs/commitments.md)
  for how the shipped part of this design works and its own honest account of these gaps:
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
    production caller yet). Found as Critical 2 of that branch's final whole-branch review, whose
    report lived in the gitignored execution workspace and is gone with it, which is why the finding
    is written out here rather than linked.
  - Trigger: a live-session signal that the companion actually raised a commitment in
    conversation (an explicit tool call, or an inferred one from the transcript at reflection
    time), which the writer and the `unknown` transition would both key off.
  - Size: medium (needs a live-session design decision, not only a data-layer change).

- **An untimed commitment has no channel to reach the live companion at all.** Spec Section 3
  says a commitment with "no timing, no bracket" should be "surfaced only when the conversation
  touches the subject, never by the calendar," but that channel does not exist. Verified directly:
  `sqlite.ts` writes no commitment rows (`grep -n commitment packages/memory/src/sqlite.ts` returns
  nothing), `graph_query` needs a `nodeId` the model has no way to discover, commitment nodes carry
  no edges unless `waitsOn` is set, and none of the thirteen live tools enumerates commitments.
  After the Important 8 eligibility fix, an untimed commitment is invisible to the live
  conversation entirely; it is not orphaned, since reflection still sees every commitment,
  uncapped (`packages/memory/src/engine.ts:1867`), so it stays revisable and resolvable at session
  end, but nothing brings it back into a live conversation on its own. Related: a `clearTiming`
  revision (`packages/memory/src/reflection.ts`, Important 6) now makes a commitment permanently
  unsurfaceable to the live model the same way, which is not what "withdraw the stated time" reads
  as to whoever calls it.
  - Why deferred: not stated (this gap surfaced in a 2026-08-25 re-review that corrected an
    unsupported claim in code comments and tests, not from a recorded scoping decision).
  - Where the thinking lives: `docs/superpowers/specs/2026-08-24-commitments-design.md`, Section 3,
    "Not stated at all"; `packages/memory/src/commitments.ts`
    (`isTimeEligible`, `selectCommitments`); `packages/core/src/context.ts` (`commitmentsSection`);
    `packages/memory/src/sqlite.ts` (no commitment indexing); `packages/memory/src/reflection.ts`
    (`clearTiming`, Important 6).
  - Trigger: not stated.
  - Size: not stated (a live-session design decision on what indexes commitments for search or
    tool lookup, similar in shape to the deferred `askedAt` mechanism above).

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
  their own. The same closed-catalogue shape exists one level over: the journal method catalogue
  (`JOURNAL_FORMAT_CONTENT` and `PER_METHOD_SAFETY_NOTES` in `packages/core/src/journaling.ts`) is
  also a fixed `Record<JournalMethod, ...>` with no gate to add or restrict a method, found during
  the Reverie Cloud round-two review: a host might want to add a proprietary journal method, or
  restrict which of the six are offered (a clinical partnership excluding `morning_pages`/`open` in
  favor of clinician-endorsed formats), and cannot today. Also worth recording alongside the mode
  catalogue itself: `set_mode`'s tool description enumerates the live `MODE_NAMES` list to the model
  regardless of what a host might otherwise configure, so overriding only the *text* of the mode
  block (see "A host-configurable prompt and tool-description surface" in section 4) would not by
  itself let a host add an eleventh mode; the tool description would still announce the stock ten.
  - Why deferred: not stated ("Ten fixed modes is the whole catalogue" is the only statement
    given).
  - Where: `docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md`, section 17
    (`Mode` interface).
  - Trigger: not stated.
  - Size: medium.
  - Journal method catalogue, added 2026-08-28: Why deferred: not stated beyond it being one of the
    review's own findings, verdict "seam, for the ability to add or restrict methods... The six
    methods' specific evidence text stays engine-internal by explicit design intent" (quoting the
    review). Where: `packages/core/src/journaling.ts` (`JOURNAL_FORMAT_CONTENT`,
    `PER_METHOD_SAFETY_NOTES`); `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 8
    ("What you have not thought of"), item 4. Trigger: a host asking for its own mode ("If a host
    ever wants its own mode, that is a different piece of work from part B"). Size: medium.

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
  - Also queued, same shape: dreaming v1's own manual testing pass. Nothing about whether a real
    model produces a good dream, a well-grounded insight, or the right tone has had a human look
    at it; every automated test in that branch runs against scripted fake providers. The full list
    (reading real dreams across all three narrative voices, judging the insights, the opener
    mention in a real session, the web Dreams view against real data including a tone-gated dream,
    the Settings round trip for the three dream preferences, `reverie dream --dry-run`/`--show`
    against a lived-in folder, and a feedback verdict read back correctly) is tracked at
    [docs/dreaming.md, section 13](docs/dreaming.md#13-manual-testing-queue), not duplicated here.

- **Eleven deferred pieces of dreaming v1**, chosen non-goals rather than things missed. Full
  reasoning for each lives in `docs/dreaming.md` sections 5, 6, and 10:
  - *Graph writes of any kind.* Dreaming writes prose and a jsonl dream log in v1, never a graph
    edge or node. Section 10 sketches five options for later: unconfirmed `relates_to` edges
    (`source: 'dream'`, `confirmed: false`), a `theme` node type for cross-cutting patterns, a
    `dream` node type with `involves` edges to what it touched, a retract-on-feedback record when
    a verdict is "wrong," and confidence-by-use (flagged in the source itself as speculative, with
    "a real risk of confirming by silence"). Why deferred: not stated beyond being scoped out of
    v1. Trigger: not stated. Size: not stated. Where: `docs/dreaming.md`, section 10.
  - *Relevance-ranked prompt injection.* The dream section of the system prompt orders by
    recency; ranking by similarity to the live conversation was always the intended refinement
    (idea 19), not built in v1. Why deferred: not stated. Trigger: not stated. Size: not stated.
    Where: `docs/dreaming.md`, section 5.
  - *Transcript-level attribution tagging.* The third feedback-attribution option considered
    (idea catalog section 9a): assistant turns carrying hidden metadata naming which insight ids
    were in context, so the web UI could mark a turn as dream-informed. Why deferred: "Deferred in
    favor of the simpler per-artifact feedback" that shipped. Trigger: not stated. Size: not
    stated. Where: `docs/dreaming.md`, section 9a.
  - *Insight decay.* Old, never-confirmed insights do not yet lose prompt priority over time
    (idea 37); everything with equal recency competes equally for the capped prompt section. Why
    deferred: not stated. Trigger: not stated. Size: not stated. Where: `docs/dreaming.md`,
    section 5.
  - *Cross-dream consolidation.* A periodic pass reading only past dream insights and writing a
    higher-level digest (idea 38). Why deferred: "recorded as open but cautious: this is the exact
    shape of the confabulation-drift risk the prior-art review flagged, so if it is ever built, the
    digest must cite original evidence pointers, not dream ids." Trigger: not stated. Size: not
    stated. Where: `docs/dreaming.md`, section 5.
  - *Dream series.* A multi-night thread following one long arc across several dreams (idea 33).
    Why deferred: not stated. Trigger: not stated. Size: not stated. Where: `docs/dreaming.md`,
    section 5.
  - *User-seeded and in-conversation-requested dreams.* A CLI flag or tool to ask for a dream
    about something specific (idea 34, "flagged as cheap to build"), and honoring a request made
    mid-conversation on the next dream (idea 35). Why deferred: not stated. Trigger: not stated.
    Size: not stated, except idea 34 noted as cheap. Where: `docs/dreaming.md`, section 5.
  - *Feedback-driven selection tuning.* Right/wrong/do-not-bring-up feedback shipped and
    permanently excludes an insight from the prompt and opener once recorded, but it does not yet
    adjust selection weights going forward. Why deferred: not stated; the source notes idea 18
    "calls for keeping an exploration term so tuning selection by feedback does not collapse into
    flattery," a design constraint on the eventual build, not a reason for the delay. Trigger: not
    stated. Size: not stated. Where: `docs/dreaming.md`, section 5.
  - *Dream-informed mode behavior and reading-aloud/ambient surfacing.* Two further open ideas
    from the same catalog: mode behavior drawing on dream insights (idea 20, for example a
    `boost` mode drawing on the strengths ledger), and a dream shown on the web landing page like
    a morning note (idea 36). Why deferred: not stated. Trigger: not stated. Size: not stated.
    Where: `docs/dreaming.md`, section 5.
  - *Two alternate architectures considered and not built.* Approach 2, a tool-using agent
    session replacing the bounded dig-deeper loop, named as the upgrade path "if the loop that
    shipped proves too shallow" (not currently planned). Approach 3, continuous micro-dreaming
    folded into reflection instead of run on a schedule, rejected for v1 but could return "as a
    small supplement to idea 5 (dormant-arc revisits) if the scheduled path proves too infrequent
    on a machine that is rarely on." Why deferred: quoted above, per approach. Trigger: quoted
    above, per approach. Size: not stated. Where: `docs/dreaming.md`, section 6.

- **Idea 39, commitment-aware dreams, is still blocked.** Once a `commitment` graph node type
  exists, a dream could notice a quiet-but-alive commitment thread, a stated event whose time has
  passed, or a seasonal gloss whose season has arrived, and surface it as a gentle open-question
  insight, bound by the commitments design's anti-taskmaster guarantees: no open-question insight
  about a commitment whose single ask is already spent or that is marked quiet, and interpreted
  time brackets never rendered in dream prose. The `commitment` node type and the commitments
  engine have since landed (see the commitments entries above in this section), so the node-type
  precondition is met, but the mechanism idea 39's own guarantee depends on is not: the "real
  `askedAt`/one-ask mechanism" entry above in this section records that nothing writes `askedAt`,
  no commitment ever reaches the `unknown` state in production, and an interim grace period stands
  in for it. Idea 39 stays blocked on that entry, not on the commitments design landing.
  - Why deferred: not stated beyond being blocked on the commitments design, per
    `docs/dreaming.md` section 11.
  - Where: `docs/dreaming.md`, section 11; the "real `askedAt`/one-ask mechanism" entry above in
    this section.
  - Trigger: the `askedAt`/one-ask mechanism above landing in production.
  - Size: not stated.

## 4. Larger pieces not built

Each of these is sized like its own sub-project. Open an issue before starting one; they need
design conversation first.

- **A host-configurable prompt and tool-description surface**, proposed by Reverie Cloud's
  round-two request as a general override API over `buildPersona` and `assembleSystemPrompt`'s
  composed system prompt, plus `toolDefinitions()` and `DREAM_TOOLS`. The request's own framing of
  the objective: "make the prompt a structured, host-configurable surface, so that varying it is a
  supported operation rather than a fork." Part D of the same round already shipped three named
  fields (`deploymentContext`, `firstConversation`, `firstConversationDeploymentClause`, the last
  added in the follow-up round that split the deployment claim into a second-person identity-block
  register and a third-person, clause-length welcome register, because neither register read
  correctly in the other's position) and established `PersonaOptions`, threaded from
  `AgentSessionOptions` through `assembleSystemPrompt` into both `buildPersona` and
  `firstConversationSection`, as the type to grow. The full review and our positions on each part
  below are in `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`:
  - *The general named prompt-block override API (part B1).* Turn the rest of `buildPersona`'s and
    `assembleSystemPrompt`'s authored blocks into named blocks a host can replace or insert after,
    via an optional dependency, with byte-identical default output when the dependency is absent.
    Our own correction to the request's proposed boundary: "You defined the seam over `buildPersona`.
    It has to be defined over the composed system prompt, because that is the unit that reaches the
    model and `buildPersona` is only part of it... the union of block names belongs in one place that
    spans both files... Grow that type. Do not grow a second one inside `personas.ts`." Reverie
    Cloud's round-three reply restated the acceptance criterion for this extraction plainly, and
    asked to be held to it: "Byte identity remains the acceptance criterion for the extraction.
    Blocks named and threaded, no overrides supplied, output identical. Hold us to that." The one
    named exception is `PRECEDENCE_SENTENCE` (see the B2 entry below), already spent. Why deferred:
    not built this round, scoped as its own design and implementation pass. Where:
    `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 3 ("Part B, our positions"),
    "B1, the shape"; `packages/core/src/personas.ts` (`PersonaOptions`, `buildPersona`);
    `packages/core/src/context.ts` (`assembleSystemPrompt`, `firstConversationSection`);
    `reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, section 3. Trigger: not
    stated. Size: medium.
  - *The protected block set (part B2), including a fourth member.* `crisis-outranks-tone`,
    `precedence`, and `crisis-stance` extracted into blocks always composed by the engine, crisis
    last, so a host replacing style or mode cannot silently delete the sentences that stop those
    blocks reading as permission to override the crisis stance. We agreed the request's reasoning
    was right and added a fourth protected member it had not asked about: the empty-memory guardrail
    inside `firstConversationSection` ("The memory is empty right now...do not tell them you can
    continue where an earlier conversation left off"), on the same grounds, since
    `PRECEDENCE_SENTENCE` names "any guidance about this being a first conversation" as a rung in its
    own ordering (reworded from "the first-conversation guidance" by `84891b7`, described next). Part
    D already protects this fourth member for the three fields it shipped; what remains
    is extracting `CRISIS_OUTRANKS_TONE` and `PRECEDENCE_SENTENCE` into blocks of their own.
    `PRECEDENCE_SENTENCE`'s own wording has already shipped as a carve-out ahead of that extraction:
    reworded from ranking by structure to ranking by role, crisis stance first, under Vishal's
    advance sign-off, because the byte-identity acceptance criterion below "was never meant to freeze
    the wording of a sentence forever," per Reverie Cloud's round-three reply, and "applied to
    `PRECEDENCE_SENTENCE` it stops being a safety discipline and becomes the thing preventing a
    defect from being fixed." Round three's acceptance criterion for the coming block extraction:
    "Byte identity remains the acceptance criterion for the extraction. Blocks named and threaded, no
    overrides supplied, output identical. Hold us to that." "One carve-out, named in advance:
    `PRECEDENCE_SENTENCE`." Now spent. Why deferred: scoped to part B1 landing first. Where:
    `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 3, "B2, the protected set";
    `packages/core/src/personas.ts:214` (`CRISIS_OUTRANKS_TONE`), `:234` (`PRECEDENCE_SENTENCE`);
    `reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, section 3. Trigger: not stated.
    Size: small to medium.
  - *Mode override must not suppress style axes (part B2b).* `styleSection`
    (`packages/core/src/personas.ts:220`) computes which style axes to suppress from
    `modeOverrides(activeMode)`, which reads the stock mode catalogue. A host that replaces only the
    mode block leaves the stock suppression in force with no replacement clause to fill the gap, so
    an axis gets no instruction at all, not the host's and not ours. The fix is fail closed: a
    host-replaced mode block suppresses nothing, so the stock style paragraphs all render. "This is
    the same correction our own AGENTS.md records from 2026-08-25, where an unhandled case defaulting
    to admitted hid two real bugs." Why deferred: found during the round-two review, gated on part B1
    shipping. Where: `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 3, "B2b, a
    hole you did not ask about"; `packages/core/src/personas.ts:220` (`styleSection`);
    `packages/core/src/modes.ts:149` (`modeOverrides`). Trigger: shipping part B1. Size: small.
  - *Prompt identity (part B5).* No prompt version, hash, or identifier exists anywhere today. Hash
    the authored surface (the ordered list of `(blockName, blockContent)` pairs for the authored
    blocks, plus the resolved safety mode and active mode), not the composed prompt, which embeds the
    person's memory and changes every turn. Return the value alongside the text rather than embedding
    it in the prompt, since a version string inside the prompt is a moving byte in the cached prefix.
    Why deferred: not built this round. Where: `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`,
    section 3, "B5, prompt identity". Trigger: not stated. Size: small.
  - *A budget position for host-supplied blocks (part B5), and a budget config surface.* Two things.
    First, `budget.ts` should state plainly that `PROMPT_BUDGET_TOTAL` does not cover the persona
    (host blocks included), since the reasoning for excluding it ("authored, fixed in size, and
    cannot grow with use") stays true for host blocks but the enforcement (a test over our own
    constants) cannot see theirs; a composition-time length check that throws on an oversized host
    block should stand in for that enforcement. Second and separate: every cap in `budget.ts` is a
    module constant with no config surface at all, which a multi-tier hosted product will need to
    differ per tier and today cannot express. Why deferred: not built this round; the config surface
    specifically, "not building it in this round." Where: `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`,
    section 3, "B5, budget"; `packages/core/src/budget.ts:17` (the persona-exclusion comment), `:71`
    (`PROMPT_BUDGET_TOTAL`). Trigger: not stated. Size: small for the stated position and length
    check; small for the config surface (scope grows with however many tiers a host wants).
  - *Nothing enforces the length of a host-supplied block (a gap the deployment-clause split makes
    concrete, not fixes).* Splitting `deploymentContext` into a second-person, paragraph-length field
    and a third-person, clause-length `firstConversationDeploymentClause` fixes the register problem
    for the two strings Reverie Cloud actually plans to use, but nothing stops a host putting a
    paragraph in the clause field. Round three showed what that costs, against the single field the
    split replaced: the welcome instruction says "two or three sentences" and Reverie Cloud's own
    honest hosted privacy statement is three sentences and 291 characters against a 57-character
    default, so "The instruction contradicts itself before the model reads a word of it." The split
    resolves that particular contradiction, because the paragraph now sits in the identity block,
    which carries no sentence count. It does not stop the next host reproducing it by putting a
    paragraph where a clause belongs. Why deferred: the composition-time length check that would catch this is already scoped as
    part of B5 above (a check that throws on an oversized host block) and belongs with it rather than
    bolted onto one field in isolation. Where: `packages/core/src/personas.ts`
    (`resolveFirstConversationDeploymentClause`); `packages/core/src/context.ts`
    (`firstConversationOpeningClause`); the B5 budget entry above in this section;
    `reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, section 5. Trigger: part B5's
    composition-time length check landing. Size: small.
  - *Tool description overrides (part C), across both tool surfaces.* `toolDefinitions()` in
    `packages/core/src/tools.ts:199` (14 tools, 9,727 characters of top-level description) and the
    separate `DREAM_TOOLS` in `packages/memory/src/dreaming.ts:22` (four overlapping tool names with
    much terser prose, unreachable from a core-keyed seam because `memory` cannot import `core`) both
    need a named, per-tool override, defaulting to today's text. `set_mode` needs to be special-cased
    so a full replace cannot freeze its live mode enumeration (see the standing defect in section 1
    above). The request's stated need: "Reverie Cloud is moving to more than one provider, explicitly
    to reduce cost, with DeepSeek and similar named. Tool-calling reliability and the phrasing that
    achieves it vary materially between model families... A host that cannot tune it is a host that
    cannot use a cheaper model that would otherwise be fine." We agreed to build it, and corrected the
    request's own worry about test cost: neither of the two tests it named as at-risk
    (`docKinds.test.ts`, `tool-labels.test.ts`) actually guards the top-level description field an
    override would replace. Reverie Cloud's round-three reply accepted that correction without
    contest: "`docKinds.test.ts` guards a nested parameter description and `tool-labels.test.ts`
    guards names, so neither is affected. We named the wrong risk and you named the right one." They
    also confirmed the chat-only seam (core's `toolDefinitions()`, leaving `DREAM_TOOLS` uncovered)
    is worth having on its own, but asked us not to build it that way: it "has standalone value and
    we would take it," but "we would rather you did not build it until both surfaces can be covered,
    because a seam that silently misses the workload we said we wanted it for is the kind of
    half-fix that stops the problem being visible." And they accepted our three scoping calls without
    change: replaceable for thirteen tools, `set_mode` special-cased to always render its live
    enumeration, and nested parameter descriptions out of scope for version one. Why deferred: not
    built this round; their own words on sequencing: "Put it after the defects and after part B... and
    bring the `DREAM_TOOLS` duplication into scope when you do." Where:
    `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 4 ("Part C, tool
    descriptions"); `packages/core/src/tools.ts:199`; `packages/memory/src/dreaming.ts:22`;
    `reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, section 8. Trigger: not stated.
    Size: medium.

- **Internationalisation is its own design round, and a prompt-block override seam must not be sold
  as one.** English is welded into places no block override would reach: `capBody`'s truncation
  marker formats numbers with `toLocaleString('en-US')` (`packages/core/src/budget.ts:119`);
  `localParts`, the shared formatter behind every rendered transcript stamp, hardcodes `'en-US'`
  (`packages/memory/src/time.ts:19`, `:74`, `:97`), so English weekday abbreviations reach every
  transcript line of every reflection prompt; singular and plural render through hardcoded ternaries
  (`packages/core/src/context.ts:297`, "day" vs "days"); booleans render as the English words
  "yes"/"no" and "has a page"/"no page yet" (`context.ts:331`, `:387`); and `PROSE_VOICE_RULE`
  (`packages/memory/src/voice.ts:15`) is an English orthography rule (no em dash, a named list of
  English filler words) spliced unconditionally into every reflection, narrative, and dream prompt,
  written into the person's permanent record. `ProfileMeta` has no locale or language field to even
  express a preference. Our own words: "If you need another language, that is its own design round
  and a large one. Do not let part B make it look adjacent."
  - Why deferred: not built this round; flagged as a distinct, larger piece of work the prompt-block
    API above must not be mistaken for.
  - Where: `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`, section 8 ("What you have not
    thought of"), item 2; `packages/core/src/budget.ts:119`; `packages/memory/src/time.ts:19,74,97`;
    `packages/core/src/context.ts:297,331,387`; `packages/memory/src/voice.ts:15`.
  - Trigger: not stated.
  - Size: large.

- **More provider adapters.** The interfaces are in `@openreverie/providers` (`ChatProvider`,
  `EmbeddingProvider`) and the factory has one switch statement waiting for company: Anthropic,
  OpenRouter, Cloudflare AI Gateway, DeepSeek, and local models (Ollama and OpenAI-compatible
  endpoints). Every adapter must pass the same contract tests. This is the most
  contributor-friendly large item.
  - Why deferred: "This spec deliberately covers only the first sub-project."
  - Where: `docs/superpowers/specs/2026-08-13-openreverie-design.md`, sections 2 and 12.
  - Trigger: not stated.
  - Size: large (per-adapter work is contained; the interface and contract tests already exist).

- **Token usage metering, plan quotas, and a usage ledger.** P0-4
  (`docs/superpowers/specs/2026-08-27-hostable-engine-design.md`) gave `ChatResult` an optional
  `usage` field, `ChatEvent` a `usage` variant, and `EmbeddingProvider.embed` an `EmbedResult`
  carrying `usage` alongside the vectors, so a token count now exists at the one place every
  model call in this system passes through. Nothing in openreverie itself reads that number for
  billing or limits: `AgentSession`'s two streaming loops (`packages/core/src/agent.ts`)
  explicitly discard a `usage` `ChatEvent`, with a comment saying why, rather than acting on it or
  forwarding it as an `AgentEvent`.
  - Why deferred: "We are not building metering. Reverie Cloud wraps the provider in its own
    `ChatProvider` that checks a usage ledger before delegating. The engine stays unaware, which
    is the point of the choke point." This is a different codebase's feature, not a piece of
    openreverie left unfinished: Reverie Cloud is a separate repository, and its own
    `ChatProvider`/`EmbeddingProvider` decorators are meant to observe the `usage` this task
    exposes and act on it, without openreverie's engine ever needing to know a ledger exists.
  - Where: `docs/superpowers/specs/2026-08-27-hostable-engine-design.md`, P0-4;
    `packages/providers/src/types.ts` (`Usage`, `ChatResult.usage`, the `ChatEvent` `usage`
    variant, `EmbedResult`); `packages/providers/src/openai.ts` (`toUsage`, `stream_options:
    { include_usage: true }`, per-batch embedding usage summed in `OpenAiEmbeddingProvider.embed`);
    `packages/core/src/agent.ts` (the explicit no-op `usage` branches in `runGreeting` and
    `runTurn`).
  - Trigger: not stated. The Reverie Cloud repository actually being built out against this
    interface is the natural discovery path, since that is the codebase this item belongs to.
  - Size: large, and out of this repository's scope entirely: it belongs to Reverie Cloud, not to
    openreverie.

- **P1-1's shared HTTP core has no node builtin imports of its own, but one thing it calls still
  does.** P1-1 (`docs/superpowers/specs/2026-08-27-hostable-engine-design.md`) made
  `packages/server/src/http-core.ts` transport-agnostic: `createFetchApp` and everything it calls
  inside that file import nothing from `node:*`. One dependency was out of scope for that task and
  was left as it was: `./api.js`'s `encodeCursor`, `decodeCursor`, and `makeGraphSnapshot` import
  `node:buffer` and `node:crypto` directly. A Workers, Bun, or Deno host running `createFetchApp`
  still needs those two node builtins at runtime, uncompensated by anything this module supplies.
  (`dreamFeedbackVerdicts`'s matching gap, constructing `memoryPaths(config.memoryDir,
  nodeStores())` itself instead of reading through whatever store the host actually gave its
  engine, was closed on 2026-08-27. An injected `MemoryPaths` dep on `HandleDeps`/`FetchAppDeps`
  was tried first and rejected on review: it reproduced the same silent-drop failure for a host
  that forgot to pass it, and let a host pass a `MemoryPaths` built over different stores than its
  own engine, so the two could read from different places with nothing to catch it. The fix that
  landed instead reads through `RecordEngine.memoryPaths`, a required member backed by a new
  `MemoryEngine.memoryPaths` getter: the HTTP layer never holds a separately constructed
  `MemoryPaths` at all, so every host gets verdicts and no host can wire them inconsistently.)
  - Why deferred: `packages/server/src/api.ts` was outside this task's file ownership (assigned to
    neither of the two tasks running concurrently against this package), and Cloudflare Workers'
    `nodejs_compat` flag already covers `node:buffer`/`node:crypto` (`Buffer`, `createHash`) at no
    cost to Reverie Cloud, so widening this task's scope to eliminate them was not worth it.
  - Where the thinking already lives: `docs/superpowers/specs/2026-08-27-hostable-engine-design.md`,
    P1-1; the comment above `HashProvider` in `packages/server/src/http-core.ts`;
    `packages/server/src/api.ts`.
  - Trigger: not stated. A concrete one would be Reverie Cloud, or a self-hosted Bun or Deno run,
    actually needing `encodeCursor`/`decodeCursor`/`makeGraphSnapshot` to run somewhere
    `node:buffer` or `node:crypto` are unavailable and uncompensated by a compatibility layer.
  - Size: small (its two base64url/hex helpers can reuse the pattern `http-core.ts`'s own
    `HashProvider` already established).

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

- **Migrate the SQLite index off `better-sqlite3` to Node's built-in `node:sqlite`.** Would
  remove the only native dependency in the published `openreverie` npm package, so a global
  install no longer needs a prebuilt binary or a C++ toolchain for anyone. Verified on
  2026-08-25 against Node 22.22.0 while building the npm packaging: `node:sqlite` is already
  present, `DatabaseSync` is a function, but importing it prints `ExperimentalWarning: SQLite is
  an experimental feature and might change at any time`.
  - Why deferred: not stated as an explicit decision anywhere; the concrete blocker found while
    verifying is that `node:sqlite` is still marked experimental by Node itself, which is reason
    enough not to make it the load-bearing storage engine for a published CLI's only mandatory
    native dependency today.
  - Where: `docs/superpowers/handoffs/2026-08-25-npm-packaging.md`; the current native-dependency
    constraint is in `packages/memory/src/sqlite.ts` and the `better-sqlite3` entry in
    `packages/memory/package.json`; the rule that makes a future swap safe, that SQLite is a
    derived index and must always be rebuildable from the memory folder, is in `AGENTS.md` under
    "Architecture rules".
  - Second reason, observed on 2026-08-25 during the first real `npm i -g openreverie`: the install
    prints `npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the
    author of the relevant native addon; alternatives are available.` That package is what fetches
    `better-sqlite3`'s prebuilt binary, and it is the only thing standing between a user and a C++
    toolchain requirement: with it, the install took two seconds; without a working prebuild path,
    it compiles from source. It works today and nothing is broken, but the mechanism the published
    package depends on for a painless install is now formally unmaintained, and a user seeing a
    deprecation warning on first install is a poor first impression regardless.
  - Trigger: either `node:sqlite` losing its experimental flag, or `prebuild-install` breaking in a
    way that makes installs start compiling. The second could arrive without warning and would be
    felt by every new user at once.
  - Size: medium (swap the binding used in `packages/memory/src/sqlite.ts` and confirm
    `node:sqlite`'s query surface actually covers everything the indexer needs; no data
    migration is required, since the memory folder and `graph.jsonl` are the only truth and the
    index is disposable).

### Post-v0.8 hosted-client requests

- **Requests from a hosted deployment building on this engine.** These arrived as a run of
  separate asks and were then consolidated into one document, the 2026-08-29 release benchmark,
  which the requester committed to as their last engine request before their first release.
  - Where the thinking already lives: the 2026-08-28 release request, then
    `reverie-cloud/docs/specs/2026-08-28-openreverie-request-round-two.md` parts E and F, then
    rounds three through eight, then
    `reverie-cloud/docs/specs/2026-08-29-openreverie-release-benchmark.md`, which supersedes every
    open item in the earlier rounds. Our positions and reasoning are in the reply documents under
    `docs/specs/`.
  - **Four of the six original asks have now shipped** and have been removed from this list rather
    than left here marked done: greeting suppression on session create (E2), host-owned session
    lifetime (E3), the search endpoint (E5), and optional provider headers on `OpenAiConfig`
    (part F). They are recorded in `ROADMAP.md`'s Done narrative. What remains below is E1, which
    is designed but not built, E4, which stays withdrawn, and the items the release benchmark
    added.
  - Rough size: see each entry.

  - *Journaling cadence, structured storage, and settability (E4), withdrawn as originally scoped.*
    Cadence needs to be settable conversationally and in settings, both writing the same structured
    record. The conversational half already exists via the live `update_journaling_protocol` tool;
    what is missing is a screen-readable structured record. That was blocked on the
    `writeJournalingProtocol` meta clobber defect: "Adding a cadence tool on top of that would
    produce a setting that silently forgets itself. Fix the meta clobber first, then the structured
    field, then decide whether a second tool is needed at all. We suspect it is not." **The meta
    clobber fix has now landed**, in `82d367a`: `writeJournalingProtocol` reads, merges, and writes
    `meta` instead of rebuilding it from scratch, on the same read-merge-write shape
    `setSessionMode` already used, so a structured field written by another caller now survives the
    next prose rewrite. Stated fallback: "cadence is a host-side setting the companion cannot
    change, which contradicts what was asked for but does not block the notification." Reverie
    Cloud's round-three reply withdrew this ask as scoped, agreeing the layer was wrong: "You are
    right and we aimed at the wrong layer... A tool writing a setting that the next unrelated write
    silently erases is worse than no tool." That withdrawal stands; this entry does not un-withdraw
    the ask itself. They said they would re-raise a narrower successor once the meta clobber was
    fixed: "What we actually need is a screen-readable structured record, because the hosted
    schedule work has to recompute a Durable Object alarm when cadence changes and cannot do that by
    parsing prose. We will re-raise that against the fixed layer rather than restating the original
    ask." Where: `packages/memory/src/journal.ts` (`writeJournalingProtocol`);
    `packages/core/src/tools.ts` (`update_journaling_protocol`); the meta clobber fix, `82d367a`;
    `reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, section 6.2. Trigger: was the
    meta-clobber fix landing first, then a re-raised, narrower ask against the fixed layer. The fix
    has now landed in `82d367a`; what remains is Reverie Cloud re-raising the narrower ask against
    the fixed layer, which has not happened yet. Size: medium.
  - *Batch model calls for reflection and dreaming (R7), recorded by request, no code asked for.*
    Reflection and dreaming move to provider batch APIs, which price asynchronous completions
    below synchronous ones. This entry exists because the requester asked for the consideration to
    be recorded so the shape is not foreclosed by something built between now and then, and asked
    that R4 be designed with it in mind. It was: `reflection.state` carries a real, durable
    `'in_progress'`, which is the state a batched reflection would sit in for a long time.
    Why deferred: their words, "That is engine work, it is large, and it is not for this release."
    The obstacle, in their words, so nobody under-sizes it later: "This is not a provider swap.
    Reflection is a sequential pipeline inside one awaited function (`_doEndSession` calls
    `reflectSession`, then `resolveNarratives`, then `materializeNew`, then `applyReflection`), and
    a dream pass is four staged calls. A Durable Object cannot hold a promise across hibernation,
    and a batch result can outlast any alarm invocation. Making this work means reflection and
    dreaming become resumable jobs with durable state between stages." The pricing figure that
    motivates it is "roughly fifty percent, which is Vishal's reading of provider documentation and
    is **not verified in either repository**. Nobody should size this work without checking it
    first." Treat that number as unverified, because it is. Where:
    `reverie-cloud/docs/specs/2026-08-29-openreverie-release-benchmark.md`, R7; the durable record
    it is cross-referenced from is `packages/memory/src/reflectionLog.ts`. Trigger: their words,
    "When it is time to build it, we bring the design rather than the ask." Size: large.
  - *Session listing reads every stored transcript in full (R9).* `SessionStore.describe`
    (`packages/memory/src/transcripts.ts`) reads every stored session's transcript in full to
    compute `updatedAt` and four per-role counts, and the sessions route paginates afterwards. Four
    routes pay it. Measured by the requester inside a real Workers runtime with the page size fixed
    at 20 throughout: "3.0ms at 200 log rows, 7.0ms at 2,500, 44.0ms at 10,000, 67.0ms at 40,000.
    Fetching ONE session's transcript at the largest size costs 71.0ms, marginally more than
    listing everything, because it reads every transcript first and then reads the requested one
    again. Two hundred sessions is roughly seven months of daily use." Their harness is
    `bench/sessionListing.bench.test.ts` in their repository.
    Why deferred: theirs to raise and ours to schedule, on their own framing, "It does not block our
    release and we are not prescribing a design." Deferred so the release benchmark's own items land
    first.
    **It is not a contract question, contrary to how it was raised.** They wrote that "the awkward
    part is the per-role counts on `PublicSession`, which is a contract question rather than a
    storage one." Checked against the code, it is not: sorting and pagination use only `createdAt`
    and `sessionId` (`compareSessions` in `packages/server/src/http-core.ts`, and the
    `revisionValue`/`tuple` pair on the sessions route), neither of which needs a transcript read,
    so the counts are only needed for the sessions actually returned on a page. The counts can stay
    on `PublicSession` untouched. The single-transcript case is worse than a cost problem: the
    transcript route calls `listStoredSessions().find()` purely to decide 404-or-not and then reads
    the transcript again, so it needs no counts at all. Of the five callers of
    `listStoredSessions`, four need no counts or need them for a single session. The cheap
    primitive already existed inside `packages/memory` (`SessionStore.listSessions` returns id,
    date, `reflected` and `skipped` with no full transcript read) and **is now exposed on the
    engine** as `listStoredSessionStates()`, added for a consumer's reconciliation pass. So what
    remains of this item is rewiring the routes that do not need counts onto it, not building
    anything new. One thing that primitive deliberately cannot answer: `updatedAt`, because a
    session's last transcript line is exactly the expensive read. A caller that needs it for a
    specific session should pay that cost per session rather than for the whole list; making it
    cheap in bulk would need a tail read on `AppendOnlyStore`, which is a change to one of the two
    injected interfaces this package reaches its filesystem through and wants a real case first. Where: `packages/memory/src/transcripts.ts` (`describe`);
    `packages/memory/src/engine.ts` (`listStoredSessions`); `packages/server/src/http-core.ts` (the
    sessions, single session and transcript routes); `packages/server/src/registry.ts:199` and its
    `findStoredSession`. Trigger: not stated by them. Ours: whichever comes first of a real
    complaint about listing latency, or the next piece of work that would put another caller of the
    full scan on a hot path. Size: small to medium, no contract change.


  - *Resume has no HTTP route and the bundled server never resumes by itself.* `AgentSession.resume`
    and `LiveSessionRegistry.resume` exist and are covered by the suite, but nothing in `/api/v1`
    reaches them and `requireLive` does not auto-resume, so a self-hosted browser user cannot
    continue an interrupted conversation even though the engine now can.
    - Why deferred: the requester drives resume from their own durable record of which session is
      live, so they asked for the registry entry point and nothing more. A window guess in front of
      every write would be worse than an explicit call, and the engine has no durable liveness of
      its own to guess from. Both were considered and declined in the design rather than overlooked.
    - Where: `docs/specs/2026-08-29-session-resume-design.md` section 3;
      `packages/server/src/registry.ts` (`resume`, `requireLive`);
      `packages/server/src/http-core.ts` (no route).
    - Trigger: wanting a self-hosted person to continue a conversation their server restarted out
      from under them. That needs a durable liveness record on this side, which is the real work,
      not the route.
    - Rough size: medium, most of it the durable liveness record rather than the plumbing.
  - *A narrow resume window survives when `maxLiveSessions` is set above the tombstone cap.*
    `resume` refuses a session this process has ended or expired by consulting the tombstones, which
    is authoritative sooner than the durable attempt record, since that record now lands
    asynchronously. The tombstone cache is capped at 64 and evicts oldest first. `sweep()` is fully
    synchronous and tombstones every expired session in one pass, so a host configuring
    `maxLiveSessions` above 64 can evict a tombstone in that same pass, before that session's own
    detached `agent.end()` has reached its first await. Such a session falls through to the durable
    check while its record has not landed, and could be resumed while being reflected. It cannot
    happen at the default of 8.
    - Why deferred: found while closing the main race, and unreachable at the shipped default. The
      original reasoning offered for why it could not happen at all was wrong and was replaced with
      this counterexample rather than left standing.
    - Where: `packages/server/src/registry.ts` (`doResume`'s tombstone check, `addTombstone`'s
      `ENDED_TOMBSTONE_CAP`, `sweep`).
    - Trigger: raising `maxLiveSessions` above 64, or any host that ends many sessions at once.
    - Rough size: small (bound the tombstone cache to the live-session limit, or record the ended
      state durably before tombstoning).
  - *`GET /api/v1/search` has no browser UI.* The route ships and the web client cannot call it, so
    a person still cannot search their own memory from the interface they actually use, which was
    the stated reason the endpoint was worth building.
    - Why deferred: the request asked for the endpoint and scoped the web work out. Building a
      search surface is a design question about where results belong among the existing sections,
      not a wiring job.
    - Where: `packages/server/src/http-core.ts` (the route); `packages/web`.
    - Trigger: not stated.
    - Rough size: medium.

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
    `out.commitmentRevisions`. Raised by the implementing task's own report, which lived in the
    gitignored execution workspace and is gone with it.
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
  commitments engine work) passed a single-element array, so `.slice(0, cap)` and the soonest-
  window-first comparator went uncovered. Deleting the entire `.sort(...)` call left the suite
  green. As of the 2026-08-25 review's Important 8 fix, the comparator's three undefined-handling
  branches are also now defensive rather than reachable through production data (`isTimeEligible`
  already requires a computable window to pass the filter above the sort), which a test covering
  the comparator's ordering, not those branches specifically, should still confirm.
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

- **Dreaming v1: four test-coverage gaps, not code-correctness bugs, from the implementation's
  execution ledger.** The ledger (`.superpowers/sdd/2026-08-24-dreaming-implementation/progress.md`,
  gitignored and deleted once the branch merges, which is why the detail is captured here rather
  than left to disappear with it) flagged fifteen items as minor across the fourteen implementation
  tasks; a final whole-branch review, scoped to the seams between already-reviewed tasks, triaged
  all fifteen and cleared every one to ship (two of the fifteen describe the same finding, the
  `dreams.css` lint warnings below, flagged once mid-review and once at task close, so fourteen
  distinct items remain). This entry covers the four that are test-coverage gaps:
  - `foldDreamLog`'s newest-wins guard for a `dreamt` record is under-tested: the fixture happens
    to have array order match timestamp order for the one entity with two records, so deleting the
    guard still passes; only inverting the comparison catches it. The guard itself is correct.
  - The dream pipeline's every-insight-fails abort test passes because the fake provider's script
    runs out at the narrative call, not via a clean assertion on the abort path itself; the outcome
    assertion is real, just weaker than it looks.
  - Only one direction of the opener/prompt-section switch-independence property has an automated
    test (opener firing while the prompt section is off); the converse was checked manually against
    a built distribution, no committed test.
  - The artifact-tracking rule (`dream.md`, `insight.md`, `process.jsonl`, and `log.jsonl` stay
    tracked while only the lock file is gitignored) was verified manually via `git ls-files`, not
    as an automated regression test.
  - Why deferred: the whole-branch review triaged all fourteen ledger-flagged minors and cleared
    every one to ship; none blocked the merge.
  - Where: `packages/memory/src/dreaming.test.ts` and related dream pipeline test files; the
    execution ledger cited above.
  - Trigger: not stated for any of the four.
  - Size: small each (a fixture or script change per item, not a design question).

- **Dreaming v1: six known, accepted behavior gaps from the same execution ledger, plus two
  wording-only corrections to a completion report with no code action.** None of these are
  defects; each was named and accepted deliberately during implementation or the final review.
  - A write failure partway through producing a dream (for example `insight.md` throwing after
    `dream.md` has already landed) can leave a partial dream directory: a narrative with no
    insights, no process log, and no log record. Nothing is corrupted or deleted, and every reader
    of a dream directory (CLI, server endpoints, web view) was told to tolerate an incomplete one
    rather than assume both files exist.
  - `candidateWeight`'s staleness term is a hard linear cap (days since last dreamt, capped at
    365, divided by 365) rather than the smoother "soft cap" the spec's own wording suggests. The
    spec treats exact constants as implementation detail tested by invariant, and the invariants
    hold, so this is a wording mismatch, not a behavior gap.
  - `POST /api/v1/dreams/:id/feedback` validates but discards the `:id` path segment, because
    feedback recording resolves an insight by its own id across all dreams, not by dream id. This
    matches the engine signature the task brief specified and was named as a known limitation by
    both the implementer and the reviewer.
  - A type-only import cycle exists between `engineDreams.ts` and `engine.ts` (one imports types
    from the other, which imports values back). It erases at build and violates no package
    boundary; moving the two shared interfaces to a leaf module would make the split acyclic.
  - The CLI-level `!force &&` guard in the "dreaming is off" message check is dead code: the
    engine never returns that reason when `force` is true, so the guard can never trigger.
    Harmless.
  - `dreams.css` carries four pre-existing cosmetic lint warnings (`noDescendingSpecificity`),
    left as the original ordering; lint still exits clean since these are warnings, not errors.
  - Wording only, no code action: a task's own completion report described a config
    field-by-field assembly as strictly required, when a narrower interface-level change would
    also have compiled (the approach that shipped mirrors an existing pattern in the same
    function, so it stayed). A second task's completion report called three new lint warnings
    "pre-existing"; they were new to the repository in that diff, but dictated verbatim by the
    task brief.
  - Why deferred: same whole-branch-review triage as above; all cleared to ship, none of these
    is a defect in what shipped.
  - Where: `packages/memory/src/dreaming.ts`, `packages/memory/src/engineDreams.ts`,
    `packages/memory/src/engine.ts`, `packages/server/src/app.ts`, `packages/cli/src/dream.ts`,
    `packages/web/src/views/dreams.css`; the execution ledger cited above.
  - Trigger: not stated for any of these.
  - Size: small each.
  - Already resolved, not outstanding: the same ledger records that `dreamNow` originally had no
    handling for a throwing `acquireDreamLock`, which would have surfaced a raw `ENOENT` error
    from the CLI. This was carried into the CLI task as a requirement rather than left open, and
    the CLI now catches it with "Dreaming could not run: ... Your memory folder may be damaged;
    try 'reverie doctor'." Named here only so the ledger's original count of fifteen is
    accounted for; there is nothing left to do.

- **Dreaming v1: feedback-verdict folding logic is duplicated between the CLI and the server.**
  `packages/cli/src/dream.ts` and `packages/server/src/app.ts` each re-derive verdicts from the
  dream log independently. It would consolidate most naturally by having the engine's `readDream`
  expose verdicts directly, so both callers read rather than re-derive them.
  - Why deferred: ledger-flagged as a consolidation opportunity, not a bug; not picked up during
    implementation. Cleared to ship by the final whole-branch review along with the rest of the
    ledger.
  - Where: `packages/cli/src/dream.ts`, `packages/server/src/app.ts`,
    `packages/memory/src/engineDreams.ts` (`readDream`).
  - Trigger: not stated.
  - Size: small.

- **A deterministic post-filter for em dashes and LLM cadence in model output.** The prose voice
  rule now sits in the companion and firewall personas, in both reflection prompts, and in both
  dreaming prompts, telling the model not to use em dashes and to vary sentence structure. That is
  an instruction, not enforcement: nothing in the code inspects or rewrites what the model actually
  returns before it is spoken or written into the memory folder.
  - Why deferred: the implementer's own words, "this is a prompt instruction, not deterministic
    post-processing. It can meaningfully reduce em dashes and stacked-clause cadence in model
    output, but it cannot guarantee elimination: the model can still ignore it, especially under
    retry pressure or on a weaker configured provider." The tests added alongside it "prove the
    instruction is present in all four prompts, not that model output changed."
  - Where: `packages/memory/src/voice.ts` (`PROSE_VOICE_RULE`, the canonical text), consumed by
    `packages/core/src/personas.ts`, `packages/memory/src/reflection.ts` and
    `packages/memory/src/dreaming.ts`.
  - Trigger to revisit: not stated. The observation that prompted the rule was em dashes appearing
    in stored memory items and in live replies, so recurrence of that after the rule shipped would
    be the natural signal.
  - Size: small for a mechanical em dash pass over stored and spoken prose; larger if it is meant
    to cover cadence, which is not mechanically detectable.

- **The Atlas categorical palette cannot separate all seven node types under simulated colour
  vision deficiency, only adjacent ones.** Each node type now has its own accent hue, validated to
  clear the 3:1 contrast floor on both the light and the dark canvas surface, and validated for
  CVD separation between palette-adjacent pairs. The all-pairs check fails beyond three slots.
  - Why deferred: the dataviz skill's own reference documents this as an unavoidable limit at seven
    categories, not a mistake in the choice of hues. The mitigation actually in place is composite
    encoding: the all-pairs failures land on type pairs that node size already separates by several
    size bands (item at 3 to 5px against arc at 13 to 16.5px), while the validated adjacent pairs
    are exactly the pairs size does not separate. Ring thickness varies by type as a second
    non-hue channel, and the per-type filter checkboxes let any type be isolated regardless of hue
    confusion.
  - Where: `packages/web/src/tokens.css`, the comment on the `--type-*` custom properties, and
    `packages/web/src/atlas.tsx`, the comment on `TYPE_COLOR_VAR`, which carries the measured
    numbers.
  - Trigger to revisit: not stated. An eighth node type would force the question, since slot 8 of
    the reference palette is deliberately left unused and the composite-encoding argument would
    have to be re-made for the new pairs.
  - Size: small to re-validate, larger if it means adding a genuine second visual channel such as
    node shape.

- **`packages/memory/src/sqlite.ts` imports `better-sqlite3` at module scope, so a host with no
  native modules survives only by a third party's implementation detail.** P0-2
  (`docs/superpowers/specs/2026-08-27-hostable-engine-design.md`) gave `MemoryIndex` an injected
  `SqlDatabase` and a `fromDatabase` entry point, so a host that cannot load a native module never
  calls `MemoryIndex.open`. The top-level `import Database from 'better-sqlite3'` stays regardless,
  and a bundler does evaluate its interop shim at startup. It does not fail today only because
  better-sqlite3 itself defers loading its native `.node` binding until the `Database` constructor
  runs. That is a guarantee owned by a dependency rather than by this codebase, and a future version
  of it that loaded eagerly would turn a working host into one that dies before any handler runs.
  Splitting the better-sqlite3 adapter into its own module the way `nodeStore.ts` split from
  `store.ts` would make the guarantee ours.
  - Why deferred: not stated beyond being explicitly out of scope for the round that raised it.
    Measured working today by the downstream consumer that runs the engine without native modules,
    and named by them as a note rather than a request.
  - Where: `packages/memory/src/sqlite.ts` (the top-level `better-sqlite3` import, `MemoryIndex.open`,
    and the adapter that wraps it), against the pattern in `packages/memory/src/store.ts` and
    `nodeStore.ts`. Design source: `docs/superpowers/specs/2026-08-27-hostable-engine-design.md`,
    P0-2, and the round two follow-up spec's "deliberately not doing" section.
  - Trigger: a better-sqlite3 release that loads its native binding at import time, or any move to
    make the engine's non-Node support a supported claim rather than a removed obstacle.
  - Size: small. One module split plus moving `MemoryIndex.open` to it, with no behavior change for
    self-hosted.

- **Three modules in `packages/memory/src` still import `node:fs/promises` directly after P0-1
  put filesystem access behind `FileStore`/`AppendOnlyStore`.** `dreamSchedule.ts` (the dream file
  lock, `flag: 'wx'` exclusive create with a stale-lock takeover on `readFile`/`rm`/`writeFile`),
  `migrations/styleToProfile.ts` (three calls reading and rewriting `config.toml`), and
  `gitSync.ts` (one `stat` call, narrowed to `FileStore.exists` rather than converted, see below).
  None of the three is a gap in the P0-1 cut; each has a concrete reason the frozen interfaces do
  not fit. `sqlite.ts` was a fourth module in this item; P0-2 (same spec) gave `MemoryIndex` an
  injected `SqlDatabase` and moved its `fileMtime` stat call out to `engine.ts`, whose caller
  already holds `paths.files`, so `sqlite.ts` no longer imports any node builtin and is out of
  this item as of that change.
  - Status update, 2026-08-27: `dreamSchedule.ts`'s reason changed. A review that day found the
    design spec's claim, quoted below, was false as shipped: `capabilities.locking` was defined on
    `FileStore` but read nowhere, so the lock ran unconditionally even where it was meant to be
    disabled. `acquireDreamLock`/`releaseDreamLock` now check `paths.files.capabilities.locking`
    first and return immediately when it is false (acquire always succeeds, release is a no-op),
    with no `node:fs` call reached on that path, proven by a test that gives them an in-memory
    store whose root is not a real directory and asserts they resolve rather than reject with
    ENOENT. The module still imports `node:fs/promises`, now genuinely only for the
    locking-enabled branch (self-hosted CLI/server, two OS processes sharing one folder), which is
    the same "no exclusive-create primitive in `FileStore`" reason `styleToProfile.ts` and
    `gitSync.ts` already had below, not a gap still to close.
  - Why deferred: quoting the design spec
    (`docs/superpowers/specs/2026-08-27-hostable-engine-design.md`, "What we checked and are
    deliberately not doing"): "The dream file lock does not need removing, only disabling, since a
    Durable Object is single-threaded. `capabilities.locking` covers it." `FileStore` has no
    exclusive-create primitive for `dreamSchedule.ts`'s `flag: 'wx'` lock semantics, so disabling
    the lock under `capabilities.locking` (now actually wired, see above) is the fix rather than
    adding one. `styleToProfile.ts`'s `config.toml` lives outside the memory folder (it is
    infrastructure, not `MemoryPaths`-scoped) and is written `mode: 0o600` because it holds the
    API key; `FileStore.writeFile` carries no permission parameter, so routing it through
    `FileStore` would silently drop that permission. `gitSync.ts`'s `commitMemory` was
    scoped by this task to "leave the git invocation alone, only convert its one fs call"; its
    `stat`-based `isDirectory` check was narrowed to `FileStore.exists` (a real behavior change,
    noted in the code, in the one pathological case where `root` or `.git` exists as a plain file
    rather than a directory) rather than adding a directory-type primitive to the frozen
    interface.
  - Where: `packages/memory/src/dreamSchedule.ts`, `packages/memory/src/migrations/styleToProfile.ts`,
    `packages/memory/src/gitSync.ts`. Design source:
    `docs/superpowers/specs/2026-08-27-hostable-engine-design.md`, section P0-1, and its "What we
    checked and are deliberately not doing" list.
  - Trigger: `config.toml` handling ported to a host with no filesystem (`styleToProfile.ts`); not
    stated for `gitSync.ts`; `dreamSchedule.ts` needs no further trigger, since its part of this
    item shipped on 2026-08-27.
  - Size: not stated for `styleToProfile.ts`, since a faithful conversion needs either a
    permission-aware `FileStore` variant or a separate host-config interface that does not exist
    yet; not stated for `gitSync.ts`.

- **Document that a Workers-style host must take its canonical origin from configuration.**
  `wrangler dev` rewrites the `Host` header to the configured route hostname while leaving `Origin`
  alone, so a host running the engine behind it cannot derive its canonical origin from the request,
  and that origin is not the address a developer types into a browser. One or two sentences wherever
  `createFetchApp` is documented.
  - Why deferred: not deferred by a decision. Handed over by Reverie Cloud on 2026-08-28 as a finding
    with no action requested ("Worth a line in whatever documents `createFetchApp`, because it will
    confuse the next person to host it"), and recorded here rather than left as a promise inside the
    reply document.
  - Where the thinking already lives:
    `docs/specs/2026-08-28-openreverie-request-round-two.md` part G, and our reply at
    `docs/specs/2026-08-28-reverie-cloud-round-two-reply.md` section 8.
  - Trigger: the next time `createFetchApp` or the hosting story is documented, or the next report of
    a host confused by an origin check.
  - Size: tiny.

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
