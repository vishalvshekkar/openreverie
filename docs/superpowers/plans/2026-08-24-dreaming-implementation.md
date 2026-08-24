# Dreaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 dreaming subsystem: a best-effort, cadence-gated background process that recombines old memory into a creative dream narrative plus evidence-pointed insights, surfaced through the prompt, tools, CLI, server, and web.

**Architecture:** A maintenance-style module family in `packages/memory` (dream log, scheduling, seeded selection, pipeline) driven by `MemoryEngine` triggers, with `core` adding config, a prompt section, and a `dream_feedback` tool, `server` adding a timer and three endpoints, `cli` a `dream` command, and `web` a Dreams view. Completion state is the artifact (a dream directory per period); everything else is append-only jsonl.

**Tech Stack:** TypeScript, zod, gray-matter frontmatter docs, better-sqlite3 index, vitest, FakeChatProvider fixtures.

**Spec:** `docs/superpowers/specs/2026-08-24-dreaming-design.md` (read it first; the working record `docs/dreaming.md` carries rationale).

## Global Constraints

- Writing style everywhere (comments, docs, CLI copy, commit messages): never use em dashes; no AI-typical tropes; plain concrete prose (AGENTS.md).
- Package deps are downward-only: `cli|server -> core -> memory -> providers`; `web` talks HTTP only.
- Prose file writes only via `writeDocumentAtomic`; jsonl writes are validated single-line appends; transcripts untouched.
- All LLM structured output validated with zod at the boundary; retry once with the validation error, then abort the dream run (no degraded dream artifacts).
- Nothing in the memory folder is ever modified or deleted by dreaming; dream files are write-once.
- TDD for all deterministic logic: write the failing test, run it, see it fail, implement, see it pass, commit. LLM behavior is tested with `FakeChatProvider` scripts and schema assertions, never golden text.
- Run tests from the repo root: `pnpm vitest run <path>` for one file, `pnpm test` for the suite. Run `pnpm build` and `pnpm lint` before claiming a task done.
- Known pre-existing failure unrelated to this work: `packages/core/src/context.test.ts` "renders each recent session id..." fails on main. Do not fix it here; every other test must pass.
- Model calls in dreaming use `dreamingModel` (falls back to the reflection model). Persona text is prepended to every dreaming system prompt via the `dreamPersona` callback (memory cannot import core's `buildPersona`).
- No `Math.random` in dreaming code paths; all randomness flows from the recorded `rngSeed` through `mulberry32`.

---

### Task 1: Dream log module, paths, id prefix

**Files:**
- Modify: `packages/memory/src/paths.ts` (MemoryPaths + memoryPaths + ensureMemoryTree)
- Modify: `packages/memory/src/documents.ts:10` (IdPrefix union)
- Create: `packages/memory/src/dreamLog.ts`
- Create: `packages/memory/src/dreamLog.test.ts`
- Modify: `packages/memory/src/index.ts` (re-export the new module; follow how graph.ts is re-exported)

**Interfaces:**
- Consumes: `MemoryPaths`, zod, `node:fs/promises`.
- Produces (used by Tasks 3, 5, 7, 9, 10, 11):
  - `type DreamVerdict = 'right' | 'wrong' | 'do_not_bring_up'`
  - `type DreamLogRecord` (discriminated union on `type: 'dreamt' | 'feedback' | 'mentioned'`)
  - `appendDreamLog(paths: MemoryPaths, records: DreamLogRecord[]): Promise<void>`
  - `readDreamLog(paths: MemoryPaths): Promise<DreamLogRecord[]>` (missing file returns `[]`)
  - `foldDreamLog(records: DreamLogRecord[]): DreamLogState` where `DreamLogState = { lastDreamt: Map<string, string>; feedback: Map<string, DreamFeedbackRecord>; mentioned: Set<string> }`
  - `paths.dreamsDir` (`<root>/dreams`) and `paths.dreamLog` (`<root>/dreams/log.jsonl`)
  - `newId('dream')` valid.

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/src/dreamLog.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendDreamLog,
  type DreamLogRecord,
  foldDreamLog,
  readDreamLog,
} from './dreamLog.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

describe('dream log', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-dreamlog-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const dreamt: DreamLogRecord = {
    ts: '2026-08-24T02:00:00.000Z',
    type: 'dreamt',
    dream: 'dream_01A',
    period: '2026-08-24',
    entities: ['arc_01X', 'person_01Y'],
  }
  const feedback: DreamLogRecord = {
    ts: '2026-08-24T09:00:00.000Z',
    type: 'feedback',
    insight: 'ins_01B',
    dream: 'dream_01A',
    verdict: 'wrong',
    source: 'ui',
  }

  it('round-trips records through append and read', async () => {
    await appendDreamLog(paths, [dreamt, feedback])
    expect(await readDreamLog(paths)).toEqual([dreamt, feedback])
  })

  it('returns an empty array when the log does not exist', async () => {
    expect(await readDreamLog(paths)).toEqual([])
  })

  it('rejects an invalid record at append time and writes nothing', async () => {
    const bad = { ...dreamt, entities: 'not-an-array' } as unknown as DreamLogRecord
    await expect(appendDreamLog(paths, [bad])).rejects.toThrow()
    expect(await readDreamLog(paths)).toEqual([])
  })

  it('folds: newest ts wins per entity, later feedback wins per insight, mentions collect', async () => {
    const later: DreamLogRecord = { ...dreamt, ts: '2026-08-25T02:00:00.000Z', dream: 'dream_01C', period: '2026-08-25', entities: ['arc_01X'] }
    const overturn: DreamLogRecord = { ...feedback, ts: '2026-08-26T09:00:00.000Z', verdict: 'right', source: 'tool' } as DreamLogRecord
    const mention: DreamLogRecord = { ts: '2026-08-25T08:00:00.000Z', type: 'mentioned', dream: 'dream_01C' }
    const state = foldDreamLog([dreamt, feedback, later, overturn, mention])
    expect(state.lastDreamt.get('arc_01X')).toBe('2026-08-25T02:00:00.000Z')
    expect(state.lastDreamt.get('person_01Y')).toBe('2026-08-24T02:00:00.000Z')
    expect(state.feedback.get('ins_01B')?.verdict).toBe('right')
    expect(state.mentioned.has('dream_01C')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run packages/memory/src/dreamLog.test.ts`
Expected: FAIL, cannot resolve `./dreamLog.js` (and `dreamsDir` missing from paths).

- [ ] **Step 3: Implement paths and id prefix**

In `paths.ts` add to `MemoryPaths`: `dreamsDir: string` and `dreamLog: string`; in `memoryPaths()` add `dreamsDir: join(root, 'dreams')` and `dreamLog: join(root, 'dreams', 'log.jsonl')`; in `ensureMemoryTree` add `paths.dreamsDir` to the directory-creation list (same pattern as `journalDir`). In `documents.ts:10` extend the union:

```ts
export type IdPrefix = 'doc' | 'item' | 'arc' | 'realm' | 'session' | 'person' | 'entity' | 'prop' | 'dream' | 'ins'
```

- [ ] **Step 4: Implement dreamLog.ts**

```ts
// packages/memory/src/dreamLog.ts
// The dream log: append-only jsonl beside the dream directories. Records
// which entities each dream touched (coverage), feedback on insights, and
// opener mentions. Validated on write and on read, like graph.jsonl: a
// record that cannot parse back off disk can never be appended.
import { appendFile, readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { MemoryPaths } from './paths.js'

export type DreamVerdict = 'right' | 'wrong' | 'do_not_bring_up'

const dreamtSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('dreamt'),
  dream: z.string(),
  period: z.string(),
  entities: z.array(z.string()),
})

const feedbackSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('feedback'),
  insight: z.string(),
  dream: z.string(),
  verdict: z.enum(['right', 'wrong', 'do_not_bring_up']),
  note: z.string().optional(),
  source: z.enum(['ui', 'tool']),
})

const mentionedSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('mentioned'),
  dream: z.string(),
})

export const dreamLogRecordSchema = z.discriminatedUnion('type', [
  dreamtSchema,
  feedbackSchema,
  mentionedSchema,
])

export type DreamLogRecord = z.infer<typeof dreamLogRecordSchema>
export type DreamFeedbackRecord = z.infer<typeof feedbackSchema>

export async function appendDreamLog(paths: MemoryPaths, records: DreamLogRecord[]): Promise<void> {
  if (records.length === 0) return
  const lines = records.map((record) => JSON.stringify(dreamLogRecordSchema.parse(record)))
  await appendFile(paths.dreamLog, `${lines.join('\n')}\n`, 'utf8')
}

