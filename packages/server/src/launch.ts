import type { RequestListener, Server } from 'node:http'
import {
  buildPersona,
  type PersonaOptions,
  type ReverieConfig,
  resolveDreamingModel,
} from '@openreverie/core'
import { type EngineDeps, type MemoryEngine, systemTimeZone } from '@openreverie/memory'
import {
  type ChatEvent,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type EmbeddingProvider,
  type EmbedResult,
  type ProviderSelection,
  ProviderUnavailableError,
} from '@openreverie/providers'
import type { CreateAppDeps } from './app.js'
import type { AuthDeps, BootstrapAuth } from './auth.js'
import type { LiveSessionRegistry, LiveSessionRegistryOptions } from './registry.js'

export interface ServerLaunchOptions {
  write: (line: string) => void
  configPath?: string
  port?: number
  now?: () => number
  openBrowser?: (url: string) => Promise<void>
  // Host-supplyable prompt blocks. node:http's server genuinely runs on
  // the person's own machine (or a self-hosted box they control), which is
  // why DEFAULT_DEPLOYMENT_CONTEXT's claim is the honest default here and
  // this can be left unset for that case. An operator whose box does not
  // match that claim (a reverse proxy onto someone else's infrastructure,
  // for instance) supplies its own. Threaded into both the dream persona
  // and every live chat session this launcher's registry creates.
  persona?: PersonaOptions
}

export interface RunningServer {
  origin: string
  bootstrapUrl: string
  close(): Promise<void>
}

export interface ServerLaunchDeps {
  loadConfig: (configPath?: string) => Promise<ReverieConfig>
  resolveApiKey: (config: ReverieConfig) => string
  createChat: (selection: ProviderSelection) => ChatProvider
  createEmbeddings: (selection: ProviderSelection) => EmbeddingProvider
  openEngine: (
    root: string,
    deps: EngineDeps,
    options: { maintenance: false },
  ) => Promise<MemoryEngine>
  resolveStaticDir: () => Promise<string>
  assertStaticDirectory: (directory: string) => Promise<void>
  createHttpServer: (listener: RequestListener) => Server
  listen: (server: Server, host: string, port: number) => Promise<number>
  closeHttpServer: (server: Server) => Promise<void>
  createAuth: (deps: Omit<AuthDeps, 'randomBytes'>) => { token: string; auth: BootstrapAuth }
  createRegistry: (options: LiveSessionRegistryOptions) => LiveSessionRegistry
  createApp: (deps: CreateAppDeps) => RequestListener
}

class UnavailableChatProvider implements ChatProvider {
  readonly name = 'unavailable'

  async complete(_request: ChatRequest): Promise<ChatResult> {
    throw new ProviderUnavailableError()
  }

  stream(_request: ChatRequest): AsyncIterable<ChatEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
        return {
          next: async () => {
            throw new ProviderUnavailableError()
          },
        }
      },
    }
  }
}

class UnavailableEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'unavailable'

  // Return type only, to satisfy EmbeddingProvider after providers'
  // P0-4 usage change (2026-08-27): this always throws, so nothing about
  // the resolved value actually changes.
  async embed(_model: string, _texts: string[]): Promise<EmbedResult> {
    throw new ProviderUnavailableError()
  }
}

function tryConfiguredProviders(
  deps: Pick<ServerLaunchDeps, 'resolveApiKey' | 'createChat' | 'createEmbeddings'>,
  config: ReverieConfig,
): { chat: ChatProvider; embeddings: EmbeddingProvider; available: true } | undefined {
  try {
    const apiKey = deps.resolveApiKey(config)
    const selection: ProviderSelection =
      config.provider.baseUrl === undefined
        ? { provider: config.provider.name, apiKey }
        : { provider: config.provider.name, apiKey, baseUrl: config.provider.baseUrl }
    return {
      chat: deps.createChat(selection),
      embeddings: deps.createEmbeddings(selection),
      available: true,
    }
  } catch {
    return undefined
  }
}

