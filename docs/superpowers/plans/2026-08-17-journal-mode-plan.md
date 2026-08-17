# Journal Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give journaling a first-class home in reverie: a `journal/` directory of entries in the person's own words, a `journaling.md` protocol document that configures how each session runs, and the safety and honesty rules the six writing methods each require.

**Architecture:** `@openreverie/memory` gains the durable primitives (paths, document kind, entry file naming and frontmatter, deterministic body assembly, the `journaling.md` read/write helper, the gated write inside `_doEndSession`). `@openreverie/core` gains the prompt content (the journaling protocol section, the six formats' prompt sequences and evidence statements, the two new tools) that only runs when a session's mode is `journal`. `@openreverie/web` gains a read-only journal tab that reuses the existing public-document HTTP surface.

**Tech Stack:** TypeScript 5.9 (NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Node 22, pnpm workspaces, vitest 3, zod 4, React 19 + Vite 6 for the web package, biome 2 for lint and format.

**Spec:** docs/superpowers/specs/2026-08-16-journal-mode-design.md

**Depends on:** the time plan (`docs/superpowers/plans/2026-08-17-time-as-first-class-plan.md`) and the modes plan (`docs/superpowers/plans/2026-08-17-modes-profile-settings-plan.md`) must both be complete first. This plan relies on event/record time, `profile.md`, the `journal` mode, the `synthetic` field on `TranscriptLine`, and mode persistence to `session.json`. As of the writing of this plan, the modes plan file exists but its task list stops after Task 5 (profile and reflection writes); the mode catalogue, `set_mode`, `session.json` persistence, `AgentSession` mode plumbing, the CLI, the server endpoints, and the web nav rail and settings pane are recorded only in that plan's File Structure table as commitments, not yet as finished task bodies. Every task below that touches one of those not-yet-finished areas says so explicitly and gives a `grep` command to confirm the real shape before writing code against it, because by the time this plan actually runs, the modes plan will be finished and may differ in a method name or two from what its File Structure table currently promises.

## Global Constraints

- Package dependencies are downward only: `cli` -> `core` -> `memory` -> `providers`, and `server` -> `core` -> `memory` -> `providers`. `cli` and `server` are sibling outer interfaces. Never import upward or sideways.
- `web` communicates with `server` through HTTP only and never imports a runtime engine package.
- Truth lives in the user's memory folder: markdown prose files plus the append-only `graph.jsonl`. SQLite is a derived index and must always be rebuildable from the folder.
- Transcripts are append-only. Never modified, never deleted by code.
- Prose file writes are atomic: write a temp file, then rename. Graph log writes are single-line appends.
- All structured LLM output is validated with zod schemas at the boundary.
- TDD for deterministic logic: write the failing test first, watch it fail for the stated reason, then write the implementation.
- LLM-dependent behaviour is tested with fixture transcripts and schema assertions, never golden text.
- Both safety modes (companion and firewall) exist by design. Never remove, weaken, or bypass them, and never make crisis behaviour "smarter" without explicit human sign-off. Journal mode never adjusts the safety stance, only style within it.
- Evidence claims about each journaling method must be stated as the spec states them: accurately, and never overstated. A method with thin or absent evidence must be described that way in the product, not borrowed weight from a better-studied method.
- Never write code that could send memory folder contents anywhere except the user's configured model provider. No telemetry, no analytics.
- No em dashes anywhere in prose, comments, error messages, CLI copy, or commit messages. Use commas, periods, colons, or parentheses.
- Avoid AI-typical tropes in all copy: "delve", "seamlessly", "robust", "leverage", "streamline", "empower", "unlock", "supercharge", and emoji in headings or lists.
- The README's Status section must reflect reality at all times.
- A reviewer runs the tests, the build, and the lint itself. An implementer's report is not evidence.
- Falsify, do not read: for every test below whose step says "falsify by X," actually make change X, watch the named test fail for the stated reason, then revert it before moving on.
- The build must compile and the full test suite must pass after every task. Never leave the build broken for a later task to fix.

## Locating code in this repository

This plan was written by reading the codebase as it exists today, before the time plan or the modes plan have landed. Both of those plans move and rename things this plan then builds on (`sessionContext`'s signature, `assembleSystemPrompt`'s signature, `TranscriptLine`, `AgentSession`'s tool dispatch loop, `ToolDeps` being replaced entirely). Line numbers quoted anywhere below are therefore hints about where in a file to look today, not guarantees about where the target sits once two other plans have edited that same file. Every step that touches such a location gives a `grep` command as the actual instruction; run it, read the surrounding code, and adapt the shown edit to what is actually there. Where the exact replacement text a step gives does not match what `grep` turns up, that is expected, not a sign the plan is wrong: find the equivalent spot by name and apply the same intent.

Two commands recur throughout:

| Purpose | Command |
| --- | --- |
| One test file | `pnpm vitest run packages/memory/src/journal.test.ts` (substitute the path) |
| One test by name | `pnpm vitest run packages/memory/src/journal.test.ts -t 'name fragment'` |
| Full test suite | `pnpm test` |
| Build every package | `pnpm build` |
| Lint and format check | `pnpm lint` |
| Lint one file | `pnpm exec biome check packages/memory/src/journal.ts` (substitute the path) |

Run every command from the repository root: `/Users/vishal/work/personal/second-mind`.

---

## File Structure

### Created

| Path | Responsibility |
| --- | --- |
| `packages/memory/src/journal.ts` | Journal entry primitives: `JournalMethod`, entry file naming, frontmatter shape, `assembleJournalBody`, `writeJournalEntry`. The `journaling.md` protocol helpers: `JOURNALING_PROTOCOL_ABSENT`, `readJournalingProtocol`, `readJournalingProtocolIfPresent`, `writeJournalingProtocol`. |
| `packages/memory/src/journal.test.ts` | Tests for every function above. |
| `packages/core/src/journaling.ts` | The static prompt content owned by this spec: the six formats' evidence statements and prompt sequences, the first-time setup conversation guidance, the cadence disclosure text, the agent activity level explanation, the per-method safety gate text, and `buildJournalModeParagraph(journalingProtocol: string): string`, the paragraph the mode catalogue's `journal` entry renders. |
| `packages/core/src/journaling.test.ts` | Content-presence tests: every evidence statement, every safety gate, the cadence disclosure, the expressive-writing crisis check, all present and none overstated. |

### Modified

| Path | Change |
| --- | --- |
| `packages/memory/src/paths.ts` | `MemoryPaths` gains `journalDir` and `journaling`. `ensureMemoryTree` creates `journalDir`, does not seed `journaling`. |
| `packages/memory/src/sqlite.ts` | `DocKind` gains `'journal'` and `'journaling'`. |
| `packages/memory/src/transcripts.ts` | `SessionMeta` (or whatever the modes plan named the `session.json` shape) gains `journalMethod?: string`. |
| `packages/memory/src/engine.ts` | `walkAllDocuments` walks `journal/` and reads `journaling.md`. `PublicDocumentRow` gains optional `method` and `entryDate`. `documentUpdatedAt` reads `recordedAt` too. `setSessionJournalMethod`, `updateJournalingProtocol`. `_doEndSession` gains the gated journal write. |
| `packages/memory/src/engine.test.ts` | Tests for all of the above, including the crash path. |
| `packages/memory/src/reflection.ts` | `ReflectionOutput` and `reflectionOutputSchema` gain `journalingUpdate`. `applyReflection` writes it. `buildReflectionContext`/`ReflectionContext` gains the current journaling protocol or its absence. |
| `packages/memory/src/reflection.test.ts` | Schema and fixture tests for `journalingUpdate`. |
| `packages/core/src/context.ts` | `sessionContext` call site passes the session's mode. `journalingProtocolSection` added, inserted after `constitutionSection`. |
| `packages/core/src/context.test.ts` | Tests for the new section, including the absent-protocol sentinel and the first-session carve-out. |
| `packages/core/src/tools.ts` | `search_memory`'s `kinds` description gains `journal, journaling`. Two new tool definitions and dispatch cases: `declare_journal_method`, `update_journaling_protocol`. |
| `packages/core/src/tools.test.ts` | Tests for both new tools. |
| `packages/core/src/agent.ts` | After a successful `update_journaling_protocol` dispatch, call `refreshSystemPrompt()`. |
| `packages/core/src/agent.test.ts` | Test for the reassembly trigger. |
| `packages/core/src/personas.test.ts` | The six-combination safety invariant test specific to journal mode. |
| `packages/server/src/app.ts` | `documentKindSchema` gains `journal`, `journaling`. `publicDocumentRowSchema` gains optional `method`, `entryDate`. |
| `packages/server/src/app.test.ts` | Round-trip test for the two new fields and the two new kinds. |
| `packages/web/src/api.ts` | Same schema widening as the server, client side. |
| `packages/web/src/api.test.ts` | Schema tests. |
| `packages/web/src/views/Journal.tsx` | Replaces the placeholder the modes plan created with the real entry list and entry view. |
| `packages/web/src/views/journal.css` | Styling for the journal tab, on the Library tab's pattern. |
| `packages/web/src/views/journal.test.tsx` | List, view, sort order, and absence-of-edit tests. |
| `packages/web/src/views/Library.tsx` | `KIND_LABELS` gains `journal` and `journaling` entries. |
| `packages/web/src/views/library.test.tsx` | Confirms a journal document still renders through the generic Record tab too. |

---

## Task 1: `journalDir` and `journaling` on `MemoryPaths`

**Files**
- Modify: `packages/memory/src/paths.ts`
- Create: `packages/memory/src/paths.test.ts`

**Interfaces**

Consumes: nothing new. `memoryPaths`, `ensureMemoryTree`, `MemoryPaths` already exist. By the time this task runs, the time plan has already added a `profile: string` field to `MemoryPaths` and a matching line to `memoryPaths()` and to `ensureMemoryTree`'s seeding. Confirm that first:

```bash
grep -n "profile" packages/memory/src/paths.ts
```

Expected: a `profile: string` field in the `MemoryPaths` interface and a `profile: join(root, 'profile.md')` line in `memoryPaths()`. If this is missing, the time plan has not landed; stop and report it rather than adding journal fields to a file the time plan has not yet touched.

Produces, consumed by every later task in this plan:

```ts
// packages/memory/src/paths.ts
export interface MemoryPaths {
  root: string
  constitution: string
  profile: string
  journalDir: string
  journaling: string
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

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/paths.test.ts`:

```ts
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMemoryTree, memoryPaths } from './paths.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('journal paths', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-paths-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('memoryPaths joins journalDir and journaling under the root', () => {
    const paths = memoryPaths(dir)
    expect(paths.journalDir).toBe(join(dir, 'journal'))
    expect(paths.journaling).toBe(join(dir, 'journaling.md'))
  })

  it('ensureMemoryTree creates the journal directory', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    expect(await pathExists(paths.journalDir)).toBe(true)
  })

  it('ensureMemoryTree does not seed journaling.md, unlike the constitution', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    expect(await pathExists(paths.constitution)).toBe(true)
    expect(await pathExists(paths.journaling)).toBe(false)
  })

  it('running ensureMemoryTree twice never creates journaling.md on its own', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await ensureMemoryTree(paths)
    expect(await pathExists(paths.journaling)).toBe(false)
  })
})
```

- [ ] **Step 2: Run and read the failure**

```bash
pnpm vitest run packages/memory/src/paths.test.ts
```

Expected: `TypeError: undefined is not an object` or similar, since `paths.journalDir` does not exist yet on the object `memoryPaths` returns.

- [ ] **Step 3: Add the fields**

Open `packages/memory/src/paths.ts`. In the `MemoryPaths` interface, add two fields (placed near `constitution`, since both are root-level files/dirs the memory folder owns, matching how `profile` was added by the time plan):

```ts
export interface MemoryPaths {
  root: string
  constitution: string
  profile: string
  journalDir: string
  journaling: string
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

In `memoryPaths()`, add the matching two lines:

```ts
export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    constitution: join(root, 'constitution.md'),
    profile: join(root, 'profile.md'),
    journalDir: join(root, 'journal'),
    journaling: join(root, 'journaling.md'),
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

(The `profile: join(root, 'profile.md')` line above already exists from the time plan; do not duplicate it, just confirm it is there and add the two `journal*` lines around it.)

In `ensureMemoryTree`, add `paths.journalDir` to the array of directories that get created exactly like the other five directories. Do **not** add any seeding logic for `paths.journaling`: its absence is what tells the companion a first-time setup conversation is owed (spec section 4.3), and seeding it here would silently defeat that.

```ts
export async function ensureMemoryTree(paths: MemoryPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true })
  for (const dir of [
    paths.realmsDir,
    paths.arcsDir,
    paths.peopleDir,
    paths.sessionsDir,
    paths.rollupsDailyDir,
    paths.rollupsWeeklyDir,
    paths.journalDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }
  // ...rest of the function (constitution seeding, profile seeding from the
  // time plan, .gitignore seeding) is unchanged.
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
pnpm vitest run packages/memory/src/paths.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Build and lint**

```bash
pnpm build && pnpm lint
```

Expected: both succeed. (`pnpm build` will fail if the time plan has not actually landed `profile`; if so, stop, this plan cannot proceed.)

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/paths.ts packages/memory/src/paths.test.ts
git commit -m "Add journalDir and journaling to MemoryPaths

journal/ holds entries only, created like every other memory
subdirectory. journaling.md is deliberately not seeded: its absence on
disk is what marks a memory folder that has never journaled before."
```

---

## Task 2: `DocKind` gains `journal`/`journaling`, `walkAllDocuments` walks them, `search_memory` documents them

**Files**
- Modify: `packages/memory/src/sqlite.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Interfaces**

Consumes: `MemoryPaths.journalDir`/`journaling` (Task 1), `listDocuments`, `readDocument` (existing).

Produces, consumed by Task 3 onward and by the web tasks:

```ts
// packages/memory/src/sqlite.ts
export type DocKind =
  | 'constitution'
  | 'realm'
  | 'arc'
  | 'summary'
  | 'rollup_daily'
  | 'rollup_weekly'
  | 'person'
  | 'journal'
  | 'journaling'
```

```ts
// packages/memory/src/engine.ts
export interface PublicDocumentRow {
  docId: string
  kind: DocKind
  title: string
  updatedAt: string
  readOnly: true
  method?: string
  entryDate?: string
}
```

- [ ] **Step 1: Write the failing test for `DocKind` and `walkAllDocuments`**

Add to `packages/memory/src/engine.test.ts`, inside the top-level `describe('MemoryEngine', ...)` block (find its closing brace with `grep -n "^describe('MemoryEngine'" -A2 packages/memory/src/engine.test.ts` and add a sibling `describe` before that closing brace):

```ts
  describe('journal document kind', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journal-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('walkAllDocuments (via listPublicDocuments) includes a hand-written journal entry', async () => {
      await writeDocumentAtomic({
        path: join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
        meta: {
          id: 'doc_01JZZZ',
          kind: 'journal',
          method: 'gratitude',
          mode: 'journal',
          entryDate: '2026-08-16',
          recordedAt: '2026-08-16T21:04:00.000Z',
          session: 'session_01JAAA',
        },
        body: 'Grateful for a quiet morning.\n',
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      const journalRow = rows.find((row) => row.kind === 'journal')
      expect(journalRow?.docId).toBe('doc_01JZZZ')
      expect(journalRow?.method).toBe('gratitude')
      expect(journalRow?.entryDate).toBe('2026-08-16')
      await engine.close()
    })

    it('walkAllDocuments includes journaling.md, once it exists, with kind journaling', async () => {
      await writeDocumentAtomic({
        path: paths.journaling,
        meta: { id: 'doc_01JZZZ2', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
        body: 'Gratitude, three times a week.\n',
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journaling')?.docId).toBe('doc_01JZZZ2')
      await engine.close()
    })

    it('walkAllDocuments does not fail when journaling.md is absent', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journaling')).toBeUndefined()
      await engine.close()
    })

    it('a journal row without a name-worthy title reports method and entryDate as its own fields, not folded into title', async () => {
      await writeDocumentAtomic({
        path: join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
        meta: {
          id: 'doc_01JZZZ',
          kind: 'journal',
          method: 'examen',
          mode: 'journal',
          entryDate: '2026-08-16',
          recordedAt: '2026-08-16T21:04:00.000Z',
          session: 'session_01JAAA',
        },
        body: 'Right now, tired but okay.\n',
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const doc = await engine.getPublicDocument('doc_01JZZZ')
      expect(doc?.method).toBe('examen')
      expect(doc?.entryDate).toBe('2026-08-16')
      await engine.close()
    })
  })
```

Confirm the file already imports `writeDocumentAtomic` from `./documents.js`; if not, add it to the existing import.

- [ ] **Step 2: Run and read the failure**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'journal document kind'
```

Expected: TypeScript fails to compile (`Type '"journal"' is not assignable to type 'DocKind'`), or at runtime `journalRow` is `undefined` because `walkAllDocuments` never looked in `journal/`.

- [ ] **Step 3: Widen `DocKind`**

In `packages/memory/src/sqlite.ts`:

```ts
export type DocKind =
  | 'constitution'
  | 'realm'
  | 'arc'
  | 'summary'
  | 'rollup_daily'
  | 'rollup_weekly'
  | 'person'
  | 'journal'
  | 'journaling'
```

- [ ] **Step 4: Wire `walkAllDocuments`**

Find the method:

```bash
grep -n "private async walkAllDocuments" packages/memory/src/engine.ts
```

Add two blocks inside it, after the existing `rollupsWeeklyDir` loop and before the session-directory walk:

```ts
    for (const doc of await listDocuments(this.paths.journalDir, this.onDocSkip)) {
      result.push({ doc, kind: 'journal' })
    }
    try {
      result.push({ doc: await readDocument(this.paths.journaling), kind: 'journaling' })
    } catch {
      // journaling.md does not exist yet: nobody has journaled in this
      // memory folder. Not an error, just nothing to index.
    }
```

- [ ] **Step 5: Widen `PublicDocumentRow` and populate the two new fields**

Find the interface and the row builder:

```bash
grep -n "export interface PublicDocumentRow\|^function publicDocumentRow\|^function documentUpdatedAt" packages/memory/src/engine.ts
```

Widen the interface:

```ts
export interface PublicDocumentRow {
  docId: string
  kind: DocKind
  title: string
  updatedAt: string
  readOnly: true
  method?: string
  entryDate?: string
}
```

Update `publicDocumentRow` to populate the two new fields only for a journal entry, and leave every other kind producing exactly what it produces today:

```ts
function publicDocumentRow(doc: Document, kind: DocKind): PublicDocumentRow {
  const base: PublicDocumentRow = {
    docId: doc.meta.id,
    kind,
    title: documentTitle(doc),
    updatedAt: documentUpdatedAt(doc),
    readOnly: true,
  }
  if (kind !== 'journal') return base
  return {
    ...base,
    ...(typeof doc.meta.method === 'string' ? { method: doc.meta.method } : {}),
    ...(typeof doc.meta.entryDate === 'string' ? { entryDate: doc.meta.entryDate } : {}),
  }
}
```

`documentUpdatedAt` currently checks `['updated', 'date', 'week']` in order and falls back to a value derived from the id. A journal entry's frontmatter has none of those three keys, only `recordedAt`, so it would silently fall through to the id-derived fallback. Add `recordedAt` to the list (not `entryDate`: `updatedAt` means "when was this document last written," which is record time, and `recordedAt` is exactly that field; `entryDate` is event time and stays a separate field on the row, never folded into `updatedAt`):

```ts
function documentUpdatedAt(doc: Document): string {
  for (const key of ['updated', 'date', 'week', 'recordedAt']) {
    const value = doc.meta[key]
    if (typeof value === 'string') return value
  }
  return isoFromId(doc.meta.id, '1970-01-01T00:00:00.000Z')
}
```

- [ ] **Step 6: Run and confirm the engine tests pass**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'journal document kind'
```

Expected: 4 passed.

- [ ] **Step 7: Document the two new kinds in `search_memory`**

```bash
grep -n "rollup_daily, rollup_weekly, person" packages/core/src/tools.ts
```

Change the description string:

```ts
          kinds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict results to these document kinds. Valid values: constitution, realm, arc, summary, ' +
              'rollup_daily, rollup_weekly, person, journal, journaling. Omit to search across all kinds.',
          },
```

- [ ] **Step 8: Add the failing-then-passing test for the description**

Add to `packages/core/src/tools.test.ts` (find an existing `describe('search_memory'` or `describe('toolDefinitions'` block with `grep -n "toolDefinitions()" packages/core/src/tools.test.ts | head -5` and add this near the other tool-definition assertions):

```ts
  it('search_memory documents journal and journaling as valid kinds', () => {
    const definitions = toolDefinitions()
    const searchMemory = definitions.find((tool) => tool.name === 'search_memory')
    const description = JSON.stringify(searchMemory?.parameters)
    expect(description).toContain('journal, journaling')
  })
```

- [ ] **Step 9: Run and confirm**

```bash
pnpm vitest run packages/core/src/tools.test.ts -t 'documents journal and journaling'
```

Expected: 1 passed.

- [ ] **Step 10: Build, full test suite, lint**

```bash
pnpm build && pnpm test && pnpm lint
```

- [ ] **Step 11: Commit**

```bash
git add packages/memory/src/sqlite.ts packages/memory/src/engine.ts packages/memory/src/engine.test.ts packages/core/src/tools.ts packages/core/src/tools.test.ts
git commit -m "Index journal entries and journaling.md as their own document kinds

DocKind gains journal and journaling. walkAllDocuments walks journal/
and reads journaling.md when it exists, so both are reachable through
search_memory and the public document HTTP surface once that surface
is wired. PublicDocumentRow carries method and entryDate for a journal
row, since neither is derivable from title or updatedAt alone."
```

---

## Task 3: Journal entry filename and frontmatter, entryDate and recordedAt independently settable

**Files**
- Create: `packages/memory/src/journal.ts`
- Create: `packages/memory/src/journal.test.ts`

**Interfaces**

Consumes: `MemoryPaths.journalDir` (Task 1), `newId`, `writeDocumentAtomic`, `readDocument`, `Document` (`packages/memory/src/documents.ts`, unchanged).

Produces, consumed by Task 4 onward:

```ts
// packages/memory/src/journal.ts
export type JournalMethod =
  | 'expressive_writing'
  | 'gratitude'
  | 'examen'
  | 'thought_record'
  | 'morning_pages'
  | 'open'

export interface JournalEntryInput {
  method: JournalMethod
  entryDate: string   // YYYY-MM-DD, event time
  recordedAt: string  // ISO instant, record time
  session: string
  body: string
}

export function journalEntryFileName(entryDate: string, id: string): string
export function journalEntryPath(paths: MemoryPaths, entryDate: string, id: string): string
export function writeJournalEntry(paths: MemoryPaths, input: JournalEntryInput): Promise<Document>
```

`writeJournalEntry` mints its own id (`newId('doc')`), builds the path from it and `entryDate`, and writes through `writeDocumentAtomic`. It is the one place a journal entry file gets created; Task 6's gated write in `_doEndSession` calls it rather than constructing the frontmatter object by hand a second time.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/journal.test.ts`:

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDocument } from './documents.js'
import { journalEntryFileName, journalEntryPath, writeJournalEntry } from './journal.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

describe('journal entry filename and frontmatter', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-journal-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('journalEntryFileName is entryDate, a dash, the doc id, and .md', () => {
    expect(journalEntryFileName('2026-08-16', 'doc_01JZZZ')).toBe('2026-08-16-doc_01JZZZ.md')
  })

  it('journalEntryPath joins the filename under journalDir', () => {
    expect(journalEntryPath(paths, '2026-08-16', 'doc_01JZZZ')).toBe(
      join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
    )
  })

  it('two entries written on the same entryDate get distinct filenames and both sort by entryDate first', async () => {
    const first = await writeJournalEntry(paths, {
      method: 'gratitude',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T09:00:00.000Z',
      session: 'session_01JAAA',
      body: 'Grateful for coffee.\n',
    })
    const second = await writeJournalEntry(paths, {
      method: 'open',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T21:00:00.000Z',
      session: 'session_01JBBB',
      body: 'Just writing.\n',
    })
    expect(first.path).not.toBe(second.path)
    const entries = (await readdir(paths.journalDir)).sort()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.startsWith('2026-08-16-')).toBe(true)
    expect(entries[1]?.startsWith('2026-08-16-')).toBe(true)
  })

  it('writes required frontmatter: id, kind, method, mode, entryDate, recordedAt, session', async () => {
    const doc = await writeJournalEntry(paths, {
      method: 'examen',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T21:04:00.000Z',
      session: 'session_01JAAA',
      body: 'Right now, calm.\n',
    })
    expect(doc.meta.id).toMatch(/^doc_[0-9A-Z]{26}$/)
    expect(doc.meta.kind).toBe('journal')
    expect(doc.meta.method).toBe('examen')
    expect(doc.meta.mode).toBe('journal')
    expect(doc.meta.entryDate).toBe('2026-08-16')
    expect(doc.meta.recordedAt).toBe('2026-08-16T21:04:00.000Z')
    expect(doc.meta.session).toBe('session_01JAAA')
  })

  it('entryDate and recordedAt are independently settable and both round-trip unchanged, guarding future import', async () => {
    const written = await writeJournalEntry(paths, {
      method: 'open',
      entryDate: '2019-03-14',
      recordedAt: '2026-08-16T21:04:00.000Z',
      session: 'session_01JAAA',
      body: 'An old page, imported today.\n',
    })
    const read = await readDocument(written.path)
    expect(read.meta.entryDate).toBe('2019-03-14')
    expect(read.meta.recordedAt).toBe('2026-08-16T21:04:00.000Z')
    expect(read.meta.entryDate).not.toBe(read.meta.recordedAt)
  })

  it('writes atomically, leaving no temp file behind', async () => {
    await writeJournalEntry(paths, {
      method: 'gratitude',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T21:04:00.000Z',
      session: 'session_01JAAA',
      body: 'Grateful.\n',
    })
    const entries = await readdir(paths.journalDir)
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/journal.test.ts
```

Expected: `Cannot find module './journal.js'` or similar, since the file does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/memory/src/journal.ts`:

```ts
// Journal entry primitives: filename, frontmatter, and the atomic write.
// journal/ holds entries only, one markdown file per entry, never edited
// in place after it is written (see paths.ts and the journal mode spec,
// section 2). This module also holds journaling.md's protocol read/write
// helpers; see the comment above writeJournalingProtocol below.

import { join } from 'node:path'
import { type Document, newId, readDocument, writeDocumentAtomic } from './documents.js'
import type { MemoryPaths } from './paths.js'

export type JournalMethod =
  | 'expressive_writing'
  | 'gratitude'
  | 'examen'
  | 'thought_record'
  | 'morning_pages'
  | 'open'

export interface JournalEntryInput {
  method: JournalMethod
  entryDate: string
  recordedAt: string
  session: string
  body: string
}

export function journalEntryFileName(entryDate: string, id: string): string {
  return `${entryDate}-${id}.md`
}

export function journalEntryPath(paths: MemoryPaths, entryDate: string, id: string): string {
  return join(paths.journalDir, journalEntryFileName(entryDate, id))
}

// The one place a journal entry file is created. entryDate (event time)
// and recordedAt (record time) are both taken from the caller rather than
// derived from each other, on purpose: see the journal mode spec, section
// 3, on why the split exists before an importer does.
export async function writeJournalEntry(
  paths: MemoryPaths,
  input: JournalEntryInput,
): Promise<Document> {
  const id = newId('doc')
  const path = journalEntryPath(paths, input.entryDate, id)
  await writeDocumentAtomic({
    path,
    meta: {
      id,
      kind: 'journal',
      method: input.method,
      mode: 'journal',
      entryDate: input.entryDate,
      recordedAt: input.recordedAt,
      session: input.session,
    },
    body: input.body,
  })
  return readDocument(path)
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
pnpm vitest run packages/memory/src/journal.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Build and lint**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/journal.ts packages/memory/src/journal.test.ts
git commit -m "Add journal entry filename, frontmatter, and atomic write

journal/<entryDate>-<id>.md, one file per entry, matching the existing
sessions/<date>-<sessionId> naming convention. entryDate and recordedAt
are independently settable fields, tested to round-trip unchanged, so
a future importer can set a historical entryDate without a migration."
```

---

## Task 4: Journal entry body assembly, from a transcript to what the entry actually says

**Files**
- Modify: `packages/memory/src/journal.ts`
- Modify: `packages/memory/src/journal.test.ts`

**Interfaces**

Consumes: `JournalMethod` (Task 3). `TranscriptLine` from `packages/memory/src/transcripts.ts`. By the time this task runs, the modes plan has already added a `synthetic?: true` field to `TranscriptLine`. Confirm first:

```bash
grep -n "interface TranscriptLine" -A8 packages/memory/src/transcripts.ts
```

Expected: a `synthetic?: true` (or `synthetic?: boolean`) field alongside `ts`, `role`, `content`. If it is missing, the modes plan has not landed section 9.3 of its own spec; stop and report it.

Produces, consumed by Task 6:

```ts
// packages/memory/src/journal.ts
export function assembleJournalBody(transcript: TranscriptLine[], method: JournalMethod): string
```

**Design decision this task makes, not dictated verbatim by the spec:** for the two structured methods (`examen`, `thought_record`), the spec says the assembled body interleaves the method's own static field labels with the person's answers "in order," but does not say what happens when the number of non-synthetic user lines does not exactly match the number of labels (a person can answer one prompt across two messages, or the companion can skip a conditional step). This task's rule: label positions are assigned to non-synthetic user lines in order, one label per line; if there are fewer user lines than labels, only the labels that have a matching line are emitted; if there are more user lines than labels, the surplus lines are appended after the labeled ones, each on its own paragraph, unlabeled rather than dropped, because dropping a person's own words would break the "never paraphrased, never dropped" rule the spec states for every method. This keeps the function total (it never throws on an unexpected transcript shape) and never discards content.

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory/src/journal.test.ts` (add `TranscriptLine` to the existing `./transcripts.js` import, or add a new import line for it, and add `assembleJournalBody` to the `./journal.js` import):

```ts
describe('assembleJournalBody', () => {
  it('includes every non-synthetic user line verbatim and in order, for an unstructured method', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Whenever ready, just start writing.' },
      { ts: '2026-08-16T09:00:05.000Z', role: 'assistant', content: 'Go ahead, take your time.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Today felt long but okay.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'tool', content: '{"ok":true}' },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'That is all for now.' },
    ]
    const body = assembleJournalBody(transcript, 'open')
    expect(body).toContain('Today felt long but okay.')
    expect(body).toContain('That is all for now.')
    expect(body).not.toContain('Go ahead, take your time.')
    expect(body).not.toContain('"ok":true')
    expect(body.indexOf('Today felt long but okay.')).toBeLessThan(body.indexOf('That is all for now.'))
  })

  it('never contains transcript-sourced assistant or tool content, for any method, even if the implementation is loosened to include it', () => {
    // This test exists to be falsified deliberately in step 2 below, not
    // to pass unconditionally: see the falsification instruction there.
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Grateful for the quiet morning.' },
      { ts: '2026-08-16T09:00:05.000Z', role: 'assistant', content: 'What made that land for you?' },
    ]
    const body = assembleJournalBody(transcript, 'gratitude')
    expect(body).not.toContain('What made that land for you?')
  })

  it('excludes a synthetic user line while still including the ordinary lines around it', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Something before the mode switch.' },
      { ts: '2026-08-16T09:00:05.000Z', role: 'user', content: '/mode journal', synthetic: true },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Something after the mode switch.' },
    ]
    const body = assembleJournalBody(transcript, 'open')
    expect(body).toContain('Something before the mode switch.')
    expect(body).toContain('Something after the mode switch.')
    expect(body).not.toContain('/mode journal')
  })

  it('interleaves the examen labels with the person answers, in the fixed order, and uses no label outside that method', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Tired but okay.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Coffee with an old friend.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'user', content: 'A hard call with my sister.' },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'That I still care more than I show.' },
      { ts: '2026-08-16T09:04:00.000Z', role: 'user', content: 'Getting to bed earlier.' },
    ]
    const body = assembleJournalBody(transcript, 'examen')
    expect(body).toContain('Tired but okay.')
    expect(body).toContain('Coffee with an old friend.')
    expect(body).toContain('A hard call with my sister.')
    expect(body).toContain('That I still care more than I show.')
    expect(body).toContain('Getting to bed earlier.')
    const labelPattern = /\*\*([^*]+):\*\*/g
    const labelsFound = [...body.matchAll(labelPattern)].map((match) => match[1])
    const examenLabels = [
      'Right now',
      'Grateful for',
      'A moment that stirred something',
      'What that moment is telling me',
      'Looking ahead',
    ]
    for (const label of labelsFound) {
      expect(examenLabels).toContain(label)
    }
    expect(body.indexOf('Right now')).toBeLessThan(body.indexOf('Grateful for'))
  })

  it('interleaves the thought record labels with the person answers, in the fixed order', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'A meeting where I froze up.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Anxious, about 70.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'user', content: 'Everyone thinks I am not prepared.' },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'I did answer two questions well.' },
      { ts: '2026-08-16T09:04:00.000Z', role: 'user', content: 'I stumbled on one thing, not everything.' },
      { ts: '2026-08-16T09:05:00.000Z', role: 'user', content: 'I can find one, actually.' },
      { ts: '2026-08-16T09:06:00.000Z', role: 'user', content: 'Down to about 40.' },
    ]
    const body = assembleJournalBody(transcript, 'thought_record')
    expect(body).toContain('**Situation:** A meeting where I froze up.')
    expect(body).toContain('**Automatic thought:** Everyone thinks I am not prepared.')
    expect(body).toContain('**Re-rated emotion:** Down to about 40.')
  })

  it('appends a surplus user line unlabeled rather than dropping it, for a structured method', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Calm.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'A walk outside.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'user', content: 'Nothing much today.' },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'Not sure.' },
      { ts: '2026-08-16T09:04:00.000Z', role: 'user', content: 'Just to rest.' },
      { ts: '2026-08-16T09:05:00.000Z', role: 'user', content: 'One more thing I forgot to say earlier.' },
    ]
    const body = assembleJournalBody(transcript, 'examen')
    expect(body).toContain('One more thing I forgot to say earlier.')
    expect(body).not.toContain('**Looking ahead:** One more thing I forgot to say earlier.')
  })
})
```

- [ ] **Step 2: Run and confirm the tests fail, and falsify the two body-assembly rules**

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'assembleJournalBody'
```

