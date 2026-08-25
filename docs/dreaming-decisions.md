# Dreaming v1: decision record

This file records the judgment calls made while building dreaming v1: the thirty-six rulings
taken on the human's behalf during execution, at points where the plan and the spec did not
settle a question. The spec (`docs/superpowers/specs/2026-08-24-dreaming-design.md`) remained the
binding authority throughout; where a ruling below diverges from it, that divergence is a
deliberate exception argued from the spec's own text, not a silent departure. The resulting spec
deviations, the ones that changed what ships versus what the spec describes, are recorded
separately in `docs/dreaming.md` and `BACKLOG.md`. This file is about how the code came to be
shaped the way it is, not about what was left undone. Fifteen further findings were rated Minor
and deferred without a full ruling; two of the fifteen describe the same finding (the `dreams.css`
lint warnings, flagged once mid-review and once at task close), so `BACKLOG.md` records them as
fourteen distinct grouped entries, in its "Smaller improvements, help welcome" section; they are
not repeated here.

Each entry below states the question, what was decided, and the cost if the decision turns out
wrong, where the underlying record states a cost. Entries are grouped by the area of the system
they explain, not by the order they were made in, since a reader is more likely to arrive here
having hit a specific piece of code than having read the whole execution in order.

## 1. Corrections to defective plan material

Five kinds of defect turned up in the plan text itself, caught during execution rather than
before it. Two tests could not fail for the reason they claimed to: the Task 5 relaxation test
(C4) hit an early return before the logic it named ever ran, and separately, a Task 6 cap test
scripted only one tool call per round so the per-call overflow guard it was meant to cover never
executed (found and fixed with a covering test; not a contested ruling, so it carries no ruling
label). A third test's expected set was arithmetically wrong (C3). One declared interface omitted
a field that the behavior text and the test both already used (C5). And in three places the plan
named the wrong file, or no file, as the site of the real work (A1, A2, A3).

- **C3 (Task 5).** The plan's median-reservation test for `pickSeeds` asserted the reserved
  older-half pool as `{a, b, f}`, excluding candidate `c`, but tracing the real algorithm
  (`dated[Math.floor(6/2)]`) shows the pool is actually `{a, b, f, c}`. Decision: the assertion
  set was corrected to match the implementation's real pool, rather than reaching green by tuning
  the rng seed. Cost if wrong: the test then proves a slightly weaker property than the spec's
  literal "older than the median" phrase, though the reach-back guarantee still holds.

- **C4 (Task 5).** The relaxation test for `pickSeeds` passed 2 candidates with `count: 2`, so the
  early return (`candidates.length <= count`) fired before the relaxation branch it named ever
  ran. Decision: the fixture became 3 mutually adjacent candidates with `count: 2`, so the
  relaxation branch actually executes, falsified by deleting the relaxation escape and confirming
  the test then hangs or fails. Cost if wrong: none material, the result is a strictly stronger
  test than the plan specified.

- **C5 (Task 7).** The plan's Interfaces block for `RunDreamArgs` omitted `resolveNode`, while the
  behavior paragraph and the test fixture both already used it. Decision: `resolveNode: (id:
  string) => boolean` is part of `RunDreamArgs`; behavior text and test win over the summary list.
  Cost if wrong: none, the summary list was an omission rather than a design choice.

- **A1 (Task 2).** `MemoryEngine.walkAllDocuments()` had no branch for the dreams directory, so
  adding `dream` and `dream_insight` to `DOC_KINDS` made them indexable but not actually readable
  through `read_document`, and Task 2's own file list never named `engine.ts` as a site to touch.
  Decision: Task 2's scope grew to add a `dreamsDir` branch scanning dream subdirectories two
  levels deep, mapping `dream.md` to kind `dream` and `insight.md` to kind `dream_insight`, and
  ignoring `log.jsonl`, `.lock`, and `process.jsonl`. Cost if wrong: roughly 20 more lines in a
  file two later tasks also touch sequentially; not doing it would have left the design's stated
  read path broken.

