# Reply to Reverie Cloud, round two

Date: 2026-08-28. From openreverie. Answering
`reverie-cloud/docs/specs/2026-08-28-openreverie-request-round-two.md`.

## 0. What this is, and what shipped

Three things are in here. A review, answering part A. A set of positions, answering B, C, E, F and
saying plainly where we think you are wrong. And one shipped change, part D, which was the only thing
gating anything.

Your document held up well under checking. Every file and line it cited was accurate, including the
ones we expected to have drifted: `personas.ts:17`, `personas.ts:76`, `personas.ts:122`,
`personas.ts:128`, `personas.ts:142`, `personas.ts:144`, `personas.ts:156`, `context.ts:48`,
`engine.ts:324`, `chat.ts:583`, `launch.ts:120`, `registry.ts:10`, `openai.ts:21`, `openai.ts:233`.
We also checked the two claims in your section 2 that were load bearing rather than descriptive:
`agent.test.ts:1364` does assert `second.system === first.system`, and `budget.test.ts:14` does
assert the cap total, which turns out to matter more than you meant it to (see part B5 in section 4).

Two of your framing claims did not hold up, and both changed our answer rather than our tone. They
are in section 1.

## 1. Two places where you are wrong, and they matter

### 1.1 The launch blocker was in two places, not one

Line numbers in this section and in appendix A are pinned to `4bd6ca7`, the revision reviewed, not to
the tree after part D. Part D moved some of this text, so checking these lines against `main` will
show you the fix rather than the bug.

You found the deployment claim in `WHAT_REVERIE_IS` (`personas.ts:17`). There is a second one, and it
is worse:

`packages/core/src/context.ts:103`, inside `firstConversationSection`:

> "Open with a short, warm welcome, two or three sentences: reverie is private and runs entirely on
> their own machine, and it remembers what they tell it so future conversations start with real
> context instead of from scratch."

`WHAT_REVERIE_IS` is background framing that the model may never voice. This one is a direct
instruction to say the claim out loud, in the opening two or three sentences, of the person's first
ever conversation. That is precisely the moment you described in your section 1. Had we fixed only
what you asked for, your greeting would have stopped carrying the false claim as background and gone
on carrying it as speech, which is worse, and it would have looked fixed.

It also sits outside the design you proposed. Your `OverridableBlock` union enumerates blocks in
`personas.ts`. `firstConversationSection` lives in `context.ts` and is assembled by
`assembleSystemPrompt`, so no version of `PersonaOverrides` as specified could ever have reached it.

We checked the rest of the repository for the same class of claim. Model-bound prose asserting where
the software runs or who can read the data exists in exactly those two places and nowhere else: not
in reflection, not in rollups, not in dreaming, not in any tool description, and not in the web UI
copy. The grep and the reasoning are in the part A catalogue.

### 1.2 Part B2 closes the front door while the back door is open

Your protected-block design exists so a host cannot reach the crisis stance, including by accident.
The premise is that today it cannot. In the chat path that is true. In the dreaming path it has never
been true.

`packages/memory/src/engine.ts:3173`:

```ts
const persona = this.deps.dreamPersona?.(this.currentStyle()) ?? ''
```

`dreamPersona` is typed as a bare `(style: StyleConfig) => string` (`engine.ts:324`) and nothing
validates what it returns. A host that supplies one already controls the entire dream system prompt,
crisis stance included, with no enforcement of any kind. A host that supplies none gets an empty
string as the system prompt for all four dream stages: exploration, insights, narrative, and the tone
gate. No identity, no memory orientation, no voice rule, no crisis stance.

The contrast with the line eight above it is the part we find hard to defend:

```ts
const model = this.deps.dreamingModel
if (model === undefined) {
  const reason = 'Dreaming has no model configured: ...'
  await this.recordDreamAttempt(args.period, args.trigger, 'failed', reason)
  throw new Error(reason)
}
```

A caller who forgets the model gets a loud, specific error, and the comment above it says so in as
many words. A caller who forgets the persona gets silence. This is the fail-open shape our own
`AGENTS.md` records as a repeated lesson in this codebase, and we wrote it anyway.

This is a live hazard for you specifically, not a hypothetical. You open `MemoryEngine` directly
inside the Durable Object rather than going through `launch.ts`, so you are one forgotten dependency
away from four unguarded model calls per dream, on a mental wellbeing product.

**This did not ship in this round.** Part D is the only code change here, and we did not pull this
into it: it is a separate defect with a separate blast radius and it deserves its own change and its
own review. It is recorded in `BACKLOG.md` and it is first in our proposed sequencing in section 10.

Our intended fix, for your comment before we build it: `dreamPersona` becomes required when dreaming
is enabled, failing the way `dreamingModel` fails, and the crisis stance gets composed by the engine
on the dream path rather than trusted to arrive inside a host-supplied string. The second half is a
design round rather than a patch, because `memory` sits below `core` and cannot import
`buildPersona`, which is the same constraint that produced the bug.

## 2. Part D, shipped

This is in the change that carries this document. It is the only part of your request that is built.

`WHAT_REVERIE_IS` is split into three pieces: `REVERIE_IDENTITY`, `DEFAULT_DEPLOYMENT_CONTEXT`
(exported), and `REVERIE_PURPOSE`. `firstConversationSection` is split into a host-overridable
welcome and onboarding script and an engine-composed empty-memory guardrail. One new type carries
both:

```ts
export interface PersonaOptions {
  // Replaces the deployment claim in the identity block. Defaults to
  // DEFAULT_DEPLOYMENT_CONTEXT. An empty string omits the claim entirely.
  deploymentContext?: string
  // Replaces the welcome and onboarding guidance shown on the very first
  // conversation. The empty-memory guardrail in that section is always
  // composed by the engine and cannot be replaced this way.
  firstConversation?: string
}
```

Threaded as an optional field at every level a host might enter from:
`buildPersona(..., options)`, `assembleSystemPrompt(..., personaOptions)`,
`AgentSessionOptions.persona`, `LiveSessionRegistryOptions.persona`, and
`ServerLaunchOptions.persona`, the last of which reaches both the registry and `dreamPersona`. You
build your own registry inside the Durable Object, so `LiveSessionRegistryOptions.persona` is your
entry point for chat and your own `dreamPersona` closure is your entry point for dreams.

Default output is byte-identical. `buildPersona` was compared against the code at `HEAD` across 48
combinations (two safety modes, four active modes, three style combinations, two resource sets), all
identical, and `assembleSystemPrompt`'s first-session output is identical at 12,896 characters. Those
captured strings are now literal `toBe` assertions rather than substring checks, so the property is
guarded going forward and not just measured once.

Verification, run by the reviewer rather than taken from the implementer's report: `pnpm build`
clean, `pnpm exec tsc --noEmit` exit 0 across all six packages, `pnpm lint` clean, and the full suite
at 1,664 tests across 81 files, all passing. The highest-stakes property was falsified by hand: with
`firstConversationSection` mutated to drop the guardrail whenever a host supplies its own opening,
exactly one test fails, the one named for that behaviour, and it passes again on restore.

### Two things to know before you write your replacement string

