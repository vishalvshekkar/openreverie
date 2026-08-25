import { describe, expect, it } from 'vitest'
import type { DoctorDeps } from './doctor.js'
import { subcommandHelp, TOP_LEVEL_HELP } from './help.js'
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
    runMigrate: async () => {
      throw new Error('runMigrate should not be called')
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
    runChat: async () => ({ interrupted: false }),
    runDreamCommand: async () => {
      throw new Error('runDreamCommand should not be called')
    },
    loadConfig: async () => {
      throw new Error('loadConfig should not be called')
    },
    readConfigMemoryDir: async () => {
      throw new Error('readConfigMemoryDir should not be called')
    },
    configPath: '/fake/.reverie/config.toml',
    write: (text: string) => {
      output += text
    },
    colorEnabled: () => false,
    interactive: () => false,
    readVersion: () => '9.9.9-test',
    runDoctor: async () => {
      throw new Error('runDoctor should not be called')
    },
    buildDoctorDeps: () => {
      throw new Error('buildDoctorDeps should not be called')
    },
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

describe('mainWith --help', () => {
  it('prints top-level help and exits 0 for --help, without touching config', async () => {
    const { deps, output } = testDeps()
    await mainWith(['--help'], deps)
    expect(output()).toBe(TOP_LEVEL_HELP)
    expect(process.exitCode).toBe(0)
    process.exitCode = 0
  })

  it('prints top-level help for -h', async () => {
    const { deps, output } = testDeps()
    await mainWith(['-h'], deps)
    expect(output()).toBe(TOP_LEVEL_HELP)
    process.exitCode = 0
  })

  it('prints top-level help for the bare help subcommand', async () => {
    const { deps, output } = testDeps()
    await mainWith(['help'], deps)
    expect(output()).toBe(TOP_LEVEL_HELP)
    process.exitCode = 0
  })

  it('prints reflect-specific help for reverie reflect --help, without opening an engine', async () => {
    let contextOpened = false
    const { deps, output } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        throw new Error('should not reach here')
      },
    })
    await mainWith(['reflect', '--help'], deps)
    expect(output()).toBe(subcommandHelp('reflect'))
    expect(contextOpened).toBe(false)
    process.exitCode = 0
  })

  it('prints reflect-specific help for reverie help reflect', async () => {
    const { deps, output } = testDeps()
    await mainWith(['help', 'reflect'], deps)
    expect(output()).toBe(subcommandHelp('reflect'))
    process.exitCode = 0
  })

  it('reports an unknown command and exits 1 for reverie help bogus', async () => {
    const { deps, output } = testDeps()
    await mainWith(['help', 'bogus'], deps)
    expect(output()).toBe(
      "reverie: unknown command 'bogus'\nRun 'reverie --help' for a list of commands.\n",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})

describe('mainWith exit codes for openCliContext failures', () => {
  it('exits 2 for a config-kind failure', async () => {
    const { deps, output } = testDeps({
      openCliContext: async () => ({ ok: false, kind: 'config', message: 'bad config' }),
    })
    await mainWith(['reflect'], deps)
    expect(output()).toBe('bad config\n')
    expect(process.exitCode).toBe(2)
    process.exitCode = 0
  })

  it('exits 3 for a provider-kind failure', async () => {
    const { deps, output } = testDeps({
      openCliContext: async () => ({ ok: false, kind: 'provider', message: 'bad provider' }),
    })
    await mainWith(['reflect'], deps)
    expect(output()).toBe('bad provider\n')
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })
})

describe('mainWith doctor', () => {
  it('calls buildDoctorDeps with the resolved config path and runDoctor with its result, setting exitCode from the return value', async () => {
    let builtWithPath: string | undefined
    const fakeDoctorDeps = {} as DoctorDeps
    const { deps } = testDeps({
      buildDoctorDeps: (configPath: string) => {
        builtWithPath = configPath
        return fakeDoctorDeps
      },
      runDoctor: async (doctorDeps: DoctorDeps) => {
        expect(doctorDeps).toBe(fakeDoctorDeps)
        return 1
      },
    })

    await mainWith(['doctor', '--config', '/custom.toml'], deps)

    expect(builtWithPath).toBe('/custom.toml')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('never opens a full CLI context for doctor', async () => {
    let contextOpened = false
    const { deps } = testDeps({
      openCliContext: async () => {
        contextOpened = true
        throw new Error('should not be called')
      },
      buildDoctorDeps: () => ({}) as DoctorDeps,
      runDoctor: async () => 0,
    })

    await mainWith(['doctor'], deps)

    expect(contextOpened).toBe(false)
    process.exitCode = 0
  })
})

describe('mainWith migrate', () => {
  it('migrate --config rewrites the named config file, not the default one', async () => {
    let readConfigMemoryDirCalledWith: string | undefined
    let runMigrateDepConfigPath: string | undefined
    const { deps } = testDeps({
      readConfigMemoryDir: async (path: string) => {
        readConfigMemoryDirCalledWith = path
        return '/fake/memory'
      },
      runMigrate: async (_args, migrateDeps) => {
        runMigrateDepConfigPath = migrateDeps.configPath
        await migrateDeps.readMemoryDir()
        return 0
      },
    })

    await mainWith(['migrate', '--config', '/custom.toml'], deps)

    expect(readConfigMemoryDirCalledWith).toBe('/custom.toml')
    expect(runMigrateDepConfigPath).toBe('/custom.toml')
    process.exitCode = 0
  })

  it('migrate --dry-run reaches runMigrate instead of being rejected as an unknown option', async () => {
    let runMigrateCalledWith: string[] | undefined
    const { deps } = testDeps({
      runMigrate: async (args) => {
        runMigrateCalledWith = args
        return 0
      },
    })

    await mainWith(['migrate', '--dry-run'], deps)

    expect(runMigrateCalledWith).toEqual(['--dry-run'])
    process.exitCode = 0
  })

  it('migrate --list reaches runMigrate instead of being rejected as an unknown option', async () => {
    let runMigrateCalledWith: string[] | undefined
    const { deps } = testDeps({
      runMigrate: async (args) => {
        runMigrateCalledWith = args
        return 0
      },
    })

    await mainWith(['migrate', '--list'], deps)

    expect(runMigrateCalledWith).toEqual(['--list'])
    process.exitCode = 0
  })
})

describe('mainWith chat interrupt exit code', () => {
  it('sets exitCode 4 when runChat reports interrupted: true', async () => {
    const dir = '/fake/memory'
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: { warnings: [], close: async () => {} } as never,
        config: { memoryDir: dir, safety: { mode: 'companion' } } as never,
        chat: {} as never,
      }),
      runChat: async () => ({ interrupted: true }),
    })

    await mainWith([], deps)

    expect(process.exitCode).toBe(4)
    process.exitCode = 0
  })

  it('leaves exitCode unset (0) when runChat reports interrupted: false', async () => {
    const dir = '/fake/memory'
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: { warnings: [], close: async () => {} } as never,
        config: { memoryDir: dir, safety: { mode: 'companion' } } as never,
        chat: {} as never,
      }),
      runChat: async () => ({ interrupted: false }),
    })

    await mainWith([], deps)

    expect(process.exitCode).toBe(0)
  })
})

