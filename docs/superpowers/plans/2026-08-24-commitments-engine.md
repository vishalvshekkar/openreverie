# Commitments Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give openreverie a first-class commitment: a bounded thing the person said they mean to do, which has identity, can be revised, and resolves.

**Architecture:** A commitment is a graph node of type `commitment` in the append-only `graph.jsonl`, revised by asserting the same node id again, so every version survives. Timing splits into two channels: a deterministic resolver handles only phrases it can resolve without judgment, and everything else is carried as the person's verbatim words plus a model-written gloss and an internal-only bracket. The bracket selects what enters the prompt; the gloss is the only thing ever spoken from.

**Tech Stack:** TypeScript, zod for boundary validation, vitest, better-sqlite3 for the derived index. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-commitments-design.md`

## Global Constraints

Copied from AGENTS.md and the spec. Every task's requirements implicitly include these.

- **Never use an em dash.** Anywhere: code comments, test names, prompt text, tool descriptions, commit messages. Use commas, periods, colons, or parentheses.
- Avoid AI-typical tropes in all prose: "delve", "seamlessly", "robust", "leverage", "streamline", "empower", "unlock", "supercharge", "It's not just X, it's Y".
- **TDD is mandatory** for deterministic logic. Write the failing test, run it, watch it fail, then implement.
- **Falsify every test you add.** After it passes, delete the fix, confirm the test fails for the right reason, restore it. Reading the code is not verification. This codebase has a history of tests that pass for reasons unrelated to their name.
- **Never resolve a vague time into an instant.** `docs/superpowers/specs/2026-08-16-time-as-first-class-design.md:107-115`. The deterministic resolver refuses anything it is not certain of, and refusing is the correct behavior, not a gap.
- **The bracket selects, the gloss speaks.** A derived bracket must never be rendered into prompt text, spoken, or shown to the person. Spec Section 3.
- **There is no overdue state.** Not a field, not a computed property, not a derived flag. Spec Section 6.
- Package dependencies run downward only: `cli` -> `core` -> `memory` -> `providers`. Never import upward or sideways.
- Prose file writes are atomic (temp file then rename). Graph log writes are single-line appends.
- Validate all LLM structured output with zod at the boundary.
- Run `pnpm test`, `pnpm build` and `pnpm lint` before claiming a task done. Paste real output; do not report a suite you did not observe.

## Out of scope for this plan

- The browser Record view for commitments. Separate plan, after this one lands.
- Projects, recurring commitments, duration and effort, notifications, editing from the browser, a page for a commitment. All recorded in the spec Section 10 and in `BACKLOG.md`.
- Backfilling commitments from existing `kind: 'intention'` items. Decided against, spec Section 11.

---

### Task 1: Graph vocabulary for commitments

Adds the node type, the edge type, and the id prefix. Nothing uses them yet; this task exists so every later task has a vocabulary that round-trips through the log and the index.

**Files:**
- Modify: `packages/memory/src/graph.ts` (`NodeType`, `EdgeType`, `nodeRecordSchema`, `edgeRecordSchema`)
- Modify: `packages/memory/src/documents.ts:10` (`IdPrefix`)
- Test: `packages/memory/src/graph.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NodeType` now includes `'commitment'`. `EdgeType` now includes `'waits_on'`. `IdPrefix` now includes `'commitment'`, so `newId('commitment')` returns `commitment_<ulid>`.

- [ ] **Step 1: Write the failing test**

In `packages/memory/src/graph.test.ts`:

```ts
it('round-trips a commitment node and a waits_on edge through the log', async () => {
  const paths = await tempPaths()
  await appendGraph(paths, [
    {
      ts: '2026-08-24T10:00:00.000Z',
      op: 'assert',
      node: 'commitment_01ABC',
      type: 'commitment',
      label: 'See Nightfall with Arjun',
    },
    {
      ts: '2026-08-24T10:00:00.000Z',
      op: 'assert',
      edge: 'waits_on',
      from: 'commitment_01ABC',
      to: 'entity_01WEDDING',
      confidence: 1,
      confirmed: true,
    },
  ])

  const graph = await readGraph(paths)

  expect(graph.nodes.get('commitment_01ABC')?.type).toBe('commitment')
  expect(graph.edges.some((e) => e.edge === 'waits_on' && e.from === 'commitment_01ABC')).toBe(true)
})
```

Follow the existing helper names in that file. If the file uses a different temp-paths helper than `tempPaths()`, use the one it already has rather than adding another.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/graph.test.ts -t 'round-trips a commitment'`
Expected: FAIL. The zod enums reject `'commitment'` and `'waits_on'`, so `readGraph` drops both records and the node lookup is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/graph.ts`:

```ts
export type NodeType = 'realm' | 'arc' | 'item' | 'session' | 'person' | 'entity' | 'commitment'
export type EdgeType = 'part_of' | 'in' | 'from' | 'involves' | 'relates_to' | 'waits_on'
```

And in both schemas, keeping the enum lists identical to the types above:

```ts
  type: z.enum(['realm', 'arc', 'item', 'session', 'person', 'entity', 'commitment']),