export async function readDreamLog(paths: MemoryPaths): Promise<DreamLogRecord[]> {
  let raw: string
  try {
    raw = await readFile(paths.dreamLog, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => dreamLogRecordSchema.parse(JSON.parse(line)))
}

export interface DreamLogState {
  lastDreamt: Map<string, string>
  feedback: Map<string, DreamFeedbackRecord>
  mentioned: Set<string>
}

export function foldDreamLog(records: DreamLogRecord[]): DreamLogState {
  const state: DreamLogState = { lastDreamt: new Map(), feedback: new Map(), mentioned: new Set() }
  for (const record of records) {
    if (record.type === 'dreamt') {
      for (const entity of record.entities) {
        const previous = state.lastDreamt.get(entity)
        if (previous === undefined || record.ts > previous) {
          state.lastDreamt.set(entity, record.ts)
        }
      }
    } else if (record.type === 'feedback') {
      state.feedback.set(record.insight, record)
    } else {
      state.mentioned.add(record.dream)
    }
  }
  return state
}
```

Re-export everything public from `packages/memory/src/index.ts` alongside the graph exports.

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm vitest run packages/memory/src/dreamLog.test.ts`
Expected: PASS (4 tests). Also run `pnpm vitest run packages/memory` to confirm no path-shape test broke (`ensureMemoryTree` tests may assert the directory list; update them to include `dreams/`).

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/dreamLog.ts packages/memory/src/dreamLog.test.ts packages/memory/src/paths.ts packages/memory/src/documents.ts packages/memory/src/index.ts
git commit -m "feat(memory): dream log, dreams paths, dream and ins id prefixes"
```

---

### Task 2: Doc kinds `dream` and `dream_insight`, index and budget wiring

**Files:**
- Modify: `packages/memory/src/sqlite.ts:18-30` (DOC_KINDS)
- Modify: `packages/memory/src/dateSpan.ts:32` (documentDateSpan switch)
- Modify: `packages/core/src/budget.ts` (new cap, SECTION_CAPS, PROMPT_BUDGET_TOTAL)
- Modify: `packages/core/src/tools.ts` (search_memory kinds description)
- Modify: `packages/core/src/docKinds.test.ts` (PROMPT_SECTION_CAP, exempt list, seeding)
- Test: existing `docKinds.test.ts` plus `packages/memory/src/dateSpan.test.ts` (extend)

**Interfaces:**
- Produces: `DocKind` now includes `'dream' | 'dream_insight'`. Frontmatter contract (written in Task 7, consumed by dateSpan now): both kinds carry `date: 'YYYY-MM-DD'`. New budget constant `DREAM_INSIGHTS_SECTION_CAP = 1800`; `PROMPT_BUDGET_TOTAL = 30000`.

- [ ] **Step 1: Extend the P8 test first (it is the failing test)**

In `docKinds.test.ts` add to `PROMPT_SECTION_CAP`:

```ts
  // dream narratives are never injected into the system prompt: they are written for the
  // person, reached only through search_memory and read_document (dreaming design spec,
  // Surfacing). No prompt section, no character cap.
  dream: 0,
  // dream_insight documents are not injected wholesale either; the dreams prompt section
  // renders selected insights and is capped by DREAM_INSIGHTS_SECTION_CAP in budget.ts.
  dream_insight: 0,
```

and add both to `PROMPT_EXEMPT_KINDS`. In the "indexing and web API wiring" describe block, the seeding helper writes one document per kind; add cases writing a minimal doc for each new kind into a `dreams/2026-08-24-dream_seed/` directory with meta `{ id, kind, date: '2026-08-24' }` (mirror how the journal case seeds `journal/`). In `dateSpan.test.ts` add:

```ts
it('returns the dream date for dream and dream_insight kinds', () => {
  expect(documentDateSpan('dream', { id: 'doc_1', date: '2026-08-24' })).toEqual({ start: '2026-08-24', end: '2026-08-24' })
  expect(documentDateSpan('dream_insight', { id: 'doc_2', date: '2026-08-24' })).toEqual({ start: '2026-08-24', end: '2026-08-24' })
  expect(documentDateSpan('dream', { id: 'doc_3' })).toBeNull()
})
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run packages/core/src/docKinds.test.ts packages/memory/src/dateSpan.test.ts`
Expected: FAIL, TypeScript rejects the unknown `dream` keys in `Record<DocKind, number>` until DOC_KINDS grows; dateSpan cases missing.

- [ ] **Step 3: Implement**

`sqlite.ts`: append `'dream', 'dream_insight'` to `DOC_KINDS`. `dateSpan.ts`: extend the existing `case 'summary': case 'rollup_daily':` group to `case 'summary': case 'rollup_daily': case 'dream': case 'dream_insight':` (they share the `meta.date` logic verbatim). `budget.ts`:

```ts
// The dreams prompt section: selected insight rows from recent dreams.
export const DREAM_INSIGHTS_SECTION_CAP = 1800
```

Append `DREAM_INSIGHTS_SECTION_CAP` to `SECTION_CAPS` and set `PROMPT_BUDGET_TOTAL = 30000` (sum becomes 29,600). `tools.ts` search_memory kinds description: append `, dream, dream_insight` to the valid-values sentence.

- [ ] **Step 4: Run the suite for both packages**

Run: `pnpm vitest run packages/core packages/memory`
Expected: PASS except the known pre-existing context.test.ts failure. `INDEX_SCHEMA_VERSION` does not change: kinds are data in the `documents.kind` column, not schema.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/sqlite.ts packages/memory/src/dateSpan.ts packages/memory/src/dateSpan.test.ts packages/core/src/budget.ts packages/core/src/tools.ts packages/core/src/docKinds.test.ts
git commit -m "feat: dream and dream_insight doc kinds with date-span, search, and budget wiring"
```

---

### Task 3: Period math and dueness

**Files:**
- Create: `packages/memory/src/dreamSchedule.ts`
- Create: `packages/memory/src/dreamSchedule.test.ts`
- Modify: `packages/memory/src/index.ts` (re-export)

**Interfaces:**
- Consumes: `formatLocalDate` (time.ts), `isoWeekOf` (rollups.ts).
- Produces (Tasks 9, 12, 13):
  - `type DreamCadence = 'daily' | 'weekly'`
  - `MIN_REFLECTED_SESSIONS = 5`
  - `periodFor(now: Date, cadence: DreamCadence, timezone: string): string`
  - `periodCovered(existingDreamDates: string[], now: Date, cadence: DreamCadence, timezone: string): boolean`
  - `dreamIsDue(check: { enabled: boolean; cadence: DreamCadence; timezone: string; reflectedSessionCount: number; existingDreamDates: string[]; now: Date }): boolean`

`existingDreamDates` are the `YYYY-MM-DD` prefixes of existing dream directory names, so dueness needs no file reads. A dream made under daily cadence covers its week if the user later switches to weekly: coverage is computed from dates, not stored period strings.

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/src/dreamSchedule.test.ts
import { describe, expect, it } from 'vitest'
import { dreamIsDue, MIN_REFLECTED_SESSIONS, periodCovered, periodFor } from './dreamSchedule.js'

// 2026-08-24 is a Monday. 18:30 UTC on the 24th is already the 25th in Tokyo.
const NOW = new Date('2026-08-24T18:30:00.000Z')

describe('periodFor', () => {
  it('uses the local day in the given timezone', () => {
    expect(periodFor(NOW, 'daily', 'UTC')).toBe('2026-08-24')
    expect(periodFor(NOW, 'daily', 'Asia/Tokyo')).toBe('2026-08-25')
  })
  it('uses the ISO week of the local day', () => {
    expect(periodFor(NOW, 'weekly', 'UTC')).toBe('2026-W35')
  })
})

describe('periodCovered', () => {
  it('daily: covered only by a dream dated the current local day', () => {
    expect(periodCovered(['2026-08-23'], NOW, 'daily', 'UTC')).toBe(false)
    expect(periodCovered(['2026-08-24'], NOW, 'daily', 'UTC')).toBe(true)
  })
  it('weekly: any dream date inside the current ISO week covers it', () => {
    expect(periodCovered(['2026-08-23'], NOW, 'weekly', 'UTC')).toBe(false) // Sunday, W34
    expect(periodCovered(['2026-08-24'], NOW, 'weekly', 'UTC')).toBe(true) // Monday, W35
  })
})

describe('dreamIsDue', () => {
  const base = {
    enabled: true,
    cadence: 'daily' as const,
    timezone: 'UTC',
    reflectedSessionCount: MIN_REFLECTED_SESSIONS,
    existingDreamDates: [] as string[],
    now: NOW,
  }
  it('due when enabled, enough sessions, period uncovered', () => {
    expect(dreamIsDue(base)).toBe(true)
  })
  it('not due when disabled, or below the session floor, or covered', () => {
    expect(dreamIsDue({ ...base, enabled: false })).toBe(false)
    expect(dreamIsDue({ ...base, reflectedSessionCount: MIN_REFLECTED_SESSIONS - 1 })).toBe(false)
    expect(dreamIsDue({ ...base, existingDreamDates: ['2026-08-24'] })).toBe(false)
  })
  it('a long gap leaves exactly the current period due, never the missed ones', () => {
    expect(dreamIsDue({ ...base, existingDreamDates: ['2026-06-01'] })).toBe(true)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run packages/memory/src/dreamSchedule.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/memory/src/dreamSchedule.ts
// Cadence names a period (a local day or ISO week), not a time. Every
// trigger asks one question: is the current period due? Missed periods are
// never backfilled (dreaming design spec, Scheduling).
import { isoWeekOf } from './rollups.js'
import { formatLocalDate } from './time.js'

export type DreamCadence = 'daily' | 'weekly'

export const MIN_REFLECTED_SESSIONS = 5

export function periodFor(now: Date, cadence: DreamCadence, timezone: string): string {
  const day = formatLocalDate(now, timezone)
  return cadence === 'daily' ? day : isoWeekOf(day)
}

export function periodCovered(
  existingDreamDates: string[],
  now: Date,
  cadence: DreamCadence,
  timezone: string,
): boolean {
  const current = periodFor(now, cadence, timezone)
  return existingDreamDates.some((date) =>
    cadence === 'daily' ? date === current : isoWeekOf(date) === current,
  )
}

export function dreamIsDue(check: {
  enabled: boolean
  cadence: DreamCadence
  timezone: string
  reflectedSessionCount: number
  existingDreamDates: string[]
  now: Date
}): boolean {
  if (!check.enabled) return false
  if (check.reflectedSessionCount < MIN_REFLECTED_SESSIONS) return false
  return !periodCovered(check.existingDreamDates, check.now, check.cadence, check.timezone)
}
```

Export from index.ts.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run packages/memory/src/dreamSchedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/dreamSchedule.ts packages/memory/src/dreamSchedule.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): dream period math and dueness"
```

---

### Task 4: Dream lock

**Files:**
- Modify: `packages/memory/src/dreamSchedule.ts` (same module; the lock is scheduling state)
- Modify: `packages/memory/src/dreamSchedule.test.ts`

**Interfaces:**
- Produces (Task 9): `DREAM_LOCK_STALE_MS = 15 * 60 * 1000`, `acquireDreamLock(paths: MemoryPaths, now: Date): Promise<boolean>`, `releaseDreamLock(paths: MemoryPaths): Promise<void>`. Lock file: `<dreamsDir>/.lock`, JSON `{ ts, pid }`, exclusive create; a lock older than the stale window is taken over.

- [ ] **Step 1: Write the failing tests** (append to dreamSchedule.test.ts; reuse the mkdtemp/ensureMemoryTree beforeEach pattern from dreamLog.test.ts)

```ts
describe('dream lock', () => {
  // beforeEach/afterEach: mkdtemp + memoryPaths + ensureMemoryTree as in dreamLog.test.ts
  it('first acquire wins, second loses, release frees it', async () => {
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
    expect(await acquireDreamLock(paths, NOW)).toBe(false)
    await releaseDreamLock(paths)
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
  })
  it('a stale lock is taken over', async () => {
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
    const later = new Date(NOW.getTime() + DREAM_LOCK_STALE_MS + 1)
    expect(await acquireDreamLock(paths, later)).toBe(true)
  })
  it('release is a no-op when no lock exists', async () => {
    await expect(releaseDreamLock(paths)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, verify failure** (`acquireDreamLock` not exported).

- [ ] **Step 3: Implement**

```ts
import { readFile as readLockFile, rm as rmLock, writeFile as writeLock } from 'node:fs/promises'
import { join } from 'node:path'

export const DREAM_LOCK_STALE_MS = 15 * 60 * 1000

function lockPath(paths: MemoryPaths): string {
  return join(paths.dreamsDir, '.lock')
}

export async function acquireDreamLock(paths: MemoryPaths, now: Date): Promise<boolean> {
  const payload = JSON.stringify({ ts: now.toISOString(), pid: process.pid })
  try {
    await writeLock(lockPath(paths), payload, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  try {
    const existing = JSON.parse(await readLockFile(lockPath(paths), 'utf8')) as { ts?: string }
    const age = now.getTime() - Date.parse(existing.ts ?? '')
    if (Number.isNaN(age) || age > DREAM_LOCK_STALE_MS) {
      await rmLock(lockPath(paths), { force: true })
      await writeLock(lockPath(paths), payload, { encoding: 'utf8', flag: 'wx' })
      return true
    }
  } catch {
    return false
  }
  return false
}

export async function releaseDreamLock(paths: MemoryPaths): Promise<void> {
  await rmLock(lockPath(paths), { force: true })
}
```

Note: the takeover path has a small race window between `rm` and `wx` create; two processes both past the staleness check can still collide and one loses on the second `wx`. That is the intended behavior, not a bug to fix.

- [ ] **Step 4: Run, verify pass**, then **Step 5: Commit**

```bash
git add packages/memory/src/dreamSchedule.ts packages/memory/src/dreamSchedule.test.ts
git commit -m "feat(memory): dream lock with stale takeover"
```

---

### Task 5: Seeded selection: PRNG, weights, seed pairing, walk

**Files:**
- Create: `packages/memory/src/dreamSelection.ts`
- Create: `packages/memory/src/dreamSelection.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces:**
- Consumes: `GraphState`, `GraphNode`, `GraphEdge` (graph.ts), `DocKind`, `DreamLogState.lastDreamt`.
- Produces (Tasks 7, 9):
  - `mulberry32(seed: number): () => number`
  - `interface DreamCandidate { id: string; label: string; kind: DocKind | 'node'; nodeType?: NodeType; date?: string; degree: number }`
  - `candidateWeight(c: DreamCandidate, lastDreamt: Map<string, string>, now: Date): number` (deterministic part, no jitter)
  - `pickSeeds(args: { candidates: DreamCandidate[]; lastDreamt: Map<string, string>; now: Date; rng: () => number; adjacent: (a: string, b: string) => boolean; count: number }): DreamCandidate[]`
  - `randomWalk(graph: GraphState, start: string, hops: number, rng: () => number): string[]` (visited node ids, start first, no revisits)

Selection rules (spec, Selection): weight = staleness × significance (+ jitter applied inside pickSeeds); staleness soft-capped at 365 days; seeds pairwise distant (not adjacent in the graph, dates ≥ 60 days apart when both dated), constraints relaxed progressively (drop the date rule after 20 failed draws, the adjacency rule after 40); one seed slot reserved for a candidate older than the median candidate date. Candidates exclude `journaling`, `dream`, and `dream_insight` kinds (built by the caller in Task 9; this module just consumes the list).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/memory/src/dreamSelection.test.ts
import { describe, expect, it } from 'vitest'
import type { GraphState } from './graph.js'
import { candidateWeight, type DreamCandidate, mulberry32, pickSeeds, randomWalk } from './dreamSelection.js'

const NOW = new Date('2026-08-24T12:00:00.000Z')

function candidate(id: string, date?: string, degree = 0): DreamCandidate {
  return { id, label: id, kind: 'node', ...(date ? { date } : {}), degree }
}

describe('mulberry32', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const runA = [a(), a(), a()]
    expect(runA).toEqual([b(), b(), b()])
    for (const v of runA) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(mulberry32(43)()).not.toBe(mulberry32(42)())
  })
})

describe('candidateWeight', () => {
  it('an undreamt old entity outweighs a freshly dreamt recent one', () => {
    const old = candidate('arc_old', '2024-01-01', 3)
    const fresh = candidate('arc_fresh', '2026-08-20', 3)
    const lastDreamt = new Map([['arc_fresh', '2026-08-23T00:00:00.000Z']])
    expect(candidateWeight(old, lastDreamt, NOW)).toBeGreaterThan(candidateWeight(fresh, lastDreamt, NOW))
  })
  it('last-dreamt time supersedes the entity date for staleness', () => {
    const c = candidate('arc_x', '2024-01-01', 1)
    const undreamt = candidateWeight(c, new Map(), NOW)
    const justDreamt = candidateWeight(c, new Map([['arc_x', '2026-08-23T00:00:00.000Z']]), NOW)
    expect(undreamt).toBeGreaterThan(justDreamt)
  })
})

describe('pickSeeds', () => {
  const pool = [
    candidate('a', '2024-01-10', 5),
    candidate('b', '2024-02-10', 4),
    candidate('c', '2026-07-01', 3),
    candidate('d', '2026-08-01', 2),
    candidate('e', '2026-08-10', 1),
    candidate('f', '2025-05-05', 2),
  ]
  const never = () => false
  it('is reproducible for a fixed rng seed and returns distinct, date-distant seeds', () => {
    const args = { candidates: pool, lastDreamt: new Map<string, string>(), now: NOW, adjacent: never, count: 3 }
    const first = pickSeeds({ ...args, rng: mulberry32(7) }).map((s) => s.id)
    const second = pickSeeds({ ...args, rng: mulberry32(7) }).map((s) => s.id)
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(3)
  })
  it('reserves one slot for a candidate older than the median date', () => {
    const seeds = pickSeeds({ candidates: pool, lastDreamt: new Map(), now: NOW, rng: mulberry32(11), adjacent: never, count: 3 })
    const oldHalf = new Set(['a', 'b', 'f'])
    expect(seeds.some((s) => oldHalf.has(s.id))).toBe(true)
  })
  it('relaxes constraints rather than failing on a tiny adjacent pool', () => {
    const tiny = [candidate('x', '2026-08-01', 1), candidate('y', '2026-08-02', 1)]
    const always = () => true
    const seeds = pickSeeds({ candidates: tiny, lastDreamt: new Map(), now: NOW, rng: mulberry32(3), adjacent: always, count: 2 })
    expect(seeds.map((s) => s.id).sort()).toEqual(['x', 'y'])
  })
})

describe('randomWalk', () => {
  it('stays within hop bound and never revisits', () => {
    const graph: GraphState = {
      nodes: new Map(
        ['n1', 'n2', 'n3', 'n4'].map((id) => [id, { id, type: 'entity' as const, label: id, ts: '2026-01-01T00:00:00.000Z' }]),
      ),
      edges: new Map([
        ['relates_to:n1:n2', { edge: 'relates_to' as const, from: 'n1', to: 'n2', confidence: 1, confirmed: true, ts: '2026-01-01T00:00:00.000Z' }],
        ['relates_to:n2:n3', { edge: 'relates_to' as const, from: 'n2', to: 'n3', confidence: 1, confirmed: true, ts: '2026-01-01T00:00:00.000Z' }],
        ['relates_to:n3:n1', { edge: 'relates_to' as const, from: 'n3', to: 'n1', confidence: 1, confirmed: true, ts: '2026-01-01T00:00:00.000Z' }],
      ]),
    }
    const path = randomWalk(graph, 'n1', 3, mulberry32(5))
    expect(path[0]).toBe('n1')
    expect(path.length).toBeLessThanOrEqual(4)
    expect(new Set(path).size).toBe(path.length)
    expect(path).not.toContain('n4')
  })
})
```

If `GraphEdge`'s literal shape differs from the object literals above (check `packages/memory/src/graph.ts:77-85`), match the real fields; the behavioral assertions stand.

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement**

```ts
// packages/memory/src/dreamSelection.ts
// Deterministic selection for a dream run. All randomness flows from a
// recorded seed through mulberry32, so any dream's selection is
// reproducible from its rngSeed (dreaming design spec, Selection).
import type { DocKind } from './sqlite.js'
import type { GraphState, NodeType } from './graph.js'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DreamCandidate {
  id: string
  label: string
  kind: DocKind | 'node'
  nodeType?: NodeType
  date?: string
  degree: number
}

const MS_PER_DAY = 86_400_000
const STALENESS_CAP_DAYS = 365
const MIN_SEED_GAP_DAYS = 60
const RELAX_DATE_AFTER = 20
const RELAX_ADJACENCY_AFTER = 40
const JITTER = 0.35

const KIND_BASE_WEIGHT: Partial<Record<DocKind, number>> = {
  constitution: 3,
  arc: 2.5,
  person: 2,
  realm: 2,
  summary: 1.5,
  journal: 1.5,
  rollup_daily: 1,
  rollup_weekly: 1,
}

export function candidateWeight(
  c: DreamCandidate,
  lastDreamt: Map<string, string>,
  now: Date,
): number {
  const last = lastDreamt.get(c.id) ?? c.date
  const parsed = last === undefined ? Number.NaN : Date.parse(last)
  const days = Number.isNaN(parsed)
    ? STALENESS_CAP_DAYS
    : Math.max(0, (now.getTime() - parsed) / MS_PER_DAY)
  const staleness = Math.min(days, STALENESS_CAP_DAYS) / STALENESS_CAP_DAYS
  const significance =
    c.kind === 'node' ? 1 + Math.log2(1 + c.degree) : (KIND_BASE_WEIGHT[c.kind] ?? 1)
  return staleness * significance
}

function weightedDraw(
  pool: DreamCandidate[],
  weights: number[],
  rng: () => number,
): number {
  const total = weights.reduce((s, w) => s + w, 0)
  if (total <= 0) return Math.floor(rng() * pool.length)
  let target = rng() * total
  for (let i = 0; i < pool.length; i += 1) {
    target -= weights[i] ?? 0
    if (target <= 0) return i
  }
  return pool.length - 1
}

function daysApart(a?: string, b?: string): number | undefined {
  if (a === undefined || b === undefined) return undefined
  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return undefined
  return Math.abs(parsedA - parsedB) / MS_PER_DAY
}

export function pickSeeds(args: {
  candidates: DreamCandidate[]
  lastDreamt: Map<string, string>
  now: Date
  rng: () => number
  adjacent: (a: string, b: string) => boolean
  count: number
}): DreamCandidate[] {
  const { candidates, lastDreamt, now, rng, adjacent, count } = args
  if (candidates.length <= count) return [...candidates]

  const weights = candidates.map(
    (c) => candidateWeight(c, lastDreamt, now) + JITTER * rng(),
  )

  const dated = candidates.filter((c) => c.date !== undefined).map((c) => c.date as string)
  dated.sort()
  const median = dated[Math.floor(dated.length / 2)]

  const chosen: DreamCandidate[] = []
  let attempts = 0
  while (chosen.length < count && attempts < RELAX_ADJACENCY_AFTER + candidates.length) {
    attempts += 1
    // Reserve the first slot for the old half so every dream reaches back.
    const pool =
      chosen.length === 0 && median !== undefined
        ? candidates.filter((c) => c.date !== undefined && (c.date as string) <= median)
        : candidates
    const poolWeights = pool.map((c) => weights[candidates.indexOf(c)] ?? 0)
    const pick = pool[weightedDraw(pool, poolWeights, rng)]
    if (pick === undefined || chosen.some((s) => s.id === pick.id)) continue
    const dateOk =
      attempts > RELAX_DATE_AFTER ||
      chosen.every((s) => {
        const gap = daysApart(s.date, pick.date)
        return gap === undefined || gap >= MIN_SEED_GAP_DAYS
      })
    const adjacencyOk =
      attempts > RELAX_ADJACENCY_AFTER || chosen.every((s) => !adjacent(s.id, pick.id))
    if (dateOk && adjacencyOk) chosen.push(pick)
  }
  // Final relaxation: fill remaining slots with the highest-weight leftovers.
  if (chosen.length < count) {
    const leftovers = candidates
      .filter((c) => !chosen.some((s) => s.id === c.id))
      .sort((a, b) => (weights[candidates.indexOf(b)] ?? 0) - (weights[candidates.indexOf(a)] ?? 0))
    chosen.push(...leftovers.slice(0, count - chosen.length))
  }
  return chosen
}

export function randomWalk(
  graph: GraphState,
  start: string,
  hops: number,
  rng: () => number,
): string[] {
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges.values()) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
  }
  const path = [start]
  const visited = new Set([start])
  let current = start
  for (let hop = 0; hop < hops; hop += 1) {
    const next = (adjacency.get(current) ?? []).filter((id) => !visited.has(id) && graph.nodes.has(id))
    if (next.length === 0) break
    const step = next[Math.floor(rng() * next.length)] as string
    path.push(step)
    visited.add(step)
    current = step
  }
  return path
}
```

- [ ] **Step 4: Run, verify pass** (`pnpm vitest run packages/memory/src/dreamSelection.test.ts`), then falsify one: comment out the old-half reservation, confirm the median test fails, restore.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/dreamSelection.ts packages/memory/src/dreamSelection.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): seeded dream selection, weights, and graph walk"
```

---

### Task 6: Dream exploration: packet and bounded tool loop

**Files:**
- Create: `packages/memory/src/dreaming.ts` (started here, finished in Task 7)
- Create: `packages/memory/src/dreaming.test.ts`

**Interfaces:**
- Consumes: `ChatProvider`, `ChatMessage`, `ToolDefinition`, `ToolCall` (providers), `DreamCandidate`.
- Produces (Task 7, 9):
  - `interface DreamLookup { search(query: string, filters?: { kinds?: DocKind[] }, limit?: number): Promise<unknown>; readDocumentById(docId: string): Promise<Document | null>; readTranscript(sessionId: string): Promise<TranscriptLine[]>; neighbors(nodeId: string): unknown }` (implemented by MemoryEngine in Task 9; its methods `search`, `readDocumentById`, `readTranscript` already exist with these names, `neighbors` delegates to `this.index.neighbors`)
  - `runExploration(args: { chat: ChatProvider; model: string; persona: string; lookup: DreamLookup; maxToolCalls: number; packet: string; record: (event: Record<string, unknown>) => void }): Promise<ChatMessage[]>`

The loop: system prompt is `persona + '\n\n' + DREAM_EXPLORATION_INSTRUCTIONS`; the packet is the first user message; each round calls `chat.complete` with the four read-only tool definitions; tool calls are dispatched against `DreamLookup`, results appended as `role: 'tool'` messages; the loop ends when the model stops calling tools or the cap is reached (a final synthetic user message says the tool budget is exhausted and asks it to stop exploring). Every tool call is passed to `record`.

The instruction text must state the restraint rule from the spec: follow what the seeds raise; reading the constitution is fine; do not attempt to read the whole record. The hard cap is what enforces it.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/memory/src/dreaming.test.ts (first block)
import { describe, expect, it } from 'vitest'
import { FakeChatProvider } from '@openreverie/providers'
import type { DreamLookup } from './dreaming.js'
import { runExploration } from './dreaming.js'

function fakeLookup(calls: string[]): DreamLookup {
  return {
    async search() { calls.push('search'); return [{ docId: 'doc_1' }] },
    async readDocumentById() { calls.push('read'); return null },
    async readTranscript() { calls.push('transcript'); return [] },
    neighbors() { calls.push('neighbors'); return [] },
  }
}

const searchCall = (id: string) => ({
  id, name: 'search_memory', arguments: JSON.stringify({ query: 'old arcs' }),
})

describe('runExploration', () => {
  it('dispatches tool calls and stops when the model stops', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [searchCall('t1')] },
      { text: 'done exploring', toolCalls: [] },
    ])
    const calls: string[] = []
    const events: Record<string, unknown>[] = []
    const messages = await runExploration({
      chat, model: 'fake', persona: 'PERSONA', lookup: fakeLookup(calls),
      maxToolCalls: 10, packet: 'PACKET', record: (e) => events.push(e),
    })
    expect(calls).toEqual(['search'])
    expect(chat.requests).toHaveLength(2)
    expect(chat.requests[0]?.system).toContain('PERSONA')
    expect(chat.requests[0]?.tools?.map((t) => t.name)).toEqual([
      'search_memory', 'read_document', 'read_transcript', 'graph_query',
    ])
    expect(messages.at(-1)?.content).toBe('done exploring')
    expect(events.filter((e) => e.event === 'tool_call')).toHaveLength(1)
  })

  it('enforces the hard tool-call cap', async () => {
    const script = Array.from({ length: 6 }, (_, i) => ({ text: '', toolCalls: [searchCall(`t${i}`)] }))
    const chat = new FakeChatProvider([...script, { text: 'stopped', toolCalls: [] }])
    const calls: string[] = []
    await runExploration({
      chat, model: 'fake', persona: 'P', lookup: fakeLookup(calls),
      maxToolCalls: 3, packet: 'PACKET', record: () => {},
    })
    expect(calls).toHaveLength(3)
    // 3 tool rounds + 1 wrap-up call after the budget-exhausted message.
    expect(chat.requests).toHaveLength(4)
  })

  it('a tool dispatch error becomes an error string result, not a crash', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'read_document', arguments: 'not json' }] },
      { text: 'ok', toolCalls: [] },
    ])
    const messages = await runExploration({
      chat, model: 'fake', persona: 'P', lookup: fakeLookup([]),
      maxToolCalls: 5, packet: 'PACKET', record: () => {},
    })
    const toolMessage = messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('error')
  })
})
```

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement** (in new `dreaming.ts`)

```ts
// packages/memory/src/dreaming.ts
// The dream pipeline. Exploration here; outputs and writes in this same
// module (see runDream below, added with the output stage).
import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from '@openreverie/providers'
import type { Document } from './documents.js'
import type { DocKind } from './sqlite.js'
import type { TranscriptLine } from './transcripts.js'

