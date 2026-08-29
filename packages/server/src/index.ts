export * from './api.js'
export * from './app.js'
export * from './auth.js'
export * from './launch.js'
export * from './registry.js'

import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveApiKey } from '@openreverie/core'
import { MemoryEngine } from '@openreverie/memory'
import { createChatProvider, createEmbeddingProvider } from '@openreverie/providers'
import { createApp } from './app.js'
import { createBootstrapAuth } from './auth.js'
import { createServerLauncher } from './launch.js'
import { createLiveSessionRegistry } from './registry.js'

// Named nodeRequire, not require: the bundle produced by
// packages/cli/scripts/bundle.mjs injects its own top-level `require`
// binding (via a banner calling createRequire), which esbuild's runtime
// shim for other bundled CommonJS dependencies' own require() calls looks
// up by that exact global name. A second top-level `const require` here
// would collide with it in the bundled output.
//
// Built lazily, on first use, rather than as a module-scope const: this
// whole file is an unrestricted `export *` barrel, so anything that reaches
// createFetchApp by importing @openreverie/server also runs this module's
// top level. import.meta.url is undefined in a Workers-style bundle, and
// createRequire(undefined) throws immediately, which used to kill the
// isolate before any handler ever ran, even for a caller that only wanted
// the transport-agnostic core and would never touch resolveStaticDir at
// all. Deferring construction to the one call site that actually needs it
// means a host with no import.meta.url never pays for it.
let cachedRequire: NodeRequire | undefined
function nodeRequire(): NodeRequire {
  if (!cachedRequire) cachedRequire = createRequire(import.meta.url)
  return cachedRequire
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

// Finds the web interface's built assets. There are three layouts to find
// them in, and only a positive check on the first tells them apart:
//
// - The published, bundled `openreverie` CLI: `packages/cli/scripts/
//   bundle.mjs` copies the built web assets to a `web` directory sitting
//   right next to the running bundle (`dist/index.js`, so `dist/web`).
//   There is no `@openreverie/web` npm package in this layout at all, so
//   resolving it would throw, not just miss.
// - The monorepo, running from source or from `tsc -b` output: web/'s dist
//   is not copied anywhere, but `@openreverie/web` is a real workspace
//   dependency of `@openreverie/server` and resolves through node_modules.
// - A published `@openreverie/server` installed on its own: `@openreverie/
//   web` is an optional peer dependency (see packages/server/package.json),
//   so a consumer who only wants createFetchApp never has to install a
//   React application to run a Worker. A consumer who does want the Node
//   static-serving path but skipped that install gets a require.resolve
//   MODULE_NOT_FOUND here, which we turn into an error naming the fix.
//
// moduleDir defaults to this file's own directory and is only overridden
// by tests, which need to point it at a temporary directory instead of
// wherever this compiled file happens to live during a test run.
export async function resolveStaticDir(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string> {
  const bundledAssets = join(moduleDir, 'web')
  if (await isFile(join(bundledAssets, 'index.html'))) {
    return bundledAssets
  }
  let webPackage: string
  try {
    webPackage = nodeRequire().resolve('@openreverie/web/package.json')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      throw new Error(
        'Web interface assets were not found: @openreverie/web is not installed. ' +
          'Install @openreverie/web alongside @openreverie/server to serve the local web interface, ' +
          'or use the published openreverie CLI, which ships the web assets already.',
      )
    }
    throw error
  }
  return join(dirname(webPackage), 'dist')
}

async function assertStaticDirectory(directory: string): Promise<void> {
  let details: Stats
  try {
    details = await stat(directory)
  } catch {
    throw new Error(`Web interface assets are missing at ${directory}. Run: pnpm build`)
  }
  if (!details.isDirectory()) {
    throw new Error(`Web interface assets are missing at ${directory}. Run: pnpm build`)
  }
  try {
    const index = await stat(join(directory, 'index.html'))
    if (!index.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`Web interface assets are missing at ${directory}. Run: pnpm build`)
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('The web server did not report a local port.'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export const launchServer = createServerLauncher({
  loadConfig,
  resolveApiKey,
  createChat: createChatProvider,
  createEmbeddings: createEmbeddingProvider,
  openEngine: MemoryEngine.open,
  resolveStaticDir,
  assertStaticDirectory,
  createHttpServer: createServer,
  listen,
  closeHttpServer,
  createAuth: (options) => createBootstrapAuth({ ...options, randomBytes }),
  createRegistry: createLiveSessionRegistry,
  createApp,
})