Expected: `assembleJournalBody is not a function`, since it does not exist yet.

- [ ] **Step 3: Write the implementation**

Append to `packages/memory/src/journal.ts`. Add `TranscriptLine` to its imports (`import type { TranscriptLine } from './transcripts.js'`):

```ts
const EXAMEN_LABELS = [
  'Right now',
  'Grateful for',
  'A moment that stirred something',
  'What that moment is telling me',
  'Looking ahead',
] as const

const THOUGHT_RECORD_LABELS = [
  'Situation',
  'Emotion and intensity',
  'Automatic thought',
  'Evidence for',
  'Evidence against',
  'Balanced alternative',
  'Re-rated emotion',
] as const

const STRUCTURED_METHOD_LABELS: Partial<Record<JournalMethod, readonly string[]>> = {
  examen: EXAMEN_LABELS,
  thought_record: THOUGHT_RECORD_LABELS,
}

// Deterministic, not another LLM call. The only lines that ever reach the
// body are the person's own non-synthetic user-role lines, verbatim and
// never paraphrased: no assistant content, no tool content, and no
// synthetic user line (the modes spec's own /mode <name> line, written on
// the person's behalf rather than typed by them). For the two structured
// methods, a fixed set of labels this module owns is interleaved with the
// answers in order; the labels are code, never text read back out of the
// transcript. See the design decision in the plan task above for what
// happens when the number of answers does not match the label count.
export function assembleJournalBody(transcript: TranscriptLine[], method: JournalMethod): string {
  const userLines = transcript.filter((line) => line.role === 'user' && !line.synthetic)
  const labels = STRUCTURED_METHOD_LABELS[method]
  if (!labels) {
    return userLines.map((line) => line.content).join('\n\n')
  }
  return userLines
    .map((line, index) => {
      const label = labels[index]
      return label ? `**${label}:** ${line.content}` : line.content
    })
    .join('\n\n')
}
```

- [ ] **Step 4: Run and confirm all six tests pass**

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'assembleJournalBody'
```

Expected: 6 passed.

- [ ] **Step 5: Falsify the inclusion test**

Temporarily change the filter in `assembleJournalBody` from `line.role === 'user' && !line.synthetic` to `line.role !== 'tool'` (so assistant content leaks in), rerun:

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'never contains transcript-sourced assistant or tool content'
```

Expected: FAIL, with the assertion `expect(body).not.toContain('What made that land for you?')` failing. This confirms the test actually catches the bug it is named for. Revert the change.

- [ ] **Step 6: Falsify the synthetic-exclusion test, separately**

Temporarily change the filter back to plain `line.role === 'user'` (drop the `&& !line.synthetic` half only, leaving the assistant/tool exclusion intact), rerun:

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'excludes a synthetic user line'
```

Expected: FAIL, with `expect(body).not.toContain('/mode journal')` failing, while the inclusion test from step 1 still passes. This is the point of having two separate tests: an inclusion-only test cannot tell correct behavior apart from this specific bug, because a synthetic line is itself a `user`-role line. Revert the change.

- [ ] **Step 7: Falsify the structured-label test**

Temporarily change the examen branch to read a label from `transcript` content instead of `EXAMEN_LABELS` (for example, hardcode the first assistant line's content as if it were a label), rerun:

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'interleaves the examen labels'
```

Expected: FAIL, since the fixture in that test has no assistant lines to pull from, or the emitted label falls outside `examenLabels`. Revert the change.

- [ ] **Step 8: Build and lint**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 9: Commit**

```bash
git add packages/memory/src/journal.ts packages/memory/src/journal.test.ts
git commit -m "Assemble journal entry bodies deterministically from a transcript

Only non-synthetic user-role lines ever reach the body, verbatim and in
order. Inclusion and synthetic-exclusion are tested separately, since a
synthetic line is itself a user line and an inclusion-only test cannot
tell the two apart. Examen and the thought record interleave fixed,
code-owned labels with the answers; the labels are never read back out
of the transcript."
```

---

## Task 5: Declaring which of the six methods this journal session is using

The spec's frontmatter schema (section 2.2) requires `method` on every journal entry, and section 11 requires the entry write inside `_doEndSession` to be deterministic, with no LLM call at write time. Neither the journal spec nor the modes spec says how `_doEndSession` learns which of the six methods was actually used this session: the modes spec's `session.json` is scoped to `{ mode }` alone ("Nothing else writes it"), and `journaling.md` is a persistent, possibly multi-method configuration document, not a per-session record of which one applied today.

**This task makes a decision the spec leaves open, and states it plainly rather than hiding it in an implementation detail.** The chosen method is declared once, live, the same way the session's mode itself is declared: a small tool the companion calls once it and the person have settled on a method for this session (spec section 7, step 3), persisted next to the mode in the session's own `session.json` so it survives the same crash path section 11 already requires the mode to survive. This mirrors `set_mode`'s own shape exactly, for the same reason: state that has to outlive the process that set it belongs on disk, not only in `AgentSession`.