export interface DreamLookup {
  search(query: string, filters?: { kinds?: DocKind[] }, limit?: number): Promise<unknown>
  readDocumentById(docId: string): Promise<Document | null>
  readTranscript(sessionId: string): Promise<TranscriptLine[]>
  neighbors(nodeId: string): unknown
}

const DREAM_TOOLS: ToolDefinition[] = [
  {
    name: 'search_memory',
    description: 'Search the memory folder. Use to follow up on what the seeds raise.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description: 'Read one document by docId.',
    parameters: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_transcript',
    description: 'Read one session transcript by sessionId.',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_query',
    description: 'List graph neighbors of a node by nodeId.',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
]

export const DREAM_EXPLORATION_INSTRUCTIONS = `## Dreaming: exploration

You are the reverie companion between conversations, turning over what this person has shared.
You have been handed a few seeds from their memory: distant things picked on purpose. Explore
what they raise. You may search, read documents and transcripts, and follow graph connections.

Restraint: follow the threads the seeds open. Reading the constitution is fine. Do not attempt
to read the whole record; a dream is made from a handful of things seen closely, not everything
seen at once. When you have enough to work with, stop calling tools and briefly note what
caught your attention.

A recorded intention is evidence the person said they meant to do something. It is never
evidence that they did it. Treat stated times ("come summer") as their words anchored to the
date they were said, never as resolved dates.`

async function dispatchDreamTool(lookup: DreamLookup, call: ToolCall): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>
  } catch {
    return JSON.stringify({ error: 'arguments were not valid JSON' })
  }
  try {
    switch (call.name) {
      case 'search_memory': {
        const kinds = Array.isArray(args.kinds) ? (args.kinds as DocKind[]) : undefined
        const result = await lookup.search(
          String(args.query ?? ''),
          kinds ? { kinds } : undefined,
          typeof args.limit === 'number' ? args.limit : undefined,
        )
        return JSON.stringify(result)
      }
      case 'read_document': {
        const doc = await lookup.readDocumentById(String(args.docId ?? ''))
        return doc === null ? JSON.stringify({ error: 'not found' }) : JSON.stringify({ meta: doc.meta, body: doc.body })
      }
      case 'read_transcript':
        return JSON.stringify(await lookup.readTranscript(String(args.sessionId ?? '')))
      case 'graph_query':
        return JSON.stringify(lookup.neighbors(String(args.nodeId ?? '')))
      default:
        return JSON.stringify({ error: `unknown tool: ${call.name}` })
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

export async function runExploration(args: {
  chat: ChatProvider
  model: string
  persona: string
  lookup: DreamLookup
  maxToolCalls: number
  packet: string
  record: (event: Record<string, unknown>) => void
}): Promise<ChatMessage[]> {
  const system = `${args.persona}\n\n${DREAM_EXPLORATION_INSTRUCTIONS}`
  const messages: ChatMessage[] = [{ role: 'user', content: args.packet }]
  let used = 0
  let exhausted = false
  for (;;) {
    const result = await args.chat.complete({ model: args.model, system, messages, tools: DREAM_TOOLS })
    messages.push({ role: 'assistant', content: result.text, ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}) })
    if (result.toolCalls.length === 0 || exhausted) return messages
    for (const call of result.toolCalls) {
      if (used >= args.maxToolCalls) {
        messages.push({ role: 'tool', content: JSON.stringify({ error: 'tool budget exhausted' }), toolCallId: call.id })
        continue
      }
      used += 1
      args.record({ event: 'tool_call', name: call.name, arguments: call.arguments })
      const output = await dispatchDreamTool(args.lookup, call)
      messages.push({ role: 'tool', content: output, toolCallId: call.id })
    }
    if (used >= args.maxToolCalls && !exhausted) {
      exhausted = true
      messages.push({
        role: 'user',
        content: 'The tool budget for this dream is used up. Stop exploring and note what caught your attention.',
      })
    }
  }
}
```

- [ ] **Step 4: Run, verify pass.** Adjust the cap test's expected request count if the loop shape differs, but the invariants must hold: lookup called exactly `maxToolCalls` times, loop terminates, final message is the model's wrap-up.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/dreaming.ts packages/memory/src/dreaming.test.ts
git commit -m "feat(memory): dream exploration with a bounded read-only tool loop"
```

