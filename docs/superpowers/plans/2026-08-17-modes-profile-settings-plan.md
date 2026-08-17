# Modes, Profile and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate per-session intent (mode) from persistent preference (style), move every personal setting out of `config.toml` into `profile.md`, and give the CLI and the web interface real surfaces for both.

**Architecture:** `StyleConfig` and the profile schema live in `@openreverie/memory`; `@openreverie/core` reads them and renders the persona, the mode overlay, and a `## Profile` block into the system prompt; `AgentSession` owns session mode and pushes it down to `MemoryEngine`, which persists it to `session.json` so reflection in a later process can still read it. The CLI gains a command parser plus a persistent status strip, the server gains profile, settings and session-mode endpoints, and the web gains a settings pane and a mode picker.

**Tech Stack:** TypeScript 5.9 (NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Node 22, pnpm workspaces, vitest 3, zod 4, React 19 + Vite 6 for the web package, biome 2 for lint and format.

**Spec:** docs/superpowers/specs/2026-08-16-modes-profile-settings-design.md

**Depends on:** docs/superpowers/plans/2026-08-17-time-as-first-class-plan.md must be complete first. It creates `profile.md`, `profileMetaSchema`, the profile loader, and the `reverie migrate` MigrationContext registry that this plan extends.

## Global Constraints

- Package dependencies are downward only: `cli` -> `core` -> `memory` -> `providers`, and `server` -> `core` -> `memory` -> `providers`. `cli` and `server` are sibling outer interfaces. Never import upward or sideways.
- `web` communicates with `server` through HTTP only and never imports a runtime engine package.
- Truth lives in the user's memory folder: markdown prose files plus the append-only `graph.jsonl`. SQLite is a derived index and must always be rebuildable from the folder.
- Transcripts are append-only. Never modified, never deleted by code.
- Prose file writes are atomic: write a temp file, then rename. Graph log writes are single-line appends.
- All structured LLM output is validated with zod schemas at the boundary.
- TDD for deterministic logic: write the failing test first, watch it fail for the stated reason, then write the implementation.
- LLM-dependent behaviour is tested with fixture transcripts and schema assertions, never golden text.
- Both safety modes (companion and firewall) exist by design. Never remove, weaken, or bypass them. A mode adjusts style within the safety stance and never adjusts the safety stance.
- Never write code that could send memory folder contents anywhere except the user's configured model provider. No telemetry, no analytics.
- No em dashes anywhere in prose, comments, error messages, CLI copy, or commit messages. Use commas, periods, colons, or parentheses.
- Avoid AI-typical tropes in all copy: "delve", "seamlessly", "robust", "leverage", "streamline", "empower", "unlock", "supercharge", and emoji in headings or lists.
- The README's Status section must reflect reality at all times.
- The build must compile and the full test suite must pass after every task. Never leave the build broken for a later task to fix.

### Commands used throughout this plan

| Purpose | Command |
| --- | --- |
| Full test suite | `pnpm test` |
| One test file | `pnpm vitest run packages/core/src/personas.test.ts` (substitute the path) |
| One test by name | `pnpm vitest run packages/core/src/personas.test.ts -t 'name fragment'` |
| Build every package | `pnpm build` |
| Lint and format check | `pnpm lint` |
| Auto-format | `pnpm format` |

Run every command from the repository root: `/Users/vishal/work/personal/second-mind`.

---

## File Structure

### Created

| Path | Responsibility |
| --- | --- |
| `packages/memory/src/style.ts` | `StyleConfig`, the three style enums, `styleMetaSchema`, `DEFAULT_STYLE`, `resolveStyle`. Moved down from `packages/core/src/config.ts`. |
| `packages/memory/src/style.test.ts` | Tests for `resolveStyle` defaults and `styleMetaSchema`. |
| `packages/memory/src/importDirection.test.ts` | Asserts no file in `packages/memory/src` imports from `@openreverie/core`. |
| `packages/memory/src/migrations/styleToProfile.ts` | The `style-to-profile` migration: reads `[style]` from `config.toml`, merges into `profile.md`, rewrites the config without the table. |
| `packages/memory/src/migrations/styleToProfile.test.ts` | The four cases from spec section 4, plus idempotence. |
| `packages/core/src/modes.ts` | `ModeName`, `Mode`, the ten-mode catalogue, `modeOverrides`, `modeSection`. |
| `packages/core/src/modes.test.ts` | Catalogue shape tests: clause completeness, axis restriction, spec table match. |
| `packages/cli/src/commands.ts` | `parseInput` and the in-session slash command table. |
| `packages/cli/src/commands.test.ts` | Parser table tests and per-command behaviour tests. |
| `packages/cli/src/strip.ts` | `renderStatusStrip` and `formatStripTime`, the persistent status strip. |
| `packages/cli/src/strip.test.ts` | Strip rendering tests including the degradation cases. |
| `packages/web/src/views/Settings.tsx` | The settings pane: style selects, profile fields, read-only safety mode. |
| `packages/web/src/views/settings.css` | Styling for the settings pane. |
| `packages/web/src/views/settings.test.tsx` | Settings pane tests including the whitelist assertion. |
| `packages/web/src/views/Journal.tsx` | The journal nav destination. A placeholder in this plan; the journal plan replaces its contents. |

### Modified

| Path | Change |
| --- | --- |
| `packages/memory/src/index.ts` | Export `./style.js` and `./migrations/styleToProfile.js`. |
| `packages/memory/src/profile.ts` | Add six fields plus `style` to `ProfileMeta` and `profileMetaSchema`; add `updateProfileArgsSchema`, `profileUpdatesSchema`, `profileSettingsPatchSchema`. |
| `packages/memory/src/profile.test.ts` | Tests for the widened schemas and the two MODEL-WRITE allowlists. |
| `packages/memory/src/transcripts.ts` | `TranscriptLine` gains `synthetic?: true`; `SessionStore` gains `writeMeta` and `readMeta` for `session.json`. |
| `packages/memory/src/transcripts.test.ts` | Tests for `synthetic` round-trip and session metadata. |
| `packages/memory/src/engine.ts` | `currentProfile()`, widened `updateProfile()`, `updateProfileSettings()`, `setSessionMode()`, `sessionMode()`, `_doEndSession` reads the mode. |
| `packages/memory/src/engine.test.ts` | Mode persistence tests including close-and-reopen. |
| `packages/memory/src/reflection.ts` | Replace the identity-fact sentence, widen `profileUpdates` in `RESPONSE_SHAPE` and its schema, show the current profile in the reflection prompt. |
| `packages/memory/src/reflection.test.ts` | Fixture tests for the widened `profileUpdates`. |
| `packages/memory/src/migrations/index.ts` | Register `styleToProfile` in the migration array. |
| `packages/core/src/config.ts` | Re-export `StyleConfig` from memory, then remove `style` from `ReverieConfig`, `configSchema` and `withNestedDefaultsFillable`; add the migrate guard in `loadConfig`. |
| `packages/core/src/config.test.ts` | Update fixtures; add migrate-guard tests. |
| `packages/core/src/personas.ts` | Import style types from memory, add the stance doctrine section, the mode overlay, and name mode in `CRISIS_OUTRANKS_TONE`. |
| `packages/core/src/personas.test.ts` | Mode overlay, precedence, stance doctrine, and the safety invariant test. |
| `packages/core/src/context.ts` | `assembleSystemPrompt` takes a mode, reads the engine's cached profile, renders `## Profile` with the 2,000 character cap. |
| `packages/core/src/context.test.ts` | Profile section and cap tests. |
| `packages/core/src/tools.ts` | Remove `update_style` and `ToolDeps`; add `set_mode` and `ToolHooks`; widen `update_profile` to the MODEL-WRITE allowlist. |
| `packages/core/src/tools.test.ts` | Tests for `set_mode`, the absence of `update_style`, and the widened `update_profile`. |
| `packages/core/src/agent.ts` | Session mode field, `start(..., { mode })`, `setMode`, `refreshSystemPrompt`, the `mode` event, `set_mode` dispatch hook. |
| `packages/core/src/agent.test.ts` | Mode lifecycle tests. |
| `packages/core/src/index.ts` | Export `./modes.js`. |
| `packages/cli/src/chat.ts` | Command dispatch through the parser, the status strip, `interactive`, removal of `createStylePersister`. |
| `packages/cli/src/chat.test.ts` | Command loop and strip tests; fixture updates. |
| `packages/cli/src/index.ts` | Drop the style persister wiring, pass `interactive`. |
| `packages/cli/src/setup.ts` | Write style into `profile.md`; correct the "tell reverie in conversation" copy. |
| `packages/cli/src/setup.test.ts` | Setup writes profile style and no `[style]` table. |
| `packages/cli/src/e2e.test.ts`, `packages/cli/src/read.test.ts` | Fixture updates. |
| `packages/server/src/registry.ts` | `StreamEvent` gains `mode`; `create(mode?)`; `setMode`; `PublicSession.mode`. |
| `packages/server/src/registry.test.ts` | Mode event and endpoint-path tests; fixture updates. |
| `packages/server/src/app.ts` | Profile, settings and session-mode routes; `RecordEngine` widened. |
| `packages/server/src/app.test.ts` | Endpoint tests including API-key non-exposure by value. |
| `packages/server/src/launch.test.ts` | Fixture updates. |
| `packages/web/src/api.ts` | `mode` stream event, `mode` on `sessionSchema`, profile/settings/mode client methods. |
| `packages/web/src/api.test.ts` | Schema tests. |
| `packages/web/src/session.ts` | Reducer handles the `mode` event. |
| `packages/web/src/session.test.ts` | Reducer test. |
| `packages/web/src/App.tsx` | Two new nav destinations: journal and settings. |
| `packages/web/src/App.test.tsx` | Nav and mount-persistence tests. |
| `packages/web/src/views/Conversations.tsx` | Mode picker and status strip near the composer. |
| `packages/web/src/views/conversations.test.tsx` | Picker tests. |
| `README.md` | Status section updated to what actually ships. |

---

## Task 0: Verify the time plan landed and record its exact shapes

This task writes no code. It confirms the symbols this whole plan extends already exist, and it records the exact names later tasks depend on. If any check fails, stop and report; do not invent the missing piece.

**Files**
- Reads only: `packages/memory/src/profile.ts`, `packages/memory/src/paths.ts`, `packages/memory/src/migrations/index.ts`, `packages/memory/src/engine.ts`.

**Interfaces**

Consumes (all created by the time plan, all must already exist):

```ts
// packages/memory/src/paths.ts
export interface MemoryPaths {
  root: string
  constitution: string
  profile: string          // <memoryDir>/profile.md
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

// packages/memory/src/profile.ts
export interface ProfileMeta {
  id: string
  timezone?: string
  timezoneSource?: 'system-default' | 'user-confirmed'
}

export interface Profile {
  meta: ProfileMeta
  body: string             // the prose body of profile.md
}

export const profileMetaSchema = z
  .object({
    id: z.string(),
    timezone: z.string().refine(isValidIanaTimeZone).optional(),
    timezoneSource: z.enum(['system-default', 'user-confirmed']).optional(),
  })
  .passthrough()

export function loadProfile(paths: MemoryPaths): Promise<Profile>
export function saveProfile(paths: MemoryPaths, profile: Profile): Promise<void>

// packages/memory/src/migrations/index.ts
export interface MigrationContext {
  paths: MemoryPaths
  configPath: string
}

export interface MigrationResult {
  changed: boolean
  messages: string[]
}

export interface Migration {
  id: string
  description: string
  isPending(ctx: MigrationContext): Promise<boolean>
  apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult>
}

export const migrations: Migration[]
```

Produces: nothing. This is a gate.

**Steps**

- [ ] 1. Confirm the profile module exists and exports the loader and the file schema:
  ```bash
  grep -n "profileMetaSchema\|export function loadProfile\|export function saveProfile\|interface ProfileMeta\|interface Profile" packages/memory/src/profile.ts
  ```
  Expected: at least one match per symbol. If the file does not exist at all, STOP and report: "The time plan has not landed; `packages/memory/src/profile.ts` is missing."

- [ ] 2. Confirm `MemoryPaths` carries `profile`:
  ```bash
  grep -n "profile" packages/memory/src/paths.ts
  ```
  Expected: a `profile: string` field in the interface and a `join(root, 'profile.md')` in `memoryPaths`. If absent, STOP and report.

- [ ] 3. Confirm the migration registry exists with a context object, not a bare `MemoryPaths`:
  ```bash
  grep -n "MigrationContext\|interface Migration\|export const migrations\|configPath" packages/memory/src/migrations/index.ts
  ```
  Expected: `MigrationContext` with both `paths` and `configPath`. If `Migration.isPending` takes a bare `MemoryPaths` instead, STOP and report: "The migration registry does not carry `configPath`; the `style-to-profile` step cannot find `config.toml`." Do not widen it yourself; that belongs to the time plan.

- [ ] 4. Confirm the engine caches the profile and exposes `updateProfile`:
  ```bash
  grep -n "profile\|Profile" packages/memory/src/engine.ts | head -40
  ```
  Record two things in your notes for later tasks:
  - The name of the cached-profile field (expected `private profile: Profile`).
  - Whether a public accessor already exists. If one exists under a different name than `currentProfile()`, use the existing name everywhere this plan writes `currentProfile()`.

- [ ] 5. Confirm the prose field name on `Profile`:
  ```bash
  grep -n -A4 "export interface Profile\b" packages/memory/src/profile.ts
  ```
  This plan writes `profile.body` throughout. If the time plan named it `prose` instead, substitute `prose` for `body` in every code block below. Nothing else changes.

- [ ] 6. Establish the green baseline before touching anything:
  ```bash
  pnpm build && pnpm test && pnpm lint
  ```
  Expected: the build completes, every test file passes, and biome reports no errors. If the baseline is not green, STOP and report which command failed. Do not start Task 1 on a red tree.

---

## Task 1: Move `StyleConfig` and its three enums down into `@openreverie/memory`

`style` is about to live in `profile.md`, whose schema lives in `@openreverie/memory`. The dependency rule is downward only (`core` depends on `memory`, never the reverse), so the types move down. `packages/core/src/config.ts` re-exports the type so no call site changes in this task, and the build stays green.

**Files**
- Create: `packages/memory/src/style.ts`
- Create: `packages/memory/src/style.test.ts`
- Create: `packages/memory/src/importDirection.test.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/core/src/config.ts`

**Interfaces**

Consumes: nothing new.

Produces, for every later task and for the journal and retrieval plans:

```ts
// packages/memory/src/style.ts
export type Engagement = 'leading' | 'balanced' | 'following'
export type Tone = 'warm' | 'playful' | 'snarky' | 'direct' | 'formal'
export type Orientation = 'listening' | 'balanced' | 'solutions'

export interface StyleConfig {
  engagement: Engagement
  tone: Tone
  orientation: Orientation
}

export const ENGAGEMENT_VALUES: readonly Engagement[]
export const TONE_VALUES: readonly Tone[]
export const ORIENTATION_VALUES: readonly Orientation[]
export const DEFAULT_STYLE: StyleConfig

export const styleMetaSchema: z.ZodType<StyleMeta>
export interface StyleMeta {
  engagement?: Engagement
  tone?: Tone
  orientation?: Orientation
}

export function resolveStyle(style: StyleMeta | undefined): StyleConfig
```

`resolveStyle` is where the three defaults live, deliberately, and not in the zod schema. A `profile.md` with no style block must load with every axis absent (spec section 16.2 requires that tone does not come back as `warm` from such a file), while the persona still needs three concrete values to render. Splitting the two makes both true at once.

**Steps**

- [ ] 1. Write the failing test file `packages/memory/src/style.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import {
    DEFAULT_STYLE,
    ENGAGEMENT_VALUES,
    ORIENTATION_VALUES,
    resolveStyle,
    styleMetaSchema,
    TONE_VALUES,
  } from './style.js'

  describe('style enums', () => {
    it('carries the three axis value lists', () => {
      expect(ENGAGEMENT_VALUES).toEqual(['leading', 'balanced', 'following'])
      expect(TONE_VALUES).toEqual(['warm', 'playful', 'snarky', 'direct', 'formal'])
      expect(ORIENTATION_VALUES).toEqual(['listening', 'balanced', 'solutions'])
    })

    it('defaults to balanced, warm, listening', () => {
      expect(DEFAULT_STYLE).toEqual({
        engagement: 'balanced',
        tone: 'warm',
        orientation: 'listening',
      })
    })
  })

  describe('styleMetaSchema', () => {
    it('accepts an empty object, because every axis is optional in the file', () => {
      const parsed = styleMetaSchema.safeParse({})
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data).toEqual({})
    })

    it('rejects a value outside an axis enum', () => {
      expect(styleMetaSchema.safeParse({ tone: 'sardonic' }).success).toBe(false)
    })

    it('does not invent defaults on parse', () => {
      const parsed = styleMetaSchema.parse({ engagement: 'leading' })
      expect(parsed).toEqual({ engagement: 'leading' })
      expect('tone' in parsed).toBe(false)
    })
  })

  describe('resolveStyle', () => {
    it('fills every unset axis from DEFAULT_STYLE', () => {
      expect(resolveStyle(undefined)).toEqual(DEFAULT_STYLE)
      expect(resolveStyle({})).toEqual(DEFAULT_STYLE)
    })

    it('keeps the axes that are set', () => {
      expect(resolveStyle({ tone: 'direct' })).toEqual({
        engagement: 'balanced',
        tone: 'direct',
        orientation: 'listening',
      })
    })
  })
  ```

- [ ] 2. Run it and read the exact failure:
  ```bash
  pnpm vitest run packages/memory/src/style.test.ts
  ```
  Expected: the run fails to collect the file with `Failed to load url ./style.js` (or `Cannot find module`). That is the correct first failure: the module does not exist yet.

- [ ] 3. Create `packages/memory/src/style.ts`:
  ```ts
  // Conversational style: how reverie talks with this person in general.
  // These three axes live in profile.md frontmatter, not in config.toml,
  // because they are a personal preference rather than infrastructure.
  // They live in @openreverie/memory rather than @openreverie/core
  // because the profile schema lives here and the dependency direction is
  // core -> memory, never the reverse.
  //
  // The defaults deliberately sit in resolveStyle rather than in the zod
  // schema. A profile.md with no style block must load with every axis
  // absent, so nothing can mistake an unset axis for a chosen one; the
  // persona still needs three concrete values to render, and that is what
  // resolveStyle is for.

  import { z } from 'zod'

  export type Engagement = 'leading' | 'balanced' | 'following'
  export type Tone = 'warm' | 'playful' | 'snarky' | 'direct' | 'formal'
  export type Orientation = 'listening' | 'balanced' | 'solutions'

  export interface StyleConfig {
    engagement: Engagement
    tone: Tone
    orientation: Orientation
  }

  export const ENGAGEMENT_VALUES: readonly Engagement[] = ['leading', 'balanced', 'following']
  export const TONE_VALUES: readonly Tone[] = ['warm', 'playful', 'snarky', 'direct', 'formal']
  export const ORIENTATION_VALUES: readonly Orientation[] = ['listening', 'balanced', 'solutions']

  export const DEFAULT_STYLE: StyleConfig = {
    engagement: 'balanced',
    tone: 'warm',
    orientation: 'listening',
  }

  export const styleMetaSchema = z.strictObject({
    engagement: z.enum(['leading', 'balanced', 'following']).optional(),
    tone: z.enum(['warm', 'playful', 'snarky', 'direct', 'formal']).optional(),
    orientation: z.enum(['listening', 'balanced', 'solutions']).optional(),
  })

  export type StyleMeta = z.infer<typeof styleMetaSchema>

  export function resolveStyle(style: StyleMeta | undefined): StyleConfig {
    return {
      engagement: style?.engagement ?? DEFAULT_STYLE.engagement,
      tone: style?.tone ?? DEFAULT_STYLE.tone,
      orientation: style?.orientation ?? DEFAULT_STYLE.orientation,
    }
  }
  ```

- [ ] 4. Run the test again:
  ```bash
  pnpm vitest run packages/memory/src/style.test.ts
  ```
  Expected: `Test Files  1 passed (1)` with 7 tests passing.

- [ ] 5. Export the module from the memory package. In `packages/memory/src/index.ts`, add one line in alphabetical position (after `export * from './sqlite.js'`):
  ```ts
  export * from './style.js'
  ```

- [ ] 6. Write the import-direction test at `packages/memory/src/importDirection.test.ts`:
  ```ts
  // The dependency rule in AGENTS.md is downward only: core depends on
  // memory, never the reverse. This test fails the build the moment any
  // file in @openreverie/memory reaches up into @openreverie/core, which is
  // exactly what moving StyleConfig down here exists to prevent.

  import { readdir, readFile } from 'node:fs/promises'
  import { join } from 'node:path'
  import { describe, expect, it } from 'vitest'

  const SRC_DIR = new URL('.', import.meta.url).pathname

  async function collectSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await collectSourceFiles(full)))
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        files.push(full)
      }
    }
    return files
  }

  describe('memory package import direction', () => {
    it('never imports from @openreverie/core', async () => {
      const files = await collectSourceFiles(SRC_DIR)
      expect(files.length).toBeGreaterThan(5)
      const offenders: string[] = []
      for (const file of files) {
        const text = await readFile(file, 'utf8')
        if (text.includes('@openreverie/core')) offenders.push(file)
      }
      expect(offenders).toEqual([])
    })

    it('owns StyleConfig itself rather than re-exporting it from elsewhere', async () => {
      const text = await readFile(join(SRC_DIR, 'style.ts'), 'utf8')
      expect(text).toContain('export interface StyleConfig')
    })
  })
  ```

- [ ] 7. Run it:
  ```bash
  pnpm vitest run packages/memory/src/importDirection.test.ts
  ```
  Expected: `Test Files  1 passed (1)`, 2 tests. If the first test fails, a memory file already reaches into core and that is a pre-existing violation; report it rather than working around it.

- [ ] 8. Point `packages/core/src/config.ts` at the moved type. Delete this block (lines 23 to 27 today):
  ```ts
  export interface StyleConfig {
    engagement: 'leading' | 'balanced' | 'following'
    tone: 'warm' | 'playful' | 'snarky' | 'direct' | 'formal'
    orientation: 'listening' | 'balanced' | 'solutions'
  }
  ```
  and add this import and re-export near the top of the file, right after the existing `import { z } from 'zod'` line:
  ```ts
  import type { StyleConfig } from '@openreverie/memory'

  // StyleConfig lives in @openreverie/memory because style is stored in
  // profile.md, whose schema lives there. Re-exported here so existing
  // importers of @openreverie/core keep working; config.toml itself no
  // longer holds style.
  export type { StyleConfig }
  ```
  `verbatimModuleSyntax` is on, so both the import and the re-export must use the `type` keyword.

- [ ] 9. Build and run the full suite:
  ```bash
  pnpm build && pnpm test
  ```
  Expected: the build succeeds and every test file passes. `packages/core/src/config.ts` still declares `styleSchema` and `ReverieConfig.style`; that removal is Task 13, not this task.

- [ ] 10. Falsify the import-direction test before trusting it. Temporarily add this line at the top of `packages/memory/src/style.ts`:
  ```ts
  import type { ReverieConfig } from '@openreverie/core'
  ```
  Run `pnpm vitest run packages/memory/src/importDirection.test.ts` and confirm the first test now fails with `expected [ '<path>/style.ts' ] to deeply equal []`. Then delete that line and re-run to confirm it passes again.

- [ ] 11. Lint and commit:
  ```bash
  pnpm lint
  git add -A && git commit -m "Move StyleConfig and its three enums into the memory package

Style is about to live in profile.md, whose schema lives in
@openreverie/memory. The dependency rule is core -> memory, so the types
move down. config.ts re-exports StyleConfig so no call site changes yet.
Adds an import-direction test that fails if memory ever imports core."
  ```

---

## Task 2: Add the six personal fields and `style` to the profile file schema

The time plan created `profile.md` with `timezone` alone. This task adds the rest of the fields from spec section 3.2, keeping the file schema's `.passthrough()` posture: a key the schema does not know about survives a read and a write.

**Files**
- Modify: `packages/memory/src/profile.ts`
- Modify: `packages/memory/src/profile.test.ts`

**Interfaces**

Consumes: `StyleMeta`, `styleMetaSchema` from Task 1. `Profile`, `ProfileMeta`, `profileMetaSchema`, `loadProfile`, `saveProfile` from the time plan.

Produces:

```ts
// packages/memory/src/profile.ts
export interface ProfileMeta {
  id: string
  timezone?: string
  timezoneSource?: 'system-default' | 'user-confirmed'
  preferredName?: string
  pronouns?: string
  location?: string
  birthday?: string
  occupation?: string
  birthdayGreetings?: boolean
  style?: StyleMeta
  [key: string]: unknown        // passthrough keys survive a read and a write
}
```

`birthday` is `MM-DD` or `YYYY-MM-DD`, validated by `BIRTHDAY_PATTERN` exported from the same file:

```ts
export const BIRTHDAY_PATTERN: RegExp   // /^(\d{4}-)?\d{2}-\d{2}$/
```

**Steps**

- [ ] 1. Add failing tests to `packages/memory/src/profile.test.ts`. Append this describe block at the end of the file:
  ```ts
  describe('profileMetaSchema personal fields', () => {
    it('accepts every field from the spec, all optional', () => {
      const parsed = profileMetaSchema.safeParse({
        id: 'doc_1',
        preferredName: 'Vish',
        pronouns: 'he/him or they/them',
        location: 'Bengaluru',
        timezone: 'Asia/Kolkata',
        timezoneSource: 'user-confirmed',
        birthday: '1990-04-02',
        occupation: 'nurse',
        birthdayGreetings: true,
        style: { engagement: 'leading', tone: 'direct', orientation: 'solutions' },
      })
      expect(parsed.success).toBe(true)
    })

    it('invents no defaults: a file with only an id yields nothing else', () => {
      const parsed = profileMetaSchema.parse({ id: 'doc_1' })
      expect(parsed).toEqual({ id: 'doc_1' })
      expect(parsed.style).toBeUndefined()
      expect(parsed.preferredName).toBeUndefined()
    })

    it('does not return warm as a tone for a file with no style block', () => {
      const parsed = profileMetaSchema.parse({ id: 'doc_1', timezone: 'Asia/Kolkata' })
      expect(parsed.style?.tone).toBeUndefined()
    })

    it('accepts a birthday with and without a year', () => {
      expect(profileMetaSchema.safeParse({ id: 'd', birthday: '04-02' }).success).toBe(true)
      expect(profileMetaSchema.safeParse({ id: 'd', birthday: '1990-04-02' }).success).toBe(true)
    })

    it('rejects a birthday that is neither shape', () => {
      expect(profileMetaSchema.safeParse({ id: 'd', birthday: 'April 2nd' }).success).toBe(false)
    })

    it('rejects a style axis value outside its enum', () => {
      expect(
        profileMetaSchema.safeParse({ id: 'd', style: { tone: 'sardonic' } }).success,
      ).toBe(false)
    })

    it('passes an unknown key through unchanged, because the profile is an open set', () => {
      const parsed = profileMetaSchema.parse({ id: 'd', favouriteTea: 'assam' })
      expect(parsed.favouriteTea).toBe('assam')
    })
  })
  ```
  Add `profileMetaSchema` to the file's existing import from `./profile.js` if it is not imported already.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/profile.test.ts
  ```
  Expected: the birthday-rejection test and the style-enum test fail, because the current schema passes both through untouched (`expected true to be false`). The accept-everything test passes only by passthrough, which is why the rejection cases are the real assertions here.

- [ ] 3. Widen the schema in `packages/memory/src/profile.ts`. Add the style import at the top:
  ```ts
  import { type StyleMeta, styleMetaSchema } from './style.js'
  ```
  Add the birthday pattern above the schema:
  ```ts
  // MM-DD or YYYY-MM-DD. The year is optional because plenty of people
  // will say the day without the year, and a profile field records what
  // was actually said rather than demanding a shape nobody offered.
  export const BIRTHDAY_PATTERN = /^(\d{4}-)?\d{2}-\d{2}$/
  ```
  Replace the schema body with:
  ```ts
  export const profileMetaSchema = z
    .object({
      id: z.string(),
      timezone: z.string().refine(isValidIanaTimeZone).optional(),
      timezoneSource: z.enum(['system-default', 'user-confirmed']).optional(),
      preferredName: z.string().optional(),
      pronouns: z.string().optional(),
      location: z.string().optional(),
      birthday: z.string().regex(BIRTHDAY_PATTERN).optional(),
      occupation: z.string().optional(),
      birthdayGreetings: z.boolean().optional(),
      style: styleMetaSchema.optional(),
    })
    .passthrough()
  ```
  and widen the interface:
  ```ts
  export interface ProfileMeta {
    id: string
    timezone?: string
    timezoneSource?: 'system-default' | 'user-confirmed'
    preferredName?: string
    pronouns?: string
    location?: string
    birthday?: string
    occupation?: string
    birthdayGreetings?: boolean
    style?: StyleMeta
    [key: string]: unknown
  }
  ```

- [ ] 4. Run the file again:
  ```bash
  pnpm vitest run packages/memory/src/profile.test.ts
  ```
  Expected: every test in the file passes, including the seven added above.

- [ ] 5. Falsify the passthrough test: change `.passthrough()` to `.strict()`, run the same command, and confirm `passes an unknown key through unchanged` now fails with an `unrecognized_keys` issue. Restore `.passthrough()` and re-run.

- [ ] 6. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add the personal profile fields to profile.md's schema

preferredName, pronouns, location, birthday, occupation,
birthdayGreetings and style join timezone in the file schema. The schema
stays passthrough: profile.md is an open, growing set and an unknown key
survives a read and a write. No field gains a default, so an unset axis
is never mistaken for a chosen one."
  ```

---

## Task 3: The two MODEL-WRITE schemas, and the settings patch schema

Three schemas, three boundaries. The file schema from Task 2 is passthrough and governs `profile.md` itself. The two MODEL-WRITE schemas are strict and govern what a model may write. The settings patch schema is strict, different again, and governs the HTTP `PATCH` body, which legitimately includes `style` and `prose` because the settings pane is not a model surface.

The MODEL-WRITE allowlist is exactly seven keys: `preferredName`, `pronouns`, `location`, `timezone`, `birthday`, `occupation`, `birthdayGreetings`. `style` is absent from both, by type, so there is no representable call from either surface that sets one.

**Files**
- Modify: `packages/memory/src/profile.ts`
- Modify: `packages/memory/src/profile.test.ts`

**Interfaces**

Consumes: `BIRTHDAY_PATTERN`, `isValidIanaTimeZone`, `styleMetaSchema`.

Produces:

```ts
// packages/memory/src/profile.ts

// MODEL-WRITE, tool surface: arguments of the live update_profile tool.
export const updateProfileArgsSchema: z.ZodType<ProfileUpdates>

// MODEL-WRITE, reflection surface: the profileUpdates field of reflection's
// structured output.
export const profileUpdatesSchema: z.ZodType<ProfileUpdates>

export interface ProfileUpdates {
  preferredName?: string
  pronouns?: string
  location?: string
  timezone?: string
  birthday?: string
  occupation?: string
  birthdayGreetings?: boolean
}

export const MODEL_WRITE_FIELDS: readonly (keyof ProfileUpdates)[]

// HTTP surface: the PATCH /api/v1/profile body. A third strict object,
// not a reuse of either MODEL-WRITE schema.
export const profileSettingsPatchSchema: z.ZodType<ProfileSettingsPatch>

export interface ProfileSettingsPatch {
  preferredName?: string | null
  pronouns?: string | null
  location?: string | null
  timezone?: string | null
  birthday?: string | null
  occupation?: string | null
  birthdayGreetings?: boolean | null
  style?: StyleMeta
  prose?: string
}
```

The two MODEL-WRITE schemas are declared separately rather than shared, because they answer to two different boundaries and a mistake in one must not be papered over by the other. `@openreverie/core` consumes `updateProfileArgsSchema` in Task 4; `reflection.ts` consumes `profileUpdatesSchema` in Task 5; the server consumes `profileSettingsPatchSchema` in Task 19.

**Steps**

- [ ] 1. Add failing tests. Append to `packages/memory/src/profile.test.ts`:
  ```ts
  describe('MODEL-WRITE profile schemas', () => {
    const allowed = {
      preferredName: 'Vish',
      pronouns: 'they/them',
      location: 'Bengaluru',
      timezone: 'Asia/Kolkata',
      birthday: '04-02',
      occupation: 'nurse',
      birthdayGreetings: false,
    }

    it('updateProfileArgsSchema accepts every allowlisted field', () => {
      expect(updateProfileArgsSchema.safeParse(allowed).success).toBe(true)
    })

    it('profileUpdatesSchema accepts every allowlisted field', () => {
      expect(profileUpdatesSchema.safeParse(allowed).success).toBe(true)
    })

    it('both accept an empty object, since every key is optional', () => {
      expect(updateProfileArgsSchema.safeParse({}).success).toBe(true)
      expect(profileUpdatesSchema.safeParse({}).success).toBe(true)
    })

    // This is the test that keeps the style/mode split real. Adding style to
    // either allowlist makes the corresponding assertion fail, because the
    // schema would then accept exactly what the rule says it must not.
    it('updateProfileArgsSchema rejects a style key', () => {
      const parsed = updateProfileArgsSchema.safeParse({ style: { tone: 'direct' } })
      expect(parsed.success).toBe(false)
    })

    it('profileUpdatesSchema rejects a style key', () => {
      const parsed = profileUpdatesSchema.safeParse({ style: { tone: 'direct' } })
      expect(parsed.success).toBe(false)
    })

    it('both reject a nested style axis smuggled in at the top level', () => {
      expect(updateProfileArgsSchema.safeParse({ tone: 'direct' }).success).toBe(false)
      expect(profileUpdatesSchema.safeParse({ orientation: 'solutions' }).success).toBe(false)
    })

    it('the allowlist is exactly the seven fields from the spec', () => {
      expect([...MODEL_WRITE_FIELDS].sort()).toEqual(
        [
          'birthday',
          'birthdayGreetings',
          'location',
          'occupation',
          'preferredName',
          'pronouns',
          'timezone',
        ].sort(),
      )
    })

    it('rejects a timezone Intl does not recognize', () => {
      expect(updateProfileArgsSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false)
    })

    it('rejects a birthday that is neither MM-DD nor YYYY-MM-DD', () => {
      expect(profileUpdatesSchema.safeParse({ birthday: 'next tuesday' }).success).toBe(false)
    })
  })

  describe('profileSettingsPatchSchema', () => {
    it('accepts style and prose, which no MODEL-WRITE schema may accept', () => {
      const parsed = profileSettingsPatchSchema.safeParse({
        style: { tone: 'direct' },
        prose: 'Prefers to be called Vish by everyone except his mother.',
      })
      expect(parsed.success).toBe(true)
    })

    it('accepts null to clear a field', () => {
      expect(profileSettingsPatchSchema.safeParse({ location: null }).success).toBe(true)
    })

    it('rejects infrastructure keys that belong to config.toml', () => {
      for (const body of [
        { provider: { apiKey: 'sk-test' } },
        { safety: { mode: 'firewall' } },
        { models: { chat: 'gpt-5' } },
        { memoryDir: '/tmp/elsewhere' },
      ]) {
        expect(profileSettingsPatchSchema.safeParse(body).success).toBe(false)
      }
    })

    it('rejects timezoneSource, which is not a setting', () => {
      expect(
        profileSettingsPatchSchema.safeParse({ timezoneSource: 'user-confirmed' }).success,
      ).toBe(false)
    })
  })
  ```
  Extend the file's import from `./profile.js` to include `MODEL_WRITE_FIELDS`, `profileSettingsPatchSchema`, `profileUpdatesSchema`, and `updateProfileArgsSchema`.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/profile.test.ts
  ```
  Expected: collection fails with `No "updateProfileArgsSchema" export is defined on the "./profile.js" mock` or a TypeScript/import error naming the missing exports. The symbols do not exist yet.

- [ ] 3. Add the schemas to `packages/memory/src/profile.ts`, below `profileMetaSchema`:
  ```ts
  // Three schemas, three boundaries, deliberately not shared.
  //
  // profileMetaSchema above is the FILE schema: passthrough, because
  // profile.md is an open, growing set the user may hand-edit.
  //
  // The two below are the MODEL-WRITE schemas, one per model surface: the
  // live update_profile tool's arguments, and reflection's profileUpdates
  // field. Both are strict objects over the same seven-key allowlist.
  // Neither has a style key, at all, ever: the model may write facts it
  // was told and consent answers it collected, and it may never write
  // style. That absence is what makes the rule enforceable rather than a
  // convention, because there is no representable call that sets one.
  //
  // They are declared separately rather than shared because they answer to
  // two different boundaries, and a mistake in one must not be silently
  // papered over by the other.

  export const MODEL_WRITE_FIELDS = [
    'preferredName',
    'pronouns',
    'location',
    'timezone',
    'birthday',
    'occupation',
    'birthdayGreetings',
  ] as const

  export const updateProfileArgsSchema = z.strictObject({
    preferredName: z.string().optional(),
    pronouns: z.string().optional(),
    location: z.string().optional(),
    timezone: z.string().refine(isValidIanaTimeZone).optional(),
    birthday: z.string().regex(BIRTHDAY_PATTERN).optional(),
    occupation: z.string().optional(),
    birthdayGreetings: z.boolean().optional(),
  })

  export const profileUpdatesSchema = z.strictObject({
    preferredName: z.string().optional(),
    pronouns: z.string().optional(),
    location: z.string().optional(),
    timezone: z.string().refine(isValidIanaTimeZone).optional(),
    birthday: z.string().regex(BIRTHDAY_PATTERN).optional(),
    occupation: z.string().optional(),
    birthdayGreetings: z.boolean().optional(),
  })

  export type ProfileUpdates = z.infer<typeof updateProfileArgsSchema>

  // The HTTP surface: the PATCH /api/v1/profile body. A third strict
  // object, distinct from both MODEL-WRITE schemas rather than a reuse of
  // either. It legitimately includes style and prose, because the settings
  // pane is not a model surface: it is the same kind of write /style and
  // reverie setup already make. null clears a field.
  export const profileSettingsPatchSchema = z.strictObject({
    preferredName: z.string().nullable().optional(),
    pronouns: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    timezone: z.string().refine(isValidIanaTimeZone).nullable().optional(),
    birthday: z.string().regex(BIRTHDAY_PATTERN).nullable().optional(),
    occupation: z.string().nullable().optional(),
    birthdayGreetings: z.boolean().nullable().optional(),
    style: styleMetaSchema.optional(),
    prose: z.string().optional(),
  })

  export type ProfileSettingsPatch = z.infer<typeof profileSettingsPatchSchema>
  ```

- [ ] 4. Run the file:
  ```bash
  pnpm vitest run packages/memory/src/profile.test.ts
  ```
  Expected: every test passes.

- [ ] 5. Falsify the split. Temporarily add `style: styleMetaSchema.optional(),` to `updateProfileArgsSchema`, run the same command, and confirm `updateProfileArgsSchema rejects a style key` fails with `expected true to be false`. Remove it and re-run. Repeat for `profileUpdatesSchema`.

- [ ] 6. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add the two MODEL-WRITE profile schemas and the settings patch schema

updateProfileArgsSchema governs the live update_profile tool, and
profileUpdatesSchema governs reflection's profileUpdates field. Both are
strict objects over the same seven-key allowlist, and neither has a style
key, so no model call can set one. profileSettingsPatchSchema is a third,
separate strict object for the HTTP PATCH body, which does accept style
and prose because the settings pane is not a model surface."
  ```

---

## Task 4: Engine profile plumbing, and widening the live `update_profile` tool

The time plan gave `MemoryEngine` a cached profile and an `updateProfile` path that handled `timezone` alone. This task widens that path to the full seven-key allowlist, adds the public accessor the prompt assembler and the settings surfaces need, and adds the non-model write path that `/style`, `reverie setup` and the HTTP `PATCH` all use.

**Files**
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`

**Interfaces**

Consumes: `ProfileUpdates`, `ProfileSettingsPatch`, `updateProfileArgsSchema`, `profileSettingsPatchSchema`, `Profile`, `loadProfile`, `saveProfile` (Tasks 2 and 3, plus the time plan). `resolveStyle`, `StyleConfig` (Task 1).

Produces, consumed by Tasks 9, 15, 19 and by the journal plan:

```ts
// packages/memory/src/engine.ts, on class MemoryEngine
currentProfile(): Profile
updateProfile(updates: ProfileUpdates): Promise<Profile>
updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile>
currentStyle(): StyleConfig
```

`currentProfile()` is synchronous and returns the cached copy loaded at `open()` and refreshed by both writers. If Task 0 recorded a public accessor that already exists under another name, use that name and skip step 3 below.

`updateProfile` is the MODEL-WRITE path: it accepts the seven-key allowlist only, and setting `timezone` through it marks `timezoneSource: 'user-confirmed'`. `updateProfileSettings` is the human path: it also accepts `style` and `prose`, and `null` clears a field. Neither ever touches `config.toml`.

**Steps**

- [ ] 1. Add failing tests. Append this describe block to `packages/memory/src/engine.test.ts`, matching the file's existing helper for opening an engine against a temp folder (find it with `grep -n "async function openTestEngine\|MemoryEngine.open" packages/memory/src/engine.test.ts | head -5` and reuse it rather than writing a second one):
  ```ts
  describe('profile writes', () => {
    it('exposes the cached profile synchronously', async () => {
      const { engine } = await openTestEngine()
      expect(engine.currentProfile().meta.id).toMatch(/^doc_/)
      await engine.close()
    })

    it('writes an allowlisted field and refreshes the cache', async () => {
      const { engine } = await openTestEngine()
      await engine.updateProfile({ preferredName: 'Vish', occupation: 'nurse' })
      expect(engine.currentProfile().meta.preferredName).toBe('Vish')
      expect(engine.currentProfile().meta.occupation).toBe('nurse')
      await engine.close()
    })

    it('marks a timezone written through the model path as user-confirmed', async () => {
      const { engine } = await openTestEngine()
      await engine.updateProfile({ timezone: 'Asia/Kolkata' })
      expect(engine.currentProfile().meta.timezone).toBe('Asia/Kolkata')
      expect(engine.currentProfile().meta.timezoneSource).toBe('user-confirmed')
      await engine.close()
    })

    it('rejects a style write through the model path', async () => {
      const { engine } = await openTestEngine()
      await expect(
        engine.updateProfile({ style: { tone: 'direct' } } as never),
      ).rejects.toThrow(/style/)
      await engine.close()
    })

    it('writes style through the settings path and leaves other fields byte-identical', async () => {
      const { engine, paths } = await openTestEngine()
      await engine.updateProfile({ preferredName: 'Vish', location: 'Bengaluru' })
      await engine.updateProfileSettings({ style: { tone: 'direct' } })
      const profile = engine.currentProfile()
      expect(profile.meta.style).toEqual({ tone: 'direct' })
      expect(profile.meta.preferredName).toBe('Vish')
      expect(profile.meta.location).toBe('Bengaluru')
      expect(paths.profile.endsWith('profile.md')).toBe(true)
      await engine.close()
    })

    it('clears a field when the settings path is given null', async () => {
      const { engine } = await openTestEngine()
      await engine.updateProfile({ location: 'Bengaluru' })
      await engine.updateProfileSettings({ location: null })
      expect(engine.currentProfile().meta.location).toBeUndefined()
      await engine.close()
    })

    it('resolves style with the balanced/warm/listening defaults when unset', async () => {
      const { engine } = await openTestEngine()
      expect(engine.currentStyle()).toEqual({
        engagement: 'balanced',
        tone: 'warm',
        orientation: 'listening',
      })
      await engine.close()
    })

    it('writes the profile atomically, leaving no temp file behind', async () => {
      const { engine, paths } = await openTestEngine()
      await engine.updateProfile({ preferredName: 'Vish' })
      const entries = await readdir(paths.root)
      expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
      await engine.close()
    })
  })
  ```
  Add `readdir` to the file's `node:fs/promises` import if it is not there already.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/engine.test.ts -t 'profile writes'
  ```
  Expected: `engine.currentProfile is not a function` on the first test.

- [ ] 3. Add the accessors and writers to `packages/memory/src/engine.ts`. Put them next to the existing profile code the time plan added:
  ```ts
  // The cached profile, loaded at open() and refreshed by both writers, so
  // the next read inside this process sees the new value without a second
  // file read racing the first.
  currentProfile(): Profile {
    return this.profile
  }

  // The three style axes, with the balanced/warm/listening defaults applied
  // at read time rather than baked into the file schema, so an unset axis in
  // profile.md is never mistaken for a chosen one.
  currentStyle(): StyleConfig {
    return resolveStyle(this.profile.meta.style)
  }

  // The MODEL-WRITE path: the live update_profile tool and reflection's
  // profileUpdates both land here. The seven-key allowlist is enforced by
  // the schema, so there is no representable call that writes style.
  // Setting a timezone here is a confirmation, so timezoneSource follows.
  async updateProfile(updates: ProfileUpdates): Promise<Profile> {
    const parsed = updateProfileArgsSchema.safeParse(updates)
    if (!parsed.success) {
      throw new Error(
        `Invalid profile update: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      )
    }
    const meta: ProfileMeta = { ...this.profile.meta }
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) meta[key] = value
    }
    if (parsed.data.timezone !== undefined) meta.timezoneSource = 'user-confirmed'
    const next: Profile = { meta, body: this.profile.body }
    await saveProfile(this.paths, next)
    this.profile = next
    return next
  }

  // The human path: /style, reverie setup, and the settings pane. It
  // accepts style and prose, which no model surface may ever write, and it
  // treats null as "clear this field" so a blank settings box means unknown
  // rather than an empty string.
  async updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile> {
    const parsed = profileSettingsPatchSchema.safeParse(patch)
    if (!parsed.success) {
      throw new Error(
        `Invalid profile settings: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      )
    }
    const meta: ProfileMeta = { ...this.profile.meta }
    for (const key of MODEL_WRITE_FIELDS) {
      const value = parsed.data[key]
      if (value === undefined) continue
      if (value === null) {
        delete meta[key]
      } else {
        meta[key] = value
      }
    }
    if (parsed.data.style !== undefined) {
      meta.style = { ...(meta.style ?? {}), ...parsed.data.style }
    }
    if (parsed.data.timezone !== undefined && parsed.data.timezone !== null) {
      meta.timezoneSource = 'user-confirmed'
    }
    const body = parsed.data.prose !== undefined ? parsed.data.prose : this.profile.body
    const next: Profile = { meta, body }
    await saveProfile(this.paths, next)
    this.profile = next
    return next
  }
  ```
  Add the imports these need at the top of `engine.ts`:
  ```ts
  import {
    MODEL_WRITE_FIELDS,
    type Profile,
    type ProfileMeta,
    type ProfileSettingsPatch,
    type ProfileUpdates,
    profileSettingsPatchSchema,
    saveProfile,
    updateProfileArgsSchema,
  } from './profile.js'
  import { resolveStyle, type StyleConfig } from './style.js'
  ```
  Some of these will already be imported by the time plan's code; merge rather than duplicating the import statement.

- [ ] 4. Run the block:
  ```bash
  pnpm vitest run packages/memory/src/engine.test.ts -t 'profile writes'
  ```
  Expected: 8 tests pass.

- [ ] 5. Widen the live tool. In `packages/core/src/tools.ts`, replace the `update_profile` argument schema the time plan added with a direct use of the memory package's MODEL-WRITE schema, so the tool and the engine can never disagree about the allowlist:
  ```ts
  import { updateProfileArgsSchema } from '@openreverie/memory'
  ```
  and replace the tool's local `z.strictObject({ timezone: ... })` with `updateProfileArgsSchema` at its `safeParse` call site.

- [ ] 6. Replace the `update_profile` tool definition's `parameters` block in `toolDefinitions()` with the full field set:
  ```ts
  {
    name: 'update_profile',
    description:
      'Record a plain fact about the person in their profile, the moment you learn it: what they want to be ' +
      'called, their pronouns, where they live, their timezone, their birthday, what they do. Also record their ' +
      'answer about birthday greetings when they give it. Write a fact only when they have actually told you; ' +
      'never infer one, not pronouns from a name, not a location from a timezone, not a birthday from an ' +
      'offhand remark about turning thirty. This is for the current value of a fact. What a fact means to them, ' +
      'and how it changed, belongs in the record you write at the end of a session, not here. You cannot change ' +
      'how you talk with them from this tool; that is /style in the terminal or the settings pane in the browser.',
    parameters: {
      type: 'object',
      properties: {
        preferredName: {
          type: 'string',
          description: 'What to call them, which is not necessarily their legal name.',
        },
        pronouns: {
          type: 'string',
          description: 'Free text, exactly as they said it. Not a fixed list.',
        },
        location: { type: 'string', description: 'Where they live, as they say it.' },
        timezone: {
          type: 'string',
          description: 'Their IANA timezone, for example Asia/Kolkata or Europe/Berlin.',
        },
        birthday: {
          type: 'string',
          description: 'MM-DD, or YYYY-MM-DD when they gave the year. Never guess a year.',
        },
        occupation: { type: 'string', description: 'Their current role, as they describe it.' },
        birthdayGreetings: {
          type: 'boolean',
          description:
            'Whether they want you to say something on their birthday. Set this from their own answer, ' +
            'never on your own judgment.',
        },
      },
      additionalProperties: false,
    },
  },
  ```

- [ ] 7. Add tool tests. Append to `packages/core/src/tools.test.ts` inside the existing top-level `describe`:
  ```ts
  describe('update_profile allowlist', () => {
    it('accepts every allowlisted field', async () => {
      const { engine, sessionId } = await openToolTestEngine()
      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_profile', {
          preferredName: 'Vish',
          pronouns: 'they/them',
          location: 'Bengaluru',
          timezone: 'Asia/Kolkata',
          birthday: '04-02',
          occupation: 'nurse',
          birthdayGreetings: false,
        }),
      )
      expect(JSON.parse(result).error).toBeUndefined()
      expect(engine.currentProfile().meta.preferredName).toBe('Vish')
    })

    it('refuses a style write, because style is never model-writable', async () => {
      const { engine, sessionId } = await openToolTestEngine()
      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_profile', { style: { tone: 'direct' } }),
      )
      expect(JSON.parse(result).error).toMatch(/update_profile/)
      expect(engine.currentProfile().meta.style).toBeUndefined()
    })
  })
  ```
  Reuse the file's existing engine helper and `call` helper; find them with `grep -n "function call(\|async function open" packages/core/src/tools.test.ts`.

- [ ] 8. Run:
  ```bash
  pnpm vitest run packages/core/src/tools.test.ts -t 'update_profile allowlist'
  ```
  Expected: 2 tests pass.

- [ ] 9. Falsify the style refusal: temporarily swap the tool's `safeParse` schema for `z.object({}).passthrough()`, run the same command, and confirm `refuses a style write` fails. Restore `updateProfileArgsSchema`.

- [ ] 10. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Widen the profile write paths to the full field set

MemoryEngine gains currentProfile, currentStyle, and two writers: the
MODEL-WRITE updateProfile over the seven-key allowlist, and
updateProfileSettings for /style, setup and the settings pane, which also
accepts style and prose. The live update_profile tool now validates with
the shared MODEL-WRITE schema, so the tool and the engine cannot disagree
about what a model may write."
  ```

---

## Task 5: Reflection writes the profile fields, and stops writing them into the constitution

Spec section 3.3. The time plan already removed "their timezone" from the identity-fact sentence and added `profileUpdates` holding `timezone` alone. This task finishes both edits: the sentence is replaced, and `profileUpdates` widens to the full MODEL-WRITE allowlist.

**Files**
- Modify: `packages/memory/src/reflection.ts`
- Modify: `packages/memory/src/reflection.test.ts`
- Modify: `packages/memory/src/engine.ts`

**Interfaces**

Consumes: `profileUpdatesSchema`, `ProfileUpdates` (Task 3), `MemoryEngine.updateProfile`, `MemoryEngine.currentProfile` (Task 4).

Produces:

```ts
// packages/memory/src/reflection.ts
export interface ReflectionOutput {
  // ...existing fields unchanged...
  profileUpdates?: ProfileUpdates
}

export interface ReflectionContext {
  // ...existing fields unchanged...
  profile: ProfileMeta
}
```

**Steps**

- [ ] 1. Add failing tests to `packages/memory/src/reflection.test.ts`:
  ```ts
  describe('profileUpdates', () => {
    it('parses every allowlisted field out of a model response', () => {
      const parsed = parseReflection(
        JSON.stringify({
          summary: 'A short session.',
          items: [],
          attributions: [],
          newArcs: [],
          newPersons: [],
          newEntities: [],
          pagePromotions: [],
          arcUpdates: [],
          personUpdates: [],
          constitutionUpdate: null,
          profileUpdates: {
            preferredName: 'Vish',
            pronouns: 'they/them',
            location: 'Bengaluru',
            timezone: 'Asia/Kolkata',
            birthday: '04-02',
            occupation: 'nurse',
            birthdayGreetings: true,
          },
        }),
      )
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data.profileUpdates?.occupation).toBe('nurse')
    })

    it('rejects a style key in profileUpdates', () => {
      const parsed = parseReflection(
        JSON.stringify({
          summary: 'A short session.',
          items: [],
          attributions: [],
          newArcs: [],
          newPersons: [],
          newEntities: [],
          pagePromotions: [],
          arcUpdates: [],
          personUpdates: [],
          constitutionUpdate: null,
          profileUpdates: { style: { tone: 'direct' } },
        }),
      )
      expect(parsed.success).toBe(false)
    })
  })

  describe('reflection prompt', () => {
    it('names the profile fields rather than routing them to the constitution', () => {
      const prompt = buildReflectionPromptForTest()
      expect(prompt).toContain('profileUpdates')
      expect(prompt).not.toContain('their timezone) always belong in the constitution')
      expect(prompt).toContain('Moved to Bangalore')
    })

    it('shows the current profile so the model can tell unset from already recorded', () => {
      const prompt = buildReflectionPromptForTest({ preferredName: 'Vish', occupation: 'nurse' })
      expect(prompt).toContain('Current profile:')
      expect(prompt).toContain('preferredName: Vish')
      expect(prompt).toContain('occupation: nurse')
    })
  })
  ```
  The file already exercises the prompt somewhere; find the existing helper with `grep -n "buildReflectionPrompt\|reflectSession(" packages/memory/src/reflection.test.ts | head -10`. If there is no exported prompt builder, export `buildReflectionPrompt` from `reflection.ts` and write the local helper as:
  ```ts
  function buildReflectionPromptForTest(profile: Record<string, unknown> = {}): string {
    return buildReflectionPrompt(
      {
        constitution: '',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        peopleTruncated: false,
        entitiesTruncated: false,
        profile: { id: 'doc_1', ...profile },
      },
      [],
    )
  }
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/reflection.test.ts -t 'profileUpdates'
  ```
  Expected: `rejects a style key in profileUpdates` fails with `expected true to be false`, because the current schema is narrower but not strict about unknown keys in that object, or because `profileUpdates` only holds `timezone` and drops the rest.

- [ ] 3. In `packages/memory/src/reflection.ts`, widen the output schema. Find the `profileUpdates` entry the time plan added to the zod output schema and replace it with:
  ```ts
  profileUpdates: profileUpdatesSchema.optional(),
  ```
  importing it at the top:
  ```ts
  import { type ProfileMeta, type ProfileUpdates, profileUpdatesSchema } from './profile.js'
  ```

- [ ] 4. Widen `RESPONSE_SHAPE`. Replace the `"profileUpdates"` line with:
  ```
    "profileUpdates": {"preferredName": string, "pronouns": string, "location": string, "timezone": string, "birthday": string, "occupation": string, "birthdayGreetings": boolean}
  ```
  Every key is optional and absent by default. There is no `style` key on it and there never can be.

- [ ] 5. Replace the identity-fact sentence in `buildReflectionPrompt`. Delete the line that currently begins `'When updating the constitution: basic identity facts about the user'` and put this in its place:
  ```ts
  "Facts and meaning go to two different places. The current value of a plain fact about the user goes in profileUpdates: what they want to be called, their pronouns, where they live, their timezone, their birthday, and what they do. Write only what they actually said; never infer a fact from another one. What a fact means to them, and how it changed, goes in constitutionUpdate. 'location: Bangalore' is a profile field. 'Moved to Bangalore and the move landed harder than expected' is the constitution. A job change is the same shape: the new title is a profileUpdates.occupation write, what the change meant is a constitution write, and a later profile write must never erase the narrative about the old job.",
  '',
  ```

- [ ] 6. Show the current profile in the prompt. Add `profile: ProfileMeta` to the `ReflectionContext` interface, and insert this block into `buildReflectionPrompt` right after the `'Constitution:'` block:
  ```ts
  'Current profile:',
  renderProfile(context.profile),
  '',
  ```
  with this helper next to `renderListing`:
  ```ts
  // Reflection sees what is already recorded so it can tell "not yet known"
  // from "already correct" and stop proposing a field that needs no change.
  function renderProfile(profile: ProfileMeta): string {
    const fields = [
      'preferredName',
      'pronouns',
      'location',
      'timezone',
      'birthday',
      'occupation',
      'birthdayGreetings',
    ] as const
    const lines: string[] = []
    for (const field of fields) {
      const value = profile[field]
      if (value === undefined) continue
      lines.push(`- ${field}: ${String(value)}`)
    }
    return lines.length === 0 ? '(nothing recorded yet)' : lines.join('\n')
  }
  ```
  Note the test asserts `preferredName: Vish` as a substring, which `- preferredName: Vish` satisfies.

- [ ] 7. Fill the new context field at the one place `ReflectionContext` is built. In `packages/memory/src/engine.ts`, find `buildReflectionContext` (`grep -n "buildReflectionContext" packages/memory/src/engine.ts`) and add to the returned object:
  ```ts
  profile: this.profile.meta,
  ```

- [ ] 8. Apply the widened updates. In `_doEndSession`, find the block the time plan added that writes `profileUpdates.timezone` and replace it with a call to the widened writer:
  ```ts
  if (output.profileUpdates !== undefined && Object.keys(output.profileUpdates).length > 0) {
    try {
      await this.updateProfile(output.profileUpdates)
    } catch (err) {
      this.warnings.push(`Could not apply reflection's profile updates: ${errorMessage(err)}`)
    }
  }
  ```
  A failure here is a warning, not a thrown error: a bad profile field must not cost the user their session summary.

- [ ] 9. Run the reflection tests and then the whole memory package:
  ```bash
  pnpm vitest run packages/memory/src/reflection.test.ts
  pnpm vitest run packages/memory/src/engine.test.ts
  ```
  Expected: both pass. Fix any existing test that constructs a `ReflectionContext` literal by adding `profile: { id: 'doc_test' }` to it; `grep -n "peopleTruncated" packages/memory/src/*.test.ts` finds every such literal.

- [ ] 10. Add the fixture tests required by spec section 16.10. Append to `packages/memory/src/reflection.test.ts`:
  ```ts
  describe('reflection fixtures, profile versus constitution', () => {
    it('puts a stated name and city in profileUpdates', async () => {
      const chat = fakeChatReturning(
        JSON.stringify({
          summary: 'They introduced themselves.',
          items: [],
          attributions: [],
          newArcs: [],
          newPersons: [],
          newEntities: [],
          pagePromotions: [],
          arcUpdates: [],
          personUpdates: [],
          constitutionUpdate: null,
          profileUpdates: { preferredName: 'Vish', location: 'Bengaluru' },
        }),
      )
      const output = await reflectSession({ chat, model: 'test' }, transcriptFixture, contextFixture)
      expect(Object.keys(output.profileUpdates ?? {}).sort()).toEqual(['location', 'preferredName'])
    })

    it('never emits style, across the fixture set', async () => {
      const chat = fakeChatReturning(
        JSON.stringify({
          summary: 'A session.',
          items: [],
          attributions: [],
          newArcs: [],
          newPersons: [],
          newEntities: [],
          pagePromotions: [],
          arcUpdates: [],
          personUpdates: [],
          constitutionUpdate: null,
          profileUpdates: { location: 'Bengaluru' },
        }),
      )
      const output = await reflectSession({ chat, model: 'test' }, transcriptFixture, contextFixture)
      expect('style' in (output.profileUpdates ?? {})).toBe(false)
    })

    it('keeps the meaning of a move in the constitution and the place in the profile', async () => {
      const chat = fakeChatReturning(
        JSON.stringify({
          summary: 'They talked about the move.',
          items: [],
          attributions: [],
          newArcs: [],
          newPersons: [],
          newEntities: [],
          pagePromotions: [],
          arcUpdates: [],
          personUpdates: [],
          constitutionUpdate: 'Moving unsettled them more than expected.',
          profileUpdates: { location: 'Bengaluru' },
        }),
      )
      const output = await reflectSession({ chat, model: 'test' }, transcriptFixture, contextFixture)
      expect(output.constitutionUpdate).not.toBeNull()
      expect(output.profileUpdates?.location).toBe('Bengaluru')
      expect(output.profileUpdates?.location?.split(' ').length).toBeLessThan(4)
    })
  })
  ```
  Reuse the file's existing fake chat provider and fixtures. Find them with `grep -n "fakeChat\|const transcript\|const context" packages/memory/src/reflection.test.ts | head -20` and rename the identifiers above to match what is already there rather than adding duplicates.

- [ ] 11. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Reflection writes profile facts instead of constitution prose

profileUpdates widens from timezone alone to the full seven-key
MODEL-WRITE allowlist, validated by profileUpdatesSchema. The identity
fact sentence is replaced: the current value of a fact goes to the
profile, its history and meaning stay in the constitution, with the
Bangalore example so the boundary is concrete. Reflection also sees the
current profile so it can tell not-yet-known from already-recorded."
  ```

---

## Task 6: The mode catalogue

Ten modes. `general` is the default and contributes nothing to the prompt. A mode declares which style axes it overrides by carrying a clause for each one, so an axis cannot be suppressed without a replacement instruction, and `tone` is not a representable key at all.

**Files**
- Create: `packages/core/src/modes.ts`
- Create: `packages/core/src/modes.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces**

Consumes: nothing.

Produces, consumed by Tasks 7, 9, 12, 14, 15, 16, 17, 18, 21, and by the journal plan:

```ts
// packages/core/src/modes.ts
export type ModeName =
  | 'general' | 'listen' | 'solve' | 'real' | 'deep'
  | 'brainstorm' | 'boost' | 'decompress' | 'process' | 'journal'

export type StyleAxis = 'engagement' | 'orientation'

export interface Mode {
  id: ModeName
  summary: string
  clauses: Partial<Record<StyleAxis, string>>
  body?: string
}

export const MODE_NAMES: readonly ModeName[]
export const MODES: Record<ModeName, Mode>
export function isModeName(value: string): value is ModeName
export function modeOverrides(mode: ModeName): StyleAxis[]
export function modeParagraph(mode: ModeName): string | undefined
```

`modeOverrides` is derived from `Object.keys(clauses)`, never declared separately. `StyleAxis` deliberately excludes `tone`: a mode that tried to override tone would not compile.

**Note for the journal plan:** `MODES.journal.clauses.orientation` and `MODES.journal.clauses.engagement` hold minimal placeholder text in this plan, and `MODES.journal.summary` holds the one-liner from the spec catalogue. The journal plan replaces exactly those three strings with its own protocol text built from `journaling.md`. Nothing else about the journal entry moves through this file.

**Steps**

- [ ] 1. Write the failing test file `packages/core/src/modes.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { isModeName, MODE_NAMES, MODES, modeOverrides, modeParagraph } from './modes.js'

  // The override table from spec section 6.2, transcribed. This test is what
  // keeps the spec and the catalogue from drifting apart: flip any cell here
  // or in the catalogue and this row fails.
  const SPEC_OVERRIDES: Record<string, string[]> = {
    general: [],
    listen: ['engagement', 'orientation'],
    solve: ['orientation'],
    real: ['engagement'],
    deep: ['engagement', 'orientation'],
    brainstorm: ['orientation'],
    boost: ['engagement'],
    decompress: ['orientation'],
    process: ['orientation'],
    journal: ['engagement', 'orientation'],
  }

  describe('mode catalogue', () => {
    it('holds exactly the ten modes from the spec', () => {
      expect([...MODE_NAMES]).toEqual([
        'general',
        'listen',
        'solve',
        'real',
        'deep',
        'brainstorm',
        'boost',
        'decompress',
        'process',
        'journal',
      ])
      expect(Object.keys(MODES).sort()).toEqual([...MODE_NAMES].sort())
    })

    it('gives every mode a non-empty one-line summary', () => {
      for (const name of MODE_NAMES) {
        expect(MODES[name].summary.length).toBeGreaterThan(10)
        expect(MODES[name].summary).not.toContain('\n')
      }
    })

    it('overrides only engagement and orientation, never tone', () => {
      for (const name of MODE_NAMES) {
        for (const axis of modeOverrides(name)) {
          expect(['engagement', 'orientation']).toContain(axis)
        }
        expect(Object.keys(MODES[name].clauses)).not.toContain('tone')
      }
    })

    // A mode that suppresses an axis and then says nothing about it has
    // deleted the user's setting and put nothing in its place. This fails
    // where a prompt-content test would not, because the resulting prompt is
    // still perfectly well-formed and just quietly says nothing about who
    // leads.
    it('gives every suppressed axis a non-empty clause', () => {
      for (const name of MODE_NAMES) {
        for (const axis of modeOverrides(name)) {
          const clause = MODES[name].clauses[axis]
          expect(clause, `${name}.${axis}`).toBeDefined()
          expect((clause ?? '').trim().length, `${name}.${axis}`).toBeGreaterThan(20)
        }
      }
    })

    it('matches the override table in spec section 6.2, mode by mode', () => {
      for (const name of MODE_NAMES) {
        expect(modeOverrides(name).sort(), name).toEqual(SPEC_OVERRIDES[name]?.sort())
      }
    })

    it('gives general no paragraph at all', () => {
      expect(modeParagraph('general')).toBeUndefined()
      expect(modeOverrides('general')).toEqual([])
    })

    it('renders the orientation clause before the engagement clause', () => {
      const paragraph = modeParagraph('listen') ?? ''
      const orientation = MODES.listen.clauses.orientation ?? ''
      const engagement = MODES.listen.clauses.engagement ?? ''
      expect(paragraph.indexOf(orientation)).toBeGreaterThanOrEqual(0)
      expect(paragraph.indexOf(engagement)).toBeGreaterThan(paragraph.indexOf(orientation))
    })

    it('carries the boost constraints the spec makes hard requirements', () => {
      const paragraph = modeParagraph('boost') ?? ''
      expect(paragraph).toContain('search memory')
      expect(paragraph).toContain('not enough')
      expect(paragraph).toMatch(/do not (make|manufactur|invent)/i)
    })

    it('recognizes mode names and refuses anything else', () => {
      expect(isModeName('listen')).toBe(true)
      expect(isModeName('Listen')).toBe(false)
      expect(isModeName('moed')).toBe(false)
    })
  })
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/modes.test.ts
  ```
  Expected: the file fails to load with `Failed to load url ./modes.js`.

- [ ] 3. Create `packages/core/src/modes.ts`:
  ```ts
  // The mode catalogue: what a particular conversation is for, as opposed to
  // style, which is how reverie talks with this person in general. A mode
  // lasts one session and is never written to disk.
  //
  // A mode declares which style axes it overrides by carrying a clause for
  // each one. That shape is the enforcement: an axis cannot be suppressed
  // without a replacement instruction, because the clause is where the
  // suppression is declared. Suppress rather than pin, because the style
  // enum values are the wrong vocabulary for what modes do: brainstorm is
  // not "solutions", and deep is not "leading" in the sense that paragraph
  // means.
  //
  // tone is not a member of StyleAxis, so no mode can override it and none
  // ever will. A snarky companion stays snarky while it listens. Mode
  // changes what the conversation is doing, not who is talking.

  export type ModeName =
    | 'general'
    | 'listen'
    | 'solve'
    | 'real'
    | 'deep'
    | 'brainstorm'
    | 'boost'
    | 'decompress'
    | 'process'
    | 'journal'

  export type StyleAxis = 'engagement' | 'orientation'

  export interface Mode {
    id: ModeName
    summary: string
    clauses: Partial<Record<StyleAxis, string>>
    body?: string
  }

  export const MODE_NAMES: readonly ModeName[] = [
    'general',
    'listen',
    'solve',
    'real',
    'deep',
    'brainstorm',
    'boost',
    'decompress',
    'process',
    'journal',
  ]

  export const MODES: Record<ModeName, Mode> = {
    general: {
      id: 'general',
      summary: 'Open conversation, no agenda. The default.',
      clauses: {},
    },
    listen: {
      id: 'listen',
      summary: 'You talk it through, it stays out of the way.',
      clauses: {
        orientation:
          'Absorb. Do not offer a next step, do not reframe what they said into something more manageable, and do not look for what this teaches them. Reflect back what was actually said when that helps them keep going. Ask a question only to keep them talking, never to redirect them. Say the thing that shows you heard it, and then stop.',
        engagement:
          'Do not raise a thread of your own, do not bring up something from a past session, and do not change the subject. Where they take it is where it goes.',
      },
    },
    solve: {
      id: 'solve',
      summary: 'A concrete problem, worked toward real options and a decision.',
      clauses: {
        orientation:
          'There is a concrete problem here. Get it stated clearly first, including what would count as solved. Then work toward real options with real trade-offs, and toward a decision. Not a plan with time blocks: the voice rules above still hold.',
      },
    },
    real: {
      id: 'real',
      summary: 'It pushes back and names what it sees. It does not soften.',
      clauses: {
        engagement:
          'Say what you actually see, including the part they would rather not hear, without waiting to be invited. Name the pattern, name the contradiction, name the thing they are avoiding. Do not cushion it into meaninglessness. This is not permission to be cruel and it is not permission to be cold: it is candour from someone on their side.',
      },
    },
    deep: {
      id: 'deep',
      summary: 'It asks the questions. It is trying to understand you, not answer anything.',
      clauses: {
        orientation:
          'You are trying to understand this person, not answer anything. Resist summarizing, resist concluding, and resist the urge to hand back an insight.',
        engagement:
          'You are the one asking. Ask, follow, ask again, and go for the thing under the thing rather than waiting to see what they offer. One question at a time still applies.',
      },
    },
    brainstorm: {
      id: 'brainstorm',
      summary: 'Quantity over judgment. Ideas riffed on, evaluation deferred.',
      clauses: {
        orientation:
          'Generate. Quantity first, evaluation later. Build on their ideas rather than judging them, offer the bad ones too, and do not narrow to one recommendation unless they ask. Say plainly that the question of which of these is best is being left for later.',
      },
    },
    boost: {
      id: 'boost',
      summary: 'Your corner talked up, from things it actually knows about you.',
      clauses: {
        engagement:
          'You are the one bringing things up, and you bring them from the record rather than from the conversation in front of you.',
      },
      body: 'Before you say anything, search memory: the graph, arcs, person pages, session summaries. What you say must come from the record. Name the thing that happened, when it happened, and what it showed. "You are resilient" is not allowed. "In March you kept showing up for that on the days it was clearly costing you, and you did not make it anyone else\'s problem" is. If the record does not support it, say so plainly: there is not enough here yet to draw on, and here is what there is. Saying you do not have much to go on yet is a correct answer in this mode. Do not manufacture: do not generalize one incident into a character trait, do not restate their own words back as if it were your observation, and do not praise the act of opening the app.',
    },
    decompress: {
      id: 'decompress',
      summary: 'Winding down. Light, low-stakes, deliberately not going deep.',
      clauses: {
        orientation:
          'They are winding down. Keep it light and low-stakes. Do not open anything heavy, do not follow a thread toward something painful, and do not ask what is really going on. If they take it somewhere deeper themselves, follow them, but do not lead there.',
      },
    },
    process: {
      id: 'process',
      summary: 'Working through one specific thing until it settles.',
      clauses: {
        orientation:
          'There is one specific thing. Stay on it until it settles. Do not change the subject, do not broaden, and do not add a second thread. Circling back over the same ground is the work here, not a failure of the conversation.',
      },
    },
    // The journal mode's real protocol, its writing formats, and its safety
    // gates belong to the journal spec. These two clauses are the minimum
    // that keeps the suppressed axes instructed until that spec ships and
    // replaces them.
    journal: {
      id: 'journal',
      summary: 'Structured written reflection.',
      clauses: {
        orientation:
          'This is written reflection rather than conversation. Give them room to write, keep your own contributions short, and do not turn what they wrote into a summary or a lesson.',
        engagement:
          'They are the one writing. Prompt once when a prompt is wanted, then stay out of the way until they are done.',
      },
    },
  }

  export function isModeName(value: string): value is ModeName {
    return (MODE_NAMES as readonly string[]).includes(value)
  }

  // Derived from the clause keys rather than declared separately, so an axis
  // cannot be suppressed without a clause to replace it.
  export function modeOverrides(mode: ModeName): StyleAxis[] {
    return Object.keys(MODES[mode].clauses) as StyleAxis[]
  }

  // The orientation clause first, then the engagement clause, then anything
  // belonging to no single axis. general contributes nothing at all, so the
  // default session prompt carries no mode paragraph.
  export function modeParagraph(mode: ModeName): string | undefined {
    const entry = MODES[mode]
    const parts: string[] = []
    if (entry.clauses.orientation) parts.push(entry.clauses.orientation)
    if (entry.clauses.engagement) parts.push(entry.clauses.engagement)
    if (entry.body) parts.push(entry.body)
    if (parts.length === 0) return undefined
    return parts.join('\n\n')
  }
  ```

- [ ] 4. Run:
  ```bash
  pnpm vitest run packages/core/src/modes.test.ts
  ```
  Expected: `Test Files  1 passed (1)` with 9 tests.

- [ ] 5. Falsify the clause-completeness test: delete `MODES.listen.clauses.engagement` entirely, run the same command, and confirm `gives every suppressed axis a non-empty clause` still passes (because the axis is no longer suppressed) but `matches the override table in spec section 6.2` fails on `listen`. Restore the clause. Then set `MODES.listen.clauses.engagement` to `''` and confirm the completeness test fails with `listen.engagement`. Restore it.

- [ ] 6. Export from the package. In `packages/core/src/index.ts`, add after `export * from './context.js'`:
  ```ts
  export * from './modes.js'
  ```

- [ ] 7. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add the ten-mode catalogue

Each mode declares the style axes it overrides by carrying a clause for
each one, so an axis cannot be suppressed without a replacement
instruction. tone is not a member of StyleAxis, so no mode can override
it. general carries no clauses and contributes no paragraph. journal's two
clauses are minimal placeholders the journal spec replaces."
  ```

---

## Task 7: Stance doctrine in the persona

A new section in `personas.ts`, present in both safety modes, part of the shared prefix so the two prompts stay identical outside the crisis stance. It lands before the mode overlay so the overlay task has a stable baseline.

**Files**
- Modify: `packages/core/src/personas.ts`
- Modify: `packages/core/src/personas.test.ts`

**Interfaces**

Consumes: nothing. Produces: `STANCE_DOCTRINE` is module-private; the test asserts on the assembled persona.

**Steps**

- [ ] 1. Add failing tests to `packages/core/src/personas.test.ts`:
  ```ts
  describe('stance doctrine', () => {
    it('tells the model to use they/them until told otherwise', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
      expect(persona).toContain('they/them until')
      expect(persona).toContain('Never assume gender, age, or pronouns')
    })

    it('extends the rule to third parties in the user\'s life', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
      expect(persona).toContain('not only to the user')
    })

    it('forbids a default shape for someone\'s life', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
      expect(persona).toContain('living situation')
      expect(persona).toContain('life stage')
    })

    it('is in the shared prefix, identical in both safety modes', () => {
      const companion = buildPersona('companion', defaultCrisisResources, defaultStyle)
      const firewall = buildPersona('firewall', defaultCrisisResources, defaultStyle)
      const marker = 'Never assume gender, age, or pronouns'
      expect(companion.slice(0, companion.indexOf(marker) + marker.length)).toEqual(
        firewall.slice(0, firewall.indexOf(marker) + marker.length),
      )
    })
  })
  ```
  `defaultCrisisResources` is already imported by this file; if it is not, add it from `./config.js`.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts -t 'stance doctrine'
  ```
  Expected: four failures, each `expected '...' to contain 'Never assume gender, age, or pronouns'`.

- [ ] 3. Add the section to `packages/core/src/personas.ts`, after `CONVERSATIONAL_VOICE`:
  ```ts
  const STANCE_DOCTRINE = `Never assume gender, age, or pronouns. Use they/them until you are told otherwise, and never infer pronouns or gender from a name, from an occupation, from a relationship, or from how someone writes.

  This applies to third parties in the user's life, not only to the user. The colleague, the partner's sibling, the therapist: they/them until the user says otherwise.

  Asking is fine. Interrogating is not. The question arises when it fits the conversation, once, and then the answer is recorded and never asked again.

  Make no assumptions about living situation, relationships, family structure, or life stage. Nothing in the way you speak should imply a default shape for someone's life.

  None of this is a stance you announce. It is how you already talk.`
  ```
  Watch the indentation: the template literal above is shown indented for readability in this plan, but it must be written flush against the left margin in the file, the same way `CONVERSATIONAL_VOICE` already is, so no leading spaces enter the prompt text.

- [ ] 4. Insert it into the section list in `buildPersona`, between `CONVERSATIONAL_VOICE` and `styleSection(style)`:
  ```ts
  const sections = [
    WHAT_REVERIE_IS,
    RETRIEVE_BEFORE_ASSERTING,
    NEVER_ASK_RULE,
    MEMORY_ORIENTATION,
    CONVERSATIONAL_VOICE,
    STANCE_DOCTRINE,
    styleSection(style),
    crisisSection(mode, resources),
  ]
  ```

- [ ] 5. Run:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts
  ```
  Expected: every test passes, the four new ones included. If an existing test asserted the exact full text of the persona, update it; `grep -n "toEqual(\|toMatchInlineSnapshot" packages/core/src/personas.test.ts` finds any.

- [ ] 6. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add the stance doctrine section to both personas

they/them until told otherwise, for third parties as well as the user, no
inference from names or occupations, and no default shape assumed for
anyone's life. It sits in the shared prefix, so the two safety modes stay
identical outside the crisis stance."
  ```

---

## Task 7A: Where profile facts get collected, and the one sentence the model is allowed to narrate

Two prompt-level rules from spec sections 15.1 and 15.2 that have no home anywhere else.

**Collection stays conversational, storage becomes structural.** The first-conversation prompt (`context.ts:53-60`) keeps its current shape exactly: a short warm welcome including the plain statement that reverie is not a therapist, then name and pronouns, then where they live and their timezone, then one thing currently going on, one question at a time. That copy is good and it is not becoming a form, so **this task changes none of it**. What changed is only where the answers go, and that is already done: the model writes them with `update_profile` as it hears them (Task 4), and reflection backfills anything missed (Task 5). The prompt does not mention profile fields, does not read like data collection, and does not ask the user to confirm anything was saved.

**Birthday is never asked**, in onboarding or anywhere else. It is recorded when it comes up naturally.

**The one exception to the no-narration rule.** `NEVER_ASK_RULE` (`personas.ts:20`) forbids narrating that something was remembered. Recording a birthday silently is fine. Signing someone up for a yearly message silently is not, because that one has a visible consequence they never agreed to. So when a birthday is first recorded, the companion says so once, in one sentence, with an easy way to decline, and writes the answer immediately so the question is never asked again. The exception is narrow and has to be stated in the prompt, or the no-narration rule swallows it.

**Files**
- Modify: `packages/core/src/personas.ts`
- Modify: `packages/core/src/personas.test.ts`

**Interfaces**

Consumes: nothing. Produces: no new exported symbols.

**Steps**

- [ ] 1. Add failing tests to `packages/core/src/personas.test.ts`:
  ```ts
  describe('birthday greetings consent', () => {
    it('names the one exception to the no-narration rule', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
      expect(persona).toContain('birthday')
      expect(persona).toContain('one sentence')
      expect(persona).toContain('never ask again')
    })

    it('still forbids narrating anything else that was remembered', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
      expect(persona).toContain('Never ask permission to remember something')
    })

    it('tells the model never to ask for a birthday', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
      expect(persona).toContain('Never ask someone for their birthday')
    })

    it('keeps the exception in the shared prefix, identical in both safety modes', () => {
      const companion = buildPersona('companion', defaultCrisisResources, defaultStyle)
      const firewall = buildPersona('firewall', defaultCrisisResources, defaultStyle)
      const marker = 'Never ask someone for their birthday'
      expect(companion.slice(0, companion.indexOf(marker) + marker.length)).toEqual(
        firewall.slice(0, firewall.indexOf(marker) + marker.length),
      )
    })
  })
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts -t 'birthday greetings consent'
  ```
  Expected: three failures, each `expected '...' to contain '...'`.

- [ ] 3. Add the section to `packages/core/src/personas.ts`, immediately after `NEVER_ASK_RULE` so the exception sits next to the rule it narrows. Write the template literal flush against the left margin, the same way the existing constants are:
  ```ts
  const BIRTHDAY_CONSENT_EXCEPTION = `Never ask someone for their birthday. It is not a question you raise, in a first conversation or in any other. Record it only when it comes up on its own: they mention one coming up, they say what year they were born, a session lands on the day itself.

  There is exactly one thing you are allowed to narrate, and this is it. The first time you record a birthday, say in one sentence that you will say something on the day, and that they can tell you not to. Then write their answer down immediately, whichever way it goes, and never ask again. Recording a birthday quietly is right. Signing someone up for a yearly message quietly is not, because that one has a consequence they never agreed to. This is the only exception: everything else you remember, you remember without saying so.`
  ```

- [ ] 4. Insert it into the section list in `buildPersona`, between `NEVER_ASK_RULE` and `MEMORY_ORIENTATION`:
  ```ts
  const sections = [
    WHAT_REVERIE_IS,
    RETRIEVE_BEFORE_ASSERTING,
    NEVER_ASK_RULE,
    BIRTHDAY_CONSENT_EXCEPTION,
    MEMORY_ORIENTATION,
    CONVERSATIONAL_VOICE,
    STANCE_DOCTRINE,
    styleSection(style),
    crisisSection(mode, resources),
  ]
  ```
  Task 8 rewrites this list again to add the mode section; that task's version already shows the final ordering, so apply this insertion now and let Task 8 build on it.

- [ ] 5. Confirm the first-conversation prompt is unchanged. It must still ask for name, pronouns, location and timezone, one question at a time, and must still say nothing about profile fields:
  ```bash
  grep -n "First conversation" -A 10 packages/core/src/context.ts
  ```
  Expected: the text is exactly what it was before this plan started. Add a test that says so, so a later change has to be deliberate:
  ```ts
  it('leaves the onboarding questions conversational and mentions no profile field', async () => {
    const { engine } = await openContextTestEngine()
    const prompt = await assembleSystemPrompt(engine, config)
    expect(prompt).toContain('their name and how they would like to be addressed')
    expect(prompt).toContain('where they live and their timezone')
    expect(prompt).not.toContain('profile.md')
    expect(prompt).not.toContain('update_profile')
    expect(prompt).not.toContain('birthday')
  })
  ```
  Put this one in `packages/core/src/context.test.ts` inside the profile section describe block from Task 9. Note the last assertion holds only for the first-conversation prompt with an empty profile: the persona's birthday sentence uses the word too, so scope the assertion to the `## First conversation` section:
  ```ts
  const firstConversation = prompt.slice(prompt.indexOf('## First conversation'))
  expect(firstConversation).not.toContain('birthday')
  ```

- [ ] 6. Run:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts
  ```
  Expected: everything passes.

- [ ] 7. Falsify: delete `BIRTHDAY_CONSENT_EXCEPTION` from the section list, run the same command, and confirm all four new tests fail. Restore it.

- [ ] 8. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Never ask for a birthday, and narrate the greeting consent once

Recording a birthday quietly is right. Signing someone up for a yearly
message quietly is not, so the first time a birthday is recorded the
companion says in one sentence that it will say something on the day and
that they can decline, writes the answer down, and never asks again. That
is the only thing the model is allowed to narrate, stated next to the rule
it narrows. The first-conversation prompt is unchanged: collection stays
conversational, only the storage became structural."
  ```

---

## Task 8: The mode overlay in the persona, and the safety invariant

A mode's paragraph is inserted after the style section and before the crisis section, and the axis paragraphs it overrides are suppressed. The crisis section stays last, byte for byte.

**Files**
- Modify: `packages/core/src/personas.ts`
- Modify: `packages/core/src/personas.test.ts`
- Modify: `packages/core/src/context.ts` (one call site)
- Modify: `packages/core/src/context.test.ts` (two call sites)

**Interfaces**

Consumes: `ModeName`, `MODES`, `modeOverrides`, `modeParagraph` (Task 6).

Produces:

```ts
// packages/core/src/personas.ts
export function buildPersona(
  mode: PersonaMode,
  resources: CrisisResource[],
  style: StyleConfig,
  activeMode?: ModeName,          // defaults to 'general'
): string
```

`activeMode` is optional and defaults to `'general'`, so every existing call site keeps compiling and keeps producing exactly what it produced before.

**Steps**

- [ ] 1. Add failing tests to `packages/core/src/personas.test.ts`:
  ```ts
  import { MODE_NAMES, MODES, modeOverrides, modeParagraph } from './modes.js'

  describe('mode overlay', () => {
    const ENGAGEMENT_MARKER = 'Your configured engagement is'
    const TONE_MARKER = 'Your configured tone is'
    const ORIENTATION_MARKER = 'Your configured orientation is'

    it('suppresses exactly the axes each mode overrides, and keeps the rest verbatim', () => {
      for (const name of MODE_NAMES) {
        const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, name)
        const overridden = modeOverrides(name)
        expect(persona.includes(ENGAGEMENT_MARKER), `${name} engagement`).toBe(
          !overridden.includes('engagement'),
        )
        expect(persona.includes(ORIENTATION_MARKER), `${name} orientation`).toBe(
          !overridden.includes('orientation'),
        )
        const paragraph = modeParagraph(name)
        if (paragraph === undefined) continue
        for (const clause of Object.values(MODES[name].clauses)) {
          expect(persona.includes(clause), `${name} clause`).toBe(true)
        }
      }
    })

    it('never suppresses tone, for any mode and any tone value', () => {
      const tones: StyleConfig['tone'][] = ['warm', 'playful', 'snarky', 'direct', 'formal']
      for (const name of MODE_NAMES) {
        for (const tone of tones) {
          const persona = buildPersona(
            'companion',
            defaultCrisisResources,
            { ...defaultStyle, tone },
            name,
          )
          expect(persona.includes(TONE_MARKER), `${name}/${tone}`).toBe(true)
          expect(persona.includes(toneParagraphText(tone)), `${name}/${tone}`).toBe(true)
        }
      }
    })

    it('states the precedence order once a mode is active', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, 'solve')
      expect(persona).toContain('this order decides, highest first')
    })

    it('says nothing about precedence in general mode', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, 'general')
      expect(persona).not.toContain('this order decides, highest first')
    })

    // Guard, not a falsification: this passes with the mode feature entirely
    // absent. It guards against general quietly growing a paragraph of its own.
    it('Guard: general is byte-identical to no mode at all', () => {
      expect(buildPersona('companion', defaultCrisisResources, defaultStyle, 'general')).toEqual(
        buildPersona('companion', defaultCrisisResources, defaultStyle),
      )
    })
  })

  describe('safety invariant', () => {
    // Position plus bytes, not presence. A naive "the crisis text is still in
    // there" assertion passes even when the mode paragraph is appended after
    // the crisis stance, which reads to the model as amending it.
    it('keeps the crisis section last and byte-identical, for all ten modes and both safety modes', () => {
      for (const safety of ['companion', 'firewall'] as const) {
        const baseline = buildPersona(safety, defaultCrisisResources, defaultStyle)
        const baselineCrisis = baseline.slice(baseline.indexOf(CRISIS_MARKER))
        expect(baselineCrisis.length).toBeGreaterThan(200)
        for (const name of MODE_NAMES) {
          const persona = buildPersona(safety, defaultCrisisResources, defaultStyle, name)
          expect(persona.endsWith(baselineCrisis), `${safety}/${name} position`).toBe(true)
          expect(persona.slice(-baselineCrisis.length), `${safety}/${name} bytes`).toEqual(
            baselineCrisis,
          )
        }
      }
    })

    it('names mode in the sentence that says style is not a permission slip', () => {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, 'real')
      expect(persona).toContain('Tone, engagement, orientation, and mode are configured')
      expect(persona).toContain('mode yields entirely')
    })

    it('keeps the shared prefix identical across safety modes with a mode active', () => {
      const companion = buildPersona('companion', defaultCrisisResources, defaultStyle, 'deep')
      const firewall = buildPersona('firewall', defaultCrisisResources, defaultStyle, 'deep')
      const cut = (text: string) => text.slice(0, text.indexOf(CRISIS_MARKER))
      expect(cut(companion)).toEqual(cut(firewall))
    })
  })
  ```
  Add these two helpers near the top of the test file, below `defaultStyle`:
  ```ts
  // The first sentence of CRISIS_DETECTION, which opens both crisis stances
  // and appears nowhere else in either persona.
  const CRISIS_MARKER = 'Deciding whether a conversation has moved into crisis territory'

  function toneParagraphText(tone: StyleConfig['tone']): string {
    return buildPersona('companion', defaultCrisisResources, { ...defaultStyle, tone })
      .split('\n\n')
      .filter((paragraph) => paragraph.startsWith('Your configured tone is'))
      .join('')
  }
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts -t 'mode overlay'
  ```
  Expected: TypeScript rejects the four-argument `buildPersona` call, reported by vitest as `Expected 3 arguments, but got 4`.

- [ ] 3. Change `packages/core/src/personas.ts`. Import the catalogue:
  ```ts
  import { MODES, type ModeName, modeOverrides, modeParagraph } from './modes.js'
  ```

- [ ] 4. Rewrite `CRISIS_OUTRANKS_TONE` so it names mode. Replace the existing constant with:
  ```ts
  const CRISIS_OUTRANKS_TONE = `Tone, engagement, orientation, and mode are configured preferences, not permission slips. The moment a conversation moves into crisis territory, all of that yields entirely to the safety mode's stance below: a playful or snarky tone never applies there, mode yields entirely whatever it says, and the posture described in that section always wins. Crisis behavior is not tunable by style and it is not tunable by mode.`
  ```

- [ ] 5. Make `styleSection` mode-aware. Replace it with:
  ```ts
  // An overridden axis has its configured paragraph suppressed, and the
  // mode's own clause stands in its place. An axis a mode does not override
  // renders exactly as it did before. tone is never overridable by any mode,
  // structurally: it is not a member of StyleAxis.
  function styleSection(style: StyleConfig, activeMode: ModeName): string {
    const overridden = modeOverrides(activeMode)
    const paragraphs: string[] = []
    if (!overridden.includes('engagement')) {
      paragraphs.push(engagementParagraph(style.engagement))
    }
    paragraphs.push(toneParagraph(style.tone))
    if (!overridden.includes('orientation')) {
      paragraphs.push(orientationParagraph(style.orientation))
    }
    paragraphs.push(CRISIS_OUTRANKS_TONE)
    return paragraphs.join('\n\n')
  }
  ```

- [ ] 6. Add the mode section builder above `buildPersona`:
  ```ts
  const PRECEDENCE_SENTENCE = `When these instructions and your configured style disagree, this order decides, highest first: the safety mode's crisis stance below, the first-conversation guidance if this is the first conversation, the personal-register rule above, this mode, and then your configured style for every axis this mode does not cover.`

  function modeSection(activeMode: ModeName): string | undefined {
    const paragraph = modeParagraph(activeMode)
    if (paragraph === undefined) return undefined
    return `## Mode: ${activeMode}\n\n${MODES[activeMode].summary}\n\n${paragraph}\n\n${PRECEDENCE_SENTENCE}`
  }
  ```

- [ ] 7. Rewrite `buildPersona`:
  ```ts
  export function buildPersona(
    mode: PersonaMode,
    resources: CrisisResource[],
    style: StyleConfig,
    activeMode: ModeName = 'general',
  ): string {
    // The crisis section stays last, always. The mode paragraph goes before
    // it, never after: an override paragraph appended after the crisis
    // stance reads as amending it, and prompt position is not a formality.
    const sections = [
      WHAT_REVERIE_IS,
      RETRIEVE_BEFORE_ASSERTING,
      NEVER_ASK_RULE,
      BIRTHDAY_CONSENT_EXCEPTION,
      MEMORY_ORIENTATION,
      CONVERSATIONAL_VOICE,
      STANCE_DOCTRINE,
      styleSection(style, activeMode),
      modeSection(activeMode),
      crisisSection(mode, resources),
    ].filter((section): section is string => section !== undefined)
    return sections.join('\n\n')
  }
  ```

- [ ] 8. Run the persona tests:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts
  ```
  Expected: everything passes.

- [ ] 9. Falsify the safety invariant, which is the point of the whole test. Move `crisisSection(mode, resources)` above `modeSection(activeMode)` in the section list, run:
  ```bash
  pnpm vitest run packages/core/src/personas.test.ts -t 'safety invariant'
  ```
  and confirm `keeps the crisis section last and byte-identical` fails with `companion/listen position: expected false to be true`. Note that a presence-only assertion would still have passed there. Restore the correct order and re-run.

- [ ] 10. Falsify the mode naming: delete `and mode` from `CRISIS_OUTRANKS_TONE`, run the same command, and confirm `names mode in the sentence` fails. Restore it.

- [ ] 11. Run the whole suite and fix the call sites that now need updating:
  ```bash
  pnpm test
  ```
  `packages/core/src/context.ts:27` and `packages/core/src/context.test.ts:162` and `:466` call `buildPersona` with three arguments. They keep compiling because `activeMode` defaults, so nothing needs changing yet; Task 9 threads the real mode through `context.ts`.

- [ ] 12. Build, lint, commit:
  ```bash
  pnpm build && pnpm lint
  git add -A && git commit -m "Overlay the active mode on the persona, ahead of the crisis section

An overridden axis has its configured paragraph suppressed and the mode's
own clause stands in its place; an axis the mode does not override renders
as before. tone is never suppressed. The mode paragraph is inserted before
the crisis section, never after, and the crisis section stays last and
byte-identical for all ten modes against both safety modes. The sentence
that says style is not a permission slip now names mode too."
  ```

---

## Task 9: The `## Profile` block in the assembled prompt, with the 2,000 character cap

The facts reach the model, not only the prose. `assembleSystemPrompt` renders whichever profile fields are set, one line each, in a fixed order. An unset field renders nothing at all: no line, no placeholder, never `unknown`, because a field the prompt claims is unknown when it is only absent is indistinguishable from one that failed to load.

**Files**
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/context.test.ts`

**Interfaces**

Consumes: `MemoryEngine.currentProfile()`, `MemoryEngine.currentStyle()` (Task 4), `ModeName` (Task 6), `buildPersona` with `activeMode` (Task 8).

Produces:

```ts
// packages/core/src/context.ts
export const PROFILE_PROSE_CAP = 2000
export const PROFILE_TRUNCATION_MARKER = '… [truncated]'

export async function assembleSystemPrompt(
  engine: MemoryEngine,
  config: ReverieConfig,
  activeMode?: ModeName,          // defaults to 'general'
): Promise<string>
```

Field order is fixed: `preferredName`, `pronouns`, `location`, `birthday`, `occupation`, `birthdayGreetings`. `timezone` is deliberately excluded, because the time plan's now-block already carries it and duplicating it invites the two to drift. `style.*` is excluded because the axes render as their own paragraphs in `personas.ts`, not as raw values. `birthdayGreetings` renders only once `birthday` is set, since the value is meaningless before that.

**Steps**

- [ ] 1. Add failing tests to `packages/core/src/context.test.ts`:
  ```ts
  describe('profile section', () => {
    it('renders a set preferred name into the prompt', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({ preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).toContain('## Profile')
      expect(prompt).toContain('Preferred name: Vish')
    })

    // Asserted together with the set case on purpose: the unset case passes
    // by coincidence if the render call is deleted, so only the pair proves
    // the section behaves.
    it('says nothing at all about an unset field, not even unknown', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({ preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).not.toContain('Pronouns')
      expect(prompt).not.toContain('unknown')
    })

    it('renders the fields in the fixed spec order', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({
        preferredName: 'Vish',
        pronouns: 'they/them',
        location: 'Bengaluru',
        birthday: '04-02',
        occupation: 'nurse',
        birthdayGreetings: true,
      })
      const prompt = await assembleSystemPrompt(engine, config)
      const order = [
        'Preferred name:',
        'Pronouns:',
        'Location:',
        'Birthday:',
        'Occupation:',
        'Birthday greetings:',
      ].map((label) => prompt.indexOf(label))
      expect(order.every((index) => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    it('leaves timezone out, because the now-block already carries it', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({ timezone: 'Asia/Kolkata', preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).not.toContain('Timezone: Asia/Kolkata')
    })

    it('hides birthdayGreetings until a birthday is recorded', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({ birthdayGreetings: true })
      const withoutBirthday = await assembleSystemPrompt(engine, config)
      expect(withoutBirthday).not.toContain('Birthday greetings:')
      await engine.updateProfile({ birthday: '04-02' })
      const withBirthday = await assembleSystemPrompt(engine, config)
      expect(withBirthday).toContain('Birthday greetings: yes')
    })

    it('omits the whole heading when nothing is set and the prose is empty', async () => {
      const { engine } = await openContextTestEngine()
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).not.toContain('## Profile')
    })

    it('renders the prose body after the fields', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({ preferredName: 'Vish' })
      await engine.updateProfileSettings({
        prose: 'Prefers to be called Vish by everyone except his mother.',
      })
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt.indexOf('except his mother')).toBeGreaterThan(
        prompt.indexOf('Preferred name: Vish'),
      )
    })

    it('truncates a prose body over the cap and marks it, without touching the file', async () => {
      const { engine, paths } = await openContextTestEngine()
      const long = 'x'.repeat(PROFILE_PROSE_CAP + 500)
      await engine.updateProfileSettings({ prose: long })
      const onDisk = await readFile(paths.profile, 'utf8')
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).toContain(PROFILE_TRUNCATION_MARKER)
      expect(prompt).not.toContain('x'.repeat(PROFILE_PROSE_CAP + 1))
      expect(prompt).toContain('x'.repeat(PROFILE_PROSE_CAP))
      expect(onDisk).toContain('x'.repeat(PROFILE_PROSE_CAP + 500))
    })

    it('leaves a prose body at exactly the cap unmarked', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfileSettings({ prose: 'y'.repeat(PROFILE_PROSE_CAP) })
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).not.toContain(PROFILE_TRUNCATION_MARKER)
    })

    it('renders the profile during the first conversation too', async () => {
      const { engine } = await openContextTestEngine()
      await engine.updateProfile({ pronouns: 'they/them' })
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).toContain('## First conversation')
      expect(prompt).toContain('Pronouns: they/them')
    })
  })

  describe('mode in the assembled prompt', () => {
    it('carries the mode paragraph when a mode is passed', async () => {
      const { engine } = await openContextTestEngine()
      const prompt = await assembleSystemPrompt(engine, config, 'listen')
      expect(prompt).toContain('## Mode: listen')
    })

    it('carries no mode section by default', async () => {
      const { engine } = await openContextTestEngine()
      const prompt = await assembleSystemPrompt(engine, config)
      expect(prompt).not.toContain('## Mode:')
    })
  })
  ```
  Reuse this file's existing engine-opening helper (`grep -n "MemoryEngine.open\|async function open" packages/core/src/context.test.ts | head -5`) and rename `openContextTestEngine` to whatever it is actually called, returning `paths` alongside `engine`. Add `readFile` from `node:fs/promises` and `PROFILE_PROSE_CAP`, `PROFILE_TRUNCATION_MARKER` to the import from `./context.js`.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/context.test.ts -t 'profile section'
  ```
  Expected: the file fails to load because `PROFILE_PROSE_CAP` is not exported from `./context.js`.

- [ ] 3. Change `packages/core/src/context.ts`. Update the imports:
  ```ts
  import type { MemoryEngine, Profile, SessionContext } from '@openreverie/memory'
  import type { ReverieConfig } from './config.js'
  import type { ModeName } from './modes.js'
  import { buildPersona } from './personas.js'
  ```

- [ ] 4. Add the cap constants and the renderer at the bottom of the file:
  ```ts
  // The prose body reaches the model capped, and the file on disk is never
  // truncated: the cap applies at prompt-assembly time only. A body over the
  // cap is cut at the character limit and marked, so the model and anyone
  // reading the assembled prompt can tell the block was cut rather than
  // complete. It is never silently dropped.
  export const PROFILE_PROSE_CAP = 2000
  export const PROFILE_TRUNCATION_MARKER = '… [truncated]'

  // Fixed order, one line per set field. An unset field renders nothing at
  // all: no line, no placeholder, never "unknown", because a prompt that
  // claims a field is unknown when it is only absent is indistinguishable
  // from one that failed to load. timezone is deliberately excluded: the
  // now-block already carries it, and a second copy invites the two to
  // drift. The style axes render as their own paragraphs in personas.ts.
  function profileSection(profile: Profile): string | undefined {
    const meta = profile.meta
    const lines: string[] = []
    if (meta.preferredName !== undefined) lines.push(`Preferred name: ${meta.preferredName}`)
    if (meta.pronouns !== undefined) lines.push(`Pronouns: ${meta.pronouns}`)
    if (meta.location !== undefined) lines.push(`Location: ${meta.location}`)
    if (meta.birthday !== undefined) lines.push(`Birthday: ${meta.birthday}`)
    if (meta.occupation !== undefined) lines.push(`Occupation: ${meta.occupation}`)
    // Meaningless before a birthday is recorded, so it is not rendered then.
    if (meta.birthday !== undefined && meta.birthdayGreetings !== undefined) {
      lines.push(`Birthday greetings: ${meta.birthdayGreetings ? 'yes' : 'no'}`)
    }

    const prose = profile.body.trim()
    const capped =
      prose.length > PROFILE_PROSE_CAP
        ? `${prose.slice(0, PROFILE_PROSE_CAP)}${PROFILE_TRUNCATION_MARKER}`
        : prose

    if (lines.length === 0 && capped.length === 0) return undefined
    const parts = [lines.join('\n'), capped].filter((part) => part.length > 0)
    return `## Profile\n\n${parts.join('\n\n')}`
  }
  ```

- [ ] 5. Rewrite `assembleSystemPrompt`:
  ```ts
  export async function assembleSystemPrompt(
    engine: MemoryEngine,
    config: ReverieConfig,
    activeMode: ModeName = 'general',
  ): Promise<string> {
    const context = await engine.sessionContext()
    const profile = engine.currentProfile()
    const persona = buildPersona(
      config.safety.mode,
      config.safety.resources,
      engine.currentStyle(),
      activeMode,
    )

    if (context.isFirstSession) {
      return [
        persona,
        todaySection(context),
        profileSection(profile),
        firstConversationSection(),
      ]
        .filter((section): section is string => section !== undefined)
        .join('\n\n')
    }

    const sections = [
      persona,
      todaySection(context),
      profileSection(profile),
      constitutionSection(context),
      realmsSection(context),
      arcsSection(context),
      peopleSection(context),
      entitiesSection(context),
      recentIntentionsSection(context),
      latestDailyRollupSection(context),
      recentSummariesSection(context),
    ].filter((section): section is string => section !== undefined)

    return sections.join('\n\n')
  }
  ```
  Note that `config.style` is gone from this call: style now comes from the profile through `engine.currentStyle()`. `ReverieConfig.style` still exists at this point and is simply no longer read here; Task 13 removes it.

- [ ] 6. Run the context tests:
  ```bash
  pnpm vitest run packages/core/src/context.test.ts
  ```
  Expected: everything passes. If an existing test asserted a prompt built from `config.style`, set the style through `engine.updateProfileSettings({ style: ... })` instead.

- [ ] 7. Falsify the profile render: delete `profileSection(profile),` from the non-first-session list, run:
  ```bash
  pnpm vitest run packages/core/src/context.test.ts -t 'profile section'
  ```
  and confirm `renders a set preferred name into the prompt` fails. Note in passing that `says nothing at all about an unset field` still passes with the render deleted, which is why the two are asserted as a pair. Restore the line.

- [ ] 8. Falsify the cap: change `PROFILE_PROSE_CAP` to `20000`, run the same test file, and confirm `truncates a prose body over the cap` fails. Then restore it and delete `PROFILE_TRUNCATION_MARKER` from the concatenation instead, and confirm the same test fails on the marker assertion. Restore both.

- [ ] 9. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Render a Profile section into the assembled system prompt

Whichever profile fields are set render one line each, in a fixed order.
An unset field renders nothing at all, never 'unknown'. timezone stays out
because the now-block already carries it. The prose body is capped at 2000
characters at assembly time with a trailing truncation marker; profile.md
on disk is never truncated. Style now comes from the profile rather than
from config."
  ```

---

## Task 10: `synthetic: true` on `TranscriptLine`

One optional field on an append-only structure. It marks a line the system wrote on the user's behalf rather than a line the person typed. Every existing transcript line has no `synthetic` key at all, its absence means what `false` would mean, so no transcript needs migrating and no reader written before this field existed breaks.

**Files**
- Modify: `packages/memory/src/transcripts.ts`
- Modify: `packages/memory/src/transcripts.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/web/src/api.ts`

**Interfaces**

Produces, and **this is the field the journal plan depends on**:

```ts
// packages/memory/src/transcripts.ts
export interface TranscriptLine {
  ts: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  synthetic?: true
}
```

`synthetic` is `true` or absent, never `false`. The journal plan's entry-body assembly excludes any line carrying `synthetic: true`; this plan guarantees only that the field exists and is set correctly at the one place that needs it, `AgentSession.setMode` in Task 12.

**Steps**

- [ ] 1. Add failing tests to `packages/memory/src/transcripts.test.ts`:
  ```ts
  describe('synthetic lines', () => {
    it('round-trips a synthetic line through the store', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await store.appendLine({
        ts: '2026-08-17T10:00:01.000Z',
        role: 'user',
        content: '/mode listen',
        synthetic: true,
      })
      const lines = await SessionStore.readTranscript(paths, store.sessionId)
      expect(lines).toHaveLength(1)
      expect(lines[0]?.synthetic).toBe(true)
    })

    it('leaves the key absent on a line the person actually typed', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await store.appendLine({
        ts: '2026-08-17T10:00:01.000Z',
        role: 'user',
        content: '/mode listen',
      })
      const raw = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')
      expect(raw).not.toContain('synthetic')
      const lines = await SessionStore.readTranscript(paths, store.sessionId)
      expect(lines[0]?.synthetic).toBeUndefined()
    })

    it('still reads a line written before the field existed', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await appendFile(
        join(store.dir, 'transcript.jsonl'),
        `${JSON.stringify({ ts: '2026-08-17T09:00:00.000Z', role: 'user', content: 'hello' })}\n`,
        'utf8',
      )
      const lines = await SessionStore.readTranscript(paths, store.sessionId)
      expect(lines[0]?.content).toBe('hello')
      expect(lines[0]?.synthetic).toBeUndefined()
    })
  })
  ```
  Reuse the file's existing temp-paths helper; find it with `grep -n "memoryPaths\|mkdtemp" packages/memory/src/transcripts.test.ts | head -5` and rename `makeTestPaths` to match.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/transcripts.test.ts -t 'synthetic'
  ```
  Expected: a TypeScript error reported by vitest, `Object literal may only specify known properties, and 'synthetic' does not exist in type 'TranscriptLine'`.

- [ ] 3. Add the field in `packages/memory/src/transcripts.ts`:
  ```ts
  export interface TranscriptLine {
    ts: string
    role: 'user' | 'assistant' | 'tool'
    content: string
    toolCalls?: ToolCall[]
    toolCallId?: string
    // Set only on lines the system wrote on the user's behalf, never on a
    // line the person typed or spoke. true or absent, never false: the
    // absence of the key means exactly what false would mean, which is why
    // no existing transcript needs migrating and no reader written before
    // this field existed breaks on it.
    synthetic?: true
  }
  ```

- [ ] 4. Run:
  ```bash
  pnpm vitest run packages/memory/src/transcripts.test.ts
  ```
  Expected: all tests pass.

- [ ] 5. Widen the two strict transcript-line schemas in the same change, because both reject an unknown key today. In `packages/server/src/app.ts`, add to `publicTranscriptLineSchema`:
  ```ts
  synthetic: z.literal(true).optional(),
  ```
  In `packages/web/src/api.ts`, add the identical line to `transcriptLineSchema`.

- [ ] 6. Add a schema test to `packages/web/src/api.test.ts`:
  ```ts
  describe('transcriptLineSchema synthetic', () => {
    it('accepts a synthetic line and a line without the key', () => {
      const base = { lineSequence: 1, ts: '2026-08-17T10:00:00.000Z', role: 'user', content: 'hi' }
      expect(transcriptLineSchema.safeParse(base).success).toBe(true)
      expect(transcriptLineSchema.safeParse({ ...base, synthetic: true }).success).toBe(true)
    })

    it('still rejects synthetic: false, which the field never carries', () => {
      const base = { lineSequence: 1, ts: '2026-08-17T10:00:00.000Z', role: 'user', content: 'hi' }
      expect(transcriptLineSchema.safeParse({ ...base, synthetic: false }).success).toBe(false)
    })
  })
  ```

- [ ] 7. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add an optional synthetic flag to TranscriptLine

It marks a line the system wrote on the user's behalf, so a record never
claims the person typed something they did not. true or absent, never
false, which is what makes it purely additive on an append-only
structure. The server and web transcript schemas gain the optional key in
the same change, since both are strict objects."
  ```

---

## Task 11: A session's mode persists to disk, and the engine reads it at end of session

The journal plan needs the mode at `endSession` time, in the memory layer, where the write happens. Session state on an object in `@openreverie/core` is not reachable from `@openreverie/memory` and must not become reachable, so the mode is pushed down rather than read up, and it is persisted to disk rather than held only in memory.

**Files**
- Modify: `packages/memory/src/transcripts.ts`
- Modify: `packages/memory/src/transcripts.test.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/engine.test.ts`

**Interfaces**

Produces, and **this is the second contract the journal plan depends on**:

```ts
// packages/memory/src/transcripts.ts
export interface SessionMeta {
  mode?: string
}
export const sessionMetaSchema: z.ZodType<SessionMeta>

// on class SessionStore
static writeMeta(paths: MemoryPaths, sessionId: string, meta: SessionMeta): Promise<void>
static readMeta(paths: MemoryPaths, sessionId: string): Promise<SessionMeta | undefined>

// packages/memory/src/engine.ts, on class MemoryEngine
setSessionMode(sessionId: string, mode: string): Promise<void>
sessionMode(sessionId: string): Promise<string | undefined>
```

The mode crosses the package boundary as a plain `string`, not `ModeName`, because `ModeName` lives in `@openreverie/core` and memory must never import it. The journal plan gates its write on the value being exactly `'journal'`, so an absent mode behaves correctly by default.

A session opened by anything that is not an `AgentSession` never calls `setSessionMode`, so no `session.json` is written and `sessionMode` returns `undefined`. Absent means absent, never `'general'`.

**Steps**

- [ ] 1. Add failing tests to `packages/memory/src/transcripts.test.ts`:
  ```ts
  describe('session metadata', () => {
    it('writes and reads back a session mode', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await SessionStore.writeMeta(paths, store.sessionId, { mode: 'journal' })
      expect(await SessionStore.readMeta(paths, store.sessionId)).toEqual({ mode: 'journal' })
    })

    it('writes it atomically, leaving no temp file in the session directory', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await SessionStore.writeMeta(paths, store.sessionId, { mode: 'listen' })
      const entries = await readdir(store.dir)
      expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
      expect(entries).toContain('session.json')
    })

    it('reports undefined for a session directory with no session.json', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      expect(await SessionStore.readMeta(paths, store.sessionId)).toBeUndefined()
    })

    it('reports undefined for a session.json that does not parse', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await writeFile(join(store.dir, 'session.json'), '{ not json', 'utf8')
      expect(await SessionStore.readMeta(paths, store.sessionId)).toBeUndefined()
    })

    it('does not touch the transcript', async () => {
      const paths = await makeTestPaths()
      const store = await SessionStore.start(paths, new Date('2026-08-17T10:00:00.000Z'))
      await store.appendLine({ ts: '2026-08-17T10:00:01.000Z', role: 'user', content: 'hello' })
      const before = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')
      await SessionStore.writeMeta(paths, store.sessionId, { mode: 'listen' })
      await SessionStore.writeMeta(paths, store.sessionId, { mode: 'journal' })
      const after = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')
      expect(after).toEqual(before)
    })
  })
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/transcripts.test.ts -t 'session metadata'
  ```
  Expected: `SessionStore.writeMeta is not a function`.

- [ ] 3. Add the metadata file to `packages/memory/src/transcripts.ts`. Extend the imports:
  ```ts
  import { access, appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
  import { ulid } from 'ulid'
  import { z } from 'zod'
  ```
  Add the constant next to `TRANSCRIPT_FILE`:
  ```ts
  const SESSION_META_FILE = 'session.json'
  ```
  Add the schema and the type near `TranscriptLine`:
  ```ts
  // A small, mutable piece of per-session metadata, kept in its own file
  // rather than as a marker line in the transcript. The transcript is
  // append-only, and mixing a value that is rewritten on every mode change
  // into that stream would mean either breaking append-only or accumulating
  // one line per change that every transcript reader then has to filter out.
  export const sessionMetaSchema = z.object({ mode: z.string().optional() }).passthrough()
  export type SessionMeta = z.infer<typeof sessionMetaSchema>
  ```
  Add the two statics to `SessionStore`:
  ```ts
  static async writeMeta(
    paths: MemoryPaths,
    sessionId: string,
    meta: SessionMeta,
  ): Promise<void> {
    const dir = await findSessionDir(paths, sessionId)
    const target = join(dir, SESSION_META_FILE)
    const tmpPath = `${target}.tmp-${ulid()}`
    await writeFile(tmpPath, `${JSON.stringify(meta)}\n`, 'utf8')
    await rename(tmpPath, target)
  }

  // A missing file, an unreadable one, and one that fails to parse all mean
  // the same thing: this session has no recorded mode. Never a default.
  static async readMeta(paths: MemoryPaths, sessionId: string): Promise<SessionMeta | undefined> {
    let dir: string
    try {
      dir = await findSessionDir(paths, sessionId)
    } catch {
      return undefined
    }
    let raw: string
    try {
      raw = await readFile(join(dir, SESSION_META_FILE), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = sessionMetaSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }
  ```

- [ ] 4. Run the transcripts tests:
  ```bash
  pnpm vitest run packages/memory/src/transcripts.test.ts
  ```
  Expected: all pass.

- [ ] 5. Add failing engine tests to `packages/memory/src/engine.test.ts`:
  ```ts
  describe('session mode', () => {
    it('records a mode set at session start', async () => {
      const { engine } = await openTestEngine()
      const sessionId = await engine.startSession()
      await engine.setSessionMode(sessionId, 'listen')
      expect(await engine.sessionMode(sessionId)).toBe('listen')
      await engine.close()
    })

    it('keeps the mode in force at the end, not the whole sequence', async () => {
      const { engine } = await openTestEngine()
      const sessionId = await engine.startSession()
      await engine.setSessionMode(sessionId, 'general')
      await engine.setSessionMode(sessionId, 'journal')
      expect(await engine.sessionMode(sessionId)).toBe('journal')
      await engine.close()
    })

    it('reports a session with no AgentSession behind it as having no mode', async () => {
      const { engine } = await openTestEngine()
      const sessionId = await engine.startSession()
      expect(await engine.sessionMode(sessionId)).toBeUndefined()
      await engine.close()
    })

    // The case section 9.4 exists to close. Holding the mode in an in-memory
    // map instead of session.json fails here while the same-process cases
    // above keep passing.
    it('survives closing and reopening the engine between the write and the read', async () => {
      const { engine, root, deps } = await openTestEngine()
      const sessionId = await engine.startSession()
      await engine.setSessionMode(sessionId, 'journal')
      await engine.close()

      const reopened = await MemoryEngine.open(root, deps, { maintenance: false })
      expect(await reopened.sessionMode(sessionId)).toBe('journal')
      await reopened.close()
    })
  })
  ```
  The helper must return `root` and `deps` so the reopen is possible; extend the existing helper rather than writing a second one.

- [ ] 6. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/engine.test.ts -t 'session mode'
  ```
  Expected: `engine.setSessionMode is not a function`.

- [ ] 7. Add the two methods to `MemoryEngine`, next to `startSession`:
  ```ts
  // Pushed down from AgentSession rather than read up out of it: core
  // depends on memory, never the other way round, so the mode is told to
  // the engine instead of the engine reaching for it.
  //
  // Written to disk, not held in a map. runMaintenance reflects stale,
  // unreflected sessions through _doEndSession in a later process: someone
  // journals for forty minutes, the process dies before /bye, and
  // reflection runs at the next startup with no live session object
  // anywhere. An in-memory-only mode would mean no journal entry is ever
  // written for that session, which is data loss rather than an edge case.
  async setSessionMode(sessionId: string, mode: string): Promise<void> {
    const existing = (await SessionStore.readMeta(this.paths, sessionId)) ?? {}
    await SessionStore.writeMeta(this.paths, sessionId, { ...existing, mode })
  }

  // The single place that knows how to answer "what mode was this session
  // in." Same-process and later-process reflection go through this identical
  // path. A session directory with no session.json, or one that fails to
  // parse, means the mode is absent. Never a default.
  async sessionMode(sessionId: string): Promise<string | undefined> {
    return (await SessionStore.readMeta(this.paths, sessionId))?.mode
  }
  ```

- [ ] 8. Read the mode in `_doEndSession`, so the seam the journal plan needs is real and tested here rather than assumed there. Add this as the first statement inside `_doEndSession`, right after `const now = new Date()`:
  ```ts
  // Read from disk rather than from any in-memory session registry, so
  // this works whether or not the process that started the session is the
  // one ending it. The journal spec's gated write reads this value.
  const sessionModeAtEnd = await this.sessionMode(sessionId)
  void sessionModeAtEnd
  ```
  The `void` is deliberate and temporary: this plan establishes and tests the read, and the journal plan is what consumes the value. Leave a comment saying exactly that, so nobody deletes it as dead code:
  ```ts
  // Consumed by the journal spec's gated entry write. Read here, in the one
  // place that knows how to answer the question, rather than in two.
  ```

- [ ] 9. Add the end-of-session test:
  ```ts
  it('has the mode available at end of session, from a fresh engine instance', async () => {
    const { engine, root, deps } = await openTestEngine()
    const sessionId = await engine.startSession()
    await engine.setSessionMode(sessionId, 'journal')
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'hello',
    })
    await engine.close()

    const reopened = await MemoryEngine.open(root, deps, { maintenance: false })
    expect(await reopened.sessionMode(sessionId)).toBe('journal')
    await reopened.endSession(sessionId)
    expect(await reopened.sessionMode(sessionId)).toBe('journal')
    await reopened.close()
  })
  ```

- [ ] 10. Run:
  ```bash
  pnpm vitest run packages/memory/src/engine.test.ts -t 'session mode'
  ```
  Expected: 5 tests pass.

- [ ] 11. Falsify the persistence. Replace the body of `setSessionMode` with an in-memory map write and `sessionMode` with a read from that map, run the same command, and confirm `survives closing and reopening the engine` fails with `expected undefined to be 'journal'` while the three same-process tests keep passing. That gap is exactly what `session.json` exists to close. Restore the disk-backed implementation.

- [ ] 12. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Persist a session's mode to session.json in the session directory

The memory layer needs the mode at end of session, and reflection can run
in a later process after the one that opened the session is gone, so the
mode is written to disk rather than held in a map. A separate file rather
than a marker line in the transcript, because the transcript is
append-only and this value is rewritten on every mode change. A session
with no session.json has no mode, never a default."
  ```

---

## Task 12: `set_mode` replaces `update_style`

`update_style` is removed entirely, not deprecated. It was dispatched through an injected persister that only the CLI wired up, so in the browser every call returned "no persister is configured": the user asked the companion to be more direct, the companion reported a confusing failure, and nothing changed. That is a live bug.

`set_mode` is the replacement, and it is designed so the bug cannot recur: mode is session-scoped, so it needs no persister, so `AgentSession` owns it and supplies the dispatch hook itself. There is no configuration under which `set_mode` is unavailable.

**Files**
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/tools.test.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/agent.test.ts`
- Modify: `packages/cli/src/chat.ts`
- Modify: `packages/cli/src/chat.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/setup.ts`

**Interfaces**

Consumes: `ModeName`, `MODES`, `MODE_NAMES`, `isModeName` (Task 6); `assembleSystemPrompt(engine, config, activeMode)` (Task 9); `MemoryEngine.setSessionMode` (Task 11); `TranscriptLine.synthetic` (Task 10).

Produces:

```ts
// packages/core/src/tools.ts
export interface ToolHooks {
  setMode?: (mode: ModeName) => Promise<void>
}
export function dispatchTool(
  engine: MemoryEngine,
  sessionId: string,
  call: ToolCall,
  hooks?: ToolHooks,
): Promise<string>
// ToolDeps is deleted.

// packages/core/src/agent.ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'thinking' }
  | { type: 'mode'; mode: ModeName }
  | { type: 'done' }

export type ModeChangeSource = 'cli' | 'web' | 'tool'

class AgentSession {
  readonly sessionId: string
  get mode(): ModeName
  static start(
    engine: MemoryEngine,
    config: ReverieConfig,
    chat: ChatProvider,
    options?: { mode?: ModeName },
  ): Promise<AgentSession>
  setMode(name: ModeName, options: { source: ModeChangeSource }): Promise<void>
  refreshSystemPrompt(): Promise<void>
}
```

`setMode` takes a `source` because the three callers differ in exactly one way, and the transcript has to say so:

| source | transcript line | `synthetic` |
| --- | --- | --- |
| `cli` | appended, `/mode <name>` | absent, the user typed it verbatim |
| `web` | appended, `/mode <name>` | `true`, a click with no keystroke behind it |
| `tool` | not appended | not applicable, the assistant tool-call line and the tool result line already record it |

Every source re-assembles the system prompt, tells `MemoryEngine.setSessionMode`, and emits nothing itself; the `mode` event is emitted by the caller for `cli` and `web` and by `runTurn` for `tool`.

**Steps**

- [ ] 1. Add failing tool tests. In `packages/core/src/tools.test.ts`, delete the entire `describe('update_style', ...)` block (currently lines 440 to 556) and the `update_style` entry in the tool-name list assertion at line 76, then append:
  ```ts
  describe('set_mode', () => {
    it('is offered as a tool and update_style is not', () => {
      const names = toolDefinitions().map((definition) => definition.name)
      expect(names).toContain('set_mode')
      expect(names).not.toContain('update_style')
    })

    it('lists all ten modes in its enum', () => {
      const definition = toolDefinitions().find((entry) => entry.name === 'set_mode')
      const properties = definition?.parameters.properties as
        | { mode?: { enum?: string[] } }
        | undefined
      expect(properties?.mode?.enum).toEqual([...MODE_NAMES])
    })

    it('tells the model to point at /style for a lasting change', () => {
      const definition = toolDefinitions().find((entry) => entry.name === 'set_mode')
      expect(definition?.description).toContain('/style')
      expect(definition?.description).toContain('settings pane')
      expect(definition?.description).toContain('this conversation only')
    })

    it('calls the hook with a valid mode', async () => {
      const { engine, sessionId } = await openToolTestEngine()
      const calls: string[] = []
      const result = await dispatchTool(engine, sessionId, call('set_mode', { mode: 'listen' }), {
        setMode: async (mode) => {
          calls.push(mode)
        },
      })
      expect(calls).toEqual(['listen'])
      expect(JSON.parse(result)).toEqual({ ok: true, mode: 'listen' })
    })

    it('returns the error shape and calls nothing for an unknown mode', async () => {
      const { engine, sessionId } = await openToolTestEngine()
      const calls: string[] = []
      const result = await dispatchTool(engine, sessionId, call('set_mode', { mode: 'moody' }), {
        setMode: async (mode) => {
          calls.push(mode)
        },
      })
      expect(JSON.parse(result).error).toMatch(/set_mode/)
      expect(calls).toEqual([])
    })

    it('reports the unknown-tool error for a stale update_style call', async () => {
      const { engine, sessionId } = await openToolTestEngine()
      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_style', { tone: 'direct' }),
        {},
      )
      expect(JSON.parse(result).error).toBe('unknown tool: update_style')
    })
  })
  ```
  Import `MODE_NAMES` from `./modes.js` at the top of the test file.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/tools.test.ts -t 'set_mode'
  ```
  Expected: `expected [ ... ] to contain 'set_mode'`.

- [ ] 3. In `packages/core/src/tools.ts`, delete these three things:
  - The `ToolDeps` interface and its whole comment block (lines 18 to 26 today).
  - The `updateStyleArgs` schema (lines 56 to 66).
  - The `update_style` entry in `toolDefinitions()` (lines 218 to 248), the `case 'update_style':` line in `dispatchTool`, and the `dispatchUpdateStyle` function.
  Also delete the now-unused `import type { StyleConfig } from './config.js'`.

- [ ] 4. Add the hooks interface and the mode args schema in their place:
  ```ts
  import { isModeName, MODE_NAMES, MODES, type ModeName } from './modes.js'

  // Mode is session state, so it needs no persister and no injected
  // configuration: AgentSession owns it, supplies this hook from runTurn,
  // and therefore works identically in the CLI and the server by
  // construction. This replaces the old ToolDeps, whose only member was a
  // style persister that only the CLI ever wired up.
  export interface ToolHooks {
    setMode?: (mode: ModeName) => Promise<void>
  }

  const setModeArgs = z.strictObject({ mode: z.string() })
  ```

- [ ] 5. Add the tool definition, in place of the deleted `update_style` entry:
  ```ts
  {
    name: 'set_mode',
    description:
      'Change what this conversation is doing, when the person asks for something this conversation needs. ' +
      'The modes are: ' +
      MODE_NAMES.map((name) => `${name} (${MODES[name].summary})`).join('; ') +
      '. The change lasts for this conversation only and is not saved. If instead they are asking for a ' +
      'lasting change to how you talk with them in general, do not call this: point them at /style in the ' +
      'terminal or the settings pane in the browser, and say plainly that you do not change that setting ' +
      'yourself.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [...MODE_NAMES],
          description: 'The mode this conversation should be in from now on.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  ```

- [ ] 6. Rewrite the dispatch signature and add the case:
  ```ts
  export async function dispatchTool(
    engine: MemoryEngine,
    sessionId: string,
    call: ToolCall,
    hooks?: ToolHooks,
  ): Promise<string> {
  ```
  and inside the switch, in place of the old `update_style` case:
  ```ts
  case 'set_mode':
    return await dispatchSetMode(hooks, parsedArgs.value)
  ```
  and the handler, in place of `dispatchUpdateStyle`:
  ```ts
  async function dispatchSetMode(hooks: ToolHooks | undefined, value: unknown): Promise<string> {
    const parsed = setModeArgs.safeParse(value)
    if (!parsed.success) return errorJson(zodErrorMessage('set_mode', parsed.error))

    if (!isModeName(parsed.data.mode)) {
      return errorJson(
        `invalid arguments for set_mode: mode must be one of ${MODE_NAMES.join(', ')}`,
      )
    }
    if (!hooks?.setMode) {
      return errorJson('set_mode is not available in this session')
    }
    await hooks.setMode(parsed.data.mode)
    return JSON.stringify({ ok: true, mode: parsed.data.mode })
  }
  ```

- [ ] 7. Run:
  ```bash
  pnpm vitest run packages/core/src/tools.test.ts
  ```
  Expected: all pass.

- [ ] 8. Add failing agent tests. In `packages/core/src/agent.test.ts`, delete the two `update_style` tests (currently around lines 342 to 440) and append:
  ```ts
  describe('session mode', () => {
    it('starts in general and reports it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      expect(session.mode).toBe('general')
    })

    it('starts in a mode passed at start, and records it on disk right away', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat, { mode: 'journal' })
      expect(session.mode).toBe('journal')
      expect(await engine.sessionMode(session.sessionId)).toBe('journal')
    })

    // Assert on the system prompt the fake provider received, not on a return
    // value: a return value can be right while the prompt is stale.
    it('carries the new mode paragraph on the next provider request after set_mode', async () => {
      const { engine, config, chat, systems } = await makeAgentFixture([
        [{ type: 'tool_call', toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"listen"}' } }],
        [{ type: 'text', text: 'ok' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      const events = []
      for await (const event of session.send('be quiet and just listen')) events.push(event)

      expect(systems[0]).not.toContain('## Mode: listen')
      expect(systems[1]).toContain('## Mode: listen')
      expect(events).toContainEqual({ type: 'mode', mode: 'listen' })
      expect(session.mode).toBe('listen')
    })

    it('leaves the mode unchanged when set_mode names something unknown', async () => {
      const { engine, config, chat } = await makeAgentFixture([
        [{ type: 'tool_call', toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"moody"}' } }],
        [{ type: 'text', text: 'ok' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      for await (const _event of session.send('switch modes')) {
        // drain
      }
      expect(session.mode).toBe('general')
    })

    // The regression test for the bug this replaces: the server starts
    // sessions with no injected dependencies at all.
    it('works on a session created with no injected dependencies', async () => {
      const { engine, config, chat } = await makeAgentFixture([
        [{ type: 'tool_call', toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"solve"}' } }],
        [{ type: 'text', text: 'ok' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      for await (const _event of session.send('help me decide')) {
        // drain
      }
      expect(session.mode).toBe('solve')
    })

    it('appends one /mode line with no synthetic key when the CLI sets it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'cli' })
      const lines = await engine.readTranscript(session.sessionId)
      const modeLines = lines.filter((line) => line.content === '/mode listen')
      expect(modeLines).toHaveLength(1)
      expect(modeLines[0]?.role).toBe('user')
      expect(modeLines[0]?.synthetic).toBeUndefined()
    })

    it('marks the /mode line synthetic when the web sets it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'web' })
      const lines = await engine.readTranscript(session.sessionId)
      const modeLines = lines.filter((line) => line.content === '/mode listen')
      expect(modeLines).toHaveLength(1)
      expect(modeLines[0]?.synthetic).toBe(true)
    })

    it('appends no line at all when the model sets it, since the tool lines already record it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'tool' })
      const lines = await engine.readTranscript(session.sessionId)
      expect(lines.filter((line) => line.content === '/mode listen')).toHaveLength(0)
    })

    it('records every mode change on disk for the engine to read at end of session', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'cli' })
      expect(await engine.sessionMode(session.sessionId)).toBe('listen')
      await session.setMode('journal', { source: 'web' })
      expect(await engine.sessionMode(session.sessionId)).toBe('journal')
    })

    // Guard, not a falsification: this passes with the mode feature entirely
    // absent. It guards against a future change that makes set_mode start
    // writing the file.
    it('Guard: profile.md is byte-identical before and after a mode change', async () => {
      const { engine, config, chat, paths } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      const before = await readFile(paths.profile, 'utf8')
      await session.setMode('real', { source: 'cli' })
      expect(await readFile(paths.profile, 'utf8')).toEqual(before)
    })

    it('applies a profile change made outside a turn when refreshSystemPrompt is called', async () => {
      const { engine, config, chat, systems } = await makeAgentFixture([[{ type: 'text', text: 'a' }]])
      const session = await AgentSession.start(engine, config, chat)
      await engine.updateProfileSettings({ style: { tone: 'direct' } })
      await session.refreshSystemPrompt()
      for await (const _event of session.send('hello')) {
        // drain
      }
      expect(systems[0]).toContain('Your configured tone is direct')
    })
  })
  ```
  `makeAgentFixture` must return `engine`, `config`, `chat`, `paths`, and a `systems: string[]` array that the fake chat provider pushes `request.system` into on every call, taking its scripted responses from the argument. Extend the file's existing fixture helper rather than adding a second one; find it with `grep -n "function makeAgent\|const fakeChat\|stream(" packages/core/src/agent.test.ts | head -20`.

- [ ] 9. Run and read the failure:
  ```bash
  pnpm vitest run packages/core/src/agent.test.ts -t 'session mode'
  ```
  Expected: `Property 'mode' does not exist on type 'AgentSession'`.

- [ ] 10. Rewrite the relevant parts of `packages/core/src/agent.ts`. Imports:
  ```ts
  import { assembleSystemPrompt } from './context.js'
  import type { ModeName } from './modes.js'
  import { dispatchTool, type ToolHooks, toolDefinitions } from './tools.js'
  ```
  The event union:
  ```ts
  export type AgentEvent =
    | { type: 'text'; text: string }
    | { type: 'tool'; name: string }
    | { type: 'thinking' }
    | { type: 'mode'; mode: ModeName }
    | { type: 'done' }

  export type ModeChangeSource = 'cli' | 'web' | 'tool'
  ```

- [ ] 11. Replace the constructor, the field list, and `start`:
  ```ts
  private readonly config: ReverieConfig
  private activeMode: ModeName

  private constructor(
    engine: MemoryEngine,
    chat: ChatProvider,
    model: string,
    system: string,
    sessionId: string,
    config: ReverieConfig,
    mode: ModeName,
  ) {
    this.engine = engine
    this.chat = chat
    this.model = model
    this.system = system
    this.sessionId = sessionId
    this.config = config
    this.activeMode = mode
  }

  get mode(): ModeName {
    return this.activeMode
  }

  static async start(
    engine: MemoryEngine,
    config: ReverieConfig,
    chat: ChatProvider,
    options: { mode?: ModeName } = {},
  ): Promise<AgentSession> {
    const mode = options.mode ?? 'general'
    const system = await assembleSystemPrompt(engine, config, mode)
    const sessionId = await engine.startSession()
    // Recorded from the session's first moment, so a process that dies
    // before /bye still leaves the mode where reflection can find it.
    await engine.setSessionMode(sessionId, mode)
    return new AgentSession(engine, chat, config.models.chat, system, sessionId, config, mode)
  }
  ```
  Delete the `toolDeps` field and the `toolDeps` parameter everywhere they appear.

- [ ] 12. Add `setMode` and `refreshSystemPrompt`:
  ```ts
  // The one place a session's mode changes, from all three callers. Each
  // caller differs in exactly one way, which the transcript has to record:
  // the CLI's /mode is a line the user literally typed, the web picker is a
  // click with no keystroke behind it, and a set_mode tool call is already
  // recorded by its own assistant tool-call line and tool result line.
  async setMode(name: ModeName, options: { source: ModeChangeSource }): Promise<void> {
    this.activeMode = name
    if (options.source !== 'tool') {
      await this.engine.appendTranscript(this.sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: `/mode ${name}`,
        ...(options.source === 'web' ? { synthetic: true as const } : {}),
      })
    }
    await this.engine.setSessionMode(this.sessionId, name)
    await this.refreshSystemPrompt()
  }

  // A public entry point, because /style and the settings pane both change
  // the profile from outside any turn. Without one, the only re-assembly in
  // the codebase is buried inside runTurn, and a /style change would apply
  // no earlier than the next session.
  async refreshSystemPrompt(): Promise<void> {
    this.system = await assembleSystemPrompt(this.engine, this.config, this.activeMode)
  }
  ```
  Note that the `/mode` line goes into the transcript only, deliberately, and not into `this.history`: it is a record of what happened to the session, not a message the model needs replayed as if the user had spoken it. The mode itself reaches the model through the re-assembled system prompt.

- [ ] 13. Replace the dispatch block in `runTurn`. The old block reads:
  ```ts
  const result = await dispatchTool(this.engine, this.sessionId, toolCall, this.toolDeps)

  if (toolCall.name === 'update_style' && !this.resultHasError(result)) {
    const resultData = JSON.parse(result)
    this.config.style = resultData.style
    this.system = await assembleSystemPrompt(this.engine, this.config)
  }
  ```
  Replace it with:
  ```ts
  let switchedTo: ModeName | undefined
  const result = await dispatchTool(this.engine, this.sessionId, toolCall, {
    setMode: async (name) => {
      // source 'tool' because the assistant tool-call line and the tool
      // result line already record this change in the transcript.
      await this.setMode(name, { source: 'tool' })
      switchedTo = name
    },
  })
  ```
  and after the tool result line is appended, emit the event:
  ```ts
  await this.appendBoth({ role: 'tool', content: result, toolCallId: toolCall.id })
  if (switchedTo !== undefined) {
    yield { type: 'mode', mode: switchedTo }
  }
  ```
  `resultHasError` becomes unused; delete it.

- [ ] 14. Widen `appendBoth` so it can carry the flag. Its `SessionMessage` type is internal to this file and does not need it, because `setMode` appends directly through `engine.appendTranscript` rather than through `appendBoth`. Leave `appendBoth` alone.

- [ ] 15. Run:
  ```bash
  pnpm vitest run packages/core/src/agent.test.ts
  ```
  Expected: all pass.

- [ ] 16. Falsify the re-assembly: delete the `await this.refreshSystemPrompt()` line from `setMode`, run the same command, and confirm `carries the new mode paragraph on the next provider request` fails with the second recorded system prompt still lacking `## Mode: listen`. Restore it.

- [ ] 17. Falsify the synthetic marking: change `options.source === 'web'` to `true`, run the same command, and confirm `appends one /mode line with no synthetic key when the CLI sets it` fails. Change it to `false` and confirm `marks the /mode line synthetic when the web sets it` fails instead. Restore the correct condition.

- [ ] 18. Clean up the CLI. In `packages/cli/src/chat.ts`:
  - Delete `createStylePersister` entirely (lines 320 to 337 today) and drop `saveConfig` and `StyleConfig` from the imports.
  - Drop `ToolDeps` from the import and delete the `toolDeps` field from `runChat`'s deps object and from the `AgentSession.start` call.
  - In `TOOL_NOTICES`, replace `update_style: 'adjusting style',` with `set_mode: 'switching mode',`.
  - In the event loop inside `runChat`, add a branch after the `'tool'` branch:
    ```ts
    } else if (event.type === 'mode') {
      statusLine.stop()
      io.write(`${dim(`[mode: ${event.mode}]`, colorEnabled)}\n`)
    }
    ```

- [ ] 19. In `packages/cli/src/index.ts`, delete `createStylePersister` from the import, from the `CliMainDeps` interface, from `defaultDeps`, and delete the line that builds `toolDeps`; the `runChat` call becomes:
  ```ts
  await deps.runChat({ engine, config, chat, io, colorEnabled })
  ```

- [ ] 20. In `packages/cli/src/setup.ts`, correct the copy that is now false. Replace the `askStyle` intro block with:
  ```ts
  io.write(
    '\nA few quick questions about how reverie talks with you. These are starting points, not ' +
      'fixed forever: you can change any of them later with /style in the terminal, or in the ' +
      'settings pane in the browser.\n',
  )
  ```

- [ ] 21. Update the CLI tests. In `packages/cli/src/chat.test.ts`:
  - Delete `describe('createStylePersister', ...)` (lines 1314 to 1356) and `describe('runChat update_style tool notice', ...)` (lines 1357 to about 1400).
  - Change line 920 from `expect(toolNotice('update_style')).toBe('[adjusting style]')` to `expect(toolNotice('set_mode')).toBe('[switching mode]')`.
  - Drop `createStylePersister` from the import list.
  In `packages/cli/src/setup.test.ts`, update any assertion on the old copy string.

- [ ] 22. Run the whole suite and fix what falls out:
  ```bash
  pnpm test
  ```
  Expected: green. `packages/server/src/registry.ts:149` calls `AgentSession.start(this.engine, this.config, this.chat)` with three arguments, which still compiles because `options` defaults.

- [ ] 23. Build, lint, commit:
  ```bash
  pnpm build && pnpm lint
  git add -A && git commit -m "Replace update_style with set_mode

update_style is gone: the tool, its dispatch, ToolDeps, the CLI's style
persister, and the setup copy that promised style could be changed by
asking. It never worked in the browser, because the server starts sessions
with no injected dependencies, so every call there reported a confusing
failure and nothing changed.

set_mode needs no persister, because mode is session state. AgentSession
owns it, supplies the dispatch hook itself, and therefore works
identically in the CLI and the server. A mode change appends one /mode
line to the transcript, marked synthetic when it came from a click rather
than a keystroke, and is recorded in session.json for reflection."
  ```

---

## Task 13: Style leaves `config.toml`

The wide one. Removing `style` from the config schema is a breaking change to every existing install, and the current code makes it a hard failure in two separate places: `configSchema` is a `z.strictObject`, so a file that still has a `[style]` table fails to load, and `withNestedDefaultsFillable` injects `style: {}` when the key is absent, so even a file that never had the table would fail. Both are handled here, together with the migration that moves the values, in one task, because splitting them leaves the build broken in between.

**Files**
- Modify: `packages/memory/package.json`
- Create: `packages/memory/src/migrations/styleToProfile.ts`
- Create: `packages/memory/src/migrations/styleToProfile.test.ts`
- Modify: `packages/memory/src/migrations/index.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config.test.ts`
- Modify: `packages/cli/src/setup.ts`
- Modify: `packages/cli/src/setup.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: nine test fixtures listed in step 9.

**Interfaces**

Consumes: `Migration`, `MigrationContext`, `MigrationResult` (time plan); `loadProfile`, `saveProfile`, `styleMetaSchema` (Tasks 1 and 2).

Produces:

```ts
// packages/memory/src/migrations/styleToProfile.ts
export const styleToProfile: Migration    // id: 'style-to-profile'

// packages/core/src/config.ts
export interface ReverieConfig {
  memoryDir: string
  provider: { name: 'openai'; apiKeyEnv?: string; apiKey?: string; baseUrl?: string }
  models: { chat: string; reflection: string; embeddings: string }
  safety: { mode: 'companion' | 'firewall'; resources: CrisisResource[] }
  // style is gone.
}

export const STYLE_MOVED_MESSAGE: string
export function readConfigMemoryDir(configPath?: string): Promise<string>
```

`readConfigMemoryDir` exists because `reverie migrate` has to find the memory folder before `loadConfig` will succeed, and on exactly the installs that need migrating it will not. It parses the TOML and reads `memoryDir` without validating anything else.

**Steps**

- [ ] 1. Give the memory package a TOML parser, since the migration has to read and rewrite `config.toml`:
  ```bash
  pnpm --filter @openreverie/memory add smol-toml@^1.4.0
  ```
  Expected: `packages/memory/package.json` gains `"smol-toml": "^1.4.0"` under `dependencies`.

- [ ] 2. Write the failing migration test at `packages/memory/src/migrations/styleToProfile.test.ts`:
  ```ts
  import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { describe, expect, it } from 'vitest'
  import { ensureMemoryTree, memoryPaths } from '../paths.js'
  import { loadProfile, saveProfile } from '../profile.js'
  import { styleToProfile } from './styleToProfile.js'

  async function makeContext(configText: string) {
    const root = await mkdtemp(join(tmpdir(), 'reverie-migrate-'))
    const paths = memoryPaths(join(root, 'memory'))
    await ensureMemoryTree(paths)
    const configPath = join(root, 'config.toml')
    await writeFile(configPath, configText, 'utf8')
    return { paths, configPath }
  }

  const CONFIG_WITH_STYLE = `memoryDir = "/tmp/does-not-matter"

  [provider]
  name = "openai"
  apiKeyEnv = "OPENAI_API_KEY"

  [models]
  chat = "gpt-5"
  reflection = "gpt-5-mini"
  embeddings = "text-embedding-3-small"

  [safety]
  mode = "companion"

  [style]
  engagement = "leading"
  tone = "snarky"
  orientation = "solutions"
  `

  const CONFIG_WITHOUT_STYLE = CONFIG_WITH_STYLE.slice(
    0,
    CONFIG_WITH_STYLE.indexOf('[style]'),
  )

  describe('style-to-profile migration', () => {
    it('has a stable id and a description', () => {
      expect(styleToProfile.id).toBe('style-to-profile')
      expect(styleToProfile.description.length).toBeGreaterThan(10)
    })

    // Case 1 from spec section 4: config has style, profile has none.
    it('moves style into the profile and drops the config table', async () => {
      const ctx = await makeContext(CONFIG_WITH_STYLE)
      expect(await styleToProfile.isPending(ctx)).toBe(true)

      const result = await styleToProfile.apply(ctx, { dryRun: false })
      expect(result.changed).toBe(true)

      const profile = await loadProfile(ctx.paths)
      expect(profile.meta.style).toEqual({
        engagement: 'leading',
        tone: 'snarky',
        orientation: 'solutions',
      })
      const config = await readFile(ctx.configPath, 'utf8')
      expect(config).not.toContain('[style]')
      expect(config).toContain('[safety]')
      expect(await styleToProfile.isPending(ctx)).toBe(false)
    })

    // Case 2: config has no style table and the profile already has style.
    it('is a no-op and reports already done', async () => {
      const ctx = await makeContext(CONFIG_WITHOUT_STYLE)
      const profile = await loadProfile(ctx.paths)
      await saveProfile(ctx.paths, {
        ...profile,
        meta: { ...profile.meta, style: { tone: 'direct' } },
      })
      expect(await styleToProfile.isPending(ctx)).toBe(false)
      const result = await styleToProfile.apply(ctx, { dryRun: false })
      expect(result.changed).toBe(false)
      expect(result.messages.join(' ')).toContain('nothing to move')
    })

    // Case 3: both have style. The profile wins, the config table is dropped
    // anyway, and the step says which values it kept and which it discarded.
    it('keeps the profile values and says which config values it discarded', async () => {
      const ctx = await makeContext(CONFIG_WITH_STYLE)
      const profile = await loadProfile(ctx.paths)
      await saveProfile(ctx.paths, {
        ...profile,
        meta: { ...profile.meta, style: { tone: 'direct' } },
      })

      const result = await styleToProfile.apply(ctx, { dryRun: false })
      const merged = await loadProfile(ctx.paths)
      expect(merged.meta.style?.tone).toBe('direct')
      expect(merged.meta.style?.engagement).toBe('leading')
      const reported = result.messages.join(' ')
      expect(reported).toContain('kept')
      expect(reported).toContain('tone')
      expect(reported).toContain('discarded')
      expect(await readFile(ctx.configPath, 'utf8')).not.toContain('[style]')
    })

    // Case 4: neither has style.
    it('is a no-op when neither file has style', async () => {
      const ctx = await makeContext(CONFIG_WITHOUT_STYLE)
      expect(await styleToProfile.isPending(ctx)).toBe(false)
      const result = await styleToProfile.apply(ctx, { dryRun: false })
      expect(result.changed).toBe(false)
    })

    it('changes nothing on a dry run, and says what it would do', async () => {
      const ctx = await makeContext(CONFIG_WITH_STYLE)
      const configBefore = await readFile(ctx.configPath, 'utf8')
      const profileBefore = await readFile(ctx.paths.profile, 'utf8')

      const result = await styleToProfile.apply(ctx, { dryRun: true })
      expect(result.changed).toBe(true)
      expect(result.messages.join(' ')).toContain('would move')
      expect(await readFile(ctx.configPath, 'utf8')).toEqual(configBefore)
      expect(await readFile(ctx.paths.profile, 'utf8')).toEqual(profileBefore)
    })

    it('is idempotent: a second run leaves both files byte-identical', async () => {
      const ctx = await makeContext(CONFIG_WITH_STYLE)
      await styleToProfile.apply(ctx, { dryRun: false })
      const configAfterFirst = await readFile(ctx.configPath, 'utf8')
      const profileAfterFirst = await readFile(ctx.paths.profile, 'utf8')

      await styleToProfile.apply(ctx, { dryRun: false })
      expect(await readFile(ctx.configPath, 'utf8')).toEqual(configAfterFirst)
      expect(await readFile(ctx.paths.profile, 'utf8')).toEqual(profileAfterFirst)
    })

    it('leaves the rewritten config readable only by its owner', async () => {
      const ctx = await makeContext(CONFIG_WITH_STYLE)
      await styleToProfile.apply(ctx, { dryRun: false })
      const { stat } = await import('node:fs/promises')
      const stats = await stat(ctx.configPath)
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })
  ```

- [ ] 3. Run and read the failure:
  ```bash
  pnpm vitest run packages/memory/src/migrations/styleToProfile.test.ts
  ```
  Expected: `Failed to load url ./styleToProfile.js`.

- [ ] 4. Create `packages/memory/src/migrations/styleToProfile.ts`:
  ```ts
  // Moves the [style] table out of config.toml and into profile.md.
  //
  // config.toml holds infrastructure: provider, API key, model names, memory
  // folder, safety mode, crisis resources. Nothing personal. A preference
  // about how someone likes to be spoken to has no business sitting in the
  // file that holds the API key and is written 0600 for exactly that reason.
  //
  // This is the first migration that reads and rewrites config.toml, which
  // is why MigrationContext carries configPath: the file lives outside the
  // memory folder and its location is overridable with --config, so a
  // migration must not guess the default path.

  import { randomBytes } from 'node:crypto'
  import { readFile, rename, writeFile } from 'node:fs/promises'
  import { basename, dirname, join } from 'node:path'
  import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
  import { loadProfile, saveProfile } from '../profile.js'
  import { type StyleMeta, styleMetaSchema } from '../style.js'
  import type { Migration, MigrationContext, MigrationResult } from './index.js'

  async function readRawConfig(configPath: string): Promise<Record<string, unknown> | undefined> {
    let text: string
    try {
      text = await readFile(configPath, 'utf8')
    } catch {
      return undefined
    }
    try {
      return parseToml(text) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  function readConfigStyle(raw: Record<string, unknown> | undefined): StyleMeta | undefined {
    if (!raw || raw.style === undefined) return undefined
    const parsed = styleMetaSchema.safeParse(raw.style)
    return parsed.success ? parsed.data : undefined
  }

  // Written with the same 0600 permissions saveConfig uses, and through the
  // same temp-file-then-rename dance, because this file holds the API key.
  async function writeConfigWithoutStyle(
    configPath: string,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const { style: _dropped, ...rest } = raw
    const text = stringifyToml(rest)
    const tmpPath = join(
      dirname(configPath),
      `.${basename(configPath)}.tmp-${randomBytes(6).toString('hex')}`,
    )
    await writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 })
    await rename(tmpPath, configPath)
  }

  export const styleToProfile: Migration = {
    id: 'style-to-profile',
    description: 'Move the [style] table from config.toml into profile.md.',

    async isPending(ctx: MigrationContext): Promise<boolean> {
      const raw = await readRawConfig(ctx.configPath)
      return raw !== undefined && raw.style !== undefined
    },

    async apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> {
      const raw = await readRawConfig(ctx.configPath)
      const configStyle = readConfigStyle(raw)

      if (raw === undefined || raw.style === undefined) {
        return { changed: false, messages: ['config.toml has no [style] table: nothing to move.'] }
      }

      const profile = await loadProfile(ctx.paths)
      const profileStyle = profile.meta.style ?? {}
      const messages: string[] = []

      // The profile wins on any axis it already has a value for, because a
      // value the user set in the settings pane must not be overwritten by a
      // stale one from TOML. The config table is dropped either way, and the
      // step says plainly which values it kept and which it discarded.
      const kept: string[] = []
      const discarded: string[] = []
      const merged: StyleMeta = { ...profileStyle }
      for (const axis of ['engagement', 'tone', 'orientation'] as const) {
        const fromConfig = configStyle?.[axis]
        if (fromConfig === undefined) continue
        if (merged[axis] === undefined) {
          merged[axis] = fromConfig
        } else if (merged[axis] !== fromConfig) {
          kept.push(`${axis}=${merged[axis]}`)
          discarded.push(`${axis}=${fromConfig}`)
        }
      }

      if (kept.length > 0) {
        messages.push(
          `profile.md already had style, so it wins: kept ${kept.join(', ')}, discarded ${discarded.join(', ')} from config.toml.`,
        )
      }

      if (opts.dryRun) {
        messages.unshift(
          `would move style from ${ctx.configPath} into ${ctx.paths.profile} and drop the [style] table.`,
        )
        return { changed: true, messages }
      }

      await saveProfile(ctx.paths, { ...profile, meta: { ...profile.meta, style: merged } })
      await writeConfigWithoutStyle(ctx.configPath, raw)
      messages.unshift(`moved style into ${ctx.paths.profile} and removed [style] from config.toml.`)
      return { changed: true, messages }
    },
  }
  ```

- [ ] 5. Run:
  ```bash
  pnpm vitest run packages/memory/src/migrations/styleToProfile.test.ts
  ```
  Expected: 8 tests pass.

- [ ] 6. Falsify idempotence: change `isPending` to always return `true` and make `apply` write unconditionally without the `raw.style === undefined` guard. Run the same command and confirm `is idempotent` fails. Restore.

- [ ] 7. Register it. In `packages/memory/src/migrations/index.ts`, add the import and append it to the ordered array:
  ```ts
  import { styleToProfile } from './styleToProfile.js'

  export const migrations: Migration[] = [
    // ...whatever the time plan registered, in order...
    styleToProfile,
  ]
  ```
  Then in `packages/memory/src/index.ts`, add:
  ```ts
  export * from './migrations/index.js'
  ```
  if the time plan has not already exported it.

- [ ] 8. Now the config removal. In `packages/core/src/config.ts`:
  - Delete `styleSchema` (lines 66 to 70 today).
  - Delete `style: styleSchema,` from `configSchema`.
  - Delete `style: StyleConfig` from `ReverieConfig`.
  - Delete `style: parsed.style,` from the returned object in `loadConfig`.
  - Delete the `if (filled.style === undefined) { filled.style = {} }` block from `withNestedDefaultsFillable`, and update that function's comment so it names only `models`.
  - Keep the `export type { StyleConfig }` re-export from Task 1: `setup.ts` and `personas.ts` still use the type, they simply no longer read it off `ReverieConfig`.
  - Add the guard and the two new exports:
  ```ts
  export const STYLE_MOVED_MESSAGE =
    'The style settings have moved out of config.toml and into profile.md. Run: reverie migrate'

  export async function readConfigMemoryDir(configPath?: string): Promise<string> {
    const resolvedPath = configPath ?? defaultConfigPath()
    let text: string
    try {
      text = await readFile(resolvedPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error('No config found. Run: reverie setup')
      }
      throw error
    }
    const raw = parseToml(text) as Record<string, unknown>
    return typeof raw.memoryDir === 'string' ? raw.memoryDir : defaultMemoryDir()
  }
  ```
  and inside `loadConfig`, between the `parseToml` call and the `safeParse`:
  ```ts
  const parsedToml = parseToml(text) as Record<string, unknown>
  // A specific error, not the generic invalid-config one, which would send
  // people off to hand-edit TOML rather than to the command that moves the
  // values for them.
  if (parsedToml.style !== undefined) {
    throw new Error(`${STYLE_MOVED_MESSAGE} (config at ${resolvedPath})`)
  }
  const raw = withNestedDefaultsFillable(parsedToml)
  ```
  Note this replaces the existing single line `const raw = withNestedDefaultsFillable(parseToml(text) as Record<string, unknown>)`. `readConfigMemoryDir` needs `defaultMemoryDir`, which is already defined in this file.

- [ ] 9. Update the nine `ReverieConfig` fixtures that now fail to compile. Delete the `style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },` line from each of:
  - `packages/cli/src/chat.test.ts:34`
  - `packages/cli/src/e2e.test.ts:78`
  - `packages/cli/src/read.test.ts:21`
  - `packages/core/src/agent.test.ts:26`
  - `packages/core/src/context.test.ts:27`
  - `packages/core/src/config.test.ts:29`
  - `packages/server/src/app.test.ts:728`
  - `packages/server/src/launch.test.ts:48`
  - `packages/server/src/registry.test.ts:272`
  and delete `style: { engagement: 'following', tone: 'snarky', orientation: 'solutions' },` from `packages/core/src/config.test.ts:63`. Line numbers are from before this task's edits; confirm each one with:
  ```bash
  grep -rn "style: {" packages/cli/src packages/core/src packages/server/src
  ```
  Expected after the edits: no matches.

- [ ] 10. Replace the config tests about the `[style]` table. In `packages/core/src/config.test.ts`, delete the tests at lines 103 and 124 (`applies balanced/warm/listening style defaults when the [style] section is omitted entirely` and `fills a defaulted field when the [style] section is present but partial`) and the `[style]` blocks in the fixtures at lines 136, 221 and 243. Add in their place:
  ```ts
  describe('style has moved out of config.toml', () => {
    it('names reverie migrate when the file still has a [style] table', async () => {
      const configPath = await writeConfigFixture(
        [
          '[provider]',
          'name = "openai"',
          'apiKeyEnv = "OPENAI_API_KEY"',
          '',
          '[safety]',
          'mode = "companion"',
          '',
          '[style]',
          'tone = "snarky"',
        ].join('\n'),
      )
      await expect(loadConfig(configPath)).rejects.toThrow(/reverie migrate/)
      await expect(loadConfig(configPath)).rejects.not.toThrow(/unknown key/)
    })

    it('loads a config with no [style] table, and the result has no style property', async () => {
      const configPath = await writeConfigFixture(
        ['[provider]', 'name = "openai"', 'apiKeyEnv = "OPENAI_API_KEY"', '', '[safety]', 'mode = "companion"'].join(
          '\n',
        ),
      )
      const config = await loadConfig(configPath)
      expect('style' in config).toBe(false)
    })

    it('readConfigMemoryDir works on a file that loadConfig would reject', async () => {
      const configPath = await writeConfigFixture(
        [
          'memoryDir = "/tmp/reverie-test-memory"',
          '[provider]',
          'name = "openai"',
          'apiKeyEnv = "OPENAI_API_KEY"',
          '',
          '[safety]',
          'mode = "companion"',
          '',
          '[style]',
          'tone = "snarky"',
        ].join('\n'),
      )
      expect(await readConfigMemoryDir(configPath)).toBe('/tmp/reverie-test-memory')
    })
  })
  ```
  Reuse the file's existing fixture-writing helper; find it with `grep -n "async function write\|mkdtemp" packages/core/src/config.test.ts | head -5` and rename `writeConfigFixture` to match. Import `readConfigMemoryDir`.

- [ ] 11. Falsify the guard: delete the `parsedToml.style !== undefined` check, run:
  ```bash
  pnpm vitest run packages/core/src/config.test.ts -t 'style has moved'
  ```
  and confirm `names reverie migrate` fails on the message text, with the generic `unknown key "style"` message appearing instead. Restore the check.

- [ ] 12. Falsify the injection removal: restore `if (filled.style === undefined) { filled.style = {} }` in `withNestedDefaultsFillable`, run the same command, and confirm `loads a config with no [style] table` fails, because the injected empty table trips the guard. Remove it again.

- [ ] 13. Make `reverie setup` write style into the profile. In `packages/cli/src/setup.ts`:
  - Delete `style,` from the `ReverieConfig` literal.
  - Add the imports:
    ```ts
    import { ensureMemoryTree, loadProfile, memoryPaths, saveProfile } from '@openreverie/memory'
    ```
  - After `await saveConfig(config, resolvedPath)`, add:
    ```ts
    // Order matters here, and getting it wrong loses data. Create the memory
    // tree first, because that is what seeds profile.md with a system-default
    // timezone when the file is absent; writing a profile before that step
    // means the seeding finds a file and skips. Then load, merge, and write
    // back, never write fresh, because a rerun on an existing folder would
    // otherwise discard every other field the person has.
    const paths = memoryPaths(memoryDir)
    await ensureMemoryTree(paths)
    const profile = await loadProfile(paths)
    await saveProfile(paths, {
      ...profile,
      meta: { ...profile.meta, style: { ...(profile.meta.style ?? {}), ...style } },
    })
    io.write(`Wrote your style choices to ${paths.profile}.\n`)
    ```

- [ ] 14. Add setup tests to `packages/cli/src/setup.test.ts`:
  ```ts
  describe('setup writes style into profile.md', () => {
    it('writes style to the profile and no [style] table to the config', async () => {
      const { configPath, memoryDir } = await runSetupWithAnswers(/* the file's existing helper */)
      const configText = await readFile(configPath, 'utf8')
      expect(configText).not.toContain('[style]')

      const paths = memoryPaths(memoryDir)
      const profile = await loadProfile(paths)
      expect(profile.meta.style).toEqual({
        engagement: 'balanced',
        tone: 'warm',
        orientation: 'listening',
      })
    })

    it('preserves every non-style profile field when setup is run twice', async () => {
      const { memoryDir } = await runSetupWithAnswers(/* first run */)
      const paths = memoryPaths(memoryDir)
      const first = await loadProfile(paths)
      await saveProfile(paths, {
        ...first,
        meta: { ...first.meta, preferredName: 'Vish', location: 'Bengaluru' },
      })

      await runSetupWithAnswers(/* second run, same memoryDir */)
      const second = await loadProfile(paths)
      expect(second.meta.preferredName).toBe('Vish')
      expect(second.meta.location).toBe('Bengaluru')
    })
  })
  ```
  Replace the `/* ... */` comments with the file's real driver. Find it with `grep -n "runSetup(" packages/cli/src/setup.test.ts | head -5`: the existing tests already script the answer sequence, so reuse that scripting rather than writing a new one, and make sure the memory folder answer points at a `mkdtemp` directory so the two runs share one folder.

- [ ] 15. Falsify the merge: replace the `saveProfile` call in `setup.ts` with a fresh write (`{ meta: { id: profile.meta.id, style }, body: '' }`), run:
  ```bash
  pnpm vitest run packages/cli/src/setup.test.ts -t 'preserves every non-style'
  ```
  and confirm it fails with `expected undefined to be 'Vish'`. Restore the merge.

- [ ] 16. Fix the four existing setup assertions on `config.style` (lines 51, 191, 202 and 220 today) to read the profile instead. For example, `expect(config.style).toEqual({...})` becomes `expect((await loadProfile(memoryPaths(memoryDir))).meta.style).toEqual({...})`.

- [ ] 17. Make `reverie migrate` work on a config that `loadConfig` now rejects. Find the migrate command the time plan added:
  ```bash
  grep -n "migrate" packages/cli/src/index.ts
  ```
  Change the memory-folder lookup in that branch from `deps.loadConfig(deps.configPath)` to `readConfigMemoryDir(deps.configPath)`, importing it from `@openreverie/core`. Add a comment saying why:
  ```ts
  // reverie migrate must run on exactly the installs loadConfig now refuses,
  // so it reads the memory folder out of the raw TOML instead of validating
  // the whole file first.
  ```
  If the time plan routed the migrate command through a `CliMainDeps` member, add `readConfigMemoryDir` to that interface and to `defaultDeps` the same way `loadConfig` is wired.

- [ ] 18. Run everything and fix the fallout:
  ```bash
  pnpm build && pnpm test
  ```
  Expected: green. Anything still referring to `config.style` is a compile error naming its file and line; there should be none left after step 9.

- [ ] 19. Lint and commit:
  ```bash
  pnpm lint
  git add -A && git commit -m "Move style out of config.toml and into profile.md

