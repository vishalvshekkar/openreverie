import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultCrisisResources,
  loadConfig,
  type ReverieConfig,
  readConfigMemoryDir,
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
})

describe('style has moved out of config.toml', () => {
  it('names reverie migrate when the file still has a [style] table', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        'apiKeyEnv = "OPENAI_API_KEY"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
        '[style]',
        'tone = "snarky"',
      ].join('\n'),
      'utf8',
    )

    await expect(loadConfig(configPath)).rejects.toThrow(/reverie migrate/)
    await expect(loadConfig(configPath)).rejects.not.toThrow(/unknown key/)
  })

  it('loads a config with no [style] table, and the result has no style property', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        '[provider]',
        'name = "openai"',
        'apiKeyEnv = "OPENAI_API_KEY"',
        '',
        '[safety]',
        'mode = "companion"',
      ].join('\n'),
      'utf8',
    )

    const config = await loadConfig(configPath)
    expect('style' in config).toBe(false)
  })

  it('readConfigMemoryDir works on a file that loadConfig would reject', async () => {
    const configPath = path.join(dir, 'config.toml')
    await writeFile(
      configPath,
      [
        'memoryDir = "/tmp/reverie-test-memory"',
        '[provider]',
        'name = "openai"',
        'apiKeyEnv = "OPENAI_API_KEY"',
        '',
        '[safety]',
        'mode = "companion"',
        '',
        '[style]',
        'tone = "snarky"',
      ].join('\n'),
      'utf8',
    )

    expect(await readConfigMemoryDir(configPath)).toBe('/tmp/reverie-test-memory')
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