---

### Task 7: Dream outputs: schemas, tone check, writes, runDream

**Files:**
- Modify: `packages/memory/src/dreaming.ts`
- Modify: `packages/memory/src/dreaming.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces:**
- Consumes: Task 6 exports, `writeDocumentAtomic`, `newId`, `appendDreamLog`, `foldDreamLog`.
- Produces (Task 9):
  - `type DreamVoice = 'first' | 'second' | 'third'`
  - `interface DreamInsight { id: string; kind: 'pattern' | 'change_over_time' | 'connection' | 'open_question' | 'strength'; headline: string; claim: string; confidence: number; evidence: { doc?: string; session?: string; node?: string }[] }`
  - `dreamInsightsOutputSchema` (zod, model output before ids are assigned)
  - `toneCheckOutputSchema` (zod: `{ narrativeOk: boolean; reason?: string; flaggedInsightIndexes: number[] }`)
  - `interface DreamRunResult { outcome: 'written' | 'aborted'; dreamId?: string; dir?: string; reason?: string }`
  - `runDream(args: RunDreamArgs): Promise<DreamRunResult>` where `RunDreamArgs = { chat; model; persona; lookup; paths; maxToolCalls; voice: DreamVoice; now: Date; timezone: string; period: string; trigger: string; rngSeed: number; seeds: DreamCandidate[]; walk: string[]; seedBodies: string[]; recentDreamDigest: string; entitiesTouched: string[] }`

Frontmatter contracts (consumed by Tasks 2, 9, 10, 13, 14):
- `dream.md`: `{ id: newId('doc'), kind: 'dream', dream: dreamId, date, period, voice, seeds: string[] }`, body = narrative.
- `insight.md`: `{ id: newId('doc'), kind: 'dream_insight', dream: dreamId, date, period, seeds, rngSeed, trigger, insights: DreamInsight[] }`, body = per-insight prose under `## <headline> (<insightId>)` headings.
- `process.jsonl`: buffered events written once at the end.

