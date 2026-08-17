import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { ensureMemoryTree, MemoryIndex, memoryPaths } from '@openreverie/memory'
import { describe, expect, it } from 'vitest'
import { type DoctorDeps, formatCheckLine, runDoctor } from './doctor.js'

describe('formatCheckLine', () => {
  it('pads every label to the same column width with a dot leader', () => {
    expect(formatCheckLine('config file', 'ok', '(/x/config.toml)')).toBe(
      'config file ......... ok   (/x/config.toml)',
    )
    expect(formatCheckLine('api key', 'ok', '(resolved via OPENAI_API_KEY)')).toBe(
      'api key ............. ok   (resolved via OPENAI_API_KEY)',
    )
    expect(formatCheckLine('memory folder', 'ok', '(/x/memory, writable)')).toBe(
      'memory folder ....... ok   (/x/memory, writable)',
    )
    expect(formatCheckLine('memory folder git', 'ok', '(clean, 3 commits)')).toBe(
      'memory folder git ... ok   (clean, 3 commits)',
    )
    expect(formatCheckLine('sqlite index', 'ok', '(present, rebuildable)')).toBe(
      'sqlite index ........ ok   (present, rebuildable)',
    )
  })

  it('pads a fail status to the same width as ok, so details line up', () => {
    expect(formatCheckLine('api key', 'fail', 'not set')).toBe('api key ............. fail not set')
  })

  it('pads a skip status the same way', () => {
    expect(formatCheckLine('api key', 'skip', 'config failed to load')).toBe(
      'api key ............. skip config failed to load',
    )
  })
})

function baseConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'm', reflection: 'm', embeddings: 'm' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function allOkDeps(
  config: ReverieConfig,
  overrides: Partial<DoctorDeps> = {},
): {
  deps: DoctorDeps
  output: () => string
} {
  let output = ''
  const base: DoctorDeps = {
    configPath: '/fake/config.toml',
    loadConfig: async () => config,
    isDirectory: async () => true,
    isFile: async () => true,
    probeWritable: async () => true,
    gitStatusPorcelain: async () => '',
    gitCommitCount: async () => 3,
    openIndex: () => ({ close: () => {} }),
    write: (text: string) => {
      output += text
    },
  }
  return { deps: { ...base, ...overrides }, output: () => output }
}

