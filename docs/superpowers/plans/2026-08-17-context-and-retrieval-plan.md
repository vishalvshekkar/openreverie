# Context and Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every piece of memory the user has given the system reachable by the model, make every tool description true, and put a hard character budget on the assembled system prompt.

**Architecture:** `@openreverie/memory` owns the SQLite index, the graph state, and the `MemoryEngine` facade; `@openreverie/core` owns prompt assembly (`context.ts`) and the model-facing tool definitions and dispatch (`tools.ts`). This plan adds real date columns to the derived index and pushes date filtering into SQL, adds a graph-node search lane and four paging listing tools, and adds per-section character caps with truncation markers that always carry a fetch key.

**Tech Stack:** TypeScript (NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node 22, pnpm workspaces, vitest, better-sqlite3 (FTS5 + raw Float32Array blobs), zod, gray-matter, biome.

**Spec:** docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md

**Depends on:** the time plan (`2026-08-17-time-as-first-class-plan.md`) owns the `sessionId` render fix in `recentSummariesSection`. This plan assumes it is done and does not duplicate it.

## Global Constraints

- Package dependencies run downward only: `cli` -> `core` -> `memory` -> `providers`, and `server` -> `core` -> `memory` -> `providers`. Never import upward or sideways.
- `web` talks to `server` over HTTP only and never imports a runtime engine package.
- SQLite (`index.db`) is a derived index and must always be rebuildable from the memory folder; nothing may be stored only in SQLite.
- Truth lives in the memory folder: markdown prose files plus the append-only `graph.jsonl`.
- Transcripts are sacred: append-only, never modified, never deleted by code.
- Prose file writes are atomic (temp file then rename); graph log writes are single-line appends.
- Relationship claims in prose are testimony; the graph log is the record.
- Model access goes through `@openreverie/providers` interfaces; never call a provider SDK or HTTP API directly from another package.
- Never write code that sends memory folder contents anywhere except the user's configured model provider. No telemetry, no analytics.
- Both safety modes (companion and firewall) stay exactly as they are; never weaken or bypass crisis behavior.
- TDD for deterministic logic: write the failing test first, watch it fail, then implement.
- Validate all LLM structured output with zod schemas at the boundary.
- A tool description must be true: a tool that advertises a capability it does not have is a defect, not a gap.
- The prompt budget is specified and enforced in characters, not tokens. There is no tokenizer in this repository and nothing in this plan claims to count tokens.
- `capBody` applies to `assembleSystemPrompt` only and never to reflection's constitution input; truncating there would delete data from disk on the next constitution rewrite.
- Writing style for every comment, message and doc line: no em dashes, no AI tropes, no emoji in headings or lists. Plain, concrete prose.

---

## Commands

Run from the repository root, `/Users/vishal/work/personal/second-mind`.

| Purpose | Command |
| --- | --- |
| Whole test suite | `pnpm test` |
| One test file | `npx vitest run packages/memory/src/rollups.test.ts` (substitute the path) |
| One test by name | `npx vitest run packages/memory/src/rollups.test.ts -t "returns the Monday"` |
| Build (typecheck everything) | `pnpm build` |
| Lint | `pnpm lint` |
| Autoformat | `pnpm format` |

`pnpm test` runs `vitest run --passWithNoTests` with `projects: ['packages/*']`, so output lines are prefixed with the package name, for example `✓ |@openreverie/memory| src/rollups.test.ts (12 tests)`.

## File Structure

Files created by this plan:

```
packages/memory/src/dateSpan.ts          documentDateSpan, the point-in-time vs living classifier
packages/memory/src/dateSpan.test.ts
packages/core/src/budget.ts              character caps, capBody, capRows
packages/core/src/budget.test.ts
packages/core/src/docKinds.test.ts       the table-driven DocKind wiring test (P8)
docs/superpowers/plans/2026-08-17-context-and-retrieval-plan.md   (this file)
```

Files modified by this plan:

```
packages/memory/src/rollups.ts           isoMondayOf, isoSundayOf
packages/memory/src/rollups.test.ts
packages/memory/src/sqlite.ts            schema version, date columns, date predicate in SQL, searchNodes
packages/memory/src/sqlite.test.ts
packages/memory/src/retrieval.ts         date filter removed, node lane added, module comment rewritten
packages/memory/src/retrieval.test.ts
packages/memory/src/engine.ts            listing tools, search shape, SessionContext growth, migration rebuild
packages/memory/src/engine.test.ts
packages/memory/src/index.ts             export dateSpan.js
packages/core/src/context.ts             caps, markers, rollup shelf
packages/core/src/context.test.ts
packages/core/src/tools.ts               two new tools, new arguments, true descriptions
packages/core/src/tools.test.ts
packages/core/src/index.ts               export budget.js
packages/cli/src/e2e.test.ts             call sites for the changed listing and search shapes
docs/retrieval.md
README.md
```

---

## Task 1: ISO week inverse (`isoMondayOf`, `isoSundayOf`)

Deriving a Monday from an ISO week id does not exist in the repository. `isoWeekOf` goes date to week; nothing goes back. Task 2 needs both ends of a week's span.

**Files**

- Modify: `packages/memory/src/rollups.ts`
- Modify: `packages/memory/src/rollups.test.ts`

**Interfaces**

Consumes (already exists, `packages/memory/src/rollups.ts:28`):

```ts
export function isoWeekOf(date: string): string
```

Produces:

```ts
export function isoMondayOf(week: string): string
export function isoSundayOf(week: string): string
```

Both take an ISO 8601 week identifier like `2026-W33` and return a `YYYY-MM-DD` date string. Both throw an `Error` on a malformed input.

**Steps**

- [ ] Append this test block to the end of `packages/memory/src/rollups.test.ts`, inside the top-level scope (the file already imports from `./rollups.js`; extend that import statement to include `isoMondayOf` and `isoSundayOf`):

```ts
describe('isoMondayOf and isoSundayOf', () => {
  it('returns the Monday and Sunday of an ordinary mid-year week', () => {
    expect(isoMondayOf('2026-W33')).toBe('2026-08-10')
    expect(isoSundayOf('2026-W33')).toBe('2026-08-16')
    expect(isoMondayOf('2026-W32')).toBe('2026-08-03')
    expect(isoSundayOf('2026-W32')).toBe('2026-08-09')
  })

  it('handles weeks whose Monday falls in the previous calendar year', () => {
    // 2026-W01 starts on Monday 2025-12-29. A naive
    // "January 1st plus (week - 1) times seven days" calculation gets
    // this wrong by several days.
    expect(isoMondayOf('2026-W01')).toBe('2025-12-29')
    expect(isoSundayOf('2026-W01')).toBe('2026-01-04')
    expect(isoMondayOf('2025-W01')).toBe('2024-12-30')
    expect(isoSundayOf('2025-W01')).toBe('2025-01-05')
  })

  it('handles a 53-week year whose last week ends in the next calendar year', () => {
    // 2026 is a 53-week ISO year: 2026-W53 runs Monday 2026-12-28
    // through Sunday 2027-01-03.
    expect(isoMondayOf('2026-W53')).toBe('2026-12-28')
    expect(isoSundayOf('2026-W53')).toBe('2027-01-03')
  })

  it('round-trips against isoWeekOf for every day across four years', () => {
    const start = Date.UTC(2024, 0, 1)
    const end = Date.UTC(2027, 11, 31)
    for (let t = start; t <= end; t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10)
      const week = isoWeekOf(date)
      const monday = isoMondayOf(week)
      const sunday = isoSundayOf(week)
      expect(isoWeekOf(monday)).toBe(week)
      expect(isoWeekOf(sunday)).toBe(week)
      expect(monday <= date).toBe(true)
      expect(date <= sunday).toBe(true)
    }
  })

  it('rejects a malformed week identifier', () => {
    expect(() => isoMondayOf('2026-33')).toThrow(/expected a YYYY-Www week id/)
    expect(() => isoMondayOf('not-a-week')).toThrow(/expected a YYYY-Www week id/)
    expect(() => isoSundayOf('2026-W00')).toThrow(/week number out of range/)
  })
})
```

- [ ] Run `npx vitest run packages/memory/src/rollups.test.ts`. It must fail. The failure names `isoMondayOf`: either `SyntaxError: The requested module './rollups.js' does not provide an export named 'isoMondayOf'` or a TypeScript error about the missing export. No new test may pass at this point.

- [ ] Add this code to `packages/memory/src/rollups.ts`, directly below `isoWeekOf` (which ends at line 48):

```ts
const ISO_WEEK_PATTERN = /^(\d{4})-W(\d{2})$/

function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Inverse of isoWeekOf: the calendar date (YYYY-MM-DD) of the Monday that
 * starts the given ISO 8601 week identifier (YYYY-Www).
 *
 * The anchor is January 4th, which is always in ISO week 1 of its own
 * calendar year by definition. Walking back from January 4th to its Monday
 * gives week 1's Monday, and every later week is that plus seven days per
 * week. Anchoring on January 1st instead is the common mistake: January 1st
 * can belong to the last week of the previous ISO year, so it is off by up
 * to three days.
 *
 * Weeks are not validated against the number of weeks the given ISO year
 * actually has. Asking for a week that does not exist (2025-W53, in a year
 * with 52 weeks) returns the Monday seven days after the last real week, in
 * the next ISO year. Callers pass week ids that came out of isoWeekOf, so
 * that case does not arise in this codebase.
 */
export function isoMondayOf(week: string): string {
  const match = ISO_WEEK_PATTERN.exec(week)
  if (!match) {
    throw new Error(`isoMondayOf: expected a YYYY-Www week id, got "${week}"`)
  }
  const isoYear = Number(match[1])
  const weekNumber = Number(match[2])
  if (weekNumber < 1 || weekNumber > 53) {
    throw new Error(`isoMondayOf: week number out of range in "${week}"`)
  }
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4IsoDay = jan4.getUTCDay() || 7
  const week1Monday = Date.UTC(isoYear, 0, 4 - (jan4IsoDay - 1))
  return formatDateUTC(new Date(week1Monday + (weekNumber - 1) * 7 * 86400000))
}

/**
 * The calendar date (YYYY-MM-DD) of the Sunday that ends the given ISO 8601
 * week identifier: six days after its Monday.
 */
export function isoSundayOf(week: string): string {
  const monday = isoMondayOf(week)
  const parts = monday.split('-').map(Number)
  const year = parts[0]
  const month = parts[1]
  const day = parts[2]
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`isoSundayOf: could not read the Monday of "${week}"`)
  }
  return formatDateUTC(new Date(Date.UTC(year, month - 1, day + 6)))
}
```

- [ ] Run `npx vitest run packages/memory/src/rollups.test.ts`. Every test passes, including the five new ones. Expected tail: `Test Files  1 passed (1)`.

- [ ] Falsify: temporarily replace the body of `isoMondayOf` with `return formatDateUTC(new Date(Date.UTC(isoYear, 0, 1 + (weekNumber - 1) * 7)))`, rerun the file, and confirm the year-boundary test and the round-trip test both fail. Restore the real implementation and rerun to green.

- [ ] Run `pnpm build`, then `pnpm lint`. Both must exit 0.

- [ ] Commit: `git add -A && git commit -m "Add isoMondayOf and isoSundayOf, the inverse of isoWeekOf"`

---

## Task 2: `documentDateSpan`, the point-in-time vs living classifier

A pure function only. Nothing calls it yet; Task 4 wires it into the index.

**Files**

- Create: `packages/memory/src/dateSpan.ts`
- Create: `packages/memory/src/dateSpan.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces**

Consumes (already exist):

```ts
// packages/memory/src/sqlite.ts:12
export type DocKind =
  | 'constitution' | 'realm' | 'arc' | 'summary'
  | 'rollup_daily' | 'rollup_weekly' | 'person'

// packages/memory/src/documents.ts:16
export interface DocumentMeta { id: string; [key: string]: unknown }

// packages/memory/src/rollups.ts (Task 1)
export function isoMondayOf(week: string): string
export function isoSundayOf(week: string): string
```

Produces:

```ts
export interface DateSpan { start: string; end: string }
export function documentDateSpan(kind: DocKind, meta: DocumentMeta): DateSpan | null
```

Rules, exactly:

| Kind | Result | Source |
| --- | --- | --- |
| `summary` | `{ start: date, end: date }` | `meta.date` |
| `rollup_daily` | `{ start: date, end: date }` | `meta.date` |
| `rollup_weekly` | `{ start: monday, end: sunday }` | `meta.week` through `isoMondayOf` / `isoSundayOf` |
| `constitution`, `realm`, `arc`, `person` | `null` | living documents, no single date |

A dated kind whose frontmatter is missing or malformed returns `null` too: an unreadable date is not a date, and guessing one would be exactly the confidently-wrong filter the spec exists to remove.

**Do not add `'journal'` or `'journaling'` to `DocKind` or to this switch.** The journal spec owns those two values. This function covers the seven kinds that exist today. The test in Task 18 is what fails, loudly, when a new kind lands unwired.

**Steps**

- [ ] Create `packages/memory/src/dateSpan.test.ts` with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import { documentDateSpan } from './dateSpan.js'

describe('documentDateSpan', () => {
  it('gives a session summary and a daily rollup a single-day span', () => {
    expect(documentDateSpan('summary', { id: 'doc_1', date: '2026-08-12' })).toEqual({
      start: '2026-08-12',
      end: '2026-08-12',
    })
    expect(documentDateSpan('rollup_daily', { id: 'doc_2', date: '2026-05-01' })).toEqual({
      start: '2026-05-01',
      end: '2026-05-01',
    })
  })

  it('gives a weekly rollup the Monday-through-Sunday span of its week', () => {
    expect(documentDateSpan('rollup_weekly', { id: 'doc_3', week: '2026-W33' })).toEqual({
      start: '2026-08-10',
      end: '2026-08-16',
    })
    // A week whose Monday is in the previous calendar year.
    expect(documentDateSpan('rollup_weekly', { id: 'doc_4', week: '2026-W01' })).toEqual({
      start: '2025-12-29',
      end: '2026-01-04',
    })
  })

  it('returns null for every living document kind', () => {
    // An arc carries opened and updated in its frontmatter and neither one
    // is "when this content is about", so it gets no span at all.
    expect(
      documentDateSpan('arc', { id: 'doc_5', opened: '2026-01-04', updated: '2026-08-12' }),
    ).toBeNull()
    expect(documentDateSpan('realm', { id: 'doc_6', name: 'Fitness' })).toBeNull()
    expect(documentDateSpan('person', { id: 'doc_7', name: 'Priya' })).toBeNull()
    expect(documentDateSpan('constitution', { id: 'doc_8' })).toBeNull()
  })

  it('returns null rather than guessing when a dated kind has no usable date', () => {
    expect(documentDateSpan('rollup_daily', { id: 'doc_9' })).toBeNull()
    expect(documentDateSpan('summary', { id: 'doc_10', date: 'yesterday' })).toBeNull()
    expect(documentDateSpan('rollup_weekly', { id: 'doc_11', week: '2026-33' })).toBeNull()
  })

  it('never returns undefined for any kind that exists today', () => {
    const kinds = [
      'constitution',
      'realm',
      'arc',
      'summary',
      'rollup_daily',
      'rollup_weekly',
      'person',
    ] as const
    for (const kind of kinds) {
      expect(documentDateSpan(kind, { id: 'doc_x' })).not.toBeUndefined()
    }
  })
})
```

- [ ] Run `npx vitest run packages/memory/src/dateSpan.test.ts`. It must fail because `./dateSpan.js` does not exist. Expected: `Error: Failed to load url ./dateSpan.js` or `Cannot find module`.

- [ ] Create `packages/memory/src/dateSpan.ts` with exactly this content:

```ts
// Classifies a document as point-in-time or living, for date filtering in
// the search index.
//
// A point-in-time document is about one bounded stretch of the person's
// life: a session summary, a daily rollup, a weekly rollup. Its span is
// stored in the index and an after/before filter compares against it.
//
// A living document (the constitution, and realm, arc and person pages) is
// rewritten over time and has no single date. It carries opened and updated
// in its frontmatter, and neither answers "when is this content about": an
// arc opened in January and rewritten in August passes after: 2026-08-01
// under updated and fails it under opened, and both readings are defensible,
// which is proof that neither is correct. File mtime is worse still, since
// it records when reflection last rewrote the page. So living documents get
// null, are stored with null date columns, and are never excluded by a date
// filter. That is a stated, tested property of exactly four kinds, not an
// accident that swallows most of the corpus.

import type { DocumentMeta } from './documents.js'
import { isoMondayOf, isoSundayOf } from './rollups.js'
import type { DocKind } from './sqlite.js'

export interface DateSpan {
  start: string
  end: string
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ISO_WEEK_PATTERN = /^\d{4}-W\d{2}$/

export function documentDateSpan(kind: DocKind, meta: DocumentMeta): DateSpan | null {
  switch (kind) {
    case 'summary':
    case 'rollup_daily': {
      const date = meta.date
      if (typeof date !== 'string' || !ISO_DATE_PATTERN.test(date)) {
        return null
      }
      return { start: date, end: date }
    }
    case 'rollup_weekly': {
      const week = meta.week
      if (typeof week !== 'string' || !ISO_WEEK_PATTERN.test(week)) {
        return null
      }
      return { start: isoMondayOf(week), end: isoSundayOf(week) }
    }
    case 'constitution':
    case 'realm':
    case 'arc':
    case 'person':
      return null
  }
}
```

- [ ] Add `export * from './dateSpan.js'` to `packages/memory/src/index.ts`, in alphabetical position between the `documents.js` line and the `engine.js` line, so the block reads:

```ts
export * from './dateSpan.js'
export * from './documents.js'
export * from './engine.js'
```

(`dateSpan` sorts before `documents`.)

- [ ] Run `npx vitest run packages/memory/src/dateSpan.test.ts`. All five tests pass.

- [ ] Falsify: change the `rollup_weekly` case to `return { start: isoMondayOf(week), end: isoMondayOf(week) }`, rerun, and confirm the weekly span test fails on the `end` value. Restore and rerun to green.

- [ ] Run `pnpm build`, then `pnpm lint`. Both exit 0.

- [ ] Commit: `git add -A && git commit -m "Add documentDateSpan, classifying document kinds as dated or living"`

---

## Task 3: Index schema versioning, with auto-rebuild on open

This is the riskiest task in the plan. It is sequenced third, before anything reads the new columns, so it can be verified on its own.

There is no `PRAGMA user_version` anywhere in `sqlite.ts` today and `initSchema` uses `CREATE TABLE IF NOT EXISTS`, which will never add a column to an existing table. An `index.db` written by an earlier version would make every search throw `no such column: d.date_start` once Task 5 lands. This task introduces the versioning, adds the two columns to the created schema (still unused), drops and recreates the four derived document tables when the stored version is behind, and makes `MemoryEngine.open` rebuild the index and record a warning when that happened.

`nodes` and `edges` are deliberately not part of the migration: `replaceGraph` (`sqlite.ts:231`) already deletes and refills both wholesale on every `MemoryEngine.open`.

**Files**

- Modify: `packages/memory/src/sqlite.ts`
- Modify: `packages/memory/src/sqlite.test.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Consumes (already exist):

```ts
// packages/memory/src/sqlite.ts:72
static open(dbPath: string): MemoryIndex
// packages/memory/src/engine.ts:234
static async open(root: string, deps: EngineDeps, options?: MemoryEngineOpenOptions): Promise<MemoryEngine>
// packages/memory/src/engine.ts:1084
async reindexAll(): Promise<void>
// packages/memory/src/engine.ts:212
readonly warnings: string[]
```

Produces:

```ts
// packages/memory/src/sqlite.ts
export const INDEX_SCHEMA_VERSION = 2

export class MemoryIndex {
  // True when open() found a stored schema version older than
  // INDEX_SCHEMA_VERSION alongside existing derived tables, dropped them,
  // and recreated them empty. False on a fresh database and on an
  // already-current one.
  readonly schemaRebuilt: boolean
}
```

**Steps**

- [ ] Add this test to `packages/memory/src/sqlite.test.ts`, as a new `describe` block at the end of the top-level `describe('MemoryIndex', ...)`. The file already imports `MemoryIndex`; add `INDEX_SCHEMA_VERSION` to that import and add `import Database from 'better-sqlite3'` at the top of the file:

```ts
  describe('schema version', () => {
    it('marks a fresh database as current, not rebuilt', () => {
      expect(index.schemaRebuilt).toBe(false)
      const db = new Database(dbPath)
      expect(db.pragma('user_version', { simple: true })).toBe(INDEX_SCHEMA_VERSION)
      db.close()
    })

    it('drops and recreates the derived document tables when the stored version is behind', async () => {
      await index.upsertDocument(doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBeGreaterThan(0)
      index.close()

      const db = new Database(dbPath)
      db.pragma('user_version = 1')
      db.close()

      const reopened = MemoryIndex.open(dbPath)
      expect(reopened.schemaRebuilt).toBe(true)
      // Derived rows are gone, and the table is present and queryable
      // rather than missing: an empty result, not a throw.
      expect(reopened.searchText('work', 10)).toEqual([])
      reopened.close()

      // Opening again finds the version current and does not rebuild.
      const third = MemoryIndex.open(dbPath)
      expect(third.schemaRebuilt).toBe(false)
      third.close()

      index = MemoryIndex.open(dbPath)
    })

    it('creates the date span columns on the documents table', () => {
      const db = new Database(dbPath)
      const columns = (db.pragma('table_info(documents)') as { name: string }[]).map((c) => c.name)
      db.close()
      expect(columns).toContain('date_start')
      expect(columns).toContain('date_end')
    })
  })
```

- [ ] Run `npx vitest run packages/memory/src/sqlite.test.ts`. The three new tests fail: `schemaRebuilt` is undefined, `user_version` reads `0`, and `table_info(documents)` has no `date_start`.

- [ ] In `packages/memory/src/sqlite.ts`, replace the constructor and `initSchema` (lines 67 to 126) with:

```ts
  private constructor(db: Database.Database) {
    this.db = db
    this.schemaRebuilt = this.initSchema()
  }

  static open(dbPath: string): MemoryIndex {
    const db = new Database(dbPath)
    return new MemoryIndex(db)
  }

  close(): void {
    this.db.close()
  }

  // Reads PRAGMA user_version and brings the derived document tables up to
  // INDEX_SCHEMA_VERSION. Returns true only when there was an older index
  // to migrate, so a caller can rebuild it.
  //
  // Migration is drop-and-recreate, not ALTER TABLE. Everything in these
  // four tables is derived from the markdown files on disk and can be
  // rebuilt exactly, so carrying rows forward buys nothing and every future
  // schema change would need its own hand-written ALTER path. `nodes` and
  // `edges` are left alone: replaceGraph already rewrites both wholesale on
  // every engine open.
  //
  // A fresh database and a stale one both start at user_version 0, so the
  // presence of the `documents` table in sqlite_master is what tells them
  // apart. Without that check every brand-new memory folder would report a
  // migration that never happened.
  private initSchema(): boolean {
    const storedVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0)
    if (storedVersion >= INDEX_SCHEMA_VERSION) {
      this.createTables()
      return false
    }

    const hadDocuments =
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
        .get() !== undefined

    if (hadDocuments) {
      // chunks_fts first: it is an external-content FTS5 table over chunks,
      // so dropping it before its content table keeps the drop of its
      // shadow tables uncomplicated.
      this.db.exec(`
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS embeddings;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS documents;
      `)
    }

    this.createTables()
    this.db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`)
    return hadDocuments
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        mtime TEXT NOT NULL,
        date_start TEXT,
        date_end TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='id'
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id INTEGER PRIMARY KEY,
        vector BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        doc TEXT,
        ts TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        edge TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        confirmed INTEGER NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (edge, from_id, to_id)
      );
    `)
  }
