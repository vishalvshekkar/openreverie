// resolveStaticDir locates the web interface's built assets at runtime. It
// has three layouts to find them in: the monorepo, where `@openreverie/web`
// is a real workspace package resolvable through node_modules; a
// published, bundled install of the `openreverie` CLI, where the web
// assets are copied to a `web` directory sitting next to the running
// bundle and there is no `@openreverie/web` package to resolve at all; and
// a published `@openreverie/server` on its own, where `@openreverie/web`
// is an optional peer dependency that a consumer may not have installed.
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

// @openreverie/web is now an optional peer of @openreverie/server (see
// packages/server/package.json), so a consumer who runs the Node
// static-serving path without installing it hits require.resolve's
// MODULE_NOT_FOUND. These tests mock node:module the same way the
// module-scope suite below does, since there is no way to make the real,
// installed @openreverie/web workspace package disappear mid test run.
describe('resolveStaticDir when @openreverie/web is not installed', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reverie-static-dir-missing-peer-'))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.doUnmock('node:module')
    vi.resetModules()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('names @openreverie/web and how to fix it, rather than a raw MODULE_NOT_FOUND', async () => {
    vi.doMock('node:module', () => ({
      createRequire: () => {
        const fakeRequire = (() => {
          throw new Error('unexpected direct require() call in test')
        }) as unknown as NodeRequire
        fakeRequire.resolve = (() => {
          const error = new Error("Cannot find module '@openreverie/web/package.json'")
          ;(error as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND'
          throw error
        }) as unknown as NodeRequire['resolve']
        return fakeRequire
      },
    }))
    const fresh = await import('./index.js')

    await expect(fresh.resolveStaticDir(tempDir)).rejects.toThrow(
      'Web interface assets were not found: @openreverie/web is not installed. ' +
        'Install @openreverie/web alongside @openreverie/server to serve the local web interface, ' +
        'or use the published openreverie CLI, which ships the web assets already.',
    )
  })

  it('does not swallow or reinterpret a resolve failure that is not MODULE_NOT_FOUND', async () => {
    vi.doMock('node:module', () => ({
      createRequire: () => {
        const fakeRequire = (() => {
          throw new Error('unexpected direct require() call in test')
        }) as unknown as NodeRequire
        fakeRequire.resolve = (() => {
          const error = new Error('EACCES: permission denied resolving @openreverie/web')
          ;(error as NodeJS.ErrnoException).code = 'EACCES'
          throw error
        }) as unknown as NodeRequire['resolve']
        return fakeRequire
      },
    }))
    const fresh = await import('./index.js')

    await expect(fresh.resolveStaticDir(tempDir)).rejects.toThrow(
      'EACCES: permission denied resolving @openreverie/web',
    )
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
