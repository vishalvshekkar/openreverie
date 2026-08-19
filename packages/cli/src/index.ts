#!/usr/bin/env node
// reverie CLI entry point.
//
// Subcommands: `setup` runs the first-run wizard, `reindex` rebuilds the
// SQLite index from the memory folder, `reflect` runs maintenance
// (reflect stale sessions, build pending rollups) on demand, `read` prints
// part of the memory record without touching the network or the provider,
// and the default (no subcommand) starts the chat REPL.
//
// This file is kept thin: it parses argv, wires real implementations
// (readline, loadConfig, the provider factory, MemoryEngine.open) into the
// functions in chat.ts and setup.ts, and prints their results. All the
// actual logic lives in those files, where it is tested with injected io
// and fakes instead of the real filesystem, terminal, and network.

import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import type { ReverieConfig } from '@openreverie/core'
import { defaultConfigPath, loadConfig, resolveApiKey } from '@openreverie/core'
import { MemoryEngine } from '@openreverie/memory'
import type { ProviderSelection } from '@openreverie/providers'
import { createChatProvider, createEmbeddingProvider } from '@openreverie/providers'
import { launchServer } from '@openreverie/server'
import type { ChatIo } from './chat.js'
import { countMemoryDocuments, openCliContext, printWarnings, runChat } from './chat.js'
import { buildRealDoctorDeps, type DoctorDeps, runDoctor } from './doctor.js'
import { subcommandHelp, TOP_LEVEL_HELP } from './help.js'
import { runMigrate } from './migrate.js'
import { runRead } from './read.js'
import { runSetup } from './setup.js'
import { readOwnVersion } from './version.js'
import { runWebCommand } from './web.js'

const KNOWN_SUBCOMMANDS = new Set([
  'setup',
  'web',
  'read',
  'migrate',
  'reindex',
  'reflect',
  'doctor',
])

// Colors are read from real process state exactly once, here at the edge:
// disabled when stdout is not a TTY (piped, redirected, or captured by a
// test harness) or when NO_COLOR is set, per the NO_COLOR convention. Every
// function downstream of this takes the resulting boolean explicitly
// rather than sniffing process state itself.
function colorsEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function providerSelection(config: ReverieConfig): ProviderSelection {
  const apiKey = resolveApiKey(config)
  return config.provider.baseUrl === undefined
    ? { provider: config.provider.name, apiKey }
    : { provider: config.provider.name, apiKey, baseUrl: config.provider.baseUrl }
}

const stdout = { write: (text: string) => process.stdout.write(text) }

function readlineChatIo(): ChatIo & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let onInterrupt: (() => void) | undefined
  // Tracks the AbortController for whatever question() call is currently
  // pending, so cancelPending() (called by chat.ts on the second Ctrl-C)
  // has something to abort. Firing the 'SIGINT' event does not by itself
  // settle a pending rl.question() in Node; only aborting its signal does.
  let pendingController: AbortController | undefined
  rl.on('SIGINT', () => onInterrupt?.())
  return {
    question: (prompt: string) => {
      const controller = new AbortController()
      pendingController = controller
      return rl.question(prompt, { signal: controller.signal }).finally(() => {
        if (pendingController === controller) {
          pendingController = undefined
        }
      })
    },
    write: (text: string) => process.stdout.write(text),
    onInterrupt: (handler: () => void) => {
      onInterrupt = handler
    },
    cancelPending: () => {
      pendingController?.abort()
    },
    close: () => rl.close(),
  }
}

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

export interface CliMainDeps {
  runWeb: typeof runWebCommand
  launchServer: typeof launchServer
  runRead: typeof runRead
  runMigrate: typeof runMigrate
  runSetupCommand: (configPath: string) => Promise<void>
  openCliContext: typeof openCliContext
  buildChat: (config: ReverieConfig) => ReturnType<typeof createChatProvider>
  buildEmbeddings: (config: ReverieConfig) => ReturnType<typeof createEmbeddingProvider>
  openEngine: typeof MemoryEngine.open
  countMemoryDocuments: typeof countMemoryDocuments
  runChat: typeof runChat
  loadConfig: (path: string) => Promise<ReverieConfig>
  configPath: string
  write: (text: string) => void
  colorEnabled: () => boolean
  readVersion: () => string
  runDoctor: (deps: DoctorDeps) => Promise<number>
  buildDoctorDeps: (configPath: string, write: (text: string) => void) => DoctorDeps
}

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

export async function mainWith(args: string[], deps: CliMainDeps): Promise<void> {
  if (args.includes('--version') || args.includes('-v') || args[0] === 'version') {
    deps.write(`${deps.readVersion()}\n`)
    process.exitCode = 0
    return
  }

  if (args[0] === 'help') {
    const topic = args[1]
    if (topic === undefined) {
      deps.write(TOP_LEVEL_HELP)
      process.exitCode = 0
      return
    }
    const text = subcommandHelp(topic)
    if (text === undefined) {
      deps.write(
        `reverie: unknown command '${topic}'\nRun 'reverie --help' for a list of commands.\n`,
      )
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
    deps.write(
      `reverie: unknown option '${unknownFlag}'\nRun 'reverie --help' for a list of options.\n`,
    )
    process.exitCode = 1
    return
  }

  const subcommand = rest[0]
  if (subcommand !== undefined && !KNOWN_SUBCOMMANDS.has(subcommand)) {
    deps.write(
      `reverie: unknown command '${subcommand}'\nRun 'reverie --help' for a list of commands.\n`,
    )
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

  if (subcommand === 'migrate') {
    const exitCode = await deps.runMigrate(args.slice(1), {
      loadConfig: () => deps.loadConfig(configPath),
      configPath: deps.configPath,
      write: deps.write,
    })
    process.exitCode = exitCode
    return
  }

  if (subcommand === 'doctor') {
    const doctorDeps = deps.buildDoctorDeps(configPath, deps.write)
    const exitCode = await deps.runDoctor(doctorDeps)
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
    process.exitCode = context.kind === 'config' ? 2 : 3
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
      try {
        const chatResult = await deps.runChat({ engine, config, chat, io, colorEnabled })
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
}

const defaultDeps: CliMainDeps = {
  runWeb: runWebCommand,
  launchServer,
  runRead,
  runMigrate,
  runSetupCommand,
  openCliContext,
  buildChat: (config) => createChatProvider(providerSelection(config)),
  buildEmbeddings: (config) => createEmbeddingProvider(providerSelection(config)),
  openEngine: MemoryEngine.open,
  countMemoryDocuments,
  runChat,
  loadConfig,
  configPath: defaultConfigPath(),
  write: (text) => process.stdout.write(text),
  colorEnabled: colorsEnabled,
  readVersion: readOwnVersion,
  runDoctor,
  buildDoctorDeps: buildRealDoctorDeps,
}

// The entry guard compares the real path of the invoked script with this
// file's own real path. A plain string comparison breaks when the CLI is run
// through a symlink (npm link, a global install, or a user's own `reverie`
// link): process.argv[1] then holds the symlink path while import.meta.url
// holds the resolved file, so the guard never fires and the command exits
// without doing anything.
function isMainModule(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url)
  }
}

if (isMainModule()) {
  mainWith(process.argv.slice(2), defaultDeps).catch((err: unknown) => {
    stdout.write(`${errorMessage(err)}\n`)
    process.exitCode = 1
  })
}
