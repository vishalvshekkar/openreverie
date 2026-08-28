import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import type {
  DreamStatus,
  MemoryEngine,
  MemoryPaths,
  Profile,
  ProfileSettingsPatch,
  StyleConfig,
} from '@openreverie/memory'
import { DEFAULT_STYLE, memoryPaths, nodeStores } from '@openreverie/memory'
import type { ChatProvider, EmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type RecordEngine } from './app.js'
import { createBootstrapAuth } from './auth.js'
import { createServerLauncher, type ServerLaunchDeps } from './launch.js'

class FakeEngine implements RecordEngine {
  // No test in this file exercises dream detail's feedback-verdict merge
  // (that is app.test.ts's job); this only needs to satisfy
  // RecordEngine.memoryPaths with a real MemoryPaths, built over the same
  // temp directory beforeEach already creates for the engine's config.
  constructor(readonly memoryPaths: MemoryPaths) {}

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

  profileState: Profile = { meta: { id: 'profile_fake' }, body: '' }

  profile(): Profile {
    return this.profileState
  }

  currentStyle(): StyleConfig {
    return DEFAULT_STYLE
  }

  async updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile> {
    this.profileState = {
      meta: { ...this.profileState.meta },
      body: patch.prose ?? this.profileState.body,
    }
    return this.profileState
  }

  async listDreams() {
    return []
  }

  async readDream() {
    return null
  }

  async recordDreamFeedback() {
    return false
  }

  async dreamStatus(): Promise<DreamStatus> {
    return {
      configured: false,
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: false, onStart: false, serverTimer: false },
      model: undefined,
      timezone: 'UTC',
      period: '2026-08-25',
      periodCovered: false,
      reflectedSessionCount: 0,
      minReflectedSessions: 5,
      reflectedFloorMet: false,
      due: false,
    }
  }

  maybeDream = vi.fn(async (_trigger: string) => undefined)
}