config.toml holds infrastructure and nothing personal. The [style] table
is gone from the schema and from the defaults injection, and a config file
that still has one now fails with a specific message naming reverie
migrate rather than the generic invalid-config error.

The style-to-profile migration moves the values: the profile wins on any
axis it already has, the config table is dropped either way, and the step
reports which values it kept and which it discarded. It is idempotent and
supports --dry-run. reverie setup now writes style into profile.md,
merging rather than replacing so a rerun keeps every other field."
  ```

---

## Task 14: A CLI command parser and a command table

Today the input loop compares `trimmed === '/bye'` and sends everything else to the model. Adding five more comparisons next to it is how the loop becomes unreadable. This task adds a parser and a dispatch table, moves `/bye` into it, and stops sending typo'd commands to the model.

**Files**
- Create: `packages/cli/src/commands.ts`
- Create: `packages/cli/src/commands.test.ts`
- Modify: `packages/cli/src/chat.ts`
- Modify: `packages/cli/src/chat.test.ts`

**Interfaces**

Consumes: `ModeName`, `MODES`, `MODE_NAMES`, `isModeName` (Task 6); `Profile`, `StyleConfig`, `resolveStyle` (Tasks 1, 2, 4).

Produces:

```ts
// packages/cli/src/commands.ts
export type ParsedInput =
  | { kind: 'command'; name: string; arg: string | undefined }
  | { kind: 'text'; text: string }

