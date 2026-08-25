// resolveStaticDir locates the web interface's built assets at runtime. It
// has two layouts to find them in: the monorepo, where `@openreverie/web`
// is a real workspace package resolvable through node_modules, and a
// published, bundled install of the `openreverie` CLI, where the web
// assets are copied to a `web` directory sitting next to the running
// bundle and there is no `@openreverie/web` package to resolve at all.
// See packages/cli/scripts/bundle.mjs for the copy step that produces the
// second layout.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
