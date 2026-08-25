// The terminal chat REPL: renders AgentEvents as they stream in, and the
// small pieces of CLI orchestration (loading config, building providers,
// opening the engine) that index.ts wires to real implementations and this
// file's tests wire to fakes. Keeps index.ts thin, per the project's rule
// that the bin entry is just wiring.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { AgentSession, buildPersona } from '@openreverie/core'
import type { EngineDeps, MemoryEngine } from '@openreverie/memory'
import { listDocuments, memoryPaths, readDocument } from '@openreverie/memory'
import type { ChatProvider, EmbeddingProvider } from '@openreverie/providers'
import { cyan, dim, magenta } from './colors.js'
import { type CommandContext, commandModeSelect, parseInput, runCommand } from './commands.js'
import { createStartupSpinner } from './startup.js'
import { createStatusLine, type StatusLine } from './status.js'
import { formatStripTime, renderStatusStrip } from './strip.js'

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
  set_mode: 'switching mode',
  search_memory: 'searching memory',
  read_document: 'reading memory',
  read_transcript: 'reading memory',
  graph_query: 'checking connections',
  list_arcs: 'checking memory',
  list_realms: 'checking memory',
  list_people: 'checking memory',
  list_entities: 'checking memory',
  update_profile: 'updating profile',
  declare_journal_method: 'setting journal method',
  update_journaling_protocol: 'updating journal setup',
  dream_feedback: 'noting your reaction',
}

export function toolNotice(name: string): string {
  const label = TOOL_NOTICES[name]
  return label !== undefined ? `[${label}]` : `[using: ${name}]`
}

// The status line's label for a tool call in flight: the same honest
// wording as toolNotice, but bare, since the status line's own frame and
// dim styling already carry the "this is a transient status" signal that
// toolNotice's brackets exist to provide for the permanent notice line.
function toolStatusLabel(name: string): string {
  return TOOL_NOTICES[name] ?? `using: ${name}`
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
  statusLine: StatusLine,
): Promise<void> {
  let tagged = false
  setResponding(true)
  try {
    for await (const event of session.greet()) {
      if (event.type === 'thinking') {
        statusLine.start('thinking')
      } else if (event.type === 'text') {
        statusLine.stop()
        if (!tagged) {
          io.write(magenta('reverie> ', colorEnabled))
          tagged = true
        }
        io.write(event.text)
      } else if (event.type === 'done' && tagged) {
        statusLine.stop()
        io.write('\n')
      }
      if (interruptLevel() >= 2) {
        break
      }
    }
  } catch {
    // Silent abandon, per the greeting's own degradation rule.
  } finally {
    // Neither the catch above nor a plain abandon (break on the second
    // Ctrl-C) ever emits 'done', so the line can only be relied on to stop
    // here, never by keying off 'done' alone.
    statusLine.stop()
    setResponding(false)
  }
}