- **A2 (Task 10).** The plan pointed at a greeting-construction site in `AgentSession.start()`
  that does not build a greeting turn at all; the greeting actually lives in `greet()` calling a
  private `runGreeting()` that receives no `SessionContext`. Decision: rather than changing
  `assembleSystemPrompt`'s return type, which would touch three call sites and their tests for no
  gain, `start()` captures the fresh-dream state on the instance and `runGreeting()` appends
  mention guidance to `GREETING_INSTRUCTION`; `engine.markDreamMentioned` fires only at the point
  guidance is actually injected, so a session that decompresses without injecting guidance leaves
  the dream available for a later one. Cost if wrong: a dream could be mentioned in a later
  session than the plan intended, which the spec's current-or-previous-period allowance still
  covers.

- **A3 (Task 12).** The `{ chat, embeddings, reflectionModel, embeddingModel }` object that
  becomes `EngineDeps` is actually built in `packages/cli/src/chat.ts`'s `openCliContext`, not in
  `index.ts` as Task 12's file list and commit description said. Decision: `chat.ts` joined Task
  12's file list and commit, sequential with Task 11's unrelated edit to the same file. Cost if
  wrong: none identified; without it, the new configuration never reaches the engine and the CLI
  dream command runs with no dreaming configuration.

- **C21 (Task 10).** A2's fix left `AgentSession.start()` reading `sessionContext` from disk a
  second time, since threading a pre-read context through `assembleSystemPrompt` would have
  reopened the three call sites A2 deliberately avoided touching. Decision: accepted as a minor,
  deferred. Cost if wrong: a small amount of duplicated disk I/O per session start.

## 2. Behavior and safety decisions

These rulings changed what the running system actually does, each resolving a place where the
plan's literal text, the spec, or an existing code idiom pointed in a different direction than
the implementer's first draft.

- **Unlabelled (Task 1).** `foldDreamLog` resolves the last feedback record for an insight by
  array position (fold order) rather than by comparing timestamps, unlike the sibling
  `lastDreamt` logic, which does sort by `ts`. Decision: correct as specified. The spec's Storage
  section says verbatim that later feedback on the same insight wins by fold order, and since the
  log is append-only, position is chronology for records this process wrote; the asymmetry with
  `lastDreamt` is deliberate, since entity coverage merges across many interleaved dream runs
  while feedback on one insight is a simple last-write-wins sequence. Cost if wrong: a
  clock-skewed or hand-edited log could resolve a verdict differently than a timestamp sort
  would, bounded to feedback verdicts, with every record still retained for later re-derivation.

- **A4 (Task 9).** The plan's fire-and-forget `onStart` dreaming trigger was not gated behind
  `MemoryEngineOpenOptions.maintenance`, the flag every other background-work path in `open()`
  already uses to keep tests deterministic, so any test opening an engine with dreaming enabled
  would get real background file I/O and provider calls racing its own teardown. Decision: gate
  `onStart` behind the same `maintenance` flag. Cost if wrong: none identified; a caller that
  explicitly passes `maintenance: false` also correctly opts out of dreaming at startup.

- **A5 (Task 9).** Every existing use of `.reflected` in `engine.ts` pairs it with `!s.skipped`,
  since a skipped session (no user messages) still gets a placeholder summary marked
  `reflected: true`, but the plan's dreaming-readiness floor did not exclude skipped sessions.
  Decision: `reflectedSessionCount` uses `s.reflected && !s.skipped`, matching the codebase idiom;
  the spec's floor means five real reflected sessions, not five placeholders. Cost if wrong:
  dreaming activates marginally later on a folder full of empty sessions, the intended
  conservative direction.

- **B2 (Task 4).** A non-JSON `.lock` file makes `acquireDreamLock` return false forever:
  `JSON.parse` throws, the catch returns false, and no later call can recover, so dreaming goes
  silently dead after one truncated write (a crash mid-write, a full disk) with no error and no
  diagnostic. Decision: treat an unreadable or unparseable lock file as stale, taken over exactly
  as an invalid timestamp already is; if the takeover's exclusive create then loses, it returns
  false, the already-excused race. Cost if wrong: a corrupt lock is taken over slightly more
  eagerly than a strict reading of the brief allows; the alternative, a permanent silent failure
  in a feature the person cannot see running, is worse.