**One field, two grammatical registers.** `DEFAULT_DEPLOYMENT_CONTEXT` addresses the model in second
person ("You run entirely on the user's own machine"). The first-conversation welcome describes
reverie in third person, because it sits inside a sentence about what to tell the user ("reverie is
private and runs entirely on their own machine, and it remembers what they tell it"). Byte identity
for the default is preserved by special-casing the default value, which is honest but means your
replacement string has to read acceptably in both positions. Write it in second person and check how
it lands in the welcome. If that turns out to read badly, tell us and we will split it into two
fields; we would rather hear it from your copy review than guess now.

**An honest note on how it was built.** The characterization tests were not written first in the
red-green sense. The implementation was written, then compared programmatically against the code at
`HEAD` across the matrix above, then the verified-equal output was captured into permanent tests. No
assertion was written that had not been checked against the old code, so the evidence is sound, but
the order was not TDD and we are not going to describe it as though it was.

## 3. Part A, the review

The full catalogue is appendix A. This is what it adds up to.

**How it was scoped.** Not from a file list, because that reproduces the sampling problem you were
trying to escape. Your own architecture rule gives the complete inventory by construction: model
access goes only through `@openreverie/providers`. So the boundary was taken as the three methods
that send text to a model (`ChatProvider.complete`, `ChatProvider.stream`, `EmbeddingProvider.embed`)
and every production call site of those three was traced backwards to the logic that built its
`system`, `messages` and `tools`. That is 17 call sites in seven files. Nothing bypasses the provider
package: no direct `fetch`, no SDK import, no subprocess.

**What it found.** 49 distinct findings. 12 are seams, 8 belong in configuration, 28 are
engine-internal, and 1 does not classify because the code has no branching to classify. The 28 are in
the appendix on purpose, per your request, each with a reason someone can act on rather than a bare
verdict.

The findings that change your plans are in sections 1.1, 1.2, 4 and 9 of this document rather than
buried in the appendix. Three of the 49 are worth naming here because they are structural rather than
local:

- **The seam you designed cannot reach a third of the authored text.** `buildPersona` contributes
  eleven blocks. `assembleSystemPrompt` contributes fifteen more sections plus the first-conversation
  guidance, and `agent.ts` appends two greeting-only blocks on top. A block API rooted in
  `personas.ts` is a seam over part of the prompt that presents as a seam over the prompt.
- **Two functions build model-bound prose from inside `engine.ts` and a helper**, not from any file
  your list named: `buildSeedBodies` (`engine.ts:3279`) assembles the dream seed block, and
  `buildRecentDreamDigest` (`engineDreams.ts:242`) assembles the prior-dreams digest. Both arrive at
  `dreaming.ts` as opaque strings, so a reader following the prompt files alone never sees them
  built.
- **The reflection and rollup pipelines carry no persona at all**, which is the good news you were
  half expecting and worth stating plainly: they do not repeat the deployment claim, and part D did
  not need to reach them.

## 4. Part B, our positions

### B1, the shape: agreed, with the boundary drawn somewhere else

Named blocks with an optional dependency, byte-identical default output, is the right shape. It is
the shape we already chose for `dreamPersona`, and you were right to say so.

One correction to the boundary. You defined the seam over `buildPersona`. It has to be defined over
the composed system prompt, because that is the unit that reaches the model and `buildPersona` is
only part of it. `assembleSystemPrompt` (`context.ts:48`) contributes the time section, the profile,
the first-conversation guidance, and eleven memory sections, and `agent.ts` appends the greeting
instruction and the dream mention on top of that. A block API rooted in `personas.ts` covers eleven
of roughly thirty pieces of authored text and cannot see the one that broke your launch.

We are not asking you to redesign it. We are saying the union of block names belongs in one place
that spans both files, and part D already establishes that shape: `PersonaOptions` is threaded from
`AgentSessionOptions` through `assembleSystemPrompt` into both `buildPersona` and
`firstConversationSection`. Grow that type. Do not grow a second one inside `personas.ts`.

### B2, the protected set: agreed, and it needs a fourth member

`crisis-outranks-tone`, `precedence` and `crisis-stance` are the right three, and extracting the two
sentences currently buried inside style and mode is the right move. Your reasoning for why is
correct and we would not have spotted it in that form.

The fourth member is the empty-memory guardrail inside `firstConversationSection`:

> "The memory is empty right now: there is nothing to search, nothing to retrieve, no earlier session
> to reference. Do not call a memory tool looking for history that is not there. Do not tell them you
> can continue where an earlier conversation left off, or greet them as though you already know them.
> There is no earlier conversation. This is the first one."

This is not a preference. It is a true statement about engine state: the memory really is empty and
the tools really will return nothing. A host that replaced the first-conversation block wholesale and
dropped it would have the model inventing a shared history on the person's first turn. It also earns
protection by your own B2 argument, because `PRECEDENCE_SENTENCE` names "the first-conversation
guidance" as a rung in its ordering, so a host able to delete that guidance can make a protected
sentence reference something that no longer exists.

Part D ships this split already: a host replaces the welcome and the onboarding script, the engine
always composes the guardrail after it.

### B2b, a hole you did not ask about and we did not know we had

`styleSection` (`personas.ts:128`) suppresses a style axis when the active mode overrides it, so the
mode's clause can stand in its place. The suppression is computed from `modeOverrides(activeMode)`
(`modes.ts:149`), which reads the **stock** mode catalogue.

If a host replaces the `mode` block and nothing else, the engine still suppresses the stock style
paragraphs for whatever axes the stock mode declared, to make room for clauses that are no longer
present. The result is an axis with no instruction at all: not the host's, not ours. Deleting text a
host never asked to delete is a worse failure than the one B2 was written to prevent, and it is
silent.

The fix is one line of policy, and it fails closed: a host-replaced mode block suppresses nothing, so
the stock style paragraphs all render. Redundant guidance beats absent guidance, and the host can
override style too if the redundancy bothers it. This is the same correction our own `AGENTS.md`
records from 2026-08-25, where an unhandled case defaulting to admitted hid two real bugs.

### B3, our opinion, which you asked for: keep option 1, but your reason for it is wrong

We tested the empirical question rather than answering it from taste. Take a host that replaces style
and mode with a single axis-free "register" concept. `PRECEDENCE_SENTENCE` then reads, in part:

> "...the personal-register rule above, this mode, and then your configured style for every axis this
> mode does not cover."

Two independent failures, and neither is the one you predicted.

First, a dispatch failure. "For every axis this mode does not cover" is not a name, it is an
instruction with operands. It is also the **only** clause granting the style block any authority in
the ordering. Against a structure with no axes it evaluates against nothing, so the model either
discards the host's block or invents axes to satisfy the sentence. Your document says option 1 "fails
in the harmless direction: an over-broad ordering claim, not a missing one." The actual failure is a
missing grant of authority to the host's own block, which is the direction you assumed was
impossible.

Second, a name collision. "The personal-register rule above" points at a sentence inside
`CONVERSATIONAL_VOICE` (`personas.ts:37`), which your union marks overridable. A host that uses the
word "register" for its replacement block, which is a natural word to reach for, produces a
precedence sentence naming two different things by the same name.

We considered arguing this makes option 1 wrong. It does not, and here is the tiebreaker: both
failures damage the host's own block and neither touches the crisis stance. Safety is intact, and the
breakage is loud enough that you will hit it in your first hour of testing rather than in production.
So option 1 stands, for a better reason than the one you gave.

There is a fifth option, and we are not proposing it for this round, but you should know it exists:
rank by role rather than by structure. A sentence that orders "the safety stance, then any guidance
about this being a first conversation, then the voice rules, then whatever narrows this particular
session, then the standing preferences" names no axes and no block identities, so it survives any
substitution. We are not proposing it because of the conflict in the next paragraph.

**Your part H is what traps you in option 1's flaw.** Part H forbids the default output differing by
a single byte. The clean fix to B3 is rewording `PRECEDENCE_SENTENCE`, which is a default-text change
by definition. Those two constraints cannot both hold. Our recommendation is that when part B ships
you spend the bytes deliberately, in one change, with the diff reviewed by a human, rather than
inheriting a sentence that misfires against every non-stock block forever. Byte identity is the right
discipline for a mechanical refactor. It is the wrong discipline for a sentence whose job is to
describe a structure you are about to make variable.

### B5, prompt identity: agreed, and hash the right thing

Hash the **authored** surface, not the composed prompt. The composed prompt embeds the person's
memory, so its hash changes every turn and answers nothing. Hash the ordered list of
`(blockName, blockContent)` pairs for the authored blocks only, plus the resolved safety mode and
active mode, and exclude every memory section and every truncation marker. That gives you a value
that changes when and only when the instructions changed, which is the question you actually want to
answer when a cheaper model starts behaving worse.

Return it alongside the text rather than embedding it in the prompt. A version string inside the
prompt is a moving byte in the cached prefix.

### B5, budget: we will state the position plainly, and the reason is narrower than you think

`PROMPT_BUDGET_TOTAL` is not a runtime check. `budget.ts` says so ("nothing measures the finished
prompt against it") and `budget.test.ts:14` is the whole enforcement: a test over the constants. That
changes the answer to your ask.

The stated reason the persona is excluded ("authored, fixed in size, and cannot grow with use") stays
true for host blocks. A host block is authored once per deployment and does not grow with use either.
What breaks is not the reasoning, it is the enforcement: our test suite can bound our own constants
and can never see yours.

So: the budget continues not to cover the persona, we will say that in `budget.ts` in as many words,
and host-supplied blocks get a composition-time length check that throws. A host finding out at
deploy time that its block is too long is fine. A host finding out by watching a provider truncate
the system prompt is not. Deterministic, no clock, no I/O.

Separately, and this is a gap for you rather than for us: the entire budget has no configuration
surface at all. Every cap in `budget.ts` is a module constant. A hosted product with more than one
tier will want them to differ per tier and today cannot express that. We are not building it in this
round. It is in the backlog.

## 5. Part C, tool descriptions: build it, but you aimed your worry at the wrong test

Yes, build it. The need is concrete and we accept it.

Your stated cost is not the real cost. You worried about `docKinds.test.ts` keeping the
`search_memory` kinds description in sync with the `DocKind` type. That guard lives on a **nested
parameter** description (`parameters.properties.kinds.description`), not on the top-level
`description` field a per-tool override would replace, so it survives untouched. `tool-labels.test.ts`
derives tool **names**, never description content, and is unaffected by any of this.

The real drift risk is one you did not name. `set_mode` is the only one of the fourteen whose
description is computed rather than typed: it enumerates the live mode list from `MODE_NAMES`
(`tools.ts:611`). It is correct by construction today and guarded by no content test. A full replace
there silently freezes the mode list, and adding an eleventh mode would then ship a tool description
that omits it, with nothing failing. So: allow replacement for thirteen, special-case `set_mode` to
always render its live enumeration, and keep nested parameter descriptions out of scope for version
one.

For scale, since your document did not have the number: fourteen tools, 9,727 characters of top-level
description, 14,316 including nested parameter descriptions. None of it is counted by any budget.

**The part that changes your plan.** There are two tool surfaces, not one. `DREAM_TOOLS`
(`packages/memory/src/dreaming.ts:22`) is a separate array covering four overlapping tool names with
much terser prose. Compare `search_memory`: roughly 1,400 characters in `core`, versus "Search the
memory folder. Use to follow up on what the seeds raise." in `memory`. A seam keyed on
`toolDefinitions()` cannot reach it, and not by oversight: `memory` sits below `core` in the
dependency graph and cannot import it, which is the same constraint that produced the `?? ''` in
section 1.2.

That matters because of your own motive. You want this to route dreaming and similar batch work to
DeepSeek to cut cost. Dreaming is the most obvious workload to move first, and it is the one workload
the seam as scoped would miss entirely.

## 6. Part E, the iOS asks

**E1, resume and rehydration. Under-scoped, and there is a bug in front of it.**
`engine.listStoredSessions()` (`engine.ts:1744`) marks every session directory `status: 'ended'`
unconditionally, with no distinction for a session that is simply not live in this process. Combined
with `requireLive`'s fallback (`registry.ts:506`), an eviction makes every in-progress session look
permanently and incorrectly ended, today, with or without resume. Fix that first and separately: it
is small, it is a correctness bug on its own terms, and shipping resume on top of it would bake the
conflation in. Full resume after that is genuinely large and multi-package. The hard part is not the
one your document flagged: turns in flight at eviction leave no durable trace at all, so they cannot
be replayed, only retried, and that is a product decision about what the user sees, not an engine
detail.

**E2, suppress the greeting. Build it.** Verified as you described (`registry.ts:250`). We checked
the two things that could plausibly depend on a greeting existing, `firstConversationSection` and
reflection's abandoned-session check, and neither breaks. Cheap and low risk.

**E3, configurable idle timeout. Build it, as one pass rather than one constant.** Confirmed at
`registry.ts:16`. Three more hardcoded durations sit next to it: `SWEEP_INTERVAL`,
`DREAM_SWEEP_INTERVAL`, and `GREETING_TIMEOUT_MS` in `agent.ts`. You will hit each in turn. One
options object, four fields.

**E4, journaling cadence. Do not build this as scoped, and the reason is a bug.** The conversational
half already exists: `update_journaling_protocol` is a live tool. What is missing is a
screen-readable structured record. But `writeJournalingProtocol` (`journal.ts:151`) rebuilds `meta`
from scratch on every call, so any structured cadence field added there is discarded by the next
prose rewrite. Adding a cadence tool on top of that would produce a setting that silently forgets
itself. Fix the meta clobber first, then the structured field, then decide whether a second tool is
needed at all. We suspect it is not.

**E5, search endpoint. Build it, and it is smaller than you feared.** `engine.search()`
(`engine.ts:1655`) is already a clean decoupled method with no tool-call formatting entangled in it.
One wrinkle: your existing cursor and pagination convention does not fit relevance-ranked results.
Use `limit` only, no cursor.

## 7. Part F, the header field: yes to the static field, no to the per-request hook

`headers?: Record<string, string>` merged into `authHeaders`, as asked. Confirmed
`OpenAiConfig` and `authHeaders` are exactly as you described. It also solves a case you did not
mention, Azure-style deployments that need a differently named auth header.

We are declining the per-request hook, and you offered it as the better option, so here is why we
think it is the worse one. `ChatRequest` carries no per-turn identifier to key a hook on. The only
cheap way to build it today would hand the hook the full request, message content included, which
puts a host-supplied callback in a position to read the person's conversation on its way to the
provider. That is a leak surface we will not add to satisfy a need that static headers already meet.
If you later have a case static headers genuinely cannot serve, come back with it and we will design
a hook that receives a turn identifier and nothing else.

On `cf-aig-collect-log-payload` specifically: thank you for that one. A host routing through AI
Gateway without it silently storing users' prompts is the kind of default that would have quietly
made both products liars, and it is worth a line in whatever we write about hosting.

## 8. Part G, your findings, acknowledged

- **`wrangler dev` rewriting `Host`.** Taken, and recorded in `BACKLOG.md` rather than left as a
  promise in this document, so it survives this document stopping being the active one.
- **`searchSemantic` reading every embedding row into memory.** Still open, still real, still ours.
  It is in the backlog. Your 20,000 chunk target does not make it not a bug.
- **`commitMemory` running regardless of `capabilities.versioning`.** Gating inside `commitMemory`
  rather than at the seven call sites was deliberate, and we agree it is the better shape. The
  warning in results is the honest surface of that choice, not a leftover.

## 9. What you have not thought of

Six things, in rough order of how much they would cost you to discover later.

1. **Two tool surfaces.** Section 5 above. Your cheapest workload is the one the seam misses.

2. **Block overrides are not an internationalisation story, and should not be sold as one.** Your
   section 1 lists "which language the person speaks" as a host axis. A prompt-block seam lets a host
   translate the persona and nothing else. English is welded into places no block override reaches:
   `capBody` formats numbers with `toLocaleString('en-US')` inside the truncation marker
   (`budget.ts:119`), `localParts` hardcodes `'en-US'` (`time.ts:74`, and again at
   `time.ts:19` and `time.ts:97`), which is the shared formatter behind every rendered stamp, so
   English weekday abbreviations reach every transcript line of every reflection prompt, singular and plural are hardcoded
   ternaries (`context.ts:297`), booleans are rendered as the English words "yes" and "no"
   (`context.ts:387`) and "has a page" and "no page yet" (`context.ts:331`), and `PROSE_VOICE_RULE`
   (`voice.ts:15`) is an English orthography rule about em dashes and a named list of English filler
   words, spliced unconditionally into every reflection and narrative prompt and therefore written
   into the person's permanent record. `ProfileMeta` has no locale field to even express a
   preference. If you need another language, that is its own design round and a large one. Do not let
   part B make it look adjacent.

3. **The engine asserts a deployment fact in a third place, and it inverts on you.** `timeSection`
   renders a caveat when the timezone came from the system default rather than from the person
   (`context.ts`). That caveat was written for a CLI running on the person's own laptop, where the
   system zone is a decent guess about the person. On a server it is a fact about the datacentre, so
   the caveat's advice reads backwards. Not a launch blocker, but it is the same category of bug as
   the one in section 1.1 and you will meet it.

4. **Two closed catalogues with no extension seam.** `MODES` (`modes.ts:53`) and the journal method
   catalogue (`JOURNAL_FORMAT_CONTENT` and `PER_METHOD_SAFETY_NOTES` in `journaling.ts`) are both
   fixed unions. Overriding the text of the `mode` block does not let a host add an eleventh mode, and
   `set_mode` enumerates the stock list to the model regardless. If a host ever wants its own mode,
   that is a different piece of work from part B and part B will look like it should have covered it.

5. **`PROSE_VOICE_RULE` is duplicated and has already diverged.** `DAILY_ROLLUP_PROMPT` and
   `WEEKLY_ROLLUP_PROMPT` (`rollups.ts:154`) reimplement a fragment of it as their own four-word
   clause instead of importing `voice.ts`, the two copies no longer say the same thing, and
   `rollups.test.ts` has no assertion on that text at all. That is our bug, not a seam question, and
   it is the one place in the review where two prompts that should agree do not.

6. **The US-centric crisis defaults fail silently per tenant, which is different from the problem you
   named.** You noted the defaults in `config.ts` are US-centric and that someone abroad cannot change
   the surrounding prose. The sharper version for you: `defaultCrisisResources` (`config.ts:25`)
   supplies the 988 lifeline and findahelpline.com whenever `safety.resources` is unset. On a
   single-user CLI, unset means one person sees the wrong hotline. On a multi-tenant host, unset is
   the default state of every new tenant, so forgetting to set it per tenant ships US-only crisis
   numbers to people who are not in the US, with nothing failing and nothing logged. Whatever you
   build for tenant provisioning should treat an unset resource list as an error rather than as a
   default, and that is a decision on your side of the seam, not ours.

   One implementation note if you build your own substitution anywhere near this: the engine passes a
   replacer **function** into `String.prototype.replace` (`personas.ts:78`) rather than a string,
   deliberately, because resource text is user-editable and a plain string replacement interprets
   `$&`, `$1` and `$$` as patterns. A host reimplementing this with a string replacement introduces a
   silent corruption bug in crisis resources specifically.

7. **Your part H and your B3 cannot both hold.** Section 4, B3 above. Worth deciding on purpose
   before it decides itself.

## 10. Sequencing, ours

We agree with yours except at the front. Part D is done and is in this change. Then:

1. The three defects, because they are cheap and two of them are live for you now: the `dreamPersona`
   fallback, `listStoredSessions` marking everything ended, and the `writeJournalingProtocol` meta
   clobber.
2. E2 and E3 together, small.
3. Part B, with B2b and the fourth protected block folded in, and B3 settled including the part H
   question.
4. F, small, any time.
5. E1 proper, after its bug is fixed.
6. C, with both tool surfaces in scope, and E5.

---

# Appendix A. The part A catalogue


This review was scoped from the model boundary inward, not from a file list. `packages/providers/src/types.ts` defines exactly three methods that send text to a model: `ChatProvider.complete`, `ChatProvider.stream`, and `EmbeddingProvider.embed`. Every production call site of those three methods was located and traced back to the logic that built its `system`, `messages`, and `tools` fields. That trace found 17 production call sites: 11 `chat.complete`, 2 `chat.stream`, 4 `embeddings.embed`. They live in seven files: `packages/memory/src/dreaming.ts` (5 sites: lines 134, 307, 326, 601, 652), `packages/memory/src/reflection.ts` (4 sites: lines 619, 639, 885, 902), `packages/memory/src/rollups.ts` (2 sites: lines 188, 222), `packages/core/src/agent.ts` (2 sites: lines 350, 406), `packages/memory/src/engine.ts` (2 sites: lines 2203, 2274, both `embed`), `packages/memory/src/retrieval.ts` (1 site: line 155, `embed`), and `packages/memory/src/retrievalEval.ts` (1 site: line 111, `embed`). No call bypasses `@openreverie/providers`: no direct `fetch`, SDK import, or subprocess model invocation was found anywhere outside it, and `packages/server` and `packages/cli` reach the model only through `AgentSession` and the memory package's pipeline functions, never directly.

What follows is 49 distinct findings about the logic that builds the text these 17 call sites send, organized by pipeline. They break down as 12 seam (a real host-variation need exists and no override point does, the seam exists but is defective, or the seam was needed and has since been built, one case, fixed mid-review), 8 config (a host-variation need exists and belongs in the existing config surface, whether or not it is wired there yet), 28 engine-internal (no legitimate host-variation need was found, kept for completeness since an explicit "engine-internal and here is why" is itself useful output), and 1 that fits none of the three cleanly, a pair of fixed rollup prompts with no branching logic at all to classify, flagged instead for what they lack. A separate closing section lists five defects the six reviews found that are bugs regardless of whether any hosting seam is ever built.

## Chat and greeting

### 1. PRECEDENCE_SENTENCE names structures a host replacement could remove (`packages/core/src/personas.ts:142`, appended at `personas.ts:153`)
- **What varies:** nothing today. This fixed sentence ("When these instructions and your configured style disagree, this order decides...") is appended unconditionally inside `modeSection` for every mode except `general`.
- **What decides it:** whether `modeSection` returns a value at all, i.e. whether the active mode is not `general`.
- **Host need:** no for the sentence's own wording, but it is a hard constraint on any future seam for the style or mode blocks it describes.
- **Verdict:** engine-internal.
- **Why:** the sentence is a dispatch instruction the model executes, not descriptive prose it can read past. It names "the personal-register rule above" (a specific paragraph in `CONVERSATIONAL_VOICE`, `personas.ts:37`), "the safety mode's crisis stance below" (depends on the crisis-section-last invariant tested at `personas.test.ts:493`), and "the first-conversation guidance" (a block owned by a different file, `context.ts`, rendered only conditionally). A constructed example was worked through: a host replacing the style block with a single "register" axis and the mode block with unstructured text produces two concrete, non-hypothetical failures, not vague ones. First, a name collision: the host's new block, if it uses the word "register" (the natural word for that concept), collides with the existing, unrelated "personal-register rule," and a model resolving the ambiguity has no principled way to pick the right one, silently misdirecting a safety-adjacent rule. Second, "for every axis this mode does not cover" presupposes a specific coverage mechanism (a mode's `clauses` cover some subset of an enumerable axis set) that no longer exists in the replacement, forcing the model into one of two wrong readings: silently discard the host's entire block, or invent axes nobody declared. This sentence cannot be treated as safe boilerplate while replacing the blocks it describes; it is coupled to their exact internal shape, not just their topic.
- **Hazard:** any host seam built for `styleSection` or `modeSection` (see items 4 and 6 below) must either preserve the axis-enumeration/per-axis-coverage shape this sentence depends on, or rewrite the sentence itself as part of the same change. Leaving it in place while replacing what it describes produces active misdirection, not graceful degradation.

### 2. Crisis-resource default is US-centric, and the substitution technique is load-bearing (`packages/core/src/personas.ts:69-84`; default at `config.ts:25-28`)
- **What varies:** a bullet list of configured crisis resources, or, when none are configured, the fixed sentence stating none are set up and to still urge real local emergency help. The template itself (`COMPANION_CRISIS_STANCE` vs `FIREWALL_CRISIS_STANCE`) is chosen by `config.safety.mode`.
- **What decides it:** `config.safety.resources` and `config.safety.mode`. When `safety.resources` is unset, `defaultCrisisResources` (`config.ts:25-28`) supplies `988 Suicide and Crisis Lifeline (US)` and `findahelpline.com`.
- **Host need:** yes, concretely. A host onboarding a tenant outside the US who never sets `safety.resources` per tenant ships US-only numbers to someone who may not be in the US, silently.
- **Verdict:** config for the resource list itself (already a working seam); the empty-list fallback sentence's own wording is engine-internal and already locale-neutral.
- **Why:** the mechanism for varying resources already exists and works. The actual gap is the default value shipped when a host forgets to set it per tenant, not the logic.
- **Hazard:** the substitution into the crisis template uses a replacer function (`personas.ts:78-82`), specifically to avoid `String.prototype.replace`'s `$&`/`$1`/`$$` special-pattern interpretation. Any host code building its own crisis-resource substitution into a different template must replicate this function-replacer pattern, not a plain string replace, or a resource's own text containing a dollar sign becomes a silent substitution bug. The two crisis-stance templates themselves are engine-internal by explicit project policy (AGENTS.md: both safety modes "exist by design... never remove, weaken, or bypass them").

### 3. Style axis paragraphs are hardcoded English prose with zero override point (`packages/core/src/personas.ts:86-120`)
- **What varies:** one full paragraph of fixed English prose per enum value across three axes (3 engagement, 5 tone, 3 orientation values, 11 paragraphs total).
- **What decides it:** `StyleConfig.engagement`/`.tone`/`.orientation`, user-set enum values stored in `profile.md`.
- **Host need:** yes. A host running the same tenant against a different model family sometimes needs axis instructions phrased differently for a weaker model to actually follow them, or wants the wording localized.
- **Verdict:** seam.
- **Why:** the choice of which enum value is active is already config; the rendering of that choice into prose is hardcoded per value with no override point today. There is no way to change what "Your configured tone is warm: ..." says without editing the constant.
- **Hazard:** the exact wording here is what `CRISIS_OUTRANKS_TONE` (`personas.ts:122`) and PRECEDENCE_SENTENCE (item 1) both refer to indirectly. `CRISIS_OUTRANKS_TONE` names "Tone, engagement, orientation, and mode" by name in its own sentence; a host replacement that no longer has these four named concepts breaks that sentence the same way PRECEDENCE_SENTENCE breaks under a register replacement.

### 4. Mode catalogue is a closed 10-value union with no addition point (`packages/core/src/personas.ts:144-154`; `packages/core/src/modes.ts:19-29, 53-141`)
- **What varies:** one of 10 possible mode paragraphs, or `undefined` (section omitted) for `general`.
- **What decides it:** `activeMode: ModeName`, a closed TypeScript union, and the `MODES` record.
- **Host need:** yes, concretely. A host wanting a tenant-specific or product-tier-specific mode (an enterprise "coaching mode," for example) cannot add one without editing this file, since `ModeName` is a closed union and `MODES` a literal record.
- **Verdict:** seam, for the ability to add a mode. The 10 existing modes' specific text stays engine-internal (core product design, tightly wired to the mode/style precedence machinery in item 1).
- **Why:** the closed union blocks any extension short of a code change, and the same shape gap propagates to `modeOverrides` (`modes.ts:149-151`, derives suppressed style axes from `Object.keys(MODES[mode].clauses)`, same closed-catalogue issue, not an independent one) and to `modeParagraph`'s fixed clause ordering (`modes.ts:156-164`, independently tested and with no legitimate variation case found).
- **Hazard:** any new mode a host wanted to add would also have to fit the same `clauses: Partial<Record<StyleAxis,...>>` shape, or `modeOverrides`, `styleSection`, and PRECEDENCE_SENTENCE all silently stop making sense for it.

### 5. `buildPersona`'s section assembly has zero insertion point for host content (`packages/core/src/personas.ts:156-180`)
- **What varies:** which of 11 candidate sections are present; the final order is a fixed literal array, with the crisis section pinned last as a tested invariant (`personas.test.ts:493`).
- **What decides it:** the literal array order at `personas.ts:166-177`.
- **Host need:** no legitimate need to reorder was found, since the ordering carries real meaning (an override paragraph appended after the crisis stance would read as amending it).
- **Verdict:** engine-internal, with the crisis-last invariant as the reason.
- **Why:** the ordering is tested and load-bearing, not incidental.
- **Hazard:** this is the sharper finding: the top-level assembly function has no supported extension point for host content at all, not a seam, not a config field. A host wanting to add a deployment banner or jurisdiction notice would have to fork this function or splice into its array directly. Separately, `personas.ts` alone does not show all persona text: `JOURNALING_PROTOCOL_ABSENT` and `PROSE_VOICE_RULE` (both imported from `@openreverie/memory`, spliced at `personas.ts:174` for the latter) are rendered directly into the persona without appearing in this file's own constants; see the Shared Helpers and Reflection sections for `PROSE_VOICE_RULE` specifically.

### 6. Timezone "system default" caveat inverts meaning between self-hosted and hosted deployment (`packages/core/src/context.ts:110-125`)
- **What varies:** whether the paragraph "This timezone is a system default, not yet confirmed by the person..." is appended.
- **What decides it:** `context.timezoneSource === 'system-default'`.
- **Host need:** yes, and this is a semantic inversion, not a phrasing gap. In the self-hosted CLI, "system default" means the person's own machine's clock, a reasonable fallback. On a multi-tenant hosted server, "system default" means the container/server's timezone, unrelated to where the person is.
- **Verdict:** seam.
- **Why:** the same code path needs materially different framing depending on what "system default" means in the deployment, not just different wording. The literal sentence stays true either way, but the implicit reasoning a model applies ("the system default is probably close, just double check") is sound on the CLI and backwards on a host, where the default could be many hours off, and nothing in the code marks the distinction.

### 7. Tool names hardcoded into chat-prompt prose, with no compile-time link to `tools.ts` (`packages/core/src/context.ts` and `budget.ts`, multiple sites; `packages/core/src/journaling.ts:117`)
- **What varies:** whether a "(showing X of Y, call `<tool>` for the rest)" marker or an inline mention names a specific tool, based on truncation state or fixed guidance text.
- **What decides it:** independent string literals in each section, with no shared constant linking them to the real tool definitions.
- **Host need:** only if a host renamed, removed, or replaced a tool (a different retrieval mechanism, a restricted tool surface for a lower tier).
- **Verdict:** engine-internal for whether to show a marker at all; the specific tool-name literals are a real, host-independent drift hazard that exists today with no host involved.
- **Why:** nothing enforces that these strings match the real tool names in `tools.ts`; a future rename silently breaks the prose with no compiler or test signal unless a test happens to string-match it. Call sites, all verified: `realmsSection` (`context.ts:144-159`, marker at 154-156, names `list_realms`), `arcsSection` (161-176, marker at 170-174, names `list_arcs`), `peopleSection` (271-288, marker at 278-286, names `list_people`), `entitiesSection` (290-301, marker at 295-299, names `list_entities`), `dreamsSection`'s truncation marker (186-212, marker at 193-201, names `search_memory`) and its always-rendered preamble (204-209, names `dream_feedback`, not inside a truncation marker so easy to miss on a marker-only sweep), `rollupsAvailableSection` (221-256, line 253, names `read_document`), and `journaling.ts:117` (`update_journaling_protocol`, feeds `modeSection`, so it reaches the chat prompt too).
- **Hazard:** `capBody` (`budget.ts:107-123`, lines 118-121) independently hardcodes the same `read_document` mention, shared by three sections (`constitutionSection`, `latestDailyRollupSection`, `recentSummariesSection`). That concentration is favorable if a seam is ever built (fix one place, not three), but today it just means a tool rename has to be fixed in `context.ts`, `journaling.ts`, and `budget.ts` independently, none of which would fail loudly.

### 8. No i18n seam exists anywhere in the chat prompt path (`packages/core/src/context.ts:221-256, 271-288, 303-346`)
- **What varies:** singular vs. plural English words via boolean/count ternaries: "day" vs. "days" (`context.ts:297`, driven by `context.dailyRollups.total === 1`), "has a page" vs. "no page yet" (`context.ts:331`), "yes" vs. "no" for `Birthday greetings` (`context.ts:387`).
- **What decides it:** plain booleans and counts from memory-engine state, each rendered through a hardcoded English ternary or template literal.
- **Host need:** yes, squarely. "Different language" is one of the review's own examples of legitimate host variation, and English singular/plural via a ternary is exactly the shape that breaks for languages with more than two plural forms, or none.
- **Verdict:** seam.
- **Why:** every place English vs. non-English varies in this scope is a hardcoded ternary or template literal, never a lookup through anything a host could swap. `ProfileMeta` has a `timezone` field but no locale or language field at all, so even a host that wanted to fix this per-user has nowhere to read the preference from today.
- **Hazard:** in `rollupsAvailableSection`, the escape-hatch sentence telling the model how to read a truncated rollup list is deliberately appended after `capRows` truncates the rows above it (comment at `context.ts:245-249`), specifically so a full twelve-week index cannot eat the one sentence that makes the docIds usable. Any i18n or "compact tier" restructuring of this section has to preserve that ordering deliberately, or the section silently regresses to giving docIds with no instructions for using them.

### 9. Journal method catalogue is closed, with no gate to add or restrict a method (`packages/core/src/journaling.ts:117, 166-191`)
- **What varies:** nothing in content across sessions; `renderPerMethodSafetyNotes` always renders exactly six lines, one per `JournalMethod` value, regardless of which method the person actually has configured, a deliberate defensive choice documented at `journaling.ts:166-172` because the module has no reliable signal for which method is active at persona-assembly time.
- **What decides it:** `Object.keys(JOURNAL_FORMAT_CONTENT)` and the parallel `PER_METHOD_SAFETY_NOTES` table, both `Record<JournalMethod, ...>` imported as a closed type from `@openreverie/memory`.
- **Host need:** yes. A host might want to add a proprietary journal method, or restrict which of the six are offered (a clinical partnership excluding `morning_pages`/`open` in favor of clinician-endorsed formats).
- **Verdict:** seam, for the ability to add or restrict methods. The six methods' specific evidence text stays engine-internal by explicit design intent (`journaling.ts:1-7`: "a method with thin or absent evidence reads as thin or absent here, not borrowed weight from a better-studied one"), since this is safety/accuracy-adjacent text a host should not be free to reword.
- **Why:** both tables are fully closed with no config gate.
- **Hazard:** `FIRST_TIME_SETUP_GUIDANCE` (`journaling.ts:117`) hardcodes a specific default recommendation ("the examen is the reasonable default...") and enumerates the six-method catalogue by name. If a host restricts the catalogue, this guidance goes stale in lockstep and needs updating together, not independently.

### 10. `renderResources` fallback wording, `crisisSection` mode dispatch, `styleSection` axis suppression, and `modeParagraph` clause ordering (`packages/core/src/personas.ts:76-84, 128-140`; `packages/core/src/modes.ts:156-164`)
- **What varies:** whether `styleSection` includes the engagement and/or orientation paragraphs, based on `modeOverrides(activeMode)`; the tone paragraph and `CRISIS_OUTRANKS_TONE` are always included; `modeParagraph` joins 0-3 parts (orientation clause, engagement clause, body) in a fixed order.
- **What decides it:** the active mode's `clauses` shape in the `MODES` table.
- **Host need:** low for the mechanism itself; a host wanting a genuinely different axis model would need to bypass this structurally (see item 1's register example).
- **Verdict:** engine-internal.
- **Why:** `CRISIS_OUTRANKS_TONE` is safety doctrine interleaved into `styleSection`; splitting it out to a host seam risks a host silently weakening it. `modeParagraph`'s ordering is independently tested ("renders the orientation clause before the engagement clause," `modes.test.ts:89`) with no legitimate variation case found.
- **Hazard:** same underlying hazard as item 1, in a second, easy-to-miss location: `CRISIS_OUTRANKS_TONE` names "Tone, engagement, orientation, and mode" by name, so a host style replacement without these four named concepts breaks this sentence too.

### 11. `profileSection`'s fixed field order and silent-drop-if-unset design (`packages/core/src/context.ts:303-346`)
- **What varies:** which of seven fields render, one per line, in fixed order; unset means no line at all, never "unknown," an explicit design choice (comment at 303-310) that also excludes timezone deliberately to avoid drift with the Time section.
- **What decides it:** `Profile.meta` field presence.
- **Host need:** no.
- **Verdict:** engine-internal.
- **Why:** field presence is already fully data-driven; the ordering choice is explicitly justified against a duplication risk elsewhere, verified as designed with no host-variation need found.

### 12. `GREETING_INSTRUCTION` + `DREAM_MENTION_GUIDANCE` gated on a hardcoded mode literal (`packages/core/src/agent.ts:344-348`)
- **What varies:** whether `DREAM_MENTION_GUIDANCE` is appended to the greeting instruction.
- **What decides it:** `this.freshDream` is set, and `this.activeMode !== 'decompress'`, a hardcoded literal string comparison.
- **Host need:** no direct need, but the pattern generalizes badly.
- **Verdict:** engine-internal.
- **Why:** `ModeName` is a closed union, so a rename of `'decompress'` is caught at compile time; this is not a silent-breakage risk today.
- **Hazard:** this is a second, separate place (outside `modes.ts`) encoding "decompress means hold back on proactive content." Any future mode with the same semantics needs this literal check duplicated here, since there is no table-driven way to declare that property on a mode.

### 13. Mid-turn system-prompt refresh gated on literal tool-name comparisons (`packages/core/src/agent.ts:482-489, 496-498`)
- **What varies:** whether `this.system` is reassembled mid-turn, via two `if (toolCall.name === '...')` checks for `update_profile` and `update_journaling_protocol`.
- **What decides it:** hardcoded tool-name string literals, matched independently of `tools.ts`.
- **Host need:** yes, if a host adds a tool whose effects should also feed back into persona-relevant state (a hypothetical safety-mode-switching tool, for example).
- **Verdict:** engine-internal, config-adjacent gap. This does not itself produce prompt text, but it gates when prompt-building logic elsewhere in this catalogue actually re-runs.
- **Why:** there is no table or declared property near a tool's own definition saying "this tool's success should trigger a system-prompt refresh," just two ad hoc checks disconnected from `tools.ts`.
- **Hazard:** any future tool, host-added or not, that changes persona-relevant state must remember to add itself to these two checks by literal string match, or the prompt silently goes stale for the rest of that session with no error, no test failure, and no warning.

## First conversation

### 14. Deployment/privacy claim in the first-conversation welcome, fixed mid-review (`packages/core/src/context.ts:169-178`; `packages/core/src/personas.ts:17, 56-59, 202, 208`)
- **What varies:** originally, nothing: `firstConversationSection` was a fixed template asserting "reverie is private and runs entirely on their own machine, and it remembers what they tell it..." to the person's first message, gated only on `context.isFirstSession`. A fix for this landed in `packages/core/src/personas.ts` while this specific report was being written; the reviewer confirmed the post-landing state directly rather than reporting on the pre-landing state.
- **What decides it:** `context.isFirstSession` for whether the section renders at all; as of the landed fix, also `PersonaOptions.deploymentContext`/`.firstConversation` for its content. `personas.ts` now exports `PersonaOptions` (`{ deploymentContext?: string; firstConversation?: string }`), `DEFAULT_DEPLOYMENT_CONTEXT` (the exact old sentence, unchanged), and `resolveDeploymentContext(options)`. `WHAT_REVERIE_IS` became `whatReverieIs(deploymentContext)` (`personas.ts:56-59`). `buildPersona` takes the new options parameter (`personas.ts:202`, resolved at 208). `context.ts` threads `personaOptions` through `assembleSystemPrompt` (`context.ts:63`) into both `buildPersona` (73) and a parallel `firstConversationSection(deploymentContext, personaOptions.firstConversation)` (81-84); if a host supplies `firstConversation`, it replaces the whole opening, otherwise `defaultFirstConversationOpening(deploymentContext)` builds it. A new `FIRST_CONVERSATION_GUARDRAIL` constant (`context.ts:139-147`) is deliberately not overridable by a host's `firstConversation` string. `agent.ts` adds `persona?: PersonaOptions` to `AgentSessionOptions` (`agent.ts:59`) and threads it into all four `assembleSystemPrompt` call sites.
- **Host need:** yes, this was the single most concrete host-variation need found across the whole review. This exact claim, asserted as fact to a person on their very first message, is untrue for a hosted deployment.
- **Verdict:** was seam-needed; now built as a seam. Assessed as sound: it correctly parameterizes the claim in both places it existed (the always-on `WHAT_REVERIE_IS`, every session, and the first-conversation welcome sentence, first session only) from one resolved value, rather than fixing only the more visible, less consequential instance.
- **Why:** `FIRST_CONVERSATION_GUARDRAIL`'s own comment explicitly names why it stays non-overridable: it names "this guidance" in the same sentence PRECEDENCE_SENTENCE (item 1) refers to by that name, so a host cannot make the thing the precedence sentence points at disappear.
- **Hazard:** one narrow, non-blocking edge case remains: `firstConversationOpeningClause` (`context.ts:118-127`) branches on `deploymentContext === DEFAULT_DEPLOYMENT_CONTEXT` by value equality rather than on whether a host actually supplied an override. Since `resolveDeploymentContext` already collapses "omitted" into the default string before this function sees it, there is no behavioral gap in practice, but a host that happened to pass back the literal default string as its own "override" would silently get the specialized wording rather than the fallback path. A very narrow edge case, not a real hazard as written.

### 15. `assembleSystemPrompt`'s first-session branch replaces the whole section list (`packages/core/src/context.ts:69-93`)
- **What varies:** whether the full memory-snapshot section list renders, or is replaced entirely by just `firstConversationSection()`.
- **What decides it:** `context.isFirstSession`.
- **Host need:** no, this is the mechanism, not the content (see item 14 for the content that actually varies).
- **Verdict:** engine-internal.
- **Why:** verified as described, a clean binary branch with no host-variation need of its own.

## Reflection

Two hazards this review was explicitly asked to check for turned out not to exist in reflection or rollups: neither pipeline imports `buildPersona` or repeats any "runs on your own machine / no analytics" language anywhere (grepped directly, only hits are unrelated code comments), and neither pipeline carries a persona at all, companion or firewall. `EngineDeps.dreamPersona` is never referenced from `_doEndSession`, `buildReflectionContext`, or the rollup loop. Separately, no schema in the codebase uses zod's `.describe()`, and there is no `zod-to-json-schema` dependency, so no schema's field descriptions leak into a prompt anywhere in reflection or rollups; the JSON shape shown to the model is a hand-written string kept in sync by hand.

### 16. `PROSE_VOICE_RULE` is spliced unconditionally into every piece of stored prose these pipelines produce (`packages/memory/src/voice.ts:15-18`; imported at `reflection.ts:58`, spliced at `reflection.ts:576-578` and `869-871`)
- **What varies:** nothing conditionally. The same fixed English style rule (no em dash, vary sentence length, no rhetorical triads, no "it's not just X, it's Y," a named list of filler words to avoid) is joined verbatim into every prose-producing prompt in scope.
- **What decides it:** a straight import and string join, no branch.
- **Host need:** yes, concretely. This is not a safety or privacy rule, it is one author's stylistic taste, and it is written permanently into the person's stored record (item text, session summaries, arc/person narratives, commitment glosses, constitution updates) for every user of every deployment. A host serving a tenant that wants a more formal or clinical register, or a non-English deployment where "avoid the em dash" is meaningless, has no way to vary it short of forking the string.
- **Verdict:** seam.
- **Why:** this is the clearest case in the whole review of a tenant-policy-needing-different-phrasing situation, applied to permanently stored prose rather than a spoken chat reply, which makes its reach broader than a chat voice seam would be.
- **Hazard:** this same rule is spliced into `personas.ts:174` (chat, spoken conversation only) and into `dreaming.ts:372` (`DREAM_INSIGHTS_INSTRUCTION`) and `dreaming.ts:397` (`narrativeInstruction`), for every dream, in every mode, with no opt-out. Separately, and worse: `rollups.ts:154-158` (`DAILY_ROLLUP_PROMPT`/`WEEKLY_ROLLUP_PROMPT`) does not import `PROSE_VOICE_RULE` at all. It reimplements a one-clause fragment of it inline ("Plain prose, no headings, no em dashes") that has already drifted from the five-paragraph rule in `voice.ts`, and carries no test coverage; see the Defects section at the end of this catalogue for that specific bug.

### 17. Hardcoded `en-US` locale reaches every reflection prompt for every user (`packages/memory/src/time.ts:73-94, 149-165`, locale literal at `time.ts:74`; also `packages/core/src/budget.ts:107-123`, lines 119-120)
- **What varies:** the per-line transcript stamp prefix (`renderTranscript`/`renderStoredStamp`, `reflection.ts:483-489`): `[Weekday YYYY-MM-DD HH:MM UTC±offset]` when the line carries a recorded offset, or a raw-ISO fallback when it does not. The weekday abbreviation ("Mon," "Tue," ...) is always English, rendered through `Intl.DateTimeFormat('en-US', ...)` inside the `localParts` helper.
- **What decides it:** each transcript line's own `utcOffsetMinutes` (recorded when written) for which branch renders; the hardcoded `'en-US'` locale for the weekday text itself, unconditional.
- **Host need:** yes. A deployment serving non-English-speaking users has every transcript line, in every reflection prompt, showing English weekday abbreviations permanently, with no way to change it short of editing `time.ts`, and `ProfileMeta` has a `timezone` field but no locale or language field at all to read a preference from even if a host wanted to fix this per person.
- **Verdict:** seam.
- **Why:** the date field itself renders `YYYY-MM-DD` (not `MM/DD/YYYY`), so there is no US date-order bug, but the weekday name is English-only with no config path anywhere in this scope to change it. This is the one place a locale assumption measurably touches every reflection prompt for every user.
- **Hazard:** `capBody` (`budget.ts:107-123`) independently hardcodes two more `.toLocaleString('en-US')` calls (lines 119-120) formatting character counts into the chat prompt's truncation markers, a lower-stakes second instance of the same assumption since that text is model-facing, not person-facing.

### 18. `renderListing` for known arcs and realms is uncapped (`packages/memory/src/reflection.ts:430-441`, called at `reflection.ts:523-527`; cap comment at `engine.ts:512-514`)
- **What varies:** the list of `- id: label` lines for arcs and realms, entirely uncapped, unlike the chat prompt's arcs section (`ARCS_CAP = 30`, `engine.ts:515`).
- **What decides it:** `context.arcs`/`context.realms`, passed through by `buildReflectionContext` (`engine.ts:2226-2227`) with no truncation logic at all, a deliberate choice per the comment ("arcs are listed there by id and label only, which stays short").
- **Host need:** marginally. A very long-lived, arc-heavy account could grow this section unbounded over years, a cost/context-window concern a hosted deployment might care about more than a self-hosted one on a local or free model.
- **Verdict:** engine-internal today (no logic branches on host identity), but the absence of a cap is asymmetric with the capped people/entities case and worth a host operator knowing about explicitly.
- **Why:** no branch exists to classify as a seam; this is a design gap, not a variation point.
- **Hazard:** unbounded growth of the reflection prompt's arcs/realms section for very active, long-lived accounts, with nothing enforcing a ceiling.

### 19. Entity list cap (`packages/memory/src/reflection.ts:430-441`, called at `reflection.ts:532-533`; `ENTITIES_CAP = 30` at `engine.ts:508`, `capEntities` at `engine.ts:3466-3469`)
- **What varies:** the entity-line list, plus a truncation marker (not stating the actual cap number) when the cap is exceeded, ordered most-recently-created first.
- **What decides it:** `capEntities` against the hardcoded module constant `ENTITIES_CAP`.
- **Host need:** yes, concretely. A hosted tier serving a paying customer with a larger model context budget, or a free tier wanting a tighter cap for cost control, is a plausible, real scenario.
- **Verdict:** config, a hardcoded module constant today, not exposed through `EngineDeps` or any config surface, but conceptually a clean host-configurable knob with no safety or identity implications.
- **Why:** this is a numeric cost/context-size knob, exactly the kind of thing hosting operators commonly want to tune per tenant or plan.
- **Hazard:** the truncation marker never states the actual cap number to the model. Not a bug today, but worth knowing if the cap ever becomes configurable: the model-visible text does not need to change to match.

### 20. People list cap and paged-first survivorship (`packages/memory/src/reflection.ts:448-461`, called at `reflection.ts:529-530`; `PEOPLE_CAP = 40` at `engine.ts:507`, `capPeople` at `engine.ts:3453-3461`)
- **What varies:** the `- id: label (has a page / no page yet)` list, plus a truncation marker describing the survivorship rule when truncated: paged people survive first (their doc already exists, so losing them from view is more costly), then most-recently-created unpaged people; render order is always recency, never grouped by page status.
- **What decides it:** `capPeople` against `PEOPLE_CAP`.
- **Host need:** yes, same reasoning as entities above.
- **Verdict:** config for the cap value; engine-internal for the paged-first survivorship policy itself, a correctness decision protecting against silently losing a maintained document from view, not something a host would want to vary by tenant.
- **Why:** the cap number is a cost knob; the survivorship rule is a quality guarantee.
- **Hazard:** same cap-not-stated-numerically point as item 19.

### 21. Commitment listing deliberately suppresses bracket and gloss (`packages/memory/src/reflection.ts:469-475`, called at `reflection.ts:535-536`)
- **What varies:** the `- id: label (flavor, state)` line for every commitment, uncapped, but never the internal scheduling `bracket` or the person-facing `gloss`.
- **What decides it:** `context.commitments`, with the bracket/gloss suppression unconditional.
- **Host need:** no.
- **Verdict:** engine-internal.
- **Why:** the comment at `reflection.ts:463-468` states the reasoning precisely: the spec's "the bracket selects, the gloss speaks" rule means the internal-only scheduling bracket and the gloss must never reach a model that could echo them back into a summary or reply. This is a suppression decision protecting an invariant, not a stylistic choice.
- **Hazard:** the live chat prompt (`sessionContext`, `engine.ts:1503-1505`, outside this review's scope) does surface `timing.interpretation.gloss` to the companion model for conversational purposes. Not a contradiction, since it is a different consumer for a different purpose, but a host auditing "does gloss ever reach a model" needs to check two different files, with no single flag to consult.

### 22. `renderProfile` field substitution (`packages/memory/src/reflection.ts:407-424`, called at `reflection.ts:521`)
- **What varies:** which of seven fixed fields (preferredName, pronouns, location, timezone, birthday, occupation, birthdayGreetings) appear, and their values; falls back to a fixed "(nothing recorded yet)" sentence when none are set.
- **What decides it:** `context.profile`, the person's own stored data.
- **Host need:** no. This is per-user data substitution, not a deployment axis.
- **Verdict:** engine-internal.
- **Why:** exactly what reflection needs to see to avoid re-asking for known facts, with no deployment concern here.

### 23. Journaling-protocol absence fallback (`packages/memory/src/reflection.ts:538-539`)
- **What varies:** whether the actual protocol text or a fixed English fallback sentence appears.
- **What decides it:** whether `readJournalingProtocolIfPresent` found a `journaling.md` file.
- **Host need:** no.
- **Verdict:** engine-internal.
- **Why:** ordinary presence/absence substitution with no policy content.

### 24. `buildNarrativeRewritePrompt`'s item-list rendering (`packages/memory/src/reflection.ts:845-876`, specifically line 862)
- **What varies:** whether the model sees the actual attributed item texts or a fixed `(none)` fallback.
- **What decides it:** whether `resolveNarratives` found any items attributed to the arc via `out.attributions`; always empty for person updates, by design, since there is no equivalent concept for people.
- **Host need:** no.
- **Verdict:** engine-internal.
- **Why:** ordinary conditional substitution with no policy content.

### 25. `resolveNarratives`'s gate on whether a pass-two model call happens at all (`packages/memory/src/reflection.ts:933-1004`)
- **What varies:** whether `rewriteNarrative` (a second model call per touched arc/person) fires for a given update.
- **What decides it:** node type match (arc/person), whether the node has a doc, and a same-session dedup check against nodes reflection just created fresh in pass one.
- **Host need:** no, this is correctness/dedup logic protecting against double-writes and dangling ids, not a policy axis.
- **Verdict:** engine-internal.
- **Why:** protects against double-writing something reflection just created in the same run.
- **Hazard:** a thrown error inside this loop (from `readDocument` or `chat.complete`) is caught and the document is silently left untouched, surfaced only through an optional `onFailure` callback (comment at `reflection.ts:918-931`: "a caller must not treat the absence of an onFailure call as the absence of a failure"). Not a host-variation concern, but a hosting operator should know pass-two narrative rewrites can silently no-op under provider errors, with the only trace a `this.warnings` entry (`engine.ts:1096-1100`) a caller could clear before ever reading.

## Rollups

The same absence of a privacy claim and a persona applies here as in reflection (see the note at the top of the Reflection section); neither `DAILY_ROLLUP_PROMPT` nor `WEEKLY_ROLLUP_PROMPT` references `buildPersona` or any deployment claim.

### 26. Rollup prompts are two fixed strings with no date grounding and a divergent style-rule fragment (`packages/memory/src/rollups.ts:154-158`)
- **What varies:** nothing. `DAILY_ROLLUP_PROMPT`/`WEEKLY_ROLLUP_PROMPT` are used unconditionally as the `system` prompt for `buildDailyRollup`/`buildWeeklyRollup`, regardless of date, person, or anything else.
- **What decides it:** nothing, there is no branch here.
- **Host need:** same reasoning as `PROSE_VOICE_RULE` (item 16) for the voice fragment specifically: a host wanting a different register or a non-English deployment has no path to change it.
- **Verdict:** not a seam/config/engine-internal question in the strict sense, since there is no logic to classify, flagged instead because of what it lacks.
- **Why:** neither prompt states the actual date or week being summarized. The model is asked to synthesize "this day" or "this week" with no date grounding at all, relying entirely on the summary/daily bodies handed to it for temporal content. The date that decides which summaries go in is used only for filtering (`session.date === date`), never rendered into the prompt.
- **Hazard:** the rollup prompts' own inline style fragment ("Plain prose, no headings, no em dashes") is a one-clause reimplementation of `PROSE_VOICE_RULE`, not an import of it, and has drifted from the five-paragraph rule in `voice.ts` with zero test coverage. See the Defects section for this specific bug.

## Dreaming

### 27. `dreamPersona` degrades silently to an empty system prompt when a host omits it (`packages/memory/src/engine.ts:3173`)
- **What varies:** the entire system prompt for every model call a dream makes: exploration, insights, narrative (plus optional retry), tone check (plus optional retry). Everything from "what is reverie" through the crisis stance.
- **What decides it:** `this.deps.dreamPersona?.(this.currentStyle()) ?? ''`, an optional host-supplied callback with a silent empty-string fallback.
- **Host need:** yes. A hosted deployment cannot claim "runs entirely on the user's own machine" and must swap in different deployment/privacy language, exactly the documented reason this hook exists (`engine.ts:321-323`).
- **Verdict:** seam, already correctly identified as one; the fallback behavior is the defect, not the existence of the seam.
- **Why:** `dreamPersona` is never defaulted to `buildPersona` anywhere; `buildPersona` is never imported into `packages/memory` at all, which is architecturally correct per AGENTS.md's downward-only-dependency rule, but it means the memory package has no way to supply a sane default if a host omits the hook.
- **Hazard:** the sibling hook `dreamingModel` is enforced with a loud, specific error and a dream-log failure record when omitted (`engine.ts:3165-3171`). `dreamPersona` gets no equivalent guard, and degrades silently instead. No test in the repo reaches `executeDream`, `maybeDream`, or `dreamNow` with `dreamPersona` omitted (verified two ways: grepping every `dreamPersona` usage in tests, five hits, all stubbing the hook; and grepping every test that calls `maybeDream`/`dreamNow`/`executeDream` and checking each by hand for whether it reaches the persona line). This is a live, unguarded, untested default, not a hypothetical. Both the CLI (`packages/cli/src/chat.ts:583`) and server (`packages/server/src/launch.ts:120`) wire it identically today (`dreamPersona: (style) => buildPersona(config.safety.mode, config.safety.resources, style)`), so this default is currently unreachable in production, but nothing in `MemoryEngine` enforces that a caller must set it.

### 28. Crisis stance is bypassable via a `dreamPersona` swap, with only a narrow output-side backstop (`packages/memory/src/dreaming.ts`, `engine.ts:3173`)
- **What varies:** whether the model receives any instruction on how to behave toward a distressed person during the dream's exploration phase (mention resources, stay present, decide when to decline).
- **What decides it:** the same `dreamPersona` callback as item 27; whatever string it returns is used verbatim as every dream model call's `system` field, with nothing in `dreaming.ts` or `engine.ts` inspecting, validating, or requiring any particular content in it.
- **Host need:** no, this should arguably be prevented, not enabled, but it is possible today.
- **Verdict:** seam (the input-side crisis stance lives entirely in `args.persona`, the same seam as item 27, and can be omitted or replaced with zero enforcement).
- **Why:** `dreamPersona` is typed as a bare `(style: StyleConfig) => string`; nothing downstream checks its content. `buildPersona` does append `crisisSection` unconditionally as the last section, for both safety modes, so the dream prompt carries the crisis stance today, exactly because both CLI and server wire `dreamPersona` to `buildPersona`. But a host-supplied replacement is under no obligation to.
- **Hazard:** there is a genuinely useful, persona-independent second layer specific to dreaming that chat does not have: `toneCheckInstruction` (`dreaming.ts:412-433`) hardcodes "No crisis or self-harm content of any kind" as a rule the tone-check model call applies to the generated narrative and insight claims, after they are written. This output-side gate is not derived from `args.persona` and survives a `dreamPersona` swap. But it only catches degenerate or crisis-flavored prose once written; it says nothing about, and provides no substitute for, the actual crisis-response behavior the input-side stance governs, and the exploration phase that precedes it, reading real transcripts and documents, has no equivalent gate at all.

### 29. Seed-body construction and its truncation cap (`packages/memory/src/engine.ts:3279-3300`)
- **What varies:** whether a seed's full document or page body is included at all (only when a node has a page, or a document seed resolves), the per-seed header text, and whether the combined text is truncated to `DREAM_SEED_BODY_CAP` = 2000 characters (`engine.ts:526, 3297`).
- **What decides it:** presence of `node.doc` or a resolvable document, string length versus the hardcoded cap.
- **Host need:** plausibly yes, for the cap. A host on a smaller-context or more expensive model may want a tighter budget; a host with a larger-context model may want more seed material, a token-economics knob a hosted deployment tends to need per provider.
- **Verdict:** config (candidate for exposure), currently engine-internal (hardcoded constant, no `EngineDeps` field, no config.toml entry).
- **Why:** this is not a seam needed for the privacy or crisis story this review was otherwise framed around, but it fits the same logic-producing-model-bound-text criteria and is worth a BACKLOG-quality note. This is also the largest of the two dreaming call sites originally flagged as living outside the reviewed file set (per the provider-call-site inventory): it is the primary content of what the dreaming model reads each run, built entirely in `engine.ts`.

### 30. Recent-dream digest (`packages/memory/src/engineDreams.ts:242-269`)
- **What varies:** a bulleted list of up to `DREAM_DIGEST_COUNT` = 3 (`engine.ts:529`) past dreams' insight headlines, each optionally suffixed with a feedback verdict, or the literal string `'No past dreams yet.'` when there are none.
- **What decides it:** a loop over recent dream summaries, a feedback-log lookup per insight, and a length check for the fallback string.
- **Host need:** possibly, for the count (a token-budget-per-host-or-provider knob), not for the content shape.
- **Verdict:** config for the count, currently a hardcoded constant with no config surface, unlike its sibling `dreaming.maxToolCalls` which is already exposed through `EngineDeps`; engine-internal for the loop, lookup, and fallback logic.
- **Why:** this was the second of the two call sites originally flagged as outside the reviewed file set; it was built from prior dream insight headlines and any recorded feedback verdict, all already-recorded calendar dates rendered through `formatLocalDate`'s locale-neutral `en-CA` trick, not a live clock read.

### 31. Dreaming's persona always renders the general-mode variant, regardless of the person's live chat mode (`packages/cli/src/chat.ts:583`; `packages/server/src/launch.ts:120`)
- **What varies:** nothing across dream runs. Both CLI and server call `buildPersona(config.safety.mode, config.safety.resources, style)` with exactly three arguments, leaving `activeMode` at its default (`'general'`) and `journalingProtocol` as `undefined`.
- **What decides it:** the fixed three-argument call shape, identical byte-for-byte in both wiring sites.
- **Host need:** no. This is a deliberate simplification, not a bug: a dream is not a live conversation turn.
- **Verdict:** engine-internal.
- **Why:** since `modeParagraph('general')` returns `undefined`, `modeSection` is filtered out, so the dream persona never carries a mode-specific paragraph, no matter what mode the person's live session was in when the dream was triggered. Dreaming's persona is not "whatever persona chat used," it is always the general-mode variant of that persona.

### 32. Dream voice selection (first, second, third person) (`packages/memory/src/engine.ts:3172`; `packages/memory/src/dreaming.ts:378-384`)
- **What varies:** one of three voice-instruction sentences.
- **What decides it:** `this.profileCache.meta.dreams?.voice ?? 'first'`, a per-person profile setting.
- **Host need:** no, beyond what already exists. This is per-person preference, already configurable through `profile.md`, not a deployment-level concern.
- **Verdict:** engine-internal (config, but already correctly scoped to the person, not the deployment).
- **Why:** already correctly configurable at the right layer.

### 33. Crisis and tone content rule inside the tone-check instruction (`packages/memory/src/dreaming.ts:417-420`)
- **What varies:** nothing. This static text ("No nightmare content... No crisis or self-harm content of any kind... No diagnosis... No unhedged character verdicts") is always included, unconditionally.
- **What decides it:** not applicable.
- **Host need:** no, arguably a host should be forbidden from varying this (see item 28).
- **Verdict:** engine-internal, and correctly so.
- **Why:** this is the one safety-relevant piece of dream prompt text that is not persona-dependent and not host-overridable today, a good property worth preserving explicitly if a "protected block" design is ever built for chat and retrofitted to dreaming. It is the mitigating fact for item 28, not a problem in itself.

### 34. Selection and walk sizing constants (`packages/memory/src/engine.ts:527-528`, used at `engine.ts:2953, 2955, 3044, 3046`)
- **What varies:** how many seeds are picked (3, `DREAM_SEED_COUNT`) and how many hops the graph walk takes (3, `DREAM_WALK_HOPS`), which indirectly changes how much material appears in the exploration packet.
- **What decides it:** hardcoded module constants.
- **Host need:** a weaker case than the seed-body cap (item 29): these look like deliberate spec defaults (`dreamSelection.ts`'s own header cites "default 3 hops" from the design spec), not arbitrary tuning knobs.
- **Verdict:** engine-internal.
- **Why:** spec-documented defaults, not obviously host-variance candidates.

### 35. Tone-check retry feedback paragraph (`packages/memory/src/dreaming.ts:402-407`)
- **What varies:** whether a paragraph naming the previous tone-check failure and asking for a different dream is appended.
- **What decides it:** `retryFeedback !== undefined`, set only on the one retry path.
- **Host need:** no, this is pipeline control flow.
- **Verdict:** engine-internal.
- **Why:** ordinary retry plumbing tied to the tone-check mechanism, no deployment concern.

### 36. Walk line in the exploration packet (`packages/memory/src/dreaming.ts:445-447`)
- **What varies:** whether a line listing graph-walk nodes is included.
- **What decides it:** `args.walk.length > 0`.
- **Host need:** no.
- **Verdict:** engine-internal.
- **Why:** ordinary conditional inclusion with no policy content.

### 37. Tone-check surviving-claims list (`packages/memory/src/dreaming.ts:412-413`)
- **What varies:** a numbered list of the insight claims that survived evidence resolution by the time the tone check runs.
- **What decides it:** whichever insights survived `insightResolves` (`dreaming.ts:480-491`).
- **Host need:** no, pipeline plumbing.
- **Verdict:** engine-internal.
- **Why:** entirely independent of `args.persona`, this is the one place upstream filtering shapes what later reaches a model call.

### 38. Insight and tone-check JSON-shape instructions (`packages/memory/src/dreaming.ts:340, 423`)
- **What varies:** nothing, both are fixed schema-description strings mirroring `dreamInsightsOutputSchema` and `toneCheckOutputSchema` (`dreaming.ts:209-242`), included verbatim every run.
- **What decides it:** not applicable.
- **Host need:** no, these must match the zod schemas the response is parsed against; varying them independently of the schema would break parsing.
- **Verdict:** engine-internal.
- **Why:** hand-written but load-bearing for parse correctness.

### 39. Budget-exhausted messages and stop-exploring injection (`packages/memory/src/dreaming.ts:145-191`)
- **What varies:** whether each tool call in a round is answered normally or refused with a fixed `{"error":"tool budget exhausted"}` message, and whether a one-time message telling the model to stop exploring is injected.
- **What decides it:** a running counter against `args.maxToolCalls`, itself already sourced from `dreaming.maxToolCalls` in `EngineDeps`, a config-exposed value distinct from the hardcoded constants in items 29 and 34.
- **Host need:** the budget number itself, yes, and it is already config-configurable. The wording of the refusal and stop-exploring messages, no.
- **Verdict:** engine-internal for the message text and branching logic; the budget number is already correctly a config value, not a finding here.
- **Why:** this is pipeline plumbing that must stay consistent with the actual tool-dispatch behavior.

### 40. Structured-output validation retry message (`packages/memory/src/dreaming.ts:318-325`)
- **What varies:** a user message substituting the specific zod validation error from the first failed attempt, sent only on retry.
- **What decides it:** whether `parseStructured` succeeded on the first attempt.
- **Host need:** no.
- **Verdict:** engine-internal.
- **Why:** a mechanical retry-with-feedback pattern tied directly to the zod schema, not a deployment concern.

Two smaller cross-references worth noting rather than duplicating as full entries: `DREAM_TOOLS`, the dream loop's own separate tool-definition array, is covered under Tool Definitions, item 44. Clock discipline in dreaming was checked and found clean: `time.ts` never reads a clock directly, `runDream` takes `now: Date` as a required argument, and the only live-clock use is `Date.now()` for elapsed-time telemetry, explicitly called out as the one legitimate use in the file's own comment.

## Tool definitions

### 41. No override seam exists for tool description text (`packages/core/src/tools.ts:199-701`)
- **What varies:** nothing today. `toolDefinitions()` returns 14 fixed tools; the top-level `description` field of 13 of them is a plain string literal, authored once.
- **What decides it:** nothing, there is no config or callback path into this function; `agent.ts:413` calls it with no arguments, once per tool-calling round.
- **Host need:** yes, and this is not speculative: a host running a cheaper, less tool-call-reliable model needs different phrasing to get consistent tool-calling behavior.
- **Verdict:** seam.
- **Why:** measured directly by importing the live `tools.ts` and calling `toolDefinitions()`: total top-level description characters across all 14 tools is 9,727. Including every nested parameter description (`kinds`, `after`, `before`, `commitment.*`, etc.) brings the total to 14,316 characters; a flat per-tool description override reaches about 68% of that surface (9,727 / 14,316), the remainder is out of scope for a top-level-only seam (see item 45).
- **Hazard:** tool descriptions are not counted anywhere in `budget.ts`, which defines caps only for system-prompt sections built from memory content. `ChatRequest.tools` is a completely separate, unbudgeted, uncapped channel; nothing in this codebase would notice if `toolDefinitions()` grew unboundedly, override seam or not. Separately, persona and context prose reference tools only by name, never by paraphrasing their descriptions (`personas.ts:23`, `context.ts:172, 199, 253`, `budget.ts:120`, `journaling.ts:117`, see item 7), so a description override does not break those cross-references structurally, though a host rewrite that changes what a tool claims to do without checking those references could still produce confusing instructions.

### 42. `set_mode`'s description is the one tool description built by logic, and no test would catch it going stale (`packages/core/src/tools.ts:607-628`, description built at `tools.ts:610-612`)
- **What varies:** the sentence enumerating all modes and their one-line summaries, built at every call from `MODE_NAMES`/`MODES` (`./modes.js`), rather than authored as a static literal.
- **What decides it:** the live `MODE_NAMES`/`MODES` table, so this description is correct by construction and can never drift from the `ModeName` type as new modes are added.
- **Host need:** no, this should be protected, not overridden.
- **Verdict:** engine-internal, but flagged as the sharpest risk in this section for a naive override seam.
- **Why:** `tools.test.ts:968-974` checks only the nested `properties.mode.enum` array equals `MODE_NAMES` (unaffected by a top-level override); `tools.test.ts:976-981` checks the top-level description for three fixed phrases unrelated to the per-mode list. Nothing in the suite would catch a `set_mode` description that lists nine modes instead of ten.
- **Hazard:** a naive full-replace override on `set_mode` swaps a self-updating enumeration for a static host string with zero automated protection against going stale the next time a mode is added, strictly worse than the closed-catalogue risk elsewhere in this scope. Any override seam should exclude `set_mode` or special-case it (always render the computed mode list, optionally letting a host override only the surrounding wrapper sentence). This is also carried forward into the Defects section, since it is a real gap independent of whether any override seam is ever built.

### 43. `search_memory`'s `kinds` parameter description is a hand-typed, test-guarded copy, not a derived one (`packages/core/src/tools.ts:232-235`; `DOC_KINDS` at `packages/memory/src/sqlite.ts:86-98`)
- **What varies:** nothing at runtime; this is a static literal listing all 11 document kinds.
- **What decides it:** nothing, it is authored text, checked against `DOC_KINDS` only by a test (`docKinds.test.ts:74-83`) that asserts the description contains every value in the real enum.
- **Host need:** no direct host-variation need identified for the content itself.
- **Verdict:** engine-internal.
- **Why:** the mechanism is a staleness tripwire, not a code path that computes the string. Someone still has to update the literal by hand when a kind is added; the test only guarantees they cannot forget silently. This is a materially weaker guarantee than `set_mode`'s live computation (item 42), worth naming as the honest contrast: one tool's correctness is structural, the other's is test-enforced.

### 44. Dreaming has its own, separate, shorter tool-definition surface (`packages/memory/src/dreaming.ts`, `DREAM_TOOLS` array; cited as lines 21-67 in the provider call-site inventory and lines 22-67 in the tool-surface review, reported separately, not reconciled)
- **What varies:** four tools sharing names with core's catalogue (`search_memory`, `read_document`, `read_transcript`, `graph_query`) but with entirely different, much shorter descriptions (for example `search_memory`: "Search the memory folder. Use to follow up on what the seeds raise," 68 characters, versus core's 1,765) and reduced parameter schemas (no `after`/`before` date filters).
- **What decides it:** the fact that `packages/memory` cannot import `packages/core` (the downward-only dependency rule in AGENTS.md), so the dream loop can never see `tools.ts`'s descriptions in the first place, overridden or not.
- **Host need:** yes, and it is the sharpest gap in this section: if a hosted deployment intends to run the dream pipeline on the same cheap model as chat (a reasonable assumption, since dreaming is an offline batch job and exactly the workload a cost-motivated host would move to a cheaper model first), a core-only override seam for item 41 does not reach it at all.
- **Verdict:** seam, a second, independent one from item 41, since the two files cannot share an override mechanism even in principle.
- **Why:** fixing tool-calling reliability for `search_memory` et al. in conversation while leaving `DREAM_TOOLS` untouched would be a half-fix for a workload that plausibly needs it more, since dreaming's descriptions are already deliberately terser.

### 45. Nested parameter descriptions stay out of scope for a top-level override (`packages/core/src/tools.ts`, all `parameters.properties.*.description` fields)
- **What varies:** none of it is reachable by a flat `Partial<Record<ToolName, string>>` override, since these live under `parameters`, not the top-level `description` field.
- **What decides it:** the shape of the proposed override type itself.
- **Host need:** plausibly yes as a follow-up. DeepSeek-class reliability often hinges on the phrasing of an individual field, like `search_memory`'s `kinds`, more than the top-level blurb.
- **Verdict:** config (candidate, deferred), currently no coverage at all.
- **Why:** this is 4,589 of the 14,316 total description characters, smaller value for a first cut than the top-level text, and a real drift hazard: broadening the seam to also cover parameter descriptions is exactly what would make `docKinds.test.ts`'s tripwire (item 43) meaningless for any tool a host actually overrides. If pursued, it needs its own explicit sync story, not folding into a top-level seam silently.

### 46. Tool descriptions carry no durability or replay risk, confirmed (`packages/providers/src/types.ts:8-12`; `packages/memory/src/transcripts.ts:37`)
- **What varies:** nothing, this is a boundary check, not a variation point. Tool names are durable, written into the append-only transcript via `ChatMessage.toolCalls`; tool descriptions are constructed fresh by `toolDefinitions()` on every call and sent to the provider, never logged, never stored.
- **What decides it:** the transcript schema itself only records `{ id, name, arguments }` for each tool call, never the description text that produced it.
- **Host need:** not applicable, this confirms an assumption rather than surfacing a gap.
- **Verdict:** engine-internal.
- **Why:** confirms that a description-only override carries zero durability or replay risk, which was an assumption worth checking explicitly before recommending item 41 as a seam.

## Shared helpers

### 47. `capBody` and the section character budget have no config surface (`packages/core/src/budget.ts:27-89, 107-123`)
- **What varies:** whether a truncation marker is appended to the constitution, latest-daily-rollup, and recent-summaries sections of the chat system prompt, and the character counts formatted into it; whether any given section gets truncated at all, against a fixed per-section cap (`SECTION_CAPS`, `PROMPT_BUDGET_TOTAL`).
- **What decides it:** `body.length <= limit`, where `limit` is one of three hardcoded module constants (`CONSTITUTION_CAP`, `LATEST_DAILY_ROLLUP_CAP`, `RECENT_SUMMARY_CAP`), never read from `ReverieConfig`.
- **Host need:** yes, concretely. A host running different tenants against different model context windows or cost tiers (explicitly the situation for this project's own hosted product) would plausibly want a larger-cap "pro" tier and a tighter-cap cheaper tier. Today that requires forking `budget.ts`, not setting a config value.
- **Verdict:** config, the clearest "belongs in the existing config surface, but isn't there yet" finding in this whole catalogue. `ReverieConfig` has no budget-related field at all.
- **Why:** `capBody` is shared by three chat-prompt sections, so a host that needs to change the retrieval-tool name referenced in its truncation marker (see item 7) fixes it in one place here rather than three, a favorable seam shape if one is ever built.
- **Hazard:** `SECTION_CAPS`' sum is asserted as a hardcoded literal in `budget.test.ts:12` (`expect(sum).toBe(30400)`), deliberately, per its own comment, "so adding a cap forces someone to come here and change it on purpose." If caps become host-configurable, this single global-sum invariant across statically-known constants stops working as written; a host raising one tenant's cap at runtime cannot be checked by a compile-time literal sum. Any seam design here needs to replace this invariant with something that validates a specific config's caps sum to at most the total, not assert one fixed literal.

### 48. Time-of-day rendering machinery spans three pipelines, with a cross-package prose coupling in chat (`packages/memory/src/time.ts`; `packages/core/src/agent.ts:352, 551`; `packages/core/src/context.ts:114`)
- **What varies:** the exact stamp text rendered onto every user message the model sees in chat (`renderLiveStamp`, prefixed in `appendBoth`, `agent.ts:551`), the one-off "current local time is..." sentence appended only to the greeting's system string (`renderLocalTime`, `agent.ts:352`), the per-transcript-line stamp reflection reads back (`renderStoredStamp`, see item 17), and the locale-neutral `YYYY-MM-DD` dates dreaming stamps into digests and directory names (`formatLocalDate`'s `en-CA` trick, confirmed not affected by the en-US issue in item 17).
- **What decides it:** an injectable clock (`this.now()`) and the engine's configured timezone, all functions in `time.ts` taking their instant as a plain argument rather than reading `Date.now()` directly, a discipline the file states as its own rule and that was verified clean throughout.
- **Host need:** plausible for locale/format reasons, lower priority than the en-US finding already catalogued under item 17, since these particular functions (aside from `renderStoredStamp`) are not the ones carrying the hardcoded locale.
- **Verdict:** engine-internal for the mechanism itself, correctly built around a single-clock discipline the codebase documents at length (`agent.ts:11-25`).
- **Why:** the discipline is real and verified, not just claimed.
- **Hazard:** `timeSection` (`context.ts:114`, in the chat system prompt) describes in prose the exact format `renderLiveStamp` produces: "Every message from them is stamped with the local date and time it was sent, in square brackets at the start of the message." This description lives in `packages/core`, the function it describes lives in `@openreverie/memory`, a different package, invoked from `agent.ts`. A host that changes how the stamp is rendered (a different format, a different bracket convention) without also updating `timeSection`'s prose would silently falsify what the persona tells the model about its own input format, a cross-file, cross-package hazard that is easy to miss on a single-package sweep.

### 49. `PEOPLE_CAP`/`ENTITIES_CAP` are shared, unexposed constants feeding both chat and reflection (`packages/memory/src/engine.ts:507-508`, used via `capPeople`/`capEntities` at `engine.ts:3453-3461, 3466-3469`)
- **What varies:** the numeric ceiling used by both the chat prompt's `sessionContext` and the reflection prompt's `buildReflectionContext` (see items 19 and 20 for the reflection-side detail).
- **What decides it:** hardcoded literals (`40`, `30`), not sourced from `EngineDeps` or any config object.
- **Host need:** yes, a straightforward cost/context-budget knob, as already covered under items 19 and 20.
- **Verdict:** config (candidate), currently a build-time constant with no per-tenant or per-deployment override path.
- **Why:** shared verbatim between both consumers by the same two functions, per the comment at `engine.ts:3450-3452` ("Shared by sessionContext... and buildReflectionContext..., so both are bounded the same way").
- **Hazard:** if a host ever exposes these as config, changing one changes both consumers at once, which may or may not be what a host wants. A tenant might want a bigger chat-visible roster but a smaller reflection-prompt roster to control reflection cost specifically, since reflection runs on every session end while chat context is read continuously; a seam design here needs to decide whether to split the knob or keep it unified.

## Defects found that are independent of hosting

These are plain bugs or gaps the six reviews found along the way. They exist regardless of whether any host seam is ever built.

- **`dreamPersona` empty-string fallback**, `packages/memory/src/engine.ts:3173`. What is wrong: `this.deps.dreamPersona?.(this.currentStyle()) ?? ''` silently falls back to an empty system prompt rather than erroring, unlike the sibling `dreamingModel` hook which throws a specific error and records a dream-log failure when omitted. Consequence: any caller of `MemoryEngine` that forgets to wire `dreamPersona`, today only a hypothetical since both production callers set it, gets a dream pipeline with no privacy claim, no crisis stance, and no voice rule, with no error, no warning, and no test in the repo that would catch it.

- **`listStoredSessions` marks every session ended, unconditionally**, `packages/memory/src/engine.ts:1744-1751` (via `SessionStore.describe`, `packages/memory/src/transcripts.ts:164-183`). What is wrong: this method returns `status: 'ended', readOnly: true` for every session directory `SessionStore.describe` finds, with no check for whether `endSession()` was ever actually called; `endSession` itself uses a different, correct signal for "already ended" (whether `summary.md` exists), but that signal is never surfaced through `listStoredSessions`/`PublicSession`. Consequence: on the hosted Durable Object model (hibernation after seconds of inactivity), the moment a session's live registry entry is evicted, `requireLive` falls through to this method for every write path (`message`, `events`, `setMode`, `end`), and a session that was still mid-conversation when the eviction happened becomes permanently read-only from the client's point of view, with no code path that ever calls `endSession()` on it. This fires on essentially every session under that hosting model, independent of whether a full "resume" feature is ever built.

- **`writeJournalingProtocol` clobbers `meta` instead of merging it**, `packages/memory/src/journal.ts:165`. What is wrong: every call rebuilds `meta: { id, kind: 'journaling', updated: now.toISOString() }` from scratch, discarding any pre-existing meta fields, in contrast to `setSessionMode`'s explicit read-merge-write pattern (`engine.ts:863-866`), which its own comment calls out as deliberate. Consequence: any structured field added to `journaling.md`'s frontmatter in the future (a cadence field, for example) would survive exactly one prose rewrite before being silently discarded on the very next call to `update_journaling_protocol`, or the next time reflection's `journalingUpdate` rewrites the same document, since both routes go through this one function.

- **Rollup prompts duplicate and diverge from `PROSE_VOICE_RULE`, untested**, `packages/memory/src/rollups.ts:154-158` versus `packages/memory/src/voice.ts:15-18`. What is wrong: the rollup prompts do not import `PROSE_VOICE_RULE`; they reimplement one clause of it inline ("Plain prose, no headings, no em dashes"), which has already drifted from the five-paragraph rule (no em dash, vary sentence length, no rhetorical triads, no "it's not just X, it's Y," a named filler-word list) that every other prose-producing prompt in scope imports verbatim, and no test in `rollups.test.ts` asserts anything about this text, `PROSE_VOICE_RULE`, or "em dash," confirmed by grep. Consequence: if `voice.ts`'s rule is ever extended or corrected, rollups will silently keep behaving as if it were not, with no test to catch the drift, unlike `reflection.ts`, which has dedicated tests asserting `PROSE_VOICE_RULE`'s presence.

- **`set_mode`'s computed description has no drift guard**, `packages/core/src/tools.ts:610-612`. What is wrong: the description is built correctly, by construction, from the live `MODE_NAMES`/`MODES` table, but no test checks its content against that table; the existing tests check only the unrelated nested `enum` array and three fixed phrases in the top-level text unconnected to the per-mode list. Consequence: nothing in the suite would catch a `set_mode` description that lists nine modes instead of ten, so a bug introduced into the string-building logic itself (as opposed to the table it reads from) would ship silently.
