# Time as First Class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the companion a real clock: a per-message local time stamp, local calendar day boundaries everywhere a day is computed, and a `profile.md` that holds the person's timezone as a machine-readable fact.

**Architecture:** A new `packages/memory/src/time.ts` holds every pure time function (IANA validation, local date formatting, local day arithmetic, UTC offset capture, stamp rendering) and is the single renderer both the live chat path in `packages/core` and the stored-transcript path in `packages/memory` call. A new `packages/memory/src/profile.ts` defines `profile.md`, its zod schema, and its loader and writer; `MemoryEngine` caches the loaded profile and exposes the timezone to every caller. A migration registry under `packages/memory/src/migrations/` plus a `reverie migrate` subcommand in `packages/cli` seeds `profile.md` into pre-existing memory folders and discards UTC-dated rollups so they rebuild on local-day boundaries.

**Tech Stack:** TypeScript 5.9 (ESM, NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node 22, pnpm workspaces, vitest 3, zod 4, biome 2, `Intl.DateTimeFormat` (Node's built-in IANA database, no external timezone dependency).

**Spec:** docs/superpowers/specs/2026-08-16-time-as-first-class-design.md

## Global Constraints

- Package dependencies are downward-only: `cli` -> `core` -> `memory` -> `providers`, and `server` -> `core` -> `memory` -> `providers`. `cli` and `server` are sibling outer interfaces. Never import upward or sideways.
- `web` talks to `server` over HTTP only and never imports a runtime engine package. Editing `packages/web/src/api.ts` response schemas is allowed; importing `@openreverie/memory` from `web` is not.
- Truth lives in the user's memory folder: markdown prose files plus the append-only `graph.jsonl`. SQLite is a derived index and must always be rebuildable from the folder. Never store anything only in SQLite.
- Transcripts are sacred. Append-only, never modified, never deleted by code. No task in this plan renames, rewrites, or deletes a transcript file or a session directory.
- Relationship claims in prose are testimony, not record. The graph log is the record.
- Model access goes through the provider interfaces in `@openreverie/providers`. Never call a provider SDK or HTTP API directly from another package.
- Both safety modes (companion and firewall) exist by design. Never remove, weaken, or bypass them.
- No telemetry, no analytics, no phoning home. Memory folder contents reach the configured model provider and nowhere else.
- TDD for deterministic logic: write the failing test first, watch it fail, then implement.
- LLM-dependent behavior is tested with fixture transcripts and schema assertions, not golden text.
- Validate all LLM structured output with zod schemas at the boundary.
- Prose file writes are atomic (temp file, then rename, via `writeDocumentAtomic`). Graph log writes are single-line appends.
- Never use an em dash in any prose: comments, error messages, CLI copy, commit messages, docs. Use commas, periods, colons, or parentheses.
- Avoid AI-typical tropes in all prose: "delve", "seamlessly", "robust", "leverage", "streamline", "empower", "unlock", "supercharge", "It's not just X, it's Y", emoji in headings or lists.
- `exactOptionalPropertyTypes` is on. Never write `{ key: undefined }` for an optional property. Use the conditional spread idiom already used in `packages/core/src/agent.ts`: `...(value !== undefined ? { key: value } : {})`.
- `noUncheckedIndexedAccess` is on. Every array index and `.find()` result is `T | undefined` and must be narrowed before use.
- Never use the `TZ` environment variable to control timezone in a test. vitest runs tests with parallelism inside one process and `TZ` is process-wide. Every test passes the IANA zone as a plain string argument.
- Never read a clock inside a function under test. Every such function takes an injected `Date` (or a `() => Date`) and an IANA timezone string.
- Formatting is biome: 2-space indent, single quotes, no semicolons, 100 column line width. Run `npx biome check .` before every commit.
- The README's Status section must reflect reality at all times.

**Non-goal, stated so it is not invented:** spec section 11 asks whether `packages/web` needs its own local-time rendering of transcript timestamps. It does not, in this plan. The only `web` change here is widening one response schema so a new optional field is not rejected. Do not build local-time rendering in the browser UI.

---

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `packages/memory/src/time.ts` | Every pure time function: IANA validation, system zone read, local date formatting, local day arithmetic, UTC offset capture, and the one stamp renderer used by both the live and stored paths. |
| `packages/memory/src/time.test.ts` | Tests for `time.ts`. |
| `packages/memory/src/profile.ts` | `profile.md`: `ProfileMeta`, `profileMetaSchema` (deliberately `.passthrough()`), starter document, `loadProfile`, `writeProfile`. |
| `packages/memory/src/profile.test.ts` | Tests for `profile.ts`. |
| `packages/memory/src/paths.test.ts` | Tests for `memoryPaths` and `ensureMemoryTree`, including profile seeding. |
| `packages/memory/src/migrations/index.ts` | `MigrationContext`, `Migration`, `MigrationResult`, the ordered registry, the `migrations.jsonl` log reader and writer, `listMigrations`, `runMigrations`. |
| `packages/memory/src/migrations/profileSeed.ts` | Migration `profile-seed`: writes `profile.md` into a folder that predates it. |
| `packages/memory/src/migrations/utcToLocalRollups.ts` | Migration `utc-to-local-rollups`: deletes every daily and weekly rollup so they rebuild on local-day boundaries. |
| `packages/memory/src/migrations/migrations.test.ts` | Tests for the registry and both migrations. |
| `packages/cli/src/migrate.ts` | `runMigrate`: the `reverie migrate` subcommand, with `--dry-run` and `--list`. |
| `packages/cli/src/migrate.test.ts` | Tests for `runMigrate`, including the folder-hash dry-run check and idempotency. |

**Modified**

| Path | Change |
| --- | --- |
| `packages/memory/src/paths.ts` | `MemoryPaths` gains `profile` and `migrationsLog`; `ensureMemoryTree` seeds `profile.md`. |
| `packages/memory/src/index.ts` | Re-export `time.js`, `profile.js`, `migrations/index.js`. |
| `packages/memory/src/transcripts.ts` | `TranscriptLine.utcOffsetMinutes`; `SessionStore.sessionDir`; `SessionStore.readFirstLine`; `listSessions` returns `dirName` and a derived logical local `date`; `SessionStore.start` takes a timezone. |
| `packages/memory/src/engine.ts` | Profile cache and accessors; `updateProfile`; `SessionContext` loses `today` and gains `timezone` and `timezoneSource`; local day boundaries; `dirName`-based paths; `remember` carries `eventTime`; reflection's `profileUpdates` applied at session end. |
| `packages/memory/src/rollups.ts` | `buildDailyRollup` builds the summary path from `session.dirName`. |
| `packages/memory/src/reflection.ts` | `renderTranscript` stamps each line; the summary's `date` is derived from the transcript's first line; `ReflectionItem.eventTime`; `profileUpdates` in the output schema and prompt; "their timezone" removed from the identity-fact sentence. |
| `packages/core/src/context.ts` | `todaySection` replaced by `timeSection`; `recentSummariesSection` renders the session id; header comment rewritten. |
| `packages/core/src/agent.ts` | Injectable clock; per-message local stamp in `appendBoth`; `utcOffsetMinutes` on every transcript line; greeting local-time line; `update_profile` reassembly; module comment rewritten. |
| `packages/core/src/tools.ts` | `remember` gains `eventTime`; new `update_profile` tool. |
| `packages/cli/src/index.ts` | `migrate` subcommand wired into `mainWith` and `CliMainDeps`. |
| `packages/server/src/app.ts` | `publicTranscriptLineSchema` accepts `utcOffsetMinutes`. |
| `packages/web/src/api.ts` | `transcriptLineSchema` accepts `utcOffsetMinutes`. |
| `packages/core/src/context.test.ts` | The two `## Today` tests are rewritten against `## Time`. |
| `packages/core/src/agent.test.ts` | The greeting date test is rewritten against the greeting's local-time line; new stamp and prefix-stability tests. |
| `packages/memory/src/transcripts.test.ts` | `listSessions` assertions gain `dirName`; new derived-date tests. |
| `packages/server/src/app.test.ts` | The transcript fixture carries `utcOffsetMinutes`. |
| `README.md` | Status section updated. |

---

### Task 1: The pure time module

**Files:**
- Create: `packages/memory/src/time.ts`
- Test: `packages/memory/src/time.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isValidIanaTimeZone(value: string): boolean`
  - `systemTimeZone(): string`
  - `formatLocalDate(date: Date, timezone: string): string`
  - `addDaysLocal(date: Date, days: number, timezone: string): string`
  - `utcOffsetMinutesFor(date: Date, timezone: string): number`
  - `formatUtcOffset(minutes: number): string`
  - `renderLocalTime(date: Date, timezone: string): string`
  - `renderLiveStamp(date: Date, timezone: string): string`
  - `renderStoredStamp(ts: string, utcOffsetMinutes?: number): string`
  - `localDateFromStored(ts: string, utcOffsetMinutes: number): string`

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/time.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  addDaysLocal,
  formatLocalDate,
  formatUtcOffset,
  isValidIanaTimeZone,
  localDateFromStored,
  renderLiveStamp,
  renderLocalTime,
  renderStoredStamp,
  systemTimeZone,
  utcOffsetMinutesFor,
} from './time.js'

describe('isValidIanaTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidIanaTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidIanaTimeZone('America/New_York')).toBe(true)
    expect(isValidIanaTimeZone('UTC')).toBe(true)
  })

  it('rejects a name Intl does not recognize', () => {
    expect(isValidIanaTimeZone('Nowhere/Fake')).toBe(false)
    expect(isValidIanaTimeZone('')).toBe(false)
  })
})

describe('systemTimeZone', () => {
  it('always returns a non-empty zone that validates', () => {
    const zone = systemTimeZone()
    expect(zone.length).toBeGreaterThan(0)
    expect(isValidIanaTimeZone(zone)).toBe(true)
  })
})

describe('formatLocalDate', () => {
  it('reports the local calendar day, not the UTC one, east of UTC', () => {
    expect(formatLocalDate(new Date('2026-08-16T20:12:00Z'), 'Asia/Kolkata')).toBe('2026-08-17')
  })

  it('reports the local calendar day, not the UTC one, west of UTC', () => {
    expect(formatLocalDate(new Date('2026-08-17T02:30:00Z'), 'America/New_York')).toBe('2026-08-16')
  })

  it('matches the UTC day when the zone is UTC', () => {
    expect(formatLocalDate(new Date('2026-08-16T20:12:00Z'), 'UTC')).toBe('2026-08-16')
  })
})

describe('addDaysLocal', () => {
  it('subtracts days from the local calendar day', () => {
    expect(addDaysLocal(new Date('2026-08-16T20:12:00Z'), -7, 'Asia/Kolkata')).toBe('2026-08-10')
  })

  it('adds days across a month boundary', () => {
    expect(addDaysLocal(new Date('2026-08-30T20:12:00Z'), 3, 'Asia/Kolkata')).toBe('2026-09-03')
  })

  it('adds zero days and returns the local day itself', () => {
    expect(addDaysLocal(new Date('2026-08-16T20:12:00Z'), 0, 'Asia/Kolkata')).toBe('2026-08-17')
  })
})

describe('utcOffsetMinutesFor', () => {
  it('reports a positive offset east of UTC', () => {
    expect(utcOffsetMinutesFor(new Date('2026-08-16T20:12:00Z'), 'Asia/Kolkata')).toBe(330)
  })

  it('reports a negative offset west of UTC', () => {
    expect(utcOffsetMinutesFor(new Date('2026-08-16T20:12:00Z'), 'America/New_York')).toBe(-240)
  })

  it('reports zero for UTC', () => {
    expect(utcOffsetMinutesFor(new Date('2026-08-16T20:12:00Z'), 'UTC')).toBe(0)
  })
})

describe('formatUtcOffset', () => {
  it('formats a positive half-hour offset', () => {
    expect(formatUtcOffset(330)).toBe('UTC+05:30')
  })

  it('formats a negative whole-hour offset', () => {
    expect(formatUtcOffset(-300)).toBe('UTC-05:00')
  })

  it('formats zero as a positive offset', () => {
    expect(formatUtcOffset(0)).toBe('UTC+00:00')
  })
})

describe('renderLocalTime and renderLiveStamp', () => {
  it('renders weekday, local date, 24-hour local time, and the zone name', () => {
    const at = new Date('2026-08-16T20:00:00Z')
    expect(renderLocalTime(at, 'Asia/Kolkata')).toBe('Mon 2026-08-17 01:30 Asia/Kolkata')
    expect(renderLiveStamp(at, 'Asia/Kolkata')).toBe('[Mon 2026-08-17 01:30 Asia/Kolkata]')
  })

  it('renders local midnight as 00:00, never as 24:00', () => {
    expect(renderLocalTime(new Date('2026-08-16T18:30:00Z'), 'Asia/Kolkata')).toBe(
      'Mon 2026-08-17 00:00 Asia/Kolkata',
    )
  })
})

describe('renderStoredStamp', () => {
  it('renders the wall clock that was in effect, using the stored offset', () => {
    expect(renderStoredStamp('2026-08-16T16:12:00.000Z', 330)).toBe('[Sun 2026-08-16 21:42 UTC+05:30]')
  })

  it('renders a labeled UTC instant when the offset is absent, and never guesses a local time', () => {
    expect(renderStoredStamp('2026-08-14T09:03:11Z')).toBe(
      '[2026-08-14T09:03:11Z (UTC; local time unknown)]',
    )
  })

  it('falls back to the labeled UTC form when ts is not a parseable instant', () => {
    expect(renderStoredStamp('not-a-date', 330)).toBe('[not-a-date (UTC; local time unknown)]')
  })
})

