# CLI Polish and CI Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round out reverie's CLI operator surface (version, help, doctor, exit codes, `--config`, error handling) and close the CI flake in `packages/memory`'s test suite, without touching persona behavior, memory format, or the web interface.

**Architecture:** All CLI logic stays in `packages/cli`, wired thin through `index.ts` the way `chat.ts`, `read.ts`, `setup.ts`, and `web.ts` already are: new pure modules (`version.ts`, `help.ts`, `doctor.ts`) hold testable logic, `index.ts` only parses argv and wires real implementations into `CliMainDeps`. The CI fix stays inside `packages/memory`: one flag added to `gitSync.ts`'s shared git helper, one retry helper used by `engine.test.ts`'s cleanup.

**Tech Stack:** TypeScript (`tsc -b`, project references, `rootDir: src` / `outDir: dist`), Vitest, Biome, pnpm workspaces, Node's `child_process.execFile` for git, `better-sqlite3` for the index.

**Spec:** docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md

**Depends on:** nothing. This plan is independent of the time, modes, journal, and retrieval plans, and can run first or last. Dispatch stays a plain `if`/`else if` chain in `mainWith()` (extended here with `doctor`), which already leaves room for a `reverie migrate` command that the time plan adds later: adding one more `if (subcommand === 'migrate')` branch, plus one more entry in `KNOWN_SUBCOMMANDS` and `SUBCOMMAND_HELP`, requires no restructuring of anything built in this plan.

## Global Constraints

- Layering is downward-only: `cli` -> `core` -> `memory` -> `providers`. This plan adds no new cross-package imports; `doctor.ts` imports `@openreverie/core` and `@openreverie/memory` the same way `chat.ts` and `read.ts` already do.
- Transcripts are append-only and never modified or deleted by code. Nothing in this plan touches transcript files.
- TDD for all deterministic logic in this plan: argv parsing, help text, version reading, doctor's checks, exit code mapping, the git flag, the retry helper. Write the failing test first, run it, see the real failure, then implement.
- A reviewer runs the tests, the build, and the lint itself. Do not accept a report as evidence.
- Falsify, do not read: for every test that asserts a specific behavior, the plan states what to delete or break to confirm the test actually catches it.
- Secrets are never printed. `doctor`'s api-key check reports only whether a key resolved and by what mechanism, never the value.
- No em dashes, no AI tropes, no emoji, in any CLI-facing copy, code comment, commit message, or this document.
- Keep argument parsing hand-rolled. No new dependency (`commander`, `yargs`, `cac`, `meow`) is added to `packages/cli/package.json`.
- Prose file writes stay atomic where this plan touches them (`saveConfig` already does this; unchanged here).

---

## File structure

New files:
- `packages/cli/src/version.ts`, `packages/cli/src/version.test.ts`
- `packages/cli/src/help.ts`, `packages/cli/src/help.test.ts`
- `packages/cli/src/doctor.ts`, `packages/cli/src/doctor.test.ts`
- `packages/cli/src/index.test.ts` (does not exist today)

Modified files:
- `packages/cli/src/index.ts`
- `packages/cli/src/chat.ts`, `packages/cli/src/chat.test.ts`
- `README.md`
- `packages/memory/src/gitSync.ts`, `packages/memory/src/gitSync.test.ts`
- `packages/memory/src/engine.test.ts`

Not modified: `packages/cli/src/setup.ts` (already accepts an optional `configPath`; only its caller in `index.ts` changes), `packages/cli/src/read.ts` (already accepts `loadConfig`/`write`/`colorEnabled` the way this plan needs; its own 19 `return 1` sites are grandfathered, see Task 1), `packages/memory/src/engine.ts` (Part 2 deliberately does not touch it; see Task 7's scope note).

---

## Task 1: Fix CLI dispatch: unknown command/flag, `--version`, `--help`, `--config`

Implements spec 1.1 (the dispatch bug), 1.2 (`--version`/`-v`/`version`), 1.3 (`--help`/`-h`/`help`, exact help layouts, delegated to Task 1 for wiring and Task 2's sibling module for text), 1.6 (`--config <path>`), 1.7 (unknown subcommand/flag), 1.8 (hand-rolled parsing, confirmed by this task: no new dependency added).

This is the first task because the dispatch bug is the one real bug in this spec (spec 1.1): today, any unrecognized `args[0]`, including `--version`, `--help`, and a typo like `reflcet`, falls through `mainWith()`'s `if`/`else if` chain in `packages/cli/src/index.ts` straight into `openCliContext()`, which loads config, resolves the API key, opens the engine, and starts a real chat session. This task's first step fixes exactly that, with a regression test that would fail today (before this task) and passes after.

### Files
- `packages/cli/src/index.ts` (edit)
- `packages/cli/src/index.test.ts` (new)
- `packages/cli/src/version.ts` (new)
- `packages/cli/src/version.test.ts` (new)
- `packages/cli/src/setup.ts` (no change; confirm `runSetup(io: SetupIo, configPath?: string)` at line 208 already accepts the second argument)

### Interfaces

Consumes (already exist, unchanged):
- `loadConfig(configPath?: string): Promise<ReverieConfig>` from `@openreverie/core` (`packages/core/src/config.ts:111`)
- `runSetup(io: SetupIo, configPath?: string): Promise<void>` from `./setup.js` (`packages/cli/src/setup.ts:208`)
- `RunWebCommandDeps` from `./web.js`: `{ launchServer, write, configPath?: string, signals?: SignalSource }` (`packages/cli/src/web.ts:8-13`)

Produces:
- `packages/cli/src/version.ts`: `export function readOwnVersion(): string`
- `packages/cli/src/index.ts`: `export interface CliMainDeps` gains one field: `readVersion: () => string`. `CliMainDeps.runSetupCommand` changes from `() => Promise<void>` to `(configPath: string) => Promise<void>`.
- `packages/cli/src/index.ts`: `export async function mainWith(args: string[], deps: CliMainDeps): Promise<void>` (signature unchanged, behavior changed as below)

### Step 1.1 (RED): the dispatch bug's regression test

Create `packages/cli/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CliMainDeps } from './index.js'
import { mainWith } from './index.js'

function testDeps(overrides: Partial<CliMainDeps> = {}): { deps: CliMainDeps; output: () => string } {
  let output = ''
  const base: CliMainDeps = {
    runWeb: async () => {
      throw new Error('runWeb should not be called')
    },
    launchServer: async () => {
      throw new Error('launchServer should not be called')
    },
    runRead: async () => {
      throw new Error('runRead should not be called')
    },
    runSetupCommand: async () => {
      throw new Error('runSetupCommand should not be called')
    },
    openCliContext: async () => {
      throw new Error('openCliContext should not be called')
    },
    buildChat: () => {
      throw new Error('buildChat should not be called')
    },
    buildEmbeddings: () => {
      throw new Error('buildEmbeddings should not be called')
    },
    openEngine: async () => {
      throw new Error('openEngine should not be called')
    },
    countMemoryDocuments: async () => {
      throw new Error('countMemoryDocuments should not be called')
    },
    runChat: async () => {
      throw new Error('runChat should not be called')
    },
    createStylePersister: () => async (patch) => ({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
      ...patch,
    }),
    loadConfig: async () => {
      throw new Error('loadConfig should not be called')
    },
    configPath: '/fake/.reverie/config.toml',
    write: (text: string) => {
      output += text
    },
    colorEnabled: () => false,
    readVersion: () => '9.9.9-test',
  }
  return { deps: { ...base, ...overrides }, output: () => output }
}

describe('mainWith unknown subcommand', () => {
  it('reports an unknown command and never opens a CLI context, instead of falling through to chat', async () => {
    let contextOpened = false
    const { deps, output } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        return { ok: true, engine: {} as never, config: {} as never, chat: {} as never }
      },
    })

    await mainWith(['reflcet'], deps)

    expect(contextOpened).toBe(false)
    expect(output()).toBe(
      "reverie: unknown command 'reflcet'\nRun 'reverie --help' for a list of commands.\n",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('still starts the chat REPL when no subcommand is given at all', async () => {
    let contextOpened = false
    const { deps } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        return { ok: false, kind: 'config', message: 'stop here' } as never
      },
    })

    await mainWith([], deps)

    expect(contextOpened).toBe(true)
    process.exitCode = 0
  })
})
```

Run it:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: `packages/cli/src/index.test.ts` fails to import `CliMainDeps`/`mainWith` in a way that type-checks (the `readVersion` field does not exist on the real `CliMainDeps` yet, and `openCliContext`'s fake return in the second test lacks a `kind` field the real type will later require in Task 3; for this task only, the first test is what must fail at runtime). Concretely, run it now and confirm: the first test fails because `contextOpened` is `true` and `output()` does not equal the expected string. The second test currently passes already (bare `reverie` already starts chat), which is expected: it is a guard against a future regression, not proof of anything new yet.

### Step 1.2 (GREEN): minimal fix for the unknown-command guard

In `packages/cli/src/index.ts`, add a constant near the top (after the existing imports, before `colorsEnabled`):

```ts
const KNOWN_SUBCOMMANDS = new Set(['setup', 'web', 'read', 'reindex', 'reflect'])
```

In `mainWith()`, immediately after `const subcommand = args[0]`, insert:

```ts
  if (subcommand !== undefined && !KNOWN_SUBCOMMANDS.has(subcommand)) {
    deps.write(`reverie: unknown command '${subcommand}'\nRun 'reverie --help' for a list of commands.\n`)
    process.exitCode = 1
    return
  }
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected: both tests in `mainWith unknown subcommand` pass. `CliMainDeps` does not yet have `readVersion`, so the file will not type-check under `tsc -b`; that is expected and fixed in Step 1.3. Vitest itself (esbuild-transpiled, no type-check) runs regardless, which is why this step is checked with the test runner, not the build, at this point.

Falsify: comment out the inserted `if` block, rerun, confirm the first test fails again with `contextOpened === true`. Restore it.

Commit: `fix(cli): stop unrecognized subcommands from falling through to chat`

### Step 1.3 (RED): `readOwnVersion()`

Create `packages/cli/src/version.ts`:

```ts
// Reads reverie's own installed version at runtime, from the CLI
// package's own package.json, never a literal hardcoded in source.
// tsc -b with rootDir: src / outDir: dist preserves the source tree
// shape one-to-one, so the compiled dist/version.js sits exactly one
// directory below packages/cli/package.json in every install shape
// (local build, npm link, global install): npm always ships
// package.json regardless of the "files" field. See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 1.2 for why this mechanism, not a JSON import attribute or
// process.env.npm_package_version, is the one that works here.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function readOwnVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    version: string
  }
  return pkg.version
}
```

Create `packages/cli/src/version.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readOwnVersion } from './version.js'

describe('readOwnVersion', () => {
  it('matches the version field in packages/cli/package.json, read independently', async () => {
    const manifest = new URL('../package.json', import.meta.url)
    const expected = JSON.parse(await readFile(manifest, 'utf8')).version
    expect(readOwnVersion()).toBe(expected)
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/version.test.ts
```

This should already pass on the first run, since `version.ts` is written correctly above; there is no red step here for the implementation itself, only for the falsification check. Falsify: temporarily change `readOwnVersion` to `return '0.0.0'`, rerun, confirm the test fails since the real `packages/cli/package.json` version is `0.5.0`, not `0.0.0`. Restore the real implementation.

Commit: `feat(cli): read the installed version from package.json at runtime`

### Step 1.4 (RED): `--version`/`-v`/`version` wired into dispatch

Add to `packages/cli/src/index.test.ts`, a new `describe` block:

```ts
describe('mainWith --version', () => {
  it('prints the bare version and exits 0 for --version, without touching config', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['--version'], deps)
    expect(output()).toBe('1.2.3\n')
    expect(process.exitCode).toBe(0)
    process.exitCode = 0
  })

  it('prints the bare version for -v', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['-v'], deps)
    expect(output()).toBe('1.2.3\n')
    process.exitCode = 0
  })

  it('prints the bare version for the version subcommand', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['version'], deps)
    expect(output()).toBe('1.2.3\n')
    process.exitCode = 0
  })

  it('wins over other garbage arguments, per spec 1.2', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['--version', '--config', '/bogus'], deps)
    expect(output()).toBe('1.2.3\n')
    process.exitCode = 0
  })
})
```

Also add `readVersion: () => '9.9.9-test'` is already in `testDeps` from Step 1.1; no change needed there.

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: all four new tests fail. `--version`/`-v` are not yet recognized by `KNOWN_SUBCOMMANDS`, so `mainWith(['--version'], deps)` falls into the unknown-command branch from Step 1.2 and writes `"reverie: unknown command '--version'\n..."` instead of the version string; `version` as a bare subcommand is also not in `KNOWN_SUBCOMMANDS` yet, so it fails the same way.

### Step 1.5 (GREEN): wire `--version`

In `packages/cli/src/index.ts`, add `readVersion: () => string` to the `CliMainDeps` interface (after `colorEnabled: () => boolean`):

```ts
  colorEnabled: () => boolean
  readVersion: () => string