export function parseInput(line: string): ParsedInput

export interface CommandSession {
  readonly mode: ModeName
  setMode(name: ModeName, options: { source: 'cli' }): Promise<void>
  refreshSystemPrompt(): Promise<void>
  end(): Promise<void>
}

export interface CommandEngine {
  currentProfile(): Profile
  currentStyle(): StyleConfig
  updateProfileSettings(patch: { style?: Partial<StyleConfig> }): Promise<Profile>
}

export interface CommandContext {
  io: { write(text: string): void }
  session: CommandSession
  engine: CommandEngine
  memoryDir: string
  safetyMode: 'companion' | 'firewall'
  printWarnings: () => void
}

export type CommandOutcome = 'continue' | 'exit'

export const COMMAND_NAMES: readonly string[]
export function runCommand(
  name: string,
  arg: string | undefined,
  ctx: CommandContext,
): Promise<CommandOutcome>
```

**Steps**

- [ ] 1. Write the failing parser tests at `packages/cli/src/commands.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { parseInput } from './commands.js'

  describe('parseInput', () => {
    const table: [string, ReturnType<typeof parseInput>][] = [
      ['/bye', { kind: 'command', name: 'bye', arg: undefined }],
      ['/mode', { kind: 'command', name: 'mode', arg: undefined }],
      ['/mode listen', { kind: 'command', name: 'mode', arg: 'listen' }],
      ['/mode   listen  ', { kind: 'command', name: 'mode', arg: 'listen' }],
      ['/MODE', { kind: 'command', name: 'mode', arg: undefined }],
      ['/moed listen', { kind: 'command', name: 'moed', arg: 'listen' }],
      ['/style tone direct', { kind: 'command', name: 'style', arg: 'tone direct' }],
      ['//mode', { kind: 'text', text: '/mode' }],
      ['/usr/local/bin', { kind: 'text', text: '/usr/local/bin' }],
      ['/', { kind: 'text', text: '/' }],
      ['', { kind: 'text', text: '' }],
      ['   ', { kind: 'text', text: '' }],
      ['hello there', { kind: 'text', text: 'hello there' }],
      ['what about /mode', { kind: 'text', text: 'what about /mode' }],
      ['/1mode', { kind: 'text', text: '/1mode' }],
      ['/mode-picker', { kind: 'command', name: 'mode-picker', arg: undefined }],
    ]

    for (const [input, expected] of table) {
      it(`parses ${JSON.stringify(input)}`, () => {
        expect(parseInput(input)).toEqual(expected)
      })
    }
  })
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/cli/src/commands.test.ts
  ```
  Expected: `Failed to load url ./commands.js`.

- [ ] 3. Create `packages/cli/src/commands.ts` with the parser. This is the in-session parser only. It reads lines typed into a running session, and it is deliberately separate from the argv parser that reads `process.argv` before a session exists.
  ```ts
  // The in-session command parser and dispatch table.
  //
  // This reads lines typed at the you> prompt inside a running session. It
  // is not the argv parser: that one reads process.argv before a session
  // exists and lives in index.ts. The two are separate and stay separate.

  import { isModeName, MODE_NAMES, MODES, type ModeName } from '@openreverie/core'
  import type { Profile, StyleConfig } from '@openreverie/memory'

  export type ParsedInput =
    | { kind: 'command'; name: string; arg: string | undefined }
    | { kind: 'text'; text: string }

  const COMMAND_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/

  export function parseInput(line: string): ParsedInput {
    const trimmed = line.trim()
    if (trimmed.length === 0) return { kind: 'text', text: '' }
    if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed }

    // A leading double slash means the user meant a literal slash. Strip
    // one and send the rest to the model: typing //mode sends /mode.
    if (trimmed.startsWith('//')) return { kind: 'text', text: trimmed.slice(1) }

    const rest = trimmed.slice(1)
    const spaceAt = rest.search(/\s/)
    const token = spaceAt < 0 ? rest : rest.slice(0, spaceAt)
    if (!COMMAND_TOKEN.test(token)) {
      // A pasted path like /usr/local/bin has a slash inside its first
      // token, so it reaches the model unchanged.
      return { kind: 'text', text: trimmed }
    }

    const argument = spaceAt < 0 ? '' : rest.slice(spaceAt).trim()
    return {
      kind: 'command',
      name: token.toLowerCase(),
      arg: argument.length === 0 ? undefined : argument,
    }
  }
  ```

- [ ] 4. Run:
  ```bash
  pnpm vitest run packages/cli/src/commands.test.ts
  ```
  Expected: 16 tests pass.

- [ ] 5. Add failing dispatch tests. Append to `packages/cli/src/commands.test.ts`:
  ```ts
  import { runCommand, type CommandContext } from './commands.js'

  function makeContext(overrides: Partial<CommandContext> = {}): {
    ctx: CommandContext
    output: string[]
    ended: number[]
  } {
    const output: string[] = []
    const ended: number[] = []
    const ctx: CommandContext = {
      io: { write: (text) => output.push(text) },
      session: {
        mode: 'general',
        setMode: async () => {},
        refreshSystemPrompt: async () => {},
        end: async () => {
          ended.push(1)
        },
      },
      engine: {
        currentProfile: () => ({ meta: { id: 'doc_1' }, body: '' }),
        currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
        updateProfileSettings: async () => ({ meta: { id: 'doc_1' }, body: '' }),
      },
      memoryDir: '/tmp/memory',
      safetyMode: 'companion',
      printWarnings: () => {},
      ...overrides,
    }
    return { ctx, output, ended }
  }

  describe('runCommand', () => {
    it('ends the session on /bye and reports it', async () => {
      const { ctx, output, ended } = makeContext()
      const outcome = await runCommand('bye', undefined, ctx)
      expect(outcome).toBe('exit')
      expect(ended).toHaveLength(1)
      expect(output.join('')).toContain('reflecting on this session')
      expect(output.join('')).toContain('Saved and reflected')
    })

    it('keeps the session and says so when reflection fails on /bye', async () => {
      const { ctx, output } = makeContext({
        session: {
          mode: 'general',
          setMode: async () => {},
          refreshSystemPrompt: async () => {},
          end: async () => {
            throw new Error('index locked')
          },
        },
      })
      const outcome = await runCommand('bye', undefined, ctx)
      expect(outcome).toBe('exit')
      expect(output.join('')).toContain('I could not finish reflecting: index locked')
      expect(output.join('')).toContain('will be reflected the next time reverie starts')
    })

    it('lists every command on /help, including the double slash escape', async () => {
      const { ctx, output } = makeContext()
      await runCommand('help', undefined, ctx)
      const text = output.join('')
      for (const name of ['/help', '/mode', '/style', '/settings', '/whoami', '/bye']) {
        expect(text).toContain(name)
      }
      expect(text).toContain('//')
    })

    it('says so plainly for an unknown command and changes nothing', async () => {
      const { ctx, output } = makeContext()
      const outcome = await runCommand('moed', 'listen', ctx)
      expect(outcome).toBe('continue')
      expect(output.join('')).toContain('Unknown command: /moed. Type /help to see what there is.')
    })
  })
  ```

- [ ] 6. Run and read the failure:
  ```bash
  pnpm vitest run packages/cli/src/commands.test.ts -t 'runCommand'
  ```
  Expected: `runCommand is not a function`.

- [ ] 7. Add the context types and the table to `packages/cli/src/commands.ts`:
  ```ts
  export interface CommandSession {
    readonly mode: ModeName
    setMode(name: ModeName, options: { source: 'cli' }): Promise<void>
    refreshSystemPrompt(): Promise<void>
    end(): Promise<void>
  }

  export interface CommandEngine {
    currentProfile(): Profile
    currentStyle(): StyleConfig
    updateProfileSettings(patch: { style?: Partial<StyleConfig> }): Promise<Profile>
  }

  export interface CommandContext {
    io: { write(text: string): void }
    session: CommandSession
    engine: CommandEngine
    memoryDir: string
    safetyMode: 'companion' | 'firewall'
    printWarnings: () => void
  }

  export type CommandOutcome = 'continue' | 'exit'

  export const COMMAND_NAMES = ['help', 'mode', 'style', 'settings', 'whoami', 'bye'] as const

  const HELP_LINES = [
    '/help                 this list',
    '/mode [name]          what this conversation is for, for this conversation only',
    '/style [axis value]   how reverie talks with you in general, saved to profile.md',
    '/settings             what is set and where it lives',
    '/whoami               what reverie knows about you',
    '/bye                  reflect on this session and stop',
    '',
    'To send a message that starts with a slash, double it: //mode sends /mode.',
  ]

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async function commandBye(ctx: CommandContext): Promise<CommandOutcome> {
    ctx.io.write('reflecting on this session...\n')
    try {
      await ctx.session.end()
      ctx.printWarnings()
      ctx.io.write('Saved and reflected. See you next time.\n')
    } catch (err) {
      // Any warning the engine accumulated before the throw belongs on
      // screen either way; losing it here would be a silent drop.
      ctx.printWarnings()
      ctx.io.write(
        `\nI could not finish reflecting: ${errorMessage(err)}. Your conversation is saved; ` +
          'it will be reflected the next time reverie starts.\n',
      )
    }
    return 'exit'
  }

  function commandHelp(ctx: CommandContext): CommandOutcome {
    ctx.io.write(`${HELP_LINES.join('\n')}\n`)
    return 'continue'
  }

  export async function runCommand(
    name: string,
    arg: string | undefined,
    ctx: CommandContext,
  ): Promise<CommandOutcome> {
    switch (name) {
      case 'bye':
        return await commandBye(ctx)
      case 'help':
        return commandHelp(ctx)
      default:
        // A typo'd command does not reach the model. Sending it to a
        // companion that then improvises around it is worse than one plain
        // line of correction.
        ctx.io.write(`Unknown command: /${name}. Type /help to see what there is.\n`)
        return 'continue'
    }
  }
  ```
  `mode`, `style`, `settings` and `whoami` land in Task 15; until then they correctly fall through to the unknown-command branch, and `COMMAND_NAMES` and `HELP_LINES` already name them so the help text does not have to change twice.

- [ ] 8. Run:
  ```bash
  pnpm vitest run packages/cli/src/commands.test.ts
  ```
  Expected: all pass.

- [ ] 9. Wire the loop. In `packages/cli/src/chat.ts`, replace the block from `const trimmed = line.trim()` through the end of the `/bye` handling and the `if (trimmed === '') continue` with:
  ```ts
      const parsed = parseInput(line)
      if (parsed.kind === 'command') {
        const outcome = await runCommand(parsed.name, parsed.arg, commandContext)
        if (outcome === 'exit') return
        continue
      }
      if (parsed.text === '') {
        continue
      }
  ```
  and change the `session.send(line)` call to `session.send(parsed.text)`.

- [ ] 10. Build `commandContext` once, above the loop:
  ```ts
  const commandContext: CommandContext = {
    io,
    session,
    engine,
    memoryDir: config.memoryDir,
    safetyMode: config.safety.mode,
    printWarnings: () => printWarnings(io, engine, colorEnabled),
  }
  ```
  and add the import:
  ```ts
  import { type CommandContext, parseInput, runCommand } from './commands.js'
  ```

- [ ] 11. Confirm EOF still goes through the table. The existing line at the top of the loop already synthesizes `line = '/bye'` on readline EOF; leave it exactly as it is. It now flows through `parseInput` and `runCommand` like any typed `/bye`, so there is one place that knows what `/bye` does.

- [ ] 12. Add loop tests to `packages/cli/src/chat.test.ts`:
  ```ts
  describe('command loop', () => {
    it('never sends an unknown command to the model', async () => {
      const sent: string[] = []
      const io = makeScriptedIo(['/moed listen', '/bye'])
      await runChat(makeChatDeps({ io, recordSend: (text) => sent.push(text) }))
      expect(sent).toEqual([])
      expect(io.output.join('')).toContain('Unknown command: /moed')
    })

    it('sends an ordinary line to the model unchanged', async () => {
      const sent: string[] = []
      const io = makeScriptedIo(['hello there', '/bye'])
      await runChat(makeChatDeps({ io, recordSend: (text) => sent.push(text) }))
      expect(sent).toEqual(['hello there'])
    })

    it('sends a doubled slash through as a literal slash', async () => {
      const sent: string[] = []
      const io = makeScriptedIo(['//mode', '/bye'])
      await runChat(makeChatDeps({ io, recordSend: (text) => sent.push(text) }))
      expect(sent).toEqual(['/mode'])
    })

    it('reflects and exits on EOF, through the command table', async () => {
      const io = makeScriptedIoThatThrowsOnRead()
      await runChat(makeChatDeps({ io }))
      expect(io.output.join('')).toContain('reflecting on this session')
    })
  })
  ```
  Reuse the file's existing io fake and deps builder; find them with `grep -n "function makeIo\|function fakeIo\|runChat({" packages/cli/src/chat.test.ts | head -10` and rename to match. `recordSend` means the fake chat provider records the last user message it received.

- [ ] 13. Falsify the unknown-command rule: change the `default:` branch in `runCommand` to return `'continue'` without writing anything, and change the loop to fall through to `session.send(line)` when `runCommand` reports an unknown name. Run:
  ```bash
  pnpm vitest run packages/cli/src/chat.test.ts -t 'never sends an unknown command'
  ```
  and confirm it fails with `expected [ '/moed listen' ] to deeply equal []`. Restore.

- [ ] 14. Falsify the single-place rule for `/bye`: delete the `case 'bye':` from `runCommand` and put a `if (trimmed === '/bye')` branch back in the loop. Run `pnpm vitest run packages/cli/src/chat.test.ts -t 'reflects and exits on EOF'` and confirm it still passes, then delete the loop branch and confirm the test fails, which proves the table is what EOF actually flows through. Restore the `case 'bye':`.

- [ ] 15. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Give the CLI a command parser and a dispatch table

parseInput turns a typed line into a command or text, with a doubled
leading slash as the escape for sending a literal one and a pasted path
falling through to the model unchanged. /bye moves into the table,
including the EOF path, so there is exactly one place that knows what it
does. An unknown command prints one plain correction instead of being
sent to a companion that would improvise around it."
  ```

