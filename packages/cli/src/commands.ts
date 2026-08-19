// The in-session command parser and dispatch table.
//
// This reads lines typed at the you> prompt inside a running session. It
// is not the argv parser: that one reads process.argv before a session
// exists and lives in index.ts. The two are separate and stay separate.

import { isModeName, MODE_NAMES, MODES, type ModeName, modeOverrides } from '@openreverie/core'
import {
  ENGAGEMENT_VALUES,
  ORIENTATION_VALUES,
  type Profile,
  type StyleConfig,
  TONE_VALUES,
} from '@openreverie/memory'

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

async function commandMode(arg: string | undefined, ctx: CommandContext): Promise<CommandOutcome> {
  if (arg === undefined) {
    const lines = MODE_NAMES.map((name) => {
      const marker = name === ctx.session.mode ? ' (current)' : ''
      return `  ${name}${marker}: ${MODES[name].summary}`
    })
    ctx.io.write(`${lines.join('\n')}\nA mode lasts for this conversation only. It is not saved.\n`)
    return 'continue'
  }

  const requested = arg.trim().toLowerCase()
  if (!isModeName(requested)) {
    ctx.io.write(`No mode called ${requested}. The modes are: ${MODE_NAMES.join(', ')}.\n`)
    return 'continue'
  }

  await ctx.session.setMode(requested, { source: 'cli' })
  const overridden = modeOverrides(requested)
  const suffix =
    overridden.length === 0
      ? 'It leaves your style settings alone.'
      : `For this conversation it takes over your ${overridden.join(' and ')} setting.`
  ctx.io.write(`Mode is now ${requested}: ${MODES[requested].summary} ${suffix}\n`)
  return 'continue'
}

const STYLE_AXES = {
  engagement: ENGAGEMENT_VALUES,
  tone: TONE_VALUES,
  orientation: ORIENTATION_VALUES,
} as const

async function commandStyle(arg: string | undefined, ctx: CommandContext): Promise<CommandOutcome> {
  const style = ctx.engine.currentStyle()
  if (arg === undefined) {
    ctx.io.write(
      [
        `  engagement: ${style.engagement}`,
        `  tone: ${style.tone}`,
        `  orientation: ${style.orientation}`,
        'Change one with /style <axis> <value>. This is saved to profile.md and lasts.',
        '',
      ].join('\n'),
    )
    return 'continue'
  }

  const parts = arg.trim().split(/\s+/)
  const axis = (parts[0] ?? '').toLowerCase()
  const value = (parts[1] ?? '').toLowerCase()

  if (axis !== 'engagement' && axis !== 'tone' && axis !== 'orientation') {
    ctx.io.write(`No style axis called ${axis}. The axes are: engagement, tone, orientation.\n`)
    return 'continue'
  }

  const allowed = STYLE_AXES[axis] as readonly string[]
  if (!allowed.includes(value)) {
    ctx.io.write(`No ${axis} called ${value}. The values are: ${allowed.join(', ')}.\n`)
    return 'continue'
  }

  await ctx.engine.updateProfileSettings({ style: { [axis]: value } as Partial<StyleConfig> })
  // Re-assemble now, so the change applies to the rest of this
  // conversation rather than only to the next one.
  await ctx.session.refreshSystemPrompt()
  ctx.io.write(`Your ${axis} is now ${value}. Saved.\n`)
  return 'continue'
}

function commandSettings(ctx: CommandContext): CommandOutcome {
  ctx.io.write(
    [
      `Safety mode: ${ctx.safetyMode}. This one is changed by hand in the config file, deliberately.`,
      `Memory folder: ${ctx.memoryDir}`,
      'Style: /style. What reverie knows about you: /whoami.',
      '',
    ].join('\n'),
  )
  return 'continue'
}

function commandWhoami(ctx: CommandContext): CommandOutcome {
  const profile = ctx.engine.profile()
  const meta = profile.meta
  const shown = (value: unknown): string =>
    value === undefined
      ? 'not known'
      : typeof value === 'boolean'
        ? value
          ? 'yes'
          : 'no'
        : String(value)

  const lines = [
    `Preferred name: ${shown(meta.preferredName)}`,
    `Pronouns: ${shown(meta.pronouns)}`,
    `Location: ${shown(meta.location)}`,
    `Timezone: ${shown(meta.timezone)}`,
    `Birthday: ${shown(meta.birthday)}`,
    `Occupation: ${shown(meta.occupation)}`,
    `Birthday greetings: ${shown(meta.birthdayGreetings)}`,
  ]

  const body = profile.body.trim()
  if (body.length > 0) lines.push('', body)
  lines.push('', 'Nothing here is guessed. It is only what you have said or set.')
  ctx.io.write(`${lines.join('\n')}\n`)
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
    case 'mode':
      return await commandMode(arg, ctx)
    case 'style':
      return await commandStyle(arg, ctx)
    case 'settings':
      return commandSettings(ctx)
    case 'whoami':
      return commandWhoami(ctx)
    default:
      // A typo'd command does not reach the model. Sending it to a
      // companion that then improvises around it is worse than one plain
      // line of correction.
      ctx.io.write(`Unknown command: /${name}. Type /help to see what there is.\n`)
      return 'continue'
  }
}