describe('localDateFromStored', () => {
  it('derives the local calendar day from a UTC instant and its stored offset', () => {
    expect(localDateFromStored('2026-08-16T20:12:00.000Z', 330)).toBe('2026-08-17')
    expect(localDateFromStored('2026-08-17T02:30:00.000Z', -300)).toBe('2026-08-16')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/time.test.ts`

Expected: FAIL. The run reports `Failed to load url ./time.js` (or `Cannot find module './time.js'`) because `packages/memory/src/time.ts` does not exist yet, and `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/memory/src/time.ts`:

```typescript
// Local wall-clock time: the calendar helpers every day boundary in the
// memory folder is computed from, and the one stamp renderer both the live
// chat path and the stored transcript path use.
//
// Nothing in this file reads a clock. Every function takes the instant it
// works from, and the IANA timezone it renders that instant in, as plain
// arguments. That is what lets a test pin both without touching the TZ
// environment variable, which is process-wide and would race any other test
// running in the same process.
//
// Node's built-in Intl carries the IANA database, so no external timezone
// dependency is needed for any of this.

export function isValidIanaTimeZone(value: string): boolean {
  if (value.length === 0) return false
  try {
    // Constructing a formatter with an unrecognized zone throws RangeError.
    // That throw is the validation; there is nothing to read off the result.
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// The zone of the machine reverie is running on. Always returns something,
// worst case 'UTC' on a misconfigured machine. This is a guess about where
// the person is, never a fact they confirmed.
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// en-CA formats a date as YYYY-MM-DD directly, which is the form every
// session date, rollup date, and summary frontmatter date in this codebase
// already uses.
export function formatLocalDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// Pure calendar arithmetic on local digits. Date.UTC is used as the
// arithmetic engine, not as an instant: the value it produces is a scratch
// calculation whose year/month/day are read straight back out, so no
// timezone conversion happens between writing and reading it.
export function addDaysLocal(date: Date, days: number, timezone: string): string {
  const parts = formatLocalDate(date, timezone).split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  const shiftedYear = shifted.getUTCFullYear()
  const shiftedMonth = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const shiftedDay = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`
}

interface LocalParts {
  weekday: string
  year: string
  month: string
  day: string
  hour: string
  minute: string
}

// hourCycle: 'h23' rather than hour12: false. The latter renders local
// midnight as 24:00 in some locales, which would put a stamp on the wrong
// calendar day at exactly the boundary this spec exists to get right.
function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    weekday: pick('weekday'),
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
  }
}

export function utcOffsetMinutesFor(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  const asIfUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
  )
  // The formatted parts carry no milliseconds, so drop them from the real
  // instant too before differencing; otherwise the result is off by a
  // fraction of a minute and rounds unpredictably at the boundary.
  const actual = Math.floor(date.getTime() / 1000) * 1000
  return Math.round((asIfUtc - actual) / 60000)
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const rest = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${rest}`
}

// The live path knows the person's IANA zone, so it renders the zone name.
export function renderLocalTime(date: Date, timezone: string): string {
  const parts = localParts(date, timezone)
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timezone}`
}

export function renderLiveStamp(date: Date, timezone: string): string {
  return `[${renderLocalTime(date, timezone)}]`
}

const UNKNOWN_LOCAL_SUFFIX = '(UTC; local time unknown)'

// The stored path knows only the instant and the offset that was in effect
// when the line was written, so it renders the offset rather than a zone
// name. A missing offset means genuinely unknown: this renders the plain
// UTC instant and never computes a local time from a timezone the line does
// not actually carry.
export function renderStoredStamp(ts: string, utcOffsetMinutes?: number): string {
  if (utcOffsetMinutes === undefined) {
    return `[${ts} ${UNKNOWN_LOCAL_SUFFIX}]`
  }
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) {
    return `[${ts} ${UNKNOWN_LOCAL_SUFFIX}]`
  }
  // A fixed offset is not an IANA zone name, and the Etc/GMT zones only
  // cover whole hours, so half-hour offsets like +05:30 have no zone to
  // format against. Shifting the instant by the offset and formatting the
  // result in UTC produces exactly the wall-clock digits that were in
  // effect when the line was written.
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60000)
  const parts = localParts(shifted, 'UTC')
  return `[${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${formatUtcOffset(utcOffsetMinutes)}]`
}

// The local calendar day a stored line belongs to, from its own instant and
// its own recorded offset. Same shifting trick as renderStoredStamp, and
// the same reason.
export function localDateFromStored(ts: string, utcOffsetMinutes: number): string {
  const date = new Date(ts)
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60000)
  return formatLocalDate(shifted, 'UTC')
}
```

- [ ] **Step 4: Export the module**

In `packages/memory/src/index.ts`, add `export * from './time.js'` so the list stays alphabetical:

```typescript
export * from './sqlite.js'
export * from './time.js'
export * from './transcripts.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/time.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 6: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 7: Commit**
```bash
git add packages/memory/src/time.ts packages/memory/src/time.test.ts packages/memory/src/index.ts
git commit -m "Add pure local-time helpers in memory: local dates, UTC offsets, and stamp rendering"
```

---

### Task 2: `profile.md` schema, loader, and writer

**Files:**
- Create: `packages/memory/src/profile.ts`
- Test: `packages/memory/src/profile.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces:**
- Consumes: `isValidIanaTimeZone(value: string): boolean` and `systemTimeZone(): string` from Task 1. `readDocument(path: string): Promise<Document>`, `writeDocumentAtomic(doc: Document): Promise<void>`, `newId(prefix: IdPrefix): string` from `packages/memory/src/documents.ts`. `MemoryPaths` from `packages/memory/src/paths.ts` (its `profile` field is added in Task 3; this task types against it, so Task 3 must land before `loadProfile` is called anywhere, which it is).
- Produces:
  - `interface ProfileMeta { id: string; timezone?: string; timezoneSource?: 'system-default' | 'user-confirmed' }`
  - `interface Profile { meta: ProfileMeta & { [key: string]: unknown }; body: string }`
  - `const profileMetaSchema` (a zod object with `.passthrough()`)
  - `const PROFILE_STARTER_BODY: string`
  - `starterProfileDocument(path: string, timezone: string): { path: string; meta: ProfileMeta & { [key: string]: unknown }; body: string }`
  - `loadProfile(paths: MemoryPaths): Promise<Profile>`
  - `writeProfile(paths: MemoryPaths, profile: Profile): Promise<void>`

**Note on ordering:** this task adds `profile.ts` but `MemoryPaths` does not yet have a `profile` field. Add the field to `packages/memory/src/paths.ts` as the very first edit of Step 3 below (one line in the interface, one line in `memoryPaths`), then write `profile.ts`. The seeding of the file in `ensureMemoryTree` is Task 3.

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/profile.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryPaths, type MemoryPaths } from './paths.js'
import { loadProfile, profileMetaSchema, starterProfileDocument, writeProfile } from './profile.js'

describe('profileMetaSchema', () => {
  it('accepts a valid IANA timezone', () => {
    const result = profileMetaSchema.safeParse({
      id: 'doc_1',
      timezone: 'Asia/Kolkata',
      timezoneSource: 'user-confirmed',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a timezone Intl does not recognize', () => {
    const result = profileMetaSchema.safeParse({ id: 'doc_1', timezone: 'Nowhere/Fake' })
    expect(result.success).toBe(false)
  })

  it('rejects a timezoneSource outside the two known values', () => {
    const result = profileMetaSchema.safeParse({ id: 'doc_1', timezoneSource: 'guessed' })
    expect(result.success).toBe(false)
  })

  it('passes an unknown key through untouched instead of stripping or rejecting it', () => {
    const result = profileMetaSchema.safeParse({
      id: 'doc_1',
      timezone: 'Asia/Kolkata',
      pronouns: 'she/her',
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: 'doc_1', timezone: 'Asia/Kolkata', pronouns: 'she/her' })
  })

  it('accepts a document with no timezone at all', () => {
    const result = profileMetaSchema.safeParse({ id: 'doc_1' })
    expect(result.success).toBe(true)
  })
})

describe('loadProfile and writeProfile', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-profile-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a written profile', async () => {
    await writeProfile(paths, {
      meta: { id: 'doc_profile', timezone: 'Asia/Kolkata', timezoneSource: 'user-confirmed' },
      body: 'Machine managed.\n',
    })

    const loaded = await loadProfile(paths)
    expect(loaded.meta.timezone).toBe('Asia/Kolkata')
    expect(loaded.meta.timezoneSource).toBe('user-confirmed')
    expect(loaded.meta.id).toBe('doc_profile')
  })

  it('returns an in-memory system-default profile when the file does not exist, and writes nothing', async () => {
    const loaded = await loadProfile(paths)
    expect(loaded.meta.timezoneSource).toBe('system-default')
    expect(typeof loaded.meta.timezone).toBe('string')
    await expect(rm(paths.profile)).rejects.toThrow()
  })

  it('reports a schema failure against the path it came from', async () => {
    await writeFile(paths.profile, '---\nid: doc_x\ntimezone: Nowhere/Fake\n---\nBody.\n', 'utf8')
    await expect(loadProfile(paths)).rejects.toThrow(paths.profile)
  })

  it('keeps an unknown frontmatter key across a load and a rewrite', async () => {
    await writeFile(
      paths.profile,
      '---\nid: doc_x\ntimezone: Asia/Kolkata\npronouns: she/her\n---\nBody.\n',
      'utf8',
    )
    const loaded = await loadProfile(paths)
    expect(loaded.meta.pronouns).toBe('she/her')

    await writeProfile(paths, {
      meta: { ...loaded.meta, timezone: 'America/New_York' },
      body: loaded.body,
    })
    const reloaded = await loadProfile(paths)
    expect(reloaded.meta.pronouns).toBe('she/her')
    expect(reloaded.meta.timezone).toBe('America/New_York')
  })

  it('builds a starter document carrying the given zone as a system default', () => {
    const doc = starterProfileDocument(paths.profile, 'Asia/Kolkata')
    expect(doc.meta.timezone).toBe('Asia/Kolkata')
    expect(doc.meta.timezoneSource).toBe('system-default')
    expect(doc.meta.id.startsWith('doc_')).toBe(true)
    expect(doc.body.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/profile.test.ts`

Expected: FAIL. The run reports `Failed to load url ./profile.js` (or `Cannot find module './profile.js'`), and `Test Files  1 failed (1)`.

- [ ] **Step 3: Add the `profile` path, then write the module**

First, in `packages/memory/src/paths.ts`, add `profile` to the interface right after `constitution`:

```typescript
export interface MemoryPaths {
  root: string
  constitution: string
  profile: string
  realmsDir: string
  arcsDir: string
  peopleDir: string
  sessionsDir: string
  rollupsDailyDir: string
  rollupsWeeklyDir: string
  graphLog: string
  proposals: string
  indexDb: string
}
```

and the matching line in `memoryPaths`:

```typescript
export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    constitution: join(root, 'constitution.md'),
    profile: join(root, 'profile.md'),
    realmsDir: join(root, 'realms'),
    arcsDir: join(root, 'arcs'),
    peopleDir: join(root, 'people'),
    sessionsDir: join(root, 'sessions'),
    rollupsDailyDir: join(root, 'rollups', 'daily'),
    rollupsWeeklyDir: join(root, 'rollups', 'weekly'),
    graphLog: join(root, 'graph.jsonl'),
    proposals: join(root, 'proposals.jsonl'),
    indexDb: join(root, 'index.db'),
  }
}
```

Then create `packages/memory/src/profile.ts`:

```typescript
// profile.md: structured personal facts about the person, at the memory
// folder root beside constitution.md.
//
// Three files hold facts about the person and the line between them is
// drawn deliberately. config.toml is infrastructure (provider, models,
// memory folder, safety mode) and is validated with z.strictObject, which
// rejects unknown keys on purpose. constitution.md is meaning: prose
// testimony about who the person is, never a reliable machine-parseable
// source. profile.md is the machine-readable middle: fields a piece of code
// has to read back out and feed to something, starting with the timezone
// that Intl.DateTimeFormat needs.
//
// The schema here is deliberately NOT strict. Config is a closed set of
// knobs where an unknown key is almost always a typo worth rejecting hard.
// Profile is an open, growing set of personal facts, so an unrecognized or
// forward-written key is passed through untyped rather than making the file
// fail to load, matching the [key: string]: unknown posture DocumentMeta
// already takes for every other document in the folder.

import { z } from 'zod'
import { newId, readDocument, writeDocumentAtomic } from './documents.js'
import type { MemoryPaths } from './paths.js'
import { isValidIanaTimeZone, systemTimeZone } from './time.js'

export interface ProfileMeta {
  id: string
  timezone?: string
  timezoneSource?: 'system-default' | 'user-confirmed'
}

export interface Profile {
  meta: ProfileMeta & { [key: string]: unknown }
  body: string
}

export const profileMetaSchema = z
  .object({
    id: z.string(),
    timezone: z
      .string()
      .refine(isValidIanaTimeZone, { message: 'is not a recognized IANA timezone' })
      .optional(),
    timezoneSource: z.enum(['system-default', 'user-confirmed']).optional(),
  })
  .passthrough()

export const PROFILE_STARTER_BODY = `This file holds structured facts about you that reverie needs to read back
out in code, starting with your timezone. It is machine managed and safe to
hand edit; keep the frontmatter valid YAML.
`

export function starterProfileDocument(
  path: string,
  timezone: string,
): { path: string; meta: ProfileMeta & { [key: string]: unknown }; body: string } {
  return {
    path,
    meta: { id: newId('doc'), timezone, timezoneSource: 'system-default' },
    body: PROFILE_STARTER_BODY,
  }
}

// A folder created after this shipped always has profile.md, because
// ensureMemoryTree seeds it. A folder that predates it does not, and
// `reverie migrate` is what writes one. Until that runs, this returns an
// in-memory system default and writes nothing: a read must never have a
// write as a side effect.
export async function loadProfile(paths: MemoryPaths): Promise<Profile> {
  let raw: Awaited<ReturnType<typeof readDocument>>
  try {
    raw = await readDocument(paths.profile)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return {
        meta: { id: newId('doc'), timezone: systemTimeZone(), timezoneSource: 'system-default' },
        body: PROFILE_STARTER_BODY,
      }
    }
    throw err
  }

  const parsed = profileMetaSchema.safeParse(raw.meta)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Profile at ${paths.profile} is not valid: ${detail}`)
  }

  return { meta: parsed.data as ProfileMeta & { [key: string]: unknown }, body: raw.body }
}

export async function writeProfile(paths: MemoryPaths, profile: Profile): Promise<void> {
  await writeDocumentAtomic({ path: paths.profile, meta: profile.meta, body: profile.body })
}
```

- [ ] **Step 4: Export the module**

In `packages/memory/src/index.ts`, add `export * from './profile.js'` keeping the list alphabetical:

```typescript
export * from './paths.js'
export * from './profile.js'
export * from './proposals.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/profile.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 6: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 7: Commit**
```bash
git add packages/memory/src/profile.ts packages/memory/src/profile.test.ts packages/memory/src/paths.ts packages/memory/src/index.ts
git commit -m "Add profile.md: schema, loader, and atomic writer for structured personal facts"
```

---

### Task 3: `ensureMemoryTree` seeds `profile.md`

**Files:**
- Modify: `packages/memory/src/paths.ts:41-69`
- Test: `packages/memory/src/paths.test.ts` (create)

**Interfaces:**
- Consumes: `starterProfileDocument(path: string, timezone: string)` and `PROFILE_STARTER_BODY` from Task 2; `systemTimeZone(): string` from Task 1.
- Produces: `ensureMemoryTree(paths: MemoryPaths): Promise<void>` now guarantees `paths.profile` exists after it returns.

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/paths.test.ts`:

```typescript
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMemoryTree, memoryPaths, type MemoryPaths } from './paths.js'
import { loadProfile } from './profile.js'
import { isValidIanaTimeZone } from './time.js'

describe('ensureMemoryTree', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-paths-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('seeds profile.md with a system-default timezone on a brand new folder', async () => {
    await ensureMemoryTree(paths)

    const profile = await loadProfile(paths)
    expect(profile.meta.timezoneSource).toBe('system-default')
    expect(typeof profile.meta.timezone).toBe('string')
    expect(isValidIanaTimeZone(profile.meta.timezone as string)).toBe(true)
    expect(profile.body.trim().length).toBeGreaterThan(0)
  })

  it('leaves an existing profile.md exactly as it is', async () => {
    await ensureMemoryTree(paths)
    const first = await readFile(paths.profile, 'utf8')

    await ensureMemoryTree(paths)
    const second = await readFile(paths.profile, 'utf8')

    expect(second).toBe(first)
  })

  it('still seeds the constitution and the gitignore', async () => {
    await ensureMemoryTree(paths)
    expect((await readFile(paths.constitution, 'utf8')).length).toBeGreaterThan(0)
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('index.db\n*.tmp-*\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/paths.test.ts`

Expected: FAIL on the first test, with `AssertionError: expected undefined to be 'system-default'` (the loader falls back to an in-memory default because `ensureMemoryTree` never wrote the file). `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/paths.ts`, add the imports and the seeding block. The full `ensureMemoryTree` becomes:

```typescript
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newId, writeDocumentAtomic } from './documents.js'
import { starterProfileDocument } from './profile.js'
import { systemTimeZone } from './time.js'
```

```typescript
export async function ensureMemoryTree(paths: MemoryPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true })
  for (const dir of [
    paths.realmsDir,
    paths.arcsDir,
    paths.peopleDir,
    paths.sessionsDir,
    paths.rollupsDailyDir,
    paths.rollupsWeeklyDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }

  const constitutionExists = await pathExists(paths.constitution)
  if (!constitutionExists) {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: CONSTITUTION_STARTER,
    })
  }

  // Unlike the constitution's starter (an empty sentence, since a person's
  // identity is unknown when a folder is created), the profile starter is
  // not empty: it carries the timezone of the machine reverie is running
  // on, marked as a system default rather than a fact the person
  // confirmed. That is what gives the per-message time stamp something to
  // render from in the very first session.
  const profileExists = await pathExists(paths.profile)
  if (!profileExists) {
    await writeDocumentAtomic(starterProfileDocument(paths.profile, systemTimeZone()))
  }

  // Seed .gitignore to exclude the SQLite index and atomic-write temp files
  const gitignorePath = join(paths.root, '.gitignore')
  const gitignoreExists = await pathExists(gitignorePath)
  if (!gitignoreExists) {
    await writeFile(gitignorePath, 'index.db\n*.tmp-*\n', 'utf8')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/paths.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/paths.ts packages/memory/src/paths.test.ts
git commit -m "Seed profile.md with the machine timezone when a memory folder is created"
```

---

### Task 4: `MemoryEngine` caches the profile and can update it

**Files:**
- Modify: `packages/memory/src/engine.ts:204-268` (fields, constructor, `open`) and the private helpers section
- Test: `packages/memory/src/engine.test.ts` (append a new `describe` block at the end of the file)

**Interfaces:**
- Consumes: `loadProfile(paths)`, `writeProfile(paths, profile)`, `Profile`, `ProfileMeta` from Task 2; `isValidIanaTimeZone`, `systemTimeZone` from Task 1.
- Produces, on `MemoryEngine`:
  - `profile(): Profile` (synchronous, returns the cached copy)
  - `timezone(): string` (the cached zone, or the machine zone when the profile carries none)
  - `timezoneSource(): 'system-default' | 'user-confirmed'`
  - `updateProfile(patch: { timezone?: string }): Promise<Profile>` (validates, writes atomically, refreshes the cache, returns the new profile)

**Ordering note, do not skip:** the profile must be loaded and handed to the constructor *before* `runMaintenance()` runs inside `open()`. Task 8 makes `runMaintenance` read `this.timezone()`, and a profile loaded after that call would be too late.

- [ ] **Step 1: Write the failing test**

Append to the end of `packages/memory/src/engine.test.ts`. The file already imports `mkdtemp`, `rm`, `tmpdir`, `join`, `FakeChatProvider`, `FakeEmbeddingProvider`, `MemoryEngine`, `memoryPaths`, `ensureMemoryTree`, and vitest's helpers; add `loadProfile` to the `./profile.js` import list by adding a new import line at the top of the file:

```typescript
import { loadProfile } from './profile.js'
```

Then append this block at the end of the file:

```typescript
describe('MemoryEngine profile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-profile-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('caches the seeded profile on open and reports it as a system default', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })

    expect(engine.timezoneSource()).toBe('system-default')
    expect(typeof engine.timezone()).toBe('string')
    expect(engine.timezone().length).toBeGreaterThan(0)

    await engine.close()
  })

  it('updateProfile writes a confirmed timezone to disk and refreshes the cached copy', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })

    const updated = await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    expect(updated.meta.timezone).toBe('Asia/Kolkata')
    expect(engine.timezone()).toBe('Asia/Kolkata')
    expect(engine.timezoneSource()).toBe('user-confirmed')

    const onDisk = await loadProfile(memoryPaths(dir))
    expect(onDisk.meta.timezone).toBe('Asia/Kolkata')
    expect(onDisk.meta.timezoneSource).toBe('user-confirmed')

    await engine.close()
  })

  it('updateProfile rejects a timezone Intl does not recognize and leaves the cache untouched', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    const before = engine.timezone()

    await expect(engine.updateProfile({ timezone: 'Nowhere/Fake' })).rejects.toThrow(
      'Nowhere/Fake',
    )
    expect(engine.timezone()).toBe(before)

    await engine.close()
  })

  it('updateProfile keeps unrelated frontmatter keys that were already in the file', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    const seeded = await loadProfile(paths)
    await writeProfile(paths, { meta: { ...seeded.meta, pronouns: 'she/her' }, body: seeded.body })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'Europe/Berlin' })

    const onDisk = await loadProfile(paths)
    expect(onDisk.meta.pronouns).toBe('she/her')
    expect(onDisk.meta.timezone).toBe('Europe/Berlin')

    await engine.close()
  })
})
```

Add `writeProfile` to the import line you created: `import { loadProfile, writeProfile } from './profile.js'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/engine.test.ts -t "MemoryEngine profile"`

Expected: FAIL with `TypeError: engine.timezoneSource is not a function` on the first test in the block. `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/engine.ts`, add the import:

```typescript
import { loadProfile, type Profile, writeProfile } from './profile.js'
import { isValidIanaTimeZone, systemTimeZone } from './time.js'
```

Add the field beside the other cached state (near `private docIdByPath = new Map<string, string>()`):

```typescript
  // The loaded profile.md, cached for cheap synchronous reads the same way
  // graphState and docPaths are. Source of truth is the file; this copy is
  // refreshed on every write that touches it, so the next read inside this
  // process sees the new value without a second file read racing the first.
  private profileCache: Profile
```

Change the constructor to take it:

```typescript
  private constructor(
    paths: MemoryPaths,
    deps: EngineDeps,
    index: MemoryIndex,
    graphState: GraphState,
    profile: Profile,
  ) {
    this.paths = paths
    this.deps = deps
    this.index = index
    this.graphState = graphState
    this.profileCache = profile
  }
```

In `open`, load the profile after `ensureMemoryTree` (which seeds it) and before the engine is constructed, so `runMaintenance` below already has a timezone to read:

```typescript
  static async open(
    root: string,
    deps: EngineDeps,
    options: MemoryEngineOpenOptions = {},
  ): Promise<MemoryEngine> {
    const paths = memoryPaths(root)
    await ensureMemoryTree(paths)
    const index = MemoryIndex.open(paths.indexDb)
    const graphState = await readGraph(paths)
    index.replaceGraph(graphState)
    // Loaded before the engine is constructed, and therefore before
    // runMaintenance() runs below: maintenance computes local calendar days
    // from this timezone, so a profile loaded after it would be too late.
    const profile = await loadProfile(paths)
    const engine = new MemoryEngine(paths, deps, index, graphState, profile)
    engine.clearWarnings()
```

(the rest of `open` is unchanged.)

Add the public accessors next to the other public methods, for example right after `close()`:

```typescript
  profile(): Profile {
    return this.profileCache
  }

  // Every caller that needs a zone goes through here rather than reading
  // the optional field itself, so there is exactly one place that decides
  // what happens when profile.md carries no timezone: fall back to the
  // machine's own zone, which Intl always answers with.
  timezone(): string {
    const stored = this.profileCache.meta.timezone
    return typeof stored === 'string' && stored.length > 0 ? stored : systemTimeZone()
  }

  timezoneSource(): 'system-default' | 'user-confirmed' {
    return this.profileCache.meta.timezoneSource === 'user-confirmed'
      ? 'user-confirmed'
      : 'system-default'
  }

  // Writes a confirmed personal fact into profile.md and refreshes the
  // cached copy. Called by the live update_profile tool and by reflection's
  // profileUpdates backstop; both are the person telling us, so the source
  // is always 'user-confirmed'.
  async updateProfile(patch: { timezone?: string }): Promise<Profile> {
    const current = this.profileCache
    const meta: Profile['meta'] = { ...current.meta }
    if (patch.timezone !== undefined) {
      if (!isValidIanaTimeZone(patch.timezone)) {
        throw new Error(`"${patch.timezone}" is not a recognized IANA timezone name.`)
      }
      meta.timezone = patch.timezone
      meta.timezoneSource = 'user-confirmed'
    }
    const next: Profile = { meta, body: current.body }
    await writeProfile(this.paths, next)
    this.profileCache = next
    return next
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/engine.test.ts -t "MemoryEngine profile"`

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Cache the profile on MemoryEngine and add updateProfile"
```

---

### Task 5: `listSessions` returns `dirName`, and every path is built from it

**Files:**
- Modify: `packages/memory/src/transcripts.ts:140-177` and `199-206`
- Modify: `packages/memory/src/engine.ts:591-595` and `1181-1186`
- Modify: `packages/memory/src/rollups.ts:123-132`
- Test: `packages/memory/src/transcripts.test.ts:89-142`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SessionStore.listSessions(paths: MemoryPaths): Promise<{ sessionId: string; dirName: string; date: string; reflected: boolean; skipped: boolean }[]>`
  - `SessionStore.sessionDir(paths: MemoryPaths, sessionId: string): Promise<string>`

This task changes no behavior. `date` is still read off the directory prefix; the point is that after it, `dirName` is the only value anything builds a path from, so Task 12 can make `date` diverge from the prefix safely. Landing Task 12 before this one would create a second session directory beside the real one on the write path, which is why this task comes first.

- [ ] **Step 1: Update the existing `listSessions` tests so they demand `dirName`**

In `packages/memory/src/transcripts.test.ts`, replace the three `toEqual` assertions. The first test becomes:

```typescript
  it('listSessions reports reflected false before and true after summary.md is written', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)
    await store.appendLine({ ts: now.toISOString(), role: 'user', content: 'hello' })

    const before = await SessionStore.listSessions(paths)
    expect(before).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-13-${store.sessionId}`,
        date: '2026-08-13',
        reflected: false,
        skipped: false,
      },
    ])

    await writeFile(join(store.dir, 'summary.md'), '---\nid: doc_x\n---\nSummary text.\n', 'utf8')

    const after = await SessionStore.listSessions(paths)
    expect(after).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-13-${store.sessionId}`,
        date: '2026-08-13',
        reflected: true,
        skipped: false,
      },
    ])
  })
```

The second becomes:

```typescript
  it('listSessions returns multiple sessions sorted by directory name', async () => {
    const first = await SessionStore.start(paths, new Date('2026-08-13T09:00:00Z'))
    const second = await SessionStore.start(paths, new Date('2026-08-14T09:00:00Z'))

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      {
        sessionId: first.sessionId,
        dirName: `2026-08-13-${first.sessionId}`,
        date: '2026-08-13',
        reflected: false,
        skipped: false,
      },
      {
        sessionId: second.sessionId,
        dirName: `2026-08-14-${second.sessionId}`,
        date: '2026-08-14',
        reflected: false,
        skipped: false,
      },
    ])
  })
```

The third becomes:

```typescript
  it('listSessions reports skipped true when the summary carries skipped: true in its frontmatter', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    await writeFile(
      join(store.dir, 'summary.md'),
      '---\nid: doc_x\nskipped: true\nreason: no user messages in this session\n---\nNothing happened.\n',
      'utf8',
    )

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-13-${store.sessionId}`,
        date: '2026-08-13',
        reflected: true,
        skipped: true,
      },
    ])
  })