- **B3 (Task 4).** `acquireDreamLock` can throw when `dreamsDir` is missing, and the brief left
  this unaddressed. Decision: leave it throwing. `ensureMemoryTree` always creates `dreamsDir`, so
  a missing one means a broken or hand-damaged memory folder, and failing loudly is the right
  response; carried into Task 9 so the engine's trigger path knows the call is not total. Cost if
  wrong: an unusual folder state surfaces as an exception rather than a skipped dream, and Task 9
  wraps the trigger call in error handling regardless.

- **C7 (Task 5).** The brief's `randomWalk` picked a uniform-random neighbor, but the spec (line
  155) specifies the walk is degree-weighted; the plan had simplified this without flagging it.
  Decision: implement degree-weighted neighbor selection, where a neighbor's draw probability is
  proportional to its own degree in the folded graph, keeping the hop bound, the no-revisit rule,
  and the seeded rng. Cost if wrong: walks would lean toward well-connected nodes, so a dream's
  supporting cast favors central people and arcs over peripheral ones; reach-back stays protected
  at the seed layer regardless, since staleness weighting and the reserved older-half slot do not
  depend on the walk.

- **C8 (Task 5).** The implementer deleted the plan's post-loop `pickSeeds` fallback (filling
  remaining slots from the highest-weight leftovers) because its presence made the relaxation
  logic unfalsifiable in isolation, correctly diagnosing the test problem but removing a specified
  safety net to fix it. Decision: restore the fallback exactly as specified, since it is the
  spec's "relaxed progressively if the pool is too small" guarantee and later tasks depend on
  receiving a full set of seeds; reshape the test to assert the observable guarantee instead, and
  add a separate test pinning the fallback's own behavior via an exported `fillRemainingSeeds`.
  Cost if wrong: the relaxation branch alone is not isolatedly falsifiable, so a regression
  disabling it would be caught only by the seed-quality invariants and the fallback; the
  alternative was a `pickSeeds` able to return fewer seeds than its callers require.

- **C10 (Task 6).** The implementer asked whether `tool_call` process-log events should fire for
  calls refused after the budget was spent, not only for calls that actually reached the lookup.
  Decision: keep `record` firing only on dispatched calls, since `process.jsonl` is a user-visible
  audit trail and a `tool_call` event should mean exactly one tool ran; additionally emit one
  `budget_exhausted` event per run, carrying `maxToolCalls` and the refused count, so the trail
  still shows the model wanted to keep going. Cost if wrong: one extra event type that a later
  task buffers and writes, deletable in one line if unwanted, with nothing else reading it.

- **C11 (Task 7, touching Task 6).** When `runExploration` returns after the budget is spent, the
  model's final reply can carry tool calls with no matching tool result message; `FakeChatProvider`
  does not validate this so every test passed, but a real provider rejects a transcript with an
  unanswered tool use, and Task 7 was reusing those messages for the insights call. The
  implementer had patched defensively at the point of reuse rather than at the source. Decision:
  fix it in `runExploration` itself, since that function's contract should be to always return a
  well-formed conversation, and remove the defensive patch so the behavior lives in one place with
  one test. A real defect found after a task was marked complete still gets fixed properly rather
  than worked around. Cost if wrong: touches a file already reviewed and marked complete, so that
  task's approved diff was no longer the final word on it; recorded here and covered by Task 7's
  own review.

- **C12 (Task 7).** The "all insights unresolvable, therefore abort and write nothing" path was
  covered only by falsification, with no direct assertion of the outcome, despite being a real
  abort path with a real consequence for the person's folder. Decision: add a dedicated test
  asserting that when every insight's evidence fails to resolve, the run aborts and nothing is
  written. Cost if wrong: none, one more test.

- **C18 (Task 9).** `dreams/.lock` was staged by `commitMemory`'s `git add -A` before
  `releaseDreamLock` deleted it, leaving the user's memory git working tree permanently dirty (a
  pending deletion) after every dream run, because the memory folder's `.gitignore` seeded only
  `index.db` and `*.tmp-*`. Decision: gitignore the lock rather than reorder the release; the
  lock's location is fixed by the spec as shared filesystem state between the CLI and server, so
  it cannot move, and gitignoring is declarative, immune to future reordering, and also covers a
  crashed run that leaves a stale lock behind. Cost if wrong: the engine appends one line to an
  already-engine-owned `.gitignore` in the user's folder when that line is absent; the alternative
  is a memory repo that reports itself dirty forever.

