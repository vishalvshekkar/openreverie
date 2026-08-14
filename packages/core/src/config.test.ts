import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultCrisisResources,
  loadConfig,
  type ReverieConfig,
  resolveApiKey,
  saveConfig,
} from './config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'reverie-config-test-'))
})

afterEach(() => {
  delete process.env.OPENREVERIE_TEST_KEY
})

function fullConfig(overrides: Partial<ReverieConfig> = {}): ReverieConfig {
  return {
    memoryDir: '/somewhere/memory',
    provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
    models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
    safety: { mode: 'companion', resources: defaultCrisisResources },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
    ...overrides,
  }
}

describe('saveConfig and loadConfig round trip', () => {
  it('reloads exactly what was saved', async () => {
    const configPath = path.join(dir, 'config.toml')
    const config = fullConfig()

    await saveConfig(config, configPath)
    const loaded = await loadConfig(configPath)

    expect(loaded).toEqual(config)
  })

  it('preserves a firewall mode config with a custom resource list', async () => {
    const configPath = path.join(dir, 'config.toml')
    const config = fullConfig({
      safety: {
        mode: 'firewall',
        resources: [{ label: 'Local crisis line', contact: '555-0100' }],
      },
    })

    await saveConfig(config, configPath)
    const loaded = await loadConfig(configPath)

    expect(loaded).toEqual(config)
  })

  it('preserves a non-default style selection', async () => {
    const configPath = path.join(dir, 'config.toml')
    const config = fullConfig({
      style: { engagement: 'following', tone: 'snarky', orientation: 'solutions' },
    })

    await saveConfig(config, configPath)
    const loaded = await loadConfig(configPath)

    expect(loaded).toEqual(config)
  })
})

describe('loadConfig defaults', () => {
  it('applies memoryDir, models, and crisis resource defaults when those sections are omitted', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        'apiKey = "sk-test"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
      ].join('\n'),
      'utf8',
    )

    const loaded = await loadConfig(configPath)

    expect(loaded.memoryDir).toBe(path.join(os.homedir(), '.reverie', 'memory'))
    expect(loaded.models).toEqual({
      chat: 'gpt-5',
      reflection: 'gpt-5-mini',
      embeddings: 'text-embedding-3-small',
    })
    expect(loaded.safety.resources).toEqual(defaultCrisisResources)
    expect(loaded.safety.resources).not.toBe(defaultCrisisResources)
    expect(loaded.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
  })

  it('applies balanced/warm/listening style defaults when the [style] section is omitted entirely', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        'apiKey = "sk-test"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
      ].join('\n'),
      'utf8',
    )

    const loaded = await loadConfig(configPath)

    expect(loaded.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
  })

  it('fills a defaulted field when the [style] section is present but partial', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        'apiKey = "sk-test"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
        '[style]',
        'tone = "playful"',
        '',
      ].join('\n'),
      'utf8',
    )

    const loaded = await loadConfig(configPath)

    expect(loaded.style).toEqual({
      engagement: 'balanced',
      tone: 'playful',
      orientation: 'listening',
    })
  })
})

describe('loadConfig missing file', () => {
  it('throws a plain error naming the setup command', async () => {
    const configPath = path.join(dir, 'does-not-exist.toml')

    await expect(loadConfig(configPath)).rejects.toThrow('No config found. Run: reverie setup')
  })
})

describe('loadConfig unknown keys', () => {
  it('rejects an unknown top-level key and names it in the error', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        'memoryDir = "/x"',
        '',
        '[provider]',
        'name = "openai"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
        'bogusField = "oops"',
        '',
      ].join('\n'),
      'utf8',
    )

    await expect(loadConfig(configPath)).rejects.toThrow('bogusField')
  })

  it('rejects an unknown key inside a nested section and names it', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        'notARealField = "oops"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
      ].join('\n'),
      'utf8',
    )

    await expect(loadConfig(configPath)).rejects.toThrow('notARealField')
  })

  it('requires an explicit safety section rather than silently defaulting the mode', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(configPath, ['[provider]', 'name = "openai"', ''].join('\n'), 'utf8')

    await expect(loadConfig(configPath)).rejects.toThrow(/safety/)
  })

  it('rejects an unknown key inside the style section and names it', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
        '[style]',
        'tone = "warm"',
        'bogusStyleField = "oops"',
        '',
      ].join('\n'),
      'utf8',
    )

    await expect(loadConfig(configPath)).rejects.toThrow('bogusStyleField')
  })

  it('rejects an invalid enum value for a style axis', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
        '[style]',
        'tone = "grumpy"',
        '',
      ].join('\n'),
      'utf8',
    )

    await expect(loadConfig(configPath)).rejects.toThrow(/style.tone/)
  })
})

describe('saveConfig file permissions', () => {
  it('writes the config file with 0600 permissions', async () => {
    const configPath = path.join(dir, 'config.toml')
    await saveConfig(fullConfig(), configPath)

    const info = await stat(configPath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('writes valid TOML that round trips through a plain read', async () => {
    const configPath = path.join(dir, 'config.toml')
    await saveConfig(fullConfig(), configPath)

    const text = await readFile(configPath, 'utf8')
    expect(text).toContain('mode = "companion"')
  })
})

describe('resolveApiKey', () => {
  it('prefers a directly configured apiKey over apiKeyEnv', () => {
    process.env.OPENREVERIE_TEST_KEY = 'from-env'
    const config = fullConfig({
      provider: { name: 'openai', apiKey: 'from-file', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
    })

    expect(resolveApiKey(config)).toBe('from-file')
  })

  it('falls back to the named environment variable', () => {
    process.env.OPENREVERIE_TEST_KEY = 'from-env'
    const config = fullConfig({ provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' } })

    expect(resolveApiKey(config)).toBe('from-env')
  })

  it('throws naming both options when the named env var is unset', () => {
    delete process.env.OPENREVERIE_TEST_KEY
    const config = fullConfig({ provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' } })

    expect(() => resolveApiKey(config)).toThrow(/provider\.apiKey\b/)
    expect(() => resolveApiKey(config)).toThrow(/provider\.apiKeyEnv\b/)
  })

  it('throws naming both options when neither apiKey nor apiKeyEnv is set', () => {
    const config = fullConfig({ provider: { name: 'openai' } })

    expect(() => resolveApiKey(config)).toThrow(/provider\.apiKey\b/)
    expect(() => resolveApiKey(config)).toThrow(/provider\.apiKeyEnv\b/)
  })
})