```

Then add a new test right after them:

```typescript
  it('sessionDir resolves a session directory by its id suffix, never by its date prefix', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-13T21:04:11Z'))

    const dir = await SessionStore.sessionDir(paths, store.sessionId)
    expect(dir).toBe(join(paths.sessionsDir, `2026-08-13-${store.sessionId}`))

    await expect(SessionStore.sessionDir(paths, 'session_nope')).rejects.toThrow(
      'No session directory found for session_nope',
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/transcripts.test.ts`

Expected: FAIL. Three assertion failures reporting the returned objects are missing `dirName`, plus `TypeError: SessionStore.sessionDir is not a function`. `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/transcripts.ts`, expose the directory resolver as a static and widen `listSessions`:

```typescript
  // The one way anything resolves a session directory from an id. It
  // matches on the id suffix and never on the date prefix, which is what
  // lets the prefix be treated as an opaque disambiguator rather than a
  // claim about which calendar day the session belongs to.
  static async sessionDir(paths: MemoryPaths, sessionId: string): Promise<string> {
    return findSessionDir(paths, sessionId)
  }

  static async listSessions(paths: MemoryPaths): Promise<
    {
      sessionId: string
      dirName: string
      date: string
      reflected: boolean
      skipped: boolean
    }[]
  > {
    const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
    const dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    const sessions: {
      sessionId: string
      dirName: string
      date: string
      reflected: boolean
      skipped: boolean
    }[] = []
    for (const dirName of dirNames) {
      const match = dirName.match(SESSION_DIR_PATTERN)
      if (!match) continue
      const date = match[1] as string
      const sessionId = match[2] as string
      const summaryPath = join(paths.sessionsDir, dirName, SUMMARY_FILE)
      const reflected = await pathExists(summaryPath)
      // A session only ever counts as skipped when its summary is both
      // present and explicitly marked that way: this is the single place
      // every consumer (recentSummaries, isFirstSession, rollup dates,
      // search indexing) reads that distinction from, instead of each one
      // re-reading summary.md's frontmatter itself.
      let skipped = false
      if (reflected) {
        try {
          const doc = await readDocument(summaryPath)
          skipped = doc.meta.skipped === true
        } catch {
          // A summary.md that fails to parse is reflected (it exists) but
          // its skipped status is unknowable; treat it as not skipped
          // rather than throwing listSessions out for every caller.
          skipped = false
        }
      }
      // dirName is the directory exactly as readdir produced it. It is the
      // only value here that may ever be used to build a path. date is for
      // windowing, grouping, and display only.
      sessions.push({ sessionId, dirName, date, reflected, skipped })
    }
    return sessions
  }
```

In `packages/memory/src/engine.ts`, `sessionContext` (currently lines 591-595) builds the summary path from `dirName`:

```typescript
    for (const session of recentCandidates) {
      const summaryPath = join(this.paths.sessionsDir, session.dirName, 'summary.md')
      const doc = await readDocument(summaryPath)
```

In `packages/memory/src/engine.ts`, `writeSkippedSummary` (currently lines 1181-1186) stops reconstructing the path entirely:

```typescript
  private async writeSkippedSummary(sessionId: string, now: Date): Promise<void> {
    const sessions = await SessionStore.listSessions(this.paths)
    const session = sessions.find((s) => s.sessionId === sessionId)
    const date = session?.date ?? formatDateUTC(now)
    // Resolved by id suffix, never rebuilt from the date. A derived date
    // that differs from the directory prefix would otherwise create a
    // second directory beside the real one, holding a summary for a session
    // whose transcript lives elsewhere, which makes that session look
    // permanently unreflected and get retried forever.
    const dir = await SessionStore.sessionDir(this.paths, sessionId)
    const summaryPath = join(dir, 'summary.md')
```

(the rest of `writeSkippedSummary` is unchanged; `date` is still written into the summary frontmatter.)

In `packages/memory/src/rollups.ts`, `buildDailyRollup` (currently lines 123-132):

```typescript
  const summaries: string[] = []
  for (const session of daySessions) {
    const summaryPath = join(deps.paths.sessionsDir, session.dirName, 'summary.md')
    const summary = await readDocument(summaryPath)
    summaries.push(summary.body.trim())
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/transcripts.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/transcripts.ts packages/memory/src/transcripts.test.ts packages/memory/src/engine.ts packages/memory/src/rollups.ts
git commit -m "Return dirName from listSessions and build every session path from it"
```

---

### Task 6: `AgentSession` takes an injectable clock

**Files:**
- Modify: `packages/core/src/agent.ts:127-173` and `354-366`
- Test: `packages/core/src/agent.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentSession.start(engine: MemoryEngine, config: ReverieConfig, chat: ChatProvider, toolDeps?: ToolDeps, options?: { now?: () => Date }): Promise<AgentSession>`. The clock defaults to `() => new Date()`, so both existing call sites (`packages/cli/src/chat.ts:175` and `packages/server/src/registry.ts:149`) keep working unchanged.

This task changes no behavior. It exists so the three tasks that follow can pin the clock without touching global state.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/agent.test.ts`, inside the existing `describe('AgentSession', ...)` block:

```typescript
  it('writes transcript timestamps from the injected clock rather than the real one', async () => {
    const chat = new FakeChatProvider([{ text: 'Noted.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('Hello.'))

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((line) => line.ts)).toEqual([
      '2026-08-16T20:00:00.000Z',
      '2026-08-16T20:00:00.000Z',
    ])

    await engine.close()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/agent.test.ts -t "writes transcript timestamps from the injected clock"`

Expected: FAIL. TypeScript reports `Expected 3-4 arguments, but got 5` at the `AgentSession.start` call, and vitest reports the file failed to collect. `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/agent.ts`, add the field, take it in the constructor, accept it in `start`, and use it in `appendBoth`:

```typescript
export interface AgentSessionOptions {
  // Injectable clock. Every transcript line and every rendered time in this
  // session comes from a call to this, so a test can pin it without
  // touching process-wide state.
  now?: () => Date
}
```

```typescript
  private readonly toolDeps: ToolDeps | undefined
  private readonly config: ReverieConfig
  private readonly now: () => Date

  private constructor(
    engine: MemoryEngine,
    chat: ChatProvider,
    model: string,
    system: string,
    sessionId: string,
    toolDeps: ToolDeps | undefined,
    config: ReverieConfig,
    now: () => Date,
  ) {
    this.engine = engine
    this.chat = chat
    this.model = model
    this.system = system
    this.sessionId = sessionId
    this.toolDeps = toolDeps
    this.config = config
    this.now = now
  }

  static async start(
    engine: MemoryEngine,
    config: ReverieConfig,
    chat: ChatProvider,
    toolDeps?: ToolDeps,
    options: AgentSessionOptions = {},
  ): Promise<AgentSession> {
    const system = await assembleSystemPrompt(engine, config)
    const sessionId = await engine.startSession()
    return new AgentSession(
      engine,
      chat,
      config.models.chat,
      system,
      sessionId,
      toolDeps,
      config,
      options.now ?? (() => new Date()),
    )
  }
```

```typescript
  private async appendBoth(message: SessionMessage): Promise<void> {
    const now = this.now()
    await this.engine.appendTranscript(this.sessionId, {
      ts: now.toISOString(),
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    })
    this.history.push(message)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/agent.test.ts -t "writes transcript timestamps from the injected clock"`

Expected: PASS, 1 test.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "Let AgentSession take an injectable clock"
```

---

### Task 7: Replace `## Today` with a static `## Time` section, and give the greeting its own local-time line

**Files:**
- Modify: `packages/memory/src/engine.ts:123-168` (`SessionContext`) and `654-667` (the return statement)
- Modify: `packages/core/src/context.ts:1-16`, `29-47`, `63-65`
- Modify: `packages/core/src/agent.ts:218-232`
- Test: `packages/core/src/context.test.ts:423-455` and `551-560`
- Test: `packages/core/src/agent.test.ts:479-482`

**Interfaces:**
- Consumes: `MemoryEngine.timezone(): string` and `MemoryEngine.timezoneSource(): 'system-default' | 'user-confirmed'` from Task 4; `renderLocalTime(date: Date, timezone: string): string` from Task 1; `AgentSessionOptions` from Task 6.
- Produces:
  - `SessionContext` loses `today: string` and gains `timezone: string` and `timezoneSource: 'system-default' | 'user-confirmed'`.
  - `packages/core/src/context.ts` exports nothing new; `todaySection` is gone and `timeSection` replaces it internally.

This is one task rather than three because the three tests the spec names as breaking (`context.test.ts:423-454`, `context.test.ts:551-557`, `agent.test.ts:474-479`) all break on the same removal, and the greeting line is what makes the third of them pass again.

- [ ] **Step 1: Rewrite the three failing tests first**

In `packages/core/src/context.test.ts`, replace the test at line 423 (`states today's date near the top, in the same form as recent session dates`) with:

```typescript
  it('states the timezone in a Time section near the top, with no clock in it', async () => {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: 'The user prefers direct, unflinching honesty over comfort.\n',
    })
    // An arc (any status) is enough to make this not a first session, so
    // the normal optional-section rendering applies here rather than the
    // first-conversation flow, and "## Constitution" actually renders.
    const arcPath = join(paths.arcsDir, 'marathon.md')
    await writeDocumentAtomic({
      path: arcPath,
      meta: { id: newId('doc'), name: 'Marathon Training', status: 'active' },
      body: 'Training for the fall marathon.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_marathon',
        type: 'arc',
        label: 'Marathon Training',
        doc: arcPath,
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Time')
    expect(prompt).toContain("This person's timezone is Asia/Kolkata.")
    expect(prompt).toContain('stamped with the local date and time it was sent')
    expect(prompt).not.toContain('## Today')
    expect(prompt.indexOf('## Time')).toBeLessThan(prompt.indexOf('## Constitution'))
    // Nothing in this section moves on its own: a clock read here would
    // cost the whole conversation history's cache on every turn.
    expect(prompt).not.toContain(new Date().toISOString().slice(0, 10))

    await engine.close()
  })

  it('says plainly when the timezone is only a system default, and drops that line once confirmed', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const seeded = await assembleSystemPrompt(engine, testConfig())
    expect(seeded).toContain('This timezone is a system default, not yet confirmed by the person.')

    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const confirmed = await assembleSystemPrompt(engine, testConfig())
    expect(confirmed).not.toContain('This timezone is a system default')

    await engine.close()
  })
```

Replace the test at line 551 (`still states today's date during a first conversation`) with:

```typescript
    it('still states the Time section during a first conversation', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ timezone: 'Asia/Kolkata' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('## Time')
      expect(prompt).toContain("This person's timezone is Asia/Kolkata.")
      expect(prompt).not.toContain('## Today')

      await engine.close()
    })
```

In `packages/core/src/agent.test.ts`, replace lines 471-482 of the test `greet() streams the greeting and appends it as a single assistant line, with no user line` (the block that starts with the `// The greeting request must carry today's date` comment) with:

```typescript
    // The greeting is the one model call with no user message to carry a
    // stamp, so its current local time is appended to the system string for
    // that call only. Nothing later reuses that string, so this costs no
    // cache: every later request's prefix is this.system plus messages.
    expect(chat.requests[0]?.system).toContain(
      'The current local time is Mon 2026-08-17 01:30 Asia/Kolkata.',
    )
    expect(chat.requests[0]?.system).toContain('## Speak first')
```

and change the same test's setup so the clock and the zone are pinned. Its first four lines become:

```typescript
    const chat = new FakeChatProvider([
      { text: 'Good to see you again. How has the week been?', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/context.test.ts packages/core/src/agent.test.ts`

Expected: FAIL. `AssertionError: expected '...' to contain '## Time'` from the two context tests, and `expected '...' to contain 'The current local time is Mon 2026-08-17 01:30 Asia/Kolkata.'` from the agent test. `Test Files  2 failed (2)`.

- [ ] **Step 3: Change `SessionContext`**

In `packages/memory/src/engine.ts`, replace the `today` field in the `SessionContext` interface (currently lines 155-160) with:

```typescript
  // The person's IANA timezone, and whether it is a fact they confirmed or
  // only the default read off the machine at folder creation. The model is
  // never told the current time through this context: the current time
  // reaches it only as the stamp on the newest user message, which is the
  // one part of the request that legitimately grows every turn. Everything
  // rendered from these two fields is static for the life of a session, so
  // the request prefix stays byte-stable and the provider's prefix cache
  // keeps matching.
  timezone: string
  timezoneSource: 'system-default' | 'user-confirmed'
```

and the corresponding lines in the return statement of `sessionContext` (currently line 665):

```typescript
      recentSummaries,
      timezone: this.timezone(),
      timezoneSource: this.timezoneSource(),
      isFirstSession,
```

- [ ] **Step 4: Rewrite the header comment and the section in `context.ts`**

Replace `packages/core/src/context.ts` lines 1-16 with:

```typescript
// Session context assembly: the system prompt handed to the chat provider
// at the start of a session. It is the persona for the configured safety
// mode, followed by a static timezone section, followed by a snapshot of
// memory state pulled from MemoryEngine.sessionContext(): the constitution,
// realms, active arcs, known people and entities, recent intentions, the
// latest daily rollup, and session summaries from the last week. A section
// with nothing to say is left out entirely rather than rendered as an empty
// header, so the model never sees "## Realms" with nothing under it.
//
// Single-clock discipline, in its current form: exactly one channel carries
// the current time to the model, and it is not this file. The time reaches
// the model only as the stamp on the newest user message (see
// AgentSession.appendBoth). This assembler never reads a clock for the
// model's benefit at all. What it renders about time is the person's
// timezone, which does not move.
//
// That matters for caching as much as for correctness. The provider's
// prefix cache matches the longest identical leading run of the whole
// request, and the system message sits in front of every conversation turn,
// so a single moving byte in here reprocesses the entire history on every
// turn. Recent sessions and the latest daily rollup are still rendered with
// absolute dates (2026-08-12); the newest message's own stamp is what lets
// the model read those as recent or old.
```

Replace `todaySection` (lines 63-65) with `timeSection`:

```typescript
function timeSection(context: SessionContext): string {
  const lines = [
    '## Time',
    '',
    `This person's timezone is ${context.timezone}. Every message from them is stamped with the local date and time it was sent, in square brackets at the start of the message. Read the newest stamp as the current time, and read the gaps between stamps as elapsed time: something the person described as happening later in the day may already have happened by a later message.`,
  ]
  if (context.timezoneSource === 'system-default') {
    lines.push(
      '',
      'This timezone is a system default, not yet confirmed by the person. Confirm it naturally if the moment allows, rather than assuming it is correct.',
    )
  }
  return lines.join('\n')
}
```

Update both call sites (lines 30 and 35):

```typescript
  if (context.isFirstSession) {
    return [persona, timeSection(context), firstConversationSection()].join('\n\n')
  }

  const sections = [
    persona,
    timeSection(context),
    constitutionSection(context),
```

- [ ] **Step 5: Add the greeting's local-time line**

In `packages/core/src/agent.ts`, import the renderer:

```typescript
import { renderLocalTime } from '@openreverie/memory'
```

and change `runGreeting` (currently lines 218-228) so the suffix carries the time:

```typescript
  private async *runGreeting(): AsyncIterable<AgentEvent> {
    yield { type: 'thinking' }
    let text = ''
    let errored = false
    // The greeting is the only model call with no user message to carry a
    // stamp, and it is the first call of the session. One clock read here
    // produces the line appended to this call's system string. Nothing
    // later reuses that string (every later request's prefix is
    // this.system plus messages), so this suffix costs no cache. No other
    // call site gets a system-string suffix.
    const openedAt = this.now()
    try {
      const stream = this.chat.stream({
        model: this.model,
        system: `${this.system}\n\n${GREETING_INSTRUCTION}\n\nThe current local time is ${renderLocalTime(openedAt, this.engine.timezone())}.`,
        messages: [],
        tools: [],
      })
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/context.test.ts packages/core/src/agent.test.ts`

Expected: PASS. `Test Files  2 passed (2)`.

- [ ] **Step 7: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 8: Commit**
```bash
git add packages/memory/src/engine.ts packages/core/src/context.ts packages/core/src/context.test.ts packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "Replace the Today section with a static Time section and give the greeting its own local time"
```

---

### Task 8: Local calendar days everywhere a day boundary is computed

**Files:**
- Modify: `packages/memory/src/engine.ts:274-278` (`startSession`), `575`, `1016`, `1184`, `1738-1750`
- Modify: `packages/memory/src/transcripts.ts:56-62` and `192-197`
- Test: `packages/memory/src/engine.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `formatLocalDate(date, timezone)` and `addDaysLocal(date, days, timezone)` from Task 1; `MemoryEngine.timezone()` from Task 4.
- Produces: `SessionStore.start(paths: MemoryPaths, now: Date, timezone?: string): Promise<SessionStore>`. The timezone defaults to `'UTC'` so the many existing test call sites keep compiling and behaving exactly as before; the only production caller, `MemoryEngine.startSession`, always passes the real zone.

`isoWeekOf` in `packages/memory/src/rollups.ts:28-48` does not change and must not be touched. It does pure ISO-week arithmetic on the year, month, and day components of a date string it is handed, and has no opinion about which calendar produced them. Once its callers feed it local dates it reports the local ISO week without a line of its own changing. The same goes for every `new Date().toISOString()` feeding a `ts` in `graph.jsonl` or a `ReflectionItem` (`engine.ts:290, 322, 1311, 1350, 1428, 1532, 1577`): those are record-time instants in an append-only log, never a calendar day boundary, and a UTC instant is the right representation for them.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to the end of `packages/memory/src/engine.test.ts`:

```typescript
describe('local day boundaries', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-localday-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('builds the daily and the completed weekly rollup using the local day, not the UTC day', async () => {
    // 2026-08-16T20:00:00Z is 2026-08-17 01:30 in Asia/Kolkata. Local today
    // is therefore 2026-08-17 (a Monday, ISO week 2026-W34), which makes
    // 2026-08-16 (a Sunday, ISO week 2026-W33) both strictly before today
    // and in a completed week. Under UTC, today would be 2026-08-16, which
    // is neither, and zero rollups would be built.
    const now = new Date('2026-08-16T20:00:00.000Z')

    const store = await SessionStore.start(paths, new Date('2026-08-16T09:00:00.000Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'A good Sunday.',
    })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-16',
        items: [],
      },
      body: 'A good Sunday.\n',
    })

    // Two completions: the daily rollup, then the weekly. runMaintenance
    // re-reads the daily rollup files from disk after its daily loop, so
    // the weekly leg fires in the same pass as the daily one.
    const chat = new FakeChatProvider([
      { text: 'A quiet Sunday.', toolCalls: [] },
      { text: 'A quiet week.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    await engine.runMaintenance(now)

    await expect(
      readDocument(join(paths.rollupsDailyDir, '2026-08-16.md')),
    ).resolves.toBeDefined()
    await expect(
      readDocument(join(paths.rollupsWeeklyDir, '2026-W33.md')),
    ).resolves.toBeDefined()

    await engine.close()
  })

  it('windows recent summaries against the local day, not the UTC day', async () => {
    // Local today is 2026-08-17, so the seven-day cutoff is 2026-08-10 and
    // a session dated 2026-08-10 is still inside the window. Under UTC the
    // cutoff would be 2026-08-09.
    const now = new Date('2026-08-16T20:00:00.000Z')

    const store = await SessionStore.start(paths, new Date('2026-08-10T09:00:00.000Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-10T09:00:00.000Z',
      role: 'user',
      content: 'Monday.',
    })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-10',
        items: [],
      },
      body: 'Monday happened.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    const context = await engine.sessionContext(now)
    expect(context.recentSummaries.map((summary) => summary.date)).toContain('2026-08-10')

    await engine.close()
  })

  it('names a new session directory with the local day', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))

    const sessions = await SessionStore.listSessions(paths)
    const created = sessions.find((session) => session.sessionId === sessionId)
    expect(created?.dirName).toBe(`2026-08-17-${sessionId}`)

    await engine.close()
  })
})
```

`engine.test.ts` already imports `readDocument`, `writeDocumentAtomic`, `newId`, `SessionStore`, `memoryPaths`, `ensureMemoryTree`, and `MemoryPaths`. If any of those is missing from the import list at the top of the file, add it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/engine.test.ts -t "local day boundaries"`

Expected: FAIL, all three tests. The first reports the rollup files do not exist (`ENOENT ... 2026-08-16.md`), the second that `recentSummaries` does not contain `'2026-08-10'`, the third `expected '2026-08-16-session_...' to be '2026-08-17-session_...'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/transcripts.ts`, import the local formatter and delete the private UTC one:

```typescript
import { formatLocalDate } from './time.js'
```

```typescript
  // The directory's date prefix is a disambiguator, not a claim: every
  // consumer that needs a session's logical day derives it (see
  // listSessions), and every consumer that needs its path uses dirName.
  // Naming a new directory with the local day just keeps the common case
  // free of divergence for a human browsing the folder. The timezone
  // defaults to UTC because a bare call has no profile to read; the only
  // production caller, MemoryEngine.startSession, always passes the real
  // zone.
  static async start(paths: MemoryPaths, now: Date, timezone = 'UTC'): Promise<SessionStore> {
    const sessionId = newId('session')
    const dir = join(paths.sessionsDir, `${formatLocalDate(now, timezone)}-${sessionId}`)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, TRANSCRIPT_FILE), '', 'utf8')
    return new SessionStore(sessionId, dir)
  }
```

Delete the private `formatDate` function (currently lines 192-197) entirely; nothing else calls it.

In `packages/memory/src/engine.ts`, import the two helpers:

```typescript
import { addDaysLocal, formatLocalDate, isValidIanaTimeZone, systemTimeZone } from './time.js'
```

Pass the zone when a session starts:

```typescript
  async startSession(now: Date = new Date()): Promise<string> {
    const store = await SessionStore.start(this.paths, now, this.timezone())
    this.liveItems.set(store.sessionId, [])
    return store.sessionId
  }
```

Switch the recent-summaries cutoff (line 575):

```typescript
    const recentCutoff = addDaysLocal(now, -RECENT_SUMMARIES_WINDOW_DAYS, this.timezone())
```

Switch `runMaintenance`'s today (line 1016):

```typescript
    const today = formatLocalDate(now, this.timezone())
```

Switch `writeSkippedSummary`'s fallback date (line 1184). It is only ever the frontmatter value now, never a path component:

```typescript
    const date = session?.date ?? formatLocalDate(now, this.timezone())
```

Delete the private `formatDateUTC` and `addDaysUTC` functions (currently lines 1738-1750) entirely; nothing else calls them.

- [ ] **Step 4: Pin the timezone in the date-sensitive suites that predate this change**

Several existing suites build fixture dates with `Date.UTC(...)` and assert against `date.toISOString().slice(0, 10)`. Those assertions were written when every day boundary in the engine was UTC. Now the engine reads the seeded profile, which carries the machine's own zone, so on a machine west of UTC the engine's "today" can be the fixture's "yesterday" and the assertion fails. Pin the zone rather than leaving that to chance.

Add this helper near the top of `packages/memory/src/engine.test.ts`, after the existing `isoDate` helper:

```typescript
// Every fixture date in this file is built with Date.UTC and asserted
// against a UTC-derived string, so the memory folder these tests open must
// be on UTC too. Written before MemoryEngine.open, because open() runs
// maintenance (which reads the zone) before any test code can call
// updateProfile. Never set TZ: it is process-wide and vitest runs tests
// with parallelism inside one process.
async function pinTimezoneUtc(paths: MemoryPaths): Promise<void> {
  const profile = await loadProfile(paths)
  await writeProfile(paths, {
    meta: { ...profile.meta, timezone: 'UTC', timezoneSource: 'user-confirmed' },
    body: profile.body,
  })
}
```

Call it immediately after every `await ensureMemoryTree(paths)` in `packages/memory/src/engine.test.ts`, and in `packages/core/src/context.test.ts` and `packages/core/src/agent.test.ts` wherever a suite builds fixture dates from `Date.UTC` or asserts on `new Date().toISOString().slice(0, 10)`. In `agent.test.ts` the memory folder is created by `MemoryEngine.open` itself, so pin it there by calling `await ensureMemoryTree(memoryPaths(dir))` followed by `await pinTimezoneUtc(memoryPaths(dir))` in the `beforeEach` that creates `dir`, before any `MemoryEngine.open` call.

The three new tests in Step 1 deliberately do not use this helper: they pin `Asia/Kolkata` on purpose, and the first two pin it after `MemoryEngine.open(..., { maintenance: false })` so no maintenance has run yet.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/engine.test.ts -t "local day boundaries"`

Expected: PASS, 3 tests.

- [ ] **Step 6: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.` If a date assertion in an older suite still fails, that suite needs `pinTimezoneUtc` from Step 4; do not weaken the assertion.

- [ ] **Step 7: Commit**
```bash
git add packages/memory/src/engine.ts packages/memory/src/transcripts.ts packages/memory/src/engine.test.ts packages/core/src/context.test.ts packages/core/src/agent.test.ts
git commit -m "Compute every day boundary from the local calendar instead of UTC"
```

---

### Task 9: `utcOffsetMinutes` on every transcript line

**Files:**
- Modify: `packages/memory/src/transcripts.ts:15-21`
- Modify: `packages/core/src/agent.ts:357-366`
- Modify: `packages/server/src/app.ts:465-471`
- Modify: `packages/web/src/api.ts:53-60`
- Test: `packages/core/src/agent.test.ts` (append one test)
- Test: `packages/server/src/app.test.ts:34` (widen the existing fixture)

**Interfaces:**
- Consumes: `utcOffsetMinutesFor(date: Date, timezone: string): number` from Task 1; `MemoryEngine.timezone()` from Task 4; the injected clock from Task 6.
- Produces: `TranscriptLine` gains `utcOffsetMinutes?: number`.

Existing lines have no offset and this task does not backfill one, ever. A missing offset means genuinely unknown, not "assume the current profile timezone": assuming the current value is exactly the bug this field exists to prevent, applied retroactively.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/agent.test.ts`, inside the existing `describe('AgentSession', ...)`:

```typescript
  it('records the local UTC offset alongside ts, from the same clock read', async () => {
    const chat = new FakeChatProvider([{ text: 'Noted.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('Hello.'))

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toHaveLength(2)
    expect(transcript[0]?.ts).toBe('2026-08-16T20:00:00.000Z')
    expect(transcript[0]?.utcOffsetMinutes).toBe(330)
    expect(transcript[1]?.utcOffsetMinutes).toBe(330)

    await engine.close()
  })
```

In `packages/server/src/app.test.ts`, widen the fixture at line 34 so the strict response schema is actually exercised:

```typescript
const userLine: TranscriptLine = {
  ts: '2026-08-15T10:00:00.000Z',
  utcOffsetMinutes: 330,
  role: 'user',
  content: 'Hello.',
}
```

The existing test `returns durable transcript lines in append order with one-based lineSequence values` already asserts `response.json.data` deep-equals `[{ lineSequence: 1, ...userLine }, { lineSequence: 2, ...assistantLine }]`, so a strict schema that rejects the new field turns that response into a 500 and fails the test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/agent.test.ts -t "records the local UTC offset"` then `npx vitest run packages/server/src/app.test.ts -t "returns durable transcript lines"`

Expected, first command: FAIL. TypeScript reports `Object literal may only specify known properties` is not the failure here; the failure is `AssertionError: expected undefined to be 330`.
Expected, second command: FAIL. TypeScript reports `'utcOffsetMinutes' does not exist in type 'TranscriptLine'` before the field is added; after the field is added but before the server schema is widened, it fails with the response status being 500 rather than the expected data array.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/transcripts.ts`:

```typescript
export interface TranscriptLine {
  // A UTC instant, ISO 8601: record time, when this line was written down.
  ts: string
  // The offset from UTC, in minutes, of the person's timezone at the moment
  // this line was written (330 for IST, -300 for US Eastern in winter).
  // Optional because lines written before this field existed do not have
  // it, and nothing backfills it: there is no source of truth for what
  // timezone a past session was actually written in, and a wrong guess
  // presented with the confidence of a real value is worse than an honest
  // gap. Storing the offset that was actually in effect is what lets a past
  // session be rendered in the wall clock it really happened in, even after
  // the person moves.
  utcOffsetMinutes?: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}
```

In `packages/core/src/agent.ts`, import the helper and capture the offset from the same clock read that produces `ts`:

```typescript
import { renderLocalTime, utcOffsetMinutesFor } from '@openreverie/memory'
```

```typescript
  private async appendBoth(message: SessionMessage): Promise<void> {
    const now = this.now()
    const timezone = this.engine.timezone()
    await this.engine.appendTranscript(this.sessionId, {
      ts: now.toISOString(),
      utcOffsetMinutes: utcOffsetMinutesFor(now, timezone),
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    })
    this.history.push(message)
  }
```

In `packages/server/src/app.ts`, widen the response schema (currently lines 465-471):

```typescript
const publicTranscriptLineSchema = z.strictObject({
  lineSequence: z.number().int().positive(),
  ts: z.string(),
  utcOffsetMinutes: z.number().optional(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
})
```

In `packages/web/src/api.ts`, widen the matching client schema (currently lines 53-60):

```typescript
export const transcriptLineSchema = z.strictObject({
  lineSequence: z.number().int().positive(),
  ts: z.string(),
  utcOffsetMinutes: z.number().optional(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/agent.test.ts -t "records the local UTC offset"` then `npx vitest run packages/server/src/app.test.ts -t "returns durable transcript lines"`

Expected: PASS for both, 1 test each.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/transcripts.ts packages/core/src/agent.ts packages/core/src/agent.test.ts packages/server/src/app.ts packages/server/src/app.test.ts packages/web/src/api.ts
git commit -m "Record the local UTC offset on every transcript line"
```

---

### Task 10: Stamp every user message with its own local time

**Files:**
- Modify: `packages/core/src/agent.ts:11-15` (module comment) and `354-366` (`appendBoth`)
- Test: `packages/core/src/agent.test.ts` (append three tests)

**Interfaces:**
- Consumes: `renderLiveStamp(date: Date, timezone: string): string` from Task 1; `MemoryEngine.timezone()` from Task 4; the injected clock from Task 6; `utcOffsetMinutesFor` from Task 9.
- Produces: no new exported symbol. The behavioral contract it establishes, which later tasks depend on: `AgentSession`'s in-memory history holds user messages whose content is prefixed with `[Weekday YYYY-MM-DD HH:MM Zone] `, while the on-disk transcript holds the verbatim content plus `ts` and `utcOffsetMinutes`.

Three rules this task must get exactly right:

1. **Only user messages are stamped.** Assistant and tool messages are stamped nowhere. They are produced within seconds of the user message that prompted them, so their own time adds nothing the preceding user stamp does not already give, and an assistant message whose content comes back with a bracket prefix it did not write teaches the model that it writes stamps, which it then starts emitting into its replies to the person.
2. **A stamp is written once and never rewritten.** Past messages never change, so the request prefix stays byte-identical from turn to turn. There is no per-round clock read and no per-round system-string change anywhere in `runTurn`.
3. **The transcript keeps the verbatim content.** The stamp is presentation, and the true time is already on the line as `ts` and `utcOffsetMinutes`. `read_transcript` returns lines as stored, `packages/server/src/app.ts:226` and `packages/server/src/registry.ts:441` send those lines to the browser for display, and reflection builds its own stamp from the line's own fields; a stamp baked into stored content would show up as literal bracket text in the person's own message bubble and would be rendered twice by reflection.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/agent.test.ts`, inside the existing `describe('AgentSession', ...)`:

```typescript
  it('stamps the user message with its local time in content, and leaves the transcript verbatim', async () => {
    const chat = new FakeChatProvider([{ text: 'Sounds fun.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send("I'm watching Halcyon tonight at 7.25pm"))

    expect(chat.requests[0]?.messages).toEqual([
      {
        role: 'user',
        content: "[Mon 2026-08-17 01:30 Asia/Kolkata] I'm watching Halcyon tonight at 7.25pm",
      },
    ])

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript[0]?.content).toBe("I'm watching Halcyon tonight at 7.25pm")
    expect(transcript[0]?.utcOffsetMinutes).toBe(330)
    expect(transcript[1]?.content).toBe('Sounds fun.')

    await engine.close()
  })

  it('never stamps an assistant or a tool message', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }] },
      { text: 'Nothing open right now.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('What is open?'))

    const secondRound = chat.requests[1]?.messages ?? []
    for (const message of secondRound) {
      if (message.role === 'user') {
        expect(message.content.startsWith('[Mon 2026-08-17 01:30 Asia/Kolkata] ')).toBe(true)
      } else {
        expect(message.content.startsWith('[')).toBe(false)
      }
    }

    await engine.close()
  })

  it('keeps the request prefix byte-stable across tool rounds even as the clock advances', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }] },
      { text: 'Nothing open right now.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    let clock = new Date('2026-08-16T20:00:00.000Z')
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => clock,
    })

    const events = session.send('What is open?')
    const seen: string[] = []
    for await (const event of events) {
      seen.push(event.type)
      // Advance real wall-clock time in the middle of the turn, between the
      // two provider rounds. Nothing already sent may change because of it.
      if (event.type === 'tool') clock = new Date('2026-08-16T21:47:00.000Z')
    }
    expect(seen).toContain('done')

    const first = chat.requests[0]
    const second = chat.requests[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // The system string is frozen for the life of the session: a per-round
    // clock read in here would reprocess the whole history every turn.
    expect(second?.system).toBe(first?.system)
    // Round two's messages are a strict extension of round one's, element
    // for element. A rebuild of history, or a re-rendered stamp, breaks it.
    const firstMessages = first?.messages ?? []
    const secondMessages = second?.messages ?? []
    expect(secondMessages.length).toBeGreaterThan(firstMessages.length)
    expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages)

    await engine.close()
  })

  it('stamps a later message with the later time and never re-renders the earlier stamp', async () => {
    const chat = new FakeChatProvider([
      { text: 'Enjoy it.', toolCalls: [] },
      { text: 'How was it?', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    let clock = new Date('2026-08-16T10:49:00.000Z')
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => clock,
    })

    await collect(session.send('Watching Halcyon tonight at 7.25pm'))
    clock = new Date('2026-08-16T18:00:00.000Z')
    await collect(session.send('Back home.'))

    const secondRequest = chat.requests[1]?.messages ?? []
    const userMessages = secondRequest.filter((message) => message.role === 'user')
    expect(userMessages).toEqual([
      {
        role: 'user',
        content: '[Sun 2026-08-16 16:19 Asia/Kolkata] Watching Halcyon tonight at 7.25pm',
      },
      { role: 'user', content: '[Sun 2026-08-16 23:30 Asia/Kolkata] Back home.' },
    ])

    await engine.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/agent.test.ts -t "stamps the user message"`

Expected: FAIL with `AssertionError: expected [ { role: 'user', content: "I'm watching Halcyon tonight at 7.25pm" } ] to deeply equal [ { role: 'user', content: "[Mon 2026-08-17 01:30 Asia/Kolkata] I'm watching Halcyon tonight at 7.25pm" } ]`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/agent.ts`, replace the transcript paragraph of the module comment (lines 11-15) with the named invariant:

```typescript
// Transcript-first discipline: every user line, assistant tool-call line,
// tool result line, and final assistant text line is appended to the
// on-disk transcript before it is added to the in-memory message history
// that gets sent back to the model. The transcript is the durable record;
// the in-memory history exists only for the life of this session object.
//
// Invariant: history content and transcript content deliberately differ.
// The transcript line stores content verbatim, plus structural time fields
// (ts, utcOffsetMinutes). The in-memory history stores the same content,
// with that same time rendered into it for user messages. Both come from
// one clock read per message; the transcript is the record, the history is
// the rendering, and neither is ever built from a different read than the
// other. A stamp, once written into history, is never rewritten: that is
// what keeps every request a strict extension of the previous one, which is
// the shape a provider's prefix cache is built to serve.
```

and replace `appendBoth`:

```typescript
  // Appends a message to the on-disk transcript first, then to the
  // in-memory history, per the transcript-first discipline: nothing is
  // added to history until it is durably recorded.
  //
  // One clock read per appended message, and one only. That single instant
  // produces the transcript line's ts, its utcOffsetMinutes, and the
  // rendered stamp, so the value the model sees and the value on disk can
  // never disagree.
  //
  // Only user messages are stamped. An assistant or tool message is
  // produced within seconds of the user message that prompted it, so its
  // own time adds nothing the preceding user stamp does not already give,
  // and an assistant message that comes back carrying a bracket prefix it
  // did not write teaches the model to start emitting stamps into its own
  // replies to the person.
  private async appendBoth(message: SessionMessage): Promise<void> {
    const now = this.now()
    const timezone = this.engine.timezone()
    await this.engine.appendTranscript(this.sessionId, {
      ts: now.toISOString(),
      utcOffsetMinutes: utcOffsetMinutesFor(now, timezone),
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    })
    this.history.push(
      message.role === 'user'
        ? { ...message, content: `${renderLiveStamp(now, timezone)} ${message.content}` }
        : message,
    )
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/agent.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Falsify, do not read**

Temporarily change the `this.history.push(...)` call back to `this.history.push(message)` and run `npx vitest run packages/core/src/agent.test.ts -t "stamps the user message"`. It must FAIL. Restore the change. Then temporarily make `appendBoth` write the stamped string to disk (`content: message.role === 'user' ? stamped : message.content`) and run the same test: the transcript half must FAIL. Restore. Then temporarily add `system: `${this.system} ${this.now().toISOString()}`` to the `this.chat.stream` call in `runTurn` and run `-t "keeps the request prefix byte-stable"`: it must FAIL. Restore.

- [ ] **Step 6: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "Stamp each user message with its local time in the message content"
```

---

### Task 11: Render the session id in the recent sessions section

**Files:**
- Modify: `packages/core/src/context.ts:98-102`
- Test: `packages/core/src/context.test.ts` (append one test)

**Interfaces:**
- Consumes: `SessionContext.recentSummaries[].sessionId`, which already exists (`packages/memory/src/engine.ts:154`, pushed at `engine.ts:597`).
- Produces: no new symbol.

`read_transcript` takes exactly one argument, `sessionId` (`packages/core/src/tools.ts:156-169`), and the only place a session id could come from is the assembled prompt, which currently drops it. A model that decides it needs the verbatim transcript of a past session has nothing to pass. This is the justification for storing `utcOffsetMinutes` at all, so it is fixed here rather than deferred.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/context.test.ts`, inside the top-level `describe('assembleSystemPrompt', ...)`:

```typescript
  it('renders each recent session id so the model can pass one to read_transcript', async () => {
    const startedAt = new Date('2026-08-15T09:00:00.000Z')
    const store = await SessionStore.start(paths, startedAt, 'UTC')
    await store.appendLine({ ts: startedAt.toISOString(), role: 'user', content: 'Hello.' })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-15',
        items: [],
      },
      body: 'We talked about the move and how unsettled it left him.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'UTC' })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain(
      `2026-08-15 (${store.sessionId}): We talked about the move and how unsettled it left him.`,
    )

    await engine.close()
  })
```

Note the engine is opened with `{ maintenance: false }` so no rollup synthesis is attempted against the empty `FakeChatProvider`, and `sessionContext` is called with the default clock, so the fixture date must be recent enough to be inside the seven-day window. If the current date has moved past that window when this runs, set the fixture date to `addDaysLocal(new Date(), -1, 'UTC')` and assert against that same string.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/context.test.ts -t "renders each recent session id"`

Expected: FAIL with `AssertionError: expected '...' to contain '2026-08-15 (session_...): We talked about the move and how unsettled it left him.'` (the rendered line carries the date and body but no id).

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/context.ts`:

```typescript
// The id is rendered alongside the date because read_transcript takes a
// session id and the prompt is the only place the model could get one.
// Without it, the model can see that a session happened and can read its
// summary, but has no way to ask for the verbatim transcript behind it.
function recentSummariesSection(context: SessionContext): string | undefined {
  if (context.recentSummaries.length === 0) return undefined
  const parts = context.recentSummaries.map(
    (summary) => `${summary.date} (${summary.sessionId}): ${summary.body.trim()}`,
  )
  return `## Recent sessions\n\n${parts.join('\n\n')}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/context.test.ts -t "renders each recent session id"`

Expected: PASS, 1 test.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.` If an existing test asserted the old `date: body` shape, update it to the new shape rather than reverting the change.

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/context.ts packages/core/src/context.test.ts
git commit -m "Render the session id in the recent sessions section so read_transcript is reachable"
```

---

### Task 12: `listSessions` derives a logical local date instead of reading the directory prefix

**Files:**
- Modify: `packages/memory/src/transcripts.ts` (imports, `listSessions`, a new `readFirstLine` static, a new private `readFirstTranscriptLine`)
- Test: `packages/memory/src/transcripts.test.ts` (append two tests)
- Test: `packages/memory/src/engine.test.ts` (append one `describe` block with three consumer tests)

**Interfaces:**
- Consumes: `localDateFromStored(ts: string, utcOffsetMinutes: number): string` from Task 1; `TranscriptLine.utcOffsetMinutes` from Task 9; `SessionStore.sessionDir` from Task 5.
- Produces: `SessionStore.readFirstLine(paths: MemoryPaths, sessionId: string): Promise<TranscriptLine | undefined>`. `listSessions`' return shape is unchanged from Task 5; only how `date` is computed changes.

The derivation is layered, cheapest source first, because `listSessions` runs on every session start, every maintenance pass, inside `buildDailyRollup`, inside `describe`, and on every server session create. Reading every transcript on that path would be O(total bytes ever written) per call.

1. A reflected session reads its date from `summary.md`'s `date` frontmatter, which `listSessions` is already reading for its `skipped` check. Zero additional file reads. That value was itself computed from the transcript at reflection time, so it is the derived value, frozen at the moment it was computed.
2. An unreflected session reads only the first line of `transcript.jsonl`, through a bounded 8 KB read, not `readTranscript`. There are only ever a handful of unreflected sessions at a time.
3. A transcript with no lines at all, or a first line with no `utcOffsetMinutes`, falls back to the directory's own date prefix. With no recorded offset there is no honest local date to compute, so none is invented.

Freezing the date at write time is a correctness requirement, not only a performance one. Recomputing it from the *current* profile timezone would silently re-date every past session when a person moves, and `pendingDailyRollups` would then see uncovered dates it had already rolled up under the old grouping and synthesize duplicates beside the orphaned originals.

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory/src/transcripts.test.ts`:

```typescript
  it('reports the summary-derived date while still reporting the directory name it lives in', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })
    await writeFile(
      join(store.dir, 'summary.md'),
      '---\nid: doc_x\ndate: 2026-08-16\n---\nSummary text.\n',
      'utf8',
    )

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-15-${store.sessionId}`,
        date: '2026-08-16',
        reflected: true,
        skipped: false,
      },
    ])
  })

  it('derives an unreflected session date from the first transcript line, and falls back to the prefix without an offset', async () => {
    const withOffset = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await withOffset.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })

    const withoutOffset = await SessionStore.start(paths, new Date('2026-08-14T21:00:00Z'), 'UTC')
    await withoutOffset.appendLine({
      ts: '2026-08-14T21:00:00.000Z',
      role: 'user',
      content: 'A line written before offsets existed.',
    })

    const empty = await SessionStore.start(paths, new Date('2026-08-13T21:00:00Z'), 'UTC')

    const sessions = await SessionStore.listSessions(paths)
    const byId = new Map(sessions.map((session) => [session.sessionId, session.date]))
    expect(byId.get(withOffset.sessionId)).toBe('2026-08-16')
    expect(byId.get(withoutOffset.sessionId)).toBe('2026-08-14')
    expect(byId.get(empty.sessionId)).toBe('2026-08-13')

    const first = await SessionStore.readFirstLine(paths, withOffset.sessionId)
    expect(first?.content).toBe('Late one.')
    expect(await SessionStore.readFirstLine(paths, empty.sessionId)).toBeUndefined()
  })
```

Append this `describe` block to the end of `packages/memory/src/engine.test.ts`. It exercises the three consumers directly, which the isolated `listSessions` tests above cannot: they would pass unchanged even if every path-building call site were still concatenating `${date}-${sessionId}` and throwing on every call.

```typescript
describe('a session whose logical date differs from its directory prefix', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-divergent-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await pinTimezoneUtc(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // The directory is 2026-08-15-<id>; the summary inside it says 2026-08-16.
  async function seedDivergentSession(summaryBody: string): Promise<string> {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-16',
        items: [],
      },
      body: summaryBody,
    })
    return store.sessionId
  }

  it('sessionContext reads the summary out of the directory that actually exists', async () => {
    const sessionId = await seedDivergentSession('A late Saturday night.\n')
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })

    const context = await engine.sessionContext(new Date('2026-08-17T12:00:00.000Z'))

    const entry = context.recentSummaries.find((summary) => summary.sessionId === sessionId)
    expect(entry?.date).toBe('2026-08-16')
    expect(entry?.body.trim()).toBe('A late Saturday night.')

    await engine.close()
  })

  it('buildDailyRollup finds the divergent session summary for its logical date', async () => {
    await seedDivergentSession('A late Saturday night.\n')
    const chat = new FakeChatProvider([{ text: 'A quiet late night.', toolCalls: [] }])

    const doc = await buildDailyRollup(
      { chat, model: 'fake-reflect', paths },
      '2026-08-16',
    )

    expect(doc.body.trim()).toBe('A quiet late night.')

    await expect(
      readDocument(join(paths.rollupsDailyDir, '2026-08-16.md')),
    ).resolves.toBeDefined()
  })

  it('a skipped summary is written into the existing directory, never into a second one', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'assistant',
      content: 'Good to see you.',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.runMaintenance(new Date('2026-08-17T12:00:00.000Z'))

    const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(dirs).toEqual([`2026-08-15-${store.sessionId}`])

    const summary = await readDocument(join(store.dir, 'summary.md'))
    expect(summary.meta.skipped).toBe(true)
    expect(summary.meta.date).toBe('2026-08-16')

    await engine.close()
  })
})
```

`engine.test.ts` needs `readdir` from `node:fs/promises` and `buildDailyRollup` from `./rollups.js` in its import list; add either if missing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/transcripts.test.ts packages/memory/src/engine.test.ts -t "logical date"`

Expected: FAIL. `TypeError: SessionStore.readFirstLine is not a function` from the transcripts file, and `expected '2026-08-15' to be '2026-08-16'` from the divergent-session block.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/transcripts.ts`, widen the imports:

```typescript
import { access, appendFile, mkdir, open, readdir, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolCall } from '@openreverie/providers'
import { decodeTime } from 'ulid'
import { newId, readDocument } from './documents.js'
import type { MemoryPaths } from './paths.js'
import { formatLocalDate, localDateFromStored } from './time.js'
```

Add the public static beside the other statics:

```typescript
  // The first line of a session's transcript, read through a bounded chunk
  // rather than by parsing the whole file. Used to derive a session's
  // logical local day without paying O(every transcript ever written) on a
  // path that runs at every session start.
  static async readFirstLine(
    paths: MemoryPaths,
    sessionId: string,
  ): Promise<TranscriptLine | undefined> {
    const dir = await findSessionDir(paths, sessionId)
    return readFirstTranscriptLine(dir)
  }
```

Add the module-private helper next to `findSessionDir`:

```typescript
const FIRST_LINE_CHUNK_BYTES = 8192

// One handle, one chunk, split at the first newline, one JSON.parse, handle
// closed. 8 KB is more than enough for a first line. Anything unreadable,
// unparseable, or absent comes back as undefined rather than throwing: the
// caller's job is to fall back, not to fail.
async function readFirstTranscriptLine(dir: string): Promise<TranscriptLine | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(join(dir, TRANSCRIPT_FILE), 'r')
    const buffer = Buffer.alloc(FIRST_LINE_CHUNK_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_CHUNK_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    const first = newline >= 0 ? text.slice(0, newline) : text
    if (first.trim().length === 0) return undefined
    return JSON.parse(first) as TranscriptLine
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}
```

Change the date derivation inside `listSessions`. Replace the body of the `for (const dirName of dirNames)` loop with:

```typescript
    for (const dirName of dirNames) {
      const match = dirName.match(SESSION_DIR_PATTERN)
      if (!match) continue
      const prefixDate = match[1] as string
      const sessionId = match[2] as string
      const sessionDirPath = join(paths.sessionsDir, dirName)
      const summaryPath = join(sessionDirPath, SUMMARY_FILE)
      const reflected = await pathExists(summaryPath)

      let skipped = false
      let summaryDate: string | undefined
      if (reflected) {
        try {
          const doc = await readDocument(summaryPath)
          skipped = doc.meta.skipped === true
          if (typeof doc.meta.date === 'string') summaryDate = doc.meta.date
        } catch {
          // A summary.md that fails to parse is reflected (it exists) but
          // its skipped status is unknowable; treat it as not skipped
          // rather than throwing listSessions out for every caller. The
          // same catch means "no date available", so the derivation falls
          // through to the transcript below instead of inventing one,
          // which keeps a hand-broken summary from re-dating its session.
          skipped = false
        }
      }

      // Cheapest source first. A reflected session's date was already
      // derived and frozen into its summary at reflection time, so reading
      // it back costs nothing extra: listSessions is opening that file for
      // the skipped check anyway.
      let date = prefixDate
      if (summaryDate !== undefined) {
        date = summaryDate
      } else {
        const first = await readFirstTranscriptLine(sessionDirPath)
        if (first !== undefined && typeof first.utcOffsetMinutes === 'number') {
          date = localDateFromStored(first.ts, first.utcOffsetMinutes)
        }
      }

      // dirName is the directory exactly as readdir produced it. It is the
      // only value here that may ever be used to build a path. date is for
      // windowing, grouping, and display only.
      sessions.push({ sessionId, dirName, date, reflected, skipped })
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/transcripts.test.ts` then `npx vitest run packages/memory/src/engine.test.ts -t "logical date"`

Expected: PASS for both.

- [ ] **Step 5: Falsify, do not read**

Temporarily change `sessionContext`'s summary path back to `` join(this.paths.sessionsDir, `${session.date}-${session.sessionId}`, 'summary.md') `` and run `npx vitest run packages/memory/src/engine.test.ts -t "sessionContext reads the summary"`. It must FAIL with an `ENOENT`. Restore. Do the same for `buildDailyRollup` and for `writeSkippedSummary`; the third must fail on the directory count.

- [ ] **Step 6: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 7: Commit**
```bash
git add packages/memory/src/transcripts.ts packages/memory/src/transcripts.test.ts packages/memory/src/engine.test.ts
git commit -m "Derive a session's logical local date instead of reading its directory prefix"
```

---

### Task 13: Reflection writes the derived local date into `summary.md`

**Files:**
- Modify: `packages/memory/src/reflection.ts:27-46` (imports), `339-351` (`findSessionDir`), `590-591`
- Test: `packages/memory/src/reflection.test.ts` (append one test)

**Interfaces:**
- Consumes: `SessionStore.sessionDir(paths, sessionId)` from Task 5; `SessionStore.readFirstLine(paths, sessionId)` and `localDateFromStored` from Task 12.
- Produces: no new exported symbol. `applyReflection` keeps its signature exactly: `applyReflection(paths: MemoryPaths, out: ReflectionOutput, sessionId: string, liveItems: ReflectionItem[], now: Date, narratives: Map<string, string>, materializeNew: (mintedItems: ReflectionItem[]) => Promise<void>): Promise<{ summaryDoc: Document; autoAsserted: number; mintedItems: ReflectionItem[] }>`.

`summary.md`'s `date` frontmatter is the one place a session's logical day is durably recorded, and Task 12 made it the cheapest source `listSessions` reads. It must therefore be derived from the transcript's own first line rather than parsed off the directory string.

- [ ] **Step 1: Write the failing test**

Append to `packages/memory/src/reflection.test.ts`, inside the `describe` that covers `applyReflection` (or as a new top-level `describe` if that is simpler; the file already sets up a temp memory folder in its `beforeEach`):

```typescript
  it('writes the local date derived from the transcript first line, not the directory prefix', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })

    const { summaryDoc } = await applyReflection(
      paths,
      emptyReflectionOutput('A late Saturday night.'),
      store.sessionId,
      [],
      new Date('2026-08-16T04:00:00.000Z'),
      new Map(),
      async () => {},
    )

    expect(summaryDoc.meta.date).toBe('2026-08-16')
    expect(summaryDoc.path).toBe(join(store.dir, 'summary.md'))
  })

  it('falls back to the directory prefix when the first line carries no offset', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      role: 'user',
      content: 'A line written before offsets existed.',
    })

    const { summaryDoc } = await applyReflection(
      paths,
      emptyReflectionOutput('An older session.'),
      store.sessionId,
      [],
      new Date('2026-08-16T04:00:00.000Z'),
      new Map(),
      async () => {},
    )

    expect(summaryDoc.meta.date).toBe('2026-08-15')
  })
```

`reflection.test.ts` already defines `emptyReflectionOutput` at the top of the file and already has a `paths: MemoryPaths` set up in the `beforeEach` of its filesystem-backed describes. It imports `TranscriptLine` as a type only, so change that import line to bring in the store as a value as well:

```typescript
import { SessionStore, type TranscriptLine } from './transcripts.js'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/reflection.test.ts -t "writes the local date derived from the transcript first line"`

Expected: FAIL with `AssertionError: expected '2026-08-15' to be '2026-08-16'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/reflection.ts`, import the store and the helper:

```typescript
import { SessionStore, type TranscriptLine } from './transcripts.js'
import { localDateFromStored } from './time.js'
```

(the existing `import type { TranscriptLine } from './transcripts.js'` line is replaced by the value import above; `readdir` and `join` stay as they are for the rest of the file.)

Replace the private `findSessionDir` (currently lines 339-351) with:

```typescript
// The directory is resolved by id suffix, never by date. The date is
// derived from the transcript's own first line, because summary.md's date
// frontmatter is the one place a session's logical local day is durably
// recorded, and SessionStore.listSessions reads it straight back out. With
// no recorded offset there is no honest local date to compute, so the
// directory's own prefix stands rather than a guess built from whatever
// timezone the profile happens to hold today.
async function resolveSession(
  paths: MemoryPaths,
  sessionId: string,
): Promise<{ dir: string; date: string }> {
  const dir = await SessionStore.sessionDir(paths, sessionId)
  const prefixMatch = dir.split('/').at(-1)?.match(/^(\d{4}-\d{2}-\d{2})-/)
  const prefixDate = prefixMatch?.[1] ?? (dir.split('/').at(-1) as string)

  const first = await SessionStore.readFirstLine(paths, sessionId)
  if (first !== undefined && typeof first.utcOffsetMinutes === 'number') {
    return { dir, date: localDateFromStored(first.ts, first.utcOffsetMinutes) }
  }
  return { dir, date: prefixDate }
}
```

Note: use `node:path`'s `basename` rather than splitting on `/` if the file already imports it; if not, add `import { basename, join } from 'node:path'` and write `basename(dir)` in both places above.

Change the call in `applyReflection` (currently line 590):

```typescript
  const { dir, date } = await resolveSession(paths, sessionId)
  const summaryPath = join(dir, 'summary.md')
```

Delete the now-unused `readdir` import from `node:fs/promises` in `reflection.ts` if nothing else in the file uses it; run `npx biome check .` to confirm.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/reflection.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "Derive a session summary's date from its transcript rather than its directory name"
```

---

### Task 14: Reflection sees the time on every transcript line

**Files:**
- Modify: `packages/memory/src/reflection.ts:191-193`
- Test: `packages/memory/src/reflection.test.ts:189-190` (widen) and one new test

**Interfaces:**
- Consumes: `renderStoredStamp(ts: string, utcOffsetMinutes?: number): string` from Task 1.
- Produces: no new exported symbol.

`renderTranscript` is what the reflection pass actually sends to the model, and today it passes only `role` and `content`. Reflection is precisely the component that would need to tell "the person said this at 16:19" apart from "the person is describing something happening at 19:25", and it currently has zero time information on any line, ever. The zone renders as an offset here rather than an IANA name because an offset is all the stored line carries. Same bracket format, same field order, one function shared with the live path.

- [ ] **Step 1: Write the failing test**

In `packages/memory/src/reflection.test.ts`, change the shared `TRANSCRIPT` fixture at the top of the file so one line carries an offset and one does not:

```typescript
const TRANSCRIPT: TranscriptLine[] = [
  {
    ts: '2026-08-13T09:00:00.000Z',
    utcOffsetMinutes: 330,
    role: 'user',
    content: 'I went for a long run this morning.',
  },
  {
    ts: '2026-08-13T09:01:00.000Z',
    role: 'assistant',
    content: 'That sounds like a good start to the day.',
  },
]
```

Then replace the two assertions at lines 189-190 with:

```typescript
      expect(prompt).toContain(
        '[Thu 2026-08-13 14:30 UTC+05:30] user: I went for a long run this morning.',
      )
      expect(prompt).toContain(
        '[2026-08-13T09:01:00.000Z (UTC; local time unknown)] assistant: That sounds like a good start to the day.',
      )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/reflection.test.ts -t "lists known"`

Expected: FAIL with `AssertionError: expected '...' to contain '[Thu 2026-08-13 14:30 UTC+05:30] user: I went for a long run this morning.'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/reflection.ts`, add `renderStoredStamp` to the `./time.js` import and change `renderTranscript`:

```typescript
import { localDateFromStored, renderStoredStamp } from './time.js'
```

```typescript
// Each line is prefixed with the wall-clock time it was written at, built
// from that line's own ts and its own recorded offset. A line written
// before offsets existed renders as a labeled UTC instant instead, and
// never as a local time guessed from a timezone the line does not carry.
// This is what lets reflection distinguish record time (when the person
// said it) from event time (when the thing they described happens).
function renderTranscript(transcript: TranscriptLine[]): string {
  return transcript
    .map(
      (line) =>
        `${renderStoredStamp(line.ts, line.utcOffsetMinutes)} ${line.role}: ${line.content}`,
    )
    .join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/reflection.test.ts`

Expected: PASS. `Test Files  1 passed (1)`. If another assertion in this file or in `packages/memory/src/engine.test.ts` anchored on a transcript line at the start of a string (rather than with `toContain`), update it to expect the stamp prefix rather than removing the stamp.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "Show reflection the local time on every transcript line"
```

---

### Task 15: `eventTime` on reflection items

**Files:**
- Modify: `packages/memory/src/reflection.ts:50-55` (`ReflectionItem`), `57-90` (`ReflectionOutput`), `110-152` (schema), `195-206` (`RESPONSE_SHAPE`), `208-251` (prompt), `320-323` (`mintItems`)
- Modify: `packages/memory/src/engine.ts:285-297` (`remember`)
- Modify: `packages/core/src/tools.ts:49-52`, `173-195`, `342-352`
- Test: `packages/memory/src/reflection.test.ts` (append one test)
- Test: `packages/core/src/tools.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ReflectionItem` gains `eventTime?: string`
  - `ReflectionOutput['items']` elements gain `eventTime?: string`
  - `MemoryEngine.remember(sessionId: string, text: string, kind?: ReflectionItemKind, eventTime?: string): Promise<void>`
  - the `remember` tool accepts an optional `eventTime` string argument

Record time answers "when did memory learn this"; event time answers "when did this happen in the person's life". They are allowed to differ, and a `remember` call at 16:19 for something the person says happens at 19:25 is two facts about one item, not a contradiction. `eventTime` is free text, not a parsed instant: "tonight", "next Tuesday", and "sometime in the fall" cannot honestly be reduced to one timestamp, and resolving them is explicitly out of scope. The item's existing `ts` stays a UTC instant, correctly, as record time always should be.

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory/src/reflection.test.ts`:

```typescript
  it('accepts and mints an item carrying an event time distinct from its record time', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('An evening plan.'),
      items: [
        { text: 'Watching Halcyon', kind: 'event', eventTime: 'tonight at 8:10pm' },
        { text: 'Feeling behind lately', kind: 'feeling' },
      ],
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)

    const store = await SessionStore.start(paths, new Date('2026-08-16T10:49:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-16T10:49:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Watching Halcyon tonight at 7.25pm',
    })

    const { mintedItems } = await applyReflection(
      paths,
      out,
      store.sessionId,
      [],
      new Date('2026-08-16T10:49:00.000Z'),
      new Map(),
      async () => {},
    )

    expect(mintedItems[0]?.eventTime).toBe('tonight at 8:10pm')
    expect(mintedItems[0]?.ts).toBe('2026-08-16T10:49:00.000Z')
    expect(mintedItems[1]?.eventTime).toBeUndefined()
  })
```

Append to `packages/core/src/tools.test.ts`, in the block that covers `remember`:

```typescript
  it('remember passes an event time through to the engine when the model states one', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const sessionId = await engine.startSession()

    const result = await dispatchTool(engine, sessionId, {
      id: 'call_1',
      name: 'remember',
      arguments: JSON.stringify({
        text: 'Watching Halcyon',
        kind: 'event',
        eventTime: 'tonight at 8:10pm',
      }),
    })

    expect(JSON.parse(result)).toEqual({ ok: true })

    const definition = toolDefinitions().find((tool) => tool.name === 'remember')
    const properties = definition?.parameters.properties as Record<string, unknown>
    expect(properties.eventTime).toBeDefined()

    await engine.close()
  })
```

`tools.test.ts` already imports `dispatchTool` and `MemoryEngine`; add `toolDefinitions` to the `./tools.js` import if it is not there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/reflection.test.ts -t "event time distinct from its record time"`

Expected: FAIL. TypeScript reports `Object literal may only specify known properties, and 'eventTime' does not exist in type '{ text: string; kind: ReflectionItemKind; }'`, and vitest reports the file failed to collect.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/reflection.ts`:

```typescript
export interface ReflectionItem {
  id: string
  text: string
  kind: ReflectionItemKind
  // Record time: when this entered memory. Always a UTC instant.
  ts: string
  // Event time: when the thing happened or will happen, as the person
  // stated it. Free text, not a parsed instant, because "tonight", "next
  // week", and "sometime in the fall" cannot honestly be reduced to one.
  // Absent when the person attached no particular moment to it.
  eventTime?: string
}
```

```typescript
export interface ReflectionOutput {
  summary: string
  items: { text: string; kind: ReflectionItemKind; eventTime?: string }[]
```

```typescript
  items: z.array(
    z.object({
      text: z.string(),
      kind: reflectionItemKindSchema,
      eventTime: z.string().optional(),
    }),
  ),
```

```typescript
const RESPONSE_SHAPE = `{
  "summary": string,
  "items": [{"text": string, "kind": "observation" | "feeling" | "event" | "intention", "eventTime": string | undefined}],
```

(the remaining lines of `RESPONSE_SHAPE` are unchanged.)

Add one sentence to `buildReflectionPrompt`, immediately after the `'For each entry in arcUpdates and personUpdates, ...'` entry:

```typescript
    '',
    'Each transcript line above is prefixed with the time it was written. When an item describes something happening at a time the person actually stated ("tonight at 7.25", "last Tuesday", "next month"), put that stated time in eventTime, in the person\'s own words, and leave eventTime out entirely otherwise. eventTime is when the thing happens; it is separate from when the person told you about it, and the two are allowed to differ. Do not invent or resolve a time the person did not state.',
```

```typescript
function mintItems(items: ReflectionOutput['items'], now: Date): ReflectionItem[] {
  const ts = now.toISOString()
  return items.map((item) => ({
    id: newId('item'),
    text: item.text,
    kind: item.kind,
    ts,
    ...(item.eventTime !== undefined ? { eventTime: item.eventTime } : {}),
  }))
}
```

In `packages/memory/src/engine.ts`:

```typescript
  async remember(
    sessionId: string,
    text: string,
    kind: ReflectionItemKind = 'observation',
    eventTime?: string,
  ): Promise<void> {
    const item: ReflectionItem = {
      id: newId('item'),
      text,
      kind,
      ts: new Date().toISOString(),
      ...(eventTime !== undefined ? { eventTime } : {}),
    }
    const items = this.liveItems.get(sessionId)
    if (items) {
      items.push(item)
    } else {
      this.liveItems.set(sessionId, [item])
    }
  }
```

In `packages/core/src/tools.ts`, widen the argument schema:

```typescript
const rememberArgs = z.strictObject({
  text: z.string(),
  kind: z.enum(['observation', 'feeling', 'event', 'intention']).optional(),
  eventTime: z.string().optional(),
})
```

add the property to the `remember` tool definition, after `kind`:

```typescript
          eventTime: {
            type: 'string',
            description:
              'When the thing happens or happened, in the person\'s own words ("tonight at 7.25", "last Tuesday"), only when they actually stated a time. Leave it out otherwise. This is separate from when they told you.',
          },
```

and pass it through in dispatch:

```typescript
async function dispatchRemember(
  engine: MemoryEngine,
  sessionId: string,
  value: unknown,
): Promise<string> {
  const parsed = rememberArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('remember', parsed.error))

  await engine.remember(sessionId, parsed.data.text, parsed.data.kind, parsed.data.eventTime)
  return JSON.stringify({ ok: true })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/reflection.test.ts packages/core/src/tools.test.ts`

Expected: PASS. `Test Files  2 passed (2)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts packages/memory/src/engine.ts packages/core/src/tools.ts packages/core/src/tools.test.ts
git commit -m "Carry an optional event time on reflection items, separate from record time"
```

---

### Task 16: Reflection can correct the timezone, and stops writing it into constitution prose

**Files:**
- Modify: `packages/memory/src/reflection.ts:57-90` (`ReflectionOutput`), `110-152` (schema), `195-206` (`RESPONSE_SHAPE`), `230` (the identity-fact sentence)
- Modify: `packages/memory/src/engine.ts:338-354` (the degraded fallback) and the block right after `applyReflection` returns in `_doEndSession`
- Test: `packages/memory/src/reflection.test.ts` (append one test)
- Test: `packages/memory/src/engine.test.ts` (append one test)

**Interfaces:**
- Consumes: `MemoryEngine.updateProfile(patch: { timezone?: string }): Promise<Profile>` from Task 4.
- Produces: `ReflectionOutput` gains `profileUpdates?: { timezone: string | null }`.

This is a backstop, not the primary path. A model that used `update_profile` live during the conversation (Task 17) has already written it, and writing the same confirmed value twice is a no-op in effect. Not every session is a first conversation, though, and a person can mention they moved, or correct a wrong guess, at any point later.

**The one requirement this task makes of the identity-fact sentence at `reflection.ts:230`: "their timezone" must no longer appear in it.** That is the whole of it. The companion spec [Modes, profile, and settings](../specs/2026-08-16-modes-profile-settings-design.md) rewrites that sentence in full and owns which of the remaining identity facts move into `profile.md`. Do not decide that here, and do not touch the rest of the list.

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory/src/reflection.test.ts`:

```typescript
  it('accepts profileUpdates and never instructs timezone into constitution prose', async () => {
    const withUpdate = {
      ...emptyReflectionOutput('They mentioned moving to Berlin.'),
      profileUpdates: { timezone: 'Europe/Berlin' },
    }
    expect(reflectionOutputSchema.safeParse(withUpdate).success).toBe(true)

    const withNull = {
      ...emptyReflectionOutput('Nothing to update.'),
      profileUpdates: { timezone: null },
    }
    expect(reflectionOutputSchema.safeParse(withNull).success).toBe(true)

    // Absent entirely is also valid, which is what every existing fixture
    // in this file relies on.
    expect(reflectionOutputSchema.safeParse(emptyReflectionOutput('Plain.')).success).toBe(true)

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('Plain.')), toolCalls: [] },
    ])
    await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
      constitution: 'The user values honesty over comfort.',
      arcs: [],
      realms: [],
      people: [],
      entities: [],
    })

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).not.toContain('their timezone')
    expect(prompt).toContain('"profileUpdates"')
  })
