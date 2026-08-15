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
import { loadConfig, resolveApiKey } from '@openreverie/core'
import { MemoryEngine } from '@openreverie/memory'
import { createChatProvider, createEmbeddingProvider } from '@openreverie/providers'
import { createApp } from './app.js'
import { createBootstrapAuth } from './auth.js'
import { createServerLauncher } from './launch.js'
import { createLiveSessionRegistry } from './registry.js'

const require = createRequire(import.meta.url)

async function resolveStaticDir(): Promise<string> {
  const webPackage = require.resolve('@openreverie/web/package.json')
  return join(dirname(webPackage), 'dist')
}

async function assertStaticDirectory(directory: string): Promise<void> {
  let details: Stats
  try {
    details = await stat(directory)
  } catch {
    throw new Error(
      `Web interface assets are missing at ${directory}. Run: pnpm --filter @openreverie/web build`,
    )
  }
  if (!details.isDirectory()) {
    throw new Error(
      `Web interface assets are missing at ${directory}. Run: pnpm --filter @openreverie/web build`,
    )
  }
  try {
    const index = await stat(join(directory, 'index.html'))
    if (!index.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(
      `Web interface assets are missing at ${directory}. Run: pnpm --filter @openreverie/web build`,
    )
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