export function createServerLauncher(deps: ServerLaunchDeps) {
  return async function launchServer(options: ServerLaunchOptions): Promise<RunningServer> {
    const config = await deps.loadConfig(options.configPath)
    const persona = options.persona ?? {}
    const providers = tryConfiguredProviders(deps, config) ?? {
      chat: new UnavailableChatProvider(),
      embeddings: new UnavailableEmbeddingProvider(),
      available: false as const,
    }
    const engine = await deps.openEngine(
      config.memoryDir,
      {
        chat: providers.chat,
        embeddings: providers.embeddings,
        reflectionModel: config.models.reflection,
        embeddingModel: config.models.embeddings,
        dreamingModel: resolveDreamingModel(config),
        dreaming: config.dreaming,
        dreamPersona: (style) =>
          buildPersona(
            config.safety.mode,
            config.safety.resources,
            style,
            undefined,
            undefined,
            persona,
          ),
        // node:http's server genuinely runs on the person's own machine
        // (or a self-hosted box they control), so the system zone is the
        // honest default here. A host with no ambient zone (a Cloudflare
        // Durable Object) never launches through this function; it builds
        // an EngineDeps.timezone itself. See EngineDeps.timezone's own
        // comment.
        timezone: systemTimeZone(),
      },
      { maintenance: false },
    )

    let server: Server | undefined
    let registry: LiveSessionRegistry | undefined
    try {
      const staticDir = await deps.resolveStaticDir()
      await deps.assertStaticDirectory(staticDir)
      let listener: RequestListener = (_request, response) => {
        response.statusCode = 503
        response.end()
      }
      server = deps.createHttpServer((request, response) => listener(request, response))
      const port = await deps.listen(server, '127.0.0.1', options.port ?? 0)
      const origin = `http://127.0.0.1:${port}`
      const { token, auth } = deps.createAuth({ origin, now: options.now ?? Date.now })
      // The same condition that decides whether the registry's own 30
      // minute sweep is wired up at all: dreaming enabled, and the
      // serverTimer trigger specifically on.
      const serverTimerDreamingOn = config.dreaming.enabled && config.dreaming.triggers.serverTimer
      registry = deps.createRegistry({
        engine,
        config,
        chat: providers.chat,
        providerAvailable: providers.available,
        persona,
        ...(options.now ? { now: options.now } : {}),
        ...(serverTimerDreamingOn ? { dreamTrigger: () => engine.maybeDream('serverTimer') } : {}),
      })
      // Defect 4, 2026-08-25 dreaming investigation: `reverie web` opens
      // its engine with { maintenance: false }, which also gates off
      // MemoryEngine.open()'s own onStart dream trigger (Ruling A4), so
      // the web server used to have no early dream trigger at all. The
      // only trigger was this registry's own 30 minute sweep, and a
      // person who starts and stops the server repeatedly (exactly what
      // the reporting user did) can go a long time without ever reaching
      // that mark. Firing one attempt immediately, right after the engine
      // opens, gives the web server the same "try once at startup"
      // posture the CLI and chat REPL already have via onStart, while
      // still keeping the 30 minute interval for a server that stays up.
      // No new guards needed here: maybeDream's own dreamAttemptedPeriods
      // set (added under the lock, after acquireDreamLock succeeds, see
      // engine.ts) and the under-lock periodCovered recheck already make
      // an extra concurrent call safe, so this immediate kick cannot
      // double-dream against the interval sweep that follows it.
      if (serverTimerDreamingOn) {
        void engine.maybeDream('serverTimer').catch(() => {})
      }
      listener = deps.createApp({ engine, config, auth, registry, staticDir, origin })
      const bootstrapUrl = `${origin}/?token=${token}`
      options.write(`Web interface: ${origin}`)
      options.write(`Open: ${bootstrapUrl}`)
      await options.openBrowser?.(bootstrapUrl)

      let closePromise: Promise<void> | undefined
      return {
        origin,
        bootstrapUrl,
        close: () => {
          closePromise ??= closeServerResources(deps, registry, server as Server, engine)
          return closePromise
        },
      }
    } catch (error) {
      try {
        await closeServerResources(deps, registry, server, engine)
      } catch {
        // Preserve the original startup failure after attempting every cleanup.
      }
      throw error
    }
  }
}

async function closeServerResources(
  deps: Pick<ServerLaunchDeps, 'closeHttpServer'>,
  registry: LiveSessionRegistry | undefined,
  server: Server | undefined,
  engine: MemoryEngine,
): Promise<void> {
  let firstError: unknown
  let hasError = false
  const attempt = async (close: () => Promise<void>): Promise<void> => {
    try {
      await close()
    } catch (error) {
      if (!hasError) {
        firstError = error
        hasError = true
      }
    }
  }

  await attempt(async () => registry?.close())
  if (server) await attempt(() => deps.closeHttpServer(server))
  await attempt(() => engine.close())

  if (hasError) throw firstError
}