```

Append to `packages/memory/src/engine.test.ts`:

```typescript
describe('reflection profileUpdates', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-profileupdates-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await pinTimezoneUtc(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a confirmed timezone reported by reflection, and ignores a null or invalid one', async () => {
    const reflectionWith = {
      ...emptyReflectionOutput('They moved to Berlin.'),
      profileUpdates: { timezone: 'Europe/Berlin' },
    }
    const chat = new FakeChatProvider([
      { text: JSON.stringify(reflectionWith), toolCalls: [] },
      { text: 'A rewritten narrative.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      utcOffsetMinutes: 0,
      role: 'user',
      content: 'I moved to Berlin last month.',
    })

    await engine.endSession(sessionId)

    expect(engine.timezone()).toBe('Europe/Berlin')
    expect(engine.timezoneSource()).toBe('user-confirmed')
    const onDisk = await loadProfile(paths)
    expect(onDisk.meta.timezone).toBe('Europe/Berlin')

    await engine.close()
  })

  it('leaves the timezone alone when reflection reports null', async () => {
    const reflectionWithout = {
      ...emptyReflectionOutput('An ordinary session.'),
      profileUpdates: { timezone: null },
    }
    const chat = new FakeChatProvider([
      { text: JSON.stringify(reflectionWithout), toolCalls: [] },
      { text: 'A rewritten narrative.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      utcOffsetMinutes: 0,
      role: 'user',
      content: 'Nothing much happened.',
    })

    await engine.endSession(sessionId)

    expect(engine.timezone()).toBe('UTC')

    await engine.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/reflection.test.ts -t "accepts profileUpdates"` then `npx vitest run packages/memory/src/engine.test.ts -t "reflection profileUpdates"`

Expected, first: FAIL with `AssertionError: expected '...' not to contain 'their timezone'`.
Expected, second: FAIL with `AssertionError: expected 'UTC' to be 'Europe/Berlin'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/reflection.ts`, add the optional field to the output interface, after `constitutionUpdate`:

```typescript
  constitutionUpdate: string | null
  // A structured personal fact worth writing into profile.md rather than
  // into constitution prose. null, or the field's absence, means nothing to
  // update. This is a backstop: a model that used the live update_profile
  // tool during the conversation has already written it, and writing the
  // same confirmed value twice is a no-op in effect.
  profileUpdates?: { timezone: string | null }
```

and to the schema, after `constitutionUpdate`:

```typescript
  constitutionUpdate: z.string().nullable(),
  profileUpdates: z.object({ timezone: z.string().nullable() }).optional(),
```

and to `RESPONSE_SHAPE`, replacing its last line before the closing brace:

```typescript
  "constitutionUpdate": string | null,
  "profileUpdates": {"timezone": string | null}
}`
```

Change the identity-fact sentence (line 230) so "their timezone" is gone, and add one sentence telling the model where the timezone goes instead:

```typescript
    'When updating the constitution: basic identity facts about the user (their name, pronouns, where they live, their occupation or work situation) always belong in the constitution when first learned or when they change. Do not wait for these facts to feel weighty; update the constitution to include them immediately.',
    '',
    'Timezone is the exception, and it does not go in the constitution: reverie has to read it back out in code to render local times, and prose is not reliably machine parseable. If this session established or corrected the person\'s timezone, put the IANA name (for example "Asia/Kolkata", "America/New_York") in profileUpdates.timezone. Otherwise set it to null.',
```

In `packages/memory/src/engine.ts`, the degraded fallback literal in `_doEndSession` needs no change: `profileUpdates` is optional, so leaving it out is valid. Add the application right after `applyReflection` returns, before the commit. Find the line in `_doEndSession` that calls `applyReflection` and add this immediately after it:

```typescript
    // Reflection's timezone backstop. Validated by updateProfile itself,
    // which rejects anything Intl does not recognize, and swallowed on
    // failure: a bad zone name from the model must not undo a session that
    // has already been written to disk.
    const reportedTimezone = out.profileUpdates?.timezone
    if (typeof reportedTimezone === 'string' && reportedTimezone.length > 0) {
      try {
        await this.updateProfile({ timezone: reportedTimezone })
      } catch (err) {
        this.warnings.push(
          `Reflection reported a timezone this session that could not be saved: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/reflection.test.ts packages/memory/src/engine.test.ts`

Expected: PASS. `Test Files  2 passed (2)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.` One existing assertion in `reflection.test.ts` checks the prompt contains `'identity facts'`; it still passes, because that phrase stays.

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Let reflection correct the timezone into profile.md instead of constitution prose"
```

---

### Task 17: The live `update_profile` tool

**Files:**
- Modify: `packages/core/src/tools.ts:54-66` (arg schemas), `218-249` (definitions), `252-287` (dispatch), and a new dispatch function
- Modify: `packages/core/src/agent.ts:326-332`
- Test: `packages/core/src/tools.test.ts` (append two tests)
- Test: `packages/core/src/agent.test.ts` (append one test)

**Interfaces:**
- Consumes: `MemoryEngine.updateProfile(patch: { timezone?: string }): Promise<Profile>` from Task 4; `assembleSystemPrompt(engine, config)` which already exists.
- Produces: a new tool named `update_profile` taking `{ timezone: string }`.

Unlike `update_style`, this does not go through `ToolDeps`. Style lives in `config.toml`, which is a CLI concern core must not know the path of; the profile lives in the memory folder, which `MemoryEngine` already owns. So dispatch calls the engine directly.

The system prompt is reassembled after a successful call, the same way `update_style` already does it, so the `## Time` section reflects the confirmed zone for the rest of the session. That costs one cache miss, once, typically during the first conversation. Messages already stamped keep the stamp they were written with; they are never re-rendered.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/tools.test.ts`:

```typescript
  it('update_profile writes a confirmed timezone through the engine', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const sessionId = await engine.startSession()

    const result = await dispatchTool(engine, sessionId, {
      id: 'call_1',
      name: 'update_profile',
      arguments: JSON.stringify({ timezone: 'Asia/Kolkata' }),
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.timezone).toBe('Asia/Kolkata')
    expect(engine.timezone()).toBe('Asia/Kolkata')
    expect(engine.timezoneSource()).toBe('user-confirmed')

    await engine.close()
  })

  it('update_profile reports an unrecognized zone as a tool error instead of throwing', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const sessionId = await engine.startSession()
    const before = engine.timezone()

    const result = await dispatchTool(engine, sessionId, {
      id: 'call_1',
      name: 'update_profile',
      arguments: JSON.stringify({ timezone: 'Nowhere/Fake' }),
    })

    expect(JSON.parse(result).error).toContain('Nowhere/Fake')
    expect(engine.timezone()).toBe(before)

    await engine.close()
  })
```

Append to `packages/core/src/agent.test.ts`, inside `describe('AgentSession', ...)`:

```typescript
  it('reassembles the system prompt after update_profile so the Time section shows the confirmed zone', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'update_profile',
            arguments: JSON.stringify({ timezone: 'Asia/Kolkata' }),
          },
        ],
      },
      { text: 'Got it, thanks.', toolCalls: [] },
      { text: 'Sure.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('I live in Bengaluru.'))
    await collect(session.send('Anything else?'))

    const last = chat.requests.at(-1)?.system ?? ''
    expect(last).toContain("This person's timezone is Asia/Kolkata.")
    expect(last).not.toContain('This timezone is a system default')

    await engine.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools.test.ts -t "update_profile"`

Expected: FAIL with `AssertionError: expected undefined to be true` on `parsed.ok`, because dispatch returns `{"error":"unknown tool: update_profile"}`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/tools.ts`, add the argument schema next to `updateStyleArgs`:

```typescript
const updateProfileArgs = z.strictObject({
  timezone: z.string(),
})
```

add the definition to the array returned by `toolDefinitions()`, after `update_style`:

```typescript
    {
      name: 'update_profile',
      description:
        'Record a structured personal fact reverie has to read back out in code. Right now that is the ' +
        "person's timezone, as an IANA name such as Asia/Kolkata or America/New_York. Call this as soon as the " +
        'person tells you where they are or corrects the timezone you were assuming, rather than waiting for the ' +
        'end of the conversation. The local times shown on their messages start using it from that point onward.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description:
              'The IANA timezone name for where the person actually is, for example Asia/Kolkata or ' +
              'America/New_York. Not an abbreviation like IST or EST, and not a UTC offset.',
          },
        },
        required: ['timezone'],
        additionalProperties: false,
      },
    },
```

add the case to `dispatchTool`'s switch, after `update_style`:

```typescript
      case 'update_profile':
        return await dispatchUpdateProfile(engine, parsedArgs.value)
```

and add the dispatch function next to `dispatchUpdateStyle`:

```typescript
// Unlike update_style, this does not go through ToolDeps. Style lives in
// config.toml, whose path is a CLI concern core must not know; the profile
// lives in the memory folder, which MemoryEngine already owns. An
// unrecognized zone name throws inside updateProfile and is turned into a
// tool error by dispatchTool's own catch, so the model sees its mistake in
// the transcript and can correct it.
async function dispatchUpdateProfile(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = updateProfileArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('update_profile', parsed.error))

  const profile = await engine.updateProfile({ timezone: parsed.data.timezone })
  return JSON.stringify({
    ok: true,
    timezone: profile.meta.timezone,
    message:
      'Saved. Local times on their messages use this from now on, in this conversation and in future ones.',
  })
}
```

In `packages/core/src/agent.ts`, extend the post-dispatch reassembly block (currently lines 326-332):

```typescript
        // If update_style succeeds, reassemble the system prompt so the new
        // style applies immediately to subsequent requests.
        if (toolCall.name === 'update_style' && !this.resultHasError(result)) {
          const resultData = JSON.parse(result)
          this.config.style = resultData.style
          this.system = await assembleSystemPrompt(this.engine, this.config)
        }

        // Same for update_profile: the Time section is built from the
        // profile, so a confirmed timezone has to be reassembled in for the
        // rest of this session. This costs one cache miss, once, typically
        // during the first conversation. Messages already stamped keep the
        // stamp they were written with and are never re-rendered.
        if (toolCall.name === 'update_profile' && !this.resultHasError(result)) {
          this.system = await assembleSystemPrompt(this.engine, this.config)
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools.test.ts packages/core/src/agent.test.ts`

Expected: PASS. `Test Files  2 passed (2)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.` If a test asserts the exact number of tool definitions, update the count rather than removing the tool.

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/tools.ts packages/core/src/tools.test.ts packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "Add an update_profile tool so a confirmed timezone lands mid-conversation"
```

---

### Task 18: The migration registry, the migrations.jsonl log, and the runner

**Files:**
- Create: `packages/memory/src/migrations/index.ts`
- Test: `packages/memory/src/migrations/migrations.test.ts` (create)
- Modify: `packages/memory/src/paths.ts:9-37` (add `migrationsLog`)
- Modify: `packages/memory/src/index.ts` (re-export `migrations/index.js`)

**Interfaces:**
- Consumes: `MemoryPaths` from `packages/memory/src/paths.ts` (gains `migrationsLog` here). `appendFile` and `readFile` from `node:fs/promises`.
- Produces:
  - `interface MigrationContext { paths: MemoryPaths; configPath: string }`
  - `interface MigrationResult { id: string; applied: boolean; summary: string; details: string[] }`
  - `interface Migration { id: string; description: string; isPending(ctx: MigrationContext): Promise<boolean>; apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> }`
  - `interface MigrationLogEntry { id: string; appliedAt: string }`
  - `interface MigrationStatus { id: string; description: string; applied: boolean }`
  - `interface RunMigrationsOptions { dryRun: boolean }`
  - `export const migrations: Migration[]` (empty in this task; Task 19 and Task 20 register the two migrations)
  - `readAppliedMigrationIds(paths: MemoryPaths): Promise<Set<string>>`
  - `appendMigrationLog(paths: MemoryPaths, entry: MigrationLogEntry): Promise<void>`
  - `listMigrations(ctx: MigrationContext): Promise<MigrationStatus[]>`
  - `runMigrations(ctx: MigrationContext, options?: RunMigrationsOptions): Promise<MigrationResult[]>`

`MigrationContext` is `{ paths: MemoryPaths; configPath: string }`, not a bare `MemoryPaths`, because config.toml is not in `MemoryPaths` and its path is overridable per invocation with `--config`. A migration that reads or rewrites config.toml cannot find it from `MemoryPaths` and must not guess the default path.

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/migrations/migrations.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryPaths, type MemoryPaths } from '../paths.js'
import {
  appendMigrationLog,
  listMigrations,
  readAppliedMigrationIds,
  runMigrations,
  type MigrationContext,
} from './index.js'

describe('migrations log and runner', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-migrations-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('exposes migrations.jsonl as migrationsLog on MemoryPaths', () => {
    expect(paths.migrationsLog).toBe(join(dir, 'migrations.jsonl'))
  })

  it('round-trips applied ids through the log', async () => {
    await appendMigrationLog(paths, { id: 'profile-seed', appliedAt: '2026-08-17T00:00:00.000Z' })
    await appendMigrationLog(paths, {
      id: 'utc-to-local-rollups',
      appliedAt: '2026-08-17T00:00:01.000Z',
    })
    const ids = await readAppliedMigrationIds(paths)
    expect(ids).toEqual(new Set(['profile-seed', 'utc-to-local-rollups']))
  })

  it('treats a missing log as having no applied migrations', async () => {
    await expect(readAppliedMigrationIds(paths)).resolves.toEqual(new Set())
  })

  it('throws, naming the path and the line, when a log line is not valid JSON', async () => {
    await writeFile(paths.migrationsLog, 'not json\n', 'utf8')
    await expect(readAppliedMigrationIds(paths)).rejects.toThrow('line 1')
  })

  it('lists nothing and runs nothing against an empty registry', async () => {
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }
    await expect(listMigrations(ctx)).resolves.toEqual([])
    await expect(runMigrations(ctx)).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/migrations/migrations.test.ts`

Expected: FAIL. The run reports it could not resolve `./index.js` (the file does not exist), and TypeScript reports `migrationsLog` does not exist on `MemoryPaths` and that `appendMigrationLog`, `readAppliedMigrationIds`, `listMigrations`, and `runMigrations` are not exported. `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

First, add `migrationsLog` to `packages/memory/src/paths.ts`. The interface and `memoryPaths` become:

```typescript
export interface MemoryPaths {
  root: string
  constitution: string
  profile: string
  migrationsLog: string
  realmsDir: string
  arcsDir: string
  peopleDir: string
  sessionsDir: string
  rollupsDailyDir: string
  rollupsWeeklyDir: string
  graphLog: string
  proposals: string
  indexDb: string
}

export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    constitution: join(root, 'constitution.md'),
    profile: join(root, 'profile.md'),
    migrationsLog: join(root, 'migrations.jsonl'),
    realmsDir: join(root, 'realms'),
    arcsDir: join(root, 'arcs'),
    peopleDir: join(root, 'people'),
    sessionsDir: join(root, 'sessions'),
    rollupsDailyDir: join(root, 'rollups', 'daily'),
    rollupsWeeklyDir: join(root, 'rollups', 'weekly'),
    graphLog: join(root, 'graph.jsonl'),
    proposals: join(root, 'proposals.jsonl'),
    indexDb: join(root, 'index.db'),
  }
}
```

Then create `packages/memory/src/migrations/index.ts`:

```typescript
// The migration registry: a small, named, idempotent unit of work for a
// memory folder, applied explicitly by `reverie migrate` and never
// automatically on open. Nothing here runs during MemoryEngine.open.
//
// A migration takes a MigrationContext, not a bare MemoryPaths. config.toml
// is not in MemoryPaths: that interface holds only paths inside the memory
// folder, and the config file lives outside it, overridable per invocation
// with --config. A migration that needs to read or rewrite the config file
// cannot find it from MemoryPaths and must not guess the default path, so
// the path `reverie` actually loaded the config from rides in the context.
//
// Applied migrations are recorded, one line each, in an append-only log at
// <memoryDir>/migrations.jsonl ({ id, appliedAt }). runMigrations reads that
// log up front and skips any id already in it, so a second run of `reverie
// migrate` is a no-op by a cheap set-membership check instead of every
// migration re-inspecting the whole folder.