**Files**
- Modify: `packages/memory/src/transcripts.ts`
- Modify: `packages/memory/src/transcripts.test.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Interfaces**

Consumes: `JournalMethod` (Task 3). The modes plan's `session.json` mechanism. Confirm its exact shape before writing any code in this task:

```bash
grep -n "session.json\|SessionMeta\|writeMeta\|readMeta\|setSessionMode\|sessionMode" packages/memory/src/transcripts.ts packages/memory/src/engine.ts
```

This plan was written expecting `SessionStore.writeMeta(paths, sessionId, meta)` and `SessionStore.readMeta(paths, sessionId)`, with a `SessionMeta` interface holding `{ mode?: string }`, and `MemoryEngine.setSessionMode(sessionId, mode)` / `MemoryEngine.sessionMode(sessionId)` as the engine-level wrappers. If the real names differ, use the real names everywhere below; the shape of the change (read the existing metadata, merge in `journalMethod`, write it back atomically) stays the same regardless of what the read/write pair is called.

Produces, consumed by Task 6:

```ts
// packages/memory/src/engine.ts, on class MemoryEngine
setSessionJournalMethod(sessionId: string, method: JournalMethod): Promise<void>
sessionJournalMethod(sessionId: string): Promise<JournalMethod | undefined>
```

- [ ] **Step 1: Write the failing tests for `SessionMeta` widening**

Find the existing session-metadata tests:

```bash
grep -n "session.json\|SessionMeta\|writeMeta\|readMeta" packages/memory/src/transcripts.test.ts
```

Add a sibling test in the same `describe` block that already covers `session.json` (create one at the end of the file if none exists yet, following the file's existing `mkdtemp`/`afterEach` pattern shown by `grep -n "mkdtemp" packages/memory/src/transcripts.test.ts`):

```ts
it('session metadata round-trips journalMethod alongside mode', async () => {
  const store = await SessionStore.start(paths, new Date('2026-08-16T09:00:00.000Z'))
  await SessionStore.writeMeta(paths, store.sessionId, { mode: 'journal' })
  const afterMode = await SessionStore.readMeta(paths, store.sessionId)
  expect(afterMode?.mode).toBe('journal')
  await SessionStore.writeMeta(paths, store.sessionId, { ...afterMode, journalMethod: 'gratitude' })
  const afterMethod = await SessionStore.readMeta(paths, store.sessionId)
  expect(afterMethod?.mode).toBe('journal')
  expect(afterMethod?.journalMethod).toBe('gratitude')
})
```

Adjust the literal calls to match whatever `grep` in the Interfaces section above actually found; the assertion (writing `mode` first, then merging in `journalMethod` without losing `mode`) is what matters, not the exact helper names.

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/transcripts.test.ts -t 'journalMethod alongside mode'
```

Expected: a type error or `journalMethod` is `undefined` after the second write, since the session metadata type does not carry it yet.

- [ ] **Step 3: Widen the session metadata shape**

Find the interface (name confirmed by the grep in the Interfaces section; this plan calls it `SessionMeta`):

```bash
grep -n "interface SessionMeta" packages/memory/src/transcripts.ts
```

Add one optional field:

```ts
export interface SessionMeta {
  mode?: string
  journalMethod?: string
}
```

`journalMethod` is typed as a plain `string` here, not `JournalMethod`: `packages/memory/src/transcripts.ts` sits below `packages/memory/src/journal.ts` in no particular dependency order within the same package, but keeping this file's own type free of a sibling module's enum avoids a needless import cycle risk for a file this central. `MemoryEngine.setSessionJournalMethod` (step 5 below) is the one place that narrows the string to `JournalMethod` before anything reads it back as one.

- [ ] **Step 4: Run and confirm the transcripts test passes**

```bash
pnpm vitest run packages/memory/src/transcripts.test.ts -t 'journalMethod alongside mode'
```

Expected: 1 passed.

- [ ] **Step 5: Write the failing engine tests**

Add to `packages/memory/src/engine.test.ts`, inside the `describe('journal document kind', ...)` block Task 2 added (or a new sibling `describe`):

```ts
  describe('session journal method', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journalmethod-'))
      paths = memoryPaths(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('records and reads back the declared method for a session', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.setSessionJournalMethod(sessionId, 'gratitude')
      expect(await engine.sessionJournalMethod(sessionId)).toBe('gratitude')
      await engine.close()
    })

    it('reports the method as absent for a session that never declared one', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      expect(await engine.sessionJournalMethod(sessionId)).toBeUndefined()
      await engine.close()
    })
  })
```

- [ ] **Step 6: Run and confirm the failure**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'session journal method'
```

Expected: `engine.setSessionJournalMethod is not a function`.

- [ ] **Step 7: Add the engine methods**

```bash
grep -n "async setSessionMode\|async sessionMode" packages/memory/src/engine.ts
```

Add the two new methods next to whatever that search found (if `setSessionMode`/`sessionMode` are not found under those names, add these two methods next to wherever `session.json` is otherwise read or written in `engine.ts`):

```ts
  // Declares which of the six journal methods this session is using, once
  // the companion and the person have settled on one (spec section 7, step
  // 3). Persisted next to the session's mode in the same session.json, on
  // the same crash-safety reasoning that persistence exists for at all:
  // a later process's runMaintenance pass must be able to read it back
  // with no live AgentSession anywhere. Read-merge-write so this call
  // never clobbers a mode already written by setSessionMode.
  async setSessionJournalMethod(sessionId: string, method: JournalMethod): Promise<void> {
    const existing = await SessionStore.readMeta(this.paths, sessionId)
    await SessionStore.writeMeta(this.paths, sessionId, { ...existing, journalMethod: method })
  }

  async sessionJournalMethod(sessionId: string): Promise<JournalMethod | undefined> {
    const meta = await SessionStore.readMeta(this.paths, sessionId)
    return meta?.journalMethod as JournalMethod | undefined
  }
```

Add `JournalMethod` to the file's import from `./journal.js` (create the import line if this is the first thing this file has needed from that module).

- [ ] **Step 8: Run and confirm the engine tests pass**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'session journal method'
```

Expected: 2 passed.

- [ ] **Step 9: Add the tool, engine-backed with no dispatch hook, matching `remember`'s shape**

```bash
grep -n "const rememberArgs\|case 'remember':\|async function dispatchRemember" packages/core/src/tools.ts
```

Add the args schema next to `rememberArgs`:

```ts
const declareJournalMethodArgs = z.strictObject({
  method: z.enum([
    'expressive_writing',
    'gratitude',
    'examen',
    'thought_record',
    'morning_pages',
    'open',
  ]),
})
```

Add the tool definition to the array `toolDefinitions()` returns, near `remember`:

```ts
    {
      name: 'declare_journal_method',
      description:
        'Record which of the six journaling formats this journal-mode session is using, once you and the person ' +
        'have actually settled on one in conversation (expressive writing, gratitude, the daily examen, a CBT ' +
        'thought record, morning pages, or open format). Call this once per session, as soon as the method is ' +
        'clear, not before. Only meaningful during a journal-mode session; harmless otherwise.',
      parameters: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            enum: [
              'expressive_writing',
              'gratitude',
              'examen',
              'thought_record',
              'morning_pages',
              'open',
            ],
            description: 'Which of the six journaling formats this session is using.',
          },
        },
        required: ['method'],
        additionalProperties: false,
      },
    },
```

Add the dispatch case and its handler, next to `dispatchRemember`:

```ts
      case 'declare_journal_method':
        return await dispatchDeclareJournalMethod(engine, sessionId, parsedArgs.value)
```

```ts
async function dispatchDeclareJournalMethod(
  engine: MemoryEngine,
  sessionId: string,
  value: unknown,
): Promise<string> {
  const parsed = declareJournalMethodArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('declare_journal_method', parsed.error))

  await engine.setSessionJournalMethod(sessionId, parsed.data.method)
  return JSON.stringify({ ok: true })
}
```

- [ ] **Step 10: Write the failing tool test, then confirm it passes**

Add to `packages/core/src/tools.test.ts`, near the existing `remember` dispatch tests (find them with `grep -n "dispatchTool.*remember\|'remember'" packages/core/src/tools.test.ts | head -5` and match that file's fixture engine setup):

```ts
it('declare_journal_method records the method on the session', async () => {
  const engine = await openTestEngine() // reuse this file's existing engine fixture helper
  const sessionId = await engine.startSession()
  const result = await dispatchTool(engine, sessionId, {
    id: 'call_1',
    name: 'declare_journal_method',
    arguments: JSON.stringify({ method: 'gratitude' }),
  })
  expect(JSON.parse(result)).toEqual({ ok: true })
  expect(await engine.sessionJournalMethod(sessionId)).toBe('gratitude')
})

it('declare_journal_method rejects an unknown method', async () => {
  const engine = await openTestEngine()
  const sessionId = await engine.startSession()
  const result = await dispatchTool(engine, sessionId, {
    id: 'call_1',
    name: 'declare_journal_method',
    arguments: JSON.stringify({ method: 'astrology' }),
  })
  expect(JSON.parse(result).error).toBeDefined()
})
```

Run:

```bash
pnpm vitest run packages/core/src/tools.test.ts -t 'declare_journal_method'
```

Expected: 2 passed. If this file has no existing `openTestEngine`-style fixture, find how its other dispatch tests construct an engine (`grep -n "MemoryEngine.open" packages/core/src/tools.test.ts | head -3`) and reuse that pattern instead.

- [ ] **Step 11: Build, full test suite, lint**

```bash
pnpm build && pnpm test && pnpm lint
```

- [ ] **Step 12: Commit**

```bash
git add packages/memory/src/transcripts.ts packages/memory/src/transcripts.test.ts packages/memory/src/engine.ts packages/memory/src/engine.test.ts packages/core/src/tools.ts packages/core/src/tools.test.ts
git commit -m "Add declare_journal_method, persisted next to session mode

The spec requires frontmatter.method on every journal entry but does
not say how the deterministic end-of-session write learns it. This
adds a live tool, mirroring set_mode's own shape: declared once,
persisted to session.json so a later process's runMaintenance can
still read it after a crash, the same guarantee mode itself needs."
```

---

## Task 6: The gated write inside `_doEndSession`, and the crash path

This is the task the spec calls out as the one ordinary-path testing misses (section 11, section 13): a session's mode and declared method must be readable from disk, not only from the process that set them, because the normal way a real session ends on a laptop is the process simply stopping, not an orderly `/bye`.

**Files**
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Consumes: `writeJournalEntry`, `assembleJournalBody`, `JournalMethod` (Tasks 3, 4). `setSessionJournalMethod`/`sessionJournalMethod` (Task 5). The modes plan's `setSessionMode`/`sessionMode` (or whatever names Task 5's grep found). The time plan's local-date formatter. Confirm it before writing code:

```bash
grep -n "export function formatLocalDate\|export function addDaysLocal" packages/memory/src/time.ts
```

Expected: `formatLocalDate(date: Date, timezone: string): string`. If `packages/memory/src/time.ts` does not exist, the time plan has not landed section 6 of its own spec; stop and report it. This plan writes `formatLocalDate(now, this.profile.meta.timezone ?? 'UTC')` throughout; substitute the real signature if it differs (for example, if the time plan folded the timezone argument away and reads it from cached engine state itself).

Produces: nothing new. This task is where Tasks 3, 4, and 5 actually get used.

- [ ] **Step 1: Write the failing gating tests, both directions**

Add to `packages/memory/src/engine.test.ts`, inside a new `describe('journal entry write', ...)` block:

```ts
  describe('journal entry write', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journalwrite-'))
      paths = memoryPaths(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('writes no file under journal/ for a session whose mode was never journal', async () => {
      const scriptedReflection = emptyReflectionOutput('An ordinary conversation.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T09:00:00.000Z',
        role: 'user',
        content: 'Just talking, nothing structured.',
      })
      await engine.endSession(sessionId)
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journal')).toBeUndefined()
      await engine.close()
    })

    it('writes exactly one file under journal/ for a session whose mode was journal, with the declared method', async () => {
      const scriptedReflection = emptyReflectionOutput('A short gratitude session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'journal')
      await engine.setSessionJournalMethod(sessionId, 'gratitude')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T09:00:00.000Z',
        role: 'user',
        content: 'Grateful for the quiet morning.',
      })
      await engine.endSession(sessionId)
      const rows = await engine.listPublicDocuments()
      const journalRows = rows.filter((row) => row.kind === 'journal')
      expect(journalRows).toHaveLength(1)
      expect(journalRows[0]?.method).toBe('gratitude')
      const doc = await engine.getPublicDocument(journalRows[0]?.docId ?? '')
      expect(doc?.body).toContain('Grateful for the quiet morning.')
      await engine.close()
    })

    it('writes nothing under journal/ when the mode was journal but no method was ever declared', async () => {
      // Absent method is treated the same as absent mode: the write is
      // additive and gated, not an error. A session cannot reach this
      // state through the real product (declare_journal_method is called
      // as soon as the method is clear), but a test transcript can, and
      // the write must degrade to "no journal document captured," per
      // spec section 11, rather than writing a frontmatter with no method.
      const scriptedReflection = emptyReflectionOutput('Started journal mode, then abandoned it.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'journal')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T09:00:00.000Z',
        role: 'user',
        content: 'Actually, never mind.',
      })
      await engine.endSession(sessionId)
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journal')).toBeUndefined()
      await engine.close()
    })
  })
```

If Task 5's grep found a different name than `setSessionMode`, substitute it here too.

- [ ] **Step 2: Run and confirm the failures**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'journal entry write'
```

Expected: the positive case fails (`journalRows` has length 0), the two negative cases already pass vacuously since nothing writes to `journal/` yet. That asymmetry is expected at this point; step 4 below closes it without breaking the two that already pass.

- [ ] **Step 3: Write the failing crash-path test**

Add to the same `describe` block:

```ts
    it('survives the engine being closed and reopened between declaring the method and endSession (the crash path)', async () => {
      const scriptedReflection = emptyReflectionOutput('A short gratitude session, reflected late.')
      const startedAt = new Date('2026-08-14T09:00:00.000Z')

      const firstChat = new FakeChatProvider([])
      let engine = await MemoryEngine.open(dir, fakeDeps(firstChat))
      const sessionId = await engine.startSession(startedAt)
      await engine.setSessionMode(sessionId, 'journal')
      await engine.setSessionJournalMethod(sessionId, 'gratitude')
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content: 'Grateful for a slow start today.',
      })
      // Simulate the process dying before /bye or an orderly endSession:
      // close the engine with the session still unreflected.
      await engine.close()

      const secondChat = new FakeChatProvider([
        { text: JSON.stringify(scriptedReflection), toolCalls: [] },
      ])
      // A fresh MemoryEngine instance, as a later process would construct.
      // MemoryEngine.open runs runMaintenance by default, which reflects
      // any unreflected session it finds, calling _doEndSession on it.
      engine = await MemoryEngine.open(dir, fakeDeps(secondChat))
      const rows = await engine.listPublicDocuments()
      const journalRows = rows.filter((row) => row.kind === 'journal')
      expect(journalRows).toHaveLength(1)
      expect(journalRows[0]?.method).toBe('gratitude')
      const doc = await engine.getPublicDocument(journalRows[0]?.docId ?? '')
      expect(doc?.body).toContain('Grateful for a slow start today.')
      await engine.close()
    })
```

- [ ] **Step 4: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'crash path'
```

Expected: FAIL, no journal row found, since `_doEndSession` does not read mode or method from disk yet.

- [ ] **Step 5: Add the gated write to `_doEndSession`**

```bash
grep -n "const commitResult = await commitMemory" packages/memory/src/engine.ts | head -3
```

This should show the commit call inside `_doEndSession` (the first match; `writeSkippedSummary` has its own, separate commit call further down and is not the one to edit here). Insert the gated write immediately before that commit call, after the narratives reindex loop:

```ts
    // Journal mode adds one more write after the rest of this pipeline
    // completes, gated on the session's own recorded mode and declared
    // method, both read from session.json on disk rather than from any
    // in-memory session registry: this is what makes the write survive
    // the process that started the session dying before an orderly
    // endSession (spec section 11). Absent mode, absent method, or a
    // mode other than journal all degrade the same way: no journal
    // document is written, and nothing else about this pipeline changes.
    const sessionMode = await this.sessionMode(sessionId)
    if (sessionMode === 'journal') {
      const method = await this.sessionJournalMethod(sessionId)
      if (method) {
        const entryDate = formatLocalDate(now, this.profile.meta.timezone ?? 'UTC')
        const body = assembleJournalBody(transcript, method)
        const entryDoc = await writeJournalEntry(this.paths, {
          method,
          entryDate,
          recordedAt: now.toISOString(),
          session: sessionId,
          body,
        })
        await this.reindexOrWarn(entryDoc, 'journal', `session ${sessionId} journal entry`)
      }
    }

    const commitResult = await commitMemory(this.paths.root, `reflect: session ${sessionId}`)
```

Add `formatLocalDate` to the file's import from `./time.js`, and `assembleJournalBody`, `writeJournalEntry` to its import from `./journal.js` (both may already be partially imported from earlier tasks; add only what is missing).

Placing this before the commit, not after, means the journal entry lands in the same git commit as the summary, the narrative rewrites, and the constitution update for this session, matching how every other write this pipeline produces is committed together.

- [ ] **Step 6: Run and confirm all four new tests pass**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'journal entry write'
pnpm vitest run packages/memory/src/engine.test.ts -t 'crash path'
```

Expected: 4 passed, 1 passed.

- [ ] **Step 7: Falsify the crash-path test specifically**

Per spec section 13, this test must fail if mode/method persistence is skipped, distinctly from the ordinary-path test. Temporarily change the crash-path test itself (not the implementation) to skip persisting the method: remove the `await engine.setSessionJournalMethod(sessionId, 'gratitude')` line, keeping everything else the same, and rerun:

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'crash path'
```

Expected: FAIL, `journalRows` has length 0, because the reopened engine's `_doEndSession` reads an absent method from `session.json` and takes the gated-absent path. This confirms the test exercises the actual dependency on persistence rather than passing regardless. Restore the removed line.

- [ ] **Step 8: Falsify the gating test's positive direction**

Temporarily comment out the `if (sessionMode === 'journal')` gate in `_doEndSession` so the write always attempts to run (leave the inner `if (method)` check in place so this does not crash on a missing method), rerun:

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'writes no file under journal/ for a session whose mode was never journal'
```

Expected: this specific test still passes (no method was ever declared for that session either, so the inner guard still blocks the write), which is exactly why the spec requires testing both directions independently: a gate that only checks `method` and never `mode` would pass every test written so far. Now also comment out the `if (method)` check and hardcode `method` to `'open'` in that branch; rerun the same command. Expected: FAIL, since a file now gets written for a non-journal session. Restore both guards.

- [ ] **Step 9: Build, full test suite, lint**

```bash
pnpm build && pnpm test && pnpm lint
```

- [ ] **Step 10: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Write a journal entry at end of session, gated on mode and method

Additive to the existing reflection pipeline: a non-journal session
writes nothing new. Mode and method are both read from session.json on
disk, not from in-memory session state, so a session that crashes
before an orderly end still produces its entry once a later process's
runMaintenance reflects it. Tested in both directions plus the crash
path, each falsified to confirm it fails for the reason it is named."
```

---

## Task 7: `journaling.md` read and write, and the shared id-preserving helper