```

```ts
  edge: z.enum(['part_of', 'in', 'from', 'involves', 'relates_to', 'waits_on']),
```

In `packages/memory/src/documents.ts`:

```ts
export type IdPrefix =
  | 'doc'
  | 'item'
  | 'arc'
  | 'realm'
  | 'session'
  | 'person'
  | 'entity'
  | 'prop'
  | 'commitment'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/graph.test.ts`
Expected: PASS, and every pre-existing test in that file still passes.

- [ ] **Step 5: Check the index accepts the new type**

`packages/memory/src/sqlite.ts` folds graph nodes into the `nodes` table via `replaceGraph`. Read that function and confirm a `commitment` node passes through without a type whitelist rejecting it. If a whitelist exists, add `commitment` and add a test asserting a commitment node is searchable by `searchNodes`.

Run: `npx vitest run packages/memory/src/sqlite.test.ts`
Expected: PASS.

- [ ] **Step 6: Falsify**

Revert the `NodeType` enum change in `nodeRecordSchema` only, rerun the Step 1 test, confirm it fails, restore. Record the result.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/graph.ts packages/memory/src/graph.test.ts packages/memory/src/documents.ts
git commit -m "feat(memory): add commitment node type and waits_on edge to the graph vocabulary"
```

---

### Task 2: The deterministic time resolver

The heart of the timing work, and the task where refusing to answer is the feature. This resolver handles only phrasings it can resolve without judgment. Everything else returns `undefined`, and a later task hands those to the model for a gloss.

**Files:**
- Create: `packages/memory/src/commitmentTime.ts`
- Test: `packages/memory/src/commitmentTime.test.ts`

**Interfaces:**
- Consumes: `localParts` and the timezone helpers in `packages/memory/src/time.ts`. Read that file first; it already solves local-day arithmetic and you must not reimplement it.
- Produces:

```ts
export interface ResolvedWindow {
  from: string // YYYY-MM-DD, local to the person's timezone
  to: string   // YYYY-MM-DD, inclusive
  statedPrecision: 'day' | 'range'
}

export function resolveStatedTime(
  words: string,
  anchor: Date,
  timezone: string,
): ResolvedWindow | undefined
```

- [ ] **Step 1: Write the failing test**

In `packages/memory/src/commitmentTime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveStatedTime } from './commitmentTime.js'

// Saturday 2026-08-22, 16:29 local in Asia/Kolkata.
const ANCHOR = new Date('2026-08-22T10:59:00.000Z')
const TZ = 'Asia/Kolkata'

describe('resolveStatedTime, phrases it resolves', () => {
  const cases: [string, string, string][] = [
    ['tomorrow', '2026-08-23', '2026-08-23'],
    ['today', '2026-08-22', '2026-08-22'],
    ['tonight', '2026-08-22', '2026-08-22'],
    ['in 3 days', '2026-08-25', '2026-08-25'],
    ['sunday', '2026-08-23', '2026-08-23'],
    ['on Wednesday', '2026-08-26', '2026-08-26'],
  ]

  for (const [words, from, to] of cases) {
    it(`resolves "${words}"`, () => {
      expect(resolveStatedTime(words, ANCHOR, TZ)).toEqual({
        from,
        to,
        statedPrecision: 'day',
      })
    })
  }
})

describe('resolveStatedTime, phrases it must refuse', () => {
  const refused = [
    'next friday',      // genuinely ambiguous in English
    'come summer',      // geographic and seasonal, needs a gloss
    'next fall',
    'over the holidays',
    'sometime in the coming week',
    'someday',
    'at some point',
    'after the wedding', // event anchored, Task 5 handles it
    '',
  ]

  for (const words of refused) {
    it(`refuses "${words}" rather than guessing`, () => {
      expect(resolveStatedTime(words, ANCHOR, TZ)).toBeUndefined()
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/commitmentTime.test.ts`
Expected: FAIL with "Cannot find module './commitmentTime.js'".

- [ ] **Step 3: Write minimal implementation**

Create `packages/memory/src/commitmentTime.ts`. The design rule is a conservative whitelist: match a known phrasing or return `undefined`. Never fall through to a best guess.