import { appendFile, readFile } from 'node:fs/promises'
import type { MemoryPaths } from '../paths.js'

export interface MigrationContext {
  paths: MemoryPaths
  configPath: string
}

export interface MigrationResult {
  id: string
  // True when apply actually wrote to disk; false under a dry run.
  applied: boolean
  // One human-readable line describing what happened or what would happen.
  summary: string
  // Zero or more paths, printed one per line under the summary.
  details: string[]
}

export interface Migration {
  // Stable across releases, e.g. "profile-seed".
  id: string
  description: string
  isPending(ctx: MigrationContext): Promise<boolean>
  apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult>
}

export interface MigrationLogEntry {
  id: string
  appliedAt: string
}

export interface MigrationStatus {
  id: string
  description: string
  applied: boolean
}

export interface RunMigrationsOptions {
  dryRun: boolean
}

// The ordered list of migrations `reverie migrate` iterates. Empty in this
// task; profile-seed and utc-to-local-rollups register themselves in the two
// tasks that add them. Order matters once there is more than one: a later
// migration may depend on a file an earlier one just wrote.
export const migrations: Migration[] = []

export async function readAppliedMigrationIds(paths: MemoryPaths): Promise<Set<string>> {
  let raw: string
  try {
    raw = await readFile(paths.migrationsLog, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set()
    }
    throw err
  }

  const ids = new Set<string>()
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') {
      continue
    }
    let entry: MigrationLogEntry
    try {
      entry = JSON.parse(line) as MigrationLogEntry
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Migration log ${paths.migrationsLog} line ${i + 1} is not valid JSON: ${message}`,
      )
    }
    if (typeof entry.id === 'string' && entry.id.length > 0) {
      ids.add(entry.id)
    }
  }
  return ids
}

export async function appendMigrationLog(
  paths: MemoryPaths,
  entry: MigrationLogEntry,
): Promise<void> {
  await appendFile(paths.migrationsLog, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function listMigrations(ctx: MigrationContext): Promise<MigrationStatus[]> {
  const appliedIds = await readAppliedMigrationIds(ctx.paths)
  return migrations.map((migration) => ({
    id: migration.id,
    description: migration.description,
    applied: appliedIds.has(migration.id),
  }))
}

export async function runMigrations(
  ctx: MigrationContext,
  options: RunMigrationsOptions = { dryRun: false },
): Promise<MigrationResult[]> {
  const appliedIds = await readAppliedMigrationIds(ctx.paths)
  const results: MigrationResult[] = []
  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue
    }
    if (!(await migration.isPending(ctx))) {
      continue
    }
    const result = await migration.apply(ctx, { dryRun: options.dryRun })
    if (!options.dryRun) {
      await appendMigrationLog(ctx.paths, {
        id: migration.id,
        appliedAt: new Date().toISOString(),
      })
      result.applied = true
    }
    results.push(result)
  }
  return results
}
```

`appliedAt` is record time, not a calendar day boundary, so a bare `new Date().toISOString()` is correct here, the same as every `ts` in `graph.jsonl`.

Finally, in `packages/memory/src/index.ts`, re-export the migrations module, keeping the list alphabetical:

```typescript
export * from './documents.js'
export * from './engine.js'
export * from './gitSync.js'
export * from './graph.js'
export * from './migrations/index.js'
export * from './paths.js'
export * from './profile.js'
export * from './proposals.js'
export * from './reflection.js'
export * from './retrieval.js'
export * from './rollups.js'
export * from './sqlite.js'
export * from './time.js'
export * from './transcripts.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/migrations/migrations.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/migrations/index.ts packages/memory/src/migrations/migrations.test.ts packages/memory/src/paths.ts packages/memory/src/index.ts
git commit -m "Add the migration registry, the migrations.jsonl log, and the runner"
```

---

### Task 19: The `profile-seed` migration

**Files:**
- Create: `packages/memory/src/migrations/profileSeed.ts`
- Modify: `packages/memory/src/migrations/index.ts` (register `profileSeedMigration` in `migrations`)
- Test: `packages/memory/src/migrations/migrations.test.ts` (append tests)

**Interfaces:**
- Consumes: `starterProfileDocument(path: string, timezone: string)` from Task 2; `systemTimeZone(): string` from Task 1; `writeDocumentAtomic(doc: Document): Promise<void>` from `packages/memory/src/documents.ts`; `Migration`, `MigrationContext`, `MigrationResult` from Task 18; `ensureMemoryTree(paths: MemoryPaths): Promise<void>` from Task 3; `loadProfile(paths: MemoryPaths): Promise<Profile>` from Task 2.
- Produces: `profileSeedMigration: Migration` with `id: 'profile-seed'`.

`ensureMemoryTree` seeds `profile.md` only on the next open of a folder that is missing it, which is a silent side effect. A pre-existing folder needs an explicit, auditable step instead, and this is it: write `profile.md` with a system-default timezone, exactly as `ensureMemoryTree` would for a brand-new folder.

- [ ] **Step 1: Write the failing test**

Append to `packages/memory/src/migrations/migrations.test.ts`. First extend the imports: add `readFile` to the `node:fs/promises` import, add `ensureMemoryTree` to the `../paths.js` import, and add these two lines:

```typescript
import { loadProfile } from '../profile.js'
import { profileSeedMigration } from './profileSeed.js'
```

Then append this block:

```typescript
describe('profile-seed migration', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-profile-seed-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is pending when profile.md is absent and not pending once it exists', async () => {
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })

    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }
    await expect(profileSeedMigration.isPending(ctx)).resolves.toBe(true)

    await profileSeedMigration.apply(ctx, { dryRun: false })
    await expect(profileSeedMigration.isPending(ctx)).resolves.toBe(false)
  })

  it('apply writes a system-default profile on disk, and a dry run does not', async () => {
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }

    const dry = await profileSeedMigration.apply(ctx, { dryRun: true })
    expect(dry.applied).toBe(false)
    expect(dry.summary).toContain('would write')
    await expect(readFile(paths.profile, 'utf8')).rejects.toThrow()

    const real = await profileSeedMigration.apply(ctx, { dryRun: false })
    expect(real.applied).toBe(true)
    expect(real.summary).toContain('wrote')
    const profile = await loadProfile(paths)
    expect(profile.meta.timezoneSource).toBe('system-default')
    expect(typeof profile.meta.timezone).toBe('string')
  })

  it('runMigrations applies it once and records it, and a second run does nothing', async () => {
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }

    const first = await runMigrations(ctx)
    expect(first.map((result) => result.id)).toEqual(['profile-seed'])

    const applied = await readAppliedMigrationIds(paths)
    expect(applied.has('profile-seed')).toBe(true)

    const second = await runMigrations(ctx)
    expect(second).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/migrations/migrations.test.ts -t "profile-seed"`

Expected: FAIL. The run reports it could not resolve `./profileSeed.js`, and `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/memory/src/migrations/profileSeed.ts`:

```typescript
// Migration "profile-seed": write profile.md into a memory folder that
// predates it. A folder created after this shipped gets profile.md from
// ensureMemoryTree on the next open, but a folder that already exists does
// not, and an explicit migration makes that seeding a listed, auditable
// action instead of a silent side effect. The file is written exactly as
// ensureMemoryTree would for a brand-new folder: a system-default timezone,
// marked as a guess rather than a fact the person confirmed.

import { access } from 'node:fs/promises'
import { writeDocumentAtomic } from '../documents.js'
import { starterProfileDocument } from '../profile.js'
import { systemTimeZone } from '../time.js'
import type { Migration, MigrationContext, MigrationResult } from './index.js'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const profileSeedMigration: Migration = {
  id: 'profile-seed',
  description:
    'Seed profile.md with a system-default timezone into a memory folder that predates it.',
  async isPending(ctx: MigrationContext): Promise<boolean> {
    return !(await fileExists(ctx.paths.profile))
  },
  async apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> {
    const summary = opts.dryRun
      ? 'would write profile.md with a system-default timezone'
      : 'wrote profile.md with a system-default timezone'
    if (!opts.dryRun) {
      const doc = starterProfileDocument(ctx.paths.profile, systemTimeZone())
      await writeDocumentAtomic(doc)
    }
    return {
      id: 'profile-seed',
      applied: !opts.dryRun,
      summary,
      details: [ctx.paths.profile],
    }
  },
}
```

Then register it in `packages/memory/src/migrations/index.ts`: add the import and change the array.

```typescript
import { profileSeedMigration } from './profileSeed.js'
```

```typescript
export const migrations: Migration[] = [profileSeedMigration]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/migrations/migrations.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/migrations/profileSeed.ts packages/memory/src/migrations/index.ts packages/memory/src/migrations/migrations.test.ts
git commit -m "Add the profile-seed migration so pre-existing folders get a profile.md"
```

---

### Task 20: The `utc-to-local-rollups` migration

**Files:**
- Create: `packages/memory/src/migrations/utcToLocalRollups.ts`
- Modify: `packages/memory/src/migrations/index.ts` (register `utcToLocalRollupsMigration` in `migrations`)
- Test: `packages/memory/src/migrations/migrations.test.ts` (append tests)

**Interfaces:**
- Consumes: `readAppliedMigrationIds(paths: MemoryPaths): Promise<Set<string>>` from Task 18; `Migration`, `MigrationContext`, `MigrationResult` from Task 18; `newId(prefix: IdPrefix): string` and `writeDocumentAtomic(doc: Document): Promise<void>` from `packages/memory/src/documents.ts`; `ensureMemoryTree(paths: MemoryPaths): Promise<void>` from Task 3.
- Produces: `utcToLocalRollupsMigration: Migration` with `id: 'utc-to-local-rollups'`.

Rollups are derived documents, synthesized from session summaries, and are not sacred the way transcripts are. Re-dating an existing rollup file in place is not a safe script for every edge case, and the synthesized prose inside would still describe whatever the old UTC boundary grouped together. This migration deletes every daily and weekly rollup file and lets the next `runMaintenance` pass rebuild them on local-day boundaries. Session summaries are untouched.

`isPending` reads `migrations.jsonl` for its own id as well as looking at the rollup directories: after this migration runs once, a later maintenance pass regenerates rollups correctly, and a second `reverie migrate` must not delete those fresh, correctly-dated files.

- [ ] **Step 1: Write the failing test**

Append to `packages/memory/src/migrations/migrations.test.ts`. First extend the imports with these two lines:

```typescript
import { newId, writeDocumentAtomic } from '../documents.js'
import { utcToLocalRollupsMigration } from './utcToLocalRollups.js'
```

Then append this block:

```typescript
describe('utc-to-local-rollups migration', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-utc-rollups-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is pending when rollups exist, and not pending when there are none', async () => {
    await ensureMemoryTree(paths)
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }
    await expect(utcToLocalRollupsMigration.isPending(ctx)).resolves.toBe(false)

    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await expect(utcToLocalRollupsMigration.isPending(ctx)).resolves.toBe(true)
  })

  it('is not pending once recorded in the log, even when rollups exist again', async () => {
    await ensureMemoryTree(paths)
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await appendMigrationLog(paths, {
      id: 'utc-to-local-rollups',
      appliedAt: '2026-08-17T00:00:00.000Z',
    })
    await expect(utcToLocalRollupsMigration.isPending(ctx)).resolves.toBe(false)
  })

  it('apply deletes every daily and weekly rollup, and a dry run deletes nothing', async () => {
    await ensureMemoryTree(paths)
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }
    const dailyPath = join(paths.rollupsDailyDir, '2026-08-15.md')
    const weeklyPath = join(paths.rollupsWeeklyDir, '2026-W33.md')
    await writeDocumentAtomic({
      path: dailyPath,
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await writeDocumentAtomic({
      path: weeklyPath,
      meta: { id: newId('doc'), week: '2026-W33' },
      body: 'A week.\n',
    })

    const dry = await utcToLocalRollupsMigration.apply(ctx, { dryRun: true })
    expect(dry.applied).toBe(false)
    expect(dry.details).toContain(dailyPath)
    expect(dry.details).toContain(weeklyPath)
    await expect(readFile(dailyPath, 'utf8')).resolves.toBeDefined()

    const real = await utcToLocalRollupsMigration.apply(ctx, { dryRun: false })
    expect(real.applied).toBe(true)
    await expect(readFile(dailyPath, 'utf8')).rejects.toThrow()
    await expect(readFile(weeklyPath, 'utf8')).rejects.toThrow()
  })

  it('runMigrations runs both migrations once and a second run is a no-op', async () => {
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }

    const first = await runMigrations(ctx)
    expect(first.map((result) => result.id)).toEqual(['profile-seed', 'utc-to-local-rollups'])

    await expect(readFile(paths.profile, 'utf8')).resolves.toBeDefined()
    await expect(readFile(join(paths.rollupsDailyDir, '2026-08-15.md'), 'utf8')).rejects.toThrow()

    const second = await runMigrations(ctx)
    expect(second).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/migrations/migrations.test.ts -t "utc-to-local-rollups"`

Expected: FAIL. The run reports it could not resolve `./utcToLocalRollups.js`, and `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/memory/src/migrations/utcToLocalRollups.ts`:

```typescript
// Migration "utc-to-local-rollups": delete every existing daily and weekly
// rollup file so the next maintenance pass rebuilds them from session
// summaries on local-day boundaries.
//
// Rollups are derived documents, synthesized by an LLM call from session
// summaries. They are not sacred the way transcripts are. Re-dating an
// existing rollup file in place is not a safe script to write for every
// edge case, and the synthesized prose inside would still describe whatever
// the old UTC boundary grouped together, so this migration discards them and
// lets runMaintenance regenerate them. Session summaries are untouched.
//
// This migration checks migrations.jsonl for its own id rather than only
// looking at the rollup directories: after it runs once, a later
// maintenance pass regenerates rollups (correctly, on local-day boundaries),
// and those must not be deleted again by a second `reverie migrate`.

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readAppliedMigrationIds,
  type Migration,
  type MigrationContext,
  type MigrationResult,
} from './index.js'

const ID = 'utc-to-local-rollups'

async function listRollupFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => join(dir, entry))
}

export const utcToLocalRollupsMigration: Migration = {
  id: ID,
  description: 'Delete every daily and weekly rollup so they rebuild on local-day boundaries.',
  async isPending(ctx: MigrationContext): Promise<boolean> {
    const applied = await readAppliedMigrationIds(ctx.paths)
    if (applied.has(ID)) {
      return false
    }
    const daily = await listRollupFiles(ctx.paths.rollupsDailyDir)
    const weekly = await listRollupFiles(ctx.paths.rollupsWeeklyDir)
    return daily.length > 0 || weekly.length > 0
  },
  async apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> {
    const daily = await listRollupFiles(ctx.paths.rollupsDailyDir)
    const weekly = await listRollupFiles(ctx.paths.rollupsWeeklyDir)
    const files = [...daily, ...weekly]
    const summary = opts.dryRun
      ? `would delete ${daily.length} daily and ${weekly.length} weekly rollup files; they will be regenerated with local-day boundaries on next use`
      : `deleted ${daily.length} daily and ${weekly.length} weekly rollup files; they will be regenerated with local-day boundaries on next use`
    if (!opts.dryRun) {
      for (const file of files) {
        await rm(file)
      }
    }
    return { id: ID, applied: !opts.dryRun, summary, details: files }
  },
}
```

`readAppliedMigrationIds` is a hoisted `export async function`, so the import above, back into the module that registers this migration, is safe: it is only called inside `isPending` and `apply`, never while either module is still being evaluated.

Then register it in `packages/memory/src/migrations/index.ts`: add the import and change the array.

```typescript
import { profileSeedMigration } from './profileSeed.js'
import { utcToLocalRollupsMigration } from './utcToLocalRollups.js'
```

```typescript
export const migrations: Migration[] = [profileSeedMigration, utcToLocalRollupsMigration]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/migrations/migrations.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/memory/src/migrations/utcToLocalRollups.ts packages/memory/src/migrations/index.ts packages/memory/src/migrations/migrations.test.ts
git commit -m "Add the utc-to-local-rollups migration so rollups rebuild on local-day boundaries"
```

---

### Task 21: The `reverie migrate` CLI subcommand

**Files:**
- Create: `packages/cli/src/migrate.ts`
- Test: `packages/cli/src/migrate.test.ts` (create)
- Modify: `packages/cli/src/index.ts:101-117` (`CliMainDeps`), `119-181` (`mainWith`), `183-199` (`defaultDeps`)

**Interfaces:**
- Consumes: `listMigrations(ctx: MigrationContext): Promise<MigrationStatus[]>`, `runMigrations(ctx: MigrationContext, options?: RunMigrationsOptions): Promise<MigrationResult[]>`, `memoryPaths(root: string): MemoryPaths`, and the `MigrationContext` type, all from `@openreverie/memory` (exported by Task 18). `ReverieConfig` from `@openreverie/core`. `CliMainDeps` from `packages/cli/src/index.ts`.
- Produces:
  - `interface MigrateDeps { loadConfig: () => Promise<ReverieConfig>; configPath: string; write: (text: string) => void }`
  - `runMigrate(args: string[], deps: MigrateDeps): Promise<number>`

Like `read.ts`, this path uses `loadConfig` and `memoryPaths` only, no engine, no provider, no network, so migrating works with the provider offline or unconfigured. `configPath` is threaded into the `MigrationContext` because that is the real path the config was loaded from, which `--config` can move off the default.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/migrate.test.ts`:

```typescript
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import {
  ensureMemoryTree,
  memoryPaths,
  newId,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainWith } from './index.js'
import { runMigrate, type MigrateDeps } from './migrate.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function fakeDeps(memoryDir: string, output: string[], configPath = '/tmp/config.toml'): MigrateDeps {
  return {
    loadConfig: async () => testConfig(memoryDir),
    configPath,
    write: (text: string) => output.push(text),
  }
}