---

## Task 15: `/mode`, `/style`, `/settings` and `/whoami`

**Files**
- Modify: `packages/cli/src/commands.ts`
- Modify: `packages/cli/src/commands.test.ts`

**Interfaces**

Consumes everything Task 14 produced, plus `MODES`, `MODE_NAMES`, `modeOverrides`, `isModeName`, `ENGAGEMENT_VALUES`, `TONE_VALUES`, `ORIENTATION_VALUES`.

Produces: no new exported symbols. Four more cases in `runCommand`.

**Steps**

- [ ] 1. Add failing tests to `packages/cli/src/commands.test.ts`:
  ```ts
  describe('/mode', () => {
    it('lists the ten modes with the current one marked, and says it is session-only', async () => {
      const { ctx, output } = makeContext()
      await runCommand('mode', undefined, ctx)
      const text = output.join('')
      for (const name of MODE_NAMES) expect(text).toContain(name)
      expect(text).toContain('general (current)')
      expect(text).toContain('this conversation only')
    })

    it('switches and names the axes it overrides', async () => {
      const switched: string[] = []
      const { ctx, output } = makeContext({
        session: {
          mode: 'general',
          setMode: async (name) => {
            switched.push(name)
          },
          refreshSystemPrompt: async () => {},
          end: async () => {},
        },
      })
      await runCommand('mode', 'listen', ctx)
      expect(switched).toEqual(['listen'])
      const text = output.join('')
      expect(text).toContain('listen')
      expect(text).toContain('engagement')
      expect(text).toContain('orientation')
    })

    it('switches nothing and lists the valid names for an unrecognized mode', async () => {
      const switched: string[] = []
      const { ctx, output } = makeContext({
        session: {
          mode: 'general',
          setMode: async (name) => {
            switched.push(name)
          },
          refreshSystemPrompt: async () => {},
          end: async () => {},
        },
      })
      await runCommand('mode', 'moody', ctx)
      expect(switched).toEqual([])
      expect(output.join('')).toContain('general, listen, solve')
    })
  })

  describe('/style', () => {
    it('shows the three axes and their current values with no argument', async () => {
      const { ctx, output } = makeContext()
      await runCommand('style', undefined, ctx)
      const text = output.join('')
      expect(text).toContain('engagement: balanced')
      expect(text).toContain('tone: warm')
      expect(text).toContain('orientation: listening')
      expect(text).toContain('/style <axis> <value>')
    })

    it('writes a valid axis and value and re-assembles the prompt', async () => {
      const patches: unknown[] = []
      let refreshed = 0
      const { ctx, output } = makeContext({
        engine: {
          currentProfile: () => ({ meta: { id: 'doc_1' }, body: '' }),
          currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
          updateProfileSettings: async (patch) => {
            patches.push(patch)
            return { meta: { id: 'doc_1' }, body: '' }
          },
        },
        session: {
          mode: 'general',
          setMode: async () => {},
          refreshSystemPrompt: async () => {
            refreshed += 1
          },
          end: async () => {},
        },
      })
      await runCommand('style', 'tone direct', ctx)
      expect(patches).toEqual([{ style: { tone: 'direct' } }])
      expect(refreshed).toBe(1)
      expect(output.join('')).toContain('tone is now direct')
    })

    it('writes nothing for an invalid axis', async () => {
      const patches: unknown[] = []
      const { ctx, output } = makeContext({
        engine: {
          currentProfile: () => ({ meta: { id: 'doc_1' }, body: '' }),
          currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
          updateProfileSettings: async (patch) => {
            patches.push(patch)
            return { meta: { id: 'doc_1' }, body: '' }
          },
        },
      })
      await runCommand('style', 'volume loud', ctx)
      expect(patches).toEqual([])
      expect(output.join('')).toContain('engagement, tone, orientation')
    })

    it('writes nothing for an invalid value', async () => {
      const patches: unknown[] = []
      const { ctx, output } = makeContext({
        engine: {
          currentProfile: () => ({ meta: { id: 'doc_1' }, body: '' }),
          currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
          updateProfileSettings: async (patch) => {
            patches.push(patch)
            return { meta: { id: 'doc_1' }, body: '' }
          },
        },
      })
      await runCommand('style', 'tone sardonic', ctx)
      expect(patches).toEqual([])
      expect(output.join('')).toContain('warm, playful, snarky, direct, formal')
    })
  })

  describe('/settings', () => {
    it('prints what is set and where it lives, and does not offer to change safety mode', async () => {
      const { ctx, output } = makeContext()
      await runCommand('settings', undefined, ctx)
      const text = output.join('')
      expect(text).toContain('Safety mode: companion')
      expect(text).toContain('config file')
      expect(text).toContain('/tmp/memory')
      expect(text).toContain('/style')
      expect(text).toContain('/whoami')
    })
  })

  describe('/whoami', () => {
    it('prints not known for every unset field and invents nothing', async () => {
      const { ctx, output } = makeContext()
      await runCommand('whoami', undefined, ctx)
      const text = output.join('')
      expect(text).toContain('Preferred name: not known')
      expect(text).toContain('Pronouns: not known')
      expect(text).toContain('nothing here is guessed')
      expect(text).not.toContain('undefined')
    })

    it('prints the values that are set, and the prose body when there is one', async () => {
      const { ctx, output } = makeContext({
        engine: {
          currentProfile: () => ({
            meta: {
              id: 'doc_1',
              preferredName: 'Vish',
              location: 'Bengaluru',
              timezone: 'Asia/Kolkata',
            },
            body: 'Prefers to be called Vish by everyone except his mother.',
          }),
          currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
          updateProfileSettings: async () => ({ meta: { id: 'doc_1' }, body: '' }),
        },
      })
      await runCommand('whoami', undefined, ctx)
      const text = output.join('')
      expect(text).toContain('Preferred name: Vish')
      expect(text).toContain('Location: Bengaluru')
      expect(text).toContain('Timezone: Asia/Kolkata')
      expect(text).toContain('except his mother')
    })
  })
  ```
  Import `MODE_NAMES` from `@openreverie/core` at the top of the test file.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/cli/src/commands.test.ts -t '/mode'
  ```
  Expected: `expected '...' to contain 'general (current)'`, because `/mode` currently falls through to the unknown-command branch.

- [ ] 3. Add the four handlers to `packages/cli/src/commands.ts`. Extend the imports:
  ```ts
  import {
    isModeName,
    MODE_NAMES,
    MODES,
    type ModeName,
    modeOverrides,
  } from '@openreverie/core'
  import {
    ENGAGEMENT_VALUES,
    ORIENTATION_VALUES,
    type Profile,
    type StyleConfig,
    TONE_VALUES,
  } from '@openreverie/memory'
  ```
  Then:
  ```ts
  async function commandMode(
    arg: string | undefined,
    ctx: CommandContext,
  ): Promise<CommandOutcome> {
    if (arg === undefined) {
      const lines = MODE_NAMES.map((name) => {
        const marker = name === ctx.session.mode ? ' (current)' : ''
        return `  ${name}${marker}: ${MODES[name].summary}`
      })
      ctx.io.write(
        `${lines.join('\n')}\nA mode lasts for this conversation only. It is not saved.\n`,
      )
      return 'continue'
    }

    const requested = arg.trim().toLowerCase()
    if (!isModeName(requested)) {
      ctx.io.write(`No mode called ${requested}. The modes are: ${MODE_NAMES.join(', ')}.\n`)
      return 'continue'
    }

    await ctx.session.setMode(requested, { source: 'cli' })
    const overridden = modeOverrides(requested)
    const suffix =
      overridden.length === 0
        ? 'It leaves your style settings alone.'
        : `For this conversation it takes over your ${overridden.join(' and ')} setting.`
    ctx.io.write(`Mode is now ${requested}: ${MODES[requested].summary} ${suffix}\n`)
    return 'continue'
  }

  const STYLE_AXES = {
    engagement: ENGAGEMENT_VALUES,
    tone: TONE_VALUES,
    orientation: ORIENTATION_VALUES,
  } as const

  async function commandStyle(
    arg: string | undefined,
    ctx: CommandContext,
  ): Promise<CommandOutcome> {
    const style = ctx.engine.currentStyle()
    if (arg === undefined) {
      ctx.io.write(
        [
          `  engagement: ${style.engagement}`,
          `  tone: ${style.tone}`,
          `  orientation: ${style.orientation}`,
          'Change one with /style <axis> <value>. This is saved to profile.md and lasts.',
          '',
        ].join('\n'),
      )
      return 'continue'
    }

    const parts = arg.trim().split(/\s+/)
    const axis = (parts[0] ?? '').toLowerCase()
    const value = (parts[1] ?? '').toLowerCase()

    if (axis !== 'engagement' && axis !== 'tone' && axis !== 'orientation') {
      ctx.io.write(`No style axis called ${axis}. The axes are: engagement, tone, orientation.\n`)
      return 'continue'
    }

    const allowed = STYLE_AXES[axis] as readonly string[]
    if (!allowed.includes(value)) {
      ctx.io.write(`No ${axis} called ${value}. The values are: ${allowed.join(', ')}.\n`)
      return 'continue'
    }

    await ctx.engine.updateProfileSettings({ style: { [axis]: value } as Partial<StyleConfig> })
    // Re-assemble now, so the change applies to the rest of this
    // conversation rather than only to the next one.
    await ctx.session.refreshSystemPrompt()
    ctx.io.write(`Your ${axis} is now ${value}. Saved.\n`)
    return 'continue'
  }

  function commandSettings(ctx: CommandContext): CommandOutcome {
    ctx.io.write(
      [
        `Safety mode: ${ctx.safetyMode}. This one is changed by hand in the config file, deliberately.`,
        `Memory folder: ${ctx.memoryDir}`,
        'Style: /style. What reverie knows about you: /whoami.',
        '',
      ].join('\n'),
    )
    return 'continue'
  }

  function commandWhoami(ctx: CommandContext): CommandOutcome {
    const profile = ctx.engine.currentProfile()
    const meta = profile.meta
    const shown = (value: unknown): string =>
      value === undefined ? 'not known' : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)

    const lines = [
      `Preferred name: ${shown(meta.preferredName)}`,
      `Pronouns: ${shown(meta.pronouns)}`,
      `Location: ${shown(meta.location)}`,
      `Timezone: ${shown(meta.timezone)}`,
      `Birthday: ${shown(meta.birthday)}`,
      `Occupation: ${shown(meta.occupation)}`,
      `Birthday greetings: ${shown(meta.birthdayGreetings)}`,
    ]

    const body = profile.body.trim()
    if (body.length > 0) lines.push('', body)
    lines.push('', 'Nothing here is guessed. It is only what you have said or set.')
    ctx.io.write(`${lines.join('\n')}\n`)
    return 'continue'
  }
  ```

- [ ] 4. Add the four cases to the switch in `runCommand`, above the `default:`:
  ```ts
  case 'mode':
    return await commandMode(arg, ctx)
  case 'style':
    return await commandStyle(arg, ctx)
  case 'settings':
    return commandSettings(ctx)
  case 'whoami':
    return commandWhoami(ctx)
  ```

- [ ] 5. Run:
  ```bash
  pnpm vitest run packages/cli/src/commands.test.ts
  ```
  Expected: all pass.

- [ ] 6. Add the end-to-end `/style` test to `packages/cli/src/chat.test.ts`, which is the one that proves the write and the re-assembly actually reach the provider:
  ```ts
  it('applies a /style change to the rest of this conversation', async () => {
    const systems: string[] = []
    const io = makeScriptedIo(['/style tone direct', 'hello', '/bye'])
    const { paths } = await runChat(makeChatDeps({ io, recordSystem: (text) => systems.push(text) }))
    expect(systems.at(-1)).toContain('Your configured tone is direct')
    const profile = await readFile(paths.profile, 'utf8')
    expect(profile).toContain('direct')
  })

  it('writes nothing for an invalid /style value', async () => {
    const io = makeScriptedIo(['/style tone sardonic', '/bye'])
    const { paths } = await runChat(makeChatDeps({ io }))
    const before = await readFile(paths.profile, 'utf8')
    expect(before).not.toContain('sardonic')
  })
  ```
  Extend the file's deps builder so it returns the memory paths and records every system prompt the fake provider receives.

- [ ] 7. Falsify the re-assembly: delete `await ctx.session.refreshSystemPrompt()` from `commandStyle`, run:
  ```bash
  pnpm vitest run packages/cli/src/chat.test.ts -t 'applies a /style change'
  ```
  and confirm it fails, because the last system prompt still carries the warm paragraph. Restore it.

- [ ] 8. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add /mode, /style, /settings and /whoami

/mode lists the ten modes with the current one marked, or switches and
names the axes it takes over for the session. /style shows the three axes
or writes one to profile.md and re-assembles the prompt so the change
applies to the rest of the conversation. /settings prints what is set and
where it lives, read-only. /whoami prints what is recorded, with 'not
known' for anything unset and a closing line saying nothing here is
guessed."
  ```

