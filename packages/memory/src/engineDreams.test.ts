import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendDreamLog } from './dreamLog.js'
import { computeDreamStatus, type DreamingSettings } from './engineDreams.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

// 2026-08-24 is a Monday, pinned explicitly with an explicit timezone
// throughout (see AGENTS.md's own recorded incidents about tests whose
// correctness quietly depended on the machine's local timezone).
const NOW = new Date('2026-08-24T12:00:00.000Z')

const dreamingOn: DreamingSettings = {
  enabled: true,
  cadence: 'daily',
  triggers: { afterSession: true, onStart: true, serverTimer: true },
  maxToolCalls: 10,
}

describe('computeDreamStatus', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-dreamstatus-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports not configured when dreaming has no deps wired at all', async () => {
    const status = await computeDreamStatus(paths, undefined, undefined, 'UTC', NOW)
    expect(status.configured).toBe(false)
    expect(status.enabled).toBe(false)
    expect(status.due).toBe(false)
  })

  it('reports enabled, the resolved model, the period, and an unmet reflected-session floor on a fresh folder', async () => {
    const status = await computeDreamStatus(paths, dreamingOn, 'gpt-5', 'UTC', NOW)
    expect(status.configured).toBe(true)
    expect(status.enabled).toBe(true)
    expect(status.model).toBe('gpt-5')
    expect(status.period).toBe('2026-08-24')
    expect(status.periodCovered).toBe(false)
    expect(status.reflectedSessionCount).toBe(0)
    expect(status.reflectedFloorMet).toBe(false)
    expect(status.due).toBe(false)
    expect(status.lastAttempt).toBeUndefined()
  })

  it('reports disabled as not due even when nothing else blocks it', async () => {
    const status = await computeDreamStatus(
      paths,
      { ...dreamingOn, enabled: false },
      'gpt-5',
      'UTC',
      NOW,
    )
    expect(status.enabled).toBe(false)
    expect(status.due).toBe(false)
  })

  it('surfaces the most recent attempt record as the last-failure reason', async () => {
    await appendDreamLog(paths, [
      {
        ts: '2026-08-24T02:00:00.000Z',
        type: 'attempt',
        period: '2026-08-24',
        trigger: 'onStart',
        outcome: 'failed',
        reason: 'openai: HTTP 400: Function tools with reasoning_effort are not supported',
      },
    ])
    const status = await computeDreamStatus(paths, dreamingOn, 'gpt-5.6-luna', 'UTC', NOW)
    expect(status.lastAttempt?.outcome).toBe('failed')
    expect(status.lastAttempt?.reason).toContain('Function tools with reasoning_effort')
  })
})