describe('runDoctor', () => {
  it('reports all five checks ok and exits 0', async () => {
    const originalEnv = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-test-dummy'
    try {
      const config = baseConfig('/fake/memory')
      const { deps, output } = allOkDeps(config)

      const exitCode = await runDoctor(deps)

      expect(exitCode).toBe(0)
      expect(output()).toBe(
        `reverie doctor

config file ......... ok   (/fake/config.toml)
api key ............. ok   (resolved via OPENAI_API_KEY)
memory folder ....... ok   (/fake/memory, writable)
memory folder git ... ok   (clean, 3 commits)
sqlite index ........ ok   (present, rebuildable)

All checks passed.
`,
      )
    } finally {
      if (originalEnv === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalEnv
    }
  })

  it('reports api key configured directly, not via env, when config.provider.apiKey is set', async () => {
    const config: ReverieConfig = {
      ...baseConfig('/fake/memory'),
      provider: { name: 'openai', apiKey: 'sk-should-never-appear-in-output' },
    }
    const { deps, output } = allOkDeps(config)

    await runDoctor(deps)

    expect(output()).toContain('api key ............. ok   (configured directly in config file)')
  })

  it('skips every downstream check when the config file does not exist', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), { isFile: async () => false })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    const text = output()
    expect(text).toContain(
      'config file ......... fail no config file at /fake/config.toml. Run: reverie setup',
    )
    expect(text).toContain('api key ............. skip config failed to load; cannot resolve a key')
    expect(text).toContain(
      'memory folder ....... skip config failed to load; cannot check the memory folder',
    )
    expect(text).toContain(
      'memory folder git ... skip memory folder check failed; cannot check git state',
    )
    expect(text).toContain(
      'sqlite index ........ skip config failed to load; cannot check the index',
    )
    expect(text).toContain('1 of 5 checks failed.')
  })

  it('reports the real resolveApiKey message and exits 1 when no key resolves, without printing it as ok', async () => {
    const config: ReverieConfig = {
      ...baseConfig('/fake/memory'),
      provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    }
    const originalEnv = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const { deps, output } = allOkDeps(config)
      const exitCode = await runDoctor(deps)
      expect(exitCode).toBe(1)
      expect(output()).toContain(
        'api key ............. fail No API key found. provider.apiKeyEnv names "OPENAI_API_KEY", ' +
          'but that environment variable is not set. Set it, or set provider.apiKey directly in the config file.',
      )
    } finally {
      if (originalEnv !== undefined) process.env.OPENAI_API_KEY = originalEnv
    }
  })

  it('reports the memory folder as not writable without failing the sqlite check, which only needs the path', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      probeWritable: async () => false,
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    const text = output()
    expect(text).toContain('memory folder ....... fail /fake/memory is not writable')
    expect(text).toContain(
      'memory folder git ... skip memory folder check failed; cannot check git state',
    )
  })

  it('reports ok with a note, not fail, when .git does not exist yet', async () => {
    const originalEnv = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-test-dummy'
    try {
      const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
        isDirectory: async (path: string) => !path.endsWith('.git'),
      })

      const exitCode = await runDoctor(deps)

      expect(output()).toContain('memory folder git ... ok   (created on first reflect or /bye)')
      expect(exitCode).toBe(0)
    } finally {
      if (originalEnv === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalEnv
    }
  })

  it('reports dirty instead of clean when git status has output', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      gitStatusPorcelain: async () => ' M constitution.md\n',
    })

    await runDoctor(deps)

    expect(output()).toContain('memory folder git ... ok   (dirty, 3 commits)')
  })

  it('reports no commits yet, not a thrown error, when the git repo has zero commits', async () => {
    const originalEnv = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-test-dummy'
    try {
      const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
        gitCommitCount: async () => undefined,
      })

      const exitCode = await runDoctor(deps)

      expect(exitCode).toBe(0)
      expect(output()).toContain('memory folder git ... ok   (initialized, no commits yet)')
    } finally {
      if (originalEnv === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalEnv
    }
  })

  it('reports the sqlite index missing with the exact remediation message', async () => {
    const { deps, output } = allOkDeps(baseConfig('/fake/memory'), {
      isFile: async (path: string) => !path.endsWith('index.db'),
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    expect(output()).toContain('sqlite index ........ fail index.db missing; run: reverie reindex')
  })

  it('does not call openIndex at all when index.db is missing, so doctor never creates it', async () => {
    let openIndexCalled = false
    const { deps } = allOkDeps(baseConfig('/fake/memory'), {
      isFile: async (path: string) => !path.endsWith('index.db'),
      openIndex: () => {
        openIndexCalled = true
        return { close: () => {} }
      },
    })

    await runDoctor(deps)

    expect(openIndexCalled).toBe(false)
  })

  it('never prints a realistic-looking secret anywhere in its output', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz123456'
    const config: ReverieConfig = {
      ...baseConfig('/fake/memory'),
      provider: { name: 'openai', apiKey: secret },
    }
    const { deps, output } = allOkDeps(config)

    await runDoctor(deps)

    expect(output()).not.toContain(secret)
  })

  it("reproduces the spec's 2-of-5 failure summary arithmetic: api key and sqlite index fail, git absent is ok", async () => {
    delete process.env.OPENAI_API_KEY
    const config = baseConfig('/fake/memory')
    const { deps, output } = allOkDeps(config, {
      isDirectory: async (path: string) => !path.endsWith('.git'),
      isFile: async (path: string) => !path.endsWith('index.db'),
    })

    const exitCode = await runDoctor(deps)

    expect(exitCode).toBe(1)
    expect(output()).toContain('2 of 5 checks failed.')
  })
})

describe('runDoctor against a real filesystem', () => {
  it('never creates index.db as a side effect of checking whether it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-doctor-'))
    try {
      const configPath = join(dir, 'config.toml')
      await writeFile(configPath, 'placeholder, loadConfig is faked below', 'utf8')
      const memoryDir = join(dir, 'memory')
      await ensureMemoryTree(memoryPaths(memoryDir))
      const config = baseConfig(memoryDir)
      let output = ''

      const exitCode = await runDoctor({
        configPath,
        loadConfig: async () => config,
        isDirectory: async (p: string) => {
          try {
            return (await stat(p)).isDirectory()
          } catch {
            return false
          }
        },
        isFile: async (p: string) => {
          try {
            return (await stat(p)).isFile()
          } catch {
            return false
          }
        },
        probeWritable: async () => true,
        gitStatusPorcelain: async () => '',
        gitCommitCount: async () => undefined,
        openIndex: (p: string) => MemoryIndex.open(p),
        write: (text: string) => {
          output += text
        },
      })

      expect(exitCode).toBe(1)
      expect(output).toContain('index.db missing; run: reverie reindex')
      await expect(stat(memoryPaths(memoryDir).indexDb)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
