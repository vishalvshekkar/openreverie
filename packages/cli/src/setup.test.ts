import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultCrisisResources, loadConfig } from '@openreverie/core'
import { describe, expect, it } from 'vitest'
import { runSetup, type SetupIo } from './setup.js'

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reverie-setup-test-'))
  return path.join(dir, 'config.toml')
}

function scriptedIo(answers: string[]): { io: SetupIo; output: string[]; queue: string[] } {
  const output: string[] = []
  const queue = [...answers]
  const io: SetupIo = {
    async question(prompt: string) {
      output.push(prompt)
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(`No scripted answer left for prompt: ${prompt}`)
      }
      return next
    },
    write(text: string) {
      output.push(text)
    },
  }
  return { io, output, queue }
}

describe('runSetup happy path', () => {
  it('writes a config loadable by loadConfig, with firewall mode when 2 is chosen', async () => {
    const configPath = await tempConfigPath()
    // provider, api key choice, env var name, chat, reflection, embeddings, memory folder,
    // safety mode, engagement, tone, orientation
    const { io, queue } = scriptedIo(['', '', '', '', '', '', '', '2', '', '', ''])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.provider).toEqual({ name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' })
    expect(config.models).toEqual({
      chat: 'gpt-5',
      reflection: 'gpt-5-mini',
      embeddings: 'text-embedding-3-small',
    })
    expect(config.safety.mode).toBe('firewall')
    expect(config.safety.resources).toEqual(defaultCrisisResources)
    expect(config.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
  })
})

describe('runSetup safety mode prompt', () => {
  it('re-asks when the safety mode answer is empty, with no preselected default', async () => {
    const configPath = await tempConfigPath()
    const { io, output, queue } = scriptedIo(['', '', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    // Both the empty answer and the following '1' must have been consumed by
    // the safety mode loop specifically, not silently defaulted past.
    expect(queue).toHaveLength(0)
    const safetyModePrompts = output.filter((line) => line.startsWith('Choice (1 or 2'))
    expect(safetyModePrompts).toHaveLength(2)
    const reprompt = output.find((line) => line.includes('no default for this one'))
    expect(reprompt).toBeDefined()

    const config = await loadConfig(configPath)
    expect(config.safety.mode).toBe('companion')
  })
})

describe('runSetup API key handling', () => {
  it('leaves apiKey unset and records apiKeyEnv on the environment variable route', async () => {
    const configPath = await tempConfigPath()
    const { io, queue } = scriptedIo(['', '1', 'MY_OPENAI_KEY', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.provider.apiKeyEnv).toBe('MY_OPENAI_KEY')
    expect(config.provider.apiKey).toBeUndefined()
  })

  it('stores a pasted key directly and leaves apiKeyEnv unset', async () => {
    const configPath = await tempConfigPath()
    const { io, queue } = scriptedIo(['', '2', 'sk-test-key', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.provider.apiKey).toBe('sk-test-key')
    expect(config.provider.apiKeyEnv).toBeUndefined()
  })

  it('re-asks when a pasted key is empty', async () => {
    const configPath = await tempConfigPath()
    const { io, output, queue } = scriptedIo([
      '',
      '2',
      '',
      'sk-real-key',
      '',
      '',
      '',
      '',
      '1',
      '',
      '',
      '',
    ])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.provider.apiKey).toBe('sk-real-key')
    const reprompt = output.find((line) => line.includes('not usable'))
    expect(reprompt).toBeDefined()
  })
})

describe('runSetup custom answers', () => {
  it('accepts a custom memory folder and model names instead of the defaults', async () => {
    const configPath = await tempConfigPath()
    const customMemoryDir = path.join(await mkdtemp(path.join(tmpdir(), 'reverie-mem-')), 'mem')
    const { io, queue } = scriptedIo([
      '',
      '',
      '',
      'gpt-5-custom',
      'gpt-5-mini-custom',
      'text-embedding-3-large',
      customMemoryDir,
      '1',
      '',
      '',
      '',
    ])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.models).toEqual({
      chat: 'gpt-5-custom',
      reflection: 'gpt-5-mini-custom',
      embeddings: 'text-embedding-3-large',
    })
    expect(config.memoryDir).toBe(customMemoryDir)
  })
})

describe('runSetup output', () => {
  it('prints where it wrote the config and how to start reverie', async () => {
    const configPath = await tempConfigPath()
    const { io, output } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    const joined = output.join('')
    expect(joined).toContain(configPath)
    expect(joined).toContain('reverie')
  })

  it('mentions crisis resources are editable in the config file', async () => {
    const configPath = await tempConfigPath()
    const { io, output } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    const joined = output.join('')
    expect(joined.toLowerCase()).toContain('crisis resources')
    expect(joined.toLowerCase()).toContain('config file')
  })
})

describe('runSetup style questions', () => {
  it('defaults to balanced/warm/listening when all three are accepted on enter', async () => {
    const configPath = await tempConfigPath()
    const { io, queue } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
  })

  it('writes the chosen style values when specific numbers are picked', async () => {
    const configPath = await tempConfigPath()
    const { io, queue } = scriptedIo(['', '', '', '', '', '', '', '1', '1', '2', '3'])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const config = await loadConfig(configPath)
    expect(config.style).toEqual({
      engagement: 'leading',
      tone: 'playful',
      orientation: 'solutions',
    })
  })

  it('re-asks on an out-of-range number, with no config written until it resolves', async () => {
    const configPath = await tempConfigPath()
    const { io, output, queue } = scriptedIo(['', '', '', '', '', '', '', '1', '9', '1', '', ''])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const reprompt = output.find((line) => line.includes('Enter a number from 1 to'))
    expect(reprompt).toBeDefined()

    const config = await loadConfig(configPath)
    expect(config.style.engagement).toBe('leading')
  })

  it('describes each style option honestly in one line, with a suggested default marked', async () => {
    const configPath = await tempConfigPath()
    const { io, output } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    const joined = output.join('')
    expect(joined).toContain('Leading.')
    expect(joined).toContain('Balanced (suggested).')
    expect(joined).toContain('Following.')
    expect(joined).toContain('Warm (suggested).')
    expect(joined).toContain('Playful.')
    expect(joined).toContain('Snarky.')
    expect(joined).toContain('Direct.')
    expect(joined).toContain('Formal.')
    expect(joined).toContain('Listening (suggested).')
    expect(joined).toContain('Solutions.')
  })

  it('mentions exactly once that style can be changed later by telling reverie in conversation', async () => {
    const configPath = await tempConfigPath()
    const { io, output } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    const joined = output.join('')
    const mentions = joined.match(/telling reverie in conversation/g) ?? []
    expect(mentions).toHaveLength(1)
  })
})
