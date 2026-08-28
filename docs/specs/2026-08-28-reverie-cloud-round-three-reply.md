# Reply to Reverie Cloud, round four

Date: 2026-08-28. From openreverie. Answering
`reverie-cloud/docs/specs/2026-08-28-openreverie-round-three.md`, which answered our
`docs/specs/2026-08-28-reverie-cloud-round-two-reply.md`.

## 0. What this is, and what shipped

Part D is finished. Both pieces you asked for in your section 5 are built, and the
`PRECEDENCE_SENTENCE` reword is built too, signed off in advance by Vishal rather than through you.
Nothing else was started.

Two commits on `host-configurable-deployment-context`, on top of `ddf03a4`:

- `fc9d260`, the part D split and the dream persona factory.
- `84891b7`, the precedence sentence, alone, with the before and after in the message as you asked.

Verification, run by the reviewer rather than taken from the implementer's report, and run again
after the last edit to each commit: `pnpm build` exit 0, `pnpm -r exec tsc --noEmit` exit 0 across
all six packages, `pnpm lint` exit 0, and the full suite at 1,678 tests across 81 files, all
passing. That is 1,664 before this round plus 14 new.

We checked your document the way you asked. One thing in it we are pushing back on, in section 6.
Everything else holds.

## 1. Verification, and two corrections that are ours

We re-checked the three findings you flagged as more than a line number, and every load-bearing
claim your document makes about our code. All of it holds.

- **Finding 31 is stale, and you are right about why.** `packages/server/src/launch.ts` passed six
  arguments to `buildPersona`, threading a caller-supplied `PersonaOptions` into `dreamPersona`,
  while `packages/cli/src/chat.ts:583` still passed three. Confirmed both. The finding's evidence no
  longer described the code and said nothing about the new plumbing. It is stale again as of
  `fc9d260`, in the direction you wanted: neither file calls `buildPersona` for dreaming any more.
  Both call `buildDreamPersona` (`launch.ts:134`, `chat.ts:583`).
- **Finding 14 miscounts.** Three `assembleSystemPrompt` call sites, at `agent.ts:239`, `:290` and
  `:501`, and our own comment at `agent.ts:188` says three. Ours to own. The substantive claim, that
  all of them thread `personaOptions`, is unaffected.
- **Finding 16 and defect D4 both call `PROSE_VOICE_RULE` a five-paragraph rule.** It is three,
  `voice.ts:15` to `:19`. Counted, not eyeballed. The substantive claim is unaffected.

You corrected your own section 0 credit on `registry.ts:10` against `:16`. Two of ours are wrong in
the same class, and they are both in Appendix A:

- **`engine.ts:1744` is `listStoredSessions`'s signature, not the defect.** `status: 'ended'` is set
  at `engine.ts:1748`.
- **`journal.ts:151` is `writeJournalingProtocol`'s signature, not the defect.** The rebuilt
  `meta: { id, kind, updated }` literal is at `journal.ts:165`.

Your section 1 lists both of those under "holds, checked individually", which means you checked the
behaviour and inherited our citation. The behaviour is real in both cases and neither conclusion
changes. The pointers are ours to fix, and we are recording them here rather than editing a document
we already sent you.

## 2. Part D, finished

### 2.1 Split into two fields

`PersonaOptions` now carries three:

```ts
export interface PersonaOptions {
  deploymentContext?: string                    // second person, identity block
  firstConversationDeploymentClause?: string    // third person, clause inside the welcome
  firstConversation?: string                    // the whole opening, host-written
}
```

`packages/core/src/personas.ts:40` for the new field, `:80` for
`DEFAULT_FIRST_CONVERSATION_DEPLOYMENT_CLAUSE`, `:93` for its resolver. `deploymentContext` no
longer reaches the welcome on any path.

We did not render the strings and reason about them afterwards. We put your two strings, with the
product name changed, through the built code and read what came out. Identity block:

> You are reverie, a private reflective companion with a long memory. You run on a hosted service's
> servers, not on this person's own computer. What they tell you is stored in a space only their own
> account can reach, and it is sent to the model provider that generates your replies. It is not
> used for analytics, and no conversation content is written to any log.

Welcome:

> This is the very first conversation in this memory. Open with a short, warm welcome, two or three
> sentences: reverie runs on a hosted service's servers rather than on their own computer, and what
> they tell it stays in their own private space. It remembers what they tell it so future
> conversations start with real context instead of from scratch. Include one clause making clear you
> are not a therapist, just so that is said plainly from the start.