```ts
// Resolves only the time phrasings that can be resolved without judgment.
// Everything else returns undefined, which is not a gap: the time spec
// (2026-08-16-time-as-first-class-design.md, lines 107 to 115) deliberately
// refuses to reduce "tonight", "next week" or "sometime in the fall" to one
// instant, and a commitment whose timing this function refuses is carried
// instead as the person's own words plus a model-written gloss.
//
// "next friday" is refused on purpose. English speakers do not agree on
// whether it means the coming Friday or the one after, so resolving it
// would be inventing a fact the person did not state.

import { localParts } from './time.js'

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

export interface ResolvedWindow {
  from: string
  to: string
  statedPrecision: 'day' | 'range'
}

export function resolveStatedTime(
  words: string,
  anchor: Date,
  timezone: string,
): ResolvedWindow | undefined {
  const text = words.trim().toLowerCase()
  if (text.length === 0) return undefined

  // "next <weekday>" is ambiguous and must be refused before the bare
  // weekday branch below can match the weekday inside it.
  if (/\bnext\b/.test(text)) return undefined

  const offset = dayOffsetFor(text, anchor, timezone)
  if (offset === undefined) return undefined

  const day = localDayPlus(anchor, timezone, offset)
  return { from: day, to: day, statedPrecision: 'day' }
}

function dayOffsetFor(text: string, anchor: Date, timezone: string): number | undefined {
  if (text === 'today' || text === 'tonight' || text === 'this evening') return 0
  if (text === 'tomorrow' || text === 'tomorrow night') return 1

  const inDays = text.match(/^in (\d+) days?$/)
  if (inDays?.[1]) return Number(inDays[1])

  const weekday = text.match(/^(?:on |this )?([a-z]+)$/)
  const named = weekday?.[1]
  if (named && WEEKDAYS.includes(named)) {
    const todayIndex = weekdayIndex(anchor, timezone)
    const targetIndex = WEEKDAYS.indexOf(named)
    // The next occurrence, and today counts as zero days away only when the
    // person names today's own weekday.
    return (targetIndex - todayIndex + 7) % 7
  }

  return undefined
}
```

Implement `localDayPlus(anchor, timezone, offsetDays): string` and `weekdayIndex(anchor, timezone): number` using `localParts` from `time.ts`. Read `time.ts` first: it already renders local weekday and local Y/M/D, and reusing it is what keeps this correct across the half-hour offset of `Asia/Kolkata`. Do not construct dates by adding milliseconds to a UTC instant and formatting in UTC.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/commitmentTime.test.ts`
Expected: PASS, all cases in both describes.

- [ ] **Step 5: Add the anchor-sensitivity test**

The same words must resolve differently depending on when they were said. This is the property that makes the anchor load-bearing rather than decorative.

```ts
it('resolves the same weekday differently depending on the anchor', () => {
  // Said on Saturday, "sunday" is tomorrow.
  expect(resolveStatedTime('sunday', new Date('2026-08-22T10:59:00.000Z'), TZ)?.from).toBe(
    '2026-08-23',
  )
  // Said on Monday, "sunday" is six days out.
  expect(resolveStatedTime('sunday', new Date('2026-08-24T10:59:00.000Z'), TZ)?.from).toBe(
    '2026-08-30',
  )
})

it('respects the timezone, not the machine, when the local day differs from UTC', () => {
  // 2026-08-22T19:30Z is already Sunday 2026-08-23 in Asia/Kolkata.
  expect(resolveStatedTime('today', new Date('2026-08-22T19:30:00.000Z'), TZ)?.from).toBe(
    '2026-08-23',
  )
})
```

Run: `npx vitest run packages/memory/src/commitmentTime.test.ts`
Expected: PASS.

- [ ] **Step 6: Falsify**

Delete the `if (/\bnext\b/.test(text)) return undefined` guard, rerun, and confirm the `"next friday"` case fails (it will resolve to a Friday rather than returning `undefined`). Restore. Then break `localDayPlus` to use UTC instead of the timezone, rerun, and confirm the timezone test fails. Restore. Record both results.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/commitmentTime.ts packages/memory/src/commitmentTime.test.ts
git commit -m "feat(memory): resolve unambiguous stated times, refuse everything else"
```

---

### Task 3: The commitment record and its three operations

Identity is the whole point of this feature, so this task is where "record", "revise" and "resolve" become three distinguishable operations rather than three appended facts.

**Files:**
- Create: `packages/memory/src/commitments.ts`
- Test: `packages/memory/src/commitments.test.ts`

**Interfaces:**
- Consumes: `appendGraph`, `readGraph` from `graph.js`; `newId` from `documents.js`; `ResolvedWindow` from `commitmentTime.js`.
- Produces:

```ts
export type CommitmentFlavor = 'errand' | 'plan'
export type CommitmentState = 'open' | 'done' | 'dropped' | 'unknown' | 'quiet'

export interface CommitmentTiming {
  // The person's own words, always, never overwritten.
  words: string
  // When they said it. ISO instant.
  anchor: string
  // Present only when the resolver was certain. Marker: this was stated.
  resolved?: ResolvedWindow
  // Present only when the resolver refused. Marker: this was interpreted.
  interpretation?: {
    gloss: string
    bracketFrom?: string
    bracketTo?: string
    confidence: 'high' | 'medium' | 'low'
  }
}

export interface Commitment {
  id: string
  label: string
  flavor: CommitmentFlavor
  state: CommitmentState
  timing?: CommitmentTiming
  waitsOn?: string
  askedAt?: string
  sessionId: string
}

export function recordCommitment(...): Promise<Commitment>
export function reviseCommitment(...): Promise<Commitment>
export function resolveCommitment(...): Promise<Commitment>
export function readCommitments(paths: MemoryPaths): Promise<Commitment[]>
```

Note the marker requirement from spec Section 3: `resolved` and `interpretation` are mutually exclusive, and exactly one of them is present when timing exists. A reader must always be able to tell a stated window from an interpreted one. Enforce it in the type or in a validator, not by convention.

- [ ] **Step 1: Write the failing test for revision preserving history**

```ts
it('revises a commitment in place while every version survives in the log', async () => {
  const paths = await tempPaths()
  const created = await recordCommitment(paths, {
    label: 'See Nightfall with Arjun',
    flavor: 'plan',
    sessionId: 'session_01A',
    timing: { words: 'friday', anchor: '2026-08-18T10:00:00.000Z',
      resolved: { from: '2026-08-21', to: '2026-08-21', statedPrecision: 'day' } },
  })

  await reviseCommitment(paths, created.id, {
    timing: { words: 'sunday the 23rd', anchor: '2026-08-20T10:00:00.000Z',
      resolved: { from: '2026-08-23', to: '2026-08-23', statedPrecision: 'day' } },
  })

  const live = await readCommitments(paths)
  expect(live).toHaveLength(1)
  expect(live[0]?.id).toBe(created.id)
  expect(live[0]?.timing?.resolved?.from).toBe('2026-08-23')

  // The superseded version is still in the log, which is the property the
  // four contradictory Nightfall records were missing.
  const raw = await readFile(paths.graphPath, 'utf8')
  expect(raw).toContain('2026-08-21')
  expect(raw).toContain('2026-08-23')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/commitments.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Store the commitment's fields as JSON in the node record's `label`, or add the fields to the node record shape. Decide deliberately and write the reason in a comment. The constraint: `NodeRecord.label` is what `searchNodes` matches on for the node lane of retrieval, so burying JSON in it would make commitments match badly in search. Prefer keeping `label` as the human-readable sentence and carrying the structured fields in a sibling field that `nodeRecordSchema` validates.

Revision asserts the same node id again with updated fields. `readCommitments` folds the log and returns the latest version of each id, skipping any that were retracted.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/commitments.test.ts`
Expected: PASS.

- [ ] **Step 5: Add tests for the other two operations and the marker invariant**

```ts
it('records an outcome without inventing one', async () => {
  const paths = await tempPaths()
  const c = await recordCommitment(paths, { label: 'File the tax paperwork', flavor: 'errand', sessionId: 's1' })
  await resolveCommitment(paths, c.id, 'done')
  expect((await readCommitments(paths))[0]?.state).toBe('done')
})

it('appends a later interpretation without rewriting the first', async () => {
  const paths = await tempPaths()
  const c = await recordCommitment(paths, {
    label: 'Start swimming',
    flavor: 'plan',
    sessionId: 's1',
    timing: {
      words: 'come summer',
      anchor: '2026-08-24T10:00:00.000Z',
      interpretation: {
        gloss: 'Said in August 2026. Summer where they live runs roughly February to May.',
        bracketFrom: '2027-02-01',
        bracketTo: '2027-05-31',
        confidence: 'medium',
      },
    },
  })

  await reviseCommitment(paths, c.id, {
    timing: {
      words: 'come summer',
      anchor: '2027-01-15T10:00:00.000Z',
      interpretation: {
        gloss: 'Re-read in January 2027, with that summer now weeks away.',
        bracketFrom: '2027-02-01',
        bracketTo: '2027-05-31',
        confidence: 'high',
      },
    },
  })

  // Spec section 3: the original gloss is testimony and is never rewritten.
  // What was understood, and when, stays legible in the log.
  const raw = await readFile(paths.graphPath, 'utf8')
  expect(raw).toContain('Said in August 2026')
  expect(raw).toContain('Re-read in January 2027')

  const live = await readCommitments(paths)
  expect(live[0]?.timing?.interpretation?.confidence).toBe('high')
})

it('never carries both a stated window and an interpreted one', async () => {
  const paths = await tempPaths()
  await expect(
    recordCommitment(paths, {
      label: 'Start swimming',
      flavor: 'plan',
      sessionId: 's1',
      timing: {
        words: 'come summer',
        anchor: '2026-08-24T10:00:00.000Z',
        resolved: { from: '2027-02-01', to: '2027-05-31', statedPrecision: 'range' },
        interpretation: { gloss: 'anything', confidence: 'low' },
      },
    }),
  ).rejects.toThrow()
})
```

