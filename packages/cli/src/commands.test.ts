import { MODE_NAMES } from '@openreverie/core'
import { describe, expect, it } from 'vitest'
import { type CommandContext, parseInput, runCommand } from './commands.js'

describe('parseInput', () => {
  const table: [string, ReturnType<typeof parseInput>][] = [
    ['/bye', { kind: 'command', name: 'bye', arg: undefined }],
    ['/mode', { kind: 'command', name: 'mode', arg: undefined }],
    ['/mode listen', { kind: 'command', name: 'mode', arg: 'listen' }],
    ['/mode   listen  ', { kind: 'command', name: 'mode', arg: 'listen' }],
    ['/MODE', { kind: 'command', name: 'mode', arg: undefined }],
    ['/moed listen', { kind: 'command', name: 'moed', arg: 'listen' }],
    ['/style tone direct', { kind: 'command', name: 'style', arg: 'tone direct' }],
    ['//mode', { kind: 'text', text: '/mode' }],
    ['/usr/local/bin', { kind: 'text', text: '/usr/local/bin' }],
    ['/', { kind: 'text', text: '/' }],
    ['', { kind: 'text', text: '' }],
    ['   ', { kind: 'text', text: '' }],
    ['hello there', { kind: 'text', text: 'hello there' }],
    ['what about /mode', { kind: 'text', text: 'what about /mode' }],
    ['/1mode', { kind: 'text', text: '/1mode' }],
    ['/mode-picker', { kind: 'command', name: 'mode-picker', arg: undefined }],
  ]

  for (const [input, expected] of table) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parseInput(input)).toEqual(expected)
    })
  }
})

function makeContext(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext
  output: string[]
  ended: number[]
} {
  const output: string[] = []
  const ended: number[] = []
  const ctx: CommandContext = {
    io: { write: (text) => output.push(text) },
    session: {
      mode: 'general',
      setMode: async () => {},
      refreshSystemPrompt: async () => {},
      end: async () => {
        ended.push(1)
      },
    },
    engine: {
      profile: () => ({ meta: { id: 'doc_1' }, body: '' }),
      currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
      updateProfileSettings: async () => ({ meta: { id: 'doc_1' }, body: '' }),
    },
    memoryDir: '/tmp/memory',
    safetyMode: 'companion',
    printWarnings: () => {},
    ...overrides,
  }
  return { ctx, output, ended }
}

