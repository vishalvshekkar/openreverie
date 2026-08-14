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

import { createInterface } from 'node:readline/promises'
import type { ReverieConfig } from '@openreverie/core'
import { defaultConfigPath, loadConfig, resolveApiKey } from '@openreverie/core'
import { MemoryEngine } from '@openreverie/memory'
import type { ProviderSelection } from '@openreverie/providers'
import { createChatProvider, createEmbeddingProvider } from '@openreverie/providers'
import type { ChatIo } from './chat.js'
import {
  countMemoryDocuments,
  createStylePersister,
  openCliContext,
  printWarnings,
  runChat,
} from './chat.js'
import { runRead } from './read.js'
import { runSetup } from './setup.js'

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

async function runSetupCommand(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await runSetup({
      question: (prompt: string) => rl.question(prompt),
      write: (text: string) => process.stdout.write(text),
    })
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const subcommand = process.argv[2]

  if (subcommand === 'setup') {
    await runSetupCommand()
    return
  }

  if (subcommand === 'read') {
    const exitCode = await runRead(process.argv.slice(3), {
      loadConfig: () => loadConfig(defaultConfigPath()),
      write: (text: string) => process.stdout.write(text),
      colorEnabled: colorsEnabled(),
    })
    process.exitCode = exitCode
    return
  }

  const colorEnabled = colorsEnabled()
  const configPath = defaultConfigPath()

  const context = await openCliContext({
    loadConfig: () => loadConfig(configPath),
    buildChat: (config) => createChatProvider(providerSelection(config)),
    buildEmbeddings: (config) => createEmbeddingProvider(providerSelection(config)),
    openEngine: (config, deps) => MemoryEngine.open(config.memoryDir, deps),
  })

  if (!context.ok) {
    stdout.write(`${context.message}\n`)
    process.exitCode = 1
    return
  }

  const { engine, config, chat } = context
  printWarnings(stdout, engine, colorEnabled)

  try {
    if (subcommand === 'reindex') {
      await engine.reindexAll()
      const count = await countMemoryDocuments(config.memoryDir)
      stdout.write(`Reindexed ${count} documents.\n`)
    } else if (subcommand === 'reflect') {
      await engine.runMaintenance()
      printWarnings(stdout, engine, colorEnabled)
      stdout.write('Reflection is up to date.\n')
    } else {
      const io = readlineChatIo()
      const toolDeps = { updateStyle: createStylePersister(config, configPath) }
      try {
        await runChat({ engine, config, chat, io, toolDeps, colorEnabled })
      } finally {
        io.close()
      }
    }
  } finally {
    await engine.close()
  }
}

main().catch((err: unknown) => {
  stdout.write(`${errorMessage(err)}\n`)
  process.exitCode = 1
})
