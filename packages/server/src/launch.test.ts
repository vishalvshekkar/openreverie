import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import type { MemoryEngine } from '@openreverie/memory'
import type { ChatProvider, EmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type RecordEngine } from './app.js'
import { createBootstrapAuth } from './auth.js'
import { createServerLauncher, type ServerLaunchDeps } from './launch.js'

class FakeEngine implements RecordEngine {
  async listPublicDocuments() {
    return []
  }
  async getPublicDocument() {
    return null
  }
  async listStoredSessions() {
    return []
  }
  async readTranscriptPage() {
    return []
  }
  graphSnapshot() {
    return { nodes: [], edges: [] }
  }
  async readGraphHistory() {
    return []
  }
  docIdForPath() {
    return undefined
  }
  async listPendingProposals() {
    return []
  }
  async resolveProposal() {}
  async close() {}
}

function config(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'chat', reflection: 'reflection', embeddings: 'embeddings' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

async function request(origin: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, { headers })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

describe('createServerLauncher', () => {
  let dir: string
  let staticDir: string
  let engine: FakeEngine
  let deps: ServerLaunchDeps

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-launch-'))
    staticDir = join(dir, 'web')
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Reverie</title>')
    await writeFile(join(staticDir, 'app.js'), 'console.log("reverie")')
    engine = new FakeEngine()
    const chatFactory = vi.fn<(_: unknown) => ChatProvider>(() => {
      throw new Error('the API key is unavailable')
    })
    const embeddingFactory = vi.fn<(_: unknown) => EmbeddingProvider>(() => {
      throw new Error('the API key is unavailable')
    })
    deps = {
      loadConfig: vi.fn(async () => config(dir)),
      resolveApiKey: vi.fn(() => {
        throw new Error('missing key')
      }),
      createChat: chatFactory,
      createEmbeddings: embeddingFactory,
      openEngine: vi.fn(async () => engine as never as MemoryEngine),
      resolveStaticDir: vi.fn(async () => staticDir),
      assertStaticDirectory: vi.fn(async () => {}),
      createHttpServer: createServer,
      listen: async (server, host, port) => {
        await new Promise<void>((resolve) => server.listen(port, host, resolve))
        return (server.address() as { port: number }).port
      },
      closeHttpServer: async (server) => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      },
      createAuth: vi.fn((options) =>
        createBootstrapAuth({
          ...options,
          randomBytes: () => Buffer.alloc(32, 7),
        }),
      ),
      createRegistry: vi.fn(() => ({
        close: vi.fn(async () => {}),
        liveSessions: () => [],
      })) as never,
      createApp: vi.fn(createApp),
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('composes provider-free reads, static assets, and a local bootstrap origin', async () => {
    const lines: string[] = []
    const opened: string[] = []
    const launchServer = createServerLauncher(deps)

    const running = await launchServer({
      write: lines.push.bind(lines),
      port: 0,
      configPath: 'test.toml',
      openBrowser: async (url) => {
        opened.push(url)
      },
    })

    expect(running.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(running.bootstrapUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    expect(lines).toEqual([`Web interface: ${running.origin}`, `Open: ${running.bootstrapUrl}`])
    expect(opened).toEqual([running.bootstrapUrl])
    expect(deps.loadConfig).toHaveBeenCalledWith('test.toml')
    expect(deps.resolveApiKey).toHaveBeenCalledWith(config(dir))
    expect(deps.openEngine).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ chat: expect.anything(), embeddings: expect.anything() }),
      { maintenance: false },
    )
    expect(deps.createChat).not.toHaveBeenCalled()
    expect(deps.createEmbeddings).not.toHaveBeenCalled()
    expect(deps.resolveStaticDir).toHaveBeenCalledOnce()
    expect(deps.assertStaticDirectory).toHaveBeenCalledWith(staticDir)
    expect(deps.createAuth).toHaveBeenCalledWith(
      expect.objectContaining({ origin: running.origin }),
    )
    expect(deps.createRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ providerAvailable: false, engine, chat: expect.anything() }),
    )
    expect(deps.createApp).toHaveBeenCalledWith(
      expect.objectContaining({ engine, staticDir, origin: running.origin }),
    )

    const token = new URL(running.bootstrapUrl).searchParams.get('token')
    expect(token).not.toBeNull()

    const exchanged = await fetch(`${running.origin}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { host: new URL(running.origin).host, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
    expect(exchanged.status).toBe(200)
    expect(
      await request(running.origin, '/api/v1/documents', {
        host: new URL(running.origin).host,
        cookie: cookie ?? '',
      }),
    ).toMatchObject({ status: 200 })
    expect(await request(running.origin, '/library')).toMatchObject({
      status: 200,
      text: '<!doctype html><title>Reverie</title>',
    })
    expect((await request(running.origin, '/app.js')).headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(await request(running.origin, '/missing.js')).toMatchObject({ status: 404 })
    expect(await request(running.origin, '/api/missing')).toMatchObject({ status: 404 })

    await running.close()
  })
})