- **C19 (Task 10).** The implementer filtered `freshDream` on `insightCount === 0`, meant to skip
  crashed or partial writes, but every successfully written dream has at least one insight (a run
  aborts otherwise), so that filter never excluded a dream whose narrative the tone gate withheld,
  which has insights but no `dream.md`; the opener would still offer to share it. Decision:
  `freshDream` requires `hasNarrative === true`. The opener offers to share the dream, and the
  dream a person reads is `dream.md`, so this predicate excludes both tone-withheld and partial
  directories, while still letting a withheld dream's insights reach the prompt section, since
  those are for the model and the narrative is for the person. Cost if wrong: a dream whose
  narrative was withheld is never mentioned in an opener, the intended reading, since there is
  nothing for the person to read.

- **C20 (Task 10).** The rendered dreams section carried no truncation marker when insights were
  capped, unlike its sibling `capRows` sections, whose house convention is that the caller renders
  the marker because its wording differs per section. Decision: render a marker naming
  `search_memory` as the way to reach older dream insights, since insights are genuinely indexed
  under the `dream_insight` kind; a section that silently truncates tells the model less than it
  knows. Cost if wrong: a few characters of the cap go to the marker rather than to an insight
  row.

- **C23 (Task 13).** The server needed feedback verdicts merged into insight detail for the web
  client, beyond the three engine methods the brief specified, so the implementer read
  `dreams/log.jsonl` directly through `memoryPaths`/`readDreamLog`/`foldDreamLog`. Decision:
  accept it. It stays inside the legal `server -> memory` direction, mirrors what the CLI already
  does on this branch, and widening the engine API this late, after Task 9 was already committed
  and reviewed, has a far larger blast radius. Cost if wrong: the same fold logic now lives in
  both the CLI and the server, so a future change to verdict semantics has to be made twice;
  recorded as a consolidation candidate.

## 3. Scope and severity judgments

Three findings were explicitly raised from Minor to Important during review, and a fourth safety
gate was fixed immediately rather than deferred, for a closely related reason: each mattered more
once traced to its actual consequence than its first-pass rating suggested.

- **C15 (Task 7).** Rated Minor at first: the tone-gate narrative retry sent byte-identical
  messages to the first call and discarded `toneResult.data.reason`, so only temperature
  separated the two attempts. Raised to Important and fixed in the same round, because the
  spec's "regenerated once" implies a real second chance, and a regeneration handed no feedback
  on identical input is not meaningfully a second attempt. The outcome stayed safe either way
  since the narrative is withheld regardless, so this cost the person a dream rather than exposing
  them, and the fix was cheap. Cost if wrong: one extra sentence of rejection reason reaches the
  regeneration prompt, removable in one line if it biases the second attempt badly.

- **C17 (Task 9).** Rated Minor at first: `releaseDreamLock` runs in `maybeDream`'s `finally`,
  outside the enclosing `catch`, and `rm(..., {force:true})` still throws on EPERM/EACCES/EROFS
  even though it swallows ENOENT. Raised to Important and fixed this round, because
  `_doEndSession` awaits `maybeDream`, so on such a folder the rejection would escape and make
  `endSession()` itself fail: exactly the containment the spec's Property 2 requires (ending a
  session must not fail because a background dream could not start), defeated by one unguarded
  cleanup line. Cost if wrong: a lock-release failure becomes a logged warning instead of an
  exception, so a genuine permissions problem surfaces less loudly from this path, though it still
  surfaces and the stale-lock takeover bounds the consequence to fifteen minutes.

- **C24 (Task 12).** Rated Minor at first: no test proved `reverie dream`'s CLI dispatch actually
  reached `runDreamCommand`, on file-scope grounds. Changing the dispatch condition to a typo left
  all 110 tests passing, empirical proof the entry point was unverified. Raised to Important,
  since a wrong dispatch line would make the entire CLI entry point for the feature silently do
  nothing while the suite stayed green, worse than most defects on this branch, for the cost of
  one test. Cost if wrong: one extra test in `index.test.ts`; none otherwise.