export async function runChat(deps: {
  engine: MemoryEngine
  config: ReverieConfig
  chat: ChatProvider
  io: ChatIo
  colorEnabled?: boolean
  interactive?: boolean
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  now?: () => number
}): Promise<{ interrupted: boolean }> {
  const {
    engine,
    config,
    chat,
    io,
    colorEnabled = false,
    interactive = false,
    setInterval: setIntervalDep = (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: clearIntervalDep = (handle: unknown) =>
      clearInterval(handle as Parameters<typeof clearInterval>[0]),
    now = () => Date.now(),
  } = deps

  const statusLine = createStatusLine({
    write: io.write,
    colorEnabled,
    setInterval: setIntervalDep,
    clearInterval: clearIntervalDep,
    now,
  })

  const sessionStartedAt = now()

  io.write(`Memory folder: ${config.memoryDir}. Safety mode: ${config.safety.mode}.\n\n`)

  const session = await AgentSession.start(engine, config, chat)

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
    // Stop the status line before writing anything: otherwise the current
    // frame (e.g. "| thinking") is left stranded in scrollback, with the
    // interrupt message printed right after it instead of on a clean line.
    statusLine.stop()
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
    statusLine,
  )

  if (interruptLevel >= 2) {
    return { interrupted: true }
  }

  const commandContext: CommandContext = {
    io,
    session,
    engine,
    memoryDir: config.memoryDir,
    safetyMode: config.safety.mode,
    printWarnings: () => printWarnings(io, engine, colorEnabled),
  }

  // Printed once, on its own dim line, immediately before each prompt. Not
  // animated and never repainted, which is what gives a fresh value at
  // every turn and right after a mode change without any cursor addressing
  // and without fighting readline.
  //
  // Shown when the terminal is interactive; dimmed only when colour is on.
  // Those are two different conditions: someone who sets NO_COLOR wants no
  // colour, not less information.
  function writeStatusStrip(): void {
    if (!interactive) return
    const meta = engine.profile().meta
    const time = formatStripTime(meta.timezone, new Date(now()))
    const place = meta.timezoneSource === 'user-confirmed' ? meta.location : undefined
    const line = renderStatusStrip({
      mode: session.mode,
      tone: engine.currentStyle().tone,
      ...(place === undefined ? {} : { location: place }),
      ...(time === undefined ? {} : { localTime: time.localTime, zoneAbbrev: time.zoneAbbrev }),
      elapsedMs: now() - sessionStartedAt,
    })
    io.write(`${dim(line, colorEnabled)}\n`)
  }

  // Set when a bare /mode just printed its numbered list and returned
  // 'select-mode': the very next line typed is read as a mode selection,
  // never parsed as a command or sent to the model as chat text. This is
  // read through the same io.question() call as the ordinary prompt below
  // (not a nested question() inside the command itself), which is what
  // keeps the second-Ctrl-C exit contract working here for free: the
  // interruptLevel >= 2 check right after that question() still runs
  // before this state is ever consulted. One exception: EOF (the endOfInput
  // flag below) always bypasses this state and exits, since EOF is not a
  // typed line and has no mode selection to make.
  let modeSelectionPending = false

  for (;;) {
    writeStatusStrip()
    let line: string
    let endOfInput = false
    try {
      line = await io.question(cyan('you> ', colorEnabled))
    } catch {
      // readline closed (EOF): treat exactly like /bye. This is the input
      // stream ending, not the person typing something, so it must exit
      // immediately whatever state the loop is in: a pending mode
      // selection is irrelevant to it. endOfInput is what lets the check
      // below tell an EOF-synthesized '/bye' apart from someone actually
      // typing /bye at the selection prompt (that path is handled by the
      // modeSelectionPending branch on purpose; see commands.ts).
      //
      // modeSelectionPending itself is deliberately left set here, not
      // cleared: this path always falls through to parseInput('/bye') and
      // commandBye, which returns 'exit' on every path (try and catch
      // alike), so runChat returns before another loop iteration could
      // ever consult modeSelectionPending again. Clearing it here would
      // add a second guard that no test could pin independently of the
      // one below.
      line = '/bye'
      endOfInput = true
    }

    if (interruptLevel >= 2) {
      return { interrupted: true }
    }

    if (modeSelectionPending && !endOfInput) {
      modeSelectionPending = false
      await commandModeSelect(line, commandContext)
      continue
    }

    const parsed = parseInput(line)
    if (parsed.kind === 'command') {
      const outcome = await runCommand(parsed.name, parsed.arg, commandContext)
      if (outcome === 'exit') {
        return { interrupted: false }
      }
      if (outcome === 'select-mode') {
        modeSelectionPending = true
      }
      continue
    }
    if (parsed.text === '') {
      continue
    }

    let sawText = false
    let taggedThisTurn = false
    responding = true
    try {
      for await (const event of session.send(parsed.text)) {
        if (event.type === 'thinking') {
          statusLine.start('thinking')
        } else if (event.type === 'text') {
          statusLine.stop()
          sawText = true
          if (!taggedThisTurn) {
            io.write(magenta('reverie> ', colorEnabled))
            taggedThisTurn = true
          }
          io.write(event.text)
        } else if (event.type === 'tool') {
          statusLine.stop()
          io.write(`${dim(toolNotice(event.name), colorEnabled)}\n`)
          statusLine.start(toolStatusLabel(event.name))
        } else if (event.type === 'mode') {
          statusLine.stop()
          io.write(`${dim(`[mode: ${event.mode}]`, colorEnabled)}\n`)
        } else if (event.type === 'done') {
          statusLine.stop()
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
      // This stop() is the one the ordering invariant actually depends on:
      // it clears the frame before the error message below is written, so
      // the message never lands after a stale frame stranded in scrollback.
      // Do not remove it on the assumption that the finally below covers
      // the same guarantee; the finally runs after this whole block,
      // which is too late to protect the write order here.
      statusLine.stop()
      io.write(
        `\nI could not reach the model: ${errorMessage(err)}. Your message is saved; try again, or type /bye.\n`,
      )
    } finally {
      // A backstop, not the ordering guarantor above: this covers the path
      // that exits the loop without ever emitting 'done' and without
      // throwing (a break on the second Ctrl-C mid response), which the
      // catch block above never sees.
      statusLine.stop()
      responding = false
    }

    if (interruptLevel >= 2) {
      return { interrupted: true }
    }
  }
}

// --- CLI command wiring, kept here (not index.ts) so it is testable with
// injected fakes instead of the real filesystem and network. ---

export interface CliEngineDeps {
  loadConfig: () => Promise<ReverieConfig>
  buildChat: (config: ReverieConfig) => ChatProvider
  buildEmbeddings: (config: ReverieConfig) => EmbeddingProvider
  openEngine: (config: ReverieConfig, deps: EngineDeps) => Promise<MemoryEngine>
  // Optional wiring for the decorative startup spinner. When write is
  // absent (or colorEnabled is false) the spinner is a no-op, exactly like
  // the status line: no escape sequence ever reaches a non-TTY stream.
  write?: (text: string) => void
  colorEnabled?: boolean
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export type CliContextResult =
  | { ok: true; engine: MemoryEngine; config: ReverieConfig; chat: ChatProvider }
  | { ok: false; kind: 'config' | 'provider'; message: string }

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
    return { ok: false, kind: 'config', message: errorMessage(err) }
  }

  let chat: ChatProvider
  let embeddings: EmbeddingProvider
  try {
    chat = deps.buildChat(config)
    embeddings = deps.buildEmbeddings(config)
  } catch (err) {
    return { ok: false, kind: 'provider', message: errorMessage(err) }
  }

  // Decorative: a dim spinner cycles startup phrases while the engine's
  // maintenance work runs. Purely cosmetic, not tied to any internal
  // engine phase; it stops the moment openEngine settles either way.
  const spinner =
    deps.write !== undefined
      ? createStartupSpinner({
          write: deps.write,
          colorEnabled: deps.colorEnabled === true,
          setInterval: deps.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
          clearInterval:
            deps.clearInterval ??
            ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0])),
        })
      : undefined

  try {
    if (spinner !== undefined) spinner.start()
    const engine = await deps.openEngine(config, {
      chat,
      embeddings,
      reflectionModel: config.models.reflection,
      embeddingModel: config.models.embeddings,
      dreamingModel: config.models.dreaming ?? config.models.reflection,
      dreaming: config.dreaming,
      dreamPersona: (style) => buildPersona(config.safety.mode, config.safety.resources, style),
    })
    return { ok: true, engine, config, chat }
  } catch (err) {
    return { ok: false, kind: 'config', message: errorMessage(err) }
  } finally {
    spinner?.stop()
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
      const doc = await readDocument(join(paths.sessionsDir, name, 'summary.md'))
      // A skipped summary (no user messages in that session) is never
      // indexed by walkAllDocuments/reindexAll either; counting it here
      // would report a document count higher than what reindex actually
      // indexes, growing by one for every skipped session.
      if (doc.meta.skipped === true) continue
      count += 1
    } catch {
      // No summary.md yet: this session has not been reflected.
    }
  }

  return count
}