Both surfaces that ever revise `journaling.md` (the live `update_journaling_protocol` tool, Task 11, and reflection's `journalingUpdate`, Task 12) write through one helper, per spec section 4.5: read the existing document to preserve its `id` if present, or mint one if this is the very first write, replace the body, write atomically. This task builds that helper once, in `packages/memory/src/journal.ts`, so neither later task forks it.

**Files**
- Modify: `packages/memory/src/journal.ts`
- Modify: `packages/memory/src/journal.test.ts`

**Interfaces**

Consumes: `MemoryPaths.journaling` (Task 1), `newId`, `readDocument`, `writeDocumentAtomic`, `Document` (existing).

Produces, consumed by Tasks 8, 11, and 12:

```ts
// packages/memory/src/journal.ts
export const JOURNALING_PROTOCOL_ABSENT: string

export function readJournalingProtocol(paths: MemoryPaths): Promise<string>
// Returns the trimmed body of journaling.md, or JOURNALING_PROTOCOL_ABSENT
// if the file does not exist. Any other read failure propagates.

export function readJournalingProtocolIfPresent(paths: MemoryPaths): Promise<string | undefined>
// Returns the trimmed body, or undefined if the file does not exist.
// Used where undefined itself is the meaningful signal (reflection's
// prompt context needs to tell "not yet set up" apart from "already
// correct," not render the ABSENT sentinel as if it were prose).

export function writeJournalingProtocol(paths: MemoryPaths, body: string, now: Date): Promise<Document>
// Reads the existing journaling.md to preserve its id if present, mints
// one otherwise, writes the full body atomically with `updated` set to
// now. Never reindexes: the caller decides when and how (Tasks 6/11/12).
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory/src/journal.test.ts`:

```ts
describe('journaling.md protocol read and write', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-journaling-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('readJournalingProtocol returns the ABSENT sentinel when journaling.md does not exist', async () => {
    const protocol = await readJournalingProtocol(paths)
    expect(protocol).toBe(JOURNALING_PROTOCOL_ABSENT)
  })

  it('readJournalingProtocol returns the trimmed body when journaling.md exists', async () => {
    await writeDocumentAtomic({
      path: paths.journaling,
      meta: { id: 'doc_01JZZZ', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
      body: '  Gratitude, three times a week.  \n\n',
    })
    const protocol = await readJournalingProtocol(paths)
    expect(protocol).toBe('Gratitude, three times a week.')
  })

  it('readJournalingProtocolIfPresent returns undefined, not the sentinel, when absent', async () => {
    const protocol = await readJournalingProtocolIfPresent(paths)
    expect(protocol).toBeUndefined()
  })

  it('readJournalingProtocolIfPresent returns the body when present', async () => {
    await writeDocumentAtomic({
      path: paths.journaling,
      meta: { id: 'doc_01JZZZ', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
      body: 'Examen, most evenings.\n',
    })
    expect(await readJournalingProtocolIfPresent(paths)).toBe('Examen, most evenings.')
  })

  it('writeJournalingProtocol mints a new id on the very first write', async () => {
    const doc = await writeJournalingProtocol(paths, 'Gratitude, three times a week.', new Date('2026-08-16T21:04:00.000Z'))
    expect(doc.meta.id).toMatch(/^doc_[0-9A-Z]{26}$/)
    expect(doc.meta.kind).toBe('journaling')
    expect(doc.meta.updated).toBe('2026-08-16T21:04:00.000Z')
    expect(doc.body.trim()).toBe('Gratitude, three times a week.')
  })

  it('writeJournalingProtocol preserves the existing id on a revision', async () => {
    const first = await writeJournalingProtocol(paths, 'Gratitude, three times a week.', new Date('2026-08-16T21:04:00.000Z'))
    const second = await writeJournalingProtocol(paths, 'Switched to the examen instead.', new Date('2026-08-17T10:00:00.000Z'))
    expect(second.meta.id).toBe(first.meta.id)
    expect(second.body.trim()).toBe('Switched to the examen instead.')
    expect(second.meta.updated).toBe('2026-08-17T10:00:00.000Z')
  })

  it('writeJournalingProtocol is a full replace, never an append: the old body is gone after a revision', async () => {
    await writeJournalingProtocol(paths, 'Gratitude, three times a week.', new Date('2026-08-16T21:04:00.000Z'))
    const revised = await writeJournalingProtocol(paths, 'Examen, most evenings.', new Date('2026-08-17T10:00:00.000Z'))
    expect(revised.body).not.toContain('Gratitude')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'journaling.md protocol'
```

Expected: `readJournalingProtocol is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `packages/memory/src/journal.ts`:

```ts
export const JOURNALING_PROTOCOL_ABSENT =
  "journaling.md does not exist yet: this person has never set up journal mode before. " +
  "Run the first-time setup conversation before beginning any method (see the journal mode " +
  "spec, section 7), and once it concludes, write journaling.md in full."

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

// Only the specific "file does not exist" case is handled here; a
// permissions error or a corrupt file propagates, the same way any other
// document-read failure in this codebase already does. See the journal
// mode spec, section 4.4.
export async function readJournalingProtocol(paths: MemoryPaths): Promise<string> {
  try {
    const doc = await readDocument(paths.journaling)
    return doc.body.trim()
  } catch (err) {
    if (isEnoent(err)) return JOURNALING_PROTOCOL_ABSENT
    throw err
  }
}

export async function readJournalingProtocolIfPresent(
  paths: MemoryPaths,
): Promise<string | undefined> {
  try {
    const doc = await readDocument(paths.journaling)
    return doc.body.trim()
  } catch (err) {
    if (isEnoent(err)) return undefined
    throw err
  }
}

// The one place journaling.md is written, from either surface (the live
// update_journaling_protocol tool or reflection's journalingUpdate field).
// Always a full replace of the body, never a diff or an append, matching
// the "never edited in place" rule journal entries themselves follow.
// Any read failure other than the file being absent (a corrupt hand edit,
// for instance) is treated the same as absent here, unlike the read
// helpers above: a write should not be blocked by a document that already
// cannot be parsed.
export async function writeJournalingProtocol(
  paths: MemoryPaths,
  body: string,
  now: Date,
): Promise<Document> {
  let id: string
  try {
    const existing = await readDocument(paths.journaling)
    id = typeof existing.meta.id === 'string' ? existing.meta.id : newId('doc')
  } catch {
    id = newId('doc')
  }
  await writeDocumentAtomic({
    path: paths.journaling,
    meta: { id, kind: 'journaling', updated: now.toISOString() },
    body,
  })
  return readDocument(paths.journaling)
}
```

Add `JOURNALING_PROTOCOL_ABSENT`, `readJournalingProtocol`, `readJournalingProtocolIfPresent`, `writeJournalingProtocol` to the file's exports (they already are, being top-level `export`s above).

- [ ] **Step 4: Run and confirm all seven tests pass**

```bash
pnpm vitest run packages/memory/src/journal.test.ts -t 'journaling.md protocol'
```

Expected: 7 passed.

- [ ] **Step 5: Build and lint**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/journal.ts packages/memory/src/journal.test.ts
git commit -m "Add journaling.md read and write, shared across both revision paths

readJournalingProtocol distinguishes absent (the fixed sentinel) from a
real body; readJournalingProtocolIfPresent returns undefined instead,
for callers that need to tell 'not yet set up' apart from 'already
correct.' writeJournalingProtocol preserves the existing id on a
revision and mints one on the first write, always a full replace."
```

---

## Task 8: `sessionContext` gains an optional mode parameter and `journalingProtocol`

**Files**
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Consumes: `readJournalingProtocol` (Task 7). The modes plan's mode type. Confirm the current shape of `sessionContext` before editing it:

```bash
grep -n "async sessionContext" packages/memory/src/engine.ts
grep -n "export interface SessionContext" -A5 packages/memory/src/engine.ts
```

By the time this task runs, the time plan has already changed `sessionContext`'s `now` handling (and likely removed `today` from `SessionContext`, per that spec's own section 5) and the modes plan has already added whatever mode type it uses at this layer (a plain `string`, per Task 5's finding above, unless the grep here shows otherwise). This plan adds one more optional parameter and one more field; it does not touch anything else `sessionContext` already does.

Produces, consumed by Task 9:

```ts
// packages/memory/src/engine.ts
export interface SessionContext {
  // ...every existing field, unchanged...
  journalingProtocol: string | undefined
}

// on class MemoryEngine
async sessionContext(now?: Date, mode?: string): Promise<SessionContext>
```

- [ ] **Step 1: Write the failing tests**

Add to `packages/memory/src/engine.test.ts`, near any existing `describe('sessionContext', ...)` block (find it with `grep -n "describe('sessionContext'" packages/memory/src/engine.test.ts`; if none exists, add a new one):

```ts
  describe('sessionContext journalingProtocol', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journalctx-'))
      paths = memoryPaths(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('leaves journalingProtocol undefined and never reads journaling.md when mode is not journal', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.startSession()
      const context = await engine.sessionContext(new Date(), 'general')
      expect(context.journalingProtocol).toBeUndefined()
      await engine.close()
    })

    it('leaves journalingProtocol undefined when sessionContext is called with no mode at all', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.startSession()
      const context = await engine.sessionContext()
      expect(context.journalingProtocol).toBeUndefined()
      await engine.close()
    })

    it('holds the ABSENT sentinel when mode is journal and journaling.md does not exist', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.startSession()
      const context = await engine.sessionContext(new Date(), 'journal')
      expect(context.journalingProtocol).toContain('has never set up journal mode before')
      await engine.close()
    })

    it('holds the trimmed journaling.md body when mode is journal and the file exists', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await writeDocumentAtomic({
        path: paths.journaling,
        meta: { id: 'doc_01JZZZ', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
        body: 'Gratitude, three times a week.\n',
      })
      await engine.startSession()
      const context = await engine.sessionContext(new Date(), 'journal')
      expect(context.journalingProtocol).toBe('Gratitude, three times a week.')
      await engine.close()
    })
  })
```

Confirm `writeDocumentAtomic` and `memoryPaths`/`ensureMemoryTree` are imported in the test file already (they are, from earlier tasks and the existing suite).

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'sessionContext journalingProtocol'
```

Expected: `context.journalingProtocol` is `undefined` on every case including the ones that expect a value, or a type error on the call site passing a second argument `sessionContext` does not accept yet.

- [ ] **Step 3: Widen the signature and the return shape**

```bash
grep -n "async sessionContext" packages/memory/src/engine.ts
```

Add the second parameter and, at the very end of the method, the new field. Keep every existing line of the method body unchanged; only add to the signature and the final returned object:

```ts
  async sessionContext(now: Date = new Date(), mode?: string): Promise<SessionContext> {
    // ...every existing line of this method, unchanged...

    const journalingProtocol =
      mode === 'journal' ? await readJournalingProtocol(this.paths) : undefined

    return {
      // ...every existing field this method already returns...
      journalingProtocol,
    }
  }
```

Add `readJournalingProtocol` to the file's import from `./journal.js`.

Widen the interface:

```bash
grep -n "export interface SessionContext" packages/memory/src/engine.ts
```

Add one field at the end of the interface:

```ts
  // Only ever set when the session's mode is journal; undefined for every
  // other mode and for a call site that passes no mode at all. When set,
  // it is either the trimmed body of journaling.md or the fixed
  // JOURNALING_PROTOCOL_ABSENT sentinel, never assembled ad hoc, so its
  // wording cannot drift between call sites.
  journalingProtocol: string | undefined
```

- [ ] **Step 4: Run and confirm all four tests pass**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'sessionContext journalingProtocol'
```

Expected: 4 passed.

- [ ] **Step 5: Confirm no existing `sessionContext` caller broke**

```bash
pnpm test
```

Expected: full suite green. Every existing call site calls `sessionContext()` or `sessionContext(now)` with no second argument, which is exactly why `mode` is optional; nothing else should need to change.

- [ ] **Step 6: Build and lint**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "sessionContext gains an optional mode and journalingProtocol

A session whose mode is not journal never reads journaling.md at all,
so the common path pays no extra file read. When mode is journal, the
field holds either the file's trimmed body or the fixed absent
sentinel, never a string assembled per call site."
```

---

## Task 9: `journalingProtocolSection` in the assembled system prompt

**Files**
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/context.test.ts`

**Interfaces**

Consumes: `SessionContext.journalingProtocol` (Task 8). Confirm the current shape of `assembleSystemPrompt` and `constitutionSection` before editing:

```bash
grep -n "export async function assembleSystemPrompt" -A15 packages/core/src/context.ts
grep -n "function constitutionSection" -A5 packages/core/src/context.ts
```

By the time this task runs, the modes plan has already widened `assembleSystemPrompt` to take the active mode (per its own spec section 9.2) and has already changed how `sessionContext` is called and what `## Today`/`## Profile` look like. This task adds one more section function and one more line inserting it into the `sections` array; it does not touch anything else in this file.

Produces: nothing new for later tasks in this plan; this is where Task 8's field actually reaches the model.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/context.test.ts`, near the existing constitution-section tests (find them with `grep -n "constitutionSection\|## Constitution" packages/core/src/context.test.ts | head -10` to match the file's existing fake-engine fixture pattern):

```ts
describe('journalingProtocolSection', () => {
  it('is absent when the session is not in journal mode', async () => {
    const prompt = await assembleSystemPrompt(fakeEngineWithContext({ journalingProtocol: undefined }), fakeConfig())
    expect(prompt).not.toContain('## Journaling protocol')
  })

  it('renders the journaling protocol body when present, immediately after the constitution section', async () => {
    const prompt = await assembleSystemPrompt(
      fakeEngineWithContext({ journalingProtocol: 'Gratitude, three times a week.' }),
      fakeConfig(),
      'journal',
    )
    expect(prompt).toContain('## Journaling protocol')
    expect(prompt).toContain('Gratitude, three times a week.')
    const constitutionIndex = prompt.indexOf('## Constitution')
    const journalingIndex = prompt.indexOf('## Journaling protocol')
    expect(journalingIndex).toBeGreaterThan(constitutionIndex)
  })

  it('renders the absent sentinel plainly when journal mode is active but journaling.md does not exist', async () => {
    const prompt = await assembleSystemPrompt(
      fakeEngineWithContext({
        journalingProtocol:
          "journaling.md does not exist yet: this person has never set up journal mode before.",
      }),
      fakeConfig(),
      'journal',
    )
    expect(prompt).toContain('has never set up journal mode before')
  })

  it('is absent during the first conversation even if a mode was somehow passed', async () => {
    const prompt = await assembleSystemPrompt(
      fakeEngineWithContext({ isFirstSession: true, journalingProtocol: 'Should never render.' }),
      fakeConfig(),
      'journal',
    )
    expect(prompt).not.toContain('## Journaling protocol')
    expect(prompt).not.toContain('Should never render.')
  })
})
```

`fakeEngineWithContext` and `fakeConfig` are this plan's names for whatever helper `context.test.ts` already uses to build a `MemoryEngine`-shaped fake and a `ReverieConfig` fixture; find the real names with:

```bash
grep -n "function fakeEngine\|function makeEngine\|function fakeConfig\|function makeConfig" packages/core/src/context.test.ts
```

and use the real ones, passing `journalingProtocol` and `isFirstSession` the same way the file's existing tests pass `constitution` or other `SessionContext` fields into that fixture.

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/core/src/context.test.ts -t 'journalingProtocolSection'
```

Expected: the second test fails first, `## Journaling protocol` never appears in the prompt.

- [ ] **Step 3: Add the section function and wire it in**

```bash
grep -n "function constitutionSection" packages/core/src/context.ts
```

Add the new function directly after `constitutionSection`, on its exact pattern:

```ts
function journalingProtocolSection(context: SessionContext): string | undefined {
  if (context.journalingProtocol === undefined) return undefined
  return `## Journaling protocol\n\n${context.journalingProtocol}`
}
```

```bash
grep -n "sections = \[" packages/core/src/context.ts
```

Insert `journalingProtocolSection(context)` immediately after `constitutionSection(context)` in that array (both are identity-and-protocol documents read the same way, per the spec, and belong adjacent):

```ts
  const sections = [
    persona,
    // ...whatever section renders time now (the modes/time plans' replacement for todaySection)...
    constitutionSection(context),
    journalingProtocolSection(context),
    // ...every other existing section, unchanged, in its existing order...
  ].filter((section): section is string => section !== undefined)
```

Confirm the call to `engine.sessionContext(...)` inside `assembleSystemPrompt` passes the mode parameter through:

```bash
grep -n "engine.sessionContext(" packages/core/src/context.ts
```

If it does not already pass `mode`, change it to `engine.sessionContext(new Date(), mode)` (or the equivalent the modes/time plans left in place; the requirement is only that whatever mode `assembleSystemPrompt` itself received reaches `sessionContext` unchanged).

- [ ] **Step 4: Run and confirm all four tests pass**

```bash
pnpm vitest run packages/core/src/context.test.ts -t 'journalingProtocolSection'
```

Expected: 4 passed.

- [ ] **Step 5: Confirm the first-conversation branch is untouched**

```bash
grep -n "if (context.isFirstSession)" -A3 packages/core/src/context.ts
```

Confirm this branch's own returned array does not include `journalingProtocolSection`; it should still return only `[persona, <time section>, firstConversationSection()]` or whatever the modes/time plans left there. This is what step 1's fourth test checks; if it fails, the first-conversation branch was accidentally widened and must be reverted to excluding this section.

- [ ] **Step 6: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/context.ts packages/core/src/context.test.ts
git commit -m "Render the journaling protocol into the system prompt in journal mode

journalingProtocolSection mirrors constitutionSection exactly: absent
when there is nothing to say, otherwise a fixed heading plus the body.
Inserted immediately after the constitution section, since both are
identity-and-protocol documents read the same way. The first-conversation
branch is unaffected; onboarding takes over regardless of mode."
```

---

## Task 10: The journaling prompt content module

This is where the spec's six formats, their evidence statements, their prompt sequences, the first-time setup conversation guidance, the cadence disclosure, the agent activity level explanation, and the per-method safety gates actually become code the model reads. Every evidence claim below is transcribed from the spec's own wording; do not paraphrase or strengthen any of them; a method with thin or absent evidence must read as thin or absent here, per `AGENTS.md`'s honesty requirement and this plan's Global Constraints.

**Files**
- Create: `packages/core/src/journaling.ts`
- Create: `packages/core/src/journaling.test.ts`
- Modify: `packages/core/src/modes.ts` (the mode catalogue's `journal` entry)
- Modify: `packages/core/src/modes.test.ts`

**Interfaces**

Consumes: `JournalMethod` from `@openreverie/memory` (Task 3).

Before touching `modes.ts`, confirm its actual shape, since the modes plan's task list did not include creating it as of this plan's writing:

```bash
grep -n "export type ModeName\|export interface Mode\b\|journal" packages/core/src/modes.ts
```

Expected: a `Mode` interface roughly matching the journal mode spec's own citation of it (`{ id: ModeName; summary: string; clauses: Partial<Record<'engagement' | 'orientation', string>>; body?: string }`), a `journal` entry either absent from the catalogue array entirely (per that spec's own stated contingency: "If the journal spec has not shipped when this one does, journal is dropped from the catalogue") or present with empty or placeholder clauses. Either starting state is handled by step 7 below. If the actual shape differs meaningfully from this (a different field name for the per-axis text, for instance), adapt step 7's edit to match it; the intent (the `journal` catalogue entry's `engagement` and `orientation` clauses are both non-empty, built from this task's content) is what matters.

Produces:

```ts
// packages/core/src/journaling.ts
export interface JournalFormatContent {
  label: string        // plain-word label, e.g. "Gratitude", not "gratitude"
  evidence: string      // stated exactly as the spec states it, never overstated
  structure: string
  prompts: string[]
}

export const JOURNAL_FORMAT_CONTENT: Record<JournalMethod, JournalFormatContent>
export const FIRST_TIME_SETUP_GUIDANCE: string
export const CADENCE_DISCLOSURE_INSTRUCTION: string
export const AGENT_ACTIVITY_LEVEL_GUIDANCE: string
export const EXPRESSIVE_WRITING_SAFETY_GATE: string
export const PER_METHOD_SAFETY_NOTES: Record<JournalMethod, string>
export const JOURNAL_MODE_ENGAGEMENT_CLAUSE: string
export const JOURNAL_MODE_ORIENTATION_CLAUSE: string
export function buildJournalModeParagraph(journalingProtocol: string): string
```

