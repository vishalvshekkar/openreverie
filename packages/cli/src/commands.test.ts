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