describe('mainWith exit code 3 on a live failure during reindex/reflect/chat', () => {
  it('exits 3 and writes the error message when reindexAll throws', async () => {
    const { deps, output } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: {
          warnings: [],
          reindexAll: async () => {
            throw new Error('embedding provider unreachable')
          },
          close: async () => {},
        } as never,
        config: { memoryDir: '/fake/memory' } as never,
        chat: {} as never,
      }),
    })

    await mainWith(['reindex'], deps)

    expect(output()).toContain('embedding provider unreachable')
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })

  it('exits 3 when runMaintenance throws during reflect', async () => {
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: {
          warnings: [],
          runMaintenance: async () => {
            throw new Error('reflection model unreachable')
          },
          close: async () => {},
        } as never,
        config: { memoryDir: '/fake/memory' } as never,
        chat: {} as never,
      }),
    })

    await mainWith(['reflect'], deps)

    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })

  it('still closes the engine when reindexAll throws', async () => {
    let closed = false
    const { deps } = testDeps({
      openCliContext: async () => ({
        ok: true,
        engine: {
          warnings: [],
          reindexAll: async () => {
            throw new Error('boom')
          },
          close: async () => {
            closed = true
          },
        } as never,
        config: { memoryDir: '/fake/memory' } as never,
        chat: {} as never,
      }),
    })

    await mainWith(['reindex'], deps)

    expect(closed).toBe(true)
    process.exitCode = 0
  })
})
