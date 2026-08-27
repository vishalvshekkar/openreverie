// resolveStaticDir locates the web interface's built assets at runtime. It
// has two layouts to find them in: the monorepo, where `@openreverie/web`
// is a real workspace package resolvable through node_modules, and a
// published, bundled install of the `openreverie` CLI, where the web
// assets are copied to a `web` directory sitting next to the running
// bundle and there is no `@openreverie/web` package to resolve at all.
// See packages/cli/scripts/bundle.mjs for the copy step that produces the
// second layout.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveStaticDir } from './index.js'

describe('resolveStaticDir', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reverie-static-dir-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('prefers a web/index.html sitting next to the running module, the bundled install layout', async () => {
    const bundledWeb = join(tempDir, 'web')
    await mkdir(bundledWeb)
    await writeFile(join(bundledWeb, 'index.html'), '<!doctype html><title>Reverie</title>')

    const staticDir = await resolveStaticDir(tempDir)

    expect(staticDir).toBe(bundledWeb)
  })

  it('falls back to resolving the @openreverie/web workspace package when no sibling web/ exists, the monorepo layout', async () => {
    // tempDir has no web/index.html, so this must fall through to the
    // require.resolve path. In this monorepo test run, @openreverie/web is
    // a real workspace dependency of @openreverie/server, so it resolves.
    const staticDir = await resolveStaticDir(tempDir)

    const here = dirname(fileURLToPath(import.meta.url))
    expect(staticDir.endsWith(join('web', 'dist'))).toBe(true)
    expect(staticDir).not.toBe(join(here, 'web'))
  })
})

// index.ts is an unrestricted `export *` barrel: anything that reaches
// createFetchApp by importing @openreverie/server also runs this file's
// module-scope code. A module-scope `const nodeRequire =
// createRequire(import.meta.url)` used to run right there, and in a
// Workers-style bundle import.meta.url is undefined, so createRequire threw
// while the module was still being evaluated: the isolate never started,
// for any caller, even one that only wanted the transport-agnostic core and
// would never call resolveStaticDir. A plain `import` test against this
// file cannot catch that: vite supplies a real import.meta.url in this test
// environment the same way Node does, so createRequire(import.meta.url)
// never throws here either way. What distinguishes the fix is *when*
// createRequire runs, not whether it eventually succeeds, so these tests
// spy on node:module's own createRequire and assert on call timing instead.
describe('module-scope safety: importing this file does not evaluate createRequire', () => {
  let createRequireSpy: ReturnType<typeof vi.fn>
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reverie-module-scope-'))
    vi.resetModules()
    createRequireSpy = vi.fn(createRequire)
    vi.doMock('node:module', () => ({ createRequire: createRequireSpy }))
  })

  afterEach(async () => {
    vi.doUnmock('node:module')
    vi.resetModules()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('is not called merely by importing the module', async () => {
    await import('./index.js')
    expect(createRequireSpy).not.toHaveBeenCalled()
  })

  it('is called once resolveStaticDir actually needs it, and reused on a second call', async () => {
    const fresh = await import('./index.js')
    // tempDir has no web/index.html, forcing the require.resolve path that
    // is nodeRequire's one caller.
    await fresh.resolveStaticDir(tempDir)
    expect(createRequireSpy).toHaveBeenCalledTimes(1)
    await fresh.resolveStaticDir(tempDir)
    expect(createRequireSpy).toHaveBeenCalledTimes(1)
  })
})