---

## Task 16: The persistent status line

A second, separate component from the transient spinner at `packages/cli/src/status.ts:34-79`. The spinner runs only between the end of a turn and the first output, is gated entirely on `colorEnabled`, and repaints in place. The strip is printed once, on its own line, immediately before each `you> ` prompt, is not animated, and never repaints. The two never write in the same frame: the spinner only runs while a reply is streaming, the strip only prints while nothing is.

```
general · warm · Bengaluru 4:19pm IST · 12m
```

Four segments and nothing else. It exists so the user can see the two things the model's behaviour depends on that are otherwise invisible, plus enough orientation to know how long they have been at it.

**Files**
- Create: `packages/cli/src/strip.ts`
- Create: `packages/cli/src/strip.test.ts`
- Modify: `packages/cli/src/chat.ts`
- Modify: `packages/cli/src/chat.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces**

Produces:

```ts
// packages/cli/src/strip.ts
export interface StatusStripInput {
  mode: string
  tone: string
  location?: string
  localTime?: string
  zoneAbbrev?: string
  elapsedMs: number
}

export function renderStatusStrip(input: StatusStripInput): string

export function formatStripTime(
  timezone: string | undefined,
  now: Date,
): { localTime: string; zoneAbbrev: string } | undefined
```

`renderStatusStrip` is pure, so it is tested without a clock. `runChat` gains `interactive?: boolean`, defaulting to `false`, so every existing caller and every existing test keeps working and piped output stays exactly as captured tests expect it.

Gating is two conditions, not one. Today `index.ts:42-43` collapses them: `colorsEnabled()` is `isTTY && !NO_COLOR`. A user who sets `NO_COLOR` wants no colour, not less information, so the strip is shown when `interactive` is true and its dim styling is applied only when `colorEnabled` is true.

**Steps**

- [ ] 1. Write the failing test file `packages/cli/src/strip.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { formatStripTime, renderStatusStrip } from './strip.js'

  describe('renderStatusStrip', () => {
    it('renders all four segments when everything is known', () => {
      expect(
        renderStatusStrip({
          mode: 'general',
          tone: 'warm',
          location: 'Bengaluru',
          localTime: '4:19pm',
          zoneAbbrev: 'IST',
          elapsedMs: 12 * 60 * 1000,
        }),
      ).toBe('general · warm · Bengaluru 4:19pm IST · 12m')
    })

    it('drops the place name when the location is unknown', () => {
      expect(
        renderStatusStrip({
          mode: 'listen',
          tone: 'direct',
          localTime: '4:19pm',
          zoneAbbrev: 'IST',
          elapsedMs: 0,
        }),
      ).toBe('listen · direct · 4:19pm IST · 0m')
    })

    it('omits the whole time segment when the zone could not be rendered', () => {
      const line = renderStatusStrip({
        mode: 'general',
        tone: 'warm',
        location: 'Bengaluru',
        elapsedMs: 60_000,
      })
      expect(line).toBe('general · warm · 1m')
      expect(line).not.toContain('UTC')
      expect(line).not.toContain('Bengaluru')
    })

    it('renders 0m for anything under a minute', () => {
      expect(renderStatusStrip({ mode: 'general', tone: 'warm', elapsedMs: 59_000 })).toBe(
        'general · warm · 0m',
      )
    })

    it('rounds elapsed down to whole minutes', () => {
      expect(renderStatusStrip({ mode: 'general', tone: 'warm', elapsedMs: 121_000 })).toBe(
        'general · warm · 2m',
      )
    })
  })

  describe('formatStripTime', () => {
    it('renders a local time and zone abbreviation for a real zone', () => {
      const formatted = formatStripTime('Asia/Kolkata', new Date('2026-08-17T10:49:00.000Z'))
      expect(formatted?.localTime).toBe('4:19pm')
      expect(formatted?.zoneAbbrev).toBe('GMT+5:30')
    })

    it('returns undefined for a zone Intl rejects', () => {
      expect(formatStripTime('Mars/Olympus', new Date())).toBeUndefined()
    })

    it('returns undefined when no zone is set, rather than falling back to the host', () => {
      expect(formatStripTime(undefined, new Date())).toBeUndefined()
    })
  })
  ```
  Node's `Intl` renders `Asia/Kolkata` as `GMT+5:30` under the short time-zone-name style rather than as `IST`, so the assertion above states what Node actually produces. Run this check before writing the implementation and put the real value in the test if it differs on this Node build:
  ```bash
  node -e "console.log(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Kolkata',timeZoneName:'short'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName').value)"
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/cli/src/strip.test.ts
  ```
  Expected: `Failed to load url ./strip.js`.

- [ ] 3. Create `packages/cli/src/strip.ts`:
  ```ts
  // The persistent status strip: mode, tone, local place and time, session
  // elapsed. Four segments and nothing else.
  //
  // This is a different component from the spinner in status.ts. The spinner
  // is transient, animated, repaints in place, and is gated entirely on
  // colorEnabled. The strip is printed once on its own line before each
  // prompt, is never animated, and is gated on whether the terminal is
  // interactive. They never write in the same frame: the spinner only runs
  // while a reply is streaming, the strip only prints while nothing is.
  //
  // The strip exists so the user can see the two things the model's
  // behaviour depends on that are otherwise invisible, mode and tone, plus
  // enough orientation to know how long they have been at it. Token counts,
  // memory statistics and a hint of the day are deliberately not here.

  export interface StatusStripInput {
    mode: string
    tone: string
    location?: string
    localTime?: string
    zoneAbbrev?: string
    elapsedMs: number
  }

  const SEPARATOR = ' · '

  export function renderStatusStrip(input: StatusStripInput): string {
    const segments: string[] = [input.mode, input.tone]

    // A guessed zone is still shown, because it is almost always right and
    // the user can see at a glance if it is not. It is never dressed up with
    // a place name the user never gave, and it never falls back to the host
    // zone when the profile could not supply one: a silent substitution is
    // how a wrong local time becomes invisible.
    if (input.localTime !== undefined && input.zoneAbbrev !== undefined) {
      const place = input.location === undefined ? '' : `${input.location} `
      segments.push(`${place}${input.localTime} ${input.zoneAbbrev}`)
    }

    segments.push(`${Math.floor(input.elapsedMs / 60_000)}m`)
    return segments.join(SEPARATOR)
  }

  // Returns undefined rather than guessing when there is no zone, or when
  // Intl rejects the one there is. The caller omits the segment entirely in
  // that case.
  export function formatStripTime(
    timezone: string | undefined,
    now: Date,
  ): { localTime: string; zoneAbbrev: string } | undefined {
    if (timezone === undefined) return undefined
    try {
      const timeParts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).formatToParts(now)

      const hour = timeParts.find((part) => part.type === 'hour')?.value ?? ''
      const minute = timeParts.find((part) => part.type === 'minute')?.value ?? ''
      const dayPeriod = (timeParts.find((part) => part.type === 'dayPeriod')?.value ?? '')
        .toLowerCase()
        .replace(/[^a-z]/g, '')

      const zoneAbbrev = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short',
      })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName')?.value

      if (hour === '' || minute === '' || zoneAbbrev === undefined) return undefined
      return { localTime: `${hour}:${minute}${dayPeriod}`, zoneAbbrev }
    } catch {
      return undefined
    }
  }
  ```

- [ ] 4. Run:
  ```bash
  pnpm vitest run packages/cli/src/strip.test.ts
  ```
  Expected: 8 tests pass. If the zone abbreviation assertion fails, correct the test to the value the `node -e` check in step 1 printed.

- [ ] 5. Wire it into `packages/cli/src/chat.ts`. Add `interactive` to the deps:
  ```ts
  export async function runChat(deps: {
    engine: MemoryEngine
    config: ReverieConfig
    chat: ChatProvider
    io: ChatIo
    colorEnabled?: boolean
    interactive?: boolean
    setInterval?: (fn: () => void, ms: number) => unknown
    clearInterval?: (handle: unknown) => void
    now?: () => number
  }): Promise<void> {
    const {
      engine,
      config,
      chat,
      io,
      colorEnabled = false,
      interactive = false,
      // ...the rest unchanged...
    } = deps
  ```
  `interactive` defaults to `false`, so piped and redirected output gets no strip and every existing captured-output test stays honest.

- [ ] 6. Sample the session start once, next to the existing `now` usage:
  ```ts
  const sessionStartedAt = now()
  ```
  and add the strip printer above the input loop:
  ```ts
  // Printed once, on its own dim line, immediately before each prompt. Not
  // animated and never repainted, which is what gives a fresh value at
  // every turn and right after a mode change without any cursor addressing
  // and without fighting readline.
  //
  // Shown when the terminal is interactive; dimmed only when colour is on.
  // Those are two different conditions: someone who sets NO_COLOR wants no
  // colour, not less information.
  function writeStatusStrip(): void {
    if (!interactive) return
    const meta = engine.currentProfile().meta
    const time = formatStripTime(meta.timezone, new Date(now()))
    const place = meta.timezoneSource === 'user-confirmed' ? meta.location : undefined
    const line = renderStatusStrip({
      mode: session.mode,
      tone: engine.currentStyle().tone,
      ...(place === undefined ? {} : { location: place }),
      ...(time === undefined ? {} : { localTime: time.localTime, zoneAbbrev: time.zoneAbbrev }),
      elapsedMs: now() - sessionStartedAt,
    })
    io.write(`${dim(line, colorEnabled)}\n`)
  }
  ```
  and call it as the first statement inside the `for (;;)` loop, before `io.question(...)`. Add the import:
  ```ts
  import { formatStripTime, renderStatusStrip } from './strip.js'
  ```

- [ ] 7. Pass `interactive` from the entry point. In `packages/cli/src/index.ts`, add a second edge-read next to `colorsEnabled`:
  ```ts
  // Two different conditions, deliberately not collapsed into one. Colour is
  // off when stdout is not a TTY or NO_COLOR is set; the terminal is
  // interactive whenever stdout is a TTY, regardless of NO_COLOR.
  function isInteractive(): boolean {
    return process.stdout.isTTY === true
  }
  ```
  Add `interactive: () => boolean` to `CliMainDeps`, set it to `isInteractive` in `defaultDeps`, and pass it in the `runChat` call:
  ```ts
  await deps.runChat({ engine, config, chat, io, colorEnabled, interactive: deps.interactive() })
  ```

- [ ] 8. Add strip tests to `packages/cli/src/chat.test.ts`:
  ```ts
  describe('status strip', () => {
    it('prints nothing when the terminal is not interactive', async () => {
      const io = makeScriptedIo(['/bye'])
      await runChat(makeChatDeps({ io, interactive: false }))
      expect(io.output.join('')).not.toContain(' · ')
    })

    it('prints the strip with no escape sequences when colour is off but the terminal is interactive', async () => {
      const io = makeScriptedIo(['/bye'])
      await runChat(makeChatDeps({ io, interactive: true, colorEnabled: false }))
      const text = io.output.join('')
      expect(text).toContain('general · warm')
      expect(text).not.toContain(String.fromCharCode(27))
    })

    it('shows the new mode on the next strip after a mode change', async () => {
      const io = makeScriptedIo(['/mode listen', '/bye'])
      await runChat(makeChatDeps({ io, interactive: true }))
      const strips = io.output
        .join('')
        .split('\n')
        .filter((line) => line.includes(' · '))
      expect(strips[0]).toContain('general · ')
      expect(strips[1]).toContain('listen · ')
    })

    // The spinner and the strip never write in the same frame.
    it('writes no strip while a reply is streaming', async () => {
      const io = makeScriptedIo(['hello', '/bye'])
      await runChat(makeChatDeps({ io, interactive: true }))
      const flat = io.output.join('')
      const stripIndex = flat.lastIndexOf(' · ')
      const replyIndex = flat.indexOf('reverie> ')
      expect(stripIndex).toBeGreaterThan(replyIndex)
    })
  })
  ```

- [ ] 9. Falsify the gating: change `if (!interactive) return` to `if (!colorEnabled) return`, run:
  ```bash
  pnpm vitest run packages/cli/src/chat.test.ts -t 'status strip'
  ```
  and confirm `prints the strip with no escape sequences when colour is off` fails. Restore.

- [ ] 10. Falsify the freshness: hoist `session.mode` into a `const modeAtStart` outside `writeStatusStrip` and use that, run the same command, and confirm `shows the new mode on the next strip` fails. Restore.

- [ ] 11. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add a persistent status strip to the CLI

Mode, tone, local place and time, session elapsed, printed once on its own
line before each prompt. It is a separate component from the transient
spinner and never writes in the same frame as it. Shown whenever the
terminal is interactive, dimmed only when colour is on, because NO_COLOR
means no colour rather than less information. A guessed timezone still
renders the time but never a place name the user did not give, and a zone
Intl rejects drops the segment rather than substituting the host's."
  ```

---

## Task 17: The `mode` stream event, end to end

The server's `StreamEvent` union and the web's `streamEventSchema` are both discriminated unions that reject an unknown `type` today, so they must change together, in one task, or the browser rejects the event the server just started sending. That is safe here because the server serves the web build from the same install, but it is worth stating rather than discovering.

**Files**
- Modify: `packages/server/src/registry.ts`
- Modify: `packages/server/src/registry.test.ts`
- Modify: `packages/web/src/api.ts`
- Modify: `packages/web/src/api.test.ts`
- Modify: `packages/web/src/session.ts`
- Modify: `packages/web/src/session.test.ts`

**Interfaces**

Consumes: `AgentEvent` with `{ type: 'mode'; mode: ModeName }` (Task 12).

Produces:

```ts
// packages/server/src/registry.ts
export type StreamEvent =
  | { schemaVersion: '1'; seq: number; type: 'thinking' }
  | { schemaVersion: '1'; seq: number; type: 'text'; text: string }
  | { schemaVersion: '1'; seq: number; type: 'tool'; name: string }
  | { schemaVersion: '1'; seq: number; type: 'mode'; mode: string }
  | { schemaVersion: '1'; seq: number; type: 'done' }
  | { schemaVersion: '1'; seq: number; type: 'error'; code: 'chat_unavailable' | 'chat_failed'; retryable: boolean; message: string }

// packages/web/src/session.ts
export interface ChatState {
  session: Session | null
  messages: ChatMessage[]
  lastSequence: number
  sending: boolean
  thinking: boolean
  activeTool: string | null
  mode: string
  error: string | null
}
```

`ChatState.mode` defaults to `'general'` in `initialChatState`.

**Steps**

- [ ] 1. Add the failing reducer test to `packages/web/src/session.test.ts`:
  ```ts
  describe('mode events', () => {
    it('starts in general', () => {
      expect(initialChatState.mode).toBe('general')
    })

    it('updates the mode from a stream event', () => {
      const next = sessionReducer(initialChatState, {
        type: 'stream',
        event: { schemaVersion: '1', seq: 1, type: 'mode', mode: 'listen' },
      })
      expect(next.mode).toBe('listen')
      expect(next.lastSequence).toBe(1)
    })

    it('ignores a mode event that is behind the sequence cursor', () => {
      const state = { ...initialChatState, lastSequence: 5, mode: 'listen' }
      const next = sessionReducer(state, {
        type: 'stream',
        event: { schemaVersion: '1', seq: 3, type: 'mode', mode: 'solve' },
      })
      expect(next.mode).toBe('listen')
    })

    it('resets to general on a new session', () => {
      const state = { ...initialChatState, mode: 'journal' }
      const next = sessionReducer(state, { type: 'new-session', session: sessionFixture })
      expect(next.mode).toBe('general')
    })
  })
  ```
  Reuse the file's existing session fixture; find it with `grep -n "const session\|Session = {" packages/web/src/session.test.ts | head -5`.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/web/src/session.test.ts -t 'mode events'
  ```
  Expected: `expected undefined to be 'general'` on the first test, and a type error on the `mode` event literal.

- [ ] 3. Add the event to the server union in `packages/server/src/registry.ts`. Extend `StreamEvent`:
  ```ts
  | { schemaVersion: '1'; seq: number; type: 'mode'; mode: string }
  ```
  and `StreamEventInput`:
  ```ts
  | { type: 'mode'; mode: string }
  ```
  and add the case to `streamEventFromAgent`:
  ```ts
  case 'mode':
    return { type: 'mode', mode: event.mode }
  ```
  The union carries `mode: string` rather than `ModeName` deliberately: the wire format is a string, and the browser validates it against its own schema.

- [ ] 4. Add the event to the web schema in `packages/web/src/api.ts`, inside `streamEventSchema`:
  ```ts
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('mode'),
    mode: z.string(),
  }),
  ```

- [ ] 5. Handle it in the reducer. In `packages/web/src/session.ts`, add `mode: string` to `ChatState`, add `mode: 'general'` to `initialChatState`, and add the case inside the `'stream'` switch:
  ```ts
  case 'mode':
    return { ...state, lastSequence, mode: event.mode }
  ```
  `'new-session'` already spreads `initialChatState`, so it resets to `'general'` with no further change. `'load-session'` does the same.

- [ ] 6. Run:
  ```bash
  pnpm vitest run packages/web/src/session.test.ts packages/web/src/api.test.ts
  ```
  Expected: all pass.

- [ ] 7. Add the server-side test to `packages/server/src/registry.test.ts`:
  ```ts
  it('records a mode event when the model switches mode mid-turn', async () => {
    const registry = await makeRegistry([
      [{ type: 'tool_call', toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"listen"}' } }],
      [{ type: 'text', text: 'ok' }],
    ])
    const created = await registry.create()
    const events = []
    for await (const event of registry.message(created.sessionId, 'turn-1', { message: 'listen to me' })) {
      events.push(event)
    }
    expect(events.some((event) => event.type === 'mode' && event.mode === 'listen')).toBe(true)
    await registry.close()
  })
  ```
  Reuse the file's existing registry fixture builder.

- [ ] 8. Falsify the pairing: delete the `mode` member from the web `streamEventSchema` and run:
  ```bash
  pnpm vitest run packages/web/src/session.test.ts -t 'mode events'
  ```
  Confirm the parse-level test fails. This is the check that keeps the two unions changing together. Restore it.

- [ ] 9. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Carry mode changes over the event stream

The server's StreamEvent union and the web's streamEventSchema both gain a
mode event, in one change, because both are discriminated unions that
reject an unknown type. The web reducer tracks the current mode so the
picker and the model never disagree."
  ```

---

## Task 18: Session mode over HTTP

`POST /api/v1/sessions` accepts an optional mode to start a session in one. `POST /api/v1/sessions/:id/mode` sets it on a live session. `PublicSession` gains an optional `mode`, present for live sessions only, so a browser reload recovers the current one.

**Files**
- Modify: `packages/memory/src/engine.ts` (the `PublicSession` interface)
- Modify: `packages/server/src/registry.ts`
- Modify: `packages/server/src/registry.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/web/src/api.ts`
- Modify: `packages/web/src/api.test.ts`

**Interfaces**

Produces:

```ts
// packages/memory/src/engine.ts
export interface PublicSession {
  sessionId: string
  createdAt: string
  updatedAt: string
  status: 'live' | 'ended' | 'expired'
  readOnly: boolean
  mode?: string                 // live sessions only
  transcript: { lineCount: number; userCount: number; assistantCount: number; toolCount: number }
}

// packages/server/src/registry.ts, on class LiveSessionRegistry
create(options?: { mode?: string }): Promise<CreateSessionResponse>
setMode(sessionId: string, mode: string): Promise<{ mode: string }>

// packages/web/src/api.ts, on interface AppApi
createSession(mode?: string): Promise<CreateSessionResponse>
setSessionMode(sessionId: string, mode: string): Promise<{ mode: string }>
```

Both `publicSessionSchema` in `packages/server/src/app.ts` and `sessionSchema` in `packages/web/src/api.ts` are strict objects, so both gain the optional key in this same task.

**Steps**

- [ ] 1. Add failing server tests to `packages/server/src/app.test.ts`:
  ```ts
  describe('session mode endpoints', () => {
    it('starts a session in a requested mode', async () => {
      const { request } = await makeServer()
      const response = await request('POST', '/api/v1/sessions', { body: { mode: 'journal' } })
      expect(response.status).toBe(201)
      expect(response.body.data.mode).toBe('journal')
    })

    it('starts in general when no mode is given', async () => {
      const { request } = await makeServer()
      const response = await request('POST', '/api/v1/sessions')
      expect(response.body.data.mode).toBe('general')
    })

    it('sets the mode on a live session', async () => {
      const { request } = await makeServer()
      const created = await request('POST', '/api/v1/sessions')
      const sessionId = created.body.data.sessionId
      const response = await request('POST', `/api/v1/sessions/${sessionId}/mode`, {
        body: { mode: 'listen' },
      })
      expect(response.status).toBe(200)
      expect(response.body.data).toEqual({ mode: 'listen' })
    })

    it('rejects an unknown mode with 400', async () => {
      const { request } = await makeServer()
      const created = await request('POST', '/api/v1/sessions')
      const sessionId = created.body.data.sessionId
      const response = await request('POST', `/api/v1/sessions/${sessionId}/mode`, {
        body: { mode: 'moody' },
      })
      expect(response.status).toBe(400)
    })

    it('returns 404 for a session that is not live', async () => {
      const { request } = await makeServer()
      const response = await request('POST', '/api/v1/sessions/session_nope/mode', {
        body: { mode: 'listen' },
      })
      expect([404, 409]).toContain(response.status)
    })

    it('marks a mode set from the browser as synthetic in the transcript', async () => {
      const { request } = await makeServer()
      const created = await request('POST', '/api/v1/sessions')
      const sessionId = created.body.data.sessionId
      await request('POST', `/api/v1/sessions/${sessionId}/mode`, { body: { mode: 'listen' } })
      const transcript = await request('GET', `/api/v1/sessions/${sessionId}/transcript`)
      const modeLine = transcript.body.data.find(
        (line: { content: string }) => line.content === '/mode listen',
      )
      expect(modeLine.synthetic).toBe(true)
    })
  })
  ```
  Reuse the file's existing server fixture and request helper; find them with `grep -n "async function makeServer\|function request" packages/server/src/app.test.ts | head -5`.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/server/src/app.test.ts -t 'session mode endpoints'
  ```
  Expected: `expected undefined to be 'journal'`, and 404 on the mode route.

- [ ] 3. Widen `PublicSession` in `packages/memory/src/engine.ts`:
  ```ts
  export interface PublicSession {
    sessionId: string
    createdAt: string
    updatedAt: string
    status: 'live' | 'ended' | 'expired'
    readOnly: boolean
    // Present for live sessions only, so a browser reload recovers the mode
    // the conversation is actually in. A stored session's mode lives in its
    // session.json and is not part of this read-only view.
    mode?: string
    transcript: {
      lineCount: number
      userCount: number
      assistantCount: number
      toolCount: number
    }
  }
  ```

- [ ] 4. Change `packages/server/src/registry.ts`:
  ```ts
  async create(options: { mode?: string } = {}): Promise<CreateSessionResponse> {
    if (this.live.size >= this.maxLiveSessions) {
      throw new ApiError(429, 'session_capacity', 'Too many live sessions are open.')
    }
    const requested = options.mode
    if (requested !== undefined && !isModeName(requested)) {
      throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    }
    const agent = await AgentSession.start(this.engine, this.config, this.chat, {
      ...(requested === undefined ? {} : { mode: requested }),
    })
    // ...the rest of create() unchanged, except the public object:
    //   public: { ..., mode: agent.mode, ... }
  }

  async setMode(sessionId: string, mode: string): Promise<{ mode: string }> {
    if (!isModeName(mode)) {
      throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    }
    const live = await this.requireLive(sessionId)
    // source 'web': a click, with no keystroke behind it, so the /mode line
    // this writes is marked synthetic.
    await live.agent.setMode(mode, { source: 'web' })
    live.public = { ...live.public, mode }
    live.lastActivity = this.now()
    return { mode }
  }
  ```
  Add the import:
  ```ts
  import { type AgentEvent, AgentSession, isModeName, type ReverieConfig } from '@openreverie/core'
  ```
  In `syncPublic`, preserve the existing `mode` by spreading `live.public` first, which it already does.

- [ ] 5. Add the routes to `packages/server/src/app.ts`. Extend the create-session route:
  ```ts
  if (registry && method === 'POST' && path.length === 3 && path[2] === 'sessions') {
    const raw = await readJsonOrEmpty(req)
    const body = createSessionSchema.safeParse(raw)
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const session = await registry.create(
      body.data.mode === undefined ? {} : { mode: body.data.mode },
    )
    writePublicJson(res, 201, createSessionResponseSchema, session, null)
    return
  }
  ```
  and add the mode route immediately after the `end` route:
  ```ts
  if (
    registry &&
    method === 'POST' &&
    path.length === 5 &&
    path[2] === 'sessions' &&
    path[4] === 'mode'
  ) {
    const sessionId = requiredId(path[3])
    const body = sessionModeSchema.safeParse(await readJson(req))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const result = await registry.setMode(sessionId, body.data.mode)
    writePublicJson(res, 200, sessionModeResponseSchema, result, null)
    return
  }
  ```
  with the schemas next to `messageSchema`:
  ```ts
  const createSessionSchema = z.strictObject({ mode: z.string().optional() })
  const sessionModeSchema = z.strictObject({ mode: z.string() })
  const sessionModeResponseSchema = z.strictObject({ mode: z.string() })
  ```
  and the optional `mode` on `publicSessionSchema`:
  ```ts
  mode: z.string().optional(),
  ```
  `POST /api/v1/sessions` currently reads no body at all, so add this helper next to `readJson`:
  ```ts
  // POST /api/v1/sessions has always been callable with no body, and still
  // is. An empty body means an empty object, not a parse error.
  async function readJsonOrEmpty(req: IncomingMessage): Promise<unknown> {
    try {
      return await readJson(req)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_json') return {}
      throw error
    }
  }
  ```
  Confirm the error code string with `grep -n "invalid_json" packages/server/src/app.ts` and use whatever is actually there.

- [ ] 6. Mirror the schema in the browser. In `packages/web/src/api.ts`, add to `sessionSchema`:
  ```ts
  mode: z.string().optional(),
  ```
  and add the two client methods to `AppApi` and `ApiClient`:
  ```ts
  createSession(mode?: string): Promise<CreateSessionResponse> {
    return this.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === undefined ? {} : { mode }),
      },
      createSessionResponseSchema,
    )
  }

  setSessionMode(sessionId: string, mode: string): Promise<{ mode: string }> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/mode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      },
      z.strictObject({ mode: z.string() }),
    )
  }
  ```
  Update the `AppApi` interface entries to match, and update every test fake of `AppApi` in `packages/web/src/*.test.tsx` and `packages/web/src/views/*.test.tsx` so they implement `setSessionMode`. Find them with:
  ```bash
  grep -rln "AppApi" packages/web/src
  ```

- [ ] 7. Run:
  ```bash
  pnpm vitest run packages/server/src/app.test.ts packages/server/src/registry.test.ts packages/web/src/api.test.ts
  ```
  Expected: all pass.

- [ ] 8. Falsify the strict-schema pairing: remove `mode: z.string().optional()` from the web `sessionSchema` while leaving it on the server, run the web tests, and confirm a session parse fails with an `unrecognized_keys` issue. Restore it.

- [ ] 9. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Expose session mode over HTTP

POST /api/v1/sessions takes an optional mode, and POST
/api/v1/sessions/:id/mode sets it on a live session. A mode set this way
goes through AgentSession.setMode with source 'web', so the /mode line it
writes is marked synthetic: a click is not a keystroke. PublicSession
gains an optional mode for live sessions, and both strict session schemas
change together."
  ```

---

## Task 19: Profile and settings endpoints, and the API key that must never be reachable

`config.toml` holds the provider API key and is written 0600 for exactly that reason. No endpoint may return the provider block, in whole or in part, under any circumstance.

**Files**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/web/src/api.ts`

**Interfaces**

Consumes: `profileSettingsPatchSchema` (Task 3), `MemoryEngine.currentProfile`, `currentStyle`, `updateProfileSettings` (Task 4).

Produces:

```ts
// packages/server/src/app.ts, on interface RecordEngine
currentProfile(): Profile
currentStyle(): StyleConfig
updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile>

// packages/web/src/api.ts
export const profileSchema: z.ZodType<PublicProfile>
export type PublicProfile = {
  preferredName: string | null
  pronouns: string | null
  location: string | null
  timezone: string | null
  birthday: string | null
  birthdayGreetings: boolean | null
  occupation: string | null
  style: { engagement: string; tone: string; orientation: string }
  prose: string
}

// on interface AppApi
getProfile(): Promise<PublicProfile>
updateProfile(patch: Record<string, unknown>): Promise<PublicProfile>
getSettings(): Promise<{ safetyMode: 'companion' | 'firewall' }>
```

The response is built from the whitelist, key by key, never by serializing the loaded object. The file's schema passes unknown keys through, so a hand-added key can exist in `profile.md`; the endpoint does not echo it. `timezoneSource` is not exposed: it is an implementation detail of how confident the zone is, not a setting.

**Steps**

- [ ] 1. Add failing tests to `packages/server/src/app.test.ts`:
  ```ts
  describe('profile endpoints', () => {
    it('returns exactly the whitelisted shape, with nulls for unset fields', async () => {
      const { request } = await makeServer()
      const response = await request('GET', '/api/v1/profile')
      expect(response.status).toBe(200)
      expect(Object.keys(response.body.data).sort()).toEqual(
        [
          'birthday',
          'birthdayGreetings',
          'location',
          'occupation',
          'preferredName',
          'pronouns',
          'prose',
          'style',
          'timezone',
        ].sort(),
      )
      expect(response.body.data.preferredName).toBeNull()
      expect(response.body.data.style).toEqual({
        engagement: 'balanced',
        tone: 'warm',
        orientation: 'listening',
      })
    })

    it('does not echo a hand-added key from profile.md', async () => {
      const { request, engine } = await makeServer()
      const profile = engine.currentProfile()
      await engine.updateProfileSettings({ preferredName: 'Vish' })
      // Write an unknown key directly, the way a hand edit would.
      await saveProfile(enginePaths, {
        ...engine.currentProfile(),
        meta: { ...engine.currentProfile().meta, favouriteTea: 'assam' },
      })
      const response = await request('GET', '/api/v1/profile')
      expect('favouriteTea' in response.body.data).toBe(false)
      expect(profile.meta.id).toBeDefined()
    })

    it('never exposes timezoneSource', async () => {
      const { request } = await makeServer()
      const response = await request('GET', '/api/v1/profile')
      expect('timezoneSource' in response.body.data).toBe(false)
    })

    it('writes a patch and returns the same shape', async () => {
      const { request } = await makeServer()
      const response = await request('PATCH', '/api/v1/profile', {
        body: { preferredName: 'Vish', style: { tone: 'direct' } },
      })
      expect(response.status).toBe(200)
      expect(response.body.data.preferredName).toBe('Vish')
      expect(response.body.data.style.tone).toBe('direct')
    })

    it('marks a timezone typed into settings as confirmed', async () => {
      const { request, engine } = await makeServer()
      await request('PATCH', '/api/v1/profile', { body: { timezone: 'Asia/Kolkata' } })
      expect(engine.currentProfile().meta.timezoneSource).toBe('user-confirmed')
    })

    it('rejects an unknown key with 400 and writes nothing', async () => {
      const { request, profilePath } = await makeServer()
      const before = await readFile(profilePath, 'utf8')
      const response = await request('PATCH', '/api/v1/profile', { body: { nickname: 'V' } })
      expect(response.status).toBe(400)
      expect(await readFile(profilePath, 'utf8')).toEqual(before)
    })

    it('rejects infrastructure keys with 400', async () => {
      const { request } = await makeServer()
      for (const body of [
        { provider: { apiKey: 'sk-leak' } },
        { safety: { mode: 'firewall' } },
        { models: { chat: 'gpt-5' } },
        { memoryDir: '/tmp/elsewhere' },
      ]) {
        const response = await request('PATCH', '/api/v1/profile', { body })
        expect(response.status).toBe(400)
      }
    })
  })

  describe('settings endpoint', () => {
    it('returns exactly one field', async () => {
      const { request } = await makeServer()
      const response = await request('GET', '/api/v1/settings')
      expect(response.status).toBe(200)
      expect(response.body.data).toEqual({ safetyMode: 'companion' })
    })

    it('has no write route: PATCH and POST are 404', async () => {
      const { request } = await makeServer()
      expect((await request('PATCH', '/api/v1/settings', { body: {} })).status).toBe(404)
      expect((await request('POST', '/api/v1/settings', { body: {} })).status).toBe(404)
    })
  })

  // By value, not by field name. A field-name assertion would not catch a
  // nested key or an accidental spread of the config object.
  describe('the API key is never reachable', () => {
    const SENTINEL = 'sk-sentinel-must-never-appear-anywhere'

    it('appears in no response body from any endpoint', async () => {
      const { request, sessionId } = await makeServer({ apiKey: SENTINEL })
      const calls: [string, string][] = [
        ['GET', '/api/v1/profile'],
        ['GET', '/api/v1/settings'],
        ['GET', '/api/v1/documents'],
        ['GET', '/api/v1/sessions'],
        ['GET', '/api/v1/proposals'],
        ['GET', '/api/v1/graph/snapshot'],
        ['GET', `/api/v1/sessions/${sessionId}/transcript`],
      ]
      for (const [method, path] of calls) {
        const response = await request(method, path)
        expect(JSON.stringify(response.body), `${method} ${path}`).not.toContain(SENTINEL)
      }

      const patched = await request('PATCH', '/api/v1/profile', { body: { preferredName: 'V' } })
      expect(JSON.stringify(patched.body)).not.toContain(SENTINEL)

      const created = await request('POST', '/api/v1/sessions')
      expect(JSON.stringify(created.body)).not.toContain(SENTINEL)

      const moded = await request('POST', `/api/v1/sessions/${created.body.data.sessionId}/mode`, {
        body: { mode: 'listen' },
      })
      expect(JSON.stringify(moded.body)).not.toContain(SENTINEL)
    })
  })
  ```
  Extend the file's `makeServer` helper so it accepts `{ apiKey }`, sets `config.provider.apiKey` to it, and returns `engine`, `profilePath`, `enginePaths`, and a `sessionId` for a stored session.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/server/src/app.test.ts -t 'profile endpoints'
  ```
  Expected: `expected 404 to be 200`.

- [ ] 3. Widen `RecordEngine` in `packages/server/src/app.ts`:
  ```ts
  export interface RecordEngine {
    // ...existing members unchanged...
    currentProfile(): Profile
    currentStyle(): StyleConfig
    updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile>
  }
  ```
  and extend the type import:
  ```ts
  import {
    type Profile,
    type ProfileSettingsPatch,
    profileSettingsPatchSchema,
    type StyleConfig,
    // ...existing imports...
  } from '@openreverie/memory'
  ```
  `profileSettingsPatchSchema` is a value, not a type, so it must not be inside a `import type` clause.

- [ ] 4. Add the response schema and the projector, next to the other schemas in `app.ts`:
  ```ts
  const publicProfileSchema = z.strictObject({
    preferredName: z.string().nullable(),
    pronouns: z.string().nullable(),
    location: z.string().nullable(),
    timezone: z.string().nullable(),
    birthday: z.string().nullable(),
    birthdayGreetings: z.boolean().nullable(),
    occupation: z.string().nullable(),
    style: z.strictObject({
      engagement: z.string(),
      tone: z.string(),
      orientation: z.string(),
    }),
    prose: z.string(),
  })

  const publicSettingsSchema = z.strictObject({
    safetyMode: z.enum(['companion', 'firewall']),
  })

  // Built from the whitelist, key by key, never by serializing the loaded
  // object. profile.md's own schema passes unknown keys through, so a
  // hand-added or forward-written key can exist in the file; this endpoint
  // does not echo it. timezoneSource is deliberately absent: it says how
  // confident the zone is, which is an implementation detail rather than a
  // setting.
  function publicProfile(profile: Profile, style: StyleConfig): z.infer<typeof publicProfileSchema> {
    const meta = profile.meta
    return {
      preferredName: meta.preferredName ?? null,
      pronouns: meta.pronouns ?? null,
      location: meta.location ?? null,
      timezone: meta.timezone ?? null,
      birthday: meta.birthday ?? null,
      birthdayGreetings: meta.birthdayGreetings ?? null,
      occupation: meta.occupation ?? null,
      style: {
        engagement: style.engagement,
        tone: style.tone,
        orientation: style.orientation,
      },
      prose: profile.body,
    }
  }
  ```

- [ ] 5. Add the three routes, above the final `throw new ApiError(404, ...)` in `handle`:
  ```ts
  if (method === 'GET' && path.length === 3 && path[2] === 'profile') {
    writePublicJson(
      res,
      200,
      publicProfileSchema,
      publicProfile(engine.currentProfile(), engine.currentStyle()),
      null,
    )
    return
  }

  if (method === 'PATCH' && path.length === 3 && path[2] === 'profile') {
    const body = profileSettingsPatchSchema.safeParse(await readJson(req))
    // An unrecognized key in a file the user may hand-edit is probably
    // intentional; an unrecognized key arriving over HTTP is probably a
    // mistake or an attempt. So the file schema passes them through and this
    // one rejects the whole body rather than applying it in part.
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const profile = await engine.updateProfileSettings(body.data)
    writePublicJson(res, 200, publicProfileSchema, publicProfile(profile, engine.currentStyle()), null)
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'settings') {
    // Exactly one field. No memory folder path, no config file path, no
    // model names, and above all nothing from the provider block. There is
    // no PATCH: safety mode is not settable over HTTP, for the same reason
    // it stays in config.toml.
    const safetyMode = config?.safety.mode
    if (safetyMode === undefined) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    }
    writePublicJson(res, 200, publicSettingsSchema, { safetyMode }, null)
    return
  }
  ```
  `config` is already a member of `CreateAppDeps`. Thread it into `handle` the same way `registry` and `staticDir` already are: add a `config: ReverieConfig | undefined` parameter and pass `deps.config` at the call site in `createApp`.

- [ ] 6. `PATCH` is a write, so confirm it lands on the write side of the auth split. The existing code at `app.ts:123-127` routes `GET` and `HEAD` to `requireAuthenticatedRead` and everything else to `requireAuthenticatedWrite`, so `PATCH` is already covered with no change. Add a test that says so:
  ```ts
  it('requires write auth for PATCH /api/v1/profile', async () => {
    const { requestWithoutOrigin } = await makeServer()
    const response = await requestWithoutOrigin('PATCH', '/api/v1/profile', {
      body: { preferredName: 'V' },
    })
    expect(response.status).toBe(403)
  })
  ```
  using whichever helper the file already has for an unauthenticated or wrong-origin request.

- [ ] 7. Add the client methods to `packages/web/src/api.ts`:
  ```ts
  export const profileSchema = z.strictObject({
    preferredName: z.string().nullable(),
    pronouns: z.string().nullable(),
    location: z.string().nullable(),
    timezone: z.string().nullable(),
    birthday: z.string().nullable(),
    birthdayGreetings: z.boolean().nullable(),
    occupation: z.string().nullable(),
    style: z.strictObject({
      engagement: z.string(),
      tone: z.string(),
      orientation: z.string(),
    }),
    prose: z.string(),
  })

  export const settingsSchema = z.strictObject({
    safetyMode: z.enum(['companion', 'firewall']),
  })

  export type PublicProfile = z.infer<typeof profileSchema>
  export type PublicSettings = z.infer<typeof settingsSchema>
  ```
  and on `ApiClient`:
  ```ts
  getProfile(): Promise<PublicProfile> {
    return this.request('/api/v1/profile', {}, profileSchema)
  }

  updateProfile(patch: Record<string, unknown>): Promise<PublicProfile> {
    return this.request(
      '/api/v1/profile',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      profileSchema,
    )
  }

  getSettings(): Promise<PublicSettings> {
    return this.request('/api/v1/settings', {}, settingsSchema)
  }
  ```
  Add all three to the `AppApi` interface and to every test fake of it.

- [ ] 8. Run:
  ```bash
  pnpm vitest run packages/server/src/app.test.ts
  ```
  Expected: all pass.

- [ ] 9. Falsify the non-exposure test, which is the one that matters most here. Temporarily change the settings route to `writePublicJson(res, 200, z.looseObject({}), { ...config }, null)` and run:
  ```bash
  pnpm vitest run packages/server/src/app.test.ts -t 'the API key is never reachable'
  ```
  Confirm it fails on `GET /api/v1/settings`. Note that a field-name assertion would not have caught this, because the leak arrived through a spread. Restore the whitelist projection.

- [ ] 10. Falsify the strict patch schema: swap `profileSettingsPatchSchema` for `z.looseObject({})` in the PATCH route, run:
  ```bash
  pnpm vitest run packages/server/src/app.test.ts -t 'rejects infrastructure keys'
  ```
  and confirm it fails. Restore.

- [ ] 11. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add profile and settings endpoints

GET and PATCH /api/v1/profile over an exact whitelist, built key by key
rather than by serializing the loaded object, so a hand-added key in
profile.md is never echoed and timezoneSource is never exposed. The PATCH
body is its own strict schema, distinct from both model-write schemas,
because the settings pane legitimately writes style and prose. GET
/api/v1/settings returns exactly one field and there is no write route for
it. A test configures a sentinel API key and asserts by value that it
appears in no response body from any endpoint."
  ```

---

## Task 20: Two new web destinations, journal and settings

The nav rail gains two destinations, and they are not the same kind of thing. Journal is a peer of Talk, Atlas and Record: a section holding a kind of content, mounted and unmounted the way those already are. Settings is a pane launched from the rail: there is nothing to browse chronologically in it, and it is the one destination that is not itself a record of anything the person did.

**This plan owns only that the journal destination exists and where it sits.** Everything it contains, what it lists, how an entry opens, how it renders, belongs to the journal plan, which replaces `packages/web/src/views/Journal.tsx` wholesale. Until then it is an honest placeholder that says journal mode is not finished, rather than an empty page implying otherwise.

**Files**
- Create: `packages/web/src/views/Journal.tsx`
- Create: `packages/web/src/views/Settings.tsx`
- Create: `packages/web/src/views/settings.css`
- Create: `packages/web/src/views/settings.test.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`

**Interfaces**

Consumes: `AppApi.getProfile`, `AppApi.updateProfile`, `AppApi.getSettings`, `PublicProfile` (Task 19).

Produces:

```ts
// packages/web/src/App.tsx
export type ViewId = 'conversations' | 'atlas' | 'library' | 'journal' | 'settings'
export function viewFromHash(hash: string): ViewId

// packages/web/src/views/Settings.tsx
export function Settings({ api }: { api: AppApi }): JSX.Element

// packages/web/src/views/Journal.tsx
export function Journal(): JSX.Element
```

**Steps**

- [ ] 1. Add failing shell tests to `packages/web/src/App.test.tsx`. Add two more mock blocks alongside the existing three:
  ```ts
  let journalMounts = 0
  let settingsMounts = 0

  vi.mock('./views/Journal.js', () => ({
    Journal: () => {
      useEffect(() => {
        journalMounts += 1
      }, [])
      return <div>journal view</div>
    },
  }))

  vi.mock('./views/Settings.js', () => ({
    Settings: () => {
      useEffect(() => {
        settingsMounts += 1
      }, [])
      return <div>settings view</div>
    },
  }))
  ```
  reset both in `beforeEach`, and add:
  ```ts
  describe('journal and settings destinations', () => {
    it('renders five destinations in the rail', () => {
      render(<App api={api} />)
      for (const label of ['Talk', 'Atlas', 'Record', 'Journal', 'Settings']) {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
      }
    })

    it('reads both new destinations out of the hash', () => {
      expect(viewFromHash('#/journal')).toBe('journal')
      expect(viewFromHash('#/settings')).toBe('settings')
    })

    it('keeps the conversation alive when switching to journal', async () => {
      render(<App api={api} />)
      await user.click(screen.getByRole('button', { name: 'Journal' }))
      expect(screen.getByText('journal view')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Talk' }))
      expect(conversationsMounts).toBe(1)
    })

    it('keeps the conversation alive when switching to settings', async () => {
      render(<App api={api} />)
      await user.click(screen.getByRole('button', { name: 'Settings' }))
      expect(screen.getByText('settings view')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Talk' }))
      expect(conversationsMounts).toBe(1)
    })

    it('mounts each new destination only while it is on screen', async () => {
      render(<App api={api} />)
      await user.click(screen.getByRole('button', { name: 'Journal' }))
      await user.click(screen.getByRole('button', { name: 'Talk' }))
      expect(journalMounts).toBe(1)
      expect(settingsMounts).toBe(0)
    })
  })
  ```

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/web/src/App.test.tsx
  ```
  Expected: `Unable to find an accessible element with the role "button" and name "Journal"`.

- [ ] 3. Create the journal placeholder at `packages/web/src/views/Journal.tsx`:
  ```tsx
  /*
   * The journal destination. This plan owns only that it exists in the nav and
   * where it sits; everything it contains belongs to the journal spec, which
   * replaces this file. Until then it says plainly that the feature is not
   * finished rather than showing an empty list that implies there is nothing
   * written yet.
   */
  export function Journal(): JSX.Element {
    return (
      <div className="journal">
        <h2>Journal</h2>
        <p>Journal mode is not finished yet. Nothing is written here.</p>
        <p>
          When it ships, the entries you write in journal mode will be listed here, newest first.
        </p>
      </div>
    )
  }
  ```

- [ ] 4. Create the settings pane at `packages/web/src/views/Settings.tsx`:
  ```tsx
  import { useCallback, useEffect, useState } from 'react'
  import type { AppApi, PublicProfile } from '../api.js'
  import './settings.css'

  const ENGAGEMENT_OPTIONS = [
    ['leading', 'Leading. reverie brings things up on its own and follows threads from earlier without being asked.'],
    ['balanced', 'Balanced. reverie mostly follows your lead, but will bring something back up if it seems worth it.'],
    ['following', 'Following. reverie waits for you to bring things up and rarely initiates on its own.'],
  ] as const

  const TONE_OPTIONS = [
    ['warm', 'Warm. Caring and gentle, the register of a close friend.'],
    ['playful', 'Playful. Light and a little teasing when the moment allows it.'],
    ['snarky', 'Snarky. Dry and a bit sharp-tongued, still on your side.'],
    ['direct', 'Direct. Plain and to the point, little cushioning.'],
    ['formal', 'Formal. More measured and reserved, less familiar.'],
  ] as const

  const ORIENTATION_OPTIONS = [
    ['listening', 'Listening. Mostly reflects and asks questions, does not rush to solve.'],
    ['balanced', 'Balanced. A mix of listening and offering a next step when that seems useful.'],
    ['solutions', 'Solutions. Leans toward offering next steps and suggestions.'],
  ] as const

  const TEXT_FIELDS = [
    ['preferredName', 'Preferred name'],
    ['pronouns', 'Pronouns'],
    ['location', 'Location'],
    ['occupation', 'Occupation'],
    ['timezone', 'Timezone'],
    ['birthday', 'Birthday'],
  ] as const

  type TextField = (typeof TEXT_FIELDS)[number][0]

  export function Settings({ api }: { api: AppApi }): JSX.Element {
    const [profile, setProfile] = useState<PublicProfile | null>(null)
    const [safetyMode, setSafetyMode] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      void (async () => {
        try {
          setProfile(await api.getProfile())
          setSafetyMode((await api.getSettings()).safetyMode)
        } catch {
          setError('Settings could not be loaded. The rest of the record still works.')
        }
      })()
    }, [api])

    // Only whitelisted keys are ever sent. An empty box means the field is
    // unknown, which is null on the wire, rather than an empty string.
    const patch = useCallback(
      async (body: Record<string, unknown>) => {
        try {
          setProfile(await api.updateProfile(body))
          setError(null)
        } catch {
          setError('That change could not be saved.')
        }
      },
      [api],
    )

    if (error !== null && profile === null) {
      return (
        <div className="settings">
          <p role="alert">{error}</p>
        </div>
      )
    }
    if (profile === null) {
      return (
        <div className="settings">
          <p>Loading settings.</p>
        </div>
      )
    }

    return (
      <div className="settings">
        <h2>Settings</h2>
        {error !== null && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}

        <section className="settings-group">
          <h3>Style</h3>
          <p className="settings-note">How reverie talks with you in general. This is saved and lasts.</p>
          <StyleSelect
            id="engagement"
            label="Engagement"
            value={profile.style.engagement}
            options={ENGAGEMENT_OPTIONS}
            onChange={(value) => void patch({ style: { engagement: value } })}
          />
          <StyleSelect
            id="tone"
            label="Tone"
            value={profile.style.tone}
            options={TONE_OPTIONS}
            onChange={(value) => void patch({ style: { tone: value } })}
          />
          <StyleSelect
            id="orientation"
            label="Orientation"
            value={profile.style.orientation}
            options={ORIENTATION_OPTIONS}
            onChange={(value) => void patch({ style: { orientation: value } })}
          />
        </section>

        <section className="settings-group">
          <h3>Profile</h3>
          <p className="settings-note">
            Every field can be left blank. Blank means not known, and nothing here is guessed.
          </p>
          {TEXT_FIELDS.map(([field, label]) => (
            <TextRow
              key={field}
              field={field}
              label={label}
              value={profile[field]}
              onCommit={(value) => void patch({ [field]: value === '' ? null : value })}
            />
          ))}
          <label className="settings-row" htmlFor="birthdayGreetings">
            <span>Birthday greetings</span>
            <input
              id="birthdayGreetings"
              type="checkbox"
              checked={profile.birthdayGreetings === true}
              onChange={(event) => void patch({ birthdayGreetings: event.target.checked })}
            />
          </label>
        </section>

        <section className="settings-group">
          <h3>Safety mode</h3>
          <p>{safetyMode ?? 'not known'}</p>
          <p className="settings-note">
            This one is changed by hand in the config file, deliberately.
          </p>
        </section>
      </div>
    )
  }

  function StyleSelect({
    id,
    label,
    value,
    options,
    onChange,
  }: {
    id: string
    label: string
    value: string
    options: readonly (readonly [string, string])[]
    onChange: (value: string) => void
  }): JSX.Element {
    return (
      <label className="settings-row" htmlFor={id}>
        <span>{label}</span>
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map(([optionValue, description]) => (
            <option key={optionValue} value={optionValue}>
              {description}
            </option>
          ))}
        </select>
      </label>
    )
  }

  function TextRow({
    field,
    label,
    value,
    onCommit,
  }: {
    field: TextField
    label: string
    value: string | null
    onCommit: (value: string) => void
  }): JSX.Element {
    const [draft, setDraft] = useState(value ?? '')
    useEffect(() => {
      setDraft(value ?? '')
    }, [value])
    return (
      <label className="settings-row" htmlFor={field}>
        <span>{label}</span>
        <input
          id={field}
          type="text"
          value={draft}
          placeholder="not known"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== (value ?? '')) onCommit(draft)
          }}
        />
      </label>
    )
  }
  ```

- [ ] 5. Create `packages/web/src/views/settings.css`, following whatever token names `packages/web/src/tokens.css` already defines (`grep -n "^  --" packages/web/src/tokens.css` lists them):
  ```css
  .settings {
    overflow-y: auto;
    padding: 2rem;
    max-width: 44rem;
  }

  .settings-group {
    margin-bottom: 2.5rem;
  }

  .settings-note {
    opacity: 0.75;
    font-size: 0.9rem;
  }

  .settings-error {
    font-size: 0.9rem;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: 0.5rem 0;
  }

  .settings-row > span {
    flex: 0 0 10rem;
  }

  .settings-row input[type='text'],
  .settings-row select {
    flex: 1 1 auto;
    min-width: 0;
  }
  ```

- [ ] 6. Add both destinations to `packages/web/src/App.tsx`:
  ```tsx
  import { Journal } from './views/Journal.js'
  import { Settings } from './views/Settings.js'

  export type ViewId = 'conversations' | 'atlas' | 'library' | 'journal' | 'settings'

  const VIEW_IDS: ViewId[] = ['conversations', 'atlas', 'library', 'journal', 'settings']

  const VIEW_LABELS: Record<ViewId, string> = {
    conversations: 'Talk',
    atlas: 'Atlas',
    library: 'Record',
    journal: 'Journal',
    settings: 'Settings',
  }
  ```
  In `RailIcon`, add two branches before the final `return`:
  ```tsx
  if (view === 'journal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 4h10.5A1.5 1.5 0 0 1 18 5.5v13a1.5 1.5 0 0 1-1.5 1.5H6z" />
        <path d="M6 4v16M9 8.5h6M9 12h6M9 15.5h3" />
      </svg>
    )
  }
  if (view === 'settings') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
      </svg>
    )
  }
  ```
  and in the stage, add the two mount blocks alongside the existing atlas and library ones:
  ```tsx
  {view === 'journal' && (
    <ViewBoundary>
      <Journal />
    </ViewBoundary>
  )}
  {view === 'settings' && (
    <ViewBoundary>
      <Settings api={api} />
    </ViewBoundary>
  )}
  ```
  Conversations stays mounted behind them, exactly as it already does for atlas and library, so opening settings mid-conversation does not end the session.

- [ ] 7. Run:
  ```bash
  pnpm vitest run packages/web/src/App.test.tsx
  ```
  Expected: all pass.

- [ ] 8. Write the settings pane tests at `packages/web/src/views/settings.test.tsx`:
  ```tsx
  import { render, screen, waitFor } from '@testing-library/react'
  import { userEvent } from '@testing-library/user-event'
  import { beforeEach, describe, expect, it } from 'vitest'
  import type { AppApi, PublicProfile } from '../api.js'
  import { Settings } from './Settings.js'

  const emptyProfile: PublicProfile = {
    preferredName: null,
    pronouns: null,
    location: null,
    timezone: null,
    birthday: null,
    birthdayGreetings: null,
    occupation: null,
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
    prose: '',
  }

  let patches: Record<string, unknown>[]
  let user: ReturnType<typeof userEvent.setup>

  function makeApi(profile: PublicProfile = emptyProfile): AppApi {
    return {
      getProfile: async () => profile,
      getSettings: async () => ({ safetyMode: 'companion' as const }),
      updateProfile: async (patch: Record<string, unknown>) => {
        patches.push(patch)
        return profile
      },
    } as unknown as AppApi
  }

  beforeEach(() => {
    patches = []
    user = userEvent.setup()
  })

  describe('Settings', () => {
    it('shows the safety mode read-only, with the reason', async () => {
      render(<Settings api={makeApi()} />)
      expect(await screen.findByText('companion')).toBeInTheDocument()
      expect(screen.getByText(/changed by hand in the config file/)).toBeInTheDocument()
    })

    it('renders a blank field as not known rather than an empty box that looks like a mistake', async () => {
      render(<Settings api={makeApi()} />)
      const input = await screen.findByLabelText('Preferred name')
      expect(input).toHaveAttribute('placeholder', 'not known')
      expect(input).toHaveValue('')
    })

    it('sends only whitelisted keys when a style select changes', async () => {
      render(<Settings api={makeApi()} />)
      const select = await screen.findByLabelText('Tone')
      await user.selectOptions(select, 'direct')
      await waitFor(() => expect(patches).toHaveLength(1))
      expect(patches[0]).toEqual({ style: { tone: 'direct' } })
    })

    it('sends null when a field is cleared, not an empty string', async () => {
      render(<Settings api={makeApi({ ...emptyProfile, location: 'Bengaluru' })} />)
      const input = await screen.findByLabelText('Location')
      await user.clear(input)
      await user.tab()
      await waitFor(() => expect(patches).toHaveLength(1))
      expect(patches[0]).toEqual({ location: null })
    })

    it('never sends an infrastructure key', async () => {
      render(<Settings api={makeApi()} />)
      const input = await screen.findByLabelText('Preferred name')
      await user.type(input, 'Vish')
      await user.tab()
      await waitFor(() => expect(patches).toHaveLength(1))
      for (const patch of patches) {
        for (const key of Object.keys(patch)) {
          expect(['preferredName', 'pronouns', 'location', 'timezone', 'birthday', 'occupation', 'birthdayGreetings', 'style', 'prose']).toContain(key)
        }
      }
    })

    it('says so plainly when settings cannot be loaded', async () => {
      const failing = {
        getProfile: async () => {
          throw new Error('offline')
        },
        getSettings: async () => ({ safetyMode: 'companion' as const }),
        updateProfile: async () => emptyProfile,
      } as unknown as AppApi
      render(<Settings api={failing} />)
      expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    })
  })
  ```

- [ ] 9. Run:
  ```bash
  pnpm vitest run packages/web/src/views/settings.test.tsx
  ```
  Expected: all pass.

- [ ] 10. Falsify the whitelist test: change the location commit handler to send `{ location: value, memoryDir: '/tmp' }`, run the same command, and confirm `never sends an infrastructure key` fails. Restore.

- [ ] 11. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add journal and settings destinations to the web nav

Journal is a peer of Talk, Atlas and Record, mounted only while on screen,
with an honest placeholder: the journal spec owns its contents and
replaces the file. Settings is a pane launched from the rail, holding the
three style selects with their honest descriptions, the profile fields
with blank rendering as not known, and the safety mode read-only with one
line saying it is changed by hand in the config file. Conversations stays
mounted behind both, so opening either mid-conversation does not end the
session."
  ```