- **C26 (Task 13).** Deleting the launch-time gate
  (`config.dreaming.enabled && config.dreaming.triggers.serverTimer`) and always wiring the server
  timer trigger passed all 64 tests and typechecked cleanly, because the one assertion touching
  the registry's arguments used `expect.objectContaining`, which ignores whether `dreamTrigger` is
  present at all. Decision: fix in this task rather than defer, because `serverTimer` has no other
  call-site guard, making this gate the only enforcement point for an operator turning
  server-timer dreaming off, and AGENTS.md treats unattended writes to a memory folder as
  domain-sensitive, which puts a regression here above the usual deferred-minor line. The new
  tests assert on the actual argument rather than the matcher that let the gap through the first
  time. Cost if wrong: three small tests in `launch.test.ts`; none otherwise.

## 4. Method decisions about how the work itself was run

These rulings governed how execution was organized, dispatched, and reviewed, not what the code
does.

- **C6 (Task 10).** Task 10 edits `packages/core/src/context.test.ts`, the file already holding a
  known pre-existing failure that fails on main and on this branch's base. Decision: the
  implementer neither fixes it nor reports it as its own regression, and the reviewer does not
  count it against the task. Cost if wrong: wasted rounds chasing an unrelated failure.

- **P1 (Tasks 13 and 14).** Server and web run in parallel but share an HTTP response-shape
  contract, with the web client consuming what the server's routes serve. Decision: both
  dispatches carry the identical response-shape contract, quoted verbatim from the plan, as the
  binding interface; the web tests use a stub, so neither task blocks the other. Cost if wrong: a
  shape mismatch would be caught by the final whole-branch review rather than at task review,
  costing one fix round, which is what later happened with the Settings profile contract.

- **B1 (Tasks 3 and 4).** Task 4 appends the dream lock to the same module and test file Task 3
  creates, and both are small and fully specified. Decision: one implementer runs Task 3 then
  Task 4 in order, producing the plan's two separate commits with its exact messages, with one
  review covering both; order across all fifteen tasks is preserved and nothing runs in parallel
  that the handoff did not permit. Cost if wrong: a defect in Task 3 gets slightly less isolated
  scrutiny than a standalone review would give it, though the review still falsifies each task's
  behavior separately.

- **B4 (Tasks 3 and 4, method for all later reviews).** Two agents in a row were killed by a
  600-second no-progress watchdog while running whole-package test suites that stream no output
  for two or more minutes under concurrent load. Decision: reviewers stop running whole-package
  suites; each runs only the single relevant test file plus lint, both fast, while the orchestrator
  runs the full package suite and build in its own background shell, where a long silent wait
  costs nothing. AGENTS.md's requirement that a reviewer run tests itself is preserved, since the
  reviewer still runs, unaided, every test covering the code it is falsifying. Cost if wrong: a
  reviewer sees a narrower suite, so a cross-file regression would surface at the orchestrator's
  full run or the final whole-branch review rather than at task review.

- **C9 (Task 5, fix round 1).** A five-name export list narrowing (`export *` to explicit names)
  was a 1,256-byte diff in one file. Decision: the controller verified this round directly, by
  reading the resulting export list against the module's full export set, rather than dispatching
  a subagent to reread five lines already read in full; this is not a controller fix, since the
  implementer wrote it, and not a skipped review, since `pnpm build` and the package suite, both
  run by the controller, catch the one real failure mode. Cost if wrong: this fix diff got one
  reader instead of two, bounded to an export list whose correctness is fully determined by the
  build and suite that were run; normal subagent re-reviews resumed for every non-trivial fix
  round after this one.

- **C13 (Task 7).** The implementer flagged that its own model-facing instruction strings were
  checked mechanically for em dashes but not for tone or tropes, correctly noting that the prose
  shapes what the companion says about a person's life. Decision: no implementer action; the Task
  7 reviewer runs on Opus per the handoff and reads every instruction string against the writing
  rules as an explicit review item, rather than the implementer self-certifying its own prose.
  This paid off directly: the read-only prose reviewer, working independently, found that the
  exploration instructions' rule against resolving stated times to a real date was not actually
  present in the system prompt used for the insights call, a gap neither reviewer alone could have
  found (see C14).

