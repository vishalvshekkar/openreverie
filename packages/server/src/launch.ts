import type { RequestListener, Server } from 'node:http'
import type { ReverieConfig } from '@openreverie/core'
import type { EngineDeps, MemoryEngine } from '@openreverie/memory'
import {
  type ChatEvent,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type EmbeddingProvider,
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

  async embed(_model: string, _texts: string[]): Promise<number[][]> {
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
      registry = deps.createRegistry({
        engine,
        config,
        chat: providers.chat,
        providerAvailable: providers.available,
        ...(options.now ? { now: options.now } : {}),
      })
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
