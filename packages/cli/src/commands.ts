// The in-session command parser and dispatch table.
//
// This reads lines typed at the you> prompt inside a running session. It
// is not the argv parser: that one reads process.argv before a session
// exists and lives in index.ts. The two are separate and stay separate.

import type { ModeName } from '@openreverie/core'
import type { Profile, StyleConfig } from '@openreverie/memory'

export type ParsedInput =
  | { kind: 'command'; name: string; arg: string | undefined }
  | { kind: 'text'; text: string }

const COMMAND_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/

export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim()
  if (trimmed.length === 0) return { kind: 'text', text: '' }
  if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed }

  // A leading double slash means the user meant a literal slash. Strip
  // one and send the rest to the model: typing //mode sends /mode.
  if (trimmed.startsWith('//')) return { kind: 'text', text: trimmed.slice(1) }

  const rest = trimmed.slice(1)
  const spaceAt = rest.search(/\s/)
  const token = spaceAt < 0 ? rest : rest.slice(0, spaceAt)
  if (!COMMAND_TOKEN.test(token)) {
    // A pasted path like /usr/local/bin has a slash inside its first
    // token, so it reaches the model unchanged.
    return { kind: 'text', text: trimmed }
  }

  const argument = spaceAt < 0 ? '' : rest.slice(spaceAt).trim()
  return {
    kind: 'command',
    name: token.toLowerCase(),
    arg: argument.length === 0 ? undefined : argument,
  }
}

export interface CommandSession {
  readonly mode: ModeName
  setMode(name: ModeName, options: { source: 'cli' }): Promise<void>
  refreshSystemPrompt(): Promise<void>
  end(): Promise<void>
}

// The real accessor on MemoryEngine is profile(), not currentProfile(). This
// interface is structural: MemoryEngine already satisfies it as written, so
// chat.ts can pass the real engine straight through with no adapter.
export interface CommandEngine {
  profile(): Profile
  currentStyle(): StyleConfig
  updateProfileSettings(patch: { style?: Partial<StyleConfig> }): Promise<Profile>
}

export interface CommandContext {
  io: { write(text: string): void }
  session: CommandSession
  engine: CommandEngine
  memoryDir: string
  safetyMode: 'companion' | 'firewall'
  printWarnings: () => void
}

export type CommandOutcome = 'continue' | 'exit'

export const COMMAND_NAMES = ['help', 'mode', 'style', 'settings', 'whoami', 'bye'] as const

const HELP_LINES = [
  '/help                 this list',
  '/mode [name]          what this conversation is for, for this conversation only',
  '/style [axis value]   how reverie talks with you in general, saved to profile.md',
  '/settings             what is set and where it lives',
  '/whoami               what reverie knows about you',
  '/bye                  reflect on this session and stop',
  '',
  'To send a message that starts with a slash, double it: //mode sends /mode.',
]

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function commandBye(ctx: CommandContext): Promise<CommandOutcome> {
  ctx.io.write('reflecting on this session...\n')
  try {
    await ctx.session.end()
    ctx.printWarnings()
    ctx.io.write('Saved and reflected. See you next time.\n')
  } catch (err) {
    // Any warning the engine accumulated before the throw belongs on
    // screen either way; losing it here would be a silent drop.
    ctx.printWarnings()
    ctx.io.write(
      `\nI could not finish reflecting: ${errorMessage(err)}. Your conversation is saved; ` +
        'it will be reflected the next time reverie starts.\n',
    )
  }
  return 'exit'
}

function commandHelp(ctx: CommandContext): CommandOutcome {
  ctx.io.write(`${HELP_LINES.join('\n')}\n`)
  return 'continue'
}

export async function runCommand(
  name: string,
  arg: string | undefined,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  switch (name) {
    case 'bye':
      return await commandBye(ctx)
    case 'help':
      return commandHelp(ctx)
    default:
      // A typo'd command does not reach the model. Sending it to a
      // companion that then improvises around it is worse than one plain
      // line of correction.
      ctx.io.write(`Unknown command: /${name}. Type /help to see what there is.\n`)
      return 'continue'
  }
}