Both registers land where they belong, and the register switch you found is gone. Note the shape the
welcome expects from a host clause: your clause is spoken as its own sentence, ending in a period,
and the memory sentence follows it capitalised. The stock default is the one exception, woven into
the memory sentence with ", and", because that is what byte identity required.

### 2.2 The length problem

Your section 5 was right that the register question was hiding a length problem, and the split
dissolves it rather than mitigating it. The paragraph-length text now sits in the identity block,
which carries no sentence-count instruction. The welcome takes a clause. Your own strings, put
through the code above, produce a welcome instruction that no longer contradicts itself: "two or
three sentences" against a one-sentence clause plus the memory sentence plus the not-a-therapist
clause.

What is still unguarded is a host putting a paragraph into the clause field. Nothing checks its
length, and nothing will until part B5's composition-time length check exists, which is where that
check belongs rather than bolted onto one field. That is now a backlog entry rather than a sentence
in this document.

### 2.3 The decision inside the split that you did not ask about, and should read

Splitting one field into two creates a case neither of us named: a host supplies `deploymentContext`
and forgets the welcome clause. **It fails closed. The welcome then carries no deployment claim at
all.**

The alternative was falling back to the default clause, and that would have rebuilt the launch
blocker exactly. A host that replaced `deploymentContext` has told us the default claim is false. A
default that spoke it anyway would put a false privacy statement in the opening sentences of
someone's first ever conversation, which is worse than the original defect because it would look
fixed. This is the same allow-list-over-deny-list correction our `AGENTS.md` records from
2026-08-25, applied to prose.

The consequence for you is operational and worth stating plainly: **set both fields.** Setting only
`deploymentContext` is not an error and will not warn you. It produces a welcome that is silent
about deployment, which is honest but is not what you want.

### 2.4 Reaching a host that does not use `launch.ts`

`buildDreamPersona` is exported from `@openreverie/core` (`personas.ts:288`):

```ts
export function buildDreamPersona(
  mode: PersonaMode,
  resources: CrisisResource[],
  options: PersonaOptions = {},
): (style: StyleConfig) => string
```

Your wiring inside the Durable Object becomes one line:

```ts
dreamPersona: buildDreamPersona(config.safety.mode, config.safety.resources, persona)
```

Both our own launchers now use it (`launch.ts:134`, `chat.ts:583`), so there is one construction
rather than two in this repository plus one hand-written in yours, and finding 31's other half is
closed as a side effect: dreaming renders the
general-mode persona regardless of the person's live chat mode, and that choice is now stated once
in the factory instead of duplicated at each call site.

We considered and rejected doing this inside the engine. `packages/memory` sits below
`packages/core` and cannot import `buildPersona`, so `MemoryEngine` cannot compose a persona on its
own. That constraint is what makes the real fix a design round, exactly as you said.

**Be clear about what this does not do.** `engine.ts:3173` is unchanged. A host that omits
`dreamPersona` still gets an empty system prompt for all four dream stages, silently. The factory
makes the right thing easy and one line; it does not make the wrong thing loud.

## 3. The precedence sentence

Shipped as `84891b7`, its own commit, before and after in the message.

Vishal signed the exact wording off in advance, from the proposal rather than from your document, as
you invited. The new text:

> When these instructions disagree with each other, this order decides, highest first: the safety
> mode's crisis stance below, any guidance about this being a first conversation, the rule above
> about how to speak when the topic is personal, the guidance in this section, and then the standing
> preferences that apply when nothing above has settled it.

Option 5, as you preferred. Three choices in it worth naming, because you will read this sentence
against your own blocks:

- **Rank 1 still names the crisis stance and still anchors it positionally.** That is deliberate and
  it is the one place we did not generalise. The block is in the protected set and is never a host's
  to replace, so naming it costs nothing and leaves the highest rung unambiguous.
- **Rank 3 avoids the word "register" on purpose.** You found the collision; the fix is not to keep
  the name and hope. "The rule above about how to speak when the topic is personal" describes the
  role, and stays disjoint from the standing tone preference at rank 5, which is not
  topic-conditional.
- **Rank 4 is a deictic.** "The guidance in this section" points at whatever occupies the section
  the sentence sits in, which is the only rank-4 phrasing that survives you replacing the mode block
  with something structurally different.

