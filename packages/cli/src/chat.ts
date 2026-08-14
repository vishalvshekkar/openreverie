// The terminal chat REPL: renders AgentEvents as they stream in, and the
// small pieces of CLI orchestration (loading config, building providers,
// opening the engine) that index.ts wires to real implementations and this
// file's tests wire to fakes. Keeps index.ts thin, per the project's rule
// that the bin entry is just wiring.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReverieConfig, StyleConfig, ToolDeps } from '@openreverie/core'
import { AgentSession, saveConfig } from '@openreverie/core'
import type { EngineDeps, MemoryEngine } from '@openreverie/memory'
import { listDocuments, memoryPaths, readDocument } from '@openreverie/memory'
import type { ChatProvider, EmbeddingProvider } from '@openreverie/providers'
import { cyan, dim, magenta } from './colors.js'

export interface ChatIo {
  question(prompt: string): Promise<string>
  write(text: string): void
  onInterrupt(handler: () => void): void
  // Unblocks whatever question() call is currently pending, the way a real
  // terminal's AbortSignal-backed readline question rejects when aborted.
  // Firing the SIGINT event alone does not settle a pending question() in
  // Node (verified against node:readline/promises); this is the hook that
  // actually does, so the second Ctrl-C while idle at the prompt can exit
  // instead of hanging forever on an unresolved question().
  cancelPending(): void
}

// One honest, specific notice per tool, so the person watching the
// terminal knows what reverie is actually doing rather than a generic
// "searching memory" for everything. A tool this list has never heard of
// (a future addition, or a stale build) still gets a plain, truthful
// fallback instead of silence or a crash.
const TOOL_NOTICES: Record<string, string> = {
  remember: 'remembering',
  resolve_proposal: 'updating memory',
  update_style: 'adjusting style',
  search_memory: 'searching memory',
  read_document: 'reading memory',
  read_transcript: 'reading memory',
  graph_query: 'checking connections',
  list_arcs: 'checking memory',
  list_realms: 'checking memory',
}