describe('runMigrate', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-migrate-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists pending migrations with --list', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })

    const output: string[] = []
    const exitCode = await runMigrate(['--list'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('pending')
    expect(joined).toContain('profile-seed')
    expect(joined).toContain('utc-to-local-rollups')
  })

  it('applies pending migrations and reports what it did', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })

    const output: string[] = []
    const exitCode = await runMigrate([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('wrote profile.md')
    expect(joined).toContain('deleted 1 daily and 0 weekly rollup files')
    await expect(readFile(paths.profile, 'utf8')).resolves.toBeDefined()
    await expect(readFile(join(paths.rollupsDailyDir, '2026-08-15.md'), 'utf8')).rejects.toThrow()
  })

  it('reports a missing memory folder and exits non-zero', async () => {
    const missingDir = join(dir, 'never-created')

    const output: string[] = []
    const exitCode = await runMigrate([], fakeDeps(missingDir, output))

    expect(exitCode).not.toBe(0)
    expect(output.join('')).toContain('No memory folder found')
  })

  it('prints the config error and exits non-zero when loadConfig throws', async () => {
    const output: string[] = []
    const deps: MigrateDeps = {
      loadConfig: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      configPath: '/tmp/config.toml',
      write: (text: string) => output.push(text),
    }
    const exitCode = await runMigrate([], deps)

    expect(exitCode).toBe(1)
    expect(output.join('')).toContain('No config found. Run: reverie setup')
  })
})