```

- [ ] In the same file, add the exported constant just below the `MAX_CHUNK_CHARS` declaration at line 39:

```ts
// Bumped whenever the derived document tables change shape. On open, an
// index.db carrying a lower version has those tables dropped and recreated,
// and MemoryEngine.open rebuilds them from the memory folder.
export const INDEX_SCHEMA_VERSION = 2
```

- [ ] In the same file, add the field declaration inside the class, directly below `private readonly db: Database.Database` at line 65:

```ts
  readonly schemaRebuilt: boolean
```

- [ ] Run `npx vitest run packages/memory/src/sqlite.test.ts`. Every test passes.

- [ ] Add this test to `packages/memory/src/engine.test.ts`, at the end of the file, as its own top-level `describe`. The file already has `mkdtemp`, `rm`, `join`, `tmpdir`, `FakeChatProvider`, `FakeEmbeddingProvider` and `MemoryEngine` in scope at the top; add `import Database from 'better-sqlite3'` to the imports:

```ts
describe('index schema migration', () => {
  it('rebuilds the index from the folder instead of leaving it empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-migration-'))
    const paths = memoryPaths(dir)

    let engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'fitness.md'),
      meta: { id: 'doc_migration_realm', name: 'Fitness' },
      body: 'Kayaking on the lake every Sunday morning.\n',
    })
    await engine.reindexAll()
    const before = await engine.search('kayaking')
    expect(before.some((hit) => hit.docId === 'doc_migration_realm')).toBe(true)
    await engine.close()

    const db = new Database(paths.indexDb)
    db.pragma('user_version = 1')
    db.close()

    engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const after = await engine.search('kayaking')
    expect(after.some((hit) => hit.docId === 'doc_migration_realm')).toBe(true)
    expect(engine.warnings.some((w) => w.includes('search index schema'))).toBe(true)
    await engine.close()

    await rm(dir, { recursive: true, force: true })
  })
})
```

Note: this test uses `engine.search(...)` with its current `SearchHit[]` return type. Task 11 changes that shape and updates this call site along with every other.

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts -t "rebuilds the index from the folder"`. It fails: after the version reset the search returns no rows, so `expect(after.some(...)).toBe(true)` fails with `expected false to be true`.

- [ ] In `packages/memory/src/engine.ts`, inside `static async open`, insert this block between the `drainLegacyProposals()` call (which ends at line 265) and `await engine.refreshDocPaths()` at line 266:

```ts
    // After runMaintenance and drainLegacyProposals, not before: both of
    // those clear warnings as their own first step, so a warning pushed
    // earlier would be wiped before anyone could read it. Nothing in the
    // maintenance path searches the index (reflection reads graph state and
    // the folder; the rollup builders read the folder), so running it
    // against a freshly emptied index is safe, and running the rebuild
    // afterwards also picks up whatever maintenance just wrote.
    //
    // Rebuild rather than leave the index empty: a silently empty search
    // index is the exact failure this release exists to remove. The cost is
    // one embedding pass over the whole folder, once. Nothing is lost if it
    // is interrupted, since the version is only advanced when the tables are
    // recreated and the index is derived from the folder either way.
    if (index.schemaRebuilt) {
      await engine.reindexAll()
      engine.warnings.push(
        'The search index schema changed in this version, so index.db was rebuilt from your memory folder. ' +
          'This happens once, on the first launch after the upgrade, and it re-embeds every document in the folder. ' +
          'Nothing was lost: the index is derived from your files, and it is rebuilt again on the next launch if this one was interrupted.',
      )
    }
```

Note: `reindexAll()` already repopulates `docPaths` and `docIdByPath` (`engine.ts:1098-1099`), so the `refreshDocPaths()` call that follows is redundant in this one path. Leave both. `refreshDocPaths` is the only thing that runs in the ordinary, non-migrating case.

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts -t "rebuilds the index from the folder"`. It passes.

- [ ] Falsify: comment out the `await engine.reindexAll()` line inside the new `if` block, rerun, and confirm the test fails on the post-migration search assertion. Restore it.

- [ ] Run `pnpm test`. The whole suite passes. Then `pnpm build` and `pnpm lint`, both exit 0.

- [ ] Commit: `git add -A && git commit -m "Version the SQLite index schema and rebuild it when it is stale"`

---

## Task 4: Populate `date_start` and `date_end` at index time

The columns exist and are always NULL. This fills them. Nothing reads them yet.

**Files**

- Modify: `packages/memory/src/sqlite.ts`
- Modify: `packages/memory/src/sqlite.test.ts`

**Interfaces**

Consumes:

```ts
// packages/memory/src/dateSpan.ts (Task 2)
export function documentDateSpan(kind: DocKind, meta: DocumentMeta): DateSpan | null
// packages/memory/src/sqlite.ts:128
async upsertDocument(doc: Document, kind: DocKind, embed: EmbedFn): Promise<void>
```

Produces: no new exported symbol. `upsertDocument` now writes `date_start` and `date_end`.

**Steps**

- [ ] Add this test to `packages/memory/src/sqlite.test.ts`, inside the existing `describe('upsertDocument and searchText', ...)` block:

```ts
    it('stores a date span for dated kinds and nulls for living ones', async () => {
      await index.upsertDocument(
        doc({ meta: { id: 'doc_daily', date: '2026-08-12' } }),
        'rollup_daily',
        embedFn(),
      )
      await index.upsertDocument(
        doc({ meta: { id: 'doc_weekly', week: '2026-W33' } }),
        'rollup_weekly',
        embedFn(),
      )
      await index.upsertDocument(
        doc({ meta: { id: 'doc_arc', opened: '2026-01-04', updated: '2026-08-12' } }),
        'arc',
        embedFn(),
      )

      const db = new Database(dbPath)
      const rows = db
        .prepare('SELECT id, date_start, date_end FROM documents ORDER BY id')
        .all() as { id: string; date_start: string | null; date_end: string | null }[]
      db.close()

      expect(rows).toEqual([
        { id: 'doc_arc', date_start: null, date_end: null },
        { id: 'doc_daily', date_start: '2026-08-12', date_end: '2026-08-12' },
        { id: 'doc_weekly', date_start: '2026-08-10', date_end: '2026-08-16' },
      ])
    })
```

- [ ] Run `npx vitest run packages/memory/src/sqlite.test.ts -t "stores a date span"`. It fails: every `date_start` and `date_end` comes back `null`, so the daily and weekly rows do not match.

- [ ] In `packages/memory/src/sqlite.ts`, add the import beside the existing `import type { Document } from './documents.js'` at line 9:

```ts
import { documentDateSpan } from './dateSpan.js'
```

- [ ] In the same file, in `upsertDocument`, add the span lookup after the `mtime` line (line 132) and replace the `INSERT INTO documents` statement:

```ts
    const mtime = await fileMtime(doc.path)
    // Null for living documents (the constitution, and realm, arc and person
    // pages) by design, so an after/before filter never excludes them. See
    // dateSpan.ts for why no date is better than a wrong one here.
    const span = documentDateSpan(kind, doc.meta)
```

and

```ts
      this.db
        .prepare(
          `INSERT INTO documents (id, path, kind, mtime, date_start, date_end)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             kind = excluded.kind,
             mtime = excluded.mtime,
             date_start = excluded.date_start,
             date_end = excluded.date_end`,
        )
        .run(docId, doc.path, kind, mtime, span?.start ?? null, span?.end ?? null)
```

- [ ] Run `npx vitest run packages/memory/src/sqlite.test.ts`. Every test passes.

- [ ] Falsify: change `span?.start ?? null` to `null`, rerun, and confirm the new test fails on `doc_daily`. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Store a date span per indexed document"`

---

## Task 5: Push the date predicate into SQL and delete the path-date filter

`passesDateFilters` (`retrieval.ts:112-124`) reads a date out of the path with `dateFromPath` (`retrieval.ts:137-146`) and returns `true` for anything it cannot read, which is most of the corpus. It also runs after fusion, so a date-matching document ranked 25th overall never survives to be filtered. Both problems go away by moving the predicate into the two SQL queries.

**Files**

- Modify: `packages/memory/src/sqlite.ts`
- Modify: `packages/memory/src/retrieval.ts`
- Modify: `packages/memory/src/retrieval.test.ts`

**Interfaces**

Consumes:

```ts
// packages/memory/src/retrieval.ts:21
export interface SearchFilters { kinds?: DocKind[]; after?: string; before?: string }
```

Produces (changed signatures):

```ts
// packages/memory/src/sqlite.ts
searchText(query: string, limit: number, kinds?: DocKind[], after?: string, before?: string): SearchHit[]
async searchVector(queryVec: number[], limit: number, kinds?: DocKind[], after?: string, before?: string): Promise<SearchHit[]>
```

Both are additive: every existing two- and three-argument call site still compiles.

The predicate, in both queries, with each half omitted when the corresponding filter is absent:

```sql
AND (d.date_start IS NULL OR (d.date_end >= :after AND d.date_start <= :before))
```

Span overlap, not point comparison: a weekly rollup covering 2026-08-10 through 2026-08-16 must be returned for `after: "2026-08-14"`.

**Steps**

- [ ] In `packages/memory/src/retrieval.test.ts`, delete the whole existing test `it('filters by date encoded in the path when present, and passes hits through when it is not', ...)` (currently lines 169 to 232). It asserts the old path-reading behavior and is the expectation this task removes.

- [ ] In the same file, add these three tests in its place:

```ts
  it('excludes a dated document outside the range, and returns it when unfiltered', async () => {
    const query = 'quiet morning walk'

    await index.upsertDocument(
      doc({
        meta: { id: 'doc_may', date: '2026-05-01' },
        body: query,
        path: '/memory/rollups/daily/2026-05-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_august', date: '2026-08-01' },
        body: query,
        path: '/memory/rollups/daily/2026-08-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )

    // Unfiltered first. Without this assertion the filtered one below
    // would still pass if the filter were deleted and nothing had ranked.
    const unfiltered = await searchMemory(index, embeddings, MODEL, query)
    expect(unfiltered.map((h) => h.docId).sort()).toEqual(['doc_august', 'doc_may'])

    const filtered = await searchMemory(index, embeddings, MODEL, query, { after: '2026-07-01' })
    expect(filtered.map((h) => h.docId)).toEqual(['doc_august'])
  })

  it('never excludes a living document, whatever the date filter says', async () => {
    const query = 'quiet morning walk'

    await index.upsertDocument(
      doc({
        meta: { id: 'doc_may', date: '2026-05-01' },
        body: query,
        path: '/memory/rollups/daily/2026-05-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )
    // An arc page carries opened and updated, both well outside the range,
    // and still must not be excluded: it has no date span at all.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_arc', opened: '2026-01-04', updated: '2026-01-20' },
        body: query,
        path: '/memory/arcs/walking.md',
      }),
      'arc',
      embedFn(embeddings),
    )

    const hits = await searchMemory(index, embeddings, MODEL, query, { after: '2026-07-01' })
    expect(hits.map((h) => h.docId)).toEqual(['doc_arc'])
  })

  it('matches a weekly rollup on span overlap, not on its Monday alone', async () => {
    const query = 'quiet morning walk'

    // 2026-W33 runs Monday 2026-08-10 through Sunday 2026-08-16.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_week', week: '2026-W33' },
        body: query,
        path: '/memory/rollups/weekly/2026-W33.md',
      }),
      'rollup_weekly',
      embedFn(embeddings),
    )

    const midWeek = await searchMemory(index, embeddings, MODEL, query, { after: '2026-08-14' })
    expect(midWeek.map((h) => h.docId)).toEqual(['doc_week'])

    const beforeMidWeek = await searchMemory(index, embeddings, MODEL, query, {
      before: '2026-08-11',
    })
    expect(beforeMidWeek.map((h) => h.docId)).toEqual(['doc_week'])

    const afterTheWeek = await searchMemory(index, embeddings, MODEL, query, {
      after: '2026-08-17',
    })
    expect(afterTheWeek.map((h) => h.docId)).toEqual([])
  })
```

- [ ] Run `npx vitest run packages/memory/src/retrieval.test.ts`. The three new tests fail: the current post-fusion filter reads no date from any of these paths for the arc and the weekly, and reads the wrong thing for the rest, so `doc_may` still comes back in the first test and the weekly comes back for `after: '2026-08-17'` in the third.

- [ ] In `packages/memory/src/sqlite.ts`, replace `searchText` (lines 262 to 297) with:

```ts
  searchText(
    query: string,
    limit: number,
    kinds?: DocKind[],
    after?: string,
    before?: string,
  ): SearchHit[] {
    const ftsQuery = toFtsQuery(query)
    if (ftsQuery === null) {
      return []
    }
    // An explicit but empty kinds list matches nothing, same as the old
    // post-fusion `.includes` check on an empty array did. Short-circuit
    // rather than emit `IN ()`, which is invalid SQL.
    if (kinds && kinds.length === 0) {
      return []
    }
    // Values are always bound as parameters, never interpolated into the
    // SQL string; only the placeholder count (one '?' per kind) varies.
    const kindClause = kinds ? `AND d.kind IN (${kinds.map(() => '?').join(', ')})` : ''
    const dates = dateClause(after, before)
    const rows = this.db
      .prepare(
        `SELECT d.id as docId, d.path as path, d.kind as kind,
                snippet(chunks_fts, 0, '', '', '...', 12) as snippet,
                chunks_fts.rank as rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ? ${kindClause} ${dates.sql}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, ...(kinds ?? []), ...dates.params, limit) as (DocumentRow & {
      snippet: string
      rank: number
    })[]

    return rows.map((row) => ({
      docId: row.docId,
      path: row.path,
      kind: row.kind,
      snippet: row.snippet,
      score: -row.rank,
    }))
  }
