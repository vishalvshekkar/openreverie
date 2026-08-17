import { describe, expect, it } from 'vitest'
import type { CliMainDeps } from './index.js'
import { mainWith } from './index.js'

function testDeps(overrides: Partial<CliMainDeps> = {}): {
  deps: CliMainDeps
  output: () => string
} {
  let output = ''
  const base: CliMainDeps = {
    runWeb: async () => {
      throw new Error('runWeb should not be called')
    },
    launchServer: async () => {
      throw new Error('launchServer should not be called')
    },
    runRead: async () => {
      throw new Error('runRead should not be called')
    },
    runSetupCommand: async (_configPath: string) => {
      throw new Error('runSetupCommand should not be called')
    },
    openCliContext: async () => {
      throw new Error('openCliContext should not be called')
    },
    buildChat: () => {
      throw new Error('buildChat should not be called')
    },
    buildEmbeddings: () => {
      throw new Error('buildEmbeddings should not be called')
    },
    openEngine: async () => {
      throw new Error('openEngine should not be called')
    },
    countMemoryDocuments: async () => {
      throw new Error('countMemoryDocuments should not be called')
    },
    runChat: async () => {
      throw new Error('runChat should not be called')
    },
    createStylePersister: () => async (patch) => ({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
      ...patch,
    }),
    loadConfig: async () => {
      throw new Error('loadConfig should not be called')
    },
    configPath: '/fake/.reverie/config.toml',
    write: (text: string) => {
      output += text
    },
    colorEnabled: () => false,
    readVersion: () => '9.9.9-test',
  }
  return { deps: { ...base, ...overrides }, output: () => output }
}

describe('mainWith unknown subcommand', () => {
  it('reports an unknown command and never opens a CLI context, instead of falling through to chat', async () => {
    let contextOpened = false
    const { deps, output } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        return { ok: true, engine: {} as never, config: {} as never, chat: {} as never }
      },
    })

    await mainWith(['reflcet'], deps)

    expect(contextOpened).toBe(false)
    expect(output()).toBe(
      "reverie: unknown command 'reflcet'\nRun 'reverie --help' for a list of commands.\n",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('still starts the chat REPL when no subcommand is given at all', async () => {
    let contextOpened = false
    const { deps } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        return { ok: false, kind: 'config', message: 'stop here' } as never
      },
    })

    await mainWith([], deps)

    expect(contextOpened).toBe(true)
    process.exitCode = 0
  })
})

describe('mainWith --version', () => {
  it('prints the bare version and exits 0 for --version, without touching config', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['--version'], deps)
    expect(output()).toBe('1.2.3\n')
    expect(process.exitCode).toBe(0)
    process.exitCode = 0
  })

  it('prints the bare version for -v', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['-v'], deps)
    expect(output()).toBe('1.2.3\n')
    process.exitCode = 0
  })

  it('prints the bare version for the version subcommand', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['version'], deps)
    expect(output()).toBe('1.2.3\n')
    process.exitCode = 0
  })

  it('wins over other garbage arguments, per spec 1.2', async () => {
    const { deps, output } = testDeps({ readVersion: () => '1.2.3' })
    await mainWith(['--version', '--config', '/bogus'], deps)
    expect(output()).toBe('1.2.3\n')
    process.exitCode = 0
  })
})

describe('mainWith --config', () => {
  it('routes --config before the subcommand into loadConfig', async () => {
    let receivedPath: string | undefined
    const { deps } = testDeps({
      runRead: async (_args, readDeps) => {
        await readDeps.loadConfig()
        return 0
      },
      loadConfig: async (path: string) => {
        receivedPath = path
        return {} as never
      },
    })

    await mainWith(['--config', '/custom/config.toml', 'read'], deps)

    expect(receivedPath).toBe('/custom/config.toml')
  })

  it('routes --config after the subcommand the same way', async () => {
    let receivedPath: string | undefined
    const { deps } = testDeps({
      runRead: async (_args, readDeps) => {
        await readDeps.loadConfig()
        return 0
      },
      loadConfig: async (path: string) => {
        receivedPath = path
        return {} as never
      },
    })

    await mainWith(['read', '--config', '/custom/config.toml'], deps)

    expect(receivedPath).toBe('/custom/config.toml')
  })

  it('reports a usage error when --config has no value', async () => {
    const { deps, output } = testDeps()

    await mainWith(['--config'], deps)

    expect(output()).toBe('--config requires a path argument\n')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('reports a usage error when --config is the last argument with a subcommand before it', async () => {
    const { deps, output } = testDeps()

    await mainWith(['read', '--config'], deps)

    expect(output()).toBe('--config requires a path argument\n')
    process.exitCode = 0
  })
})

describe('mainWith unknown option', () => {
  it('reports an unknown flag anywhere in argv, without touching config', async () => {
    const { deps, output } = testDeps()

    await mainWith(['reflect', '--frobnicate'], deps)

    expect(output()).toBe(
      "reverie: unknown option '--frobnicate'\nRun 'reverie --help' for a list of options.\n",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