export function toolNotice(name: string): string {
  const label = TOOL_NOTICES[name]
  return label !== undefined ? `[${label}]` : `[using: ${name}]`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// After any engine operation (open, session end, reindex, reflect), the
// engine may have collected warnings (a document that failed to index, a
// git commit that failed). None of them are fatal; each one is surfaced as
// one dim, plain "note:" line rather than crashing or being swallowed.
export function printWarnings(
  io: { write(text: string): void },
  engine: { readonly warnings: readonly string[] },
  colorEnabled = false,
): void {
  for (const warning of engine.warnings) {
    io.write(`${dim(`note: ${warning}`, colorEnabled)}\n`)
  }
}

const LOST_IN_NOTES_MESSAGE =
  'I got lost in my notes there and did not get to an answer. Ask me again?\n'

// Streams AgentSession.greet() the same way the main loop streams a
// reply: the reverie> tag before the first chunk of text, plain writes
// after that. Error handling deliberately differs from a normal turn:
// any failure inside greet() (a provider error, or its own 20 second
// timeout) is swallowed here without a word, because the greeting was
// never asked for and a visible error about it would be confusing rather
// than honest. A real provider problem still surfaces normally on the
// user's first actual message.
//
// Mirrors the main loop's own interrupt handling, which this needs just
// as much as a real turn does: setResponding(true) around the loop so a
// Ctrl-C that lands mid-greeting prints the "finishing this reply"
// message instead of the idle one (nothing else marks a greeting as a
// response actively streaming), and breaking on interruptLevel() >= 2 so
// a second Ctrl-C actually ends the greeting rather than leaving it
// running for up to 20 seconds after the CLI has already said it
// stopped. Breaking the for-await loop calls .return() on session.greet()
// the same way an abandoned real turn does, which is what persists the
// text already streamed (Task 10) and unwinds the underlying provider
// iterator instead of leaving it parked (the withTimeout fix this task
// also makes).
async function runGreeting(
  session: AgentSession,
  io: ChatIo,
  colorEnabled: boolean,
  interruptLevel: () => number,
  setResponding: (value: boolean) => void,
): Promise<void> {
  let tagged = false
  setResponding(true)
  try {
    for await (const event of session.greet()) {
      if (event.type === 'text') {
        if (!tagged) {
          io.write(magenta('reverie> ', colorEnabled))
          tagged = true
        }
        io.write(event.text)
      } else if (event.type === 'done' && tagged) {
        io.write('\n')
      }
      if (interruptLevel() >= 2) {
        break
      }
    }
  } catch {
    // Silent abandon, per the greeting's own degradation rule.
  } finally {
    setResponding(false)
  }
}

export async function runChat(deps: {
  engine: MemoryEngine
  config: ReverieConfig
  chat: ChatProvider
  io: ChatIo
  toolDeps?: ToolDeps
  colorEnabled?: boolean
}): Promise<void> {
  const { engine, config, chat, io, toolDeps, colorEnabled = false } = deps

  io.write(`Memory folder: ${config.memoryDir}. Safety mode: ${config.safety.mode}.\n\n`)

  const session = await AgentSession.start(engine, config, chat, toolDeps)

  // 0 = no interrupt yet, 1 = one Ctrl-C seen (reminded about /bye), 2+ =
  // a second Ctrl-C seen (exit without reflecting). The handler itself
  // prints its message so the reassurance appears the moment the signal
  // fires, not only once the main loop next checks in. `responding` tracks
  // whether a reply is currently streaming, so the first-press message can
  // say the right thing whether the user interrupts mid-reply or while
  // sitting idle at the prompt.
  let interruptLevel = 0
  let responding = false
  io.onInterrupt(() => {
    interruptLevel += 1
    if (interruptLevel === 1) {
      io.write(
        responding
          ? '\nFinishing this reply. Type /bye when you want to stop; it reflects on the session first.\n'
          : '\nType /bye when you want to stop; it reflects on the session first.\n',
      )
    } else {
      io.write(
        '\nStopping without reflecting. This conversation is already saved and will be reflected the next time reverie starts.\n',
      )
      // Second press: if we are idle, blocked on question(), unblock it now
      // instead of waiting forever for a line of input that may never come.
      io.cancelPending()
    }
  })

  await runGreeting(
    session,
    io,
    colorEnabled,
    () => interruptLevel,
    (value) => {
      responding = value
    },
  )

  if (interruptLevel >= 2) {
    return
  }

  for (;;) {
    let line: string
    try {
      line = await io.question(cyan('you> ', colorEnabled))
    } catch {
      // readline closed (EOF): treat exactly like /bye.
      line = '/bye'
    }

    if (interruptLevel >= 2) {
      return
    }

    const trimmed = line.trim()
    if (trimmed === '/bye') {
      io.write('reflecting on this session...\n')
      await session.end()
      printWarnings(io, engine, colorEnabled)
      io.write('Saved and reflected. See you next time.\n')
      return
    }
    if (trimmed === '') {
      continue
    }

    let sawText = false
    let taggedThisTurn = false
    responding = true
    try {
      for await (const event of session.send(line)) {
        if (event.type === 'text') {
          sawText = true
          if (!taggedThisTurn) {
            io.write(magenta('reverie> ', colorEnabled))
            taggedThisTurn = true
          }
          io.write(event.text)
        } else if (event.type === 'tool') {
          io.write(`${dim(toolNotice(event.name), colorEnabled)}\n`)
        } else if (event.type === 'done') {
          io.write('\n')
          if (!sawText) {
            if (!taggedThisTurn) {
              io.write(magenta('reverie> ', colorEnabled))
              taggedThisTurn = true
            }
            io.write(LOST_IN_NOTES_MESSAGE)
          }
        }
        if (interruptLevel >= 2) {
          break
        }
      }
    } catch (err) {
      io.write(
        `\nI could not reach the model: ${errorMessage(err)}. Your message is saved; try again, or type /bye.\n`,
      )
    } finally {
      responding = false
    }

    if (interruptLevel >= 2) {
      return
    }
  }
}

// Builds the persister the update_style tool needs. Core never knows
// config file paths or how style is saved (that is the point of ToolDeps);
// this is the CLI's one implementation of it. Patches `config.style` in
// place, in the same ReverieConfig object the running session was started
// with, then writes the whole config back to the exact path it was loaded
// from, atomically (saveConfig writes to a temp file and renames over the
// target).
export function createStylePersister(
  config: ReverieConfig,
  configPath: string,
): (patch: Partial<StyleConfig>) => Promise<StyleConfig> {
  return async (patch: Partial<StyleConfig>) => {
    const nextStyle: StyleConfig = { ...config.style, ...patch }
    config.style = nextStyle
    await saveConfig(config, configPath)
    return nextStyle
  }
}

// --- CLI command wiring, kept here (not index.ts) so it is testable with
// injected fakes instead of the real filesystem and network. ---

export interface CliEngineDeps {
  loadConfig: () => Promise<ReverieConfig>
  buildChat: (config: ReverieConfig) => ChatProvider
  buildEmbeddings: (config: ReverieConfig) => EmbeddingProvider
  openEngine: (config: ReverieConfig, deps: EngineDeps) => Promise<MemoryEngine>
}

export type CliContextResult =
  | { ok: true; engine: MemoryEngine; config: ReverieConfig; chat: ChatProvider }
  | { ok: false; message: string }

// Loads config, builds the configured providers, and opens the engine, in
// that order, stopping at the first failure. Every failure (missing
// config, an unsupported provider, an unreachable engine) comes back as
// one plain message instead of a thrown error or a stack trace, so the
// caller can print it and stop rather than half-working.
export async function openCliContext(deps: CliEngineDeps): Promise<CliContextResult> {
  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }

  let chat: ChatProvider
  let embeddings: EmbeddingProvider
  try {
    chat = deps.buildChat(config)
    embeddings = deps.buildEmbeddings(config)
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }

  try {
    const engine = await deps.openEngine(config, {
      chat,
      embeddings,
      reflectionModel: config.models.reflection,
      embeddingModel: config.models.embeddings,
    })
    return { ok: true, engine, config, chat }
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }
}

// Counts every prose document reverie knows about (constitution, realms,
// arcs, people, rollups, and reflected session summaries), by walking the
// memory folder the same way the engine does internally. Used to give the
// `reindex` subcommand a concrete count line instead of a bare "done".
export async function countMemoryDocuments(memoryDir: string): Promise<number> {
  const paths = memoryPaths(memoryDir)
  let count = 1 // constitution.md always exists once the memory tree is set up.
  count += (await listDocuments(paths.realmsDir)).length
  count += (await listDocuments(paths.arcsDir)).length
  count += (await listDocuments(paths.peopleDir)).length
  count += (await listDocuments(paths.rollupsDailyDir)).length
  count += (await listDocuments(paths.rollupsWeeklyDir)).length

  let sessionDirs: string[] = []
  try {
    const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
    sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    sessionDirs = []
  }
  for (const name of sessionDirs) {
    try {
      await readDocument(join(paths.sessionsDir, name, 'summary.md'))
      count += 1
    } catch {
      // No summary.md yet: this session has not been reflected.
    }
  }

  return count
}
