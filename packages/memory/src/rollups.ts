// Pending-rollup date logic (pure) and LLM rollup builders.
//
// The pure functions below decide which daily and weekly rollups are due.
// They never touch the filesystem or a provider; callers supply the raw
// date lists (from session dirs, existing rollup files) and get back the
// dates or ISO weeks that still need a rollup written.

import { join } from 'node:path'
import type { ChatProvider } from '@openreverie/providers'
import {
  type Document,
  listDocuments,
  newId,
  readDocument,
  writeDocumentAtomic,
} from './documents.js'
import type { MemoryPaths } from './paths.js'
import { SessionStore } from './transcripts.js'

// --- Pure functions ---

/**
 * Convert a date string (YYYY-MM-DD) to its ISO 8601 week identifier
 * (YYYY-Www). Week 1 is the week containing the year's first Thursday;
 * weeks run Monday to Sunday. A date near a year boundary can belong to
 * the ISO week of the adjacent calendar year.
 */
export function isoWeekOf(date: string): string {
  const parts = date.split('-').map(Number)
  const year = parts[0]
  const month = parts[1]
  const day = parts[2]
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`isoWeekOf: expected a YYYY-MM-DD date, got "${date}"`)
  }
  const target = new Date(Date.UTC(year, month - 1, day))

  // ISO day number: Monday = 1 .. Sunday = 7 (getUTCDay() gives 0 for Sunday).
  const isoDayNum = target.getUTCDay() || 7
  // Move to the Thursday of this ISO week; the Thursday's calendar year
  // is always the ISO week-numbering year.
  target.setUTCDate(target.getUTCDate() + (4 - isoDayNum))

  const isoYear = target.getUTCFullYear()
  const weekNumber = Math.ceil(((target.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7)

  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`
}

/**
 * Dates strictly before `today` that have at least one session and no
 * daily rollup yet, sorted ascending. `today` itself is never pending,
 * regardless of how many sessions it has.
 */
export function pendingDailyRollups(
  sessionDates: string[],
  existingDailies: string[],
  today: string,
): string[] {
  const covered = new Set(existingDailies)
  const pending = new Set(sessionDates.filter((date) => date < today && !covered.has(date)))
  return [...pending].sort()
}

/**
 * ISO weeks strictly before the ISO week of `today` that have at least
 * one daily rollup and no weekly rollup yet, sorted ascending. Comparison
 * is done on the ISO week identifier, not the raw date, so a daily in the
 * same week as `today` is never pending even if its date is earlier.
 */
export function pendingWeeklyRollups(
  dailyDates: string[],
  existingWeeklies: string[],
  today: string,
): string[] {
  const todayWeek = isoWeekOf(today)
  const covered = new Set(existingWeeklies)
  const pending = new Set<string>()
  for (const date of dailyDates) {
    const week = isoWeekOf(date)
    if (week < todayWeek && !covered.has(week)) {
      pending.add(week)
    }
  }
  return [...pending].sort()
}

// --- LLM rollup builders ---

export interface RollupDeps {
  chat: ChatProvider
  model: string
  paths: MemoryPaths
}

const DAILY_ROLLUP_PROMPT =
  "Synthesize this day in this person's life into a short honest rollup: what happened, what they felt, what moved. Plain prose, no headings, no em dashes."

const WEEKLY_ROLLUP_PROMPT =
  "Synthesize this week in this person's life into a short honest rollup: what happened, what they felt, what moved. Plain prose, no headings, no em dashes."

/**
 * Build the daily rollup for `date`: read every reflected session's
 * summary from that date, ask the chat provider to synthesize them, and
 * write the result to rollups/daily/<date>.md. Throws if the date has no
 * reflected session to draw from; callers are expected to only pass dates
 * that pendingDailyRollups reported, which always have sources.
 */
export async function buildDailyRollup(deps: RollupDeps, date: string): Promise<Document> {
  const sessions = await SessionStore.listSessions(deps.paths)
  // A skipped session has no content to synthesize: excluded here too,
  // defensively, even though the caller (MemoryEngine.runMaintenance) is
  // expected to never pass a date whose only sessions are skipped.
  const daySessions = sessions.filter(
    (session) => session.date === date && session.reflected && !session.skipped,
  )
  if (daySessions.length === 0) {
    throw new Error(
      `No reflected session summaries found for ${date}; cannot build a daily rollup.`,
    )
  }

  const summaries: string[] = []
  for (const session of daySessions) {
    const summaryPath = join(
      deps.paths.sessionsDir,
      `${session.date}-${session.sessionId}`,
      'summary.md',
    )
    const summary = await readDocument(summaryPath)
    summaries.push(summary.body.trim())
  }

  const result = await deps.chat.complete({
    model: deps.model,
    system: DAILY_ROLLUP_PROMPT,
    messages: [{ role: 'user', content: summaries.join('\n\n') }],
  })

  const path = join(deps.paths.rollupsDailyDir, `${date}.md`)
  await writeDocumentAtomic({
    path,
    meta: { id: newId('doc'), kind: 'rollup_daily', date },
    body: result.text,
  })
  return readDocument(path)
}

/**
 * Build the weekly rollup for `week` (an ISO week identifier, e.g.
 * 2026-W32): read every daily rollup whose date falls in that week, ask
 * the chat provider to synthesize them, and write the result to
 * rollups/weekly/<week>.md. Throws if the week has no daily rollup to
 * draw from; callers are expected to only pass weeks that
 * pendingWeeklyRollups reported, which always have sources.
 */
export async function buildWeeklyRollup(deps: RollupDeps, week: string): Promise<Document> {
  const dailies = await listDocuments(deps.paths.rollupsDailyDir)
  const weekDailies = dailies.filter(
    (doc) => typeof doc.meta.date === 'string' && isoWeekOf(doc.meta.date) === week,
  )
  if (weekDailies.length === 0) {
    throw new Error(`No daily rollups found for week ${week}; cannot build a weekly rollup.`)
  }

  const bodies = weekDailies.map((doc) => doc.body.trim())

  const result = await deps.chat.complete({
    model: deps.model,
    system: WEEKLY_ROLLUP_PROMPT,
    messages: [{ role: 'user', content: bodies.join('\n\n') }],
  })

  const path = join(deps.paths.rollupsWeeklyDir, `${week}.md`)
  await writeDocumentAtomic({
    path,
    meta: { id: newId('doc'), kind: 'rollup_weekly', week },
    body: result.text,
  })
  return readDocument(path)
}