```

- [ ] In the same file, replace `searchVector` (lines 299 to 330) with:

```ts
  async searchVector(
    queryVec: number[],
    limit: number,
    kinds?: DocKind[],
    after?: string,
    before?: string,
  ): Promise<SearchHit[]> {
    if (kinds && kinds.length === 0) {
      return []
    }
    const predicates: string[] = []
    const params: (string | DocKind)[] = []
    if (kinds) {
      predicates.push(`d.kind IN (${kinds.map(() => '?').join(', ')})`)
      params.push(...kinds)
    }
    const dates = dateClause(after, before)
    if (dates.sql.length > 0) {
      // dateClause returns its predicate already prefixed with AND, for the
      // searchText query where it is never first. Here it can be first, so
      // the prefix is stripped.
      predicates.push(dates.sql.replace(/^AND /, ''))
      params.push(...dates.params)
    }
    const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT e.vector as vector, d.id as docId, d.path as path, d.kind as kind, c.text as text
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.doc_id
         ${whereClause}`,
      )
      .all(...params) as {
      vector: Buffer
      docId: string
      path: string
      kind: DocKind
      text: string
    }[]

    const scored: SearchHit[] = rows.map((row) => ({
      docId: row.docId,
      path: row.path,
      kind: row.kind,
      snippet: makeSnippet(row.text),
      score: cosineSimilarity(queryVec, blobToVector(row.vector)),
    }))

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }
```

- [ ] In the same file, add this module-level helper next to `toFtsQuery` (after line 477):

```ts
// The date predicate shared by searchText and searchVector. Filtering is by
// span overlap, not point comparison: a hit passes when its span ends on or
// after `after` and starts on or before `before`. A weekly rollup covering
// Monday through Sunday is therefore returned for any day inside it, which a
// comparison against its Monday alone would get wrong.
//
// A document with a NULL span (the constitution, and realm, arc and person
// pages) always passes. Those are living documents with no single date; see
// dateSpan.ts.
function dateClause(after?: string, before?: string): { sql: string; params: string[] } {
  const halves: string[] = []
  const params: string[] = []
  if (after !== undefined) {
    halves.push('d.date_end >= ?')
    params.push(after)
  }
  if (before !== undefined) {
    halves.push('d.date_start <= ?')
    params.push(before)
  }
  if (halves.length === 0) {
    return { sql: '', params: [] }
  }
  return { sql: `AND (d.date_start IS NULL OR (${halves.join(' AND ')}))`, params }
}
```

- [ ] In `packages/memory/src/retrieval.ts`, replace the module comment (lines 1 to 16) with:

```ts
// Hybrid retrieval: merges FTS text search and cosine vector search with
// reciprocal rank fusion.
//
// Both the caller's kind filter and the caller's after/before date filter
// are applied inside the index, in the SQL WHERE clauses of searchText and
// searchVector, not here. That is deliberate and it is the same argument in
// both cases: this module only ever sees the top-20 candidate window from
// each search, so anything filtered out afterwards has already cost a
// candidate slot, and a narrow filter could come back empty while matching
// documents sat just outside the window.
//
// Date filtering compares against the span stored on each document row
// (date_start, date_end), written at index time by documentDateSpan. Session
// summaries, daily rollups and weekly rollups have a real span. Living
// documents (the constitution, and realm, arc and person pages) have none:
// they carry NULL and are never excluded by a date filter, because no single
// date on them means "when this content is about". See dateSpan.ts for the
// full reasoning.
```

- [ ] In the same file, replace the body of `searchMemory` (lines 39 to 50) with:

```ts
  const textHits = index.searchText(
    query,
    CANDIDATE_LIMIT,
    filters?.kinds,
    filters?.after,
    filters?.before,
  )
  const [queryVector] = await embeddings.embed(embeddingModel, [query])
  const vectorHits = queryVector
    ? await index.searchVector(
        queryVector,
        CANDIDATE_LIMIT,
        filters?.kinds,
        filters?.after,
        filters?.before,
      )
    : []

  const fused = fuseByReciprocalRank([textHits, vectorHits])
  return fused.slice(0, limit)
```

- [ ] In the same file, delete `passesDateFilters` (lines 112 to 124), the `DATE_AT_SEGMENT_START` constant, its comment block, and `dateFromPath` (lines 126 to 146). Nothing else references them; confirm with `grep -rn "dateFromPath\|passesDateFilters" packages`, which must print nothing.

- [ ] Run `npx vitest run packages/memory/src/retrieval.test.ts`. All tests pass, including the three new ones.

- [ ] Falsify: delete the `AND (d.date_start IS NULL OR (...))` clause from `dateClause` by making it always return `{ sql: '', params: [] }`, rerun, and confirm the first and third new tests fail on their filtered assertions while their unfiltered assertions still pass. Restore. Then separately drop the `d.date_start IS NULL OR` half, rerun, and confirm the living-document test fails. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Filter search by indexed date span inside SQL, not by path after fusion"`

---

## Task 6: Make the `after` and `before` descriptions true

The schema (`tools.ts:92-98`) promises date filtering with no caveat. After Task 5 the behavior is honest but narrow, and the description has to say so, including the practical instruction to combine dates with `kinds`.

The `kinds` description string at `tools.ts:88-90` already lists all seven kinds correctly and needs no edit today. Task 18 is what keeps it honest when a kind is added.

**Files**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Interfaces**

Consumes: `toolDefinitions(): ToolDefinition[]` (`packages/core/src/tools.ts:68`).

Produces: no signature change. The `after` and `before` description strings change.

**Steps**

- [ ] Add this test to `packages/core/src/tools.test.ts`, inside the existing `describe('toolDefinitions', ...)` block:

```ts
  it('says plainly which kinds the date filters apply to and which they never exclude', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    const properties = (
      searchMemory.parameters as {
        properties: { after: { description: string }; before: { description: string } }
      }
    ).properties

    for (const description of [properties.after.description, properties.before.description]) {
      expect(description).toContain('weekly rollup matches if any day of its week falls in range')
      expect(description).toContain('never excluded')
      expect(description).toContain('kinds')
    }
    expect(properties.after.description).toContain('on or after')
    expect(properties.before.description).toContain('on or before')
  })
```

- [ ] Run `npx vitest run packages/core/src/tools.test.ts -t "says plainly which kinds"`. It fails: the current descriptions are one sentence each and contain none of those substrings.

- [ ] In `packages/core/src/tools.ts`, replace the `after` and `before` property definitions (lines 92 to 99) with:

```ts
          after: {
            type: 'string',
            description:
              'Only include dated artifacts on or after this date, YYYY-MM-DD. Dated artifacts are session ' +
              'summaries, daily rollups, weekly rollups, and journal entries; a weekly rollup matches if any day ' +
              'of its week falls in range. Living documents that are rewritten over time (the constitution, and ' +
              'realm, arc and person pages) have no single date and are never excluded by these filters. To ' +
              'search only within a date range, combine this with kinds.',
          },
          before: {
            type: 'string',
            description:
              'Only include dated artifacts on or before this date, YYYY-MM-DD. Dated artifacts are session ' +
              'summaries, daily rollups, weekly rollups, and journal entries; a weekly rollup matches if any day ' +
              'of its week falls in range. Living documents that are rewritten over time (the constitution, and ' +
              'realm, arc and person pages) have no single date and are never excluded by these filters. To ' +
              'search only within a date range, combine this with kinds.',
          },
```

Both descriptions name journal entries because the journal spec's `'journal'` kind is dated by design; when that kind lands it is already described here, and Task 18's test is what proves it was wired rather than only described.

- [ ] Run `npx vitest run packages/core/src/tools.test.ts`. All tests pass.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Describe the search date filters as they actually behave"`

---

## Task 7: The listing envelope, and `listArcs` / `listRealms` that hand back a `docId`

`MemoryEngine.listArcs()` and `listRealms()` (`engine.ts:786-792`) return raw `GraphNode[]`. A `GraphNode` is `{ id, type, label, doc?, ts }` (`graph.ts:69-75`), so the model gets `doc`, a filesystem path it cannot open, and never the `docId` that `read_document` needs. `graphQuery` already passes its nodes through the private `withDocId` helper (`engine.ts:698-702`); these two never did.

`list_arcs`'s description also promises "its id, name, and status" and `GraphNode` has no status field at all. Arc status lives in the arc page's frontmatter, which `sessionContext` reads per arc (`engine.ts:534-543`) and `listArcs` does not.

**Files**

- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/tools.ts` (dispatch only, so the package keeps compiling)
- Modify: `packages/core/src/tools.test.ts`
- Modify: `packages/cli/src/e2e.test.ts`

**Interfaces**

Consumes:

```ts
// packages/memory/src/graph.ts:69
export interface GraphNode { id: string; type: NodeType; label: string; doc?: string; ts: string }
// packages/memory/src/documents.ts:40
export async function readDocument(path: string): Promise<Document>
// packages/memory/src/engine.ts:97
export interface PublicGraphNode { id: string; type: GraphNode['type']; label: string; docId?: string; assertedAt: string }
```

Produces:

```ts
export interface ListingEnvelope<Row> {
  total: number
  offset: number
  limit: number
  returned: number
  hasMore: boolean
  rows: Row[]
}

export type ArcStatus = 'active' | 'dormant' | 'closed'

export interface ArcRow {
  id: string
  type: 'arc'
  label: string
  assertedAt: string
  docId?: string
  status?: string
  lastTouched?: string
}

export interface RealmRow {
  id: string
  type: 'realm'
  label: string
  assertedAt: string
  docId?: string
}

export interface ListArcsOptions { status?: ArcStatus; offset?: number; limit?: number }
export interface ListRealmsOptions { offset?: number; limit?: number }

class MemoryEngine {
  async listArcs(options?: ListArcsOptions): Promise<ListingEnvelope<ArcRow>>
  listRealms(options?: ListRealmsOptions): ListingEnvelope<RealmRow>
}
```

`listArcs` becomes async because it reads each arc page's frontmatter. `listRealms` stays synchronous: it reads no documents.

Rules:

- The row is the `graphSnapshot` projection (`engine.ts:748-760`) plus `docId`. The raw `doc` filesystem path is dropped: the model cannot open a path, and a path in a tool result invites quoting it back to the user as though it meant something.
- Status and `lastTouched` come from the arc page's frontmatter (`status`, `updated`). If the page cannot be read, both fields are omitted rather than defaulted, because defaulting an unreadable arc to `active` is how a broken file becomes a wrong answer.
- Rows are ordered by node `ts` descending, tie broken by node id descending, so the order is total and stable across calls and across index rebuilds.
- `total` is the count after the status filter, so `hasMore` stays meaningful.
- `limit` defaults to 50 and is clamped to 200.

**Steps**

- [ ] Add this test to `packages/memory/src/engine.test.ts` as a new top-level `describe` at the end of the file:

```ts
describe('listArcs and listRealms', () => {
  it('returns docId, real status from frontmatter, and no filesystem path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-listings-'))
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    const activeArcPath = join(paths.arcsDir, 'marathon.md')
    await writeDocumentAtomic({
      path: activeArcPath,
      meta: {
        id: 'doc_arc_active',
        name: 'Marathon Training',
        status: 'active',
        updated: '2026-08-10',
      },
      body: 'Training for the fall marathon.\n',
    })
    const closedArcPath = join(paths.arcsDir, 'move.md')
    await writeDocumentAtomic({
      path: closedArcPath,
      meta: { id: 'doc_arc_closed', name: 'Moving House', status: 'closed', updated: '2026-03-02' },
      body: 'The move is done.\n',
    })
    const realmPath = join(paths.realmsDir, 'fitness.md')
    await writeDocumentAtomic({
      path: realmPath,
      meta: { id: 'doc_realm', name: 'Fitness' },
      body: 'Running, lifting, sleep.\n',
    })

    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_active',
        type: 'arc',
        label: 'Marathon Training',
        doc: activeArcPath,
      },
      {
        ts: '2026-07-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_closed',
        type: 'arc',
        label: 'Moving House',
        doc: closedArcPath,
      },
      {
        ts: '2026-06-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_no_page',
        type: 'arc',
        label: 'Unpaged Arc',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        doc: realmPath,
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const all = await engine.listArcs()
    expect(all.total).toBe(3)
    expect(all.offset).toBe(0)
    expect(all.limit).toBe(50)
    expect(all.returned).toBe(3)
    expect(all.hasMore).toBe(false)
    expect(all.rows.map((row) => row.id)).toEqual(['arc_active', 'arc_closed', 'arc_no_page'])

    const active = all.rows[0]
    expect(active).toEqual({
      id: 'arc_active',
      type: 'arc',
      label: 'Marathon Training',
      assertedAt: '2026-08-01T00:00:00.000Z',
      docId: 'doc_arc_active',
      status: 'active',
      lastTouched: '2026-08-10',
    })
    // The filesystem path is deliberately not part of the row.
    expect(Object.keys(active ?? {})).not.toContain('doc')

    // An arc with no page has no status to read, and status is absent
    // rather than defaulted to active.
    expect(all.rows[2]).toEqual({
      id: 'arc_no_page',
      type: 'arc',
      label: 'Unpaged Arc',
      assertedAt: '2026-06-01T00:00:00.000Z',
    })

    // The docId chains into read_document's engine method.
    const arcDoc = await engine.readDocumentById('doc_arc_active')
    expect(arcDoc?.body).toContain('Training for the fall marathon.')

    const onlyActive = await engine.listArcs({ status: 'active' })
    expect(onlyActive.total).toBe(1)
    expect(onlyActive.rows.map((row) => row.id)).toEqual(['arc_active'])

    const onlyClosed = await engine.listArcs({ status: 'closed' })
    expect(onlyClosed.rows.map((row) => row.id)).toEqual(['arc_closed'])

    const realms = engine.listRealms()
    expect(realms.total).toBe(1)
    expect(realms.rows).toEqual([
      {
        id: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        assertedAt: '2026-08-01T00:00:00.000Z',
        docId: 'doc_realm',
      },
    ])

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pages arcs with a stable total order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-listings-page-'))
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    for (let i = 0; i < 5; i++) {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: `arc_${i}`,
          type: 'arc',
          label: `Arc ${i}`,
        },
      ])
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const first = await engine.listArcs({ limit: 2 })
    expect(first.returned).toBe(2)
    expect(first.hasMore).toBe(true)
    const second = await engine.listArcs({ offset: 2, limit: 2 })
    const third = await engine.listArcs({ offset: 4, limit: 2 })
    expect(third.hasMore).toBe(false)

    const paged = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id)
    const unpaged = (await engine.listArcs()).rows.map((row) => row.id)
    expect(paged).toEqual(unpaged)
    expect(new Set(paged).size).toBe(5)

    // limit is clamped rather than trusted.
    const clamped = await engine.listArcs({ limit: 5000 })
    expect(clamped.limit).toBe(200)

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})
```

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts -t "returns docId, real status"`. It fails to compile or fails at runtime: `listArcs()` currently returns `GraphNode[]`, which has no `.total` and is not a promise.

- [ ] In `packages/memory/src/engine.ts`, add these exported types just below the `PublicGraphEdge` interface (which ends at line 114):

```ts
// One shape for every listing tool, so no listing in this system can ever
// silently truncate. `total` is always the true count of matching rows, so
// the model can tell how much it has not seen.
export interface ListingEnvelope<Row> {
  total: number
  offset: number
  limit: number
  returned: number
  hasMore: boolean
  rows: Row[]
}

export type ArcStatus = 'active' | 'dormant' | 'closed'

// The graphSnapshot projection plus docId, plus the two fields that only
// exist in the arc page's frontmatter. The raw `doc` filesystem path is
// deliberately absent: the model cannot open a path, and a path in a tool
// result invites quoting it back to the user as though it were meaningful.
export interface ArcRow {
  id: string
  type: 'arc'
  label: string
  assertedAt: string
  docId?: string
  status?: string
  lastTouched?: string
}

export interface RealmRow {
  id: string
  type: 'realm'
  label: string
  assertedAt: string
  docId?: string
}

export interface ListArcsOptions {
  status?: ArcStatus
  offset?: number
  limit?: number
}

export interface ListRealmsOptions {
  offset?: number
  limit?: number
}
```

- [ ] In the same file, add these module-level helpers next to `byTsDescending` (line 1696):

```ts
const LISTING_DEFAULT_LIMIT = 50
const LISTING_MAX_LIMIT = 200

// Slices one page out of an already-ordered row list and reports the true
// total alongside it. offset and limit come from the model, so both are
// clamped rather than trusted: a negative or non-numeric offset reads as 0,
// and a missing or oversized limit reads as the default or the maximum.
function pageRows<Row>(rows: Row[], offset?: number, limit?: number): ListingEnvelope<Row> {
  const safeOffset =
    offset !== undefined && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  const requested =
    limit !== undefined && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : LISTING_DEFAULT_LIMIT
  const safeLimit = Math.min(requested, LISTING_MAX_LIMIT)
  const page = rows.slice(safeOffset, safeOffset + safeLimit)
  return {
    total: rows.length,
    offset: safeOffset,
    limit: safeLimit,
    returned: page.length,
    hasMore: safeOffset + page.length < rows.length,
    rows: page,
  }
}

// A total order for listing tools: most recently asserted first, ties broken
// by node id descending. capPeople's paged-first rule is deliberately not
// reused here. That rule decides who survives truncation in a fixed-size
// prompt list; a paging tool truncates nothing, so what it needs instead is
// an order that is identical across calls and across index rebuilds, which
// is what the id tiebreak provides.
function compareNodesForListing(a: GraphNode, b: GraphNode): number {
  if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}
```

- [ ] In the same file, replace `listArcs` and `listRealms` (lines 786 to 792) with:

```ts
  // Async because arc status and lastTouched live in the arc page's
  // frontmatter, not on the graph node, and the tool has been promising a
  // status field it never returned. Arc counts are in the dozens, so a
  // bounded set of document reads per call is acceptable.
  async listArcs(options: ListArcsOptions = {}): Promise<ListingEnvelope<ArcRow>> {
    const nodes = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'arc')
      .sort(compareNodesForListing)

    const rows: ArcRow[] = []
    for (const node of nodes) {
      const row: ArcRow = {
        id: node.id,
        type: 'arc',
        label: node.label,
        assertedAt: node.ts,
      }
      const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
      if (docId) row.docId = docId
      if (node.doc) {
        try {
          const doc = await readDocument(node.doc)
          if (typeof doc.meta.status === 'string') row.status = doc.meta.status
          if (typeof doc.meta.updated === 'string') row.lastTouched = doc.meta.updated
        } catch {
          // The page does not read cleanly. Omit status and lastTouched
          // rather than defaulting them: defaulting an unreadable arc to
          // active is how a broken file becomes a wrong answer.
        }
      }
      if (options.status !== undefined && row.status !== options.status) continue
      rows.push(row)
    }

    return pageRows(rows, options.offset, options.limit)
  }

  listRealms(options: ListRealmsOptions = {}): ListingEnvelope<RealmRow> {
    const rows = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'realm')
      .sort(compareNodesForListing)
      .map((node) => {
        const row: RealmRow = {
          id: node.id,
          type: 'realm',
          label: node.label,
          assertedAt: node.ts,
        }
        const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
        if (docId) row.docId = docId
        return row
      })
    return pageRows(rows, options.offset, options.limit)
  }
```

- [ ] Update the call sites that consume the old shape, so the workspace compiles:

  - `packages/core/src/tools.ts:357`: `return JSON.stringify(engine.listArcs())` becomes `return JSON.stringify(await engine.listArcs())`.
  - `packages/memory/src/engine.test.ts:322`: `const newArc = engine.listArcs().find((n) => n.label === 'presentation prep')` becomes `const newArc = (await engine.listArcs()).rows.find((n) => n.label === 'presentation prep')`. The two lines below it read `newArc.doc`; replace `if (!newArc?.doc) throw new Error('expected the new arc to have a doc pointer')` and `expect(await readDocument(newArc.doc))` with `if (!newArc?.docId) throw new Error('expected the new arc to have a docId')` and `expect(await engine.readDocumentById(newArc.docId))`.
  - `packages/memory/src/engine.test.ts:333-334`: becomes `expect((await engine.listArcs()).total).toBe(2)` and `expect(engine.listRealms().total).toBe(1)`.
  - `packages/memory/src/engine.test.ts:685-686`: becomes `expect((await engine.listArcs()).rows.some((n) => n.id === arcNode.id)).toBe(true)` and `expect(engine.listRealms().rows.some((n) => n.id === realmNode.id)).toBe(true)`.
  - `packages/cli/src/e2e.test.ts:144`: `const arcs = engine.listArcs()` becomes `const arcs = (await engine.listArcs()).rows`.
  - `packages/cli/src/e2e.test.ts:151-152`: `engine.listRealms().find(...)` becomes `engine.listRealms().rows.find(...)` on both lines.
  - `packages/core/src/tools.test.ts:415-421`: the two `JSON.parse` casts become envelope-aware:

```ts
    const arcsResult = await dispatchTool(engine, sessionId, call('list_arcs', {}))
    const arcs = JSON.parse(arcsResult) as { rows: { id: string; label: string }[] }
    expect(arcs.rows).toEqual([expect.objectContaining({ id: 'arc_y', label: 'Fitness' })])

    const realmsResult = await dispatchTool(engine, sessionId, call('list_realms', {}))
    const realms = JSON.parse(realmsResult) as { rows: { id: string; label: string }[] }
    expect(realms.rows).toEqual([expect.objectContaining({ id: 'realm_y', label: 'Health' })])
```

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts`. Everything passes, including both new tests.

- [ ] Falsify: make `listArcs` return the raw nodes by deleting the frontmatter read block, rerun the first new test, and confirm it fails on both `status` and `lastTouched`. Restore. Then delete the `if (docId) row.docId = docId` line, rerun, and confirm the `docId` assertion and the `readDocumentById` chain both fail. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Return paged rows with docId and real status from listArcs and listRealms"`

---

## Task 8: `list_arcs` and `list_realms` gain arguments and honest descriptions

The engine methods take options; the tools still take none, and `list_arcs`'s description still promises a status it only now actually returns.

**Files**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Interfaces**

Consumes (from Task 7):

```ts
export interface ListArcsOptions { status?: ArcStatus; offset?: number; limit?: number }
export interface ListRealmsOptions { offset?: number; limit?: number }
class MemoryEngine {
  async listArcs(options?: ListArcsOptions): Promise<ListingEnvelope<ArcRow>>
  listRealms(options?: ListRealmsOptions): ListingEnvelope<RealmRow>
}
```

Produces: no new exported symbol. `list_arcs` accepts `status`, `offset`, `limit`; `list_realms` accepts `offset`, `limit`.

**Steps**

- [ ] Add this test to `packages/core/src/tools.test.ts`, at the end of the file:

```ts
it('list_arcs filters by status and pages, and its description matches what it returns', async () => {
  const paths = memoryPaths(dir)
  await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

  const openPath = join(paths.arcsDir, 'open.md')
  await writeDocumentAtomic({
    path: openPath,
    meta: { id: 'doc_open_arc', name: 'Open Arc', status: 'active', updated: '2026-08-10' },
    body: 'Still going.\n',
  })
  const donePath = join(paths.arcsDir, 'done.md')
  await writeDocumentAtomic({
    path: donePath,
    meta: { id: 'doc_done_arc', name: 'Done Arc', status: 'closed', updated: '2026-02-02' },
    body: 'Finished.\n',
  })
  await appendGraph(paths, [
    {
      ts: '2026-08-01T00:00:00.000Z',
      op: 'assert',
      node: 'arc_open',
      type: 'arc',
      label: 'Open Arc',
      doc: openPath,
    },
    {
      ts: '2026-02-01T00:00:00.000Z',
      op: 'assert',
      node: 'arc_done',
      type: 'arc',
      label: 'Done Arc',
      doc: donePath,
    },
  ])

  const engine = await MemoryEngine.open(dir, fakeDeps())
  const sessionId = await engine.startSession()

  const closedResult = await dispatchTool(engine, sessionId, call('list_arcs', { status: 'closed' }))
  const closed = JSON.parse(closedResult) as {
    total: number
    rows: { id: string; status: string; docId: string }[]
  }
  expect(closed.total).toBe(1)
  expect(closed.rows[0]).toMatchObject({ id: 'arc_done', status: 'closed', docId: 'doc_done_arc' })

  const pagedResult = await dispatchTool(engine, sessionId, call('list_arcs', { limit: 1 }))
  const paged = JSON.parse(pagedResult) as { total: number; returned: number; hasMore: boolean }
  expect(paged).toMatchObject({ total: 2, returned: 1, hasMore: true })

  const badStatus = await dispatchTool(engine, sessionId, call('list_arcs', { status: 'sideways' }))
  expect(JSON.parse(badStatus).error).toMatch(/list_arcs/)

  const realmsPaged = await dispatchTool(engine, sessionId, call('list_realms', { limit: 1 }))
  expect(JSON.parse(realmsPaged)).toMatchObject({ offset: 0, limit: 1 })

  const defs = toolDefinitions()
  const listArcs = defs.find((d) => d.name === 'list_arcs')
  if (!listArcs) throw new Error('expected a list_arcs tool definition')
  expect(listArcs.description).toContain('docId')
  expect(listArcs.description).toContain('dormant')
  const listArcsProps = (listArcs.parameters as { properties: Record<string, unknown> }).properties
  expect(Object.keys(listArcsProps).sort()).toEqual(['limit', 'offset', 'status'])

  await engine.close()
})
```

- [ ] Run `npx vitest run packages/core/src/tools.test.ts -t "list_arcs filters by status"`. It fails: `noArgs` rejects `{ status: 'closed' }`, so the first dispatch returns an error object with no `total`.

- [ ] In `packages/core/src/tools.ts`, add these schemas next to `noArgs` (line 54):

```ts
const listArcsArgs = z.strictObject({
  status: z.enum(['active', 'dormant', 'closed']).optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})

const listRealmsArgs = z.strictObject({
  offset: z.number().optional(),
  limit: z.number().optional(),
})
```

- [ ] In the same file, replace the `list_arcs` and `list_realms` tool definitions (lines 196 to 217) with:

```ts
    {
      name: 'list_arcs',
      description:
        'List the arcs (ongoing storylines) tracked in memory, with each arc id, name, status, when it was last ' +
        'touched, and the docId of its page when it has one. Pass that docId to read_document for the full ' +
        'narrative. Status comes from the arc page itself and is absent when the arc has no page or its page ' +
        'cannot be read. The system prompt preloads active arcs only, so this is the only way to reach a dormant ' +
        'or closed arc. Cheap orientation: use it to see what is open before deciding whether to search or read ' +
        'further. Results come back as a page: total is the true count, and hasMore says whether more remain.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'dormant', 'closed'],
            description: 'Return only arcs with this status. Omit to get arcs of every status.',
          },
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_realms',
      description:
        'List the realms (life domains) tracked in memory, with each realm id, name, and the docId of its page ' +
        'when it has one. Pass that docId to read_document for the full text. Cheap orientation, like list_arcs, ' +
        'for getting your bearings before a deeper lookup. Results come back as a page: total is the true count, ' +
        'and hasMore says whether more remain.',
      parameters: {
        type: 'object',
        properties: {
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
```

- [ ] In the same file, replace `dispatchListArcs` and `dispatchListRealms` (lines 354 to 364) with:

```ts
async function dispatchListArcs(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listArcsArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_arcs', parsed.error))

  // Rebuilt key by key rather than spread: exactOptionalPropertyTypes
  // distinguishes an absent key from a key present and undefined, and zod's
  // .optional() types as `T | undefined`.
  const options: ListArcsOptions = {}
  if (parsed.data.status !== undefined) options.status = parsed.data.status
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(await engine.listArcs(options))
}

async function dispatchListRealms(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listRealmsArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_realms', parsed.error))

  const options: ListRealmsOptions = {}
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(engine.listRealms(options))
}
```

- [ ] In the same file, extend the type-only import on line 13 to:

```ts
import type {
  DocKind,
  GraphQuery,
  ListArcsOptions,
  ListRealmsOptions,
  MemoryEngine,
} from '@openreverie/memory'
```

- [ ] Run `npx vitest run packages/core/src/tools.test.ts`. All tests pass. The existing test at line 171 that sends `list_arcs` with an empty argument string still passes, because `parseArguments` turns `''` into `{}` and `listArcsArgs` accepts an empty object.

- [ ] Falsify: change `listArcsArgs` back to `noArgs` in `dispatchListArcs`, rerun, and confirm the status and paging assertions fail. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Give list_arcs a status filter and paging, and both listings true descriptions"`

---

## Task 9: `listPeople` and `listEntities` on the engine

`capPeople` (`engine.ts:1711-1719`) keeps 40 people and `capEntities` (`engine.ts:1724-1727`) keeps 30 entities, and the prompt tells the model that older ones exist. Nothing lets it reach them. Entities never get a page in this release, so they are not in the document index either: there is no way at all to find the 41st person or the 31st entity today.

**Files**

- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Consumes: `ListingEnvelope`, `pageRows`, `compareNodesForListing` (Task 7).

Produces:

```ts
export interface PersonRow {
  id: string
  name: string
  hasPage: boolean
  docId?: string
  firstSeen: string
}

export interface EntityRow {
  id: string
  name: string
  firstSeen: string
}

export interface ListPeopleOptions {
  nameContains?: string
  hasPage?: boolean
  offset?: number
  limit?: number
}

export interface ListEntitiesOptions {
  nameContains?: string
  offset?: number
  limit?: number
}

class MemoryEngine {
  listPeople(options?: ListPeopleOptions): ListingEnvelope<PersonRow>
  listEntities(options?: ListEntitiesOptions): ListingEnvelope<EntityRow>
}
```

`firstSeen` is the node's `ts`. `EntityRow` deliberately carries no `hasPage` and no `docId`: entities have no pages in this release, and emitting `hasPage: false` on every row would imply a page might exist. If entity pages ever arrive, the shape gains the fields then.

Ordering is `compareNodesForListing` (node `ts` descending, id descending tiebreak), the same total order the arc and realm listings use, and `capPeople`'s paged-first rule is deliberately not inherited: that rule decides who survives truncation in a fixed-size prompt list, and a paging tool truncates nothing. `hasPage` is exposed as a filter so a caller that wants the paged-first view can ask for it directly.

`total` is the count after `nameContains` and `hasPage` filtering, so `hasMore` stays meaningful.

**Steps**

- [ ] Add this test to `packages/memory/src/engine.test.ts` as a new top-level `describe` at the end of the file:

```ts
describe('listPeople and listEntities', () => {
  async function seedPeople(dir: string, count: number, pagedCount: number): Promise<void> {
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())
    for (let i = 0; i < count; i++) {
      const hasPage = i < pagedCount
      let personPath: string | undefined
      if (hasPage) {
        personPath = join(paths.peopleDir, `person-${i}.md`)
        await writeDocumentAtomic({
          path: personPath,
          meta: { id: `doc_person_${i}`, name: `Person ${i}`, node: `person_${i}` },
          body: `Person ${i} has a page.\n`,
        })
      }
      await appendGraph(paths, [
        {
          ts: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
          op: 'assert',
          node: `person_${i}`,
          type: 'person',
          label: `Person ${i}`,
          ...(personPath ? { doc: personPath } : {}),
        },
      ])
    }
  }

  it('reaches a person past the prompt cap, with a docId only when a page exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-people-'))
    await seedPeople(dir, 45, 5)

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const all = engine.listPeople({ limit: 200 })
    expect(all.total).toBe(45)
    expect(all.returned).toBe(45)

    const past = engine.listPeople({ offset: 40, limit: 50 })
    expect(past.offset).toBe(40)
    expect(past.returned).toBe(5)
    expect(past.hasMore).toBe(false)

    const paged = engine.listPeople({ hasPage: true, limit: 200 })
    expect(paged.total).toBe(5)
    for (const row of paged.rows) {
      expect(row.hasPage).toBe(true)
      expect(typeof row.docId).toBe('string')
    }

    const unpaged = engine.listPeople({ hasPage: false, limit: 200 })
    expect(unpaged.total).toBe(40)
    for (const row of unpaged.rows) {
      expect(row.hasPage).toBe(false)
      expect(row.docId).toBeUndefined()
    }

    const byName = engine.listPeople({ nameContains: 'person 41' })
    expect(byName.total).toBe(1)
    expect(byName.rows[0]).toMatchObject({ id: 'person_41', name: 'Person 41', hasPage: false })
    expect(typeof byName.rows[0]?.firstSeen).toBe('string')

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pages through every person exactly once, in an order stable across rebuilds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-people-paging-'))
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    // 45 people, of which five share an identical ts. Without the id
    // tiebreak the order of that tied group depends on graph.jsonl's line
    // order, which changes when the log is rewritten.
    for (let i = 0; i < 45; i++) {
      const ts = i < 5 ? '2026-08-01T00:00:00.000Z' : `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`
      await appendGraph(paths, [
        { ts, op: 'assert', node: `person_${i}`, type: 'person', label: `Person ${i}` },
      ])
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const collected: string[] = []
    for (let offset = 0; offset < 45; offset += 7) {
      collected.push(...engine.listPeople({ offset, limit: 7 }).rows.map((row) => row.id))
    }
    const unpaged = engine.listPeople({ limit: 200 }).rows.map((row) => row.id)
    expect(collected).toEqual(unpaged)
    expect(new Set(collected).size).toBe(45)
    await engine.close()

    // Rewrite graph.jsonl with the tied group in the opposite order, then
    // reopen. The tiebreak is what keeps the total order identical, so
    // paging still covers all 45 exactly once with no duplicate and no gap.
    const original = (await readFile(paths.graphLog, 'utf8')).split('\n').filter(Boolean)
    const tied = original.slice(0, 5).reverse()
    const rest = original.slice(5)
    await writeFile(paths.graphLog, `${[...tied, ...rest].join('\n')}\n`, 'utf8')

    const reopened = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const afterRebuild: string[] = []
    for (let offset = 0; offset < 45; offset += 7) {
      afterRebuild.push(...reopened.listPeople({ offset, limit: 7 }).rows.map((row) => row.id))
    }
    expect(afterRebuild).toEqual(unpaged)
    expect(new Set(afterRebuild).size).toBe(45)
    await reopened.close()

    await rm(dir, { recursive: true, force: true })
  })

  it('lists entities with no page fields at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-entities-'))
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    for (let i = 0; i < 3; i++) {
      await appendGraph(paths, [
        {
          ts: `2026-08-0${i + 1}T00:00:00.000Z`,
          op: 'assert',
          node: `entity_${i}`,
          type: 'entity',
          label: `Entity ${i}`,
        },
      ])
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const listed = engine.listEntities()
    expect(listed.total).toBe(3)
    expect(listed.rows[0]).toEqual({
      id: 'entity_2',
      name: 'Entity 2',
      firstSeen: '2026-08-03T00:00:00.000Z',
    })
    expect(Object.keys(listed.rows[0] ?? {}).sort()).toEqual(['firstSeen', 'id', 'name'])

    const filtered = engine.listEntities({ nameContains: 'entity 1' })
    expect(filtered.total).toBe(1)
    expect(filtered.rows[0]?.id).toBe('entity_1')

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})
```

The second test needs `readFile` and `writeFile`; add both to the existing `node:fs/promises` import at the top of `engine.test.ts` if they are not already there.

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts -t "reaches a person past the prompt cap"`. It fails: `engine.listPeople is not a function`.

- [ ] In `packages/memory/src/engine.ts`, add these types below `ListRealmsOptions` (added in Task 7):

```ts
export interface PersonRow {
  id: string
  name: string
  hasPage: boolean
  docId?: string
  firstSeen: string
}

// No hasPage and no docId. Entities never get a page in this release, and
// emitting hasPage: false on every row would be noise implying a page might
// exist. If entity pages ever arrive, the shape gains the fields then.
export interface EntityRow {
  id: string
  name: string
  firstSeen: string
}

export interface ListPeopleOptions {
  nameContains?: string
  hasPage?: boolean
  offset?: number
  limit?: number
}

export interface ListEntitiesOptions {
  nameContains?: string
  offset?: number
  limit?: number
}
```

- [ ] In the same file, add these two methods directly below `listRealms`:

```ts
  // The escape hatch for everyone past PEOPLE_CAP. A person with no page has
  // no document, so no chunk, no FTS row and no embedding: search_memory's
  // document lane cannot find them under any query, and before this method
  // and the node lane existed there was no way to reach them at all.
  listPeople(options: ListPeopleOptions = {}): ListingEnvelope<PersonRow> {
    const needle = options.nameContains?.toLowerCase()
    const rows = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'person')
      .filter((node) => (needle === undefined ? true : node.label.toLowerCase().includes(needle)))
      .filter((node) =>
        options.hasPage === undefined ? true : (node.doc !== undefined) === options.hasPage,
      )
      .sort(compareNodesForListing)
      .map((node) => {
        const row: PersonRow = {
          id: node.id,
          name: node.label,
          hasPage: node.doc !== undefined,
          firstSeen: node.ts,
        }
        const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
        if (docId) row.docId = docId
        return row
      })
    return pageRows(rows, options.offset, options.limit)
  }

  listEntities(options: ListEntitiesOptions = {}): ListingEnvelope<EntityRow> {
    const needle = options.nameContains?.toLowerCase()
    const rows = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'entity')
      .filter((node) => (needle === undefined ? true : node.label.toLowerCase().includes(needle)))
      .sort(compareNodesForListing)
      .map((node) => ({ id: node.id, name: node.label, firstSeen: node.ts }))
    return pageRows(rows, options.offset, options.limit)
  }
```

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts`. Everything passes.

- [ ] Falsify: remove the `a.id < b.id ? 1 : a.id > b.id ? -1 : 0` tiebreak from `compareNodesForListing` and return `0` for a tie instead, then rerun the paging test. It fails after the graph log rewrite, because the tied group's order follows the file and the two paged runs disagree. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Add listPeople and listEntities so capped nodes stay reachable"`

---

## Task 10: `list_people` and `list_entities` tools

**Files**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Interfaces**

Consumes (Task 9): `listPeople`, `listEntities`, `ListPeopleOptions`, `ListEntitiesOptions`.

Produces: two entries in `toolDefinitions()` and two dispatch branches. The tool list grows from eight names to ten.

**Steps**

- [ ] In `packages/core/src/tools.test.ts`, update the existing test at line 66 that asserts the tool list. Replace its title and expected array with:

```ts
  it('lists exactly the ten memory and style tools with non-empty descriptions and a JSON schema', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(
      [
        'graph_query',
        'list_arcs',
        'list_entities',
        'list_people',
        'list_realms',
        'read_document',
        'read_transcript',
        'remember',
        'search_memory',
        'update_style',
      ].sort(),
    )
```

- [ ] Add this test to the end of `packages/core/src/tools.test.ts`:

```ts
it('list_people and list_entities page through nodes the prompt could not show', async () => {
  const paths = memoryPaths(dir)
  await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

  for (let i = 0; i < 3; i++) {
    await appendGraph(paths, [
      {
        ts: `2026-08-0${i + 1}T00:00:00.000Z`,
        op: 'assert',
        node: `person_${i}`,
        type: 'person',
        label: `Person ${i}`,
      },
      {
        ts: `2026-08-0${i + 1}T00:00:00.000Z`,
        op: 'assert',
        node: `entity_${i}`,
        type: 'entity',
        label: `Entity ${i}`,
      },
    ])
  }

  const engine = await MemoryEngine.open(dir, fakeDeps())
  const sessionId = await engine.startSession()

  const peopleResult = await dispatchTool(
    engine,
    sessionId,
    call('list_people', { nameContains: 'person 1' }),
  )
  const people = JSON.parse(peopleResult) as {
    total: number
    rows: { id: string; name: string; hasPage: boolean }[]
  }
  expect(people.total).toBe(1)
  expect(people.rows[0]).toMatchObject({ id: 'person_1', name: 'Person 1', hasPage: false })

  const entitiesResult = await dispatchTool(engine, sessionId, call('list_entities', { limit: 2 }))
  const entities = JSON.parse(entitiesResult) as { total: number; returned: number; hasMore: boolean }
  expect(entities).toMatchObject({ total: 3, returned: 2, hasMore: true })

  const badArg = await dispatchTool(engine, sessionId, call('list_people', { sortBy: 'name' }))
  expect(JSON.parse(badArg).error).toMatch(/list_people/)

  await engine.close()
})
```

- [ ] Run `npx vitest run packages/core/src/tools.test.ts`. Both the updated tool-list test and the new test fail: there are eight tools, and `list_people` dispatches to the unknown-tool branch.

- [ ] In `packages/core/src/tools.ts`, add these schemas next to `listRealmsArgs`:

```ts
const listPeopleArgs = z.strictObject({
  nameContains: z.string().optional(),
  hasPage: z.boolean().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})

const listEntitiesArgs = z.strictObject({
  nameContains: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})
```

- [ ] In the same file, add these two definitions to `toolDefinitions()`, directly after the `list_realms` entry:

```ts
    {
      name: 'list_people',
      description:
        'List the people recorded in memory, with each person id, name, whether they have a page, the docId of ' +
        'that page when they do, and when they were first recorded. The system prompt shows only the most recent ' +
        'forty, so this is how you reach anyone older, and how you look someone up by name without guessing. A ' +
        'person with no page is still fully recorded: they have an id you can pass to graph_query, and nothing ' +
        'written about them beyond their name and their links. Results come back as a page: total is the true ' +
        'count of matching people, and hasMore says whether more remain.',
      parameters: {
        type: 'object',
        properties: {
          nameContains: {
            type: 'string',
            description:
              'Return only people whose name contains this text, case-insensitively. Omit to list everyone.',
          },
          hasPage: {
            type: 'boolean',
            description:
              'Return only people who have a page (true) or only those who do not (false). Omit for both.',
          },
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_entities',
      description:
        'List the entities recorded in memory (films, books, companies, places, bands, works of fiction), with ' +
        'each entity id, name, and when it was first recorded. The system prompt shows only the most recent ' +
        'thirty, so this is how you reach anything older. Entities have no pages in this release, so there is ' +
        'nothing to read beyond the name and what the graph links to it; pass the id to graph_query for that. ' +
        'Results come back as a page: total is the true count of matching entities, and hasMore says whether ' +
        'more remain.',
      parameters: {
        type: 'object',
        properties: {
          nameContains: {
            type: 'string',
            description:
              'Return only entities whose name contains this text, case-insensitively. Omit to list everything.',
          },
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
```

- [ ] In the same file, add these two cases to the `switch` in `dispatchTool`, after the `list_realms` case:

```ts
      case 'list_people':
        return await dispatchListPeople(engine, parsedArgs.value)
      case 'list_entities':
        return await dispatchListEntities(engine, parsedArgs.value)
```

- [ ] In the same file, add these two dispatch functions after `dispatchListRealms`:

```ts
async function dispatchListPeople(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listPeopleArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_people', parsed.error))

  const options: ListPeopleOptions = {}
  if (parsed.data.nameContains !== undefined) options.nameContains = parsed.data.nameContains
  if (parsed.data.hasPage !== undefined) options.hasPage = parsed.data.hasPage
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(engine.listPeople(options))
}

async function dispatchListEntities(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listEntitiesArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_entities', parsed.error))

  const options: ListEntitiesOptions = {}
  if (parsed.data.nameContains !== undefined) options.nameContains = parsed.data.nameContains
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(engine.listEntities(options))
}
```

- [ ] In the same file, extend the type-only import from `@openreverie/memory` to include `ListEntitiesOptions` and `ListPeopleOptions`.

- [ ] Run `npx vitest run packages/core/src/tools.test.ts`. All tests pass.

- [ ] Falsify: delete the `list_people` case from the dispatch switch, rerun, and confirm the new test fails with an `unknown tool: list_people` error. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Add list_people and list_entities tools"`

---

## Task 11: The node lane in `search_memory`

A listing tool alone cannot find the 41st person: a tool returning a page of 40 has the prompt's problem one page further along. A search alone cannot enumerate: ranked results are not a roster. Both are needed, and they answer different questions. Task 9 built the roster; this builds the search.

The implementation is a case-folded substring scan over `nodes.label`, not an FTS5 table. Node counts are hundreds to low thousands after years of daily use, so a full scan of that table in SQLite is sub-millisecond and is dwarfed by the embedding round trip the same search already makes. `replaceGraph` wipes and refills `nodes` on every engine open and every graph change, and keeping an external-content FTS5 table correct across that requires delete bookkeeping that buys nothing at this size; a desynced FTS index is exactly the silent-wrong-answer bug this release exists to remove. Name lookup also wants substring and prefix behavior, and FTS5 matches whole tokens, giving prefix matching only with an explicit trailing `*` and never mid-token: "ren" should find "Renata".

Node hits are never fused into the RRF ranking. A node has no chunk, no FTS rank and no cosine score, so any score assigned to it for fusion would be invented, and mixing an invented score into a real ranking is how a retrieval system starts lying quietly.

**Files**

- Modify: `packages/memory/src/sqlite.ts`
- Modify: `packages/memory/src/sqlite.test.ts`
- Modify: `packages/memory/src/retrieval.ts`
- Modify: `packages/memory/src/retrieval.test.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`
- Modify: `packages/cli/src/e2e.test.ts`

**Interfaces**

Consumes:

```ts
// packages/memory/src/graph.ts:16
export type NodeType = 'realm' | 'arc' | 'item' | 'session' | 'person' | 'entity'
```

Produces:

```ts
// packages/memory/src/sqlite.ts
export interface NodeMatch {
  id: string
  type: NodeType
  label: string
  doc: string | null
  ts: string
}
export function nodeQueryTokens(query: string): string[]
class MemoryIndex {
  searchNodes(query: string, limit: number): NodeMatch[]
}

// packages/memory/src/retrieval.ts
export interface SearchResults {
  documents: SearchHit[]
  nodes: NodeMatch[]
}
export async function searchMemory(...): Promise<SearchResults>   // was Promise<SearchHit[]>

// packages/memory/src/engine.ts
export interface NodeHit {
  nodeId: string
  name: string
  type: NodeType
  hasPage: boolean
  docId?: string
}
export interface EngineSearchResult {
  documents: SearchHit[]
  nodes: NodeHit[]
}
class MemoryEngine {
  async search(query: string, filters?: SearchFilters, limit?: number): Promise<EngineSearchResult>
}
```

Matching rule, exactly: the query is case-folded and split on non-word characters. Tokens shorter than three characters are dropped, unless the entire query is a single token, in which case it is kept (a two-letter nickname is a real name). A node matches if any surviving token is a substring of its case-folded label. Results are ordered by match quality (whole-label equality, then label prefix, then substring), then node `ts` descending, then node id descending. Capped at `NODE_HITS_CAP = 10`.

Every node type is included, not just person and entity. An arc or realm with a page appears in both lanes, which is not waste: the document lane answers "what does this page say", the node lane answers "what is this node's id", and `graph_query` needs the id. Item nodes matter too: item text is already indexed (`buildChunks` appends `itemChunkText` per item, `sqlite.ts:408-417`) but the item's node id is not recoverable from a document hit.

**Steps**

- [ ] Add this test to `packages/memory/src/sqlite.test.ts`, as a new `describe` inside `describe('MemoryIndex', ...)`:

```ts
  describe('searchNodes', () => {
    function graphWith(nodes: { id: string; type: string; label: string; doc?: string; ts: string }[]) {
      return {
        nodes: new Map(
          nodes.map((n) => [
            n.id,
            { id: n.id, type: n.type, label: n.label, ...(n.doc ? { doc: n.doc } : {}), ts: n.ts },
          ]),
        ),
        edges: new Map(),
      } as unknown as GraphState
    }

    it('matches by case-folded substring and orders by match quality then recency', () => {
      index.replaceGraph(
        graphWith([
          { id: 'person_1', type: 'person', label: 'Renata', ts: '2026-08-01T00:00:00.000Z' },
          {
            id: 'person_2',
            type: 'person',
            label: 'Lorenzo',
            ts: '2026-08-02T00:00:00.000Z',
          },
          { id: 'person_3', type: 'person', label: 'ren', ts: '2026-07-01T00:00:00.000Z' },
          { id: 'entity_1', type: 'entity', label: 'Unrelated', ts: '2026-08-03T00:00:00.000Z' },
        ]),
      )

      const hits = index.searchNodes('ren', 10)
      // Exact label match first, then the prefix match, then the mid-word
      // substring match. "Unrelated" does not match at all.
      expect(hits.map((h) => h.id)).toEqual(['person_3', 'person_1', 'person_2'])
    })

    it('drops short tokens unless the whole query is one token', () => {
      index.replaceGraph(
        graphWith([
          { id: 'person_1', type: 'person', label: 'Jo', ts: '2026-08-01T00:00:00.000Z' },
          { id: 'person_2', type: 'person', label: 'Anderson', ts: '2026-08-02T00:00:00.000Z' },
        ]),
      )

      // A single short token is kept: a two-letter nickname is a real name.
      expect(index.searchNodes('jo', 10).map((h) => h.id)).toEqual(['person_1'])
      // In a multi-token query the short token is dropped, so only
      // "anderson" is matched and Jo does not come back.
      expect(index.searchNodes('jo anderson', 10).map((h) => h.id)).toEqual(['person_2'])
    })

    it('returns every node type, with the page path when there is one, and honours the limit', () => {
      index.replaceGraph(
        graphWith([
          {
            id: 'arc_1',
            type: 'arc',
            label: 'Kayaking',
            doc: '/memory/arcs/kayaking.md',
            ts: '2026-08-01T00:00:00.000Z',
          },
          { id: 'item_1', type: 'item', label: 'Kayaking again', ts: '2026-08-02T00:00:00.000Z' },
          { id: 'entity_1', type: 'entity', label: 'Kayaks Inc', ts: '2026-08-03T00:00:00.000Z' },
        ]),
      )

      const hits = index.searchNodes('kayaking', 10)
      expect(hits.map((h) => h.type).sort()).toEqual(['arc', 'item'])
      expect(hits.find((h) => h.id === 'arc_1')?.doc).toBe('/memory/arcs/kayaking.md')
      expect(hits.find((h) => h.id === 'item_1')?.doc).toBeNull()
      expect(index.searchNodes('kayaking', 1)).toHaveLength(1)
    })

    it('returns nothing for a query with no usable tokens', () => {
      index.replaceGraph(
        graphWith([{ id: 'person_1', type: 'person', label: 'Jo', ts: '2026-08-01T00:00:00.000Z' }]),
      )
      expect(index.searchNodes('   ', 10)).toEqual([])
      expect(index.searchNodes('a b', 10)).toEqual([])
    })
  })
```

- [ ] Run `npx vitest run packages/memory/src/sqlite.test.ts -t "searchNodes"`. It fails: `index.searchNodes is not a function`.

- [ ] In `packages/memory/src/sqlite.ts`, add the exported type next to `SearchHit` (line 29):

```ts
// A graph node whose name matched a search query. Separate from SearchHit
// on purpose: a node has no chunk, no FTS rank and no cosine score, so it
// carries no score at all rather than an invented one.
export interface NodeMatch {
  id: string
  type: NodeType
  label: string
  doc: string | null
  ts: string
}
```

- [ ] In the same file, add this method to `MemoryIndex`, directly after `searchVector`:

```ts
  // A full scan of the nodes table, case-folded, matched by substring. See
  // the comment on nodeQueryTokens for the matching rule, and the spec for
  // why this is a scan rather than an FTS5 table: node counts are in the
  // hundreds to low thousands, replaceGraph rewrites this table wholesale on
  // every open, and name lookup wants mid-token substring behavior that FTS5
  // does not give.
  searchNodes(query: string, limit: number): NodeMatch[] {
    const tokens = nodeQueryTokens(query)
    if (tokens.length === 0) {
      return []
    }
    const rows = this.db.prepare('SELECT id, type, label, doc, ts FROM nodes').all() as NodeRow[]

    const scored: { row: NodeRow; tier: number }[] = []
    for (const row of rows) {
      const label = row.label.toLowerCase()
      let tier = 3
      for (const token of tokens) {
        if (label === token) {
          tier = Math.min(tier, 0)
        } else if (label.startsWith(token)) {
          tier = Math.min(tier, 1)
        } else if (label.includes(token)) {
          tier = Math.min(tier, 2)
        }
      }
      if (tier < 3) {
        scored.push({ row, tier })
      }
    }

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.row.ts !== b.row.ts) return a.row.ts > b.row.ts ? -1 : 1
      return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0
    })

    return scored.slice(0, limit).map(({ row }) => ({
      id: row.id,
      type: row.type,
      label: row.label,
      doc: row.doc,
      ts: row.ts,
    }))
  }
```

- [ ] In the same file, add this module-level function next to `toFtsQuery`:

```ts
// Splits a search query into the tokens the node scan matches on. The query
// is case-folded and split on non-word characters. Tokens shorter than three
// characters are dropped, because a two-letter fragment matches a large
// share of any name list, unless the entire query is one token, in which
// case it is kept: a two-letter nickname is a real name someone might search
// for on its own.
export function nodeQueryTokens(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
  if (raw.length === 1) {
    return raw
  }
  return raw.filter((token) => token.length >= 3)
}
```

- [ ] Run `npx vitest run packages/memory/src/sqlite.test.ts`. All tests pass.

- [ ] Add this test to `packages/memory/src/retrieval.test.ts`:

```ts
  it('returns node matches in their own lane, never fused into the document ranking', async () => {
    const query = 'renata'

    await index.upsertDocument(
      doc({ meta: { id: 'doc_note' }, body: 'A note that mentions renata once.' }),
      'realm',
      embedFn(embeddings),
    )
    index.replaceGraph({
      nodes: new Map([
        [
          'person_renata',
          {
            id: 'person_renata',
            type: 'person' as const,
            label: 'Renata',
            ts: '2026-08-01T00:00:00.000Z',
          },
        ],
      ]),
      edges: new Map(),
    })

    const results = await searchMemory(index, embeddings, MODEL, query)

    expect(results.documents.map((h) => h.docId)).toEqual(['doc_note'])
    expect(results.nodes.map((n) => n.id)).toEqual(['person_renata'])
    // A node hit carries no score field at all: it has no rank in either
    // list and any score given to it for fusion would be fabricated.
    expect(Object.keys(results.nodes[0] ?? {}).sort()).toEqual(['doc', 'id', 'label', 'ts', 'type'])
  })
```

- [ ] In `packages/memory/src/retrieval.ts`, add the `NodeMatch` type to the existing type-only import from `./sqlite.js`, add the cap constant next to `RRF_K`, add the result interface, and change `searchMemory`:

```ts
const NODE_HITS_CAP = 10

// Two lanes, returned separately. `documents` are ranked passages fused from
// the FTS and cosine lists. `nodes` are graph nodes whose name matched, and
// they are deliberately not fused in: a node has no chunk, so it has no rank
// in either list, and any score invented for it would corrupt a real ranking.
export interface SearchResults {
  documents: SearchHit[]
  nodes: NodeMatch[]
}
```

and the tail of the function body:

```ts
  const fused = fuseByReciprocalRank([textHits, vectorHits])
  return {
    documents: fused.slice(0, limit),
    nodes: index.searchNodes(query, NODE_HITS_CAP),
  }
```

with the signature's return type changed to `Promise<SearchResults>`.

- [ ] In `packages/memory/src/retrieval.test.ts`, every existing test reads the return value as an array. Change each `const hits = await searchMemory(...)` to read `.documents`, for example `const hits = (await searchMemory(index, embeddings, MODEL, query)).documents`. There are eight such call sites in the file (including the three added in Task 5); update all of them.

- [ ] Run `npx vitest run packages/memory/src/retrieval.test.ts`. All tests pass.

- [ ] In `packages/memory/src/engine.ts`, add `type NodeType` to the existing import from `./graph.js` (line 27), add `type NodeMatch` to the import from `./sqlite.js` (line 62), add these types below `EngineSearchResult`'s neighbours in the interface block, and replace `search` (lines 670 to 679):

```ts
export interface NodeHit {
  nodeId: string
  name: string
  type: NodeType
  hasPage: boolean
  docId?: string
}

export interface EngineSearchResult {
  documents: SearchHit[]
  nodes: NodeHit[]
}
```

```ts
  async search(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<EngineSearchResult> {
    const results = await searchMemory(
      this.index,
      this.deps.embeddings,
      this.deps.embeddingModel,
      query,
      filters,
      limit,
    )
    // The nodes table stores a filesystem path, not a document id, so the
    // path-to-docId projection happens here, exactly as withDocId does for
    // graphQuery. A node with no page has neither.
    const nodes: NodeHit[] = results.nodes.map((node) => {
      const hit: NodeHit = {
        nodeId: node.id,
        name: node.label,
        type: node.type,
        hasPage: node.doc !== null,
      }
      const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
      if (docId) hit.docId = docId
      return hit
    })
    return { documents: results.documents, nodes }
  }
```

- [ ] Update every existing `engine.search` call site to read `.documents`:

  - `packages/memory/src/engine.test.ts:356`, `:367`, `:371`, `:598`, `:605`, `:613`, `:826`, `:2333`, `:2336`, `:2458`, `:2546`, `:2556`.
  - The migration test added in Task 3: `before.some(...)` becomes `before.documents.some(...)` and `after.some(...)` becomes `after.documents.some(...)`.
  - `packages/cli/src/e2e.test.ts:195`, `:267`, `:271`.

  For example, `const hits = await engine.search('anxious')` becomes `const hits = (await engine.search('anxious')).documents`, and `expect(hitsBeforeRebuild).toEqual([])` becomes `expect(hitsBeforeRebuild.documents).toEqual([])` if the variable holds the whole result. Pick one style per call site; the assertion must end up reading the `documents` array. Note that on an empty document index the `nodes` lane can still be non-empty, because `nodes` is refilled from `graph.jsonl` on every open, so an "index is empty" assertion must be made against `documents` specifically.

- [ ] Add this test to `packages/memory/src/engine.test.ts` at the end of the file:

```ts
describe('search node lane', () => {
  it('finds a person with no page by name and gives back an id, not a docId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-node-lane-'))
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    const pagedPath = join(paths.peopleDir, 'priya.md')
    await writeDocumentAtomic({
      path: pagedPath,
      meta: { id: 'doc_priya', name: 'Priya', node: 'person_priya' },
      body: 'Priya runs the reading group.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_priya',
        type: 'person',
        label: 'Priya',
        doc: pagedPath,
      },
      {
        ts: '2026-08-02T00:00:00.000Z',
        op: 'assert',
        node: 'person_dara',
        type: 'person',
        label: 'Dara',
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const unpaged = await engine.search('Dara')
    expect(unpaged.nodes).toEqual([
      { nodeId: 'person_dara', name: 'Dara', type: 'person', hasPage: false },
    ])
    expect(unpaged.documents.some((hit) => hit.docId === 'doc_dara')).toBe(false)

    const paged = await engine.search('Priya')
    expect(paged.nodes[0]).toEqual({
      nodeId: 'person_priya',
      name: 'Priya',
      type: 'person',
      hasPage: true,
      docId: 'doc_priya',
    })

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})
```

- [ ] In `packages/core/src/tools.ts`, change the last line of `dispatchSearchMemory` (line 304) from `return JSON.stringify(hits)` to:

```ts
  const results = await engine.search(query, filters, limit)
  return JSON.stringify(results)
```

renaming the `hits` local to `results`.

- [ ] In `packages/core/src/tools.test.ts:199-201`, change the parse and assertions to read the documents lane:

```ts
    const results = JSON.parse(result) as { documents: { docId: string; kind: string }[] }
    expect(results.documents.length).toBeGreaterThan(0)
    expect(results.documents[0]?.kind).toBe('summary')
```

- [ ] Run `pnpm test`. The whole suite passes.

- [ ] Falsify: make `searchNodes` return `[]` unconditionally, rerun `npx vitest run packages/memory/src/engine.test.ts -t "finds a person with no page by name"`, and confirm it fails on the unpaged assertion. Restore.

- [ ] Run `pnpm build` and `pnpm lint`. Both exit 0.

- [ ] Commit: `git add -A && git commit -m "Add a graph node lane to search, returned beside documents and never fused"`

---

## Task 12: Tell the model what the two search lanes mean

Without a sentence explaining a node-only hit, a model receiving one will either ignore it or assume a page failed to load.

**Files**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Steps**

- [ ] Add this test to `packages/core/src/tools.test.ts`, inside `describe('toolDefinitions', ...)`:

```ts
  it('explains both search lanes and what a node-only hit means', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    expect(searchMemory.description).toContain('two parts')
    expect(searchMemory.description).toContain('hasPage: false')
    expect(searchMemory.description).toContain('graph_query')
  })
```

- [ ] Run `npx vitest run packages/core/src/tools.test.ts -t "explains both search lanes"`. It fails: the current description says nothing about lanes.

- [ ] In `packages/core/src/tools.ts`, replace the `search_memory` description string (lines 72 to 77) with:

```ts
      description:
        'Search memory before answering from a vague impression of what was probably said. Use this whenever the ' +
        'conversation touches something that might already be recorded: an ongoing arc, a past event, a person, a ' +
        'decision made earlier. Retrieve before asserting: check the record rather than guess. Results come back ' +
        'in two parts. documents are ranked passages from pages, summaries and rollups, each with a snippet. ' +
        'nodes are graph nodes whose name matches the query, including people and things that have no page of ' +
        'their own; a node hit carries an id you can pass to graph_query, and a docId only when a page exists. A ' +
        'node hit with hasPage: false means this person or thing is known and recorded, and there is nothing ' +
        'written about them beyond their name and their links.',
```

- [ ] Run `npx vitest run packages/core/src/tools.test.ts`. All tests pass.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Describe both search_memory lanes and what a node-only hit means"`

---

## Task 13: The prompt's truncation markers gain the escape hatch

The existing markers (`context.ts:109-113` and `:121-124`) say more exist. They must say how to get them. This is the single change that closes the loop the current code opens.

**Files**

- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/context.test.ts`

**Interfaces**

Consumes: `SessionContext` (`packages/memory/src/engine.ts:123`).

Produces (two required fields added to `SessionContext`):

```ts
export interface SessionContext {
  // ... existing fields unchanged
  peopleTotal: number
  entitiesTotal: number
}
```

Both are required, not optional. Nothing in the repository builds a `SessionContext` object literal (verified by grep: every consumer calls `engine.sessionContext()`), so a required field breaks nothing.

Marker text, exactly:

```
(showing 40 of 137 people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)
```

```
(showing 30 of 84 entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)
```

**Steps**

- [ ] Add this test to `packages/core/src/context.test.ts`, at the end of the `describe('assembleSystemPrompt', ...)` block:

```ts
  it('names the tool that reaches the people and entities the prompt could not show', async () => {
    const records = []
    for (let i = 0; i < 45; i++) {
      records.push({
        ts: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
        op: 'assert' as const,
        node: `person_${i}`,
        type: 'person' as const,
        label: `Person ${i}`,
      })
    }
    for (let i = 0; i < 35; i++) {
      records.push({
        ts: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
        op: 'assert' as const,
        node: `entity_${i}`,
        type: 'entity' as const,
        label: `Entity ${i}`,
      })
    }
    // An arc so this is not treated as a first session, which would replace
    // every optional section with the onboarding block.
    records.push({
      ts: '2026-08-01T00:00:00.000Z',
      op: 'assert' as const,
      node: 'arc_any',
      type: 'arc' as const,
      label: 'Any Arc',
    })
    await appendGraph(paths, records)

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain(
      '(showing 40 of 45 people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)',
    )
    expect(prompt).toContain(
      '(showing 30 of 35 entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)',
    )

    await engine.close()
  })

  it('shows no truncation marker when nothing was truncated', async () => {
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_only',
        type: 'person',
        label: 'Only Person',
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## People')
    expect(prompt).not.toContain('Call list_people')

    await engine.close()
  })
```

- [ ] Update the existing test at `packages/core/src/context.test.ts:416`: replace `expect(prompt).toContain('list truncated')` with `expect(prompt).toContain('Call list_people to page through the rest')`. Leave the two surrounding assertions about `Person 44` and `Person 0` exactly as they are.

- [ ] Run `npx vitest run packages/core/src/context.test.ts`. The two new tests and the edited one fail: the current markers carry no counts and name no tool.

- [ ] In `packages/memory/src/engine.ts`, add these two fields to `SessionContext`, directly after `peopleTruncated` and `entitiesTruncated` respectively:

```ts
  // The true number of person nodes, whether or not they fit under
  // PEOPLE_CAP. The prompt's truncation marker states it, so the model
  // knows how much of the roster it is not being shown.
  peopleTotal: number
```

```ts
  // The true number of entity nodes, for the same reason as peopleTotal.
  entitiesTotal: number
```

- [ ] In the same file, in `sessionContext`'s return object (line 654 onward), add `peopleTotal: personNodes.length,` next to `peopleTruncated` and `entitiesTotal: entityNodes.length,` next to `entitiesTruncated`.

- [ ] In `packages/core/src/context.ts`, replace `peopleSection` and `entitiesSection` (lines 104 to 126) with:

```ts
function peopleSection(context: SessionContext): string | undefined {
  if (context.people.length === 0) return undefined
  const lines = context.people.map(
    (person) => `- ${person.name} (${person.id}, ${person.hasPage ? 'has a page' : 'no page yet'})`,
  )
  if (context.peopleTruncated) {
    // The marker names the tool that closes the gap. A marker that says
    // more exist without saying how to reach them tells the model something
    // exists and gives it no way to fetch it, which is the defect this
    // release exists to remove.
    lines.push(
      `(showing ${context.people.length} of ${context.peopleTotal} people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)`,
    )
  }
  return `## People\n\n${lines.join('\n')}`
}

function entitiesSection(context: SessionContext): string | undefined {
  if (context.entities.length === 0) return undefined
  const lines = context.entities.map((entity) => `- ${entity.name}`)
  if (context.entitiesTruncated) {
    lines.push(
      `(showing ${context.entities.length} of ${context.entitiesTotal} entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)`,
    )
  }
  return `## Entities\n\n${lines.join('\n')}`
}
```

- [ ] Run `npx vitest run packages/core/src/context.test.ts`. All tests pass.

- [ ] Falsify: revert the two marker strings to the old wording, rerun, and confirm the first new test fails on both markers while the second (no-marker) test still passes. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green. Note `packages/memory/src/engine.test.ts:3701` also asserts `'list truncated'`, but that assertion is against the reflection prompt built by `reflection.ts:165` and `:185`, which this task does not touch, so it keeps passing.

- [ ] Commit: `git add -A && git commit -m "Point the prompt's truncation markers at the tools that reach the rest"`

---

## Task 14: The prompt budget module

`constitutionSection` (`context.ts:67-71`), `latestDailyRollupSection` (`:92-96`) and `recentSummariesSection` (`:98-102`) render full bodies with no cap. This task builds the pure functions and the constants; Tasks 15, 16 and 17 apply them.

The budget is in characters, not tokens. There is no tokenizer in this repository; a grep across all six packages finds `maxTokens` as a pass-through request field and nothing that counts. The rough conversion of four characters per token is an assumption stated in the spec, not something this code asserts.

There is no cross-section arbitration, and that is the design choice. Every cap is hard and applied independently, so the sum can never exceed 27,800 and no runtime priority ordering is ever needed. A global squeeze would make the prompt's content depend on the size of unrelated sections, which is unpleasant to reason about and unpleasant to test: the same constitution would render differently depending on how many people exist.

**Files**

- Create: `packages/core/src/budget.ts`
- Create: `packages/core/src/budget.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces**

Produces:

```ts
export const PROFILE_BODY_CAP = 2000
export const CONSTITUTION_CAP = 6000
export const REALMS_SECTION_CAP = 4000
export const REALM_FIRST_LINE_CAP = 160
export const ARCS_SECTION_CAP = 2000
export const PEOPLE_SECTION_CAP = 2500
export const ENTITIES_SECTION_CAP = 1200
export const RECENT_INTENTIONS_SECTION_CAP = 800
export const LATEST_DAILY_ROLLUP_CAP = 2500
export const ROLLUPS_AVAILABLE_CAP = 800
export const RECENT_SUMMARIES_SECTION_CAP = 6000
export const RECENT_SUMMARY_CAP = 2000
export const PROMPT_BUDGET_TOTAL = 28000
export const SECTION_CAPS: number[]

export function capBody(body: string, limit: number, docId: string): { text: string; truncated: boolean }
export function capRows(rows: string[], limit: number): { rows: string[]; shown: number }
```

`PROFILE_BODY_CAP` is carried here only so the running total accounts for it. The modes spec (`2026-08-16-modes-profile-settings-design.md`, section 3.2) owns `profile.md`'s prose body and enforces that cap at prompt-assembly time with its own bare `… [truncated]` marker. `capBody` is not applied to it: `profile.md` is unindexed by design, so it has no docId to hand back, and a marker with no fetch key is correct only where no read path exists.

`ARCS_CAP` and the other row caps are not in `SECTION_CAPS`: they bound row counts, not characters, and adding them to a character sum would be meaningless.

Truncation is always signalled, and always with a fetch key:

```
(truncated: showing the first 6,000 of 18,432 characters. Call read_document with docId doc_01JAB7QK3M9XZ2R4T6V8W0YCDE for the full text.)
```

Prose is cut from the start of the body forward, at the last paragraph boundary at or before the cap; if there is no paragraph boundary before the cap, it is cut at the cap. Keeping the head rather than the tail is deliberate for the constitution, whose opening carries the most stable identity material, and neutral for rollups and summaries, which are written as narrative.

**Steps**

- [ ] Create `packages/core/src/budget.test.ts` with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import {
  capBody,
  capRows,
  CONSTITUTION_CAP,
  PROMPT_BUDGET_TOTAL,
  SECTION_CAPS,
} from './budget.js'

describe('the budget arithmetic', () => {
  it('keeps the sum of every per-section character cap inside the stated total', () => {
    const sum = SECTION_CAPS.reduce((total, cap) => total + cap, 0)
    expect(sum).toBe(27800)
    expect(sum).toBeLessThanOrEqual(PROMPT_BUDGET_TOTAL)
  })
})