- [ ] **Step 1: Write the failing content-presence tests**

Create `packages/core/src/journaling.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTIVITY_LEVEL_GUIDANCE,
  buildJournalModeParagraph,
  CADENCE_DISCLOSURE_INSTRUCTION,
  EXPRESSIVE_WRITING_SAFETY_GATE,
  FIRST_TIME_SETUP_GUIDANCE,
  JOURNAL_FORMAT_CONTENT,
  JOURNAL_MODE_ENGAGEMENT_CLAUSE,
  JOURNAL_MODE_ORIENTATION_CLAUSE,
  PER_METHOD_SAFETY_NOTES,
} from './journaling.js'

describe('journal format content, evidence stated honestly', () => {
  it('expressive writing states a real, replicated, small average effect, not a cure', () => {
    const content = JOURNAL_FORMAT_CONTENT.expressive_writing
    expect(content.evidence).toContain('200 studies')
    expect(content.evidence).toContain('d = 0.16')
    expect(content.evidence).not.toMatch(/cure|guarantee/i)
  })

  it('gratitude states the wallpaper effect and that the original study was weekly, not daily', () => {
    const content = JOURNAL_FORMAT_CONTENT.gratitude
    expect(content.evidence).toContain('weekly')
    expect(content.evidence).toContain('wallpaper effect')
    expect(content.evidence).toMatch(/3 to 4|three to four/)
  })

  it('the examen is described as thin but suggestive, one small study, not borrowed weight', () => {
    const content = JOURNAL_FORMAT_CONTENT.examen
    expect(content.evidence).toMatch(/thin/i)
    expect(content.evidence).toContain('n = 57')
    expect(content.evidence).not.toMatch(/well.?evidenced|well.?studied/i)
  })

  it('the thought record separates the general CBT evidence base from the worksheet in isolation', () => {
    const content = JOURNAL_FORMAT_CONTENT.thought_record
    expect(content.evidence).toMatch(/enormous evidence base/i)
    expect(content.evidence).toMatch(/thinly studied on its own|not separately validated/i)
  })

  it('morning pages states plainly that there are no clinical studies at all', () => {
    const content = JOURNAL_FORMAT_CONTENT.morning_pages
    expect(content.evidence).toMatch(/no clinical studies|never studied/i)
  })

  it('open format states that no evidence question applies to it', () => {
    const content = JOURNAL_FORMAT_CONTENT.open
    expect(content.evidence).toMatch(/not applicable|no research question/i)
  })

  it('every format label is a plain word, not the internal method key', () => {
    for (const method of Object.keys(JOURNAL_FORMAT_CONTENT) as (keyof typeof JOURNAL_FORMAT_CONTENT)[]) {
      expect(JOURNAL_FORMAT_CONTENT[method].label).not.toBe(method)
      expect(JOURNAL_FORMAT_CONTENT[method].label).not.toContain('_')
    }
  })

  it('gratitude carries exactly the shippable prompt sequence from the spec', () => {
    expect(JOURNAL_FORMAT_CONTENT.gratitude.prompts.length).toBeGreaterThanOrEqual(1)
    expect(JOURNAL_FORMAT_CONTENT.gratitude.prompts[0]).toMatch(/genuinely glad happened/)
  })

  it('the thought record prompt sequence accepts "I cannot find one yet" as a valid, complete answer', () => {
    const prompts = JOURNAL_FORMAT_CONTENT.thought_record.prompts.join(' ')
    expect(prompts).toMatch(/I can't find one yet|I cannot find one yet/)
  })
})

describe('cadence disclosure', () => {
  it('states the wallpaper-effect finding and instructs saying it once, then accepting the choice', () => {
    expect(CADENCE_DISCLOSURE_INSTRUCTION).toMatch(/three to four times a week|3 to 4 times a week/)
    expect(CADENCE_DISCLOSURE_INSTRUCTION).toMatch(/once/i)
    expect(CADENCE_DISCLOSURE_INSTRUCTION).not.toMatch(/every session|each time|recurring/i)
  })
})

describe('expressive writing safety gate', () => {
  it('instructs a crisis check before expressive writing is offered or started', () => {
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/crisis|suicidal/i)
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/before (it|expressive writing) (is|can be) offered|before offering/i)
  })

  it('instructs against offering it for very recent or acute trauma', () => {
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/acute|very recent/i)
  })

  it('requires the grounding close unconditionally, every session using this method', () => {
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/grounding|small, true thing/i)
  })
})

describe('per-method safety notes', () => {
  it('examen step 3 is skippable, with no pressure to resolve it in-session', () => {
    expect(PER_METHOD_SAFETY_NOTES.examen).toMatch(/skippable/i)
    expect(PER_METHOD_SAFETY_NOTES.examen).toMatch(/no pressure/i)
  })

  it('the thought record note forbids pushing for a positive reframe once the person has said they cannot find one', () => {
    expect(PER_METHOD_SAFETY_NOTES.thought_record).toMatch(/do not push|not push/i)
  })

  it('gratitude states plainly it has no method-specific gate', () => {
    expect(PER_METHOD_SAFETY_NOTES.gratitude).toMatch(/no method-specific gate/i)
  })

  it('morning pages and open format both name the ordinary crisis pathway, with no method-specific gate beyond it', () => {
    expect(PER_METHOD_SAFETY_NOTES.morning_pages).toMatch(/crisis judgment/i)
    expect(PER_METHOD_SAFETY_NOTES.open).toMatch(/crisis judgment/i)
  })
})

describe('agent activity level', () => {
  it('explains the axis is separate from style.engagement', () => {
    expect(AGENT_ACTIVITY_LEVEL_GUIDANCE).toMatch(/style\.engagement|separate from/i)
  })
})

describe('first-time setup guidance', () => {
  it('never presents journaling as a substitute for therapy', () => {
    expect(FIRST_TIME_SETUP_GUIDANCE).toMatch(/not a substitute for therapy/i)
  })

  it('names the examen as the reasonable default when nothing points elsewhere', () => {
    expect(FIRST_TIME_SETUP_GUIDANCE).toMatch(/examen.*default|default.*examen/is)
  })
})

describe('buildJournalModeParagraph', () => {
  it('always contains the expressive writing safety gate, regardless of journaling.md content', () => {
    const paragraph = buildJournalModeParagraph('Gratitude, three times a week.')
    expect(paragraph).toContain(EXPRESSIVE_WRITING_SAFETY_GATE)
  })

  it('always contains the cadence disclosure instruction', () => {
    const paragraph = buildJournalModeParagraph('Examen, most evenings.')
    expect(paragraph).toContain(CADENCE_DISCLOSURE_INSTRUCTION)
  })

  it('includes the journaling.md content it was given', () => {
    const paragraph = buildJournalModeParagraph('A specific configured protocol, verbatim.')
    expect(paragraph).toContain('A specific configured protocol, verbatim.')
  })

  it('includes every method\'s per-method safety note, examen\'s skippability included', () => {
    const paragraph = buildJournalModeParagraph('Examen, most evenings.')
    expect(paragraph).toContain(PER_METHOD_SAFETY_NOTES.examen)
    expect(paragraph).toContain(PER_METHOD_SAFETY_NOTES.thought_record)
  })

  it('covers both axes journal mode suppresses: engagement and orientation', () => {
    expect(JOURNAL_MODE_ENGAGEMENT_CLAUSE.length).toBeGreaterThan(0)
    expect(JOURNAL_MODE_ORIENTATION_CLAUSE.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/core/src/journaling.test.ts
```

Expected: `Cannot find module './journaling.js'`.

- [ ] **Step 3: Write the content module**

Create `packages/core/src/journaling.ts`:

```ts
// Static prompt content for journal mode: the six formats' evidence and
// prompt sequences, the first-time setup conversation guidance, the
// cadence disclosure, the agent activity level explanation, and the
// expressive-writing safety gate. Every evidence statement here is
// transcribed from the journal mode spec's own wording (section 5) and
// must stay that way: a method with thin or absent evidence reads as
// thin or absent here, not borrowed weight from a better-studied one.

import type { JournalMethod } from '@openreverie/memory'

export interface JournalFormatContent {
  label: string
  evidence: string
  structure: string
  prompts: string[]
}

export const JOURNAL_FORMAT_CONTENT: Record<JournalMethod, JournalFormatContent> = {
  expressive_writing: {
    label: 'Expressive Writing',
    evidence:
      'The best evidenced of the six formats. Over 200 studies and multiple meta-analyses show a real but ' +
      'modest average effect (around d = 0.16), with real heterogeneity across studies and populations. Read as: ' +
      'real, replicated, small on average, not a cure.',
    structure:
      'Write continuously for 15 to 20 minutes on the same difficult topic, across 4 consecutive days. Include ' +
      'facts, thoughts, and feelings about it. Ignore grammar and spelling entirely; this is not for anyone else ' +
      'to read.',
    prompts: [
      "What's something that's been weighing on you that you haven't fully let yourself think through? Write " +
        'about it for the next 15 to 20 minutes: what happened, what you think about it, and how it makes you ' +
        "feel. Don't worry about grammar or whether it makes sense to anyone else. Just keep writing.",
      "Same topic as before. Write again, for the same length of time. It's fine if today's version says " +
        "something different than yesterday's.",
      "Before we stop, take a breath. What's one small, true thing that's okay right now, even next to all of " +
        'that?',
    ],
  },
  gratitude: {
    label: 'Gratitude',
    evidence:
      'Well replicated, modest effect (g roughly 0.19 to 0.22). The original study used weekly journaling, not ' +
      'daily. A 2025 meta-analysis found that 3 to 4 times a week outperforms daily practice, attributed to a ' +
      '"wallpaper effect" where daily repetition of the same kind of entry stops registering emotionally.',
    structure:
      'List a small number of things (3 is typical) the person is grateful for, with enough specificity to be ' +
      'more than a label.',
    prompts: [
      "What are a few things from the last few days that you're genuinely glad happened, big or small?",
      'For each one raised, one light follow-up, only if it feels natural, not mechanically for every item: ' +
        'What made that one land for you?',
    ],
  },
  examen: {
    label: 'Daily Examen',
    evidence:
      'Thin but suggestive. One small randomized controlled trial (n = 57 students, a 2-week secularized ' +
      'version) found gains in meaning in life, life satisfaction, and hope. That is one study, small, on a ' +
      'specific population, not the evidence base expressive writing or gratitude have. Say so plainly rather ' +
      "than borrowing gratitude's or CBT's weight for it.",
    structure:
      'Five steps, in order: notice how you feel right now; review the day with gratitude; notice one moment ' +
      'that stirred strong emotion; reflect on what that moment is telling you; look to tomorrow with intention.',
    prompts: [
      'Before we look back at the day, just notice: how are you feeling right now, in this moment?',
      'Walking back through today, what are you grateful for, even something small?',
      'Was there a moment today that stirred something strong in you, good or hard?',
      'What do you think that moment is telling you?',
      'Looking ahead to tomorrow, is there anything you want to carry into it, or set an intention about?',
    ],
  },
  thought_record: {
    label: 'CBT Thought Record',
    evidence:
      'CBT as a whole has an enormous evidence base across decades and populations. The thought record ' +
      'specifically, used in isolation from the rest of a CBT course or a therapist, is thinly studied on its ' +
      'own and not separately validated. State the general claim (CBT is well evidenced) and the specific one ' +
      '(this worksheet in isolation is not) without letting the general claim imply the specific one.',
    structure:
      'Situation; emotion and its intensity (0 to 100); the automatic thought; evidence for it; evidence ' +
      'against it; a more balanced alternative thought; re-rate the emotion.',
    prompts: [
      "What's the situation you want to look at?",
      'What did you feel in that moment, and how strong was it, from 0 to 100?',
      'What was the thought that went through your mind right then?',
      "What's the evidence that thought is true?",
      "What's the evidence against it, or that complicates it?",
      "Given both sides, is there a more balanced way to put it? If the person says \"I can't find one yet,\" " +
        'that is a valid, complete answer. Do not push for a positive reframe once they have said this.',
      'If they found an alternative thought to hold: if you re-rate that original feeling now, where is it, ' +
        '0 to 100? Skip this if the previous answer was "I can\'t find one yet."',
    ],
  },
  morning_pages: {
    label: 'Morning Pages',
    evidence:
      'No clinical studies. Widely practiced, popular, part of a specific creative recovery tradition (The ' +
      "Artist's Way, 1992), but never studied. State this as widely loved, never studied, not as a lesser " +
      'version of the other methods, and never omit the absence of evidence.',
    structure:
      'Three pages, stream of consciousness, no editing, done first thing in the morning, 20 to 40 minutes.',
    prompts: [
      "Whenever you're ready, just start writing. Doesn't need to go anywhere, doesn't need to make sense. " +
        'Three pages or however long feels right.',
    ],
  },
  open: {
    label: 'Open format',
    evidence:
      'Not applicable. This is not a method with a research question attached to it; it is the absence of one.',
    structure:
      'None. The person asked for exactly this: a place to record thoughts with no ritual constraints.',
    prompts: ["Go ahead, write whatever's on your mind. No structure offered unless asked for."],
  },
}

export const FIRST_TIME_SETUP_GUIDANCE = `This is the first time this person wants to journal, or journaling.md still holds no real setup. Have a conversation, not a form: ask what they are hoping to get out of journaling right now (processing something specific, building a regular habit, a place to think without an audience), then briefly and honestly describe the six options in plain terms using the evidence exactly as it is stated for each one: expressive writing and gratitude are well studied, the examen is thin but suggestive, the thought record is well evidenced as a broader practice but not validated in isolation, morning pages is widely loved but never studied, and open format carries no research question at all. Make a suggestion based on what they said: the examen is the reasonable default when nothing points elsewhere, because its fixed question sequence suits a conversational agent best; suggest expressive writing when they specifically want to process something difficult, once the safety gate below is confirmed clear; suggest gratitude for a lighter regular practice; suggest morning pages or open format when they say, in effect, they just want to write with no interest in structure. Ask whether they want prompts or freeform if that is not already implied. Propose a cadence per the format's own evidence and adjust to what they want, applying the cadence disclosure below when it is relevant. Ask roughly how long they want sessions to run, and how active they want you to be during a session (prompting and pushing gently, or mostly staying quiet). Once the conversation actually concludes, write journaling.md in full prose, not a bullet list of settings, through update_journaling_protocol. State once, plainly, in this conversation, that journaling is never a substitute for therapy; do not repeat that disclaimer every session.`

export const CADENCE_DISCLOSURE_INSTRUCTION = `If the person is choosing or leaning toward gratitude journaling, mention once, plainly, that the research on gratitude journaling found three to four times a week works better than daily: people tend to stop really feeling it once it becomes an everyday thing (a "wallpaper effect"). Say this once, in the conversation where the cadence is actually being chosen, then accept whatever the person decides, including daily if that is still what they want. This is a single, honest disclosure, not a recurring nag: do not repeat it in later sessions once it has been made.`

export const AGENT_ACTIVITY_LEVEL_GUIDANCE = `journaling.md may state an agent activity level for journal sessions, separate from and orthogonal to the person's general style.engagement setting: style.engagement governs ordinary conversation, while this axis governs only how much you nudge within the chosen journaling method itself. "Active" means prompting through the sequence, following up with genuine curiosity, and gently pushing deeper when the person seems to be skimming the surface. "Hang back" means offering the opening prompt (or nothing, for morning pages and open format) and otherwise staying quiet, checking in only if the person seems to want a response or seems to have stopped. This can be set per method, not only once globally; read journaling.md's own wording for it rather than assuming one global value. Regardless of any configured level, default toward hang back during morning pages specifically, since prompting works against that method's own premise.`

export const EXPRESSIVE_WRITING_SAFETY_GATE = `Expressive writing carries a real, documented short-term risk: it reliably raises negative affect and physiological arousal before any benefit appears. Before offering expressive writing as a choice, or before starting a session using it, check for active crisis or suicidal thinking in the current conversation using ordinary judgment, not a keyword scan; if that judgment says the person is in crisis territory right now, do not offer expressive writing, and let the active safety mode's normal crisis stance take over instead. Do not offer expressive writing for very recent or acute trauma without clinical support in the picture; if what the person describes just happened and sounds acute, say plainly that this method is meant for something with some distance from it, and suggest waiting or a different method. Cap a session at 15 to 20 minutes of continuous writing; do not extend it. Never make a person feel they owe the rest of a 4-day arc if they stop after day 1 or partway through. Every session using this method closes with the grounding prompt, unconditionally, before the session ends: before we stop, take a breath, what's one small, true thing that's okay right now, even next to all of that.`

export const JOURNAL_MODE_ENGAGEMENT_CLAUSE = `Engagement in journal mode is about how much you nudge within the chosen writing method itself, not about raising unrelated threads: track which prompts in the method's own sequence have been covered as a running tally for this conversation, and raise an uncovered one as the session winds down rather than firing every question up front. Back off toward closing when you sense resistance (short answers, a change of subject, "I don't want to get into that") or when the person says they are done; backing off means moving toward closing, not repeating the same prompt more gently. If prompts remain uncovered and the person still seems willing, raise the last one once, plainly, framed as optional.`

export const JOURNAL_MODE_ORIENTATION_CLAUSE = `Orientation in journal mode is the chosen method's own structure, not your usual listening-versus-solving axis: follow the method's prompt sequence (or offer no structure at all, for open format and morning pages) rather than steering toward advice or a next step. The point of a journal entry is the person's own writing.`

// Per spec section 10: every method beyond expressive writing (which gets
// its own dedicated constant above, since its gate is the heaviest) has
// its own, smaller safety note. Gratitude's note says plainly that there
// is none, so buildJournalModeParagraph never has to special-case an
// absent entry.
export const PER_METHOD_SAFETY_NOTES: Record<JournalMethod, string> = {
  expressive_writing: 'See the dedicated expressive writing safety gate above; it is not repeated here.',
  gratitude: 'No method-specific gate. Gratitude is the lowest-risk of the six by construction.',
  examen:
    "Step 3 (the moment that stirred strong emotion) is skippable, with no pressure to resolve it in-session. " +
    "If it surfaces real distress, ordinary crisis judgment applies as it would in any conversation; otherwise " +
    "you can simply move to step 5 if the person wants to skip it.",
  thought_record:
    '"I can\'t find one yet" is a valid, complete answer to the balanced-thought step. Do not push for a ' +
    "positive reframe once the person has said this; forcing one is invalidating and a known failure mode of " +
    "this method done badly.",
  morning_pages:
    "Unprompted by design, so heavy material can surface with no warning. Ordinary crisis judgment applies " +
    "exactly as it would in any other conversation; there is no method-specific gate beyond that, because there " +
    "is no structure here to gate.",
  open:
    "Unprompted by design, so heavy material can surface with no warning. Ordinary crisis judgment applies " +
    "exactly as it would in any other conversation; there is no method-specific gate beyond that, because there " +
    "is no structure here to gate.",
}