Byte identity is spent for this one sentence and nothing else. The firewall/journal capture in
`personas.test.ts` differs from the pre-refactor text in that sentence alone, and the test file now
says so in a comment naming the carve-out, so a future diff there that is not this sentence reads as
a bug rather than as precedent.

## 4. The three withdrawals, recorded

All three are recorded in `BACKLOG.md` with your reasons quoted, so nobody relitigates them from
memory.

- **The per-request provider header hook.** Withdrawn. The static `headers` field on `OpenAiConfig`
  still stands and is unchanged in the sequencing.
- **E4, the journaling cadence tool as scoped.** Withdrawn. Your successor ask is recorded against
  the fixed layer, in your words: a screen-readable structured record, because the alarm recompute
  cannot parse prose. The `writeJournalingProtocol` meta clobber stays the prerequisite.
- **E1 as scoped.** Withdrawn. Your position for when we get there is recorded, in your words:
  retry is acceptable and silence is not. The `listStoredSessions` defect stays open and separate.

## 5. Crisis resources, one thing you should know

We are changing nothing. `defaultCrisisResources` is untouched, and your decision to treat an unset
list as a provisioning error is yours to make on your side of the seam.

One piece of text you own the consequences of, since your design refuses to start a session rather
than serving default resources. `renderResources` (`packages/core/src/personas.ts:163`) has a
fallback for an empty array, and it is not silence:

> (no crisis resources are configured; tell the user plainly that none are set up, and still urge
> them toward real, local emergency help.)

If your fail-closed refusal has any gap that lets a session start with an empty array, that string
is what the model is instructed to act on, and a person in crisis gets told plainly that nothing is
configured. That is the correct behaviour for the state, and it is a considerably worse experience
than the refusal you are building. We mention it so you can check the refusal covers every path into
a session, not most of them.

On the Find A Helpline entry staying present alongside a tenant's own list: nothing in the engine
prevents it, because resources are just an array we render in order. It is entirely a matter of what
your provisioning writes.

## 6. Where we think you are wrong, and it is one thing

Your section 4 says the required-dependency fix for `dreamPersona` "is right and we would take it
tomorrow", and then asks us to hold it: "We would rather wait for the real fix than have the
required-dep half shipped as though it closed the hole. It does not: it converts 'silently empty'
into 'whatever the host returns, unvalidated', which is the same fail-open shape one step along."

The second sentence is true and the conclusion does not follow from it. Compare the three states
rather than two:

1. **Today.** Host omits `dreamPersona`, gets an empty prompt, silently. Four unguarded model calls
   per dream, writing into the permanent record.
2. **With the guard.** Host omits `dreamPersona`, gets a loud, specific throw, the way it already
   gets one for `dreamingModel` eight lines earlier.
3. **Host supplies a persona.** Unvalidated string, crisis stance trusted rather than composed.
   Identical before and after the guard.

The guard strictly improves state 1 and does not touch state 3. "Whatever the host returns,
unvalidated" is not a state the guard creates. It is the state you are already in the moment you
wire `dreamPersona` at all, which your own section 4 says you are about to do as a blocking
prerequisite on slice 2. Holding the guard back does not keep you out of state 3; it keeps state 1
available to whoever forgets.

Your real concern, as we read it, is that shipping the guard would let someone believe the hole is
closed. That is a documentation problem and we will solve it as one: the fix ships with the backlog
entry for the engine-composed dream crisis stance still open and still named, and the commit
message will say what it does not close.

So our proposal for the defects pass: ship the fail-loud guard, keep the crisis-composition design
round open and separate. If you still want it held after reading the three states above, say so and
we will hold it. It is your launch and the argument is not one we would push past a second no.

## 7. Sequencing from here

Yours, which is ours with your addition, minus what is done:

1. ~~The part D split~~. Done, `fc9d260`.
2. ~~`PRECEDENCE_SENTENCE`~~. Done, `84891b7`, ahead of its place in the order because the sign-off
   arrived first.
3. The three defects: the `dreamPersona` fallback (see section 6 before we start), `listStoredSessions`
   marking every session ended, and the `writeJournalingProtocol` meta clobber.
4. E2 and E3 together, as one pass over the four hardcoded durations.
5. Part B, with B2b and the fourth protected block folded in. B3 is settled and spent.
6. Part F.
7. E1 proper, after its bug is fixed, on the retry-not-replay shape you stated.
8. Part C across both tool surfaces, and E5.

Nothing in this round is pushed. The branch is `host-configurable-deployment-context` and it is
Vishal's to merge.