describe('capBody', () => {
  it('leaves a body under the limit exactly as it is, with no marker', () => {
    const body = 'A short constitution.\n\nTwo paragraphs, nothing more.'
    const result = capBody(body, CONSTITUTION_CAP, 'doc_1')
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(body)
    expect(result.text).not.toContain('truncated')
  })

  it('cuts at the last paragraph boundary before the limit and names the docId', () => {
    const head = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`
    const tail = 'THE SENTINEL PARAGRAPH'
    const body = `${head}\n\n${tail}`
    const result = capBody(body, 90, 'doc_01JAB7QK3M9XZ2R4T6V8W0YCDE')

    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain(tail)
    expect(result.text).toContain('a'.repeat(40))
    expect(result.text).toContain('b'.repeat(40))
    expect(result.text).toContain(
      'Call read_document with docId doc_01JAB7QK3M9XZ2R4T6V8W0YCDE for the full text.',
    )
    expect(result.text).toContain('(truncated: showing the first 82 of 114 characters.')
  })

  it('cuts at the limit when there is no paragraph boundary before it', () => {
    const body = 'x'.repeat(500)
    const result = capBody(body, 100, 'doc_2')
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('x'.repeat(100))).toBe(true)
    expect(result.text).toContain('(truncated: showing the first 100 of 500 characters.')
  })

  it('formats large character counts with thousands separators', () => {
    const result = capBody('y'.repeat(18432), 6000, 'doc_3')
    expect(result.text).toContain('(truncated: showing the first 6,000 of 18,432 characters.')
  })
})

describe('capRows', () => {
  it('keeps every row when they all fit', () => {
    const rows = ['- one', '- two', '- three']
    expect(capRows(rows, 1000)).toEqual({ rows, shown: 3 })
  })

  it('stops at the last row that fits, counting the newline between rows', () => {
    // '- one' is 5 characters, '- two' another 5 plus one newline: 11 to
    // hold both. A limit of 10 holds only the first.
    const result = capRows(['- one', '- two', '- three'], 10)
    expect(result).toEqual({ rows: ['- one'], shown: 1 })
  })

  it('returns nothing when even the first row does not fit', () => {
    expect(capRows(['- a very long single row'], 5)).toEqual({ rows: [], shown: 0 })
  })
})
```

- [ ] Run `npx vitest run packages/core/src/budget.test.ts`. It fails: `./budget.js` does not exist.

- [ ] Create `packages/core/src/budget.ts` with exactly this content:

```ts
// The system prompt's character budget.
//
// Measured in characters, not tokens. There is no tokenizer anywhere in this
// repository, so a budget in tokens would be a number nothing could check.
// The working assumption behind the numbers below is roughly four characters
// per token for English prose, and that assumption is stated rather than
// asserted: everything here counts characters.
//
// Every cap is hard and applied independently. There is no cross-section
// arbitration, so the assembled body can never exceed the sum below and no
// runtime priority ordering is ever needed. A global squeeze, where sections
// yield to each other against a total, would make each section's content
// depend on the size of unrelated sections: the same constitution would
// render differently depending on how many people exist, which is
// unpleasant to reason about and worse to test.
//
// The persona is excluded from the budget: it is authored, fixed in size,
// and cannot grow with use.

// profile.md's prose body. Owned and enforced by the modes spec
// (2026-08-16-modes-profile-settings-design.md, section 3.2), which caps it
// at prompt-assembly time with its own truncation marker. It is carried here
// only so the running total accounts for it. capBody is deliberately not
// applied to it: profile.md is unindexed by design, so it has no docId to
// hand back, and a marker without a fetch key is correct only where no read
// path through any tool exists.
export const PROFILE_BODY_CAP = 2000

export const CONSTITUTION_CAP = 6000
export const REALMS_SECTION_CAP = 4000
export const REALM_FIRST_LINE_CAP = 160
export const ARCS_SECTION_CAP = 2000
export const PEOPLE_SECTION_CAP = 2500
export const ENTITIES_SECTION_CAP = 1200
export const RECENT_INTENTIONS_SECTION_CAP = 800
export const LATEST_DAILY_ROLLUP_CAP = 2500
export const ROLLUPS_AVAILABLE_CAP = 800
export const RECENT_SUMMARIES_SECTION_CAP = 6000
// Three summaries at 2,000 characters each is the section cap above.
export const RECENT_SUMMARY_CAP = 2000

// The target for the whole assembled body. Not runtime behavior: nothing
// measures the finished prompt against it. It is an invariant asserted by a
// test over the constants, which fails if anyone raises a cap past the total.
export const PROMPT_BUDGET_TOTAL = 28000

// Every character cap that contributes to the assembled body, in prompt
// order. Row caps (ARCS_CAP, PEOPLE_CAP, ENTITIES_CAP) are deliberately
// absent: they bound row counts, not characters.
export const SECTION_CAPS: number[] = [
  PROFILE_BODY_CAP,
  CONSTITUTION_CAP,
  REALMS_SECTION_CAP,
  ARCS_SECTION_CAP,
  PEOPLE_SECTION_CAP,
  ENTITIES_SECTION_CAP,
  RECENT_INTENTIONS_SECTION_CAP,
  LATEST_DAILY_ROLLUP_CAP,
  ROLLUPS_AVAILABLE_CAP,
  RECENT_SUMMARIES_SECTION_CAP,
]

// Cuts a prose body to `limit` characters and, when it cuts, appends a
// marker naming the docId that fetches the whole thing. The docId is
// required, not decorative: a truncation marker without one tells the model
// something exists and gives it no way to reach it.
//
// The cut is from the start of the body forward, at the last paragraph
// boundary at or before the limit, or at the limit itself when there is no
// boundary before it. Keeping the head rather than the tail is deliberate
// for the constitution, whose opening carries the most stable identity
// material, and neutral for rollups and summaries, which are narrative.
//
// This applies to assembleSystemPrompt only. It must never be applied to the
// constitution in the reflection path: reflection emits its constitution
// update as a complete replacement body, so a model shown a truncated
// constitution and asked to produce the updated one deletes the tail it
// never saw from disk.
export function capBody(
  body: string,
  limit: number,
  docId: string,
): { text: string; truncated: boolean } {
  if (body.length <= limit) {
    return { text: body, truncated: false }
  }
  const head = body.slice(0, limit)
  const lastBoundary = head.lastIndexOf('\n\n')
  const kept = lastBoundary > 0 ? body.slice(0, lastBoundary) : head
  const marker =
    `(truncated: showing the first ${kept.length.toLocaleString('en-US')} of ` +
    `${body.length.toLocaleString('en-US')} characters. Call read_document with docId ${docId} ` +
    'for the full text.)'
  return { text: `${kept}\n\n${marker}`, truncated: true }
}

// Keeps as many leading rows as fit in `limit` characters, counting the
// newline that joins each row to the one before it. Callers compare `shown`
// against the true total to decide whether to render a truncation marker,
// so this function never renders one itself: the marker wording differs per
// section and always names the tool that reaches the rest.
export function capRows(rows: string[], limit: number): { rows: string[]; shown: number } {
  const kept: string[] = []
  let used = 0
  for (const row of rows) {
    const cost = kept.length === 0 ? row.length : row.length + 1
    if (used + cost > limit) break
    kept.push(row)
    used += cost
  }
  return { rows: kept, shown: kept.length }
}
```

- [ ] Add `export * from './budget.js'` to `packages/core/src/index.ts`, as the first line of the export block (it sorts before `./agent.js`? No: `agent` sorts before `budget`, so place it between the `agent.js` and `config.js` lines).

- [ ] Run `npx vitest run packages/core/src/budget.test.ts`. All eight tests pass.

- [ ] Falsify: raise `CONSTITUTION_CAP` to `6500`, rerun, and confirm the budget arithmetic test fails with `expected 28300 to be 27800`. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Add the prompt character budget: caps, capBody, capRows"`

---

## Task 15: Apply the budget to every capped section of `assembleSystemPrompt`

Task 14 built the caps and the two pure functions; nothing calls them. This task wires them into the three prose sections that currently render unbounded bodies (the constitution, the latest daily rollup, and each recent session summary), and applies the character caps to the list sections (realms, arcs, people, entities, recent intentions). Every prose truncation marker carries a docId so the model can fetch the missing tail, and every list marker names the tool that reaches the rest.

The prose markers need docIds that `SessionContext` does not carry yet. `sessionContext` reads the constitution document, the latest daily rollup, and each summary document but returns only their bodies, so this task also adds `constitutionDocId`, `latestDailyRollup.docId`, and `recentSummaries[].docId` to `SessionContext`. The arcs section gains its row cap (`ARCS_CAP = 30`) in the engine, ordered by `lastTouched`, which is where that field is read.

**Files**

- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/context.test.ts`

**Interfaces**

Consumes (from Task 14):

```ts
// packages/core/src/budget.ts
export const CONSTITUTION_CAP = 6000
export const REALMS_SECTION_CAP = 4000
export const REALM_FIRST_LINE_CAP = 160
export const ARCS_SECTION_CAP = 2000
export const PEOPLE_SECTION_CAP = 2500
export const ENTITIES_SECTION_CAP = 1200
export const RECENT_INTENTIONS_SECTION_CAP = 800
export const LATEST_DAILY_ROLLUP_CAP = 2500
export const RECENT_SUMMARY_CAP = 2000
export function capBody(body: string, limit: number, docId: string): { text: string; truncated: boolean }
export function capRows(rows: string[], limit: number): { rows: string[]; shown: number }
```

Produces (changes to `SessionContext` in `packages/memory/src/engine.ts`):

```ts
export interface SessionContext {
  constitution: string
  // The constitution document's id, so the truncation marker capBody emits
  // can hand the model a key read_document accepts.
  constitutionDocId: string
  arcs: { id: string; name: string; status: string; lastTouched?: string }[]
  // True when there are more active arcs than ARCS_CAP, so `arcs` above is
  // the 30 most recently touched rather than the complete active roster.
  arcsTruncated: boolean
  arcsTotal: number
  latestDailyRollup?: { date: string; body: string; docId: string }
  recentSummaries: { sessionId: string; date: string; body: string; docId: string }[]
  // ... all other fields unchanged
}
```

**Steps**

- [ ] Add this new top-level `describe` block to the end of `packages/core/src/context.test.ts`. It reuses the module-level `testConfig` and `fakeDeps` helpers already in that file:

```ts
describe('assembleSystemPrompt budget', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-context-budget-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function openEngine(): Promise<MemoryEngine> {
    return MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), { maintenance: false })
  }

  it('caps the constitution and hands back its docId for the full text', async () => {
    const docId = newId('doc')
    const sentinel = 'THE SENTINEL SENTENCE THAT IS NEVER SHOWN'
    const body = `${'a'.repeat(6000)}\n\n${'b'.repeat(1000)}\n\n${sentinel}`
    await writeDocumentAtomic({ path: paths.constitution, meta: { id: docId }, body })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('(truncated: showing the first 6,000 of')
    expect(prompt).toContain(`Call read_document with docId ${docId} for the full text.`)
    expect(prompt).not.toContain(sentinel)

    const full = await engine.readDocumentById(docId)
    expect(full?.body).toContain(sentinel)

    await engine.close()
  })

  it('leaves a short constitution uncapped and with no truncation marker', async () => {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: 'The user prefers direct, unflinching honesty.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('The user prefers direct, unflinching honesty.')
    expect(prompt).not.toContain('(truncated:')

    await engine.close()
  })

  it('clips each realm first line to 160 characters', async () => {
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'fitness.md'),
      meta: { id: newId('doc'), name: 'Fitness' },
      body: `${'x'.repeat(200)}\n`,
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        doc: join(paths.realmsDir, 'fitness.md'),
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('x'.repeat(160))
    expect(prompt).not.toContain('x'.repeat(161))

    await engine.close()
  })

  it('caps active arcs at 30 and names list_arcs for the rest', async () => {
    const records: Parameters<typeof appendGraph>[1] = []
    for (let i = 0; i < 33; i++) {
      const arcPath = join(paths.arcsDir, `arc-${i}.md`)
      await writeDocumentAtomic({
        path: arcPath,
        meta: {
          id: newId('doc'),
          name: `Active Arc ${String(i).padStart(2, '0')}`,
          status: 'active',
          updated: `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        },
        body: `Arc ${i}.\n`,
      })
      records.push({
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: `arc_${i}`,
        type: 'arc',
        label: `Active Arc ${String(i).padStart(2, '0')}`,
        doc: arcPath,
      })
    }
    await appendGraph(paths, records)

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain(
      '(showing 30 of 33 active arcs, most recently touched first. Call list_arcs for the rest, including dormant and closed ones.)',
    )
    expect(prompt).toContain('Active Arc 32')
    expect(prompt).not.toContain('Active Arc 00')

    await engine.close()
  })

  it('shows no arcs marker when under the cap, and orders undated arcs last', async () => {
    const datedPath = join(paths.arcsDir, 'touched.md')
    await writeDocumentAtomic({
      path: datedPath,
      meta: { id: newId('doc'), name: 'Touched Arc', status: 'active', updated: '2026-08-10' },
      body: 'Touched.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-02T00:00:00.000Z',
        op: 'assert',
        node: 'arc_loose_two',
        type: 'arc',
        label: 'Loose Two',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_touched',
        type: 'arc',
        label: 'Touched Arc',
        doc: datedPath,
      },
      {
        ts: '2026-08-03T00:00:00.000Z',
        op: 'assert',
        node: 'arc_loose_one',
        type: 'arc',
        label: 'Loose One',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Active arcs')
    expect(prompt).not.toContain('Call list_arcs for the rest')

    const touched = prompt.indexOf('Touched Arc')
    const looseOne = prompt.indexOf('Loose One')
    const looseTwo = prompt.indexOf('Loose Two')
    expect(touched).toBeGreaterThan(-1)
    expect(touched).toBeLessThan(looseOne)
    expect(looseOne).toBeLessThan(looseTwo)

    await engine.close()
  })

  it('caps an over-long daily rollup and hands back its docId', async () => {
    const docId = newId('doc')
    const sentinel = 'THE ROLLUP SENTINEL'
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: docId, date: '2026-08-10' },
      body: `${'c'.repeat(2500)}\n\n${sentinel}`,
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('(truncated: showing the first 2,500 of')
    expect(prompt).toContain(`Call read_document with docId ${docId} for the full text.`)
    expect(prompt).not.toContain(sentinel)

    await engine.close()
  })

  it('caps each recent session summary independently', async () => {
    const store = await SessionStore.start(paths, new Date(Date.now() - 24 * 60 * 60 * 1000))
    const docId = newId('doc')
    const sentinel = 'THE SUMMARY SENTINEL'
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: docId },
      body: `${'d'.repeat(2000)}\n\n${sentinel}`,
    })

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('(truncated: showing the first 2,000 of')
    expect(prompt).toContain(`Call read_document with docId ${docId} for the full text.`)
    expect(prompt).not.toContain(sentinel)

    await engine.close()
  })
})
```

- [ ] Run `npx vitest run packages/core/src/context.test.ts -t "caps the constitution"`. It must fail: the constitution is currently rendered in full, so the `(truncated: showing the first 6,000 of` assertion fails and the sentinel is present.

- [ ] In `packages/memory/src/engine.ts`, add the constant next to `PEOPLE_CAP` (line 200):

```ts
// Active arcs rendered in the prompt. Active-only filtering bounds arcs
// against closed ones and nothing bounds them against each other, so a
// user with many open storylines would otherwise grow this section without
// bound. The reflection prompt does not share this cap (arcs are listed
// there by id and label only, which stays short), so it lives here next to
// the chat-prompt caps.
const ARCS_CAP = 30
```

- [ ] In the same file, add `constitutionDocId`, `arcsTruncated`, and `arcsTotal` to the `SessionContext` interface, and change the `latestDailyRollup` and `recentSummaries` declarations. Replace the `latestDailyRollup` line with:

```ts
  latestDailyRollup?: { date: string; body: string; docId: string }
```

and the `recentSummaries` line with:

```ts
  recentSummaries: { sessionId: string; date: string; body: string; docId: string }[]
```

and add these three declarations directly below the `constitution` and `arcs` declarations respectively:

```ts
  // The constitution document's id, so the truncation marker capBody emits
  // can hand the model a key read_document accepts. The prompt shows at most
  // CONSTITUTION_CAP characters; the id is how it fetches the rest.
  constitutionDocId: string
```

```ts
  // True when there are more active arcs than ARCS_CAP, so `arcs` above is
  // the most recently touched subset rather than the complete active roster.
  arcsTruncated: boolean
  // The true number of active arcs, for the same reason peopleTotal and
  // entitiesTotal exist: the marker states how many were not shown.
  arcsTotal: number
```

- [ ] In the same file, add this comparator next to `byTsDescending` (line 1696):

```ts
// Orders active arcs for the prompt: most recently touched first, and arcs
// whose page could not be read (no lastTouched) sort last, ordered among
// themselves by node ts descending. Without that rule the ARCS_CAP cut
// would drop a nondeterministic arc, since the undated group's order would
// otherwise depend on graph.jsonl's insertion order.
function compareArcs(
  a: { lastTouched?: string; ts: string; id: string },
  b: { lastTouched?: string; ts: string; id: string },
): number {
  if (a.lastTouched !== undefined && b.lastTouched !== undefined) {
    if (a.lastTouched !== b.lastTouched) return a.lastTouched > b.lastTouched ? -1 : 1
  } else if (a.lastTouched !== undefined) {
    return -1
  } else if (b.lastTouched !== undefined) {
    return 1
  }
  if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}
```

- [ ] In the same file, replace the arcs loop in `sessionContext` (lines 529 to 549) with:

```ts
    const arcs: SessionContext['arcs'] = []
    const arcRows: { id: string; name: string; status: string; lastTouched?: string; ts: string }[] =
      []
    for (const node of this.graphState.nodes.values()) {
      if (node.type !== 'arc') continue
      let status = 'active'
      let lastTouched: string | undefined
      if (node.doc) {
        try {
          const doc = await readDocument(node.doc)
          if (typeof doc.meta.status === 'string') status = doc.meta.status
          if (typeof doc.meta.updated === 'string') lastTouched = doc.meta.updated
        } catch {
          // Arc node points at a doc that no longer reads cleanly; fall
          // back to defaults rather than failing the whole context build.
        }
      }
      // Ruling 3: sessionContext only carries active arcs into the
      // assembled context; dormant and closed arcs never age out of
      // graphState on their own, so they must be filtered here instead.
      if (status !== 'active') continue
      arcRows.push({
        id: node.id,
        name: node.label,
        status,
        ...(lastTouched ? { lastTouched } : {}),
        ts: node.ts,
      })
    }
    arcRows.sort(compareArcs)
    const arcsTotal = arcRows.length
    for (const row of arcRows.slice(0, ARCS_CAP)) {
      arcs.push({
        id: row.id,
        name: row.name,
        status: row.status,
        ...(row.lastTouched ? { lastTouched: row.lastTouched } : {}),
      })
    }
    const arcsTruncated = arcsTotal > ARCS_CAP
```

- [ ] In the same file, change the daily rollup walk to attach the docId. Replace the `latestDailyRollup` declaration and assignment (lines 566 and 570) so the block reads:

```ts
    let latestDailyRollup: { date: string; body: string; docId: string } | undefined
    for (const doc of await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip)) {
      if (typeof doc.meta.date !== 'string') continue
      if (!latestDailyRollup || doc.meta.date > latestDailyRollup.date) {
        latestDailyRollup = { date: doc.meta.date, body: doc.body, docId: doc.meta.id }
      }
    }
```

- [ ] In the same file, change the `recentSummaries.push` call (line 597) to:

```ts
      recentSummaries.push({
        sessionId: session.sessionId,
        date: session.date,
        body: doc.body,
        docId: doc.meta.id,
      })
```

- [ ] In the same file, add `constitutionDocId: constitutionDoc.meta.id,` directly below the `constitution: constitutionDoc.body,` line in the `return` object, and add `arcsTruncated,` and `arcsTotal,` directly below the `arcs,` line.

- [ ] In `packages/core/src/context.ts`, add this import near the existing `@openreverie/memory` import:

```ts
import {
  ARCS_SECTION_CAP,
  capBody,
  capRows,
  CONSTITUTION_CAP,
  ENTITIES_SECTION_CAP,
  LATEST_DAILY_ROLLUP_CAP,
  PEOPLE_SECTION_CAP,
  REALMS_SECTION_CAP,
  REALM_FIRST_LINE_CAP,
  RECENT_INTENTIONS_SECTION_CAP,
  RECENT_SUMMARY_CAP,
} from './budget.js'
```

- [ ] In the same file, replace `constitutionSection`, `realmsSection`, `arcsSection`, `peopleSection`, `entitiesSection`, `recentIntentionsSection`, `latestDailyRollupSection`, and `recentSummariesSection` with:

```ts
function constitutionSection(context: SessionContext): string | undefined {
  const text = context.constitution.trim()
  if (text.length === 0) return undefined
  // capBody cuts from the start and, when it cuts, appends a marker naming
  // the constitution's docId. The docId is what lets the model fetch the
  // full text it is missing; a marker without it would tell the model
  // something exists and give it no way to reach it. This applies to the
  // chat prompt only; reflection's input is deliberately never capped.
  const capped = capBody(text, CONSTITUTION_CAP, context.constitutionDocId)
  return `## Constitution\n\n${capped.text}`
}

function realmsSection(context: SessionContext): string | undefined {
  if (context.realms.length === 0) return undefined
  const lines = context.realms.map((realm) => {
    const firstLine = realm.firstLine.trim()
    const clipped =
      firstLine.length > REALM_FIRST_LINE_CAP ? firstLine.slice(0, REALM_FIRST_LINE_CAP) : firstLine
    return clipped.length > 0 ? `- ${realm.name}: ${clipped}` : `- ${realm.name}`
  })
  const capped = capRows(lines, REALMS_SECTION_CAP)
  if (capped.shown < lines.length) {
    capped.rows.push(`(showing ${capped.shown} of ${lines.length} realms. Call list_realms for the rest.)`)
  }
  return `## Realms\n\n${capped.rows.join('\n')}`
}

function arcsSection(context: SessionContext): string | undefined {
  if (context.arcs.length === 0) return undefined
  const lines = context.arcs.map((arc) => {
    const details = [`status: ${arc.status}`]
    if (arc.lastTouched) details.push(`last touched: ${arc.lastTouched}`)
    return `- ${arc.name} (${details.join(', ')})`
  })
  const capped = capRows(lines, ARCS_SECTION_CAP)
  const rows = capped.rows
  if (context.arcsTruncated) {
    rows.push(
      `(showing ${capped.shown} of ${context.arcsTotal} active arcs, most recently touched first. Call list_arcs for the rest, including dormant and closed ones.)`,
    )
  }
  return `## Active arcs\n\n${rows.join('\n')}`
}

function peopleSection(context: SessionContext): string | undefined {
  if (context.people.length === 0) return undefined
  const lines = context.people.map(
    (person) => `- ${person.name} (${person.id}, ${person.hasPage ? 'has a page' : 'no page yet'})`,
  )
  const capped = capRows(lines, PEOPLE_SECTION_CAP)
  const rows = capped.rows
  if (context.peopleTruncated || capped.shown < lines.length) {
    // The marker names the tool that closes the gap. A marker that says
    // more exist without saying how to reach them tells the model something
    // exists and gives it no way to fetch it, which is the defect this
    // release exists to remove.
    rows.push(
      `(showing ${capped.shown} of ${context.peopleTotal} people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)`,
    )
  }
  return `## People\n\n${rows.join('\n')}`
}

function entitiesSection(context: SessionContext): string | undefined {
  if (context.entities.length === 0) return undefined
  const lines = context.entities.map((entity) => `- ${entity.name}`)
  const capped = capRows(lines, ENTITIES_SECTION_CAP)
  const rows = capped.rows
  if (context.entitiesTruncated || capped.shown < lines.length) {
    rows.push(
      `(showing ${capped.shown} of ${context.entitiesTotal} entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)`,
    )
  }
  return `## Entities\n\n${rows.join('\n')}`
}

function recentIntentionsSection(context: SessionContext): string | undefined {
  if (context.recentIntentions.length === 0) return undefined
  const lines = context.recentIntentions.map(
    (intention) => `- ${intention.date}: ${intention.text}`,
  )
  const capped = capRows(lines, RECENT_INTENTIONS_SECTION_CAP)
  const rows = capped.rows
  if (capped.shown < lines.length) {
    // Intentions have no listing tool and no fetch path of their own, so a
    // marker here can only state the count. The five-row cap keeps this
    // unreachable in practice; the character cap is a budget backstop.
    rows.push(`(showing ${capped.shown} of ${lines.length} recent intentions.)`)
  }
  return `## Recent intentions\n\n${rows.join('\n')}`
}

function latestDailyRollupSection(context: SessionContext): string | undefined {
  if (!context.latestDailyRollup) return undefined
  const body = context.latestDailyRollup.body.trim()
  const capped = capBody(body, LATEST_DAILY_ROLLUP_CAP, context.latestDailyRollup.docId)
  return `## Latest daily rollup\n\nDate: ${context.latestDailyRollup.date}\n\n${capped.text}`
}

function recentSummariesSection(context: SessionContext): string | undefined {
  if (context.recentSummaries.length === 0) return undefined
  const parts = context.recentSummaries.map((summary) => {
    const capped = capBody(summary.body.trim(), RECENT_SUMMARY_CAP, summary.docId)
    return `${summary.date}: ${capped.text}`
  })
  return `## Recent sessions\n\n${parts.join('\n\n')}`
}
```

- [ ] Run `npx vitest run packages/core/src/context.test.ts`. All seven new tests pass, and every existing test in the file still passes (short constitutions, realms, rollups, and summaries stay under their caps, and the people and entities markers still render the same wording).

- [ ] Falsify: in `constitutionSection`, replace `const capped = capBody(text, CONSTITUTION_CAP, context.constitutionDocId)` with `const capped = { text, truncated: false }`, rerun the constitution cap test, and confirm it fails on both the marker and the sentinel assertions while the under-budget test still passes. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Apply the prompt character budget to every capped section"`

---

## Task 16: Reflection receives the full constitution, never a capped one

Task 15 caps the constitution in the chat prompt. The reflection prompt must not share that cap. Reflection emits `out.constitutionUpdate` as a complete replacement body, which `applyReflection` writes over the constitution file; if the model were shown a truncated constitution and asked to produce the updated one, the tail it never saw would be deleted from disk. That is silent data loss in the one document meant to be the living record of the person.

`capBody` lives in `@openreverie/core`, and `memory` cannot import it upward, so the asymmetry is already guaranteed by the architecture today. The point of this task is to pin it with a test so a future refactor that inlines truncation into the reflection path cannot slip through. The test drives a full `endSession`, captures the reflection prompt from `FakeChatProvider.requests`, and asserts the whole 12,000-character constitution, sentinel included, is present with no truncation marker. Its falsification is the inverse of Task 15's: applying the cap to `buildReflectionContext` makes it fail.

**Files**

- Modify: `packages/memory/src/engine.ts` (a comment, no behavior change)
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Consumes: `buildReflectionContext` (private, `packages/memory/src/engine.ts:1105`), `FakeChatProvider.requests` (a `ChatRequest[]` recorded on every `complete` call), and `emptyReflectionOutput` / `fakeDeps` from `engine.test.ts`.

Produces: no new exported symbol. A comment at the reflection call site, and a test that pins the asymmetry.

**Steps**

- [ ] Add this `describe` block to the end of `packages/memory/src/engine.test.ts`:

```ts
describe('reflection receives the full constitution', () => {
  it('the reflection prompt carries the whole constitution body, sentinel included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-reflect-full-'))
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const sentinel = 'THE SENTINEL SENTENCE THAT MUST SURVIVE REFLECTION'
    const body = `${'p'.repeat(12000)}\n\n${sentinel}`
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body,
    })

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('p'.repeat(12000))
    expect(prompt).toContain(sentinel)
    expect(prompt).not.toContain('(truncated:')

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})
```

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts -t "the reflection prompt carries the whole constitution"`. It passes: this is a pinning test, and reflection is already uncapped.

- [ ] In `packages/memory/src/engine.ts`, add this comment in `buildReflectionContext`, directly above the `const constitutionDoc = await readDocument(this.paths.constitution)` line:

```ts
    // The constitution is passed through whole, never capped. Reflection
    // emits its constitution update as a complete replacement body, so a
    // model shown a truncated constitution and asked to produce the update
    // would rewrite only what it saw and delete the tail it never saw from
    // disk. capBody (in @openreverie/core) applies to assembleSystemPrompt
    // only and must never be applied here. See the test "the reflection
    // prompt carries the whole constitution body, sentinel included".
```

- [ ] Run `npx vitest run packages/memory/src/engine.test.ts -t "the reflection prompt carries the whole constitution"` again. Still passes.

- [ ] Falsify: in `buildReflectionContext`, replace `constitution: constitutionDoc.body` with `constitution: constitutionDoc.body.slice(0, 6000)`, rerun, and confirm the test fails on the sentinel assertion (and the `'p'.repeat(12000)` assertion). Restore the full body and rerun to green.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Pin that reflection receives the full constitution, never a capped one"`

---

## Task 17: The weekly rollup shelf

Weekly rollups are preloaded nowhere, so the model cannot know they exist. Preloading their content would recreate the unbounded-prompt problem the budget exists to fix: weekly rollups accumulate at 52 per year without bound. This task preloads a compact index instead: the newest `WEEKLY_INDEX_CAP = 12` weeks, each with its docId, plus the true total and the earliest week, and a count-and-range line for daily rollups. A listing of period names without docIds would reproduce the P1 defect for a third time, so every listed week carries its key.

**Files**

- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/context.test.ts`

**Interfaces**

Consumes (from Task 15): `SessionContext` with `latestDailyRollup.docId`, and the `ROLLUPS_AVAILABLE_CAP` and `capRows` from Task 14.

Produces (changes to `SessionContext` in `packages/memory/src/engine.ts`):

```ts
export interface SessionContext {
  // Newest first, at most WEEKLY_INDEX_CAP entries. The docId is mandatory:
  // a listing of period names without keys hands the model a shelf it
  // cannot take anything off.
  weeklyRollups: { week: string; docId: string }[]
  weeklyRollupsTotal: number
  earliestWeek?: string
  dailyRollups: { total: number; earliest?: string; latest?: string }
  // ... all other fields unchanged
}
```

**Steps**

- [ ] Add this `describe` block to the end of `packages/core/src/context.test.ts`:

```ts
describe('assembleSystemPrompt rollup shelf', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-context-shelf-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('preloads a compact index of weekly rollups, each with a docId, never the content', async () => {
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const ids: string[] = []
    for (let w = 19; w <= 33; w++) {
      const week = `2026-W${String(w).padStart(2, '0')}`
      const docId = newId('doc')
      ids.push(docId)
      await writeDocumentAtomic({
        path: join(paths.rollupsWeeklyDir, `${week}.md`),
        meta: { id: docId, kind: 'rollup_weekly', week },
        body: `Week ${w} content that must never be preloaded.\n`,
      })
    }
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: newId('doc'), date: '2026-08-10' },
      body: 'A steady day.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Rollups available')
    expect(prompt).toContain('2026-W33 (')
    expect(prompt).toContain('12 shown, 15 exist')
    expect(prompt).toContain('running back to 2026-W19.')
    expect(prompt).toContain('Daily rollups: 1 day covered')
    // The three oldest weeks are beyond the twelve-week index and appear
    // only in the count-and-range line, never as listable keys.
    expect(prompt).not.toContain('2026-W19 (')
    // Content is never preloaded.
    expect(prompt).not.toContain('Week 33 content')

    // Every listed docId appears in the prompt and resolves through
    // read_document.
    for (const id of ids.slice(ids.length - 12)) {
      expect(prompt).toContain(id)
      const doc = await engine.readDocumentById(id)
      expect(doc?.body).toContain('Week')
    }

    await engine.close()
  })
})
```

- [ ] Run `npx vitest run packages/core/src/context.test.ts -t "preloads a compact index"`. It must fail: `SessionContext` has no `weeklyRollups`, so the code does not compile.

- [ ] In `packages/memory/src/engine.ts`, add the constant next to `ARCS_CAP` (added in Task 15):

```ts
// How many of the most recent weekly rollups are listed in the prompt
// shelf, each with its docId. Twelve is a quarter, which covers "a month
// ago" without listing years. Older weeks are stated as a count and a
// range, not enumerated, which is what keeps the shelf inside its
// character budget.
const WEEKLY_INDEX_CAP = 12
```

- [ ] In the same file, add these four declarations to the `SessionContext` interface, after `recentSummaries`:

```ts
  // The newest WEEKLY_INDEX_CAP weekly rollups, newest first, each with the
  // docId the model needs to fetch it. Never the rollup bodies: those
  // accumulate at 52 per year without bound, and preloading them would
  // recreate the unbounded-prompt problem the budget exists to fix.
  weeklyRollups: { week: string; docId: string }[]
  // The true number of weekly rollups on disk, whether or not they fit in
  // the shelf, so the shelf can say how many exist beyond what it lists.
  weeklyRollupsTotal: number
  // The oldest weekly rollup week, for the "running back to" line. Absent
  // when there are no weekly rollups.
  earliestWeek?: string
  // Count and range of daily rollups, computed for free during the same
  // walk that finds the newest one. earliest and latest are absent when
  // there are no daily rollups.
  dailyRollups: { total: number; earliest?: string; latest?: string }
```

- [ ] In the same file, replace the daily rollup walk (the `latestDailyRollup` block written in Task 15) with:

```ts
    let latestDailyRollup: { date: string; body: string; docId: string } | undefined
    let dailyTotal = 0
    let dailyEarliest: string | undefined
    let dailyLatest: string | undefined
    for (const doc of await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip)) {
      if (typeof doc.meta.date !== 'string') continue
      dailyTotal += 1
      if (dailyEarliest === undefined || doc.meta.date < dailyEarliest) dailyEarliest = doc.meta.date
      if (dailyLatest === undefined || doc.meta.date > dailyLatest) dailyLatest = doc.meta.date
      if (!latestDailyRollup || doc.meta.date > latestDailyRollup.date) {
        latestDailyRollup = { date: doc.meta.date, body: doc.body, docId: doc.meta.id }
      }
    }
    const dailyRollups = {
      total: dailyTotal,
      ...(dailyEarliest !== undefined ? { earliest: dailyEarliest } : {}),
      ...(dailyLatest !== undefined ? { latest: dailyLatest } : {}),
    }

    // The weekly shelf. Only the id-bearing index is preloaded, never the
    // bodies. One directory read plus a frontmatter parse per weekly file,
    // on the same order as the daily walk already performed beside it.
    const weeklyDocs = await listDocuments(this.paths.rollupsWeeklyDir, this.onDocSkip)
    const weeklyRollups: SessionContext['weeklyRollups'] = []
    let weeklyRollupsTotal = 0
    let earliestWeek: string | undefined
    for (const doc of weeklyDocs) {
      if (typeof doc.meta.week !== 'string') continue
      weeklyRollupsTotal += 1
      if (earliestWeek === undefined || doc.meta.week < earliestWeek) {
        earliestWeek = doc.meta.week
      }
      weeklyRollups.push({ week: doc.meta.week, docId: doc.meta.id })
    }
    // ISO week ids sort lexicographically in chronological order, so a
    // descending sort puts the newest week first.
    weeklyRollups.sort((a, b) => (a.week > b.week ? -1 : 1))
```

- [ ] In the same file, add these four fields to the `return` object, after the `recentSummaries` line:

```ts
      weeklyRollups: weeklyRollups.slice(0, WEEKLY_INDEX_CAP),
      weeklyRollupsTotal,
      ...(earliestWeek !== undefined ? { earliestWeek } : {}),
      dailyRollups,
```

- [ ] In `packages/core/src/context.ts`, add `ROLLUPS_AVAILABLE_CAP` to the `budget.js` import added in Task 15.

- [ ] In the same file, add this function next to `latestDailyRollupSection`, and insert `rollupsAvailableSection(context),` into the `sections` array directly after `latestDailyRollupSection(context),`:

```ts
function rollupsAvailableSection(context: SessionContext): string | undefined {
  if (context.weeklyRollupsTotal === 0) return undefined
  const lines: string[] = []
  lines.push(
    `Weekly rollups, most recent first: ${context.weeklyRollups
      .map((r) => `${r.week} (${r.docId})`)
      .join(', ')}`,
  )
  if (context.weeklyRollupsTotal > context.weeklyRollups.length) {
    lines.push(
      `${context.weeklyRollups.length} shown, ${context.weeklyRollupsTotal} exist` +
        (context.earliestWeek !== undefined ? `, running back to ${context.earliestWeek}.` : '.'),
    )
  }
  if (context.dailyRollups.total > 0) {
    const range =
      context.dailyRollups.earliest !== undefined && context.dailyRollups.latest !== undefined
        ? `, from ${context.dailyRollups.earliest} to ${context.dailyRollups.latest}`
        : ''
    lines.push(
      `Daily rollups: ${context.dailyRollups.total} days covered${range}. The newest is shown above in full.`,
    )
  }
  lines.push(
    'Read any of these with read_document, or find one by period with search_memory using kinds and a date range.',
  )
  const capped = capRows(lines, ROLLUPS_AVAILABLE_CAP)
  return `## Rollups available\n\n${capped.rows.join('\n')}`
}
```

- [ ] Run `npx vitest run packages/core/src/context.test.ts`. The new test passes, and the existing tests still pass (none of their fixtures contain weekly rollups, so the shelf is omitted there).

- [ ] Falsify: change the shelf's first line to `Weekly rollups, most recent first: ${context.weeklyRollups.map((r) => r.week).join(', ')}` (dropping the docIds), rerun, and confirm the test fails on the `expect(prompt).toContain(id)` assertion for every listed id. Restore.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Preload a compact weekly rollup index with docIds, never the bodies"`

---

## Task 18: The DocKind wiring test (P8)

The standing rule: every document type must declare how the model reads it, or it is a defect, not a gap. The plan's File Structure names `packages/core/src/docKinds.test.ts` as the enforcement mechanism but no task creates it. This task adds it, plus the one change that makes it real: `DocKind` becomes a runtime const array (`DOC_KINDS`) so the test can enumerate the union instead of hardcoding a list that drifts.

The test asserts, table-driven over `DOC_KINDS`, that every kind is wired through all of its touchpoints: the `DocKind` union itself (enumerated via `DOC_KINDS`), `walkAllDocuments` and the web API (via `listPublicDocuments` and `getPublicDocument`), the hand-maintained kinds description in `tools.ts`, `documentDateSpan` (a span or null, never undefined), and the prompt budget (a positive cap that is part of `SECTION_CAPS`).

**Files**

- Modify: `packages/memory/src/sqlite.ts`
- Create: `packages/core/src/docKinds.test.ts`

**Interfaces**

Produces:

```ts
// packages/memory/src/sqlite.ts
export const DOC_KINDS: readonly [
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
]
export type DocKind = (typeof DOC_KINDS)[number]
```

`DocKind` stays the same string-literal union, so no downstream code changes. `DOC_KINDS` is what the test iterates.

**Steps**

- [ ] Create `packages/core/src/docKinds.test.ts` with exactly this content:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOC_KINDS,
  type DocKind,
  documentDateSpan,
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  memoryPaths,
  type MemoryPaths,
  newId,
  SessionStore,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARCS_SECTION_CAP,
  CONSTITUTION_CAP,
  ENTITIES_SECTION_CAP,
  LATEST_DAILY_ROLLUP_CAP,
  PEOPLE_SECTION_CAP,
  REALMS_SECTION_CAP,
  RECENT_SUMMARIES_SECTION_CAP,
  ROLLUPS_AVAILABLE_CAP,
  SECTION_CAPS,
} from './budget.js'
import { toolDefinitions } from './tools.js'

// Every kind maps to the character cap of the prompt section where it
// appears. Declared as Record<DocKind, number>, so the moment a kind is
// added to DocKind without a cap this stops compiling, and the values are
// asserted below to actually be part of SECTION_CAPS, so a cap that exists
// in name but not in the budget fails too.
const PROMPT_SECTION_CAP: Record<DocKind, number> = {
  constitution: CONSTITUTION_CAP,
  realm: REALMS_SECTION_CAP,
  arc: ARCS_SECTION_CAP,
  summary: RECENT_SUMMARIES_SECTION_CAP,
  rollup_daily: LATEST_DAILY_ROLLUP_CAP,
  rollup_weekly: ROLLUPS_AVAILABLE_CAP,
  person: PEOPLE_SECTION_CAP,
}

function fakeDeps(): EngineDeps {
  return {
    chat: new FakeChatProvider([]),
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
  }
}

describe('DocKind wiring (P8)', () => {
  it('lists every DocKind in the search_memory kinds description', () => {
    const defs = toolDefinitions()
    const search = defs.find((d) => d.name === 'search_memory')
    if (!search) throw new Error('expected a search_memory tool definition')
    const description = (
      search.parameters as { properties: { kinds: { description: string } } }
    ).properties.kinds.description
    for (const kind of DOC_KINDS) {
      expect(description).toContain(kind)
    }
  })

  it('documentDateSpan returns a span or null, never undefined, for every kind', () => {
    for (const kind of DOC_KINDS) {
      expect(documentDateSpan(kind, { id: 'doc_x' })).not.toBeUndefined()
    }
  })

  it('every kind has a positive prompt cap that is part of the budget', () => {
    for (const kind of DOC_KINDS) {
      const cap = PROMPT_SECTION_CAP[kind]
      expect(cap).toBeGreaterThan(0)
      expect(SECTION_CAPS).toContain(cap)
    }
  })
})

describe('DocKind indexing and web API wiring', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-doc-kinds-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('walks and serves every kind through the public document API', async () => {
    const seeded: { kind: DocKind; docId: string }[] = []

    const constitutionId = newId('doc')
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: constitutionId },
      body: 'The constitution body.\n',
    })
    seeded.push({ kind: 'constitution', docId: constitutionId })

    const realmId = newId('doc')
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'fitness.md'),
      meta: { id: realmId, name: 'Fitness' },
      body: 'Running and lifting.\n',
    })
    seeded.push({ kind: 'realm', docId: realmId })

    const arcId = newId('doc')
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: arcId, name: 'Marathon', status: 'active' },
      body: 'Training for the fall marathon.\n',
    })
    seeded.push({ kind: 'arc', docId: arcId })

    const personId = newId('doc')
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'priya.md'),
      meta: { id: personId, name: 'Priya' },
      body: 'Priya runs the reading group.\n',
    })
    seeded.push({ kind: 'person', docId: personId })

    const dailyId = newId('doc')
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: dailyId, date: '2026-08-10' },
      body: 'A steady day.\n',
    })
    seeded.push({ kind: 'rollup_daily', docId: dailyId })

    const weeklyId = newId('doc')
    await writeDocumentAtomic({
      path: join(paths.rollupsWeeklyDir, '2026-W33.md'),
      meta: { id: weeklyId, week: '2026-W33' },
      body: 'The week in brief.\n',
    })
    seeded.push({ kind: 'rollup_weekly', docId: weeklyId })

    const store = await SessionStore.start(paths, new Date('2026-08-10T00:00:00.000Z'))
    const summaryId = newId('doc')
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: summaryId },
      body: 'A session summary.\n',
    })
    seeded.push({ kind: 'summary', docId: summaryId })

    expect(seeded.map((s) => s.kind).sort()).toEqual([...DOC_KINDS].sort())

    const engine = await MemoryEngine.open(dir, fakeDeps(), { maintenance: false })

    const rows = await engine.listPublicDocuments()
    const byDocId = new Map(rows.map((row) => [row.docId, row]))
    for (const { kind, docId } of seeded) {
      expect(byDocId.get(docId)?.kind).toBe(kind)
      const full = await engine.getPublicDocument(docId)
      expect(full?.kind).toBe(kind)
      expect(full?.body.length).toBeGreaterThan(0)
    }

    await engine.close()
  })
})
```

- [ ] Run `npx vitest run packages/core/src/docKinds.test.ts`. It must fail because `DOC_KINDS` is not exported from `@openreverie/memory`.

- [ ] In `packages/memory/src/sqlite.ts`, replace the `DocKind` type (lines 12 to 19) with:

```ts
// The closed set of document kinds, kept as a const array so the
// table-driven wiring test (packages/core/src/docKinds.test.ts) can
// enumerate the union at runtime. Adding a kind here and wiring none of its
// touchpoints makes that test fail, which is the enforcement mechanism for
// the P8 rule: every document type must declare how the model reads it.
export const DOC_KINDS = [
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
] as const

export type DocKind = (typeof DOC_KINDS)[number]
```

- [ ] Run `npx vitest run packages/core/src/docKinds.test.ts`. All four tests pass.

- [ ] Falsify: add `'journal'` to the `DOC_KINDS` array, rerun, and confirm the test fails: the kinds-description test no longer finds it in `search_memory`, the `documentDateSpan` test returns undefined for it (the switch has no case), and `PROMPT_SECTION_CAP` has no entry for it. Remove `'journal'` and rerun to green.

- [ ] Run `pnpm test`, `pnpm build`, `pnpm lint`. All green.

- [ ] Commit: `git add -A && git commit -m "Add the table-driven DocKind wiring test and a runtime DOC_KINDS list"`

---

## Task 19: Final verification

Run the whole suite from a clean state to confirm nothing regressed across the release.

- [ ] Run `pnpm lint`. It must exit 0.

- [ ] Run `pnpm build`. It must exit 0.

- [ ] Run `pnpm test`. The whole suite passes.