- [ ] **Step 6: Falsify**

For each of the three tests: break the corresponding code path, confirm the test fails for the right reason, restore. In particular, for the revision test, make `reviseCommitment` append a new node id instead of reusing the existing one and confirm `readCommitments` then returns two commitments. That failure mode is exactly the bug this feature exists to prevent, so watch it happen once.

- [ ] **Step 7: Run the full suite and commit**

```bash
pnpm test && pnpm build && pnpm lint
git add packages/memory/src/commitments.ts packages/memory/src/commitments.test.ts packages/memory/src/graph.ts
git commit -m "feat(memory): commitments with identity, revision, and resolution"
```

---

### Task 4: Selection, with lead time proportional to vagueness

**Files:**
- Modify: `packages/memory/src/commitments.ts`
- Test: `packages/memory/src/commitments.test.ts`

**Interfaces:**
- Produces: `export function selectCommitments(all: Commitment[], today: string, cap: number): Commitment[]`

The rule from spec Section 4: a commitment is eligible when today falls within its window, or within a lead time before it, and the lead time scales with vagueness. A day-precision commitment becomes eligible the day of. A range or interpreted commitment becomes eligible earlier.

- [ ] **Step 1: Write the failing test**

```ts
const base = { id: 'c1', label: 'x', flavor: 'plan' as const, state: 'open' as const, sessionId: 's1' }

it('surfaces a day-precision commitment on its day, not a week early', () => {
  const c = { ...base, timing: { words: 'sunday', anchor: '2026-08-22T00:00:00.000Z',
    resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const } } }
  expect(selectCommitments([c], '2026-08-23', 5)).toHaveLength(0)
  expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(1)
})

it('surfaces a vague seasonal commitment weeks ahead of its bracket', () => {
  const c = { ...base, timing: { words: 'come summer', anchor: '2026-08-24T00:00:00.000Z',
    interpretation: { gloss: 'Summer in Bangalore runs roughly February to May.',
      bracketFrom: '2027-02-01', bracketTo: '2027-05-31', confidence: 'medium' as const } } }
  expect(selectCommitments([c], '2027-01-10', 5)).toHaveLength(1)
})

it('never surfaces a commitment that has already been asked about once', () => {
  const c = { ...base, askedAt: '2026-08-31', timing: { words: 'sunday',
    anchor: '2026-08-22T00:00:00.000Z',
    resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const } } }
  expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(0)
})

it('never surfaces a quiet commitment, whatever its timing', () => {
  const c = { ...base, state: 'quiet' as const, timing: { words: 'sunday',
    anchor: '2026-08-22T00:00:00.000Z',
    resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const } } }
  expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(0)
})

it('never surfaces a commitment waiting on something', () => {
  const c = { ...base, waitsOn: 'entity_01WEDDING' }
  expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/commitments.test.ts -t 'surfaces a day-precision'`
Expected: FAIL, `selectCommitments` is not exported.

- [ ] **Step 3: Implement**

State the lead times as named constants with the reasoning in a comment, so a future reader can see they were chosen rather than typed. Suggested starting values: 0 days for `day` precision, 3 days for `range`, and 30 days for an interpretation. Say in the comment that these are a starting point and what would justify changing them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/commitments.test.ts`
Expected: PASS.

- [ ] **Step 5: Falsify all five**

Each of the last three tests guards an anti-taskmaster guarantee from spec Section 6, so falsify them individually: remove the `askedAt` check and watch the "asked once" test fail; remove the `quiet` check and watch that one fail; remove the `waitsOn` check and watch that one fail. Record each. These are the tests most likely to be silently defeated by a later refactor.

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/commitments.ts packages/memory/src/commitments.test.ts
git commit -m "feat(memory): select commitments with lead time proportional to vagueness"
```

---

### Task 5: The no-overdue-state guarantee, enforced

Spec Section 6 says there is no overdue state anywhere in the schema. That is a claim about the whole codebase, so it needs a test that fails if anyone adds one.

**Files:**
- Test: `packages/memory/src/commitments.test.ts`

- [ ] **Step 1: Write the test**

```ts
it('has no state, field or helper expressing lateness', () => {
  const source = readFileSync(new URL('./commitments.ts', import.meta.url), 'utf8')
  // Spec section 6: if the data cannot express "you failed to do this",
  // nothing downstream can render it. This test guards the absence.
  for (const forbidden of ['overdue', 'isLate', 'missed', 'pastDue', 'failed']) {
    expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase())
  }
})

it('leaves a passed window open rather than marking it anything', () => {
  const c = { id: 'c1', label: 'x', flavor: 'plan' as const, state: 'open' as const,
    sessionId: 's1', timing: { words: 'sunday', anchor: '2026-08-22T00:00:00.000Z',
      resolved: { from: '2026-08-23', to: '2026-08-23', statedPrecision: 'day' as const } } }
  // A month later it is still simply open. Unresolved is an ordinary,
  // unjudged condition.
  expect(c.state).toBe('open')
  expect(selectCommitments([c], '2026-09-23', 5)).toHaveLength(0)
})
```