---

## Task 21: The mode picker, with the conversation

The picker sits with the chat, near the composer, not in settings. Mode is a property of this conversation, so it belongs where the conversation is, and it must be changeable mid-conversation without leaving the view. A click and a `set_mode` tool call take exactly the same path, so the two can never disagree.

**Files**
- Modify: `packages/web/src/views/Conversations.tsx`
- Modify: `packages/web/src/views/conversations.test.tsx`
- Modify: `packages/web/src/views/conversations.css`

**Interfaces**

Consumes: `AppApi.setSessionMode` (Task 18), `ChatState.mode` and the `mode` stream event (Task 17), `AppApi.getProfile` (Task 19).

Produces: no new exported symbols.

The ten modes and their one-line summaries are duplicated in the browser rather than imported, because `web` talks to `server` over HTTP only and never imports a runtime engine package. The list is a small, stable piece of copy; a test asserts it has ten entries so a future addition is noticed.

**Steps**

- [ ] 1. Add failing tests to `packages/web/src/views/conversations.test.tsx`:
  ```tsx
  describe('mode picker', () => {
    it('lists ten modes and starts on general', async () => {
      render(<Conversations api={makeApi()} />)
      const picker = await screen.findByLabelText('Mode')
      expect(picker).toHaveValue('general')
      expect(picker.querySelectorAll('option')).toHaveLength(10)
    })

    it('calls the session mode endpoint when the picker changes', async () => {
      const calls: [string, string][] = []
      render(<Conversations api={makeApi({ recordMode: (id, mode) => calls.push([id, mode]) })} />)
      const picker = await screen.findByLabelText('Mode')
      await user.selectOptions(picker, 'listen')
      await waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0]?.[1]).toBe('listen')
      expect(picker).toHaveValue('listen')
    })

    it('follows the model without a refetch when a mode event arrives', async () => {
      const stream = makeControllableStream()
      render(<Conversations api={makeApi({ stream })} />)
      await screen.findByLabelText('Mode')
      stream.push({ schemaVersion: '1', seq: 1, type: 'mode', mode: 'solve' })
      await waitFor(() => expect(screen.getByLabelText('Mode')).toHaveValue('solve'))
    })

    it('leaves the picker where it was when the endpoint fails', async () => {
      render(
        <Conversations
          api={makeApi({
            recordMode: () => {
              throw new Error('offline')
            },
          })}
        />,
      )
      const picker = await screen.findByLabelText('Mode')
      await user.selectOptions(picker, 'listen')
      await waitFor(() => expect(screen.getByLabelText('Mode')).toHaveValue('general'))
    })

    it('renders the status strip next to the composer', async () => {
      render(<Conversations api={makeApi()} />)
      expect(await screen.findByTestId('status-strip')).toHaveTextContent('warm')
    })
  })
  ```
  Extend the file's existing `makeApi` fake so it accepts `recordMode` and a controllable event stream, and so `getProfile` returns a profile with `style.tone` of `warm`. Find the existing fake with `grep -n "makeApi\|const api" packages/web/src/views/conversations.test.tsx | head -10`.

