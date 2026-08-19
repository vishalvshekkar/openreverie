import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultCrisisResources, loadConfig } from '@openreverie/core'
import { loadProfile, memoryPaths, writeProfile } from '@openreverie/memory'
import { describe, expect, it } from 'vitest'
import { runSetup, type SetupIo } from './setup.js'

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reverie-setup-test-'))
  return path.join(dir, 'config.toml')
}

// The memory-folder prompt is answered blank in most scripted runs below,
// which used to be harmless: nothing read config.memoryDir back off disk.
// Now that runSetup also writes profile.md into that folder, a blank
// answer must not resolve to the real ~/.reverie/memory on whatever
// machine runs the suite. So this substitutes a fresh temp directory for
// any blank answer to that one prompt, and leaves an explicitly scripted
// path (used by the two-runs-share-a-folder test) untouched.
function scriptedIo(answers: string[]): {
  io: SetupIo
  output: string[]
  queue: string[]
  memoryDir: string
} {
  const output: string[] = []
  const queue = [...answers]
  const fallbackMemoryDir = mkdtempSync(path.join(tmpdir(), 'reverie-setup-memory-'))
  let memoryDir = fallbackMemoryDir
  const io: SetupIo = {
    async question(prompt: string) {
      output.push(prompt)
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(`No scripted answer left for prompt: ${prompt}`)
      }
      if (prompt.includes('Memory folder')) {
        if (next === '') {
          memoryDir = fallbackMemoryDir
          return fallbackMemoryDir
        }
        memoryDir = next
        return next
      }
      return next
    },
    write(text: string) {
      output.push(text)
    },
  }
  return {
    io,
    output,
    queue,
    get memoryDir() {
      return memoryDir
    },
  }
}

describe('runSetup happy path', () => {
  it('writes a config loadable by loadConfig, with firewall mode when 2 is chosen', async () => {
    const configPath = await tempConfigPath()
    // provider, api key choice, env var name, chat, reflection, embeddings, memory folder,
    // safety mode, engagement, tone, orientation
    const { io, queue, memoryDir } = scriptedIo(['', '', '', '', '', '', '', '2', '', '', ''])

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
    const profile = await loadProfile(memoryPaths(memoryDir))
    expect(profile.meta.style).toEqual({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
    })
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
    const { io, queue, memoryDir } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const profile = await loadProfile(memoryPaths(memoryDir))
    expect(profile.meta.style).toEqual({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
    })
  })

  it('writes the chosen style values when specific numbers are picked', async () => {
    const configPath = await tempConfigPath()
    const { io, queue, memoryDir } = scriptedIo(['', '', '', '', '', '', '', '1', '1', '2', '3'])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const profile = await loadProfile(memoryPaths(memoryDir))
    expect(profile.meta.style).toEqual({
      engagement: 'leading',
      tone: 'playful',
      orientation: 'solutions',
    })
  })

  it('re-asks on an out-of-range number, with no config written until it resolves', async () => {
    const configPath = await tempConfigPath()
    const { io, output, queue, memoryDir } = scriptedIo([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '1',
      '9',
      '1',
      '',
      '',
    ])

    await runSetup(io, configPath)

    expect(queue).toHaveLength(0)
    const reprompt = output.find((line) => line.includes('Enter a number from 1 to'))
    expect(reprompt).toBeDefined()

    const profile = await loadProfile(memoryPaths(memoryDir))
    expect(profile.meta.style?.engagement).toBe('leading')
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

  it('mentions exactly once that style can be changed later with /style', async () => {
    const configPath = await tempConfigPath()
    const { io, output } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    const joined = output.join('')
    const mentions = joined.match(/\/style/g) ?? []
    expect(mentions).toHaveLength(1)
  })
})

describe('setup writes style into profile.md', () => {
  it('writes style to the profile and no [style] table to the config', async () => {
    const configPath = await tempConfigPath()
    const { io, memoryDir } = scriptedIo(['', '', '', '', '', '', '', '1', '', '', ''])

    await runSetup(io, configPath)

    const configText = await readFile(configPath, 'utf8')
    expect(configText).not.toContain('[style]')

    const paths = memoryPaths(memoryDir)
    const profile = await loadProfile(paths)
    expect(profile.meta.style).toEqual({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
    })
  })

  it('preserves every non-style profile field when setup is run twice', async () => {
    const configPath = await tempConfigPath()
    const sharedMemoryDir = await mkdtemp(path.join(tmpdir(), 'reverie-setup-memory-shared-'))

    const first = scriptedIo(['', '', '', '', '', '', sharedMemoryDir, '1', '', '', ''])
    await runSetup(first.io, configPath)

    const paths = memoryPaths(sharedMemoryDir)
    const firstProfile = await loadProfile(paths)
    await writeProfile(paths, {
      ...firstProfile,
      meta: { ...firstProfile.meta, preferredName: 'Vish', location: 'Bengaluru' },
    })

    const second = scriptedIo(['', '', '', '', '', '', sharedMemoryDir, '1', '', '', ''])
    await runSetup(second.io, configPath)

    const secondProfile = await loadProfile(paths)
    expect(secondProfile.meta.preferredName).toBe('Vish')
    expect(secondProfile.meta.location).toBe('Bengaluru')
  })
})