- **C14 (Task 7).** Two single-agent reviews of Task 7 had already died mid-run, one to a session
  limit, one to an API error, rather than being retried a third time as one dispatch. Decision:
  split the review in two, run concurrently: an Opus falsifying reviewer covering four safety
  properties with required falsifications, and a Sonnet strictly read-only reviewer covering every
  model-facing instruction string plus public API hygiene. This split is safe only because one
  side modifies files (break, test, restore) while the other is forbidden to edit anything, since
  two falsifying agents on the same files would corrupt each other's work. Cost if wrong: two
  reviewers each hold half the picture, so a defect spanning both halves could fall between them;
  the orchestrator holds both reports and checks that seam, which is exactly how the C15 finding
  surfaced.

- **C22 (Task 10, method for all remaining work).** A Task 10 reviewer's first falsification,
  deleting the highest-stakes property in the task, produced zero failures, not because the test
  was weak but because `packages/core` tests resolve `@openreverie/memory` through its compiled
  `dist` (declared as `main` in `package.json`, with no dev-condition alias), so editing
  `packages/memory/src` and rerunning a `core` test was silently a no-op. Decision: from that
  point on, any falsification that edits `memory/src` and verifies via a `core`, `cli`, or
  `server` test must rebuild in between, and every reviewer dispatch that could cross that
  boundary carries this instruction explicitly; the orchestrator also runs `pnpm build` before
  cross-package suite runs rather than after. A reassessment of every earlier falsification in the
  session confirmed only Task 10 had crossed this boundary, so no earlier finding was invalidated.
  Cost if wrong: a rebuild step adds time to each cross-package falsification; without it, a
  reviewer can report a gap that does not exist, or miss a real regression entirely.

- **C25 (Task 12).** The off-message shown when dreaming is off named `defaultConfigPath()`
  unconditionally, so under `--config <other.toml>` it pointed a person at a file they were not
  using. The reviewer's suggested fix, an optional `configPath` on `ReverieConfig` populated in
  `loadConfig`, was sound but would touch `packages/core`'s config schema, which carries
  round-trip tests, at the very end of the branch for a narrow case. Decision: keep the fix inside
  `packages/cli` by making the sentence true in both cases, labelling the path as the default
  location rather than asserting it is the one in effect. Cost if wrong: someone using `--config`
  gets a slightly less specific pointer, though they are told the correct setting and the
  `--force` hatch either way.

## 5. Decisions deliberately deferred to the human

Two decisions were left open rather than resolved during execution, because each carries a design
or data-format consequence properly owned by the human.

- **C16 (Task 9).** The implementer flagged that `dreamNow({ force: true })` bypasses
  `dreaming.enabled`, reading the brief literally, and asked for confirmation rather than
  assuming. Decision: this reading is exactly right and stands, confirmed against the spec's own
  text: manual runs are exempt from the once-per-period rule but must respect the switch being
  off, with `--force` as the spec's own escape hatch. The unforced path still refuses with a clear
  message when dreaming is off, surfaced by the CLI as "dreaming is off." Cost if wrong: someone
  with dreaming switched off who explicitly types `--force` gets a dream and spends a model call,
  which is what the flag is for, and it cannot fire without being typed.

- **C27 (Task 15).** The spec's Feedback section requires the CLI to record feedback directly
  through the engine ("the CLI appends directly through the engine"), but Task 12's brief narrowed
  the CLI to display-only, and nothing caught the gap until the final whole-branch review. The
  dream log's `feedback` record schema also constrains `source` to `'ui' | 'tool'`, so a CLI
  recording path needs either a third source value, changing an append-only log format at the end
  of the branch, or labelling terminal corrections as `'ui'`, which would be dishonest data.
  Decision: record the deviation, raise it to the human, and do not implement it now. AGENTS.md
  requires raising a spec contradiction rather than silently diverging, and the source-value
  question is a design decision with a data-format consequence that belongs to the human. Cost if
  wrong: someone who lives in the terminal cannot correct an insight without opening the web view
  or saying so in conversation. No data is wrong and nothing is unreachable: two of the three
  feedback paths, the web view's feedback endpoint and the `dream_feedback` tool mid-conversation,
  shipped and are tested, and `reverie dream --show` still displays verdicts recorded elsewhere.