- [ ] 2. Run and read the failure:
  ```bash
  pnpm vitest run packages/web/src/views/conversations.test.tsx -t 'mode picker'
  ```
  Expected: `Unable to find a label with the text of: Mode`.

- [ ] 3. Add the catalogue copy and the picker to `packages/web/src/views/Conversations.tsx`. Above the component:
  ```tsx
  /*
   * Duplicated in the browser rather than imported: web talks to server over
   * HTTP only and never imports a runtime engine package. This is a small,
   * stable piece of copy, and the test that counts ten entries is what
   * notices if the catalogue ever grows without this list following.
   */
  const MODE_OPTIONS: readonly (readonly [string, string])[] = [
    ['general', 'Open conversation, no agenda.'],
    ['listen', 'You talk it through, it stays out of the way.'],
    ['solve', 'A concrete problem, worked toward real options and a decision.'],
    ['real', 'It pushes back and names what it sees.'],
    ['deep', 'It asks the questions, trying to understand you.'],
    ['brainstorm', 'Quantity over judgment, evaluation deferred.'],
    ['boost', 'Your corner talked up, from things it actually knows about you.'],
    ['decompress', 'Winding down. Light and low-stakes.'],
    ['process', 'Working through one specific thing until it settles.'],
    ['journal', 'Structured written reflection.'],
  ]
  ```