// The one place these pieces are assembled into the paragraph the mode
// catalogue's journal entry renders. journalingProtocol is the session's
// SessionContext.journalingProtocol (Task 8): either the person's actual
// configured setup or the JOURNALING_PROTOCOL_ABSENT sentinel. That value
// already reaches the model through journalingProtocolSection (Task 9);
// it is repeated here too because this paragraph is what the mode
// catalogue renders regardless of whether journalingProtocolSection's own
// insertion point changes later, and duplication of a short, already-
// rendered string costs little next to the risk of the mode paragraph
// saying nothing about it at all.
// Per-method safety notes are rendered for all six methods, unconditionally,
// rather than only for whichever one the session actually declared: the
// content module has no reliable, always-current signal for which method
// is active at the moment the persona is assembled (declare_journal_method,
// Task 5, is read only at end-of-session by _doEndSession, not threaded
// into prompt assembly), and repeating all six short notes is a small,
// safe redundancy next to the alternative of silently guessing one.
function renderPerMethodSafetyNotes(): string {
  const lines = (Object.keys(JOURNAL_FORMAT_CONTENT) as JournalMethod[]).map(
    (method) => `${JOURNAL_FORMAT_CONTENT[method].label}: ${PER_METHOD_SAFETY_NOTES[method]}`,
  )
  return ['Per-method safety notes:', ...lines].join('\n')
}

export function buildJournalModeParagraph(journalingProtocol: string): string {
  return [
    'You are running a journal-mode session: structured written reflection using a method the person chose.',
    `Their configured setup: ${journalingProtocol}`,
    FIRST_TIME_SETUP_GUIDANCE,
    CADENCE_DISCLOSURE_INSTRUCTION,
    AGENT_ACTIVITY_LEVEL_GUIDANCE,
    EXPRESSIVE_WRITING_SAFETY_GATE,
    renderPerMethodSafetyNotes(),
    JOURNAL_MODE_ENGAGEMENT_CLAUSE,
    JOURNAL_MODE_ORIENTATION_CLAUSE,
  ].join('\n\n')
}
```

- [ ] **Step 4: Run and confirm the tests pass**

```bash
pnpm vitest run packages/core/src/journaling.test.ts
```

Expected: every test passes. If any evidence-statement test fails on a specific phrase, adjust the wording in `JOURNAL_FORMAT_CONTENT` to match the spec's own phrasing more closely rather than loosening the test; the test exists to keep this file honest against section 5 of the spec, not the other way round.

- [ ] **Step 5: Confirm `@openreverie/memory` exports `JournalMethod`**

```bash
grep -n "export.*JournalMethod" packages/memory/src/index.ts packages/memory/src/journal.ts
```

If `packages/memory/src/index.ts` does not yet re-export `./journal.js`, add `export * from './journal.js'` there (matching the pattern already used for the package's other modules; check with `grep -n "export \* from" packages/memory/src/index.ts`).

- [ ] **Step 6: Build and lint**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 7: Wire the content into the mode paragraph, as dynamic content, not a static catalogue entry**

Every other mode's paragraph is a fixed string, known at catalogue-definition time. Journal mode's paragraph is not: spec section 5.1 of the modes design says it "supplies the paragraph, built from journaling.md and the chosen format," which is per-session content, not something a static `Mode.body` string can hold. Find how the modes plan actually renders a mode's paragraph into the persona:

```bash
grep -n "export type ModeName\|interface Mode\b\|function modeSection\|modeSection(" packages/core/src/modes.ts packages/core/src/personas.ts
```

Two things to confirm from that output:
1. Whether `journal` has a catalogue entry at all. If the modes plan followed its own spec's contingency ("if the journal spec has not shipped when this one does, journal is dropped from the catalogue"), it will be absent; add one with `summary: 'Structured written reflection.'` and `clauses` left as an empty object (not omitted; the type likely requires the key), since journal's clauses are rendered dynamically rather than read from this static entry.
2. The signature of whatever function turns the active mode into the paragraph text that gets inserted into `buildPersona`'s section list (this plan calls it `modeSection` above; adapt to the real name).

Change that function (or add a special case inside it) so that when the active mode is `journal`, it calls `buildJournalModeParagraph` with the session's actual journaling protocol, instead of reading a static string off the catalogue entry:

```ts
function modeSection(activeMode: ModeName | undefined, journalingProtocol: string | undefined): string | undefined {
  if (!activeMode || activeMode === 'general') return undefined
  if (activeMode === 'journal') {
    return buildJournalModeParagraph(journalingProtocol ?? JOURNALING_PROTOCOL_ABSENT)
  }
  // ...whatever this function already does for the other nine modes,
  // reading their static clauses/body off the catalogue, unchanged...
}
```

This means `buildPersona` (and therefore `assembleSystemPrompt`) needs the session's journaling protocol string threaded down to it, one parameter further than the modes plan's own signature carries by itself. Find the current signature:

```bash
grep -n "export function buildPersona" packages/core/src/personas.ts
grep -n "export async function assembleSystemPrompt" packages/core/src/context.ts
```

Add one optional parameter to each, threaded through:

```ts
// packages/core/src/personas.ts
export function buildPersona(
  mode: PersonaMode,
  resources: CrisisResource[],
  style: StyleConfig,
  activeMode?: ModeName,
  journalingProtocol?: string,
): string
```

```ts
// packages/core/src/context.ts, inside assembleSystemPrompt
const persona = buildPersona(
  config.safety.mode,
  config.safety.resources,
  config.style,
  activeMode,
  context.journalingProtocol,
)
```

(`activeMode` above is whatever parameter name the modes plan already added to `assembleSystemPrompt` for the active mode; reuse it, do not add a second one.) This keeps the invariant modes spec section 8 requires intact by construction: the journal paragraph, however its content is built, is inserted at the exact same slot in `buildPersona`'s section list every other mode's paragraph is, strictly before `crisisSection`, so the crisis section stays the last section of `buildPersona`'s own output regardless of which mode is active or what that mode's paragraph says.

Add `JOURNAL_MODE_ENGAGEMENT_CLAUSE` and `JOURNAL_MODE_ORIENTATION_CLAUSE` from Task 10 to the catalogue's `journal` entry's `clauses` anyway, even though the dynamic path above does not read them: the modes plan's own catalogue-shape tests (the ones asserting "every suppressed axis has a non-empty clause") check the static catalogue, not the rendered output, and an empty `clauses` object on `journal` would fail that test for a reason unrelated to anything this plan is actually testing.

- [ ] **Step 8: Add or update the catalogue shape test**

```bash
grep -n "describe.*catalogue\|clause completeness\|axis restriction" packages/core/src/modes.test.ts
```

Add a case for `journal` to whatever table-driven test already checks "every suppressed axis has a non-empty clause" (per the modes plan's own testing section); if `journal` is already included in that table because the modes plan wrote it generically over `Object.values(catalogue)`, no change is needed here beyond confirming the existing test now passes for it:

```bash
pnpm vitest run packages/core/src/modes.test.ts
```

Expected: full pass, including whatever pre-existing case iterates over every mode's suppressed axes.

- [ ] **Step 9: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/journaling.ts packages/core/src/journaling.test.ts packages/core/src/modes.ts packages/core/src/modes.test.ts
git commit -m "Add the journaling prompt content module and wire it into the mode catalogue

Evidence statements are transcribed from the spec's own wording, tested
so a paraphrase that overstates or understates any method's evidence
fails. The expressive-writing safety gate and the cadence disclosure
are always present in the assembled paragraph, not conditional on any
runtime branch, since the actual crisis judgment happens in the model
at inference time, not in this code."
```

---

## Task 11: `update_journaling_protocol`, the live tool, and its `refreshSystemPrompt` trigger

**Files**
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/agent.test.ts`

**Interfaces**

Consumes: `writeJournalingProtocol` (Task 7). Confirm `AgentSession.refreshSystemPrompt` exists before touching `agent.ts`:

```bash
grep -n "refreshSystemPrompt" packages/core/src/agent.ts
```

Expected: a public method, already used by `/style` or the settings pane's write path. If it does not exist, the modes plan has not landed section 9.2 of its own spec; stop and report it.

Produces: nothing new for later tasks; this is a leaf.

- [ ] **Step 1: Write the failing engine test**

Add to `packages/memory/src/engine.test.ts`, inside a new `describe('updateJournalingProtocol', ...)` block:

```ts
  describe('updateJournalingProtocol', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-updatejournaling-'))
      paths = memoryPaths(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('writes journaling.md on the first call and reindexes it', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const doc = await engine.updateJournalingProtocol('Gratitude, three times a week.')
      expect(doc.body.trim()).toBe('Gratitude, three times a week.')
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journaling')?.docId).toBe(doc.meta.id)
      await engine.close()
    })

    it('preserves the id and replaces the body on a second call', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const first = await engine.updateJournalingProtocol('Gratitude, three times a week.')
      const second = await engine.updateJournalingProtocol('Switched to the examen instead.')
      expect(second.meta.id).toBe(first.meta.id)
      expect(second.body).not.toContain('Gratitude')
      await engine.close()
    })
  })
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'updateJournalingProtocol'
```

Expected: `engine.updateJournalingProtocol is not a function`.

- [ ] **Step 3: Add the engine method**

```bash
grep -n "async setSessionJournalMethod" packages/memory/src/engine.ts
```

Add next to it:

```ts
  // The live-tool half of the journaling.md rewrite mechanism (spec
  // section 4.5). Writes through the same shared helper reflection's
  // journalingUpdate uses (Task 12), then reindexes so search stays
  // current; reflection's own path reindexes separately, inside
  // _doEndSession, on the same pattern the constitution update already
  // uses.
  async updateJournalingProtocol(body: string): Promise<Document> {
    const doc = await writeJournalingProtocol(this.paths, body, new Date())
    await this.reindexOrWarn(doc, 'journaling', 'live update_journaling_protocol call')
    return doc
  }
```

Add `writeJournalingProtocol` to the file's import from `./journal.js` if not already present from Task 8.

- [ ] **Step 4: Run and confirm the engine tests pass**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'updateJournalingProtocol'
```

Expected: 2 passed.

- [ ] **Step 5: Add the tool**

```bash
grep -n "case 'remember':" packages/core/src/tools.ts
```

Add the args schema next to `rememberArgs`:

```ts
const updateJournalingProtocolArgs = z.strictObject({
  body: z.string(),
})
```

Add the tool definition to `toolDefinitions()`, near `declare_journal_method` (Task 5):

```ts
    {
      name: 'update_journaling_protocol',
      description:
        'Rewrite journaling.md, the person\'s journaling setup: chosen method or methods and their cadence, ' +
        'prompt style, session length, and how active you should be during a session. Call this with the ' +
        'complete new document body, full prose, a whole rewrite, never a diff or an append, and only after an ' +
        'actual conversation about what changed (the first-time setup conversation, or a later request to ' +
        'revise it). Available in every session, not only journal-mode ones, since the person can ask to change ' +
        'their setup from an ordinary conversation too.',
      parameters: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: 'The complete new body of journaling.md, in prose, replacing whatever was there before.',
          },
        },
        required: ['body'],
        additionalProperties: false,
      },
    },
```

Add the dispatch case and handler, next to `declare_journal_method`'s:

```ts
      case 'update_journaling_protocol':
        return await dispatchUpdateJournalingProtocol(engine, parsedArgs.value)
```

```ts
async function dispatchUpdateJournalingProtocol(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = updateJournalingProtocolArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('update_journaling_protocol', parsed.error))

  const doc = await engine.updateJournalingProtocol(parsed.data.body)
  return JSON.stringify({ ok: true, updated: doc.meta.updated })
}
```

- [ ] **Step 6: Write the failing tool test, then confirm it passes**

Add to `packages/core/src/tools.test.ts`, near the `declare_journal_method` tests from Task 5:

```ts
it('update_journaling_protocol rewrites the document and reports ok', async () => {
  const engine = await openTestEngine()
  const sessionId = await engine.startSession()
  const result = await dispatchTool(engine, sessionId, {
    id: 'call_1',
    name: 'update_journaling_protocol',
    arguments: JSON.stringify({ body: 'Gratitude, three times a week.' }),
  })
  expect(JSON.parse(result).ok).toBe(true)
  const rows = await engine.listPublicDocuments()
  expect(rows.find((row) => row.kind === 'journaling')).toBeDefined()
})
```

```bash
pnpm vitest run packages/core/src/tools.test.ts -t 'update_journaling_protocol'
```

Expected: 1 passed.

- [ ] **Step 7: Write the failing `refreshSystemPrompt` trigger test**

```bash
grep -n "refreshSystemPrompt\|toolCall.name ===" packages/core/src/agent.ts
```

Find `AgentSession`'s tool dispatch loop and the existing pattern for a tool that must trigger reassembly (most likely `set_mode`, per the modes plan). Add to `packages/core/src/agent.test.ts`, near whatever test already covers that reassembly (find it with `grep -n "refreshSystemPrompt\|system prompt.*after" packages/core/src/agent.test.ts | head -10`):

```ts
it('reassembles the system prompt after a successful update_journaling_protocol call', async () => {
  // Build a fake chat provider whose first response is a tool call to
  // update_journaling_protocol, and whose second response is plain text.
  // Reuse this file's existing helper for scripting a tool-call turn;
  // find it with: grep -n "toolCalls:" packages/core/src/agent.test.ts | head -10
  const chat = fakeChatWithToolCall({
    name: 'update_journaling_protocol',
    arguments: { body: 'Gratitude, three times a week.' },
  })
  const engine = await openTestEngine()
  const session = await AgentSession.start(engine, testConfig(), chat)
  const events = []
  for await (const event of session.send('Let\'s set up journaling.')) events.push(event)
  // The system prompt used for the request AFTER the tool call must
  // differ from the one used for the request that produced the tool
  // call, since journaling.md changed in between.
  expect(chat.requests[1]?.system).not.toBe(chat.requests[0]?.system)
  expect(chat.requests[1]?.system).toContain('Gratitude, three times a week.')
})
```