```

In `mainWith()`, insert this check as the very first thing in the function body, before `const subcommand = args[0]`:

```ts
export async function mainWith(args: string[], deps: CliMainDeps): Promise<void> {
  if (args.includes('--version') || args.includes('-v') || args[0] === 'version') {
    deps.write(`${deps.readVersion()}\n`)
    process.exitCode = 0
    return
  }

  const subcommand = args[0]
  // ... existing unknown-command guard from Step 1.2 follows ...
```

Add `readVersion: readOwnVersion` to `defaultDeps`, and the import:

```ts
import { readOwnVersion } from './version.js'
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected: all four `mainWith --version` tests pass, the two `mainWith unknown subcommand` tests still pass.

Falsify: change `args.includes('--version')` to `args.includes('--versionx')`, rerun, confirm the first and fourth new tests fail. Restore.

Commit: `feat(cli): wire --version, -v, and the version subcommand`

### Step 1.6 (RED): `--config <path>` extraction and wiring

Add to `packages/cli/src/index.test.ts`:

```ts
describe('mainWith --config', () => {
  it('routes --config before the subcommand into loadConfig', async () => {
    let receivedPath: string | undefined
    const { deps } = testDeps({
      runRead: async (_args, readDeps) => {
        await readDeps.loadConfig()
        return 0
      },
      loadConfig: async (path: string) => {
        receivedPath = path
        return {} as never
      },
    })

    await mainWith(['--config', '/custom/config.toml', 'read'], deps)

    expect(receivedPath).toBe('/custom/config.toml')
  })

  it('routes --config after the subcommand the same way', async () => {
    let receivedPath: string | undefined
    const { deps } = testDeps({
      runRead: async (_args, readDeps) => {
        await readDeps.loadConfig()
        return 0
      },
      loadConfig: async (path: string) => {
        receivedPath = path
        return {} as never
      },
    })

    await mainWith(['read', '--config', '/custom/config.toml'], deps)

    expect(receivedPath).toBe('/custom/config.toml')
  })

  it('reports a usage error when --config has no value', async () => {
    const { deps, output } = testDeps()

    await mainWith(['--config'], deps)

    expect(output()).toBe('--config requires a path argument\n')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('reports a usage error when --config is the last argument with a subcommand before it', async () => {
    const { deps, output } = testDeps()

    await mainWith(['read', '--config'], deps)

    expect(output()).toBe('--config requires a path argument\n')
    process.exitCode = 0
  })
})

describe('mainWith unknown option', () => {
  it('reports an unknown flag anywhere in argv, without touching config', async () => {
    const { deps, output } = testDeps()

    await mainWith(['reflect', '--frobnicate'], deps)

    expect(output()).toBe(
      "reverie: unknown option '--frobnicate'\nRun 'reverie --help' for a list of options.\n",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: `--config` is not recognized at all yet, so `mainWith(['--config', '/custom/config.toml', 'read'], deps)` falls into the Step 1.2 unknown-command guard (`args[0]` is `'--config'`, not in `KNOWN_SUBCOMMANDS`), writing an unknown-command message instead of routing the path; the missing-value tests fail the same way; the unknown-option test currently fails too, since `--frobnicate` is simply ignored today (falls through to `openCliContext` after `subcommand` resolves to `'reflect'`, which is a known subcommand, so today's code would actually try to run `reflect` for real rather than reporting an unknown option).

### Step 1.7 (GREEN): `--config` extraction, unknown-flag scan, and full dispatch rewrite

Replace `mainWith()` in `packages/cli/src/index.ts` in full. First, add this helper above `mainWith`:

```ts
interface ConfigExtraction {
  configOverride?: string
  rest: string[]
  error?: string
}

// Pulls `--config <path>` out of argv, wherever it appears, leaving every
// other token in `rest` in its original order. A `--config` with nothing
// after it (or as the very last token) is reported as `error` instead of
// silently swallowing the next real argument.
function extractConfigOverride(args: string[]): ConfigExtraction {
  const rest: string[] = []
  let configOverride: string | undefined
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--config') {
      const value = args[i + 1]
      if (value === undefined) {
        return { rest: [], error: '--config requires a path argument' }
      }
      configOverride = value
      i += 1
      continue
    }
    if (token !== undefined) rest.push(token)
  }
  return configOverride === undefined ? { rest } : { configOverride, rest }
}
```

Now replace the whole body of `mainWith` with:

```ts
export async function mainWith(args: string[], deps: CliMainDeps): Promise<void> {
  if (args.includes('--version') || args.includes('-v') || args[0] === 'version') {
    deps.write(`${deps.readVersion()}\n`)
    process.exitCode = 0
    return
  }

  const extraction = extractConfigOverride(args)
  if (extraction.error !== undefined) {
    deps.write(`${extraction.error}\n`)
    process.exitCode = 1
    return
  }
  const { configOverride, rest } = extraction
  const configPath = configOverride ?? deps.configPath

  const unknownFlag = rest.find((token) => token.startsWith('-'))
  if (unknownFlag !== undefined) {
    deps.write(`reverie: unknown option '${unknownFlag}'\nRun 'reverie --help' for a list of options.\n`)
    process.exitCode = 1
    return
  }

  const subcommand = rest[0]
  if (subcommand !== undefined && !KNOWN_SUBCOMMANDS.has(subcommand)) {
    deps.write(`reverie: unknown command '${subcommand}'\nRun 'reverie --help' for a list of commands.\n`)
    process.exitCode = 1
    return
  }

  if (subcommand === 'setup') {
    await deps.runSetupCommand(configPath)
    return
  }

  if (subcommand === 'web') {
    await deps.runWeb({
      launchServer: deps.launchServer,
      write: deps.write,
      ...(configOverride !== undefined ? { configPath: configOverride } : {}),
    })
    return
  }

  if (subcommand === 'read') {
    const exitCode = await deps.runRead(rest.slice(1), {
      loadConfig: () => deps.loadConfig(configPath),
      write: deps.write,
      colorEnabled: deps.colorEnabled(),
    })
    process.exitCode = exitCode
    return
  }

  const colorEnabled = deps.colorEnabled()

  const context = await deps.openCliContext({
    loadConfig: () => deps.loadConfig(configPath),
    buildChat: deps.buildChat,
    buildEmbeddings: deps.buildEmbeddings,
    openEngine: (config, engineDeps) => deps.openEngine(config.memoryDir, engineDeps),
  })

  if (!context.ok) {
    deps.write(`${context.message}\n`)
    process.exitCode = 1
    return
  }

  const { engine, config, chat } = context
  printWarnings({ write: deps.write }, engine, colorEnabled)

  try {
    if (subcommand === 'reindex') {
      await engine.reindexAll()
      const count = await deps.countMemoryDocuments(config.memoryDir)
      deps.write(`Reindexed ${count} documents.\n`)
    } else if (subcommand === 'reflect') {
      await engine.runMaintenance()
      printWarnings({ write: deps.write }, engine, colorEnabled)
      deps.write('Reflection is up to date.\n')
    } else {
      const io = readlineChatIo()
      const toolDeps = { updateStyle: deps.createStylePersister(config, configPath) }
      try {
        await deps.runChat({ engine, config, chat, io, toolDeps, colorEnabled })
      } finally {
        io.close()
      }
    }
  } finally {
    await engine.close()
  }
}
```

Note: the `!context.ok` branch above still hardcodes `process.exitCode = 1` at this point in the plan. Task 3 changes this line to use `context.kind`; leaving it as `1` here keeps this task's tests (which do not yet exercise `kind`) green without forward-referencing work that has not happened yet.

Update `CliMainDeps.runSetupCommand`'s type from `() => Promise<void>` to `(configPath: string) => Promise<void>`, and update the local `runSetupCommand` function above `defaultDeps` to accept and forward the path:

```ts
async function runSetupCommand(configPath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await runSetup(
      {
        question: (prompt: string) => rl.question(prompt),
        write: (text: string) => process.stdout.write(text),
      },
      configPath,
    )
  } finally {
    rl.close()
  }
}
```

`defaultDeps.runSetupCommand: runSetupCommand` already matches by reference; no further change needed there since `typeof runSetupCommand` now includes the parameter.

Update `packages/cli/src/index.test.ts`'s `testDeps()` base object: change `runSetupCommand: async () => { throw ... }` to `runSetupCommand: async (_configPath: string) => { throw new Error('runSetupCommand should not be called') }`. Also update the two tests from Step 1.6 that faked `runRead` with a two-argument signature `async (_args, readDeps) => { ... }`: confirm this already matches `CliMainDeps['runRead']`'s real type (`typeof runRead`, i.e. `(args: string[], deps: ReadDeps) => Promise<number>`), so no further change is needed there.

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected: every test added in Steps 1.1, 1.4, and 1.6 passes.

Then run the whole package to confirm nothing else broke:

```
pnpm --filter openreverie test
```

Expected: all files pass, including `chat.test.ts`, `read.test.ts`, `setup.test.ts`, `web.test.ts`, `e2e.test.ts`, `release.test.ts`, `status.test.ts`.

Then type-check:

```
pnpm build
```

Expected: builds clean. (This also builds `core`, `memory`, `providers`, `server`, `web` via project references; if anything outside `packages/cli` fails to build at this point in the plan, stop and investigate before continuing, since nothing in Task 1 should touch those packages.)

Falsify: temporarily delete the `unknownFlag` check block, rerun `src/index.test.ts`, confirm the `mainWith unknown option` test fails (since `reflect` would now be treated as a normal subcommand and `--frobnicate` silently ignored). Restore it. Separately, delete the `--config` missing-value check, rerun, confirm the two missing-value tests in `mainWith --config` fail with a different (wrong) error, or no error at all. Restore it.

Commit: `feat(cli): wire --config, unknown-flag detection, and full dispatch rewrite`

---

## Task 2: `--help`, `-h`, `help`, and per-subcommand help text

Implements spec 1.3 in full: the exact top-level layout and the eight per-subcommand blocks (`setup`, `web`, `read`, `reindex`, `reflect`, `doctor`, `version`, `help`).

### Files
- `packages/cli/src/help.ts` (new)
- `packages/cli/src/help.test.ts` (new)
- `packages/cli/src/index.ts` (edit)
- `packages/cli/src/index.test.ts` (edit)

### Interfaces

Produces:
- `packages/cli/src/help.ts`: `export const TOP_LEVEL_HELP: string`, `export function subcommandHelp(name: string): string | undefined`
- `packages/cli/src/index.ts`: `CliMainDeps` unchanged (help text is imported directly, not injected, since it has no side effects to fake)

### Step 2.1 (RED): help text module

Create `packages/cli/src/help.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { subcommandHelp, TOP_LEVEL_HELP } from './help.js'

