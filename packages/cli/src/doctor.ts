// `reverie doctor`: six independent, read-only checks of whether reverie
// is set up correctly. Never opens a MemoryEngine, never calls
// runMaintenance (so it is never itself a source of git-subprocess side
// effects), never constructs a ChatProvider, never makes a network call,
// and never prints a secret value. See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 1.4.
//
// The dreaming check (added 2026-08-25) reads computeDreamStatus, a pure
// function over paths in @openreverie/memory: it does not open a
// MemoryEngine either, just the same handful of file reads (dreamsDir,
// sessionsDir, the dream log) an engine would make internally.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  loadConfig,
  type ReverieConfig,
  resolveApiKey,
  resolveDreamingModel,
} from '@openreverie/core'
import {
  computeDreamStatus,
  type DreamStatus,
  loadProfile,
  MemoryIndex,
  memoryPaths,
  nodeStores,
  systemTimeZone,
} from '@openreverie/memory'

const run = promisify(execFile)

export type CheckStatus = 'ok' | 'fail' | 'skip'

const CHECK_LABEL_WIDTH = 20

export function formatCheckLine(label: string, status: CheckStatus, detail: string): string {
  const dots = '.'.repeat(Math.max(3, CHECK_LABEL_WIDTH - label.length))
  const statusColumn = status.padEnd(5)
  return `${label} ${dots} ${statusColumn}${detail}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface DoctorDeps {
  configPath: string
  loadConfig: (path: string) => Promise<ReverieConfig>
  isDirectory: (path: string) => Promise<boolean>
  isFile: (path: string) => Promise<boolean>
  probeWritable: (dir: string) => Promise<boolean>
  gitStatusPorcelain: (root: string) => Promise<string>
  gitCommitCount: (root: string) => Promise<number | undefined>
  openIndex: (path: string) => { close(): void }
  dreamStatus: (config: ReverieConfig) => Promise<DreamStatus>
  write: (text: string) => void
}

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const lines: string[] = []
  let failCount = 0

  let config: ReverieConfig | undefined
  const configExists = await deps.isFile(deps.configPath)
  if (!configExists) {
    lines.push(
      formatCheckLine(
        'config file',
        'fail',
        `no config file at ${deps.configPath}. Run: reverie setup`,
      ),
    )
    failCount += 1
  } else {
    try {
      config = await deps.loadConfig(deps.configPath)
      lines.push(formatCheckLine('config file', 'ok', `(${deps.configPath})`))
    } catch (err) {
      lines.push(formatCheckLine('config file', 'fail', errorMessage(err)))
      failCount += 1
    }
  }

  if (config === undefined) {
    lines.push(formatCheckLine('api key', 'skip', 'config failed to load; cannot resolve a key'))
  } else {
    try {
      resolveApiKey(config)
      const detail =
        config.provider.apiKey !== undefined
          ? '(configured directly in config file)'
          : `(resolved via ${config.provider.apiKeyEnv})`
      lines.push(formatCheckLine('api key', 'ok', detail))
    } catch (err) {
      lines.push(formatCheckLine('api key', 'fail', errorMessage(err)))
      failCount += 1
    }
  }

  let memoryFolderOk = false
  if (config === undefined) {
    lines.push(
      formatCheckLine(
        'memory folder',
        'skip',
        'config failed to load; cannot check the memory folder',
      ),
    )
  } else {
    const exists = await deps.isDirectory(config.memoryDir)
    if (!exists) {
      lines.push(
        formatCheckLine(
          'memory folder',
          'fail',
          `${config.memoryDir} does not exist. Run: reverie setup`,
        ),
      )
      failCount += 1
    } else {
      const writable = await deps.probeWritable(config.memoryDir)
      if (!writable) {
        lines.push(formatCheckLine('memory folder', 'fail', `${config.memoryDir} is not writable`))
        failCount += 1
      } else {
        memoryFolderOk = true
        lines.push(formatCheckLine('memory folder', 'ok', `(${config.memoryDir}, writable)`))
      }
    }
  }

  if (!memoryFolderOk || config === undefined) {
    lines.push(
      formatCheckLine(
        'memory folder git',
        'skip',
        'memory folder check failed; cannot check git state',
      ),
    )
  } else {
    const hasGit = await deps.isDirectory(join(config.memoryDir, '.git'))
    if (!hasGit) {
      lines.push(formatCheckLine('memory folder git', 'ok', '(created on first reflect or /bye)'))
    } else {
      const status = await deps.gitStatusPorcelain(config.memoryDir)
      const count = await deps.gitCommitCount(config.memoryDir)
      const detail =
        count === undefined
          ? '(initialized, no commits yet)'
          : `(${status.trim().length === 0 ? 'clean' : 'dirty'}, ${count} commit${count === 1 ? '' : 's'})`
      lines.push(formatCheckLine('memory folder git', 'ok', detail))
    }
  }

  if (config === undefined) {
    lines.push(
      formatCheckLine('sqlite index', 'skip', 'config failed to load; cannot check the index'),
    )
  } else {
    const indexPath = memoryPaths(config.memoryDir, nodeStores()).indexDb
    const exists = await deps.isFile(indexPath)
    if (!exists) {
      lines.push(formatCheckLine('sqlite index', 'fail', 'index.db missing; run: reverie reindex'))
      failCount += 1
    } else {
      try {
        deps.openIndex(indexPath).close()
        lines.push(formatCheckLine('sqlite index', 'ok', '(present, rebuildable)'))
      } catch (err) {
        lines.push(
          formatCheckLine(
            'sqlite index',
            'fail',
            `index.db exists but failed to open: ${errorMessage(err)}`,
          ),
        )
        failCount += 1
      }
    }
  }

  if (config === undefined) {
    lines.push(formatCheckLine('dreaming', 'skip', 'config failed to load; cannot check dreaming'))
  } else if (!config.dreaming.enabled) {
    lines.push(
      formatCheckLine(
        'dreaming',
        'ok',
        '(disabled; opt in with [dreaming] enabled = true in your config file)',
      ),
    )
  } else {
    const status = await deps.dreamStatus(config)
    const detailParts = [
      `cadence ${status.cadence}`,
      `model ${status.model ?? 'none configured'}`,
      `${status.reflectedSessionCount}/${status.minReflectedSessions} reflected sessions`,
      `period ${status.period} ${status.periodCovered ? 'covered' : 'not yet covered'}`,
    ]
    if (status.lastAttempt !== undefined) {
      detailParts.push(
        `last attempt (${status.lastAttempt.trigger}, ${status.lastAttempt.outcome}): ${status.lastAttempt.reason}`,
      )
    }
    // Dreaming is due right now (enabled, floor met, period uncovered) and
    // the last real attempt was a hard failure, with nothing having
    // succeeded since: this is the state the 2026-08-25 investigation
    // found a real user stuck in indefinitely (a model that rejects
    // function tools, silently, forever). An aborted attempt (a pipeline
    // decision, like zero insights surviving evidence resolution) is not
    // treated as broken the same way: it is a real, working run that
    // simply produced nothing that one time.
    const stuck = status.due && status.lastAttempt?.outcome === 'failed'
    lines.push(formatCheckLine('dreaming', stuck ? 'fail' : 'ok', `(${detailParts.join('; ')})`))
    if (stuck) failCount += 1
  }

  const totalChecks = 6
  deps.write('reverie doctor\n\n')
  for (const line of lines) deps.write(`${line}\n`)
  deps.write('\n')
  deps.write(
    failCount === 0 ? 'All checks passed.\n' : `${failCount} of ${totalChecks} checks failed.\n`,
  )

  return failCount === 0 ? 0 : 1
}

export function buildRealDoctorDeps(configPath: string, write: (text: string) => void): DoctorDeps {
  return {
    configPath,
    loadConfig,
    write,
    isDirectory: async (path: string) => {
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    },
    isFile: async (path: string) => {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    },
    probeWritable: async (dir: string) => {
      const probePath = join(dir, `.reverie-doctor-probe-${randomBytes(4).toString('hex')}`)
      try {
        await writeFile(probePath, 'probe', 'utf8')
        await unlink(probePath)
        return true
      } catch {
        return false
      }
    },
    gitStatusPorcelain: async (root: string) => {
      const { stdout } = await run('git', ['-c', 'gc.auto=0', 'status', '--porcelain'], {
        cwd: root,
      })
      return stdout
    },
    gitCommitCount: async (root: string) => {
      try {
        const { stdout } = await run('git', ['-c', 'gc.auto=0', 'rev-list', '--count', 'HEAD'], {
          cwd: root,
        })
        return Number.parseInt(stdout.trim(), 10)
      } catch {
        return undefined
      }
    },
    openIndex: (path: string) => MemoryIndex.open(path),
    dreamStatus: async (config: ReverieConfig) => {
      const paths = memoryPaths(config.memoryDir, nodeStores())
      // Mirrors MemoryEngine.timezone()'s own fallback, without opening an
      // engine: profile.md's confirmed timezone when there is one, the
      // system zone otherwise.
      let timezone = systemTimeZone()
      try {
        const profile = await loadProfile(paths, timezone)
        if (typeof profile.meta.timezone === 'string' && profile.meta.timezone.length > 0) {
          timezone = profile.meta.timezone
        }
      } catch {
        // No profile.md yet, or it does not parse: system zone stands.
      }
      return computeDreamStatus(
        paths,
        config.dreaming,
        resolveDreamingModel(config),
        timezone,
        new Date(),
      )
    },
  }
}