Adapt the helper names (`fakeChatWithToolCall`, `openTestEngine`, `testConfig`) to whatever `agent.test.ts` actually already has; the assertion (the second request's `system` string differs from the first and contains the new body) is what matters. Run:

```bash
pnpm vitest run packages/core/src/agent.test.ts -t 'reassembles the system prompt after a successful update_journaling_protocol'
```

Expected: FAIL, the two system strings are identical, since nothing calls `refreshSystemPrompt()` for this tool name yet.

- [ ] **Step 8: Add the trigger**

In `AgentSession`'s tool dispatch loop (found above), add a branch alongside whatever already exists for `set_mode` (do not replace that branch; add a sibling one):

```ts
        if (toolCall.name === 'update_journaling_protocol' && !this.resultHasError(result)) {
          await this.refreshSystemPrompt()
        }
```

If `resultHasError` is named differently by the time this runs, use the real name; its job (parse the JSON result, return true if it has an `error` key) is unchanged from what it does for the tool this file already checks it against.

- [ ] **Step 9: Run and confirm it passes**

```bash
pnpm vitest run packages/core/src/agent.test.ts -t 'reassembles the system prompt after a successful update_journaling_protocol'
```

Expected: 1 passed.

- [ ] **Step 10: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 11: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts packages/core/src/tools.ts packages/core/src/tools.test.ts packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "Add update_journaling_protocol, live-writable from any session

Writes through the same shared helper reflection's journalingUpdate
uses, so both surfaces stay one implementation. A successful call
reassembles the live system prompt immediately, the same way a
settings-pane profile write does, so a mid-session revision takes
effect on the very next turn instead of waiting for a session that has
not started yet."
```

---

## Task 12: Reflection's `journalingUpdate` field, the backstop path

**Files**
- Modify: `packages/memory/src/reflection.ts`
- Modify: `packages/memory/src/reflection.test.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Consumes: `writeJournalingProtocol`, `readJournalingProtocolIfPresent` (Task 7).

Produces: nothing new for later tasks in this plan; `journalingUpdate` is consumed only by `applyReflection` and `_doEndSession` themselves.

**This task widens a required field on `ReflectionOutput`, which breaks every existing literal of that shape in the test suite until they are updated.** Both `packages/memory/src/engine.test.ts` and `packages/memory/src/reflection.test.ts` define a shared `emptyReflectionOutput(summary)` helper that every scripted-reflection test builds from. Both must be updated in this same task, in the same commit, or the build stays red between steps.

- [ ] **Step 1: Write the failing schema test**

Add to `packages/memory/src/reflection.test.ts`, inside the existing `describe('reflectionOutputSchema', ...)` block:

```ts
  it('accepts journalingUpdate as null', () => {
    const out: ReflectionOutput = { ...emptyReflectionOutput('A session.'), journalingUpdate: null }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('accepts journalingUpdate as a full replacement body', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      journalingUpdate: 'Switched from gratitude to the examen.',
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('rejects a whole output missing journalingUpdate entirely', () => {
    const { journalingUpdate, ...rest } = { ...emptyReflectionOutput('A session.'), journalingUpdate: null }
    expect(reflectionOutputSchema.safeParse(rest).success).toBe(false)
  })
```

- [ ] **Step 2: Run and confirm the failure**

```bash
pnpm vitest run packages/memory/src/reflection.test.ts -t 'journalingUpdate'
```

Expected: a TypeScript error (`journalingUpdate` does not exist on `ReflectionOutput`) or, once the test compiles against the widened local literal, a schema-parse failure because `reflectionOutputSchema` does not know the key.

- [ ] **Step 3: Widen `ReflectionOutput`, its schema, and `RESPONSE_SHAPE`**

```bash
grep -n "constitutionUpdate: string | null" packages/memory/src/reflection.ts
```

Add the field to the interface, directly after `constitutionUpdate`:

```ts
export interface ReflectionOutput {
  // ...every existing field, unchanged...
  constitutionUpdate: string | null
  // The backstop half of the journaling.md rewrite mechanism (spec
  // section 4.5): null when nothing about the person's journaling setup
  // changed this session, otherwise the full new document body. The live
  // update_journaling_protocol tool is the primary path; this exists for
  // a session where the person clearly renegotiated their setup but the
  // model never called that tool for it.
  journalingUpdate: string | null
}
```

Add the matching line to `reflectionOutputSchema`:

```ts
  constitutionUpdate: z.string().nullable(),
  journalingUpdate: z.string().nullable(),
```

Add the matching line to `RESPONSE_SHAPE`:

```ts
  "constitutionUpdate": string | null,
  "journalingUpdate": string | null
```

(Adjust the trailing comma on whichever of the two was previously last in that template literal.)

- [ ] **Step 4: Update the shared `emptyReflectionOutput` helper in both test files**

```bash
grep -rn "function emptyReflectionOutput" packages/memory/src/
```

In both `packages/memory/src/reflection.test.ts` and `packages/memory/src/engine.test.ts`, add the field to the helper's returned object:

```ts
function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    newEntities: [],
    pagePromotions: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
    journalingUpdate: null,
  }
}
```

- [ ] **Step 5: Run and confirm the schema tests pass, and the full suite still compiles**

```bash
pnpm vitest run packages/memory/src/reflection.test.ts -t 'journalingUpdate'
pnpm test
```

Expected: 3 passed for the new tests, full suite green (every other test using `emptyReflectionOutput` now gets `journalingUpdate: null` for free).

- [ ] **Step 6: Add the reflection prompt's own journaling context**

```bash
grep -n "export interface ReflectionContext" -A10 packages/memory/src/reflection.ts
```

Add one field:

```ts
export interface ReflectionContext {
  // ...every existing field, unchanged...
  // undefined when journaling.md does not exist, so the prompt can tell
  // "not yet set up" apart from "already correct"; never the
  // JOURNALING_PROTOCOL_ABSENT sentinel here, since that sentinel is
  // written for the chat model's own journal-mode session, not for
  // reflection's very different prompt.
  journalingProtocol?: string
}
```

```bash
grep -n "function buildReflectionPrompt" packages/memory/src/reflection.ts
```

Add a short paragraph to the prompt, after the "Known entities" block and before the transcript:

```ts
    'Current journaling setup:',
    context.journalingProtocol ?? '(not set up yet: this person has never journaled before)',
    '',
```

- [ ] **Step 7: Write the failing fixture test for the reflection prompt**

Add to `packages/memory/src/reflection.test.ts`, inside `describe('reflectSession', ...)`:

```ts
    it('includes the current journaling setup, or its absence, in the prompt', async () => {
      const out = emptyReflectionOutput('A session about switching journaling methods.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        journalingProtocol: 'Gratitude, three times a week.',
      })
      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('Gratitude, three times a week.')
    })

    it('states journaling is not yet set up when journalingProtocol is absent', async () => {
      const out = emptyReflectionOutput('A first session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
      })
      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('never journaled before')
    })
```

```bash
pnpm vitest run packages/memory/src/reflection.test.ts -t 'journaling setup'
```

Expected after step 6: 2 passed.

- [ ] **Step 8: Write the failing test for `applyReflection` actually writing `journalingUpdate`**

Add to `packages/memory/src/reflection.test.ts`, inside a `describe('applyReflection', ...)` block (find it with `grep -n "describe('applyReflection'" packages/memory/src/reflection.test.ts`; reuse its existing `paths`/`sessionId`/`sessionDir` setup from `beforeEach`):

```ts
    it('writes journaling.md when journalingUpdate is set, preserving the id on a second write', async () => {
      const first = {
        ...emptyReflectionOutput('First session about journaling.'),
        journalingUpdate: 'Gratitude, three times a week.',
      }
      await applyReflection(paths, first, sessionId, [], new Date('2026-08-16T21:00:00.000Z'), new Map(), noopMaterialize)
      const firstDoc = await readDocument(paths.journaling)
      expect(firstDoc.body.trim()).toBe('Gratitude, three times a week.')

      const secondSessionId = newId('session')
      const secondSessionDir = join(paths.sessionsDir, `2026-08-17-${secondSessionId}`)
      await mkdir(secondSessionDir, { recursive: true })
      const second = {
        ...emptyReflectionOutput('Second session, switched methods.'),
        journalingUpdate: 'Switched to the examen.',
      }
      await applyReflection(paths, second, secondSessionId, [], new Date('2026-08-17T10:00:00.000Z'), new Map(), noopMaterialize)
      const secondDoc = await readDocument(paths.journaling)
      expect(secondDoc.meta.id).toBe(firstDoc.meta.id)
      expect(secondDoc.body.trim()).toBe('Switched to the examen.')
    })

    it('leaves journaling.md untouched when journalingUpdate is null', async () => {
      const out = emptyReflectionOutput('An ordinary session, nothing about journaling.')
      await applyReflection(paths, out, sessionId, [], new Date(), new Map(), noopMaterialize)
      await expect(readDocument(paths.journaling)).rejects.toThrow()
    })
```

```bash
pnpm vitest run packages/memory/src/reflection.test.ts -t 'journaling.md when journalingUpdate'
```

Expected: FAIL, `readDocument(paths.journaling)` throws (file was never written).

- [ ] **Step 9: Write the implementation in `applyReflection`**

```bash
grep -n "if (constitutionWrite)" packages/memory/src/reflection.ts
```

Add, immediately after that block (still inside phase 2, before `materializeNew` runs):

```ts
  if (out.journalingUpdate !== null) {
    await writeJournalingProtocol(paths, out.journalingUpdate, now)
  }
```

Add `writeJournalingProtocol` to `reflection.ts`'s import from `./journal.js`.

- [ ] **Step 10: Run and confirm both `applyReflection` tests pass**

```bash
pnpm vitest run packages/memory/src/reflection.test.ts -t 'journaling.md when journalingUpdate'
pnpm vitest run packages/memory/src/reflection.test.ts -t 'leaves journaling.md untouched'
```

Expected: 1 passed each.

- [ ] **Step 11: Wire `MemoryEngine.buildReflectionContext` and the end-of-session reindex**

```bash
grep -n "private async buildReflectionContext" -A20 packages/memory/src/engine.ts
```

Add one line to the returned object:

```ts
      journalingProtocol: await readJournalingProtocolIfPresent(this.paths),
```

Add `readJournalingProtocolIfPresent` to the file's import from `./journal.js`.

```bash
grep -n "if (out.constitutionUpdate !== null)" packages/memory/src/engine.ts
```

Add a matching block immediately after it, inside `_doEndSession`:

```ts
    if (out.journalingUpdate !== null) {
      await this.reindexOrWarn(
        await readDocument(this.paths.journaling),
        'journaling',
        `session ${sessionId} journaling protocol update`,
      )
    }
```

- [ ] **Step 12: Write the failing end-to-end engine test**

Add to `packages/memory/src/engine.test.ts`, inside the `describe('updateJournalingProtocol', ...)` block from Task 11:

```ts
    it('reflection writes and reindexes journaling.md when journalingUpdate is set', async () => {
      const scriptedReflection = {
        ...emptyReflectionOutput('Talked about wanting to journal more.'),
        journalingUpdate: 'Gratitude, three times a week.',
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T09:00:00.000Z',
        role: 'user',
        content: 'I want to start journaling regularly.',
      })
      await engine.endSession(sessionId)
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journaling')).toBeDefined()
      const hits = await engine.search('Gratitude, three times a week')
      expect(hits.some((hit) => hit.kind === 'journaling')).toBe(true)
      await engine.close()
    })
```

- [ ] **Step 13: Run and confirm**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'reflection writes and reindexes journaling.md'
```

Expected: 1 passed.

- [ ] **Step 14: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 15: Commit**

```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Add reflection's journalingUpdate, the backstop revision path

Same shape as constitutionUpdate: null when nothing changed, a full
replacement body otherwise, written through the same shared helper the
live update_journaling_protocol tool uses. Reflection's own prompt now
sees the current journaling setup, or states plainly that there is
none yet, so it can tell not-yet-set-up apart from already-correct."
```

---

## Task 13: The safety invariant test, six combinations, position plus bytes

Per spec section 13, a presence-only assertion ("the crisis text appears somewhere") is anti-falsifiable here: it gets stronger, not weaker, if journal mode's own prompt construction is deleted entirely, because there is then nothing left that could plausibly displace the crisis text. The fix is position plus bytes, against a journal-mode arm with real, non-trivial content, across every combination of {companion, firewall} safety mode and {no mode, journal mode with a real `journaling.md` fixture, journal mode with `journaling.md` absent}.

**Files**
- Modify: `packages/core/src/personas.test.ts`

**Interfaces**

Consumes: `buildPersona` with its widened signature (Task 10, step 7). `JOURNALING_PROTOCOL_ABSENT` from `@openreverie/memory` (Task 7; confirm it is re-exported from `packages/memory/src/index.ts`, same as `JournalMethod`).

Produces: nothing; this is a leaf, and the single most safety-critical test in this plan.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/personas.test.ts`, in a new `describe` block:

```ts
describe('journal mode never weakens the crisis stance', () => {
  const journalingFixture =
    'Gratitude, three times a week, prompted, roughly ten minutes, active nudging.'

  function crisisSectionOf(persona: string, mode: PersonaMode): string {
    // The crisis stance text is identical between companion and firewall
    // only in the CRISIS_DETECTION preamble; the rest differs by design.
    // This helper locates the section by its own heading text, whatever
    // it renders as for the given mode, reusing this file's existing
    // helper if one already exists (check with:
    // grep -n "function crisisSectionOf\|function extractCrisisSection" packages/core/src/personas.test.ts
    // and delete this duplicate definition if so).
    const marker = mode === 'companion' ? 'your posture is to stay' : 'this is beyond what you should handle'
    const index = persona.indexOf(marker)
    if (index < 0) throw new Error(`crisis section marker not found for ${mode}`)
    return persona.slice(persona.lastIndexOf('\n\n', index))
  }

  const safetyModes: PersonaMode[] = ['companion', 'firewall']
  const resources = [{ label: 'Test crisis line', contact: '000-000-0000' }]
  const style = { engagement: 'balanced', tone: 'warm', orientation: 'listening' } as const

  for (const safetyMode of safetyModes) {
    it(`${safetyMode}: crisis section is byte-identical and last, across no-mode, journal-with-fixture, and journal-absent`, () => {
      const baseline = buildPersona(safetyMode, resources, style)
      const journalWithFixture = buildPersona(
        safetyMode,
        resources,
        style,
        'journal',
        journalingFixture,
      )
      const journalAbsent = buildPersona(safetyMode, resources, style, 'journal', JOURNALING_PROTOCOL_ABSENT)

      // The journal-mode arms must genuinely differ from the baseline
      // outside the crisis section, or this test would pass just as
      // easily with journal mode's own prompt construction deleted.
      expect(journalWithFixture).toContain(journalingFixture)
      expect(journalWithFixture).not.toBe(baseline)
      expect(journalAbsent).toContain('has never set up journal mode before')
      expect(journalAbsent).not.toBe(baseline)

      const baselineCrisis = crisisSectionOf(baseline, safetyMode)
      const fixtureCrisis = crisisSectionOf(journalWithFixture, safetyMode)
      const absentCrisis = crisisSectionOf(journalAbsent, safetyMode)

      expect(fixtureCrisis).toBe(baselineCrisis)
      expect(absentCrisis).toBe(baselineCrisis)

      // Position: the crisis section is the last section of buildPersona's
      // own output in all three arms, not merely present somewhere.
      expect(baseline.endsWith(baselineCrisis.trim())).toBe(true)
      expect(journalWithFixture.endsWith(fixtureCrisis.trim())).toBe(true)
      expect(journalAbsent.endsWith(absentCrisis.trim())).toBe(true)
    })
  }
})
```

If `personas.test.ts` already imports `PersonaMode`, `buildPersona`, or defines `resources`/`style` fixtures under different names, reuse the existing ones (`grep -n "const resources\|const style\|import.*PersonaMode" packages/core/src/personas.test.ts`) rather than redeclaring them. Add `JOURNALING_PROTOCOL_ABSENT` to the file's import from `@openreverie/memory`.

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/core/src/personas.test.ts -t 'journal mode never weakens the crisis stance'
```

Expected: `buildPersona` does not accept a fourth and fifth argument (TypeScript error) until Task 10 step 7 lands; if Task 10 already landed by the time this task runs, expect the `journalWithFixture` assertions to fail instead (the paragraph is not there yet if this task somehow runs before Task 10's wiring step, which it should not: this plan's tasks are ordered so this cannot happen).

- [ ] **Step 3: Confirm it passes as-is**

Because Task 10 step 7 already implemented the dynamic mode-paragraph rendering and threaded the two new parameters through `buildPersona`, no new implementation code is needed in this task; it is purely a test.

```bash
pnpm vitest run packages/core/src/personas.test.ts -t 'journal mode never weakens the crisis stance'
```

Expected: 2 passed (one per safety mode).

- [ ] **Step 4: Falsify the ordering half specifically**

```bash
grep -n "crisisSection(mode, resources)" packages/core/src/personas.ts
```

Temporarily move the mode-paragraph insertion (added by Task 10 step 7, inside `buildPersona`'s `sections` array) to after `crisisSection(mode, resources)` instead of before it. Rerun:

```bash
pnpm vitest run packages/core/src/personas.test.ts -t 'journal mode never weakens the crisis stance'
```

Expected: FAIL, specifically on the `endsWith` assertions (the ordering half), while a presence-only check (`toContain`) would still pass, since the crisis text is still somewhere in the string. This is the entire reason position is checked and not just presence. Revert the change.

- [ ] **Step 5: Falsify the byte-identity half specifically**

Temporarily make the mode-paragraph text for `journal` include a stray copy of one word from the crisis resources (for example, append the literal string `'000-000-0000'` to `buildJournalModeParagraph`'s output inside this test file only, by wrapping the call: `buildJournalModeParagraph(x) + ' 000-000-0000'`, not by editing `journaling.ts` itself). Rerun the same command. Expected: this alone should not break byte-identity of the crisis section itself (the crisis section's own text is unchanged; only the mode paragraph grew), so this particular falsification is a no-op and is expected to still pass. Skip asserting anything from this sub-step; it exists only to confirm the two arms are allowed to differ outside the crisis section without breaking the test, which the `not.toBe(baseline)` assertions in step 1 already prove more directly. Move on.

- [ ] **Step 6: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/personas.test.ts
git commit -m "Test that journal mode cannot weaken the crisis stance, six combinations

Position plus bytes, against a journal-mode arm with real content
(a journaling.md fixture, and separately the absent-protocol sentinel),
across both safety modes. A presence-only assertion would pass harder
with journal mode's own prompt construction deleted than with it
present; this test is written to fail specifically on ordering when
the mode paragraph is moved after the crisis section."
```

---

## Task 14: Server exposes `journal`/`journaling` kinds and the two new fields

**Files**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`

**Interfaces**

Consumes: `PublicDocumentRow.method`/`entryDate`, `DocKind` widened (Task 2).

Produces, consumed by Task 15:

```ts
// packages/server/src/app.ts
const documentKindSchema = z.enum([
  'constitution', 'realm', 'arc', 'summary', 'rollup_daily', 'rollup_weekly', 'person',
  'journal', 'journaling',
])
const publicDocumentRowSchema = z.strictObject({
  docId: z.string(),
  kind: documentKindSchema,
  title: z.string(),
  updatedAt: z.string(),
  readOnly: z.literal(true),
  method: z.string().optional(),
  entryDate: z.string().optional(),
})
```

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/app.test.ts`, near the existing document-listing tests (find the fixture engine pattern with `grep -n "listPublicDocuments\|getPublicDocument" packages/server/src/app.test.ts | head -10`):

```ts
it('a journal document round-trips method and entryDate through GET /api/v1/documents and the single-document route', async () => {
  const engine = fakeEngine({
    documents: [
      {
        docId: 'doc_01JZZZ',
        kind: 'journal',
        title: 'doc_01JZZZ',
        updatedAt: '2026-08-16T21:04:00.000Z',
        readOnly: true,
        method: 'gratitude',
        entryDate: '2026-08-16',
      },
    ],
    documentBodies: { doc_01JZZZ: 'Grateful for the quiet morning.\n' },
  })
  const listResponse = await request(engine).get('/api/v1/documents')
  const listRow = listResponse.body.data.find((row: { docId: string }) => row.docId === 'doc_01JZZZ')
  expect(listRow.method).toBe('gratitude')
  expect(listRow.entryDate).toBe('2026-08-16')

  const oneResponse = await request(engine).get('/api/v1/documents/doc_01JZZZ')
  expect(oneResponse.body.data.method).toBe('gratitude')
  expect(oneResponse.body.data.entryDate).toBe('2026-08-16')
})
```

Adapt `fakeEngine`/`request` to this file's actual fixture helper names (`grep -n "function fakeEngine\|function request\|createTestServer" packages/server/src/app.test.ts | head -10`); the shape of what matters (a document with `kind: 'journal'`, `method`, and `entryDate` survives both routes) stays the same.

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/server/src/app.test.ts -t 'a journal document round-trips'
```

Expected: the response fails schema validation (`documentKindSchema` rejects `'journal'`), or `method`/`entryDate` are stripped from the response body because `publicDocumentRowSchema` is a `strictObject` that does not know those keys.

- [ ] **Step 3: Widen both schemas**

```bash
grep -n "const documentKindSchema\|const publicDocumentRowSchema" packages/server/src/app.ts
```

```ts
const documentKindSchema = z.enum([
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
  'journal',
  'journaling',
])
const publicDocumentRowSchema = z.strictObject({
  docId: z.string(),
  kind: documentKindSchema,
  title: z.string(),
  updatedAt: z.string(),
  readOnly: z.literal(true),
  method: z.string().optional(),
  entryDate: z.string().optional(),
})
```

`publicDocumentSchema` (`publicDocumentRowSchema.extend({ body: z.string() })`) needs no direct edit; it inherits the two new optional fields through `.extend`.

- [ ] **Step 4: Run and confirm it passes**

```bash
pnpm vitest run packages/server/src/app.test.ts -t 'a journal document round-trips'
```

Expected: 1 passed.

- [ ] **Step 5: Confirm the API-key non-exposure test still passes with the widened schema**

```bash
grep -n "API key non-exposure\|apiKey.*sentinel" packages/server/src/app.test.ts
```

```bash
pnpm vitest run packages/server/src/app.test.ts -t 'api key'
```

Expected: still passes; this task adds fields to a response schema, it does not touch what gets serialized into it, and the sentinel-by-value test does not depend on `DocKind` at all.

- [ ] **Step 6: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/app.test.ts
git commit -m "Expose journal and journaling document kinds over the HTTP API

publicDocumentRowSchema gains optional method and entryDate, populated
only for a journal-kind row. Both routes (list and single-document)
already serialize whatever engine.listPublicDocuments/getPublicDocument
return; this task only widens the strict schema that was silently
stripping the two new fields before this change."
```

---

## Task 15: Web client schema wiring and `Library.tsx`'s `KIND_LABELS`

**Files**
- Modify: `packages/web/src/api.ts`
- Modify: `packages/web/src/api.test.ts`
- Modify: `packages/web/src/views/Library.tsx`
- Modify: `packages/web/src/views/library.test.tsx`

**Interfaces**

Consumes: the server's widened response shape (Task 14).

Produces, consumed by Task 16:

```ts
// packages/web/src/api.ts
export const documentRowSchema: z.ZodType<{
  docId: string
  kind: 'constitution' | 'realm' | 'arc' | 'summary' | 'rollup_daily' | 'rollup_weekly' | 'person' | 'journal' | 'journaling'
  title: string
  updatedAt: string
  readOnly: true
  method?: string
  entryDate?: string
}>
export type DocumentRow = z.infer<typeof documentRowSchema>
```

- [ ] **Step 1: Write the failing schema test**

Add to `packages/web/src/api.test.ts`, near the existing `documentRowSchema` tests (find with `grep -n "documentRowSchema\|documentSchema" packages/web/src/api.test.ts | head -10`):

```ts
it('documentRowSchema accepts a journal row with method and entryDate', () => {
  const result = documentRowSchema.safeParse({
    docId: 'doc_01JZZZ',
    kind: 'journal',
    title: 'doc_01JZZZ',
    updatedAt: '2026-08-16T21:04:00.000Z',
    readOnly: true,
    method: 'gratitude',
    entryDate: '2026-08-16',
  })
  expect(result.success).toBe(true)
})

it('documentRowSchema accepts a journaling row with neither field', () => {
  const result = documentRowSchema.safeParse({
    docId: 'doc_01JZZZ2',
    kind: 'journaling',
    title: 'doc_01JZZZ2',
    updatedAt: '2026-08-16T21:04:00.000Z',
    readOnly: true,
  })
  expect(result.success).toBe(true)
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/web/src/api.test.ts -t 'documentRowSchema accepts a journal row'
```

Expected: FAIL, `kind: 'journal'` is rejected by the enum.

- [ ] **Step 3: Widen the client-side schema**

```bash
grep -n "const documentKindSchema" packages/web/src/api.ts
```

```ts
const documentKindSchema = z.enum([
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
  'journal',
  'journaling',
])
```

```bash
grep -n "export const documentRowSchema" packages/web/src/api.ts
```

```ts
export const documentRowSchema = z.strictObject({
  docId: z.string(),
  kind: documentKindSchema,
  title: z.string(),
  updatedAt: z.string(),
  readOnly: z.literal(true),
  method: z.string().optional(),
  entryDate: z.string().optional(),
})
```

(`documentSchema`, `documentRowSchema.extend({ body: z.string() })`, needs no direct edit.)

- [ ] **Step 4: Run and confirm it passes**

```bash
pnpm vitest run packages/web/src/api.test.ts -t 'documentRowSchema accepts'
```

Expected: 2 passed.

- [ ] **Step 5: Write the failing `Library.tsx` compile/label test**

`KIND_LABELS` in `Library.tsx` is `Record<DocumentKind, string>`, so widening `DocumentRow['kind']` without adding entries for the two new kinds fails to compile, not just fails a runtime test. Add to `packages/web/src/views/library.test.tsx`:

```ts
it('displayTitle falls back to a readable label for a journal document with a placeholder title', () => {
  const row = {
    docId: 'doc_01JZZZ',
    kind: 'journal' as const,
    title: 'doc_01JZZZ',
    updatedAt: '2026-08-16T21:04:00.000Z',
  }
  expect(displayTitle(row)).toContain('16 August 2026')
})

it('displayTitle falls back to a readable label for the journaling protocol document', () => {
  const row = {
    docId: 'doc_01JZZZ2',
    kind: 'journaling' as const,
    title: 'doc_01JZZZ2',
    updatedAt: '2026-08-16T21:04:00.000Z',
  }
  expect(displayTitle(row)).toContain('16 August 2026')
})
```

- [ ] **Step 6: Run and confirm it fails**

```bash
pnpm vitest run packages/web/src/views/library.test.tsx -t 'displayTitle falls back'
```

Expected: a TypeScript compile error (`Property 'journal' is missing in type 'Record<...>'`), since `KIND_LABELS` does not yet cover the two new kinds.

- [ ] **Step 7: Add the two labels**

```bash
grep -n "const KIND_LABELS" -A10 packages/web/src/views/Library.tsx
```

```ts
const KIND_LABELS: Record<DocumentKind, string> = {
  constitution: 'Constitution',
  realm: 'Realm',
  arc: 'Arc',
  person: 'Person',
  summary: 'Session summary',
  rollup_daily: 'Daily rollup',
  rollup_weekly: 'Weekly rollup',
  journal: 'Journal entry',
  journaling: 'Journaling protocol',
}
```

Add the two kinds to `GROUP_DEFS` too, so a journal document remains findable in the generic Record tab (the journal spec's own tab, built in Task 16, is a dedicated reader; this tab is the existing general-purpose one, and nothing in the spec says a journal entry should disappear from it):

```bash
grep -n "const GROUP_DEFS" -A10 packages/web/src/views/Library.tsx
```

```ts
const GROUP_DEFS: { key: string; heading: string; kinds: DocumentKind[] }[] = [
  { key: 'constitution', heading: 'Constitution', kinds: ['constitution'] },
  { key: 'realms', heading: 'Realms', kinds: ['realm'] },
  { key: 'arcs', heading: 'Arcs', kinds: ['arc'] },
  { key: 'people', heading: 'People', kinds: ['person'] },
  { key: 'rollups', heading: 'Rollups', kinds: ['rollup_daily', 'rollup_weekly'] },
  { key: 'summaries', heading: 'Summaries', kinds: ['summary'] },
  { key: 'journal', heading: 'Journal entries', kinds: ['journal'] },
  { key: 'journaling', heading: 'Journaling protocol', kinds: ['journaling'] },
]
```

- [ ] **Step 8: Run and confirm it passes**

```bash
pnpm vitest run packages/web/src/views/library.test.tsx
```

Expected: full file passes, including the two new tests.

- [ ] **Step 9: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/api.test.ts packages/web/src/views/Library.tsx packages/web/src/views/library.test.tsx
git commit -m "Widen the web client schema for journal and journaling kinds

documentRowSchema/documentSchema accept the two new kinds and their
optional method/entryDate fields. Library.tsx's KIND_LABELS and
GROUP_DEFS gain entries for both, so a journal document keeps
rendering correctly in the existing general-purpose Record tab too."
```

---

## Task 16: The web journal tab

Spec section 12.1 requires a list row showing the method in plain words, the entry date, and a short excerpt of the body. The existing document-list projection (`PublicDocumentRow`) carries `title` and `updatedAt` only, deliberately, to keep the list endpoint cheap; a body excerpt is not derivable from either. This task adds one more optional field end to end (engine, server, web) before building the tab itself, the same pattern Tasks 2, 14, and 15 already used for `method` and `entryDate`.

**Files**
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/web/src/api.ts`
- Modify: `packages/web/src/api.test.ts`
- Modify (replace placeholder content): `packages/web/src/views/Journal.tsx`
- Create: `packages/web/src/views/journal.css`
- Create: `packages/web/src/views/journal.test.tsx`

**Interfaces**

Consumes: `PublicDocumentRow.method`/`entryDate` (Task 2). The modes plan's placeholder `Journal.tsx` and its nav rail wiring. Confirm the placeholder's current shape before replacing it:

```bash
cat packages/web/src/views/Journal.tsx
grep -n "journal" packages/web/src/App.tsx
```

If `Journal.tsx` does not exist, or `App.tsx` has no `journal` nav destination, the modes plan has not landed sections 12 and 12.1 of its own spec; stop and report it rather than building nav plumbing this plan does not own.

Produces: nothing for a later task; this is the last task in this plan.

- [ ] **Step 1: Write the failing excerpt tests, engine layer**

Add to the `describe('journal document kind', ...)` block in `packages/memory/src/engine.test.ts` (Task 2):

```ts
    it('a journal row carries a short excerpt of its body, truncated', async () => {
      const longFirstLine = 'A'.repeat(200)
      await writeDocumentAtomic({
        path: join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
        meta: {
          id: 'doc_01JZZZ',
          kind: 'journal',
          method: 'open',
          mode: 'journal',
          entryDate: '2026-08-16',
          recordedAt: '2026-08-16T21:04:00.000Z',
          session: 'session_01JAAA',
        },
        body: `${longFirstLine}\nSecond line, not part of the excerpt.\n`,
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      const row = rows.find((r) => r.kind === 'journal')
      expect(row?.excerpt?.length).toBeLessThanOrEqual(141)
      expect(row?.excerpt).not.toContain('Second line')
      await engine.close()
    })

    it('a non-journal row never carries an excerpt', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      expect(rows.every((row) => row.excerpt === undefined)).toBe(true)
      await engine.close()
    })
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'excerpt'
```

Expected: `row?.excerpt` is `undefined` on the positive case.

- [ ] **Step 3: Add `excerpt` to `PublicDocumentRow` and `publicDocumentRow`**

```bash
grep -n "export interface PublicDocumentRow" -A10 packages/memory/src/engine.ts
```

```ts
export interface PublicDocumentRow {
  docId: string
  kind: DocKind
  title: string
  updatedAt: string
  readOnly: true
  method?: string
  entryDate?: string
  excerpt?: string
}
```

```bash
grep -n "^function publicDocumentRow" -A15 packages/memory/src/engine.ts
```

```ts
function publicDocumentRow(doc: Document, kind: DocKind): PublicDocumentRow {
  const base: PublicDocumentRow = {
    docId: doc.meta.id,
    kind,
    title: documentTitle(doc),
    updatedAt: documentUpdatedAt(doc),
    readOnly: true,
  }
  if (kind !== 'journal') return base
  return {
    ...base,
    ...(typeof doc.meta.method === 'string' ? { method: doc.meta.method } : {}),
    ...(typeof doc.meta.entryDate === 'string' ? { entryDate: doc.meta.entryDate } : {}),
    ...(documentExcerpt(doc) ? { excerpt: documentExcerpt(doc) } : {}),
  }
}

const EXCERPT_MAX_CHARS = 140

// The first non-empty line of the body, trimmed and capped. Deliberately
// simple: a journal entry's first line is usually the person's actual
// opening sentence, and this is a list-row hint, not a summary.
function documentExcerpt(doc: Document): string | undefined {
  const firstLine = doc.body
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()
  if (!firstLine) return undefined
  return firstLine.length > EXCERPT_MAX_CHARS
    ? `${firstLine.slice(0, EXCERPT_MAX_CHARS)}…`
    : firstLine
}
```

- [ ] **Step 4: Run and confirm the two excerpt tests pass**

```bash
pnpm vitest run packages/memory/src/engine.test.ts -t 'excerpt'
```

Expected: 2 passed.

- [ ] **Step 5: Widen the server and web schemas for `excerpt`**

```bash
grep -n "const publicDocumentRowSchema" packages/server/src/app.ts
```

Add `excerpt: z.string().optional(),` to `publicDocumentRowSchema` (Task 14).

```bash
grep -n "export const documentRowSchema" packages/web/src/api.ts
```

Add `excerpt: z.string().optional(),` to `documentRowSchema` (Task 15).

Add one test to each of `packages/server/src/app.test.ts` and `packages/web/src/api.test.ts`, mirroring the `method`/`entryDate` tests those files already have from Tasks 14 and 15, substituting `excerpt` as the field under test. Run:

```bash
pnpm vitest run packages/server/src/app.test.ts -t 'excerpt'
pnpm vitest run packages/web/src/api.test.ts -t 'excerpt'
```

Expected: 1 passed each (write the two tests first, confirm they fail, then make this edit, per the same TDD order every other task in this plan follows).

- [ ] **Step 6: Write the failing journal tab tests**

Create `packages/web/src/views/journal.test.tsx`, on `library.test.tsx`'s pattern (`grep -n "function fakeApi\|class FakeApi" packages/web/src/views/library.test.tsx` to reuse whatever fake `AppApi` implementation that file already has):

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Journal } from './Journal.js'
// Reuse this package's existing fake AppApi builder rather than writing a
// second one; find it with:
// grep -n "function fakeApi\|class FakeApi" packages/web/src/views/library.test.tsx

const gratitudeRow = {
  docId: 'doc_01JAAA',
  kind: 'journal' as const,
  title: 'doc_01JAAA',
  updatedAt: '2026-08-14T09:00:00.000Z',
  readOnly: true as const,
  method: 'gratitude',
  entryDate: '2026-08-14',
  excerpt: 'Grateful for a slow morning.',
}
const examenRow = {
  docId: 'doc_01JBBB',
  kind: 'journal' as const,
  title: 'doc_01JBBB',
  updatedAt: '2026-08-16T21:00:00.000Z',
  readOnly: true as const,
  method: 'examen',
  entryDate: '2026-08-16',
  excerpt: 'Tired but okay.',
}

describe('Journal tab', () => {
  it('lists entries sorted by entryDate descending, showing method in plain words, date, and excerpt', async () => {
    const api = fakeApi({ documents: [gratitudeRow, examenRow] })
    render(<Journal api={api} />)
    const items = await screen.findAllByRole('button', { name: /Daily Examen|Gratitude/ })
    expect(items[0]).toHaveTextContent('Daily Examen')
    expect(items[1]).toHaveTextContent('Gratitude')
    expect(screen.getByText(/Tired but okay\./)).toBeInTheDocument()
  })

  it('opens an entry showing its full body, method, entry date, and recordedAt as a secondary line', async () => {
    const api = fakeApi({
      documents: [gratitudeRow],
      documentBodies: { doc_01JAAA: 'Grateful for a slow morning.\n\nCoffee on the porch.\n' },
      documentMeta: { doc_01JAAA: { recordedAt: '2026-08-14T21:30:00.000Z' } },
    })
    render(<Journal api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /Gratitude/ }))
    await waitFor(() => expect(screen.getByText(/Coffee on the porch\./)).toBeInTheDocument())
    expect(screen.getByText(/Gratitude/)).toBeInTheDocument()
    expect(screen.getByText(/2026-08-14/)).toBeInTheDocument()
  })

  it('has no edit, delete, or compose affordance anywhere', async () => {
    const api = fakeApi({ documents: [gratitudeRow] })
    render(<Journal api={api} />)
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new entry|compose|write/i })).toBeNull()
  })
})
```

If this codebase's `getDocument` response shape does not carry arbitrary frontmatter (per the current `Document` type, it does not: only `docId`, `kind`, `title`, `updatedAt`, `readOnly`, `body`, plus this plan's `method`/`entryDate`/`excerpt` additions), the `recordedAt` value for the entry view must come from somewhere. This plan's design: add `recordedAt` as one more optional field on `PublicDocumentRow`/`Document`, populated the same way `method` and `entryDate` are, rather than inventing a `documentMeta` side-channel the real `AppApi` does not have. Revise the test above to use the real shape: add `recordedAt: '2026-08-14T21:30:00.000Z'` directly onto `gratitudeRow` (and the schema/engine changes from steps 3 and 5 above, one more `entryDate`-shaped field), and delete the `documentMeta` option from the fake `api` call; the fake API's `getDocument` should simply return the row plus `body` for a given `docId`, matching every other document kind's existing behavior in this test suite.

- [ ] **Step 7: Run and confirm it fails**

```bash
pnpm vitest run packages/web/src/views/journal.test.tsx
```

Expected: `Cannot find module './Journal.js'` export named `Journal`, or the placeholder `Journal.tsx` renders none of the expected content.

- [ ] **Step 8: Add `recordedAt` alongside `method`/`entryDate`, repeating steps 3 and 5's pattern**

In `packages/memory/src/engine.ts`'s `publicDocumentRow`, add `...(typeof doc.meta.recordedAt === 'string' ? { recordedAt: doc.meta.recordedAt } : {}),` and add `recordedAt?: string` to `PublicDocumentRow`. Add `recordedAt: z.string().optional()` to both `publicDocumentRowSchema` (server) and `documentRowSchema` (web). Run the full test suite to confirm nothing else broke:

```bash
pnpm test
```

- [ ] **Step 9: Write the journal tab component**

Replace the contents of `packages/web/src/views/Journal.tsx` (the modes plan's placeholder) with:

```tsx
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppApi, Document, DocumentRow } from '../api.js'
import { Markdown } from './markdown.js'
import './journal.css'