describe('TOP_LEVEL_HELP', () => {
  it('matches the exact layout specified in the CLI polish spec', () => {
    expect(TOP_LEVEL_HELP).toBe(
      `reverie: a self-hosted companion agent with a memory that does not forget.

Usage: reverie [command] [options]

Commands:
  (none)          Start the terminal chat REPL.
  setup           Run the first-run setup wizard.
  web             Start the local web interface.
  read [target]   Print part of your memory record from disk. No network call.
  reindex         Rebuild the SQLite search index from the memory folder.
  reflect         Run maintenance now (reflect stale sessions, build rollups).
  doctor          Check config, provider, and memory folder health.
  version         Print the installed version.
  help [command]  Show this message, or help for one command.

Options:
  -v, --version   Print the installed version.
  -h, --help      Show this message.
  --config <path> Use a config file at this path instead of the default.

Run 'reverie help <command>' for details on a specific command.
`,
    )
  })
})

describe('subcommandHelp', () => {
  it('returns the exact reflect help block', () => {
    expect(subcommandHelp('reflect')).toBe(
      `reverie reflect

Runs maintenance immediately: reflects any stale unreflected sessions and builds any
daily or weekly rollups that are due, instead of waiting for it to happen automatically
on next chat start. Requires a working config and a reachable model provider.

Usage: reverie reflect [--config <path>]
`,
    )
  })

  it('returns the exact doctor help block', () => {
    expect(subcommandHelp('doctor')).toBe(
      `reverie doctor

Checks whether reverie is set up correctly: config file present and valid, API key
resolvable, memory folder present and writable, memory folder's git state, and SQLite
index present and rebuildable. Never prints secret values. Exits non-zero if any check
fails.

Usage: reverie doctor [--config <path>]
`,
    )
  })

  it('returns the exact read help block, including its argument forms', () => {
    expect(subcommandHelp('read')).toBe(
      `reverie read [target]

Prints part of your memory record straight from the files on disk. No network call,
no engine, no provider: this works even when the provider is offline or unconfigured.

With no arguments, lists your constitution, arcs, realms, and people. Other forms:
  reverie read constitution     Print the constitution in full.
  reverie read arc <name>       Print one arc by a case-insensitive substring match.
  reverie read realm <name>     Print one realm the same way.
  reverie read person <name>    Print one person the same way.

Usage: reverie read [constitution | arc <name> | realm <name> | person <name>] [--config <path>]
`,
    )
  })

  it('returns undefined for an unknown command name', () => {
    expect(subcommandHelp('bogus')).toBeUndefined()
  })

  it('has a help block for every command listed in the top-level Commands section', () => {
    const names = ['setup', 'web', 'read', 'reindex', 'reflect', 'doctor', 'version', 'help']
    for (const name of names) {
      expect(subcommandHelp(name)).toBeDefined()
    }
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/help.test.ts
```

Expected failure: module `./help.js` does not exist.

### Step 2.2 (GREEN): write the help text module

Create `packages/cli/src/help.ts`:

```ts
// Exact help text for `reverie --help`/`-h`/`help` and `reverie help
// <command>`/`reverie <command> --help`. See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 1.3 for the required top-level layout and the reflect/doctor
// examples this module's other blocks follow the shape of. Each
// per-subcommand block restates what README.md's Usage section already
// says about that command, rather than diverging from it.

export const TOP_LEVEL_HELP = `reverie: a self-hosted companion agent with a memory that does not forget.

Usage: reverie [command] [options]

Commands:
  (none)          Start the terminal chat REPL.
  setup           Run the first-run setup wizard.
  web             Start the local web interface.
  read [target]   Print part of your memory record from disk. No network call.
  reindex         Rebuild the SQLite search index from the memory folder.
  reflect         Run maintenance now (reflect stale sessions, build rollups).
  doctor          Check config, provider, and memory folder health.
  version         Print the installed version.
  help [command]  Show this message, or help for one command.

Options:
  -v, --version   Print the installed version.
  -h, --help      Show this message.
  --config <path> Use a config file at this path instead of the default.

Run 'reverie help <command>' for details on a specific command.
`

const SUBCOMMAND_HELP: Record<string, string> = {
  setup: `reverie setup

Runs the first-run setup wizard: asks for your provider API key, your safety mode,
and where you want your memory folder to live, then writes a config file. Run it
once before anything else.

Usage: reverie setup [--config <path>]
`,
  web: `reverie web

Starts the local web interface and prints its bootstrap URL. The server listens on
127.0.0.1 only, so only processes on your own machine can reach it. Copy the printed
URL into your browser to start; this command does not open the browser for you.

Usage: reverie web [--config <path>]
`,
  read: `reverie read [target]

Prints part of your memory record straight from the files on disk. No network call,
no engine, no provider: this works even when the provider is offline or unconfigured.

With no arguments, lists your constitution, arcs, realms, and people. Other forms:
  reverie read constitution     Print the constitution in full.
  reverie read arc <name>       Print one arc by a case-insensitive substring match.
  reverie read realm <name>     Print one realm the same way.
  reverie read person <name>    Print one person the same way.

Usage: reverie read [constitution | arc <name> | realm <name> | person <name>] [--config <path>]
`,
  reindex: `reverie reindex

Rebuilds the SQLite search index from your memory folder from scratch. Safe to run
any time: the index is always derived and disposable, never a source of truth.

Usage: reverie reindex [--config <path>]
`,
  reflect: `reverie reflect

Runs maintenance immediately: reflects any stale unreflected sessions and builds any
daily or weekly rollups that are due, instead of waiting for it to happen automatically
on next chat start. Requires a working config and a reachable model provider.

Usage: reverie reflect [--config <path>]
`,
  doctor: `reverie doctor

Checks whether reverie is set up correctly: config file present and valid, API key
resolvable, memory folder present and writable, memory folder's git state, and SQLite
index present and rebuildable. Never prints secret values. Exits non-zero if any check
fails.

Usage: reverie doctor [--config <path>]
`,
  version: `reverie version

Prints the installed version and exits. Same as reverie --version or reverie -v.

Usage: reverie version
`,
  help: `reverie help

Shows the top-level command list, or details for one command.

Usage: reverie help [command]
`,
}

export function subcommandHelp(name: string): string | undefined {
  return SUBCOMMAND_HELP[name]
}
```

Run:

```
pnpm --filter openreverie test -- src/help.test.ts
```

Expected: all tests pass.

Falsify: delete the `Usage: reverie reflect [--config <path>]` line from the `reflect` block, rerun, confirm the exact-match test for `reflect` fails (a substring check would not have caught this). Restore it.

Commit: `feat(cli): add top-level and per-subcommand help text`

### Step 2.3 (RED): help wired into dispatch

Add to `packages/cli/src/index.test.ts`:

```ts
import { subcommandHelp, TOP_LEVEL_HELP } from './help.js'

describe('mainWith --help', () => {
  it('prints top-level help and exits 0 for --help, without touching config', async () => {
    const { deps, output } = testDeps()
    await mainWith(['--help'], deps)
    expect(output()).toBe(TOP_LEVEL_HELP)
    expect(process.exitCode).toBe(0)
    process.exitCode = 0
  })

  it('prints top-level help for -h', async () => {
    const { deps, output } = testDeps()
    await mainWith(['-h'], deps)
    expect(output()).toBe(TOP_LEVEL_HELP)
    process.exitCode = 0
  })

  it('prints top-level help for the bare help subcommand', async () => {
    const { deps, output } = testDeps()
    await mainWith(['help'], deps)
    expect(output()).toBe(TOP_LEVEL_HELP)
    process.exitCode = 0
  })

  it('prints reflect-specific help for reverie reflect --help, without opening an engine', async () => {
    let contextOpened = false
    const { deps, output } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        throw new Error('should not reach here')
      },
    })
    await mainWith(['reflect', '--help'], deps)
    expect(output()).toBe(subcommandHelp('reflect'))
    expect(contextOpened).toBe(false)
    process.exitCode = 0
  })

  it('prints reflect-specific help for reverie help reflect', async () => {
    const { deps, output } = testDeps()
    await mainWith(['help', 'reflect'], deps)
    expect(output()).toBe(subcommandHelp('reflect'))
    process.exitCode = 0
  })

  it('reports an unknown command and exits 1 for reverie help bogus', async () => {
    const { deps, output } = testDeps()
    await mainWith(['help', 'bogus'], deps)
    expect(output()).toBe(
      "reverie: unknown command 'bogus'\nRun 'reverie --help' for a list of commands.\n",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: none of `--help`, `-h`, `help`, or `<subcommand> --help` are recognized yet, so every case falls into the unknown-command or unknown-option branch from Task 1 instead of printing help.

### Step 2.4 (GREEN): wire help into `mainWith`

In `packages/cli/src/index.ts`, add the import:

```ts
import { subcommandHelp, TOP_LEVEL_HELP } from './help.js'
```

Insert help handling in `mainWith`, directly after the `--version` check and before `extractConfigOverride`:

```ts
  if (args[0] === 'help') {
    const topic = args[1]
    if (topic === undefined) {
      deps.write(TOP_LEVEL_HELP)
      process.exitCode = 0
      return
    }
    const text = subcommandHelp(topic)
    if (text === undefined) {
      deps.write(`reverie: unknown command '${topic}'\nRun 'reverie --help' for a list of commands.\n`)
      process.exitCode = 1
      return
    }
    deps.write(text)
    process.exitCode = 0
    return
  }

  if (args.includes('--help') || args.includes('-h')) {
    const first = args[0]
    const topic = first !== undefined && !first.startsWith('-') ? subcommandHelp(first) : undefined
    deps.write(topic ?? TOP_LEVEL_HELP)
    process.exitCode = 0
    return
  }
```

This makes `reverie <subcommand> --help` and `reverie help <subcommand>` show that subcommand's help, and both `reverie --help`/`-h` on their own and `reverie --help <subcommand>` (flag before the subcommand) show top-level help. This asymmetry (only `<subcommand> --help` and `help <subcommand>` are per-subcommand; `--help <subcommand>` is not) is a deliberate, stated simplification of hand-rolled parsing: `argv[0]` is the only position checked for a subcommand name once a bare `--help`/`-h` flag is found anywhere.

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected: all six `mainWith --help` tests pass.

Then the full package suite and build:

```
pnpm --filter openreverie test
pnpm build
```

Expected: clean.

Falsify: delete the `if (args[0] === 'help')` block, rerun `src/index.test.ts`, confirm the `reverie help reflect` and `reverie help bogus` tests fail. Restore it.

Commit: `feat(cli): wire --help, -h, help, and per-subcommand help into dispatch`

---

## Task 3: Exit code kinds for config vs. provider failures

Implements spec 1.5, rows for code 2 (Config error) and code 3 (Provider error), for the `openCliContext` failure path specifically. `doctor`'s own exit code (always 1 on any failed check, spec's explicit choice) is implemented in Task 4, not here. Code 3 for a failure mid-`reindex`/`reflect`/chat is Task 6. Code 4 (Interrupted) is Task 5.

### Files
- `packages/cli/src/chat.ts` (edit)
- `packages/cli/src/chat.test.ts` (edit)
- `packages/cli/src/index.ts` (edit)
- `packages/cli/src/index.test.ts` (edit)

### Interfaces

Produces:
- `packages/cli/src/chat.ts`: `CliContextResult`'s failure variant changes from `{ ok: false; message: string }` to `{ ok: false; kind: 'config' | 'provider'; message: string }`.

### Step 3.1 (RED): `kind` on each of the three failure branches

Add to `packages/cli/src/chat.test.ts`, inside the existing `describe('openCliContext', ...)` block (after the three existing `it` blocks, before the closing `})`):

```ts
  it('tags a config load failure with kind: config', async () => {
    const result = await openCliContext({
      loadConfig: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      buildChat: () => {
        throw new Error('should not be called')
      },
      buildEmbeddings: () => {
        throw new Error('should not be called')
      },
      openEngine: async () => {
        throw new Error('should not be called')
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('config')
    }
  })

  it('tags a provider construction failure with kind: provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-kind-'))
    try {
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => {
          throw new Error('unknown provider: openai2')
        },
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => MemoryEngine.open(config.memoryDir, deps),
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.kind).toBe('provider')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tags an engine-open failure with kind: config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-openfail-'))
    try {
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => new FakeChatProvider([]),
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async () => {
          throw new Error('engine open failed: disk full')
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.kind).toBe('config')
        expect(result.message).toBe('engine open failed: disk full')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
```

Run:

```
pnpm --filter openreverie test -- src/chat.test.ts
```

Expected failure: `result.kind` is `undefined` in all three new tests, since `CliContextResult`'s failure variant does not have a `kind` field yet.

### Step 3.2 (GREEN): tag each catch block

In `packages/cli/src/chat.ts`, change the type:

```ts
export type CliContextResult =
  | { ok: true; engine: MemoryEngine; config: ReverieConfig; chat: ChatProvider }
  | { ok: false; kind: 'config' | 'provider'; message: string }
```

And tag each of the three `catch` blocks in `openCliContext`:

```ts
export async function openCliContext(deps: CliEngineDeps): Promise<CliContextResult> {
  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    return { ok: false, kind: 'config', message: errorMessage(err) }
  }

  let chat: ChatProvider
  let embeddings: EmbeddingProvider
  try {
    chat = deps.buildChat(config)
    embeddings = deps.buildEmbeddings(config)
  } catch (err) {
    return { ok: false, kind: 'provider', message: errorMessage(err) }
  }

  try {
    const engine = await deps.openEngine(config, {
      chat,
      embeddings,
      reflectionModel: config.models.reflection,
      embeddingModel: config.models.embeddings,
    })
    return { ok: true, engine, config, chat }
  } catch (err) {
    return { ok: false, kind: 'config', message: errorMessage(err) }
  }
}
```

Engine-open failures are classified as `kind: 'config'`, not `'provider'`, even though they happen after provider construction succeeded. This is a judgment call the spec leaves open (spec 1.5 says the type needs exactly two kinds but does not say which one an engine-open failure gets). Reasoning: by the time `openEngine` runs, the chat and embedding providers already constructed successfully; what remains that can throw is `ensureMemoryTree`'s filesystem writes, `MemoryIndex.open`'s SQLite open, or `readGraph`'s parse of `graph.jsonl`, none of which are about the chat/embedding provider being unreachable. These are all about the configured `memoryDir` being unusable, the same broad bucket as a bad `config.toml`, so `'config'` is the closer fit of the two available kinds.

Run:

```
pnpm --filter openreverie test -- src/chat.test.ts
```

Expected: all three new tests pass, and the three pre-existing `openCliContext` tests (which only check `.ok` and `.message`, not `.kind`) still pass unchanged.

### Step 3.3 (RED): `mainWith` maps `kind` to exit code 2 or 3

Add to `packages/cli/src/index.test.ts`:

```ts
describe('mainWith exit codes for openCliContext failures', () => {
  it('exits 2 for a config-kind failure', async () => {
    const { deps, output } = testDeps({
      openCliContext: async () => ({ ok: false, kind: 'config', message: 'bad config' }),
    })
    await mainWith(['reflect'], deps)
    expect(output()).toBe('bad config\n')
    expect(process.exitCode).toBe(2)
    process.exitCode = 0
  })

  it('exits 3 for a provider-kind failure', async () => {
    const { deps, output } = testDeps({
      openCliContext: async () => ({ ok: false, kind: 'provider', message: 'bad provider' }),
    })
    await mainWith(['reflect'], deps)
    expect(output()).toBe('bad provider\n')
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })
})
```

Also fix the two earlier fakes in `testDeps()`'s consumers that construct a bare `{ ok: true, ... }` or previously untyped failure literal without `kind`: in Step 1.1's second test (`'still starts the chat REPL...'`), the fake already returns `{ ok: false, kind: 'config', message: 'stop here' }`, so no change is needed there.

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: both new tests fail, since `mainWith` still hardcodes `process.exitCode = 1` for every `openCliContext` failure regardless of `kind`.

### Step 3.4 (GREEN): map `kind` to exit code in `mainWith`

In `packages/cli/src/index.ts`, replace:

```ts
  if (!context.ok) {
    deps.write(`${context.message}\n`)
    process.exitCode = 1
    return
  }
```

with:

```ts
  if (!context.ok) {
    deps.write(`${context.message}\n`)
    process.exitCode = context.kind === 'config' ? 2 : 3
    return
  }
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
pnpm --filter openreverie test
pnpm build
```

Expected: clean throughout.

Falsify: change `context.kind === 'config' ? 2 : 3` to always `3`, rerun `src/index.test.ts`, confirm the "exits 2" test fails. Restore it.

Commit: `feat(cli): map config vs provider context failures to exit codes 2 and 3`

---

## Task 4: `reverie doctor`

Implements spec 1.4 in full, and spec's note under 1.5 that `doctor`'s own exit code is always 1 on any failure, never 2 or 3.

Two documented resolutions of ambiguity in the spec, applied here and stated for the reviewer:

1. **Spec's own doctor failure illustration is internally inconsistent.** Spec 1.4's prose says: "If `.git` does not exist yet, this is reported as `ok` with a note that it is created on first reflect, not as a failure." Spec 1.4's illustrative failure example then shows `memory folder git ..... fail    not a git repository yet (created on first reflect or /bye)` as a `fail` line. These two statements in the same document contradict each other. The illustrative example's own summary line, `2 of 5 checks failed.`, only works arithmetically if exactly two of the five checks fail; the example as literally drawn shows three (`api key`, `memory folder git`, `sqlite index`). This plan follows the explicit prose rule, not the illustration: an absent `.git` is always `ok`. That keeps the "N of 5" arithmetic honest and matches the reasoned rule ("expected state, not a problem") rather than an apparently-copy-pasted illustration.
2. **Commit count command.** Spec 1.4 names `git log --oneline -1` as one of the two read-only git calls for the git-state check, but that command returns only the most recent commit line, not a count, and the ok example's detail text is `(clean, 42 commits)`, which needs an actual count. This plan uses `git rev-list --count HEAD` instead, which is the standard read-only way to get a commit count, and additionally guards the zero-commit case (`.git` exists, nothing committed yet, which `commitMemory` in `packages/memory/src/gitSync.ts` can leave behind when nothing was staged to commit) by treating a failing `rev-list` as "no commits yet" rather than letting it throw.

The doctor line format (`label` padded with a dot leader, then a status word, then a detail) follows spec 1.4's content and column order exactly, but does not reproduce the spec illustration's literal spacing verbatim: the two illustrative examples in the spec pad `config file`/`api key` to 22 characters before the status word and `memory folder`/`memory folder git`/`sqlite index` to 23, which is plainly hand-typed prose, not a machine-generated table. This plan defines one consistent column width (computed below) instead.

### Files
- `packages/cli/src/doctor.ts` (new)
- `packages/cli/src/doctor.test.ts` (new)
- `packages/cli/src/index.ts` (edit)
- `packages/cli/src/index.test.ts` (edit)

### Interfaces

Consumes:
- `resolveApiKey(config: ReverieConfig): string` from `@openreverie/core` (`packages/core/src/config.ts:160`)
- `loadConfig(configPath?: string): Promise<ReverieConfig>` from `@openreverie/core`
- `memoryPaths(root: string): MemoryPaths` from `@openreverie/memory` (`packages/memory/src/paths.ts:23`), specifically `.indexDb`, which is `index.db`, not `index.sqlite` (`paths.ts:35`)
- `MemoryIndex.open(dbPath: string): MemoryIndex` from `@openreverie/memory` (`packages/memory/src/sqlite.ts:72`), synchronous, and `.close(): void` (`sqlite.ts:77`)

Produces:
- `packages/cli/src/doctor.ts`:
  - `export type CheckStatus = 'ok' | 'fail' | 'skip'`
  - `export function formatCheckLine(label: string, status: CheckStatus, detail: string): string`
  - `export interface DoctorDeps { configPath: string; loadConfig: (path: string) => Promise<ReverieConfig>; isDirectory: (path: string) => Promise<boolean>; isFile: (path: string) => Promise<boolean>; probeWritable: (dir: string) => Promise<boolean>; gitStatusPorcelain: (root: string) => Promise<string>; gitCommitCount: (root: string) => Promise<number | undefined>; openIndex: (path: string) => { close(): void }; write: (text: string) => void }`
  - `export async function runDoctor(deps: DoctorDeps): Promise<number>`
  - `export function buildRealDoctorDeps(configPath: string, write: (text: string) => void): DoctorDeps`
- `packages/cli/src/index.ts`: `CliMainDeps` gains `runDoctor: (deps: DoctorDeps) => Promise<number>` and `buildDoctorDeps: (configPath: string, write: (text: string) => void) => DoctorDeps`.

### Step 4.1 (RED): `formatCheckLine`

Create `packages/cli/src/doctor.test.ts` with its first block:

```ts
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { ensureMemoryTree, MemoryIndex, memoryPaths } from '@openreverie/memory'
import { describe, expect, it } from 'vitest'
import { type DoctorDeps, formatCheckLine, runDoctor } from './doctor.js'

describe('formatCheckLine', () => {
  it('pads every label to the same column width with a dot leader', () => {
    expect(formatCheckLine('config file', 'ok', '(/x/config.toml)')).toBe(
      'config file ......... ok   (/x/config.toml)',
    )
    expect(formatCheckLine('api key', 'ok', '(resolved via OPENAI_API_KEY)')).toBe(
      'api key ............. ok   (resolved via OPENAI_API_KEY)',
    )
    expect(formatCheckLine('memory folder', 'ok', '(/x/memory, writable)')).toBe(
      'memory folder ....... ok   (/x/memory, writable)',
    )
    expect(formatCheckLine('memory folder git', 'ok', '(clean, 3 commits)')).toBe(
      'memory folder git ... ok   (clean, 3 commits)',
    )
    expect(formatCheckLine('sqlite index', 'ok', '(present, rebuildable)')).toBe(
      'sqlite index ........ ok   (present, rebuildable)',
    )
  })

  it('pads a fail status to the same width as ok, so details line up', () => {
    expect(formatCheckLine('api key', 'fail', 'not set')).toBe('api key ............. fail not set')
  })

  it('pads a skip status the same way', () => {
    expect(formatCheckLine('api key', 'skip', 'config failed to load')).toBe(
      'api key ............. skip config failed to load',
    )
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/doctor.test.ts
```

Expected failure: module `./doctor.js` does not exist.

### Step 4.2 (GREEN): start `doctor.ts` with `formatCheckLine`

Create `packages/cli/src/doctor.ts`:

```ts
// `reverie doctor`: five independent, read-only checks of whether reverie
// is set up correctly. Never opens a MemoryEngine, never calls
// runMaintenance (so it is never itself a source of git-subprocess side
// effects), never constructs a ChatProvider, never makes a network call,
// and never prints a secret value. See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 1.4.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadConfig, type ReverieConfig, resolveApiKey } from '@openreverie/core'
import { MemoryIndex, memoryPaths } from '@openreverie/memory'

const run = promisify(execFile)

export type CheckStatus = 'ok' | 'fail' | 'skip'

const CHECK_LABEL_WIDTH = 20

export function formatCheckLine(label: string, status: CheckStatus, detail: string): string {
  const dots = '.'.repeat(Math.max(3, CHECK_LABEL_WIDTH - label.length))
  const statusColumn = status.padEnd(5)
  return `${label} ${dots} ${statusColumn}${detail}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
```

Run:

```
pnpm --filter openreverie test -- src/doctor.test.ts
```

Expected: the three `formatCheckLine` tests pass (the import of `runDoctor` and `DoctorDeps` will fail to resolve until Step 4.4, so this run is expected to still fail at the module level; add a `// @ts-expect-error not implemented yet` is not appropriate here since this is a test file, not application code, so instead run only this block in isolation by temporarily commenting out the later `runDoctor`/`DoctorDeps` import line while iterating, or proceed directly to Step 4.3, which needs `runDoctor` next in the same file anyway).

Practically: continue straight to Step 4.3 without a separate isolated run, since `doctor.test.ts` is being built up as one file and the next step adds the missing exports.

Commit: (do not commit yet; the file is not done)

### Step 4.3 (RED): the five checks, `all ok`, and `2 of 5`

Append to `packages/cli/src/doctor.test.ts`:

```ts
function baseConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'm', reflection: 'm', embeddings: 'm' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function allOkDeps(config: ReverieConfig, overrides: Partial<DoctorDeps> = {}): {
  deps: DoctorDeps
  output: () => string
} {
  let output = ''
  const base: DoctorDeps = {
    configPath: '/fake/config.toml',
    loadConfig: async () => config,
    isDirectory: async () => true,
    isFile: async () => true,
    probeWritable: async () => true,
    gitStatusPorcelain: async () => '',
    gitCommitCount: async () => 3,
    openIndex: () => ({ close: () => {} }),
    write: (text: string) => {
      output += text
    },
  }
  return { deps: { ...base, ...overrides }, output: () => output }
}

describe('runDoctor', () => {
  it('reports all five checks ok and exits 0', async () => {
    const config = baseConfig('/fake/memory')
    const { deps, output } = allOkDeps(config)

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(0)
    expect(output()).toBe(
      `reverie doctor

config file ......... ok   (/fake/config.toml)
api key ............. ok   (resolved via OPENAI_API_KEY)
memory folder ....... ok   (/fake/memory, writable)
memory folder git ... ok   (clean, 3 commits)
sqlite index ........ ok   (present, rebuildable)

All checks passed.
`,
    )
  })

  it('reports api key configured directly, not via env, when config.provider.apiKey is set', async () => {
    const config: ReverieConfig = {
      ...baseConfig('/fake/memory'),
      provider: { name: 'openai', apiKey: 'sk-should-never-appear-in-output' },
    }
    const { deps, output } = allOkDeps(config)

    await runDoctor(deps)

    expect(output()).toContain('api key ............. ok   (configured directly in config file)')
  })

  it('skips every downstream check when the config file does not exist', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), { isFile: async () => false })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    const text = output()
    expect(text).toContain('config file ......... fail no config file at /fake/config.toml. Run: reverie setup')
    expect(text).toContain('api key ............. skip config failed to load; cannot resolve a key')
    expect(text).toContain(
      'memory folder ....... skip config failed to load; cannot check the memory folder',
    )
    expect(text).toContain('memory folder git ... skip memory folder check failed; cannot check git state')
    expect(text).toContain('sqlite index ........ skip config failed to load; cannot check the index')
    expect(text).toContain('1 of 5 checks failed.')
  })

  it('reports the real resolveApiKey message and exits 1 when no key resolves, without printing it as ok', async () => {
    const config: ReverieConfig = {
      ...baseConfig('/fake/memory'),
      provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    }
    const originalEnv = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const { deps, output } = allOkDeps(config)
      const exitCode = await runDoctor(deps)
      expect(exitCode).toBe(1)
      expect(output()).toContain(
        'api key ............. fail No API key found. provider.apiKeyEnv names "OPENAI_API_KEY", ' +
          'but that environment variable is not set. Set it, or set provider.apiKey directly in the config file.',
      )
    } finally {
      if (originalEnv !== undefined) process.env.OPENAI_API_KEY = originalEnv
    }
  })

  it('reports the memory folder as not writable without failing the sqlite check, which only needs the path', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      probeWritable: async () => false,
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    const text = output()
    expect(text).toContain('memory folder ....... fail /fake/memory is not writable')
    expect(text).toContain('memory folder git ... skip memory folder check failed; cannot check git state')
  })

  it('reports ok with a note, not fail, when .git does not exist yet', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      isDirectory: async (path: string) => !path.endsWith('.git'),
    })

    const exitCode = await runDoctor(deps)

    expect(output()).toContain('memory folder git ... ok   (created on first reflect or /bye)')
    expect(exitCode).toBe(0)
  })

  it('reports dirty instead of clean when git status has output', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      gitStatusPorcelain: async () => ' M constitution.md\n',
    })

    await runDoctor(deps)

    expect(output()).toContain('memory folder git ... ok   (dirty, 3 commits)')
  })

  it('reports no commits yet, not a thrown error, when the git repo has zero commits', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      gitCommitCount: async () => undefined,
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(0)
    expect(output()).toContain('memory folder git ... ok   (initialized, no commits yet)')
  })

  it('reports the sqlite index missing with the exact remediation message', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      isFile: async (path: string) => !path.endsWith('index.db'),
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    expect(output()).toContain('sqlite index ........ fail index.db missing; run: reverie reindex')
  })

  it('does not call openIndex at all when index.db is missing, so doctor never creates it', async () => {
    let openIndexCalled = false
    const { deps } = allOkDeps(baseConfig('/fake/memory'), {
      isFile: async (path: string) => !path.endsWith('index.db'),
      openIndex: () => {
        openIndexCalled = true
        return { close: () => {} }
      },
    })

    await runDoctor(deps)

    expect(openIndexCalled).toBe(false)
  })

  it('never prints a realistic-looking secret anywhere in its output', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz123456'
    const config: ReverieConfig = {
      ...baseConfig('/fake/memory'),
      provider: { name: 'openai', apiKey: secret },
    }
    const { deps, output } = allOkDeps(config)

    await runDoctor(deps)

    expect(output()).not.toContain(secret)
  })

  it('reproduces the spec's 2-of-5 failure summary arithmetic: api key and sqlite index fail, git absent is ok', async () => {
    delete process.env.OPENAI_API_KEY
    const config = baseConfig('/fake/memory')
    const { deps, output } = allOkDeps(config, {
      isDirectory: async (path: string) => !path.endsWith('.git'),
      isFile: async (path: string) => !path.endsWith('index.db'),
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    expect(output()).toContain('2 of 5 checks failed.')
  })
})

describe('runDoctor against a real filesystem', () => {
  it('never creates index.db as a side effect of checking whether it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-doctor-'))
    try {
      const configPath = join(dir, 'config.toml')
      await writeFile(configPath, 'placeholder, loadConfig is faked below', 'utf8')
      const memoryDir = join(dir, 'memory')
      await ensureMemoryTree(memoryPaths(memoryDir))
      const config = baseConfig(memoryDir)
      let output = ''

      const exitCode = await runDoctor({
        configPath,
        loadConfig: async () => config,
        isDirectory: async (p: string) => {
          try {
            return (await stat(p)).isDirectory()
          } catch {
            return false
          }
        },
        isFile: async (p: string) => {
          try {
            return (await stat(p)).isFile()
          } catch {
            return false
          }
        },
        probeWritable: async () => true,
        gitStatusPorcelain: async () => '',
        gitCommitCount: async () => undefined,
        openIndex: (p: string) => MemoryIndex.open(p),
        write: (text: string) => {
          output += text
        },
      })

      expect(exitCode).toBe(1)
      expect(output).toContain('index.db missing; run: reverie reindex')
      await expect(stat(memoryPaths(memoryDir).indexDb)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/doctor.test.ts
```

Expected failure: `runDoctor` and `DoctorDeps` are not exported yet.

### Step 4.4 (GREEN): `runDoctor` and `DoctorDeps`

Append to `packages/cli/src/doctor.ts`:

```ts
export interface DoctorDeps {
  configPath: string
  loadConfig: (path: string) => Promise<ReverieConfig>
  isDirectory: (path: string) => Promise<boolean>
  isFile: (path: string) => Promise<boolean>
  probeWritable: (dir: string) => Promise<boolean>
  gitStatusPorcelain: (root: string) => Promise<string>
  gitCommitCount: (root: string) => Promise<number | undefined>
  openIndex: (path: string) => { close(): void }
  write: (text: string) => void
}

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const lines: string[] = []
  let failCount = 0

  let config: ReverieConfig | undefined
  const configExists = await deps.isFile(deps.configPath)
  if (!configExists) {
    lines.push(
      formatCheckLine('config file', 'fail', `no config file at ${deps.configPath}. Run: reverie setup`),
    )
    failCount += 1
  } else {
    try {
      config = await deps.loadConfig(deps.configPath)
      lines.push(formatCheckLine('config file', 'ok', `(${deps.configPath})`))
    } catch (err) {
      lines.push(formatCheckLine('config file', 'fail', errorMessage(err)))
      failCount += 1
    }
  }

  if (config === undefined) {
    lines.push(formatCheckLine('api key', 'skip', 'config failed to load; cannot resolve a key'))
  } else {
    try {
      resolveApiKey(config)
      const detail =
        config.provider.apiKey !== undefined
          ? '(configured directly in config file)'
          : `(resolved via ${config.provider.apiKeyEnv})`
      lines.push(formatCheckLine('api key', 'ok', detail))
    } catch (err) {
      lines.push(formatCheckLine('api key', 'fail', errorMessage(err)))
      failCount += 1
    }
  }

  let memoryFolderOk = false
  if (config === undefined) {
    lines.push(
      formatCheckLine('memory folder', 'skip', 'config failed to load; cannot check the memory folder'),
    )
  } else {
    const exists = await deps.isDirectory(config.memoryDir)
    if (!exists) {
      lines.push(
        formatCheckLine('memory folder', 'fail', `${config.memoryDir} does not exist. Run: reverie setup`),
      )
      failCount += 1
    } else {
      const writable = await deps.probeWritable(config.memoryDir)
      if (!writable) {
        lines.push(formatCheckLine('memory folder', 'fail', `${config.memoryDir} is not writable`))
        failCount += 1
      } else {
        memoryFolderOk = true
        lines.push(formatCheckLine('memory folder', 'ok', `(${config.memoryDir}, writable)`))
      }
    }
  }

  if (!memoryFolderOk || config === undefined) {
    lines.push(
      formatCheckLine('memory folder git', 'skip', 'memory folder check failed; cannot check git state'),
    )
  } else {
    const hasGit = await deps.isDirectory(join(config.memoryDir, '.git'))
    if (!hasGit) {
      lines.push(formatCheckLine('memory folder git', 'ok', '(created on first reflect or /bye)'))
    } else {
      const status = await deps.gitStatusPorcelain(config.memoryDir)
      const count = await deps.gitCommitCount(config.memoryDir)
      const detail =
        count === undefined
          ? '(initialized, no commits yet)'
          : `(${status.trim().length === 0 ? 'clean' : 'dirty'}, ${count} commit${count === 1 ? '' : 's'})`
      lines.push(formatCheckLine('memory folder git', 'ok', detail))
    }
  }

  if (config === undefined) {
    lines.push(formatCheckLine('sqlite index', 'skip', 'config failed to load; cannot check the index'))
  } else {
    const indexPath = memoryPaths(config.memoryDir).indexDb
    const exists = await deps.isFile(indexPath)
    if (!exists) {
      lines.push(formatCheckLine('sqlite index', 'fail', 'index.db missing; run: reverie reindex'))
      failCount += 1
    } else {
      try {
        deps.openIndex(indexPath).close()
        lines.push(formatCheckLine('sqlite index', 'ok', '(present, rebuildable)'))
      } catch (err) {
        lines.push(
          formatCheckLine(
            'sqlite index',
            'fail',
            `index.db exists but failed to open: ${errorMessage(err)}`,
          ),
        )
        failCount += 1
      }
    }
  }

  deps.write('reverie doctor\n\n')
  for (const line of lines) deps.write(`${line}\n`)
  deps.write('\n')
  deps.write(failCount === 0 ? 'All checks passed.\n' : `${failCount} of 5 checks failed.\n`)

  return failCount === 0 ? 0 : 1
}

export function buildRealDoctorDeps(configPath: string, write: (text: string) => void): DoctorDeps {
  return {
    configPath,
    loadConfig,
    write,
    isDirectory: async (path: string) => {
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    },
    isFile: async (path: string) => {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    },
    probeWritable: async (dir: string) => {
      const probePath = join(dir, `.reverie-doctor-probe-${randomBytes(4).toString('hex')}`)
      try {
        await writeFile(probePath, 'probe', 'utf8')
        await unlink(probePath)
        return true
      } catch {
        return false
      }
    },
    gitStatusPorcelain: async (root: string) => {
      const { stdout } = await run('git', ['-c', 'gc.auto=0', 'status', '--porcelain'], { cwd: root })
      return stdout
    },
    gitCommitCount: async (root: string) => {
      try {
        const { stdout } = await run('git', ['-c', 'gc.auto=0', 'rev-list', '--count', 'HEAD'], {
          cwd: root,
        })
        return Number.parseInt(stdout.trim(), 10)
      } catch {
        return undefined
      }
    },
    openIndex: (path: string) => MemoryIndex.open(path),
  }
}
```

Run:

```
pnpm --filter openreverie test -- src/doctor.test.ts
```

Expected: every test in the file passes, including the real-filesystem test.

Falsify: swap the order of the `isFile`/`openIndex` calls in the sqlite-index branch above so `deps.openIndex(indexPath)` runs before the `deps.isFile(indexPath)` check, rerun the real-filesystem test, confirm it fails (`stat(...indexDb)` no longer rejects, since `MemoryIndex.open` created the file). Restore the correct order.

Also falsify the git-check resolution specifically: change the `!hasGit` branch to `formatCheckLine('memory folder git', 'fail', 'not a git repository yet (created on first reflect or /bye)')` and `failCount += 1`, rerun the "ok with a note" test and the "2 of 5" test, confirm both fail (the first because it now expects `fail`, the second because failCount would be 3, not 2). Restore the `ok` version.

Commit: `feat(cli): add reverie doctor with five independent checks`

### Step 4.5 (RED): wired into dispatch

Add to `packages/cli/src/index.test.ts`:

```ts
import type { DoctorDeps } from './doctor.js'

describe('mainWith doctor', () => {
  it('calls buildDoctorDeps with the resolved config path and runDoctor with its result, setting exitCode from the return value', async () => {
    let builtWithPath: string | undefined
    const fakeDoctorDeps = {} as DoctorDeps
    const { deps } = testDeps({
      buildDoctorDeps: (configPath: string) => {
        builtWithPath = configPath
        return fakeDoctorDeps
      },
      runDoctor: async (doctorDeps: DoctorDeps) => {
        expect(doctorDeps).toBe(fakeDoctorDeps)
        return 1
      },
    })

    await mainWith(['doctor', '--config', '/custom.toml'], deps)

    expect(builtWithPath).toBe('/custom.toml')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('never opens a full CLI context for doctor', async () => {
    let contextOpened = false
    const { deps } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        throw new Error('should not be called')
      },
      buildDoctorDeps: () => ({}) as DoctorDeps,
      runDoctor: async () => 0,
    })

    await mainWith(['doctor'], deps)

    expect(contextOpened).toBe(false)
    process.exitCode = 0
  })
})
```

Add `buildDoctorDeps` and `runDoctor` throwing stubs to `testDeps()`'s base object:

```ts
    runDoctor: async () => {
      throw new Error('runDoctor should not be called')
    },
    buildDoctorDeps: () => {
      throw new Error('buildDoctorDeps should not be called')
    },
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: `doctor` is not in `KNOWN_SUBCOMMANDS`, so `mainWith(['doctor', ...], deps)` reports an unknown command instead of dispatching to `runDoctor`.

### Step 4.6 (GREEN): wire doctor into `mainWith`

In `packages/cli/src/index.ts`:

Add `'doctor'` to `KNOWN_SUBCOMMANDS`:

```ts
const KNOWN_SUBCOMMANDS = new Set(['setup', 'web', 'read', 'reindex', 'reflect', 'doctor'])
```

Add the import:

```ts
import { buildRealDoctorDeps, type DoctorDeps, runDoctor } from './doctor.js'
```

Add two fields to `CliMainDeps` (after `readVersion: () => string`):

```ts
  readVersion: () => string
  runDoctor: (deps: DoctorDeps) => Promise<number>
  buildDoctorDeps: (configPath: string, write: (text: string) => void) => DoctorDeps
```

Add a `doctor` branch in `mainWith`, right after the `read` branch and before `const colorEnabled = deps.colorEnabled()`:

```ts
  if (subcommand === 'doctor') {
    const doctorDeps = deps.buildDoctorDeps(configPath, deps.write)
    const exitCode = await deps.runDoctor(doctorDeps)
    process.exitCode = exitCode
    return
  }
```

Add to `defaultDeps`:

```ts
  runDoctor,
  buildDoctorDeps: buildRealDoctorDeps,
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
pnpm --filter openreverie test
pnpm build
```

Expected: clean throughout.

Falsify: remove the `doctor` branch, rerun `src/index.test.ts`, confirm both new tests fail (doctor now reports "unknown command"). Restore it.

Commit: `feat(cli): wire reverie doctor into dispatch`

---

## Task 5: `runChat` reports whether it was interrupted; exit code 4

Implements spec 1.5's fourth row: a second Ctrl-C during chat currently exits the same way as any other clean stop; this task makes `mainWith` set `process.exitCode = 4` for that path specifically.

### Files
- `packages/cli/src/chat.ts` (edit)
- `packages/cli/src/chat.test.ts` (edit)
- `packages/cli/src/index.ts` (edit)
- `packages/cli/src/index.test.ts` (edit)

### Interfaces

Produces:
- `packages/cli/src/chat.ts`: `runChat`'s return type changes from `Promise<void>` to `Promise<{ interrupted: boolean }>`.

### Step 5.1 (RED): `runChat` reports interruption

Add to `packages/cli/src/chat.test.ts`, inside `describe('runChat', ...)` (near the two existing double-Ctrl-C tests at "exits without reflecting when a second Ctrl-C arrives idle at the prompt" and "stops streaming and exits without reflecting when a second Ctrl-C arrives mid-response"):

```ts
  it('reports interrupted: true when a second Ctrl-C ends the session idle at the prompt', async () => {
    const chat = new FakeChatProvider([])
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-interrupt-report-'))
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    let onInterrupt: (() => void) | undefined
    const io: ChatIo = {
      question: () => new Promise(() => {}),
      write: () => {},
      onInterrupt: (handler) => {
        onInterrupt = handler
      },
      cancelPending: () => {},
    }

    const resultPromise = runChat({ engine, config: testConfig(dir), chat, io })
    onInterrupt?.()
    onInterrupt?.()
    const result = await resultPromise

    expect(result).toEqual({ interrupted: true })
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('reports interrupted: false on a normal /bye exit', async () => {
    const chat = new FakeChatProvider([{ text: JSON.stringify(emptyReflectionJson('done')), toolCalls: [] }])
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-interrupt-report-bye-'))
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const lines = ['/bye']
    const io: ChatIo = {
      question: async () => lines.shift() ?? '/bye',
      write: () => {},
      onInterrupt: () => {},
      cancelPending: () => {},
    }

    const result = await runChat({ engine, config: testConfig(dir), chat, io })

    expect(result).toEqual({ interrupted: false })
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
```

These two new tests reuse `testConfig`, `fakeDeps`, and `emptyReflectionJson`, which already exist earlier in `chat.test.ts` (confirmed at lines 28-56). If the double-Ctrl-C-while-idle pattern above (constructing `io` with a `question` that never resolves, then calling `onInterrupt` twice) does not match an existing pattern already used by the file's own "exits without reflecting when a second Ctrl-C arrives idle at the prompt" test, read that existing test first and match its exact `io` construction instead of the sketch above, since the exact mechanics of unblocking a pending `question()` matter (see `cancelPending`'s doc comment at `chat.ts:21-27`).

Run:

```
pnpm --filter openreverie test -- src/chat.test.ts
```

Expected failure: `result` is `undefined` in both new tests (`runChat` currently returns `Promise<void>`), so `expect(result).toEqual(...)` fails.

### Step 5.2 (GREEN): change `runChat`'s return type and its four return points

In `packages/cli/src/chat.ts`, change the signature:

```ts
export async function runChat(deps: {
  engine: MemoryEngine
  config: ReverieConfig
  chat: ChatProvider
  io: ChatIo
  toolDeps?: ToolDeps
  colorEnabled?: boolean
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  now?: () => number
}): Promise<{ interrupted: boolean }> {
```

Change the return after the greeting (currently `if (interruptLevel >= 2) { return }`):

```ts
  if (interruptLevel >= 2) {
    return { interrupted: true }
  }
```

Change the return inside the main loop right after `io.question(...)` (currently `if (interruptLevel >= 2) { return }`):

```ts
    if (interruptLevel >= 2) {
      return { interrupted: true }
    }
```

Change the `/bye` branch's `return` (the one after printing "Saved and reflected..." or the reflection-failure message) to:

```ts
      return { interrupted: false }
```

Change the return after turn processing (currently `if (interruptLevel >= 2) { return }`):

```ts
    if (interruptLevel >= 2) {
      return { interrupted: true }
    }
```

Run:

```
pnpm --filter openreverie test -- src/chat.test.ts
```

Expected: the two new tests pass. Every pre-existing test in `chat.test.ts` that calls `runChat(...)` without inspecting its return value still passes unchanged, since ignoring a return value type-checks fine in TypeScript.

### Step 5.3 (RED): `mainWith` sets exit code 4

Add to `packages/cli/src/index.test.ts`:

```ts
describe('mainWith chat interrupt exit code', () => {
  it('sets exitCode 4 when runChat reports interrupted: true', async () => {
    const dir = '/fake/memory'
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: { warnings: [], close: async () => {} } as never,
        config: { memoryDir: dir, safety: { mode: 'companion' } } as never,
        chat: {} as never,
      }),
      runChat: async () => ({ interrupted: true }),
    })

    await mainWith([], deps)

    expect(process.exitCode).toBe(4)
    process.exitCode = 0
  })

  it('leaves exitCode unset (0) when runChat reports interrupted: false', async () => {
    const dir = '/fake/memory'
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: { warnings: [], close: async () => {} } as never,
        config: { memoryDir: dir, safety: { mode: 'companion' } } as never,
        chat: {} as never,
      }),
      runChat: async () => ({ interrupted: false }),
    })

    await mainWith([], deps)

    expect(process.exitCode).toBe(0)
  })
})
```

Update `testDeps()`'s base `runChat` stub from throwing to returning a value, since the two `mainWith --version`/`--help`/etc. tests that reach the chat branch (the bare-`reverie` guard test in Step 1.1) do not currently exercise `runChat`, so a throwing stub is still safe there; but to keep the base object type-correct going forward, change it to:

```ts
    runChat: async () => ({ interrupted: false }),
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: `process.exitCode` stays whatever it was before (likely `0` or `undefined`), not `4`, since `mainWith` does not yet inspect `runChat`'s return value.

### Step 5.4 (GREEN): wire exit code 4

In `packages/cli/src/index.ts`, replace:

```ts
      const io = readlineChatIo()
      const toolDeps = { updateStyle: deps.createStylePersister(config, configPath) }
      try {
        await deps.runChat({ engine, config, chat, io, toolDeps, colorEnabled })
      } finally {
        io.close()
      }
```

with:

```ts
      const io = readlineChatIo()
      const toolDeps = { updateStyle: deps.createStylePersister(config, configPath) }
      try {
        const chatResult = await deps.runChat({ engine, config, chat, io, toolDeps, colorEnabled })
        if (chatResult.interrupted) {
          process.exitCode = 4
        }
      } finally {
        io.close()
      }
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
pnpm --filter openreverie test
pnpm build
```

Expected: clean throughout, including `chat.test.ts` (Step 5.2's change) and the rest of the package.

Falsify: change `if (chatResult.interrupted)` to `if (false)`, rerun `src/index.test.ts`, confirm the "sets exitCode 4" test fails. Restore it.

Commit: `feat(cli): report chat interruption and exit 4 on a second Ctrl-C`

---

## Task 6: Exit code 3 for a live provider failure during reindex, reflect, or chat

Implements the remainder of spec 1.5's third row: "a live provider call fails during chat/reflect/reindex." Today, an exception thrown from `engine.reindexAll()`, `engine.runMaintenance()`, or `deps.runChat(...)` propagates out of `mainWith` to the top-level `.catch()` in `index.ts`'s `isMainModule()` block, which sets `process.exitCode = 1` unconditionally. This task catches it inside `mainWith` instead and sets exit code 3.

### Files
- `packages/cli/src/index.ts` (edit)
- `packages/cli/src/index.test.ts` (edit)

### Step 6.1: RED

Add to `packages/cli/src/index.test.ts`:

```ts
describe('mainWith exit code 3 on a live failure during reindex/reflect/chat', () => {
  it('exits 3 and writes the error message when reindexAll throws', async () => {
    const { deps, output } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: {
          warnings: [],
          reindexAll: async () => {
            throw new Error('embedding provider unreachable')
          },
          close: async () => {},
        } as never,
        config: { memoryDir: '/fake/memory' } as never,
        chat: {} as never,
      }),
    })

    await mainWith(['reindex'], deps)

    expect(output()).toContain('embedding provider unreachable')
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })

  it('exits 3 when runMaintenance throws during reflect', async () => {
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: {
          warnings: [],
          runMaintenance: async () => {
            throw new Error('reflection model unreachable')
          },
          close: async () => {},
        } as never,
        config: { memoryDir: '/fake/memory' } as never,
        chat: {} as never,
      }),
    })

    await mainWith(['reflect'], deps)

    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })

  it('still closes the engine when reindexAll throws', async () => {
    let closed = false
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: {
          warnings: [],
          reindexAll: async () => {
            throw new Error('boom')
          },
          close: async () => {
            closed = true
          },
        } as never,
        config: { memoryDir: '/fake/memory' } as never,
        chat: {} as never,
      }),
    })

    await mainWith(['reindex'], deps)

    expect(closed).toBe(true)
    process.exitCode = 0
  })
})
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
```

Expected failure: `process.exitCode` is left `undefined`/unset by `mainWith` in the first two tests (the thrown error propagates out of `mainWith` entirely, uncaught by the test, which would actually surface as an unhandled rejection failing the test run rather than a clean assertion failure); the third test's `closed` stays `false` too, since the `finally` block's `engine.close()` never runs if the error propagates past `mainWith` before the test can observe it. Confirm this is the actual failure mode by running the suite and reading the reported error.

### Step 6.2: GREEN

In `packages/cli/src/index.ts`, wrap the `reindex`/`reflect`/chat dispatch in a try/catch that sets exit code 3, replacing:

```ts
  try {
    if (subcommand === 'reindex') {
      await engine.reindexAll()
      const count = await deps.countMemoryDocuments(config.memoryDir)
      deps.write(`Reindexed ${count} documents.\n`)
    } else if (subcommand === 'reflect') {
      await engine.runMaintenance()
      printWarnings({ write: deps.write }, engine, colorEnabled)
      deps.write('Reflection is up to date.\n')
    } else {
      const io = readlineChatIo()
      const toolDeps = { updateStyle: deps.createStylePersister(config, configPath) }
      try {
        const chatResult = await deps.runChat({ engine, config, chat, io, toolDeps, colorEnabled })
        if (chatResult.interrupted) {
          process.exitCode = 4
        }
      } finally {
        io.close()
      }
    }
  } finally {
    await engine.close()
  }
```

with:

```ts
  try {
    if (subcommand === 'reindex') {
      await engine.reindexAll()
      const count = await deps.countMemoryDocuments(config.memoryDir)
      deps.write(`Reindexed ${count} documents.\n`)
    } else if (subcommand === 'reflect') {
      await engine.runMaintenance()
      printWarnings({ write: deps.write }, engine, colorEnabled)
      deps.write('Reflection is up to date.\n')
    } else {
      const io = readlineChatIo()
      const toolDeps = { updateStyle: deps.createStylePersister(config, configPath) }
      try {
        const chatResult = await deps.runChat({ engine, config, chat, io, toolDeps, colorEnabled })
        if (chatResult.interrupted) {
          process.exitCode = 4
        }
      } finally {
        io.close()
      }
    }
  } catch (err) {
    deps.write(`${errorMessage(err)}\n`)
    process.exitCode = 3
  } finally {
    await engine.close()
  }
```

Run:

```
pnpm --filter openreverie test -- src/index.test.ts
pnpm --filter openreverie test
pnpm build
```

Expected: clean throughout, and none of the existing successful-path tests in `index.test.ts`, `chat.test.ts`, or `e2e.test.ts` regress, since this only changes behavior on a thrown error.

Falsify: remove the `catch` block (restore the plain `finally`), rerun `src/index.test.ts`, confirm the three new tests fail again (the first two because the thrown error now propagates unhandled instead of being caught, the third because `closed` may still end up `true` via a different path depending on how the test harness handles the rejection, so confirm by checking the actual error output rather than assuming). Restore the `catch` block.

Commit: `feat(cli): exit 3 on a live provider failure during reindex, reflect, or chat`

---

## Task 7: README Usage section

AGENTS.md requires the README's Status section to reflect reality at all times, and this plan adds four new pieces of user-visible surface (`doctor`, `--version`/`version`, `--help`/`help`, `--config`) that `README.md`'s current Usage section (lines 60-69) does not mention.

### Files
- `README.md` (edit)
- `packages/cli/src/release.test.ts` (run only, not edited; confirm its existing `toContain` assertions still pass against the new README text)

### Step 7.1: Update README Usage section

In `README.md`, after the existing `read` bullet (the last of the four bullets under "Usage", ending "...since seeing what is being kept about you should never depend on the network being up."), add:

```markdown
- `doctor`: checks whether reverie is set up correctly (config file, API key, memory folder, its git state, the SQLite index) and prints one line per check. Never prints a secret value, and never opens a full engine or makes a network call.
- `version` (or `--version`/`-v`): prints the installed version and exits.
- `help [command]` (or `--help`/`-h`, or `<command> --help`): prints the command list, or one command's own help.
- `--config <path>`: use a config file at this path instead of `~/.reverie/config.toml`, before or after the subcommand.
```

Run:

```
pnpm --filter openreverie test -- src/release.test.ts
```

Expected: passes unchanged. `release.test.ts`'s assertions are all `toContain` checks against specific substrings already present before this edit (`'local web interface'`, `'reverie web'`, the realm-influence/history-lens/worker-build/8-MiB sentences); this task only adds new text after the existing content, so none of those substrings move or disappear.

Commit: `docs(readme): document doctor, version, help, and --config`

---

## Task 8: `gitSync.ts`, layer 1: `-c gc.auto=0`

Implements spec 2.2. This is the fix for the actual mechanism traced in spec 2.1: `git commit` (and `git add`/`git init` under some conditions) can trigger a detached `git gc --auto` fork whose writes into `.git/objects/pack` are not guaranteed to have finished by the time the awaited `execFile` call resolves, which is what `rm -rf` in `engine.test.ts`'s `afterEach` was observed racing against in the CI failure quoted in spec 2.1.

### Files
- `packages/memory/src/gitSync.ts` (edit)
- `packages/memory/src/gitSync.test.ts` (edit)

### Interfaces

Consumes: nothing new.

Produces: no change to `commitMemory`'s exported signature or behavior. Only the private `git()` helper's constructed argument list changes.

### Step 8.1 (RED): pure `gitArgs` test

Design note, read before implementing: the spec's own testing guidance (2.5) suggests mocking `execFile` and asserting the args array it receives. That approach was evaluated and rejected here for two independent reasons. First, `gitSync.ts` does `import { execFile } from 'node:child_process'` then `const run = promisify(execFile)` once at module load; that capture happens before any test in this file runs, so a runtime patch of `child_process.execFile` made later, inside a test body, is never observed by `gitSync.ts`'s already-bound `run` (ES module named imports are live bindings on the *module*, but `promisify()` itself was already called against whatever `execFile` was at that moment and returns a new function closed over that specific reference, not a live re-lookup). A `vi.mock('node:child_process', ...)` factory sidesteps that specific problem (it replaces the module in the registry before `gitSync.ts` ever resolves its import), but runs into a second, separate problem: Node's real `execFile` carries an internal `util.promisify.custom` implementation that resolves to `{ stdout, stderr }`; a plain mock function does not have that symbol set, so `promisify(mockExecFile)` falls back to generic promisify behavior, which resolves with only the callback's first success argument (`stdout`) as a bare string, not an object. `gitSync.ts`'s own code reads `status.stdout.trim()`, which would then throw on `undefined`, silently breaking `commitMemory` in a way unrelated to what this test is trying to prove. Getting this right requires manually attaching a `[promisify.custom]` implementation to the mock, which is real, working, but fragile machinery to hang a one-line flag check on.

Instead, extract the argument-building logic out of the private `git()` helper into its own small, exported, pure function with no `execFile` involved, and test that directly. This proves spec 2.2's actual requirement (every git invocation gets `-c gc.auto=0` prepended) unconditionally, with no process-mocking risk of a subtly wrong test silently passing, or of the mock itself changing `commitMemory`'s real behavior. `commitMemory`'s existing real-git-subprocess tests in this same file (Step 8.3 below) already cover the end-to-end path.

Add to `packages/memory/src/gitSync.test.ts`, a new top-level `describe` block (after the existing `describe('commitMemory', ...)` block):

```ts
import { gitArgs } from './gitSync.js'

describe('gitArgs', () => {
  it('prepends -c gc.auto=0 before the given subcommand and its arguments', () => {
    expect(gitArgs(['status', '--porcelain'])).toEqual(['-c', 'gc.auto=0', 'status', '--porcelain'])
  })

  it('prepends the same flag for a bare single-word subcommand', () => {
    expect(gitArgs(['init', '-q'])).toEqual(['-c', 'gc.auto=0', 'init', '-q'])
  })
})
```

Run:

```
pnpm --filter @openreverie/memory test -- src/gitSync.test.ts
```

Expected failure: `gitArgs` is not exported from `./gitSync.js`.

### Step 8.2 (GREEN): extract and use `gitArgs`

In `packages/memory/src/gitSync.ts`, add the exported pure function and use it in the existing private `git()` helper:

```ts
// Every git invocation this module makes gets -c gc.auto=0, so that
// git commit (and git add/git init under some conditions) never triggers
// a detached `git gc --auto` fork. That fork's own writes into
// .git/objects/pack are not guaranteed to have finished by the time the
// awaited execFile call resolves, which is the actual mechanism behind
// an ENOTEMPTY race against a test's own `rm -rf` on the same directory
// right after engine.close(). See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 2.2. Extracted as its own pure function so the flag's presence
// is directly testable without mocking child_process.
export function gitArgs(args: string[]): string[] {
  return ['-c', 'gc.auto=0', ...args]
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', gitArgs(args), { cwd: root })
}
```

Run:

```
pnpm --filter @openreverie/memory test -- src/gitSync.test.ts
```

Expected: both new `gitArgs` tests pass, and every pre-existing test in `commitMemory`'s own `describe` block still passes unchanged, since `commitMemory`'s observable behavior (what gets committed, when, with what message, `CommitResult`'s shape) is untouched: `gc.auto=0` only suppresses opportunistic housekeeping, never the commit itself.

Falsify: change `gitArgs` to `return [...args]` (drop the flag), rerun, confirm both new tests fail. Restore it.

### Step 8.3: Real-process confirmation (not a new automated test)

Run the full `commitMemory` suite once to confirm the flag does not change observable git behavior end to end:

```
pnpm --filter @openreverie/memory test -- src/gitSync.test.ts
```

Expected: all tests pass, including the pre-existing "initializes a repo and makes the first commit" and "is ok when a second call has nothing new to commit" tests, which exercise real git subprocesses in a real `mkdtemp` sandbox and would fail if `-c gc.auto=0` broke anything about how `git init`/`add`/`status`/`commit` behave.

Then the full package suite and build:

```
pnpm --filter @openreverie/memory test
pnpm build
```

Expected: clean.

Commit: `fix(memory): pass -c gc.auto=0 on every git invocation to stop detached gc forks`

---

## Task 9: `engine.test.ts`, layer 2: retry the recursive `rm` in `afterEach`

Implements spec 2.3. This is a mitigation, not a proof of fix; Task 9's own commit message and this task's final note say so plainly, matching spec 2.5's honesty requirement.

### Files
- `packages/memory/src/engine.test.ts` (edit)

### Interfaces

Produces (test-file-local, not exported from `src/`, since no shared test-utils module exists yet in this package):
- `rmWithRetry(path: string, attempts?: number, delayMs?: number): Promise<void>`, defined once near the top of `engine.test.ts`.

### Step 9.1 (RED): the retry helper's own tests

Add near the top of `packages/memory/src/engine.test.ts`, after the existing imports and before the first `describe` block:

```ts
async function rmWithRetry(path: string, attempts = 3, delayMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

describe('rmWithRetry', () => {
  it('retries after ENOTEMPTY and eventually succeeds', async () => {
    let calls = 0
    const original = rm
    const fakeRm = vi.fn(async (path: string, options: unknown) => {
      calls += 1
      if (calls < 3) {
        const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException
        err.code = 'ENOTEMPTY'
        throw err
      }
      return original(path, options as never)
    })
    // This test exercises the retry loop's own logic directly against a
    // fake, not against the real rm re-imported under a different name,
    // since engine.test.ts already imports rm from node:fs/promises at
    // module scope; redefine a local retry loop bound to the fake here so
    // the assertion is about the algorithm, not about patching a live
    // binding mid-file.
    async function retryWithFake(path: string, attempts = 3, delayMs = 1): Promise<void> {
      for (let i = 0; i < attempts; i++) {
        try {
          await fakeRm(path, { recursive: true, force: true })
          return
        } catch (err) {
          if (i === attempts - 1) throw err
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    await retryWithFake('/fake/path', 3, 1)

    expect(calls).toBe(3)
  })

  it('re-throws after exhausting every attempt instead of swallowing a persistent failure', async () => {
    let calls = 0
    const fakeRm = vi.fn(async () => {
      calls += 1
      const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException
      err.code = 'ENOTEMPTY'
      throw err
    })
    async function retryWithFake(path: string, attempts = 3, delayMs = 1): Promise<void> {
      for (let i = 0; i < attempts; i++) {
        try {
          await fakeRm(path, { recursive: true, force: true })
          return
        } catch (err) {
          if (i === attempts - 1) throw err
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    await expect(retryWithFake('/fake/path', 3, 1)).rejects.toThrow('ENOTEMPTY')
    expect(calls).toBe(3)
  })
})
```

Run:

```
pnpm --filter @openreverie/memory test -- src/engine.test.ts
```

Expected: since `rmWithRetry` itself and the two new tests are added together in this step (there is no meaningful red state for a helper whose logic is written correctly the first time; the red/green discipline here is expressed through the falsification check below instead), run this immediately and confirm both new tests pass, then falsify: change `retryWithFake`'s two `if (i === attempts - 1) throw err` lines to `if (false) throw err`, rerun, confirm the first test's `calls` count changes (it will attempt more than 3 times before eventually resolving differently, or hang differently) and the second test's `rejects.toThrow` assertion fails since the loop no longer rethrows. Restore both.

### Step 9.2: Apply `rmWithRetry` to the file's `afterEach`/cleanup sites

Grep-confirmed exact occurrences in `packages/memory/src/engine.test.ts` before this step: 22 total lines matching `recursive: true, force: true`. Of these, 19 are the exact text `await rm(dir, { recursive: true, force: true })`, one is `await rm(forgetDir, { recursive: true, force: true })` (inside the `describe('forget', ...)` block's own `afterEach`), and two are `await rm(join(paths.root, '.git'), { recursive: true, force: true })` (both inside `describe('runMaintenance warnings', ...)`'s `it` blocks, at the lines that deliberately corrupt `.git` mid-test to force a `commitMemory` failure, not cleanup calls). Confirm this count first:

```
grep -c "rm(dir, { recursive: true, force: true })" packages/memory/src/engine.test.ts
grep -c "rm(forgetDir, { recursive: true, force: true })" packages/memory/src/engine.test.ts
grep -c "rm(join(paths.root, '.git'), { recursive: true, force: true })" packages/memory/src/engine.test.ts
```

Expected: `19`, `1`, `2`.

Replace all 19 occurrences of `await rm(dir, { recursive: true, force: true })` with `await rmWithRetry(dir)` using a single find-and-replace across the file (every occurrence is inside an `afterEach`, following an `await engine.close()` earlier in the same describe block, per spec 2.3's scope: "every other afterEach/finally in this file... that does a bare rm right after closing an engine that had maintenance enabled"). Then separately replace the one `await rm(forgetDir, { recursive: true, force: true })` with `await rmWithRetry(forgetDir)`. Do not touch the two `rm(join(paths.root, '.git'), ...)` lines: those are mid-test git corruption, not cleanup, and are out of scope.

Run:

```
grep -c "rmWithRetry(dir)" packages/memory/src/engine.test.ts
grep -c "rmWithRetry(forgetDir)" packages/memory/src/engine.test.ts
grep -c "rm(dir, { recursive: true, force: true })" packages/memory/src/engine.test.ts
```

Expected: `19`, `1`, `0` (the last confirms every generic `rm(dir, ...)` call site was replaced, none left behind).

Run the full file:

```
pnpm --filter @openreverie/memory test -- src/engine.test.ts
```

Expected: all tests still pass (this is a pure refactor of cleanup code; no test's own assertions changed).

Then the full package suite, lint, and build:

```
pnpm --filter @openreverie/memory test
pnpm lint
pnpm build
```

Expected: clean throughout.

Falsify: temporarily revert one `rmWithRetry(dir)` call back to the bare `rm(dir, { recursive: true, force: true })` in the exact describe block that contains the originally-failing test ("caps recentSummaries at three, keeping the three most recent and dropping the oldest", spec 2.1), rerun that one file a handful of times locally, and confirm no observable behavior change under normal conditions (this cannot prove or disprove the race locally; it only confirms the refactor did not break anything). Restore the retry call.

Commit: `test(memory): retry the recursive rm in engine.test.ts's afterEach after a git gc race`

---

## Task 10: Final verification and honest closing note on Part 2

No new code. This task exists to run the full gate exactly the way CI does, and to write down, in one place, what Part 2 does and does not prove, per spec's testing plan and AGENTS.md's review-practice requirement that a reviewer runs the suite itself rather than trusting a report.

### Step 10.1: Full gate, in CI's exact order

```
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test
```

Expected: all four succeed, matching `.github/workflows/ci.yml`'s four `run` steps exactly (`packages/*` install via the workspace, `biome check .`, `tsc -b --force && pnpm --filter @openreverie/web exec vite build`, `vitest run --passWithNoTests` across the workspace).

### Step 10.2: Repeat the full test run a few times

```
pnpm test
pnpm test
pnpm test
```

Expected: `616 + (new tests added by this plan)` passing, zero failing, on every run. Record the exact pass count from the first of these three runs and confirm it matches on the second and third.

### Step 10.3: Write down what this proves and what it does not

This is the honesty check spec 2.5 requires explicitly. State plainly, in the PR description or commit body for this task (not as new source code):

- A clean local run, repeated several times, shows the specific interleaving that failed once in CI (spec 2.1's quoted `ENOTEMPTY` failure) did not reproduce. That is weaker than proving it cannot reproduce: `fs.rm` racing an external process writing into the same tree is a general hazard, and layer 1 (Task 8) narrows the known cause without a way to prove it eliminated from a local run.
- Layer 1 (`-c gc.auto=0`) is the layer that plausibly closes the actual mechanism traced in spec 2.1 step 5 (a detached `git gc --auto` fork outliving the awaited `execFile` call). Layer 2 (Task 9's retry) is a cushion for the same class of hazard from any other source, not a fix for a diagnosed cause.
- Real confidence beyond this task comes from watching CI itself over the next several pushes to `main` for a recurrence of this exact `ENOTEMPTY` failure, or its absence, not from this task's local runs alone.
- The deeper option evaluated and explicitly deferred by the spec (an injectable git-sync dependency on `EngineDeps`, removing all 82-of-87 real git subprocess spawns from `engine.test.ts` entirely) is out of scope for this plan. It is a cross-package interface change (`EngineDeps` is depended on by both `cli` and `server`) with six production call sites in `engine.ts` (lines 520, 807, 882, 982, 1075, 1202) and its own blast radius, and belongs in its own follow-up, not bundled into a flake fix. Nothing in this plan should be read as having done that refactor; if a future task does, it should cite this note rather than assume the flake fix already made it unnecessary.

No commit for this task (nothing to commit beyond what Tasks 8 and 9 already committed); this task's output is the verification record itself, which the human reviewer reads directly rather than trusting a report.

---

## Spec coverage

| Spec section | Task |
|---|---|
| 1.1 dispatch bug | Task 1, Step 1.1-1.2 |
| 1.2 `--version`/`-v`/`version` | Task 1, Step 1.3-1.5 |
| 1.3 `--help`/`-h`/`help`, exact layouts | Task 2 |
| 1.4 `doctor`, five checks | Task 4 |
| 1.5 exit code table, all five rows | Task 1 (row 1), Task 3 (rows 2-3, `openCliContext` path), Task 4 (`doctor`'s own code 1), Task 5 (row 4), Task 6 (row 3, `reindex`/`reflect`/chat path) |
| 1.5 `read.ts`'s 19 `return 1` sites grandfathered | Not touched by any task; `read.ts` is unmodified except for receiving `configPath` through its existing `ReadDeps.loadConfig` closure in Task 1, Step 1.7 |
| 1.6 `--config <path>` | Task 1, Step 1.6-1.7 |
| 1.7 unknown subcommand/flag | Task 1, Step 1.1-1.2 (subcommand), Step 1.6-1.7 (flag) |
| 1.8 hand-rolled parsing | Task 1 throughout; confirmed by `packages/cli/package.json` gaining no new dependency |
| Dependency on `migrate` | Addressed in this document's header ("Depends on") and Task 1's `KNOWN_SUBCOMMANDS`/if-else shape |
| 2.2 `-c gc.auto=0` | Task 8 |
| 2.3 retry `rm` | Task 9 |
| 2.4 injectable git-sync, deferred | Explicitly not implemented; restated in Task 10, Step 10.3 |
| Testing plan, Part 1 | Every RED step across Tasks 1-6 |
| Testing plan, Part 2 honesty requirement | Task 10, Step 10.3 |
| README honesty (AGENTS.md) | Task 7 |

## Judgment calls made in this plan, stated for the reviewer

1. **`memory folder git` is `ok`, never `fail`, when `.git` is absent.** Spec 1.4's prose and its own illustrative failure example contradict each other; the prose's stated reasoning ("expected state, not a problem") and the illustration's own "2 of 5" arithmetic both only work if this is `ok`. See Task 4's header note.
2. **Commit count uses `git rev-list --count HEAD`, not `git log --oneline -1`.** The spec names the second command for the git-state check, but it cannot produce a count; the first can, and is guarded against the zero-commit case. See Task 4's header note.
3. **`formatCheckLine`'s column width is a single consistent value, not the spec illustration's literal (inconsistent) spacing.** See Task 4's header note.
4. **Engine-open failures inside `openCliContext` are tagged `kind: 'config'`, not `'provider'`.** Spec 1.5 requires exactly two kinds and does not say which one this case gets; reasoning given in Task 3, Step 3.2.
5. **`reverie help <unknown>` is a usage error (exit 1, unknown-command message), not a silent fallback to top-level help.** Not specified either way by the spec; Task 2, Step 2.4 states this choice inline.
6. **`reverie <subcommand> --help` reads the subcommand only from `argv[0]`; `reverie --help <subcommand>` (flag first) always shows top-level help, not per-subcommand help.** Stated as a deliberate simplification of hand-rolled parsing in Task 2, Step 2.4.

## Note on task granularity

Each task above is sized to leave the codebase compiling and every existing test passing at its end (confirmed by a `pnpm build` and either a full-package or full-workspace `pnpm test` at the close of every task that touches a shared type: `CliMainDeps`, `CliContextResult`, `runChat`'s return type, `DoctorDeps`). Steps within a task are the 2-5 minute unit: one red assertion, one run that shows the real failure, one minimal implementation, one run that shows the pass, one falsification check, one commit.