describe('mainWith migrate dispatch', () => {
  it('dispatches migrate before normal chat setup', async () => {
    const runMigrateMock = vi.fn(async () => 0)
    const openCliContext = vi.fn()
    const deps = {
      runMigrate: runMigrateMock,
      openCliContext,
      loadConfig: vi.fn(),
      configPath: '/tmp/config.toml',
      write: () => {},
      colorEnabled: () => false,
    }

    await mainWith(['migrate'], deps as never)

    expect(runMigrateMock).toHaveBeenCalledOnce()
    expect(openCliContext).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/migrate.test.ts`

Expected: FAIL. The run reports it could not resolve `./migrate.js`, and `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/migrate.ts`:

```typescript
// `reverie migrate`: apply pending memory-folder migrations, deliberately
// and explicitly, never automatically on open. Built the same way read.ts
// is: loadConfig to learn the memory folder, memoryPaths to address it, and
// the migration registry from @openreverie/memory. No engine, no provider,
// no network: migrations touch only prose files and rollups, and this
// command must work with the provider offline or unconfigured.
//
// configPath is threaded through because the migration context needs the
// real path the config was loaded from, not the default. A migration that
// reads or rewrites config.toml must not guess, since --config can point
// anywhere.

import { stat } from 'node:fs/promises'
import type { ReverieConfig } from '@openreverie/core'
import {
  listMigrations,
  memoryPaths,
  runMigrations,
  type MigrationContext,
} from '@openreverie/memory'

export interface MigrateDeps {
  loadConfig: () => Promise<ReverieConfig>
  configPath: string
  write: (text: string) => void
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function runMigrate(args: string[], deps: MigrateDeps): Promise<number> {
  const dryRun = args.includes('--dry-run')
  const list = args.includes('--list')

  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    deps.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const paths = memoryPaths(config.memoryDir)
  if (!(await pathIsDirectory(paths.root))) {
    deps.write(`No memory folder found at ${paths.root}. Run: reverie setup\n`)
    return 1
  }

  const ctx: MigrationContext = { paths, configPath: deps.configPath }

  if (list) {
    const statuses = await listMigrations(ctx)
    for (const status of statuses) {
      deps.write(`${status.applied ? 'applied' : 'pending'}  ${status.id}: ${status.description}\n`)
    }
    return 0
  }

  const results = await runMigrations(ctx, { dryRun })
  if (results.length === 0) {
    deps.write('Nothing to migrate: every migration is already applied.\n')
    return 0
  }
  for (const result of results) {
    deps.write(`${result.summary}\n`)
    for (const detail of result.details) {
      deps.write(`  ${detail}\n`)
    }
  }
  return 0
}
```

Then wire it into `packages/cli/src/index.ts`. Add the import:

```typescript
import { runMigrate } from './migrate.js'
```

Add `runMigrate` to `CliMainDeps`, right after `runRead`:

```typescript
  runRead: typeof runRead
  runMigrate: typeof runMigrate
```

Add the dispatch in `mainWith`, right after the `read` block:

```typescript
  if (subcommand === 'migrate') {
    const exitCode = await deps.runMigrate(args.slice(1), {
      loadConfig: () => deps.loadConfig(deps.configPath),
      configPath: deps.configPath,
      write: deps.write,
    })
    process.exitCode = exitCode
    return
  }
```

And add it to `defaultDeps`, right after `runRead`:

```typescript
  runRead,
  runMigrate,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/migrate.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/cli/src/migrate.ts packages/cli/src/migrate.test.ts packages/cli/src/index.ts
git commit -m "Add the reverie migrate subcommand with --dry-run and --list"
```

---

### Task 22: Dry-run byte-identity and run-twice idempotency guardrails

**Files:**
- Test: `packages/cli/src/migrate.test.ts` (append tests and a folder-hash helper)

**Interfaces:**
- Consumes: `runMigrate(args: string[], deps: MigrateDeps): Promise<number>` from Task 21; `SessionStore.start(paths: MemoryPaths, now: Date, timezone?: string): Promise<SessionStore>` from Task 8; `ensureMemoryTree`, `memoryPaths`, `newId`, `writeDocumentAtomic` from `@openreverie/memory`.
- Produces: nothing new. These are the two end-to-end guardrails the spec names for `reverie migrate`: a dry run changes nothing on disk, and a second run does no work and never touches a transcript.

Both tests are written against the behavior built in Tasks 18 through 21, so they pass immediately. The point of the task is the falsification in Step 3, which proves each test actually guards the behavior it is named for.

- [ ] **Step 1: Write the tests**

Append to `packages/cli/src/migrate.test.ts`. First extend the imports: add `createHash` from `node:crypto`, add `readdir` to the `node:fs/promises` import, and add `SessionStore` to the `@openreverie/memory` import.

```typescript
import { createHash } from 'node:crypto'
```

```typescript
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
```

```typescript
import {
  ensureMemoryTree,
  memoryPaths,
  newId,
  SessionStore,
  writeDocumentAtomic,
} from '@openreverie/memory'
```

Add this helper after `fakeDeps`:

```typescript
// Hashes every file under `root` recursively, in sorted path order, with
// each entry's name folded in so renames register too. Excludes index.db
// (a derived artifact) and any *.tmp-* file (an in-flight atomic write), the
// two entries the seeded .gitignore already names.
async function hashFolder(root: string): Promise<string> {
  const hash = createHash('sha256')
  const entries = await readdir(root, { withFileTypes: true })
  const sorted = entries
    .filter((entry) => entry.name !== 'index.db' && !entry.name.includes('.tmp-'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of sorted) {
    const full = join(root, entry.name)
    hash.update(entry.name)
    if (entry.isDirectory()) {
      hash.update(await hashFolder(full))
    } else {
      hash.update(await readFile(full))
    }
  }
  return hash.digest('hex')
}
```

Then append these two tests inside the existing `describe('runMigrate', ...)`:

```typescript
  it('--dry-run reports pending deletions and changes nothing on disk, proven by a folder hash', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-14.md'),
      meta: { id: newId('doc'), date: '2026-08-14' },
      body: 'A rollup.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.rollupsWeeklyDir, '2026-W33.md'),
      meta: { id: newId('doc'), week: '2026-W33' },
      body: 'A week.\n',
    })

    const before = await hashFolder(dir)

    const output: string[] = []
    const exitCode = await runMigrate(['--dry-run'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    expect(output.join('')).toContain('would delete 2 daily and 1 weekly rollup files')
    expect(output.join('')).toContain('would write profile.md')

    const after = await hashFolder(dir)
    expect(after).toBe(before)
  })

  it('running twice does the work once: the second run reports nothing and leaves transcripts byte-identical', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'))
    await store.appendLine({ ts: '2026-08-15T21:00:00.000Z', role: 'user', content: 'hello' })

    const transcriptBefore = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')

    const first: string[] = []
    const firstCode = await runMigrate([], fakeDeps(dir, first))
    expect(firstCode).toBe(0)

    const second: string[] = []
    const secondCode = await runMigrate([], fakeDeps(dir, second))
    expect(secondCode).toBe(0)
    expect(second.join('')).toContain('Nothing to migrate')

    const transcriptAfter = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')
    expect(transcriptAfter).toBe(transcriptBefore)
  })
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run packages/cli/src/migrate.test.ts`

Expected: PASS. `Test Files  1 passed (1)`. The behavior they guard was built in Tasks 18 through 21.

- [ ] **Step 3: Falsify, do not read**

Temporarily make `runMigrations` in `packages/memory/src/migrations/index.ts` write in dry-run mode (change `if (!options.dryRun)` to `if (true)`) and run `npx vitest run packages/cli/src/migrate.test.ts -t "changes nothing on disk"`. It must FAIL, because the log gets appended and the folder hash changes. Restore. Then temporarily make `runMigrations` apply every migration unconditionally (delete both `continue` lines in the loop, so the applied-set and isPending guards are gone) and run `-t "running twice does the work once"`. It must FAIL, because the second run reports work again instead of "Nothing to migrate". Restore.

- [ ] **Step 4: Re-run to confirm pass**

Run: `npx vitest run packages/cli/src/migrate.test.ts`

Expected: PASS. `Test Files  1 passed (1)`.

- [ ] **Step 5: Verify the whole suite, the build, and the lint**

Run: `npx vitest run` then `npx tsc -b` then `npx biome check .`

Expected: all tests pass, `tsc -b` prints nothing, biome prints `No fixes applied.`

- [ ] **Step 6: Commit**
```bash
git add packages/cli/src/migrate.test.ts
git commit -m "Add dry-run and run-twice guardrail tests for reverie migrate"
```

---

### Task 23: Full verification: lint, build, and test

**Files:**
- Modify: `README.md` (add `migrate` to the subcommand list in Usage, and note the time features in Status, if the earlier tasks did not)

This task writes no code. It is the final gate: the whole suite, the typecheck build, and the lint must all be green, and the README must not claim less than the code now does.

- [ ] **Step 1: Run the lint**

Run: `pnpm lint`

Expected: `Checked N files in Mms. No fixes applied.` (or the equivalent biome success line), and exit code 0.

- [ ] **Step 2: Run the build**

Run: `pnpm build`

Expected: `tsc -b --force` completes with no errors, then the vite build for `@openreverie/web` completes, and exit code 0.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`

Expected: every test passes, including `packages/memory/src/migrations/migrations.test.ts` and `packages/cli/src/migrate.test.ts`. Exit code 0.

- [ ] **Step 4: Update the README so it stays honest**

Add `migrate` to the subcommand list under Usage, after `read`:

```markdown
- `migrate`: applies pending memory-folder migrations, deliberately and once. `migrate --dry-run` reports what would change without changing anything; `migrate --list` shows each migration as pending or applied. Migrations seed `profile.md` into pre-existing folders and discard UTC-dated rollups so they rebuild on local-day boundaries. Run it once after upgrading from a release that predates the timezone and profile work.
```

If the Status section's "What works today" list does not yet mention local times or `profile.md`, add one line to it now, plainly, so the README does not understate what shipped.

- [ ] **Step 5: Commit the README**
```bash
git add README.md
git commit -m "Document the reverie migrate subcommand"
```