The string scan is deliberately crude, and that is fine: it is a tripwire, not a type system. Write a comment saying so, and saying that `unknown` is the correct state for a passed window with no recorded outcome.

- [ ] **Step 2: Run and confirm it passes, then falsify**

Add a field named `overdue` to the `Commitment` interface, rerun, confirm the test fails, remove it. Record the result. This is the one test whose falsification proves the guarantee is guarded rather than merely intended.

- [ ] **Step 3: Commit**

```bash
git add packages/memory/src/commitments.test.ts
git commit -m "test(memory): guard the no-overdue-state guarantee"
```

---

### Task 6: Extend `remember` without flattening it

Spec Section 7 decided to extend `remember` rather than add a fourteenth tool, on the condition that the operation does not flatten into "an item with an extra string on it". This task is where that condition is either honored or lost.

**Files:**
- Modify: `packages/core/src/tools.ts` (`rememberArgs`, the `remember` tool definition, `dispatchRemember`)
- Modify: `packages/memory/src/engine.ts` (a method the tool can call)
- Test: `packages/core/src/tools.test.ts`

**Interfaces:**
- Consumes: `recordCommitment`, `reviseCommitment`, `resolveCommitment` from Task 3.
- Produces: `remember` accepts a discriminated union of shapes. The item shape is unchanged and stays the default, so nothing that works today breaks.

- [ ] **Step 1: Write the failing tests**

```ts
it('still records a plain item exactly as before', async () => {
  const result = await dispatchTool(engine, 's1', 'remember', {
    text: 'Today felt heavy.', kind: 'feeling',
  })
  expect(JSON.parse(result)).toEqual({ ok: true })
})

it('records a commitment as a commitment, not as an item', async () => {
  await dispatchTool(engine, 's1', 'remember', {
    commitment: { label: 'See Nightfall with Arjun', flavor: 'plan', statedTime: 'sunday' },
  })
  const live = await readCommitments(paths)
  expect(live).toHaveLength(1)
  expect(live[0]?.label).toBe('See Nightfall with Arjun')
})

it('rejects a revision that does not say what it revises', async () => {
  const result = await dispatchTool(engine, 's1', 'remember', {
    reviseCommitment: { statedTime: 'sunday the 23rd' },
  })
  expect(JSON.parse(result).error).toBeDefined()
})

it('rejects a resolution that does not name an outcome', async () => {
  const result = await dispatchTool(engine, 's1', 'remember', {
    resolveCommitment: { commitmentId: 'commitment_01A' },
  })
  expect(JSON.parse(result).error).toBeDefined()
})
```

The last two are the anti-flattening tests. A revision that cannot say what it revises, and a resolution with no outcome, are exactly the shapes that produced four contradictory Nightfall records, and the schema must refuse them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools.test.ts -t 'commitment'`
Expected: FAIL. `rememberArgs` is a `z.strictObject` and rejects the unknown keys.

- [ ] **Step 3: Implement**

Make `rememberArgs` a discriminated union of four strict shapes, not one object with everything optional:

```ts
// Four shapes, deliberately kept separate rather than merged into one
// optional-everything object. Spec section 7: recording, revising and
// resolving are three different operations and must stay distinguishable at
// the boundary. If this union ever needs optional-everything to typecheck,
// the extension has flattened and should be revisited.
const rememberArgs = z.union([
  z.strictObject({
    text: z.string(),
    kind: z.enum(['observation', 'feeling', 'event', 'intention']).optional(),
    eventTime: z.string().optional(),
  }),
  z.strictObject({
    commitment: z.strictObject({
      label: z.string(),
      flavor: z.enum(['errand', 'plan']),
      statedTime: z.string().optional(),
      waitsOn: z.string().optional(),
    }),
  }),
  z.strictObject({
    reviseCommitment: z.strictObject({
      commitmentId: z.string(),
      label: z.string().optional(),
      statedTime: z.string().optional(),
    }),
  }),
  z.strictObject({
    resolveCommitment: z.strictObject({
      commitmentId: z.string(),
      outcome: z.enum(['done', 'dropped', 'quiet']),
    }),
  }),
])
```

In `dispatchRemember`, branch on which shape parsed and call the matching engine method. When a commitment carries `statedTime`, call `resolveStatedTime` from Task 2. When it resolves, store it as `timing.resolved`. When it does not, store `timing.words` and `timing.anchor` with no interpretation yet: the gloss is written by reflection in Task 7, because the live tool call has no reliable moment to ask the model for one.

Update the `remember` tool description to explain the four shapes in plain language. This is the part the model actually reads, so it decides whether the feature works at all. No em dashes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools.test.ts`
Expected: PASS, including every pre-existing `remember` test.