describe('runCommand', () => {
  it('ends the session on /bye and reports it', async () => {
    const { ctx, output, ended } = makeContext()
    const outcome = await runCommand('bye', undefined, ctx)
    expect(outcome).toBe('exit')
    expect(ended).toHaveLength(1)
    expect(output.join('')).toContain('reflecting on this session')
    expect(output.join('')).toContain('Saved and reflected')
  })

  it('keeps the session and says so when reflection fails on /bye', async () => {
    const { ctx, output } = makeContext({
      session: {
        mode: 'general',
        setMode: async () => {},
        refreshSystemPrompt: async () => {},
        end: async () => {
          throw new Error('index locked')
        },
      },
    })
    const outcome = await runCommand('bye', undefined, ctx)
    expect(outcome).toBe('exit')
    expect(output.join('')).toContain('I could not finish reflecting: index locked')
    expect(output.join('')).toContain('will be reflected the next time reverie starts')
  })

  it('lists every command on /help, including the double slash escape', async () => {
    const { ctx, output } = makeContext()
    await runCommand('help', undefined, ctx)
    const text = output.join('')
    for (const name of ['/help', '/mode', '/style', '/settings', '/whoami', '/bye']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('//')
  })

  it('says so plainly for an unknown command and changes nothing', async () => {
    const { ctx, output } = makeContext()
    const outcome = await runCommand('moed', 'listen', ctx)
    expect(outcome).toBe('continue')
    expect(output.join('')).toContain('Unknown command: /moed. Type /help to see what there is.')
  })
})

describe('/mode', () => {
  it('lists the ten modes with the current one marked, and says it is session-only', async () => {
    const { ctx, output } = makeContext()
    await runCommand('mode', undefined, ctx)
    const text = output.join('')
    for (const name of MODE_NAMES) expect(text).toContain(name)
    expect(text).toContain('general (current)')
    expect(text).toContain('this conversation only')
  })

  it('switches and names the axes it overrides', async () => {
    const switched: string[] = []
    const { ctx, output } = makeContext({
      session: {
        mode: 'general',
        setMode: async (name) => {
          switched.push(name)
        },
        refreshSystemPrompt: async () => {},
        end: async () => {},
      },
    })
    await runCommand('mode', 'listen', ctx)
    expect(switched).toEqual(['listen'])
    const text = output.join('')
    expect(text).toContain('listen')
    expect(text).toContain('engagement')
    expect(text).toContain('orientation')
  })

  it('switches nothing and lists the valid names for an unrecognized mode', async () => {
    const switched: string[] = []
    const { ctx, output } = makeContext({
      session: {
        mode: 'general',
        setMode: async (name) => {
          switched.push(name)
        },
        refreshSystemPrompt: async () => {},
        end: async () => {},
      },
    })
    await runCommand('mode', 'moody', ctx)
    expect(switched).toEqual([])
    expect(output.join('')).toContain('general, listen, solve')
  })
})

describe('/style', () => {
  it('shows the three axes and their current values with no argument', async () => {
    const { ctx, output } = makeContext()
    await runCommand('style', undefined, ctx)
    const text = output.join('')
    expect(text).toContain('engagement: balanced')
    expect(text).toContain('tone: warm')
    expect(text).toContain('orientation: listening')
    expect(text).toContain('/style <axis> <value>')
  })

  it('writes a valid axis and value and re-assembles the prompt', async () => {
    const patches: unknown[] = []
    let refreshed = 0
    const { ctx, output } = makeContext({
      engine: {
        profile: () => ({ meta: { id: 'doc_1' }, body: '' }),
        currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
        updateProfileSettings: async (patch) => {
          patches.push(patch)
          return { meta: { id: 'doc_1' }, body: '' }
        },
      },
      session: {
        mode: 'general',
        setMode: async () => {},
        refreshSystemPrompt: async () => {
          refreshed += 1
        },
        end: async () => {},
      },
    })
    await runCommand('style', 'tone direct', ctx)
    expect(patches).toEqual([{ style: { tone: 'direct' } }])
    expect(refreshed).toBe(1)
    expect(output.join('')).toContain('tone is now direct')
  })

  it('writes nothing for an invalid axis', async () => {
    const patches: unknown[] = []
    const { ctx, output } = makeContext({
      engine: {
        profile: () => ({ meta: { id: 'doc_1' }, body: '' }),
        currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
        updateProfileSettings: async (patch) => {
          patches.push(patch)
          return { meta: { id: 'doc_1' }, body: '' }
        },
      },
    })
    await runCommand('style', 'volume loud', ctx)
    expect(patches).toEqual([])
    expect(output.join('')).toContain('engagement, tone, orientation')
  })

  it('writes nothing for an invalid value', async () => {
    const patches: unknown[] = []
    const { ctx, output } = makeContext({
      engine: {
        profile: () => ({ meta: { id: 'doc_1' }, body: '' }),
        currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
        updateProfileSettings: async (patch) => {
          patches.push(patch)
          return { meta: { id: 'doc_1' }, body: '' }
        },
      },
    })
    await runCommand('style', 'tone sardonic', ctx)
    expect(patches).toEqual([])
    expect(output.join('')).toContain('warm, playful, snarky, direct, formal')
  })
})

describe('/settings', () => {
  it('prints what is set and where it lives, and does not offer to change safety mode', async () => {
    const { ctx, output } = makeContext()
    await runCommand('settings', undefined, ctx)
    const text = output.join('')
    expect(text).toContain('Safety mode: companion')
    expect(text).toContain('config file')
    expect(text).toContain('/tmp/memory')
    expect(text).toContain('/style')
    expect(text).toContain('/whoami')
  })
})

describe('/whoami', () => {
  it('prints not known for every unset field and invents nothing', async () => {
    const { ctx, output } = makeContext()
    await runCommand('whoami', undefined, ctx)
    const text = output.join('')
    expect(text).toContain('Preferred name: not known')
    expect(text).toContain('Pronouns: not known')
    expect(text).toContain('Nothing here is guessed')
    expect(text).not.toContain('undefined')
  })

  it('prints the values that are set, and the prose body when there is one', async () => {
    const { ctx, output } = makeContext({
      engine: {
        profile: () => ({
          meta: {
            id: 'doc_1',
            preferredName: 'Vish',
            location: 'Bengaluru',
            timezone: 'Asia/Kolkata',
          },
          body: 'Prefers to be called Vish by everyone except his mother.',
        }),
        currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'listening' }),
        updateProfileSettings: async () => ({ meta: { id: 'doc_1' }, body: '' }),
      },
    })
    await runCommand('whoami', undefined, ctx)
    const text = output.join('')
    expect(text).toContain('Preferred name: Vish')
    expect(text).toContain('Location: Bengaluru')
    expect(text).toContain('Timezone: Asia/Kolkata')
    expect(text).toContain('except his mother')
  })
})
