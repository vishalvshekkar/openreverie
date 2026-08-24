// Cadence names a period (a local day or ISO week), not a time. Every
// trigger asks one question: is the current period due? Missed periods are
// never backfilled (dreaming design spec, Scheduling).
import { readFile as readLockFile, rm as rmLock, writeFile as writeLock } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryPaths } from './paths.js'
import { isoWeekOf } from './rollups.js'
import { formatLocalDate } from './time.js'

export type DreamCadence = 'daily' | 'weekly'

export const MIN_REFLECTED_SESSIONS = 5

export function periodFor(now: Date, cadence: DreamCadence, timezone: string): string {
  const day = formatLocalDate(now, timezone)
  return cadence === 'daily' ? day : isoWeekOf(day)
}

export function periodCovered(
  existingDreamDates: string[],
  now: Date,
  cadence: DreamCadence,
  timezone: string,
): boolean {
  const current = periodFor(now, cadence, timezone)
  return existingDreamDates.some((date) =>
    cadence === 'daily' ? date === current : isoWeekOf(date) === current,
  )
}

export function dreamIsDue(check: {
  enabled: boolean
  cadence: DreamCadence
  timezone: string
  reflectedSessionCount: number
  existingDreamDates: string[]
  now: Date
}): boolean {
  if (!check.enabled) return false
  if (check.reflectedSessionCount < MIN_REFLECTED_SESSIONS) return false
  return !periodCovered(check.existingDreamDates, check.now, check.cadence, check.timezone)
}

export const DREAM_LOCK_STALE_MS = 15 * 60 * 1000

function lockPath(paths: MemoryPaths): string {
  return join(paths.dreamsDir, '.lock')
}

export async function acquireDreamLock(paths: MemoryPaths, now: Date): Promise<boolean> {
  const payload = JSON.stringify({ ts: now.toISOString(), pid: process.pid })
  try {
    await writeLock(lockPath(paths), payload, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  try {
    const existing = JSON.parse(await readLockFile(lockPath(paths), 'utf8')) as { ts?: string }
    const age = now.getTime() - Date.parse(existing.ts ?? '')
    if (Number.isNaN(age) || age > DREAM_LOCK_STALE_MS) {
      await rmLock(lockPath(paths), { force: true })
      await writeLock(lockPath(paths), payload, { encoding: 'utf8', flag: 'wx' })
      return true
    }
  } catch {
    return false
  }
  return false
}

export async function releaseDreamLock(paths: MemoryPaths): Promise<void> {
  await rmLock(lockPath(paths), { force: true })
}