- [ ] **Step 5: Confirm the tool notice table still covers everything**

Task C of the previous plan added a test that fails when any name from `toolDefinitions()` has no entry in `TOOL_NOTICES`. `remember` already has an entry and no new tool was added, so this should still pass. Run it and confirm rather than assuming.

Run: `npx vitest run packages/cli/src/chat.test.ts`
Expected: PASS.

- [ ] **Step 6: Falsify**

Replace the union with a single object where every field is optional, rerun, and confirm the two rejection tests fail. That is the flattening the spec warned about, so watch it happen once and then restore the union. Record the result.

- [ ] **Step 7: Commit**

```bash
pnpm test && pnpm build && pnpm lint
git add packages/core/src/tools.ts packages/core/src/tools.test.ts packages/memory/src/engine.ts
git commit -m "feat(core): extend remember with commitment shapes, kept distinguishable"
```

---

### Task 7: Reflection as the backstop, and the gloss writer

Spec Section 7: reflection is the path that must work, because live tool calls are not guaranteed. A chat model can be swapped and quietly stop calling tools, with no error and no visible symptom, which is the finding recorded in `BACKLOG.md`. Reflection attaches no tools and is unaffected.

**Files:**
- Modify: `packages/memory/src/reflection.ts` (`ReflectionOutput`, `reflectionOutputSchema`, the prompt, and the graph write around line 710)
- Test: `packages/memory/src/reflection.test.ts`

**Interfaces:**
- Consumes: Task 2's `resolveStatedTime`, Task 3's `recordCommitment` and `reviseCommitment`.
- Produces: `ReflectionOutput.commitments` and `ReflectionOutput.commitmentRevisions`.

- [ ] **Step 1: Write the failing schema test**

```ts
it('accepts commitments with a gloss for a time it could not resolve', () => {
  const parsed = reflectionOutputSchema.safeParse({
    summary: 's', items: [], attributions: [], newArcs: [], personUpdates: [],
    commitments: [{
      label: 'Start swimming',
      flavor: 'plan',
      statedTime: 'come summer',
      gloss: 'Said on 2026-08-24. Summer where they live, Bangalore, runs roughly February to May, so this points at early 2027 rather than the middle of the year.',
      bracketFrom: '2027-02-01',
      bracketTo: '2027-05-31',
      confidence: 'medium',
    }],
  })
  expect(parsed.success).toBe(true)
})

it('rejects a gloss with no stated words to interpret', () => {
  const parsed = reflectionOutputSchema.safeParse({
    summary: 's', items: [], attributions: [], newArcs: [], personUpdates: [],
    commitments: [{ label: 'x', flavor: 'plan', gloss: 'invented from nothing' }],
  })
  expect(parsed.success).toBe(false)
})
```

Match the exact field names the existing `reflectionOutputSchema` uses for its other arrays, and check whether `personUpdates` and the other keys are required before copying this literally.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/memory/src/reflection.test.ts -t 'commitments'`
Expected: FAIL, the schema has no `commitments` key.

- [ ] **Step 3: Implement schema and the write path**

Extend the output type and schema. In the graph write near line 710, where items already become `type: 'item'` nodes, add the commitment write using Task 3's functions. Reflection wins over the live path when both touched the same commitment, per spec Section 7, because it has read the whole session.

- [ ] **Step 4: Extend the reflection prompt**

Near `reflection.ts:332`, which already instructs the model about `eventTime`, add the commitment instruction. It must say, in plain language:

- What a commitment is: a bounded thing the person said they mean to do, which can later resolve.
- That the person's exact wording for timing goes in `statedTime`, always, unchanged.
- That when the wording is vague (a season, a holiday, "sometime"), it writes a `gloss`: one or two sentences recording what was said, when, and what it plausibly means **for this person in the place they live**. The model has `profile.md` in context, so it knows the location. Say explicitly that summer in Bangalore is roughly February to May, as a worked example of why the gloss cannot come from a season table.
- That the bracket is a rough outer range for the gloss, is never shown to the person, and is only used to decide when the commitment is worth mentioning.
- That it must **not** resolve a vague time into a specific date, and must not invent a time the person did not state.
- That a commitment already recorded and now changed is a revision referencing its id, not a new commitment.

- [ ] **Step 5: Add a fixture test for the gloss**

Per AGENTS.md, LLM-dependent behavior is tested with fixture transcripts and schema assertions, not golden text. Add a fixture transcript where the person says "come summer I want to start swimming again", run it through the existing reflection test harness with a stubbed model returning a fixture response, and assert: a commitment was created, `statedTime` is exactly `'come summer'`, an interpretation is present, and `resolved` is absent. Do not assert on the gloss's wording.

- [ ] **Step 6: Falsify**

Delete the commitment branch of the graph write, rerun, confirm the write test fails. Restore. Then break the schema so `gloss` is allowed without `statedTime`, rerun, confirm the rejection test fails. Restore. Record both.

- [ ] **Step 7: Commit**

```bash
pnpm test && pnpm build && pnpm lint
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "feat(memory): reflection captures commitments and writes the time gloss"
```

---

### Task 8: Commitments in the session prompt

The last mile. Everything above is invisible until the companion can see it.

**Files:**
- Modify: `packages/memory/src/engine.ts` (`SessionContext`, `sessionContext()`)
- Modify: `packages/core/src/context.ts` (a new section, and the cap)
- Modify: `packages/core/src/budget.ts` (the section cap constant)
- Test: `packages/core/src/context.test.ts`, `packages/memory/src/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('renders a commitment with the person\'s own words, never the bracket', async () => {
  // ... build a memory with one interpreted commitment, bracket 2027-02-01 to 2027-05-31
  const prompt = await assembleSystemPrompt(engine, testConfig(), 'general',
    () => new Date('2027-01-10T00:00:00.000Z'))

  expect(prompt).toContain('come summer')
  expect(prompt).toContain('Summer where they live')
  // Spec section 3: the bracket selects, the gloss speaks. It must never
  // reach the prompt at all.
  expect(prompt).not.toContain('2027-02-01')
  expect(prompt).not.toContain('2027-05-31')
})