const MAX_PAGES = 50

const METHOD_LABELS: Record<string, string> = {
  expressive_writing: 'Expressive Writing',
  gratitude: 'Gratitude',
  examen: 'Daily Examen',
  thought_record: 'CBT Thought Record',
  morning_pages: 'Morning Pages',
  open: 'Open format',
}

function methodLabel(method: string | undefined): string {
  if (!method) return 'Journal entry'
  return METHOD_LABELS[method] ?? method
}

function formatEntryDate(entryDate: string | undefined): string {
  if (!entryDate) return ''
  const date = new Date(`${entryDate}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return entryDate
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatRecordedAt(recordedAt: string | undefined): string | null {
  if (!recordedAt) return null
  const date = new Date(recordedAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date)
}

type ListStatus = 'loading' | 'ready' | 'error'

export function Journal({ api }: { api: AppApi }): JSX.Element {
  const [entries, setEntries] = useState<DocumentRow[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<Document | null>(null)
  const [entryError, setEntryError] = useState<string | null>(null)

  const selectEntry = useCallback(
    async (docId: string) => {
      setEntryError(null)
      try {
        const entry = await api.getDocument(docId)
        setSelectedEntry(entry)
        setSelectedDocId(docId)
      } catch {
        setEntryError('This entry could not be loaded. The previous one is still shown.')
      }
    },
    [api],
  )

  const loadEntries = useCallback(async () => {
    setListStatus('loading')
    try {
      const all: DocumentRow[] = []
      let cursor: string | undefined
      let pages = 0
      while (pages < MAX_PAGES) {
        const page = await api.listDocuments(cursor)
        all.push(...page.data)
        pages += 1
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      setEntries(all.filter((row) => row.kind === 'journal'))
      setListStatus('ready')
    } catch {
      setListStatus('error')
    }
  }, [api])

  // biome-ignore lint/correctness/useExhaustiveDependencies: only ever run on mount, like Library's own loader
  useEffect(() => {
    void loadEntries()
  }, [])

  const sortedEntries = useMemo(
    () =>
      entries
        .slice()
        .sort((a, b) => (b.entryDate ?? '').localeCompare(a.entryDate ?? '')),
    [entries],
  )

  const recordedAtLine = formatRecordedAt(selectedEntry?.recordedAt)

  return (
    <div className="journal">
      <section className="journal-index" aria-label="Journal entries">
        {listStatus === 'loading' && <p className="journal-status">Loading journal entries.</p>}

        {listStatus === 'error' && (
          <p className="journal-status journal-status-error">
            <span>Journal entries could not be loaded.</span>
            <button type="button" onClick={() => void loadEntries()}>
              Retry
            </button>
          </p>
        )}

        {listStatus === 'ready' && sortedEntries.length === 0 && (
          <p className="journal-status">No journal entries yet.</p>
        )}

        {listStatus === 'ready' && sortedEntries.length > 0 && (
          <ul>
            {sortedEntries.map((row) => (
              <li key={row.docId}>
                <button
                  type="button"
                  aria-current={row.docId === selectedDocId}
                  onClick={() => void selectEntry(row.docId)}
                >
                  <span className="journal-row-method">{methodLabel(row.method)}</span>
                  <span className="journal-row-date">{formatEntryDate(row.entryDate)}</span>
                  {row.excerpt && <span className="journal-row-excerpt">{row.excerpt}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="journal-reading" aria-label="Entry">
        {entryError && <p className="journal-notice">{entryError}</p>}

        {selectedEntry ? (
          <article aria-label={methodLabel(selectedEntry.method)}>
            <header className="journal-reading-header">
              <p className="journal-meta">
                {methodLabel(selectedEntry.method)} &middot; {formatEntryDate(selectedEntry.entryDate)}
              </p>
              {recordedAtLine && <p className="journal-recorded-at">Written {recordedAtLine}</p>}
              <p className="journal-readonly-note">This entry is read-only. Add to it with a new entry instead.</p>
            </header>
            <div className="journal-body">
              <Markdown source={selectedEntry.body} />
            </div>
          </article>
        ) : (
          <p className="journal-empty">Pick an entry from the list to read it here.</p>
        )}
      </section>
    </div>
  )
}
```

Create `packages/web/src/views/journal.css`, matching `library.css`'s layout conventions (`grep -n "\.library" packages/web/src/views/library.css` to reuse the same two-pane grid, spacing, and color tokens rather than inventing new ones):

```css
.journal {
  display: grid;
  grid-template-columns: 280px 1fr;
  height: 100%;
  min-height: 0;
}

.journal-index {
  overflow-y: auto;
  border-right: 1px solid var(--border, #2a2a2a);
  padding: 0.5rem;
}

.journal-index ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.journal-index li button {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-radius: 6px;
  background: none;
  border: none;
  cursor: pointer;
}

.journal-index li button[aria-current='true'] {
  background: var(--surface-active, #1f1f1f);
}

.journal-row-method {
  font-weight: 600;
}

.journal-row-date {
  font-size: 0.85rem;
  opacity: 0.75;
}

.journal-row-excerpt {
  font-size: 0.85rem;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journal-reading {
  overflow-y: auto;
  padding: 1rem 1.5rem;
}

.journal-recorded-at {
  font-size: 0.85rem;
  opacity: 0.65;
}

.journal-readonly-note {
  font-size: 0.85rem;
  opacity: 0.6;
}

.journal-status,
.journal-empty,
.journal-notice {
  padding: 1rem;
  opacity: 0.75;
}
```

- [ ] **Step 10: Run and confirm the journal tab tests pass**

```bash
pnpm vitest run packages/web/src/views/journal.test.tsx
```

Expected: 3 passed.

- [ ] **Step 11: Confirm the nav rail still mounts the journal destination without ending the session**

```bash
grep -n "journal" packages/web/src/App.tsx packages/web/src/App.test.tsx
```

If `App.test.tsx` already has a test asserting the journal destination mounts like Atlas or Record without ending a live Conversations session (per the modes plan's own testing section), run it:

```bash
pnpm vitest run packages/web/src/App.test.tsx -t journal
```

Expected: passes unchanged, since this task only replaced what is rendered inside the destination, not how the destination itself mounts.

- [ ] **Step 12: Full suite, build, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

- [ ] **Step 13: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts packages/server/src/app.ts packages/server/src/app.test.ts packages/web/src/api.ts packages/web/src/api.test.ts packages/web/src/views/Journal.tsx packages/web/src/views/journal.css packages/web/src/views/journal.test.tsx
git commit -m "Build the journal tab: entry list and entry view, read-only

Entries sort by entryDate descending, not recordedAt, per spec section
12.2: entryDate is what the entry is about, recordedAt is only when it
was actually written, shown as a smaller secondary line in the entry
view. No edit, delete, or compose affordance anywhere; this tab reads
entries a journal-mode session already produced."
```

---