Behavior (spec, pipeline steps 3 to 6): insights call with the exploration messages plus an output instruction, parse with zod, retry once appending the validation error, abort on second failure. Assign `ins_` ids after parse. Resolve evidence pointers (doc via `lookup.readDocumentById`, session via `lookup.readTranscript` inside try/catch, node via a `resolveNode: (id: string) => boolean` callback included in RunDreamArgs); drop unresolvable insights; abort if none survive. Narrative call at `temperature: 0.9` in the configured voice. Tone check call; on `narrativeOk: false` regenerate the narrative once and re-check; still bad, write `insight.md` only. Flagged insights are dropped; if all are flagged, abort. Directory `<dreamsDir>/<localDate>-<dreamId>` is created only after all model calls succeed; then both docs via `writeDocumentAtomic`, `process.jsonl` via one `writeFile`, and the `dreamt` log record.

- [ ] **Step 1: Write the failing tests** (append to dreaming.test.ts; use mkdtemp paths + ensureMemoryTree as in Task 1)

```ts
const INSIGHTS_JSON = JSON.stringify({
  insights: [
    { kind: 'pattern', headline: 'Asking late', claim: 'It looks like help arrives only after weeks of solo effort.', confidence: 0.6, evidence: [{ doc: 'doc_ok' }] },
    { kind: 'open_question', headline: 'The garden', claim: 'Whatever happened to the balcony garden plan?', confidence: 0.5, evidence: [{ doc: 'doc_missing' }] },
  ],
})
const TONE_OK = JSON.stringify({ narrativeOk: true, flaggedInsightIndexes: [] })

function lookupResolving(okDocIds: string[]): DreamLookup {
  return {
    async search() { return [] },
    async readDocumentById(docId: string) {
      return okDocIds.includes(docId)
        ? { path: '/x', meta: { id: docId }, body: 'b' }
        : null
    },
    async readTranscript() { throw new Error('no such session') },
    neighbors() { return [] },
  }
}

function runArgs(paths: MemoryPaths, chat: FakeChatProvider): RunDreamArgs {
  return {
    chat, model: 'fake', persona: 'P', lookup: lookupResolving(['doc_ok']), paths,
    maxToolCalls: 4, voice: 'first', now: new Date('2026-08-24T05:00:00.000Z'),
    timezone: 'UTC', period: '2026-08-24', trigger: 'manual', rngSeed: 7,
    seeds: [], walk: [], seedBodies: ['seed body'], recentDreamDigest: '(no past dreams)',
    entitiesTouched: ['arc_01X'], resolveNode: () => false,
  }
}

describe('runDream', () => {
  it('writes dream.md, insight.md, process.jsonl and the log; drops unresolvable insights', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },        // exploration wrap-up
      { text: INSIGHTS_JSON, toolCalls: [] },  // insights
      { text: 'A quiet shoreline...', toolCalls: [] }, // narrative
      { text: TONE_OK, toolCalls: [] },        // tone check
    ])
    const result = await runDream(runArgs(paths, chat))
    expect(result.outcome).toBe('written')
    const dirents = await readdir(paths.dreamsDir, { withFileTypes: true })
    const dreamDir = dirents.find((d) => d.isDirectory())
    expect(dreamDir?.name).toMatch(/^2026-08-24-dream_/)
    const insightDoc = await readDocument(join(paths.dreamsDir, dreamDir!.name, 'insight.md'))
    const insights = insightDoc.meta.insights as DreamInsight[]
    expect(insights).toHaveLength(1) // doc_missing dropped
    expect(insights[0]?.id).toMatch(/^ins_/)
    expect(insightDoc.meta.rngSeed).toBe(7)
    const dreamDoc = await readDocument(join(paths.dreamsDir, dreamDir!.name, 'dream.md'))
    expect(dreamDoc.meta.kind).toBe('dream')
    expect(dreamDoc.body).toContain('shoreline')
    const log = await readDreamLog(paths)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ type: 'dreamt', period: '2026-08-24', entities: ['arc_01X'] })
  })

  it('retries a bad insights response once, then aborts with nothing written', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    ])
    const result = await runDream(runArgs(paths, chat))
    expect(result.outcome).toBe('aborted')
    expect(await readdir(paths.dreamsDir)).toEqual([]) // no dir, no log
    expect(chat.requests.some((r) => r.messages.some((m) => m.content.includes('failed validation')))).toBe(true)
  })

  it('withholds the narrative after two failed tone checks but still writes insights', async () => {
    const TONE_BAD = JSON.stringify({ narrativeOk: false, reason: 'dread', flaggedInsightIndexes: [] })
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      { text: 'dark narrative', toolCalls: [] },
      { text: TONE_BAD, toolCalls: [] },
      { text: 'second narrative', toolCalls: [] },
      { text: TONE_BAD, toolCalls: [] },
    ])
    const result = await runDream(runArgs(paths, chat))
    expect(result.outcome).toBe('written')
    const dirents = await readdir(paths.dreamsDir, { withFileTypes: true })
    const dreamDir = dirents.find((d) => d.isDirectory())
    const files = await readdir(join(paths.dreamsDir, dreamDir!.name))
    expect(files.sort()).toEqual(['insight.md', 'process.jsonl'])
  })
})
```

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement.** Key pieces beyond the flow described above:

```ts
export const dreamInsightsOutputSchema = z.object({
  insights: z
    .array(
      z.object({
        kind: z.enum(['pattern', 'change_over_time', 'connection', 'open_question', 'strength']),
        headline: z.string().min(1).max(200),
        claim: z.string().min(1),
        confidence: z.number().min(0).max(1),
        evidence: z
          .array(
            z
              .object({
                doc: z.string().optional(),
                session: z.string().optional(),
                node: z.string().optional(),
              })
              .refine((p) => [p.doc, p.session, p.node].filter((v) => v !== undefined).length === 1, {
                message: 'each evidence pointer names exactly one of doc, session, node',
              }),
          )
          .min(1),
      }),
    )
    .min(1),
})

export const toneCheckOutputSchema = z.object({
  narrativeOk: z.boolean(),
  reason: z.string().optional(),
  flaggedInsightIndexes: z.array(z.number().int().nonnegative()),
})
```

Structured calls reuse the reflection retry shape verbatim (reflection.ts:366-401): first call, `safeParse` on `JSON.parse` inside try/catch, one retry whose prompt appends `Your previous response failed validation: <error>` plus the previous text, then abort (`{ outcome: 'aborted', reason: ... }`). Extract a local helper `structuredCall<T>(chat, model, system, messages, schema)` used by both the insights and tone calls so the retry logic exists once.

The insights instruction (a user message appended to the exploration messages) must require: JSON only, matching the schema shape shown inline; hedged falsifiable claims ("it looks like", never "you are"); at least one evidence pointer per insight naming real ids encountered in the packet or exploration; open questions welcome; strengths welcome; never treat a stated intention as a completed fact; never chain from past dreams as evidence.

The narrative instruction (its own `chat.complete` with `temperature: 0.9`, same persona system prompt): 300 to 600 words, a setting and an atmosphere, non-literal recombination of the explored material, gently positive or curious, counterfactual framings allowed, voice per `args.voice` (`first`: the companion dreaming, "I dreamt"; `second`: "you were walking"; `third`: a figure seen from outside).

The tone-check instruction: given the narrative and the insight claims, return JSON judging: no nightmare content, no crisis or self-harm content, no diagnosis, no unhedged character verdicts; flag insight indexes that violate; `narrativeOk` false if the narrative violates.

Writes:

```ts
const dreamId = newId('dream')
const localDate = formatLocalDate(args.now, args.timezone)
const dir = join(args.paths.dreamsDir, `${localDate}-${dreamId}`)
await mkdir(dir, { recursive: true })
if (narrative !== undefined) {
  await writeDocumentAtomic({
    path: join(dir, 'dream.md'),
    meta: { id: newId('doc'), kind: 'dream', dream: dreamId, date: localDate, period: args.period, voice: args.voice, seeds: args.seeds.map((s) => s.id) },
    body: narrative,
  })
}
await writeDocumentAtomic({
  path: join(dir, 'insight.md'),
  meta: { id: newId('doc'), kind: 'dream_insight', dream: dreamId, date: localDate, period: args.period, seeds: args.seeds.map((s) => s.id), rngSeed: args.rngSeed, trigger: args.trigger, insights: survivors },
  body: survivors.map((i) => `## ${i.headline} (${i.id})\n\n${i.claim}`).join('\n\n'),
})
await writeFile(join(dir, 'process.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
await appendDreamLog(args.paths, [{ ts: args.now.toISOString(), type: 'dreamt', dream: dreamId, period: args.period, entities: args.entitiesTouched }])
return { outcome: 'written', dreamId, dir }
```

`events` buffers `{ ts, event, ... }` objects from run start onward (seeds with weights, every tool call via the Task 6 `record` hook, every model call with duration, tone verdicts, outcome). Insight ids: `survivors` get `id: newId('ins')` assigned after validation and evidence resolution.

- [ ] **Step 4: Run, verify pass**, then falsify: make evidence resolution accept everything and confirm the drop test fails; restore.

- [ ] **Step 5: Run the whole memory package** (`pnpm vitest run packages/memory`), **commit**

```bash
git add packages/memory/src/dreaming.ts packages/memory/src/dreaming.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): dream outputs, tone gate, and atomic dream writes"
```

---

### Task 8: Config and profile preferences

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config.test.ts` (follow existing test style there)
- Modify: `packages/memory/src/profile.ts`
- Modify: `packages/memory/src/profile.test.ts`

**Interfaces:**
- Produces (Tasks 9, 12, 13, 14):
  - `ReverieConfig.models.dreaming?: string`
  - `ReverieConfig.dreaming: { enabled: boolean; cadence: 'daily' | 'weekly'; triggers: { afterSession: boolean; onStart: boolean; serverTimer: boolean }; maxToolCalls: number }`
  - `ProfileMeta.dreams?: { voice?: 'first' | 'second' | 'third'; openerMention?: boolean; promptSection?: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// config.test.ts additions
it('defaults the dreaming section when absent: off, daily, all triggers on', async () => {
  // write a config.toml WITHOUT a [dreaming] table using the test helpers already in this file
  const config = await loadConfig(configPath)
  expect(config.dreaming).toEqual({
    enabled: false,
    cadence: 'daily',
    triggers: { afterSession: true, onStart: true, serverTimer: true },
    maxToolCalls: 10,
  })
  expect(config.models.dreaming).toBeUndefined()
})

it('accepts models.dreaming and a partial [dreaming] table', async () => {
  // config.toml with: models.dreaming = "gpt-5-mini" and [dreaming]\nenabled = true\ncadence = "weekly"
  const config = await loadConfig(configPath)
  expect(config.models.dreaming).toBe('gpt-5-mini')
  expect(config.dreaming.enabled).toBe(true)
  expect(config.dreaming.cadence).toBe('weekly')
  expect(config.dreaming.triggers.onStart).toBe(true)
})
```

```ts
// profile.test.ts additions
it('round-trips dreams preferences and rejects an invalid voice', () => {
  const ok = profileMetaSchema.safeParse({ id: 'doc_1', dreams: { voice: 'second', openerMention: false } })
  expect(ok.success).toBe(true)
  const bad = profileMetaSchema.safeParse({ id: 'doc_1', dreams: { voice: 'fourth' } })
  expect(bad.success).toBe(false)
})
```

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement**

`config.ts`: add `dreaming: z.string().optional()` to `modelsSchema`; add

```ts
const dreamingTriggersSchema = z.strictObject({
  afterSession: z.boolean().default(true),
  onStart: z.boolean().default(true),
  serverTimer: z.boolean().default(true),
})

const dreamingSchema = z.strictObject({
  enabled: z.boolean().default(false),
  cadence: z.enum(['daily', 'weekly']).default('daily'),
  triggers: dreamingTriggersSchema.default(() => ({ afterSession: true, onStart: true, serverTimer: true })),
  maxToolCalls: z.number().int().positive().default(10),
})
```

wire `dreaming: dreamingSchema` into `configSchema`, extend `ReverieConfig`, and extend `withNestedDefaultsFillable` to seed `filled.dreaming = {}` (and, inside it, leave triggers to the field default) exactly the way `models` is seeded. Check `saveConfig`'s TOML serialization includes the new section (smol-toml stringifies nested objects; the existing round-trip test style covers it).

`profile.ts`: add to `ProfileMeta`: `dreams?: { voice?: 'first' | 'second' | 'third'; openerMention?: boolean; promptSection?: boolean }`, and to `profileMetaSchema`:

```ts
dreams: z
  .object({
    voice: z.enum(['first', 'second', 'third']).optional(),
    openerMention: z.boolean().optional(),
    promptSection: z.boolean().optional(),
  })
  .passthrough()
  .optional(),
```

- [ ] **Step 4: Run both packages' tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts packages/memory/src/profile.ts packages/memory/src/profile.test.ts
git commit -m "feat: dreaming config section, models.dreaming, and profile dream preferences"
```

---

### Task 9: Engine wiring: deps, candidates, dreamIfDue, triggers, feedback, listing

**Files:**
- Modify: `packages/memory/src/engine.ts`
- Create: `packages/memory/src/engineDreaming.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7.
- Produces (Tasks 10 to 14):
  - `EngineDeps` gains: `dreamingModel?: string`, `dreamPersona?: (style: StyleConfig) => string`, `dreaming?: { enabled: boolean; cadence: DreamCadence; triggers: { afterSession: boolean; onStart: boolean; serverTimer: boolean }; maxToolCalls: number }`
  - `MemoryEngine.maybeDream(trigger: 'afterSession' | 'onStart' | 'serverTimer'): Promise<DreamRunResult | undefined>` (undefined when not due, disabled, locked, or already attempted this period by this process)
  - `MemoryEngine.dreamNow(options?: { force?: boolean; dryRun?: boolean }): Promise<DreamRunResult | DreamDryRun>` where `DreamDryRun = { dryRun: true; period: string; due: boolean; seeds: { id: string; label: string; weight: number }[]; walk: string[] }`
  - `MemoryEngine.listDreams(): Promise<DreamSummary[]>` where `DreamSummary = { dreamId: string; date: string; period: string; hasNarrative: boolean; insightCount: number; dir: string }`
  - `MemoryEngine.readDream(dreamId: string): Promise<{ summary: DreamSummary; narrative?: Document; insights: Document; processLog: string } | null>`
  - `MemoryEngine.recordDreamFeedback(args: { insightId: string; verdict: DreamVerdict; note?: string; source: 'ui' | 'tool' }): Promise<boolean>` (false when the insight id does not exist in any insight.md)
  - `MemoryEngine.markDreamMentioned(dreamId: string): Promise<void>`
  - Engine implements `DreamLookup` (`search`, `readDocumentById`, `readTranscript` exist; add `neighbors(nodeId)` delegating to `this.index.neighbors(nodeId)`).

Implementation notes, concrete:
- `collectDreamCandidates()`: graph nodes from `this.graphState.nodes` (`[id, node]` entries; `label: node.label`, `nodeType: node.type`, `date: node.ts.slice(0, 10)`, degree counted by scanning `this.graphState.edges` values for `from`/`to` matches), plus documents from `await this.listPublicDocuments()` mapped to `{ id: row.docId, label: row.title, kind: row.kind, date: documentDateSpan(row.kind, ...)` is overkill here: use `row.entryDate ?? row.updatedAt.slice(0, 10)` `}`. Exclude kinds `journaling`, `dream`, `dream_insight`. Exclude nothing else.
- `adjacent(a, b)`: scan `this.graphState.edges` values for an edge joining a and b in either direction.
- `existingDreamDates()`: `readdir(this.paths.dreamsDir)`, keep directories matching `/^(\d{4}-\d{2}-\d{2})-dream_/`, return the date captures. `listDreams` builds on the same scan and reads each `insight.md` meta for period and insight count.
- `reflectedSessionCount`: `(await SessionStore.listSessions(this.paths)).filter((s) => s.reflected).length`.
- `maybeDream`: guard `this.dreamAttemptedPeriods: Set<string>` (per-process, one attempt per period per invocation); check the config trigger switch; `dreamIsDue`; `acquireDreamLock`; re-check dueness under the lock; build candidates, fold the log, `rngSeed = Date.now() >>> 0`, `rng = mulberry32(rngSeed)`, `pickSeeds` (count 3), walks (3 hops per node seed), seed bodies (read each seed doc body capped to 2,000 chars; node seeds contribute their `doc` page when set), digest of the last 3 dreams (headline lines from their insight metas plus feedback verdicts from the fold), persona from `deps.dreamPersona?.(this.currentStyle()) ?? ''`, voice from `this.profileCache.meta.dreams?.voice ?? 'first'`, then `runDream`, `reindexOrWarn` both written docs (kinds `dream`, `dream_insight`), `commitMemory(this.paths.root, 'dream: <period>')`, and `releaseDreamLock` in a `finally`.
- `dreamNow`: same body without the trigger switch and once-per-period guard; `force` skips `dreamIsDue`; `dryRun` stops after selection and returns the preview.
- Trigger hooks: at the end of `MemoryEngine.open` (after `refreshDocPaths`), `if (deps.dreaming?.enabled && deps.dreaming.triggers.onStart) { void engine.maybeDream('onStart').catch(() => {}) }` with a comment saying it is deliberately not awaited. At the end of `_doEndSession` (after `commitMemory`), `if (this.deps.dreaming?.enabled && this.deps.dreaming.triggers.afterSession) { await this.maybeDream('afterSession') }`.
- `recordDreamFeedback`: scan insight docs for the insight id, append the feedback record with the owning dream id; `markDreamMentioned` appends a mentioned record.

- [ ] **Step 1: Write the failing tests.** Use the docKinds.test.ts pattern for a real engine over a temp folder with `FakeChatProvider`/`FakeEmbeddingProvider`. Cover, with scripted providers sized to the pipeline (1 exploration wrap-up + 1 insights + 1 narrative + 1 tone per successful run):

```ts
it('dreamNow with force writes a dream and indexes both docs', async () => { /* seed 5 reflected sessions via the seeding helper, run dreamNow({force:true}), assert a dreams/ dir exists, listDreams() length 1, engine.search finds the narrative text with kinds ['dream'] */ })
it('maybeDream is a no-op when disabled, under the session floor, or already covered', async () => { /* three assertions, undefined returned, no dir created */ })
it('maybeDream attempts a period at most once per process even after an aborted run', async () => { /* script a double-validation-failure abort, then assert a second maybeDream call returns undefined without new chat requests */ })
it('recordDreamFeedback appends to the log and returns false for an unknown insight', async () => { ... })
it('dreamNow dryRun returns seeds and walk without calling the chat provider', async () => { /* chat.requests stays empty */ })
```

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement** per the notes above. Keep every dreaming-specific method in a clearly commented region of engine.ts; if the additions push past roughly 250 lines, extract an `engineDreams.ts` helper module taking `{ paths, index, graphState, deps, profile }` style narrow arguments rather than the whole engine.

- [ ] **Step 4: Run `pnpm vitest run packages/memory`, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engineDreaming.test.ts
git commit -m "feat(memory): engine dreaming triggers, dueness, feedback, and listing"
```

---

### Task 10: Prompt section and opener mention

**Files:**
- Modify: `packages/memory/src/engine.ts` (SessionContext fields + population)
- Modify: `packages/core/src/context.ts` (dreamsSection)
- Modify: `packages/core/src/context.test.ts`
- Modify: `packages/core/src/agent.ts` (opener addition)
- Modify: `packages/core/src/agent.test.ts`

**Interfaces:**
- `SessionContext` gains: `dreamInsights: { insightId: string; dreamId: string; kind: string; headline: string; claim: string }[]` (newest dream first, feedback-excluded, at most 8) and `freshDream?: { dreamId: string; date: string }` (newest dream when it is unmentioned and `profileCache.meta.dreams?.openerMention !== false`; independent of `promptSection`).
- `dreamsSection(context: SessionContext): string | undefined` rendered between `recentIntentionsSection` and `latestDailyRollupSection` in the sections array; omitted when `dreamInsights` is empty. `sessionContext` populates `dreamInsights` as `[]` when `profileCache.meta.dreams?.promptSection === false`.

Section text, exactly:

```
## Between-session reflections (dreams)

Between conversations you turn over this person's memory and keep what looked worth keeping.
These are your own tentative observations, not established facts. Draw on them naturally when
they fit, attribute them honestly when you use one ("going back over what you told me..."),
and if the person says one is wrong, accept that and record it with dream_feedback. Open
questions are things worth asking when the moment is natural, never a checklist.

- [ins_x] (pattern) Headline: claim text
```

rendered with `capRows(lines, DREAM_INSIGHTS_SECTION_CAP)`.

- [ ] **Step 1: Write the failing tests.** In context.test.ts follow the existing fixture pattern (the file builds a fake SessionContext): assert the section renders id, kind, headline, claim; is omitted when empty; and respects the cap (`capRows`). In agent.test.ts: when `freshDream` is present in the context the system prompt's greeting instruction contains the dream mention guidance, and `engine.markDreamMentioned` was called with the dream id; when absent, neither.

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement.** `sessionContext`: scan dream dirs newest-first (reuse `listDreams`), read insight metas, fold the log once, filter `feedback.get(id)?.verdict` in `('wrong', 'do_not_bring_up')`, flatten to 8. `freshDream`: newest dream dir where `!state.mentioned.has(dreamId)`. In agent.ts, where `AgentSession.start` assembles the greeting turn, append to the greeting instruction when `context.freshDream` exists (thread it through `assembleSystemPrompt`'s return or a second engine call, matching how the greeting currently gets its context):

```
While the person was away you dreamt. If it fits the opening, mention it in one light
sentence and offer to share it; do not retell it unprompted, and let it go if the person
arrives in distress or wants to talk about something else. Never mention it in decompress mode.
```

and call `await engine.markDreamMentioned(context.freshDream.dreamId)` at session start so the offer happens once. Mode guard: skip the addition entirely when the session mode is `decompress`.

- [ ] **Step 4: Run, verify pass** (`pnpm vitest run packages/core`).

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/engine.ts packages/core/src/context.ts packages/core/src/context.test.ts packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "feat(core): dreams prompt section and one-time opener mention"
```

---

### Task 11: dream_feedback tool

**Files:**
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`
- Modify: `packages/cli/src/chat.ts` (TOOL_NOTICES)

**Interfaces:**
- Tool `dream_feedback`, args `{ insightId: string; verdict: 'right' | 'wrong' | 'do_not_bring_up'; note?: string }`, zod `z.strictObject` + `safeParse` like every other tool, dispatching to `engine.recordDreamFeedback({ ...args, source: 'tool' })`; returns `{"ok":true}` or an error JSON when the insight id is unknown.
- `TOOL_NOTICES` gains `dream_feedback: 'noting your reaction'`.

- [ ] **Step 1: Write the failing tests** (tools.test.ts, following its existing dispatch-test pattern with a stub engine): definition present in `toolDefinitions()` with required `insightId` and `verdict`; dispatch calls `recordDreamFeedback` with `source: 'tool'`; unknown insight returns error JSON; invalid verdict returns a zod error JSON. In the CLI package, extend the TOOL_NOTICES completeness test if one exists in this branch's base; otherwise assert `toolNotice('dream_feedback')` returns `'[noting your reaction]'`.

- [ ] **Step 2: Run, verify failure.** **Step 3: Implement.** **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools.ts packages/core/src/tools.test.ts packages/cli/src/chat.ts
git commit -m "feat(core): dream_feedback tool with CLI notice"
```

---

### Task 12: CLI `reverie dream`

**Files:**
- Modify: `packages/cli/src/index.ts` (KNOWN_SUBCOMMANDS + dispatch)
- Create: `packages/cli/src/dream.ts`
- Create: `packages/cli/src/dream.test.ts`

**Interfaces:**
- `runDreamCommand(engine: MemoryEngine, config: ReverieConfig, args: string[], write: (line: string) => void): Promise<void>` handling: no flags (run now: `dreamNow()`, honoring dueness; prints outcome or why it did not run, including "dreaming is off" with the config path and "fewer than 5 reflected sessions"), `--force`, `--dry-run` (prints period, dueness, seeds with weights, walk), `--list` (one line per dream: date, period, insight count, narrative present), `--show <dreamId>` (prints dream.md body, then insight headlines with ids and any feedback verdicts, then a final line naming the process log path).
- index.ts: add `'dream'` to `KNOWN_SUBCOMMANDS` and an `else if (subcommand === 'dream')` branch calling `runDreamCommand` with the already-opened engine (the same branch shape as `reflect`). Engine construction must now pass the new deps: `dreamingModel: config.models.dreaming ?? config.models.reflection`, `dreaming: config.dreaming`, `dreamPersona: (style) => buildPersona(config.safety.mode, config.safety.resources, style)` (imported from `@openreverie/core`), wherever the CLI builds `EngineDeps` today (find the one site constructing `{ chat, embeddings, reflectionModel, embeddingModel }` and extend it; the server's equivalent site is Task 13).

- [ ] **Step 1: Write the failing tests** (stub engine object with vitest `vi.fn()` methods; assert each flag calls the right engine method and writes the expected lines; `--show` with an unknown id writes an error line and does not throw).

- [ ] **Step 2: Run, verify failure.** **Step 3: Implement.** **Step 4: Run `pnpm vitest run packages/cli`, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/dream.ts packages/cli/src/dream.test.ts
git commit -m "feat(cli): reverie dream command with dry-run, list, show, force"
```

---

### Task 13: Server: engine deps, timer trigger, three endpoints

**Files:**
- Modify: `packages/server/src/launch.ts` (EngineDeps extension, same values as Task 12)
- Modify: `packages/server/src/registry.ts` (dream sweep)
- Modify: `packages/server/src/app.ts` (routes)
- Modify: `packages/server/src/app.test.ts`, `packages/server/src/registry.test.ts`

**Interfaces:**
- `LiveSessionRegistryOptions` gains optional `dreamTrigger?: () => Promise<unknown>`; the constructor, beside the existing sweep, schedules `DREAM_SWEEP_INTERVAL = 30 * 60 * 1000` calling `void options.dreamTrigger?.()` guarded by `!this.closed`; `close()` cancels it. launch.ts passes `dreamTrigger: () => engine.maybeDream('serverTimer')` only when `config.dreaming.enabled && config.dreaming.triggers.serverTimer`.
- Routes, following the existing pathname-array pattern and `writePublicJson` with zod response schemas:
  - `GET /api/v1/dreams` -> `engine.listDreams()` rows `{ dreamId, date, period, hasNarrative, insightCount }`
  - `GET /api/v1/dreams/:id` -> `engine.readDream(id)` as `{ dreamId, date, period, narrative?: string, insights: { insightId, kind, headline, claim, confidence, verdict? }[], processLog: string }`, 404 via `ApiError` when null
  - `POST /api/v1/dreams/:id/feedback` body `{ insightId, verdict, note? }` (zod), -> `engine.recordDreamFeedback({ ..., source: 'ui' })`, 404 when it returns false

- [ ] **Step 1: Write the failing tests.** registry.test.ts drives the injectable scheduler manually and asserts the dream trigger fires on its interval and stops after `close()`. app.test.ts follows the existing route-test pattern with a stub engine: list returns rows; show 404s on unknown; feedback posts and 404s on false.

- [ ] **Step 2: Run, verify failure.** **Step 3: Implement.** **Step 4: Run `pnpm vitest run packages/server`, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/launch.ts packages/server/src/registry.ts packages/server/src/app.ts packages/server/src/app.test.ts packages/server/src/registry.test.ts
git commit -m "feat(server): dream timer trigger and dreams endpoints"
```

---

### Task 14: Web: Dreams view and settings

**Files:**
- Modify: `packages/web/src/api.ts` (types + three client calls)
- Modify: `packages/web/src/App.tsx` (ViewId `'dreams'`, label `Dreams`, tab between `journal` and `settings`)
- Create: `packages/web/src/views/Dreams.tsx` and `dreams.css`
- Modify: `packages/web/src/views/Settings.tsx` (dreams preferences via the existing `PATCH /api/v1/profile` path)
- Test: `packages/web/src/views/Dreams.test.tsx` (follow the Journal view's test pattern)

**Interfaces:**
- ApiClient gains `listDreams(): Promise<DreamRow[]>`, `getDream(dreamId: string): Promise<DreamDetail>`, `sendDreamFeedback(dreamId: string, insightId: string, verdict: DreamVerdict, note?: string): Promise<void>`, with zod response schemas mirroring Task 13's shapes.
- Dreams view: list of dreams newest first (date, insight count, narrative badge); selecting one shows the narrative (Markdown component) and, separately below it, the insights, each with its kind, claim, confidence, and three buttons (Right / Wrong / Don't bring this up) that call `sendDreamFeedback` and reflect the recorded verdict; the process log behind a `<details>` disclosure rendered as preformatted lines. Narrative and insights are visually distinct sections, matching the two-file split.
- Settings view: a Dreams block editing `dreams.voice` (select), `dreams.openerMention`, `dreams.promptSection` (checkboxes) through the profile PATCH; display-only note that enabling dreaming itself and its cadence live in config.toml.

- [ ] **Step 1: Write the failing tests** (render with a stub AppApi: list renders rows; feedback button calls the api with the right verdict; empty state says dreaming has not run yet, without pretending it is on).

- [ ] **Step 2: Run, verify failure.** **Step 3: Implement.** **Step 4: Run `pnpm vitest run packages/web` and `pnpm build` (vite build must pass), verify.**

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/App.tsx packages/web/src/views/Dreams.tsx packages/web/src/views/dreams.css packages/web/src/views/Settings.tsx packages/web/src/views/Dreams.test.tsx
git commit -m "feat(web): dreams view with insight feedback and dream settings"
```

---

### Task 15: Docs honesty and release notes

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `docs/dreaming.md` (changelog entry: shipped state)
- Modify: `docs/superpowers/specs/2026-08-24-dreaming-design.md` only if implementation deviated; record any deviation in both files

**Steps:**

- [ ] **Step 1:** Add a README "Dreaming" subsection under How it works: what it is (two artifacts per run, narrative and insights), off by default and why (it spends model calls in the background), how to turn it on (`[dreaming] enabled = true`, cadence daily or weekly), the four triggers, `reverie dream` and the web Dreams tab, that insights are the model's guesses with per-insight feedback, that nothing is ever rewritten, and the five-reflected-sessions floor. Update the Status section to claim exactly what landed and what did not (per AGENTS.md, overstating status is a serious defect).
- [ ] **Step 2:** Update ROADMAP.md: dreaming v1 shipped; later items (graph writes, relevance ranking, transcript attribution, commitment-aware dreams) pointed at `docs/dreaming.md`.
- [ ] **Step 3:** Run the full suite, build, and lint from the root: `pnpm test && pnpm build && pnpm lint`. Everything green except the one known pre-existing context.test.ts failure.
- [ ] **Step 4: Commit**

```bash
git add README.md ROADMAP.md docs/dreaming.md
git commit -m "docs: dreaming shipped; README and roadmap reflect reality"
```

---

## Plan self-review notes (kept for the executor)

- Spec coverage: storage and log (T1, T7), doc kinds and wiring (T2), selection (T5), pipeline and tool loop (T6, T7), scheduling, lock, triggers, once-per-period (T3, T4, T9), config split (T8), surfacing (T10), feedback both paths (T11, T13, T14), CLI (T12), server (T13), web (T14), README honesty (T15), safety (persona threading T9, tone gate T7, no crisis flag: prompt-level restraint T10).
- Deviations from the spec text, agreed before this plan was executed and recorded in the spec's changelog when Task 15 runs: dream coverage state is derived by folding `dreams/log.jsonl` in memory rather than a SQLite `dream_state` table (the log stays tiny at one dream per period; the table remains a later optimization), and the candidate pool also excludes the `dream` and `dream_insight` kinds (past dreams are context via the digest, never candidates, closing the self-reference loop).
- The exploration cap test in Task 6 pins request counts; if the loop implementation legitimately differs, adjust counts but keep the invariants (exact cap on lookup calls, termination, wrap-up message last).