it('states that a commitment is not evidence the thing happened', async () => {
  const prompt = await assembleSystemPrompt(engine, testConfig())
  expect(prompt).toContain('never evidence that they did it')
})
```

Note the fourth argument to `assembleSystemPrompt`: the injectable clock added in the previous plan's Unit E. Use it rather than depending on the wall clock, or this test rots the way the recent-sessions test did.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/core/src/context.test.ts -t 'commitment'`
Expected: FAIL.

- [ ] **Step 3: Implement**

`sessionContext` calls `selectCommitments` with the local day derived from its existing `now` parameter. `context.ts` renders a `## Commitments` section, capped like its siblings, with a `COMMITMENTS_SECTION_CAP` in `budget.ts` following the naming of `RECENT_INTENTIONS_SECTION_CAP`.

The section renders, per commitment: the label, the person's verbatim timing words, the date they said it, and the gloss when there is one. It renders no bracket, no derived date, and no count of anything overdue.

- [ ] **Step 4: Verify the byte-stability invariant still holds**

`packages/core/src/context.test.ts` asserts the system prompt does not contain today's date, because the prompt must stay byte-stable across a session for the provider's prefix cache. Your rendering must not print a current clock reading.

Run: `npx vitest run packages/core/src/context.test.ts`
Expected: PASS, including that assertion.

- [ ] **Step 5: Falsify**

Render the bracket into the section, rerun, and confirm the "never the bracket" test fails. Restore. This is the single most important falsification in the plan: the bracket reaching prompt text is the failure mode that would make resolving vague time unsafe, and spec Section 3 names it as the property to protect if anything else has to give.

- [ ] **Step 6: Update the README**

AGENTS.md requires the README stay true after any meaningful build session. Add commitments to the Status section, honestly: what is captured, that capture depends on the model for the live path but not for reflection, and that the browser view is not built yet.

- [ ] **Step 7: Commit**

```bash
pnpm test && pnpm build && pnpm lint
git add -A
git commit -m "feat(core): surface commitments in the session prompt"
```

---

## Self-review against the spec

- Section 1, one entity with a flavor field: Task 3 (`CommitmentFlavor`).
- Section 2, the record and no new graph operations: Tasks 1 and 3.
- Section 3, stated versus interpreted, the marker, two precision fields, the bracket-selects invariant: Tasks 2, 3, 7, 8. The invariant is falsified in Task 8 Step 5.
- Section 3, re-glossing by append and never rewrite: covered by the append-only log in Task 3. **Gap: no task explicitly tests appending a second interpretation.** Add it as a sixth test in Task 3 Step 5.
- Section 4, selection and lead time: Task 4.
- Section 5, event-anchored via a `waits_on` edge: Tasks 1 and 4. **Partial: nothing yet flips a waiting commitment live once the thing it waits on happens.** That is honest to defer, but record it in `BACKLOG.md` when this plan starts rather than leaving it implied.
- Section 6, all four anti-taskmaster guarantees: Tasks 4 and 5. Never-volunteered-as-a-list is prompt text in Task 8.
- Section 7, both capture channels and reflection winning: Tasks 6 and 7.
- Section 8, the browser view: deliberately a separate plan.
- Section 9, testing: throughout.