- [ ] 4. Add profile state and an elapsed ticker inside the component, next to the existing state:
  ```tsx
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    void (async () => {
      try {
        setProfile(await api.getProfile())
      } catch {
        // The strip degrades to nothing. A failed profile fetch must not
        // block the thread.
      }
    })()
  }, [api])

  useEffect(() => {
    const handle = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(handle)
  }, [])
  ```
  A `/style` change made in the settings pane is picked up on the next mount of this view, which is when the profile is fetched again.

- [ ] 5. Add the change handler:
  ```tsx
  const changeMode = useCallback(
    async (mode: string) => {
      const sessionId = state.session?.sessionId
      if (sessionId === undefined) return
      try {
        await api.setSessionMode(sessionId, mode)
        dispatch({
          type: 'stream',
          event: { schemaVersion: '1', seq: state.lastSequence + 1, type: 'mode', mode },
        })
      } catch {
        // The picker stays where it was. A mode the server did not accept
        // must not be shown as if it took effect.
      }
    },
    [api, state.session?.sessionId, state.lastSequence],
  )
  ```

- [ ] 6. Render the strip and the picker inside `composer-area-inner`, above the `<form>`:
  ```tsx
  <div className="composer-status">
    <label className="mode-picker" htmlFor="mode-picker">
      <span className="mode-picker-label">Mode</span>
      <select
        id="mode-picker"
        value={state.mode}
        disabled={!state.session || readOnly}
        onChange={(event) => void changeMode(event.target.value)}
      >
        {MODE_OPTIONS.map(([value, summary]) => (
          <option key={value} value={value}>
            {value}: {summary}
          </option>
        ))}
      </select>
    </label>
    <span className="status-strip" data-testid="status-strip">
      {webStatusStrip(profile, state.session?.createdAt, nowMs)}
    </span>
  </div>
  ```
  The `<label htmlFor="mode-picker">` wrapping a `<span>` labelled `Mode` is what makes `findByLabelText('Mode')` work.

- [ ] 7. Add the strip renderer below the component, applying the same degradation rules the CLI strip uses:
  ```tsx
  /*
   * The same four segments the terminal strip shows, from the same profile
   * fields: tone, local place and time, elapsed. Mode is the picker itself,
   * so it is not repeated here. A guessed timezone renders the time without
   * the place name; a zone the browser rejects drops the segment entirely
   * rather than substituting the host's, because a silent substitution is how
   * a wrong local time becomes invisible.
   */
  function webStatusStrip(
    profile: PublicProfile | null,
    createdAt: string | undefined,
    nowMs: number,
  ): string {
    if (profile === null) return ''
    const segments: string[] = [profile.style.tone]

    if (profile.timezone !== null) {
      try {
        const time = new Intl.DateTimeFormat('en-US', {
          timeZone: profile.timezone,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZoneName: 'short',
        }).format(new Date(nowMs))
        const place = profile.location === null ? '' : `${profile.location} `
        segments.push(`${place}${time}`)
      } catch {
        // A zone Intl rejects means no time segment at all.
      }
    }

    if (createdAt !== undefined) {
      const elapsed = Math.max(0, nowMs - new Date(createdAt).getTime())
      segments.push(`${Math.floor(elapsed / 60_000)}m`)
    }

    return segments.join(' · ')
  }
  ```
  Note the CLI strip only shows the place name when `timezoneSource` is `user-confirmed`, and the browser cannot see `timezoneSource`, because the endpoint deliberately does not expose it. That is the intended trade: the browser shows the place whenever a location is set, which is a small, stated difference rather than an accidental one.

- [ ] 8. Add the imports and the CSS. In the component file:
  ```tsx
  import type { AppApi, PublicProfile, Session, StreamEvent, TranscriptLine } from '../api.js'
  ```
  merging with the existing import from `'../api.js'`. In `packages/web/src/views/conversations.css`:
  ```css
  .composer-status {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 0 0.5rem;
    font-size: 0.85rem;
  }

  .mode-picker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-strip {
    opacity: 0.7;
    margin-left: auto;
  }
  ```

- [ ] 9. Run:
  ```bash
  pnpm vitest run packages/web/src/views/conversations.test.tsx
  ```
  Expected: all pass.

- [ ] 10. Falsify the agreement between picker and model: change the picker's `value` from `state.mode` to a fixed `'general'`, run:
  ```bash
  pnpm vitest run packages/web/src/views/conversations.test.tsx -t 'follows the model'
  ```
  and confirm it fails. Restore.

- [ ] 11. Build, test, lint, commit:
  ```bash
  pnpm build && pnpm test && pnpm lint
  git add -A && git commit -m "Add a mode picker and a status strip next to the composer

The picker sits with the conversation rather than in settings, because
mode is a property of this conversation. Changing it calls the session
mode endpoint, which drives AgentSession.setMode, so a click and a set_mode
tool call take the same path; a mode event from the model updates the
picker without a refetch. The strip shows tone, local place and time, and
elapsed, degrading the same way the terminal strip does."
  ```

---

## Task 22: Tell the truth in the README

AGENTS.md makes this mandatory after any meaningful build session, and it is a defect rather than a cosmetic gap when it lags. The README's Status section must say what actually ships, including what does not.

**Files**
- Modify: `README.md`

**Interfaces**

Consumes: everything above. Produces: nothing.

**Steps**

- [ ] 1. Read the current Status section:
  ```bash
  grep -n "## Status" -A 60 README.md
  ```

- [ ] 2. Update it so every one of these is stated accurately. Say each plainly, in the README's existing voice, without marketing tone and without em dashes:
  - Style now lives in `profile.md`, not `config.toml`. Existing installs must run `reverie migrate` once; running `reverie` before that fails with a message naming the command.
  - `config.toml` holds infrastructure only: provider, API key, model names, memory folder, safety mode, crisis resources. Safety mode is still changed only by hand, deliberately.
  - `profile.md` holds preferred name, pronouns, location, timezone, birthday, occupation, birthday greetings, style, and a short prose body. Every field is optional and nothing is ever inferred.
  - The model can record profile facts with `update_profile` and can never change style.
  - Ten conversation modes exist, set with `/mode`, the web picker, or by asking. A mode lasts one session and is never saved.
  - `journal` is in the catalogue and in the web nav, but journal mode itself is not finished: the mode currently changes only how the conversation is framed, and no journal entries are written. State this plainly rather than letting the mode's presence imply a feature that does not exist.
  - `update_style` is gone. Asking the companion to change style permanently now points the user at `/style` or the settings pane.
  - The CLI has `/help`, `/mode`, `/style`, `/settings`, `/whoami` and `/bye`, and a persistent status line above the prompt in an interactive terminal.
  - The web interface has five destinations: Talk, Atlas, Record, Journal and Settings, plus a mode picker next to the composer.
  - The server exposes `GET`/`PATCH /api/v1/profile`, `GET /api/v1/settings`, and `POST /api/v1/sessions/:id/mode`. There is no endpoint that can return the provider API key, and no endpoint that writes config.

- [ ] 3. Check the whole README for statements this work made false:
  ```bash
  grep -n "update_style\|\[style\]\|config.toml" README.md
  ```
  Fix every hit.

- [ ] 4. Check the writing rules on your own edit:
  ```bash
  grep -n "—" README.md
  ```
  Expected: no output. If there is any, replace each em dash with a comma, a period, a colon, or parentheses.

- [ ] 5. Record the `boost` dogfooding pass, which spec section 16.10 requires and which no unit test can stand in for. Whether the model manufactures praise cannot be settled by a test, and a test asserting the presence of specific praise text would be exactly the golden-text test AGENTS.md forbids. What is tested is deterministic and already covered in Task 6: the boost paragraph is present and carries the evidence requirement and the admit-the-absence requirement. The behavioural property is checked by hand:
  - Point reverie at a memory folder with almost no history, which is the case where manufacturing is most tempting.
  - Start a session, switch to `boost`, and ask it to talk you up.
  - Write the outcome into the release notes, in one short paragraph, whether it goes well or not. If it invented a strength, say so and say what was done about it. An honest bad result is the point of the pass.
  Add that paragraph to the README's Status section or to `ROADMAP.md`, wherever release notes currently live in this repository (`grep -n "Status" README.md ROADMAP.md | head`).

- [ ] 6. Run the release check, which asserts things about packaging and docs:
  ```bash
  pnpm vitest run packages/cli/src/release.test.ts
  ```
  Expected: passes. If it asserts on README content, update the assertion together with the README.

- [ ] 7. Final full verification:
  ```bash
  pnpm build && pnpm test && pnpm lint
  ```
  Expected: the build completes, every test file passes, biome reports no errors.

- [ ] 7. Commit:
  ```bash
  git add -A && git commit -m "Update the README for modes, profile and settings

Status now says what actually ships: style moved to profile.md and
existing installs must run reverie migrate, the ten modes and what a mode
does, the new CLI commands and status line, the five web destinations, and
the new endpoints. It also says plainly that journal mode is a catalogue
entry and a nav destination with nothing behind it yet, rather than
letting its presence imply a feature that does not exist."
  ```

---

## Handoff notes for the parallel plans

**For the journal plan.** This plan produces three things it depends on, all landed and tested here rather than assumed there:

1. `TranscriptLine.synthetic?: true` (Task 10). Set only on lines the system wrote on the user's behalf. `AgentSession.setMode` sets it when the call came from the web picker and leaves it absent when the user typed `/mode`. The journal plan's entry-body assembly excludes any line carrying it; that exclusion rule belongs to that plan.
2. `MemoryEngine.sessionMode(sessionId): Promise<string | undefined>` and `MemoryEngine.setSessionMode(sessionId, mode)` (Task 11), backed by `session.json` in the session directory. `_doEndSession` already reads the value into `sessionModeAtEnd`; the journal plan consumes it and gates its write on the value being exactly `'journal'`. An absent mode is absent, never `'general'`, so the gate behaves correctly for sessions no `AgentSession` opened.
3. `MODES.journal` (Task 6), with `summary` and two minimal clause strings for the axes it suppresses. The journal plan replaces exactly those three strings with its own protocol text built from `journaling.md`, and replaces `packages/web/src/views/Journal.tsx` wholesale. It should not need to touch anything else in `packages/core/src/modes.ts`.

**For the retrieval plan.** Nothing here changes retrieval. `profile.md` is not indexed and reaches the model through prompt assembly rather than through `search_memory`. `assembleSystemPrompt` gained a third parameter, `activeMode`, defaulting to `'general'`, and now reads style from `engine.currentStyle()` rather than from `config.style`.

**One reconciliation point, stated rather than hidden.** `formatStripTime` in `packages/cli/src/strip.ts` renders a local time and zone abbreviation with `Intl` directly. The spec asks the strip and the time plan's now-block to share one formatter. They do not yet, because the time plan's formatter is not named in either spec and inventing a cross-plan symbol would be worse than a stated duplication. If the time plan exported a formatter, the strip should be changed to call it, and this note deleted.