function config(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'chat', reflection: 'reflection', embeddings: 'embeddings' },
    safety: { mode: 'companion', resources: [] },
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
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
    engine = new FakeEngine(memoryPaths(dir, nodeStores()))
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

  it('does not serve files through static-directory symlinks that escape the asset directory', async () => {
    const outsideDir = join(dir, 'outside')
    const secret = 'outside bytes must never be served'
    await mkdir(outsideDir)
    await writeFile(join(outsideDir, 'secret.js'), secret)
    await symlink(join(outsideDir, 'secret.js'), join(staticDir, 'escape.js'))
    await symlink(outsideDir, join(staticDir, 'escape-dir'))

    const running = await createServerLauncher(deps)({ write: () => {} })

    for (const path of ['/escape.js', '/escape-dir/secret.js']) {
      const response = await request(running.origin, path)
      expect(response.status).toBe(404)
      expect(response.text).not.toContain(secret)
    }

    await rm(join(staticDir, 'index.html'))
    await symlink(join(outsideDir, 'secret.js'), join(staticDir, 'index.html'))
    const indexResponse = await request(running.origin, '/library')
    expect(indexResponse.status).toBe(404)
    expect(indexResponse.text).not.toContain(secret)

    await running.close()
  })

  it('still closes the HTTP server and engine when the registry close rejects', async () => {
    const registryError = new Error('registry close failed')
    const registryClose = vi.fn(async () => {
      throw registryError
    })
    const closeHttpServer = vi.fn(deps.closeHttpServer)
    const engineClose = vi.spyOn(engine, 'close')
    deps.closeHttpServer = closeHttpServer
    deps.createRegistry = vi.fn(() => ({
      close: registryClose,
      liveSessions: () => [],
    })) as never

    const running = await createServerLauncher(deps)({ write: () => {} })

    await expect(running.close()).rejects.toBe(registryError)
    expect(registryClose).toHaveBeenCalledOnce()
    expect(closeHttpServer).toHaveBeenCalledOnce()
    expect(engineClose).toHaveBeenCalledOnce()
  })

  it('still closes the engine when HTTP server close rejects', async () => {
    const serverError = new Error('HTTP server close failed')
    const registryClose = vi.fn(async () => {})
    const originalCloseHttpServer = deps.closeHttpServer
    const closeHttpServer = vi.fn(async (server) => {
      await originalCloseHttpServer(server)
      throw serverError
    })
    const engineClose = vi.spyOn(engine, 'close')
    deps.closeHttpServer = closeHttpServer
    deps.createRegistry = vi.fn(() => ({
      close: registryClose,
      liveSessions: () => [],
    })) as never

    const running = await createServerLauncher(deps)({ write: () => {} })

    await expect(running.close()).rejects.toBe(serverError)
    expect(registryClose).toHaveBeenCalledOnce()
    expect(closeHttpServer).toHaveBeenCalledOnce()
    expect(engineClose).toHaveBeenCalledOnce()
  })

  it('attempts every resource close exactly once when the engine close rejects', async () => {
    const engineError = new Error('engine close failed')
    const registryClose = vi.fn(async () => {})
    const closeHttpServer = vi.fn(deps.closeHttpServer)
    const engineClose = vi.spyOn(engine, 'close').mockRejectedValue(engineError)
    deps.closeHttpServer = closeHttpServer
    deps.createRegistry = vi.fn(() => ({
      close: registryClose,
      liveSessions: () => [],
    })) as never

    const running = await createServerLauncher(deps)({ write: () => {} })

    await expect(running.close()).rejects.toBe(engineError)
    expect(registryClose).toHaveBeenCalledOnce()
    expect(closeHttpServer).toHaveBeenCalledOnce()
    expect(engineClose).toHaveBeenCalledOnce()
  })

  // The server-timer gate in launch.ts (config.dreaming.enabled &&
  // config.dreaming.triggers.serverTimer) is the only place that enforces an
  // operator's choice to keep unsolicited dreaming off. These three cases
  // check the actual argument createRegistry was called with, not
  // expect.objectContaining, since objectContaining ignores a key's absence
  // and would pass whether or not the gate exists at all.
  it('passes a dreamTrigger to createRegistry when dreaming is enabled and the server timer trigger is on', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      dreaming: {
        enabled: true,
        cadence: 'daily' as const,
        triggers: { afterSession: true, onStart: true, serverTimer: true },
        maxToolCalls: 10,
      },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    const calls = (deps.createRegistry as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const call = calls[0]?.[0] as { dreamTrigger?: () => Promise<unknown> }
    expect(typeof call.dreamTrigger).toBe('function')
  })

  it('passes no dreamTrigger to createRegistry when dreaming is disabled entirely', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      dreaming: {
        enabled: false,
        cadence: 'daily' as const,
        triggers: { afterSession: true, onStart: true, serverTimer: true },
        maxToolCalls: 10,
      },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    const calls = (deps.createRegistry as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const call = calls[0]?.[0] as object
    expect(Object.hasOwn(call, 'dreamTrigger')).toBe(false)
  })

  it('passes no dreamTrigger to createRegistry when dreaming is enabled but the server timer trigger is off', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      dreaming: {
        enabled: true,
        cadence: 'daily' as const,
        triggers: { afterSession: true, onStart: true, serverTimer: false },
        maxToolCalls: 10,
      },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    const calls = (deps.createRegistry as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const call = calls[0]?.[0] as object
    expect(Object.hasOwn(call, 'dreamTrigger')).toBe(false)
  })

  // ServerLaunchOptions.persona: the host-supplyable prompt blocks that let
  // a self-hosted operator whose box does not match
  // DEFAULT_DEPLOYMENT_CONTEXT's claim override it, threaded into both the
  // dream persona (EngineDeps.dreamPersona) and every live chat session
  // (LiveSessionRegistryOptions.persona) this launcher creates.
  it('threads options.persona into both the dream persona and the registry', async () => {
    const launchServer = createServerLauncher(deps)

    await launchServer({
      write: () => {},
      persona: { deploymentContext: 'A hosted deployment claim, launch-level.' },
    })

    const engineCalls = (deps.openEngine as ReturnType<typeof vi.fn>).mock.calls
    expect(engineCalls).toHaveLength(1)
    const engineDeps = engineCalls[0]?.[1] as {
      dreamPersona?: (style: StyleConfig) => string
    }
    expect(typeof engineDeps.dreamPersona).toBe('function')
    const dreamPersonaText = engineDeps.dreamPersona?.(DEFAULT_STYLE) ?? ''
    expect(dreamPersonaText).toContain('A hosted deployment claim, launch-level.')

    const registryCalls = (deps.createRegistry as ReturnType<typeof vi.fn>).mock.calls
    expect(registryCalls).toHaveLength(1)
    const registryOptions = registryCalls[0]?.[0] as { persona?: { deploymentContext?: string } }
    expect(registryOptions.persona).toEqual({
      deploymentContext: 'A hosted deployment claim, launch-level.',
    })
  })

  it('omitting options.persona keeps the default deployment claim in the dream persona', async () => {
    const launchServer = createServerLauncher(deps)

    await launchServer({ write: () => {} })

    const engineCalls = (deps.openEngine as ReturnType<typeof vi.fn>).mock.calls
    expect(engineCalls).toHaveLength(1)
    const engineDeps = engineCalls[0]?.[1] as {
      dreamPersona?: (style: StyleConfig) => string
    }
    const dreamPersonaText = engineDeps.dreamPersona?.(DEFAULT_STYLE) ?? ''
    expect(dreamPersonaText).toContain("You run entirely on the user's own machine")
  })

  // Defect 4, 2026-08-25 dreaming investigation: `reverie web` opens its
  // engine with { maintenance: false }, which also skips MemoryEngine's
  // own onStart dream trigger, so the web server used to have no early
  // dream attempt at all: only the registry's 30-minute sweep, which a
  // person who starts and stops the server repeatedly may never reach.
  // launchServer must fire one maybeDream('serverTimer') itself, right
  // after the engine opens, gated by the same enabled && serverTimer
  // condition as the registry's own dreamTrigger wiring.
  it('fires one maybeDream immediately on launch when dreaming is enabled and the server timer trigger is on', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      dreaming: {
        enabled: true,
        cadence: 'daily' as const,
        triggers: { afterSession: true, onStart: true, serverTimer: true },
        maxToolCalls: 10,
      },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    expect(engine.maybeDream).toHaveBeenCalledWith('serverTimer')
  })

  it('does not fire an immediate maybeDream when dreaming is disabled entirely', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      dreaming: {
        enabled: false,
        cadence: 'daily' as const,
        triggers: { afterSession: true, onStart: true, serverTimer: true },
        maxToolCalls: 10,
      },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    expect(engine.maybeDream).not.toHaveBeenCalled()
  })

  // Defect 1, 2026-08-25 dreaming investigation: dreamingModel used to fall
  // back to config.models.reflection, which is exactly how one real user's
  // dreaming broke permanently (dreaming runs a tool loop; a reasoning-
  // effort reflection model rejects function tools with an HTTP 400). It
  // must resolve through resolveDreamingModel, which falls back to
  // models.chat instead.
  it('resolves dreamingModel via resolveDreamingModel, never falling back to models.reflection', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      models: { chat: 'chat-model', reflection: 'reflection-model', embeddings: 'embeddings' },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    const calls = (deps.openEngine as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const engineDeps = calls[0]?.[1] as { dreamingModel?: string }
    expect(engineDeps.dreamingModel).toBe('chat-model')
    expect(engineDeps.dreamingModel).not.toBe('reflection-model')
  })

  it('does not fire an immediate maybeDream when the server timer trigger is off, even though dreaming is enabled', async () => {
    deps.loadConfig = vi.fn(async () => ({
      ...config(dir),
      dreaming: {
        enabled: true,
        cadence: 'daily' as const,
        triggers: { afterSession: true, onStart: true, serverTimer: false },
        maxToolCalls: 10,
      },
    }))

    await createServerLauncher(deps)({ write: () => {} })

    expect(engine.maybeDream).not.toHaveBeenCalled()
  })
})
