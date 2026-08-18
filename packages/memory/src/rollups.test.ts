import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeChatProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, readDocument, writeDocumentAtomic } from './documents.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import {
  buildDailyRollup,
  buildWeeklyRollup,
  isoMondayOf,
  isoSundayOf,
  isoWeekOf,
  pendingDailyRollups,
  pendingWeeklyRollups,
  type RollupDeps,
} from './rollups.js'

describe('isoWeekOf', () => {
  const boundaryCases: Array<[string, string]> = [
    ['2021-01-01', '2020-W53'],
    ['2022-12-31', '2022-W52'],
    ['2023-01-01', '2022-W52'],
    ['2024-12-30', '2025-W01'],
    ['2025-01-01', '2025-W01'],
    ['2026-01-01', '2026-W01'],
    ['2026-08-13', '2026-W33'],
    ['2027-01-01', '2026-W53'],
    ['2016-01-03', '2015-W53'],
  ]

  it.each(boundaryCases)('maps %s to %s', (date, expected) => {
    expect(isoWeekOf(date)).toBe(expected)
  })

  it('only changes label on Mondays across 2022 through 2024', () => {
    const start = Date.UTC(2022, 0, 1)
    const end = Date.UTC(2024, 11, 31)
    let previousLabel: string | null = null
    for (let t = start; t <= end; t += 86400000) {
      const d = new Date(t)
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
      const label = isoWeekOf(dateStr)
      if (previousLabel !== null && label !== previousLabel) {
        expect(d.getUTCDay()).toBe(1)
      }
      previousLabel = label
    }
  })

  it('places December 28th in that same year final ISO week for every year 2015 through 2030', () => {
    for (let year = 2015; year <= 2030; year++) {
      const dateStr = `${year}-12-28`
      const label = isoWeekOf(dateStr)
      const match = label.match(/^(\d{4})-W(\d{2})$/)
      expect(match).not.toBeNull()
      const [, isoYearStr, weekStr] = match as RegExpMatchArray
      expect(Number(isoYearStr)).toBe(year)
      const week = Number(weekStr)
      expect(week === 52 || week === 53).toBe(true)
    }
  })
})

describe('pendingDailyRollups', () => {
  it('flags a date strictly before today with a session and no daily rollup', () => {
    const result = pendingDailyRollups(['2026-08-10'], [], '2026-08-13')
    expect(result).toEqual(['2026-08-10'])
  })

  it('never flags today, even with sessions', () => {
    const result = pendingDailyRollups(['2026-08-13'], [], '2026-08-13')
    expect(result).toEqual([])
  })

  it('skips a date that already has a daily rollup', () => {
    const result = pendingDailyRollups(['2026-08-10'], ['2026-08-10'], '2026-08-13')
    expect(result).toEqual([])
  })

  it('skips a date with no sessions at all', () => {
    const result = pendingDailyRollups([], [], '2026-08-13')
    expect(result).toEqual([])
  })

  it('deduplicates multiple sessions on the same date', () => {
    const result = pendingDailyRollups(['2026-08-10', '2026-08-10', '2026-08-10'], [], '2026-08-13')
    expect(result).toEqual(['2026-08-10'])
  })

  it('sorts results ascending', () => {
    const result = pendingDailyRollups(['2026-08-11', '2026-08-09', '2026-08-10'], [], '2026-08-13')
    expect(result).toEqual(['2026-08-09', '2026-08-10', '2026-08-11'])
  })

  it('never flags a date after today', () => {
    const result = pendingDailyRollups(['2026-08-14'], [], '2026-08-13')
    expect(result).toEqual([])
  })
})

describe('pendingWeeklyRollups', () => {
  it('flags an ISO week strictly before the week of today with a daily rollup and no weekly rollup', () => {
    // 2026-08-03 is in ISO week 2026-W32, today 2026-08-13 is in 2026-W33.
    const result = pendingWeeklyRollups(['2026-08-03'], [], '2026-08-13')
    expect(result).toEqual(['2026-W32'])
  })

  it('never flags the ISO week of today, even with a daily rollup dated before today', () => {
    // 2026-08-10 is in the same ISO week as today (2026-08-13), which is 2026-W33.
    const result = pendingWeeklyRollups(['2026-08-10'], [], '2026-08-13')
    expect(result).toEqual([])
  })

  it('skips a week that already has a weekly rollup', () => {
    const result = pendingWeeklyRollups(['2026-08-03'], ['2026-W32'], '2026-08-13')
    expect(result).toEqual([])
  })

  it('deduplicates multiple dailies in the same ISO week', () => {
    const result = pendingWeeklyRollups(
      ['2026-08-03', '2026-08-04', '2026-08-05'],
      [],
      '2026-08-13',
    )
    expect(result).toEqual(['2026-W32'])
  })

  it('sorts results ascending across a year boundary', () => {
    // 2025-12-31 -> 2026-W01, 2026-08-03 -> 2026-W32.
    const result = pendingWeeklyRollups(['2026-08-03', '2025-12-31'], [], '2026-08-13')
    expect(result).toEqual(['2026-W01', '2026-W32'])
  })

  it('handles a week spanning a year boundary correctly against today in the new year', () => {
    // 2025-12-31 is ISO week 2026-W01. If today is early in 2026-W02, that week is strictly before.
    const result = pendingWeeklyRollups(['2025-12-31'], [], '2026-01-08')
    expect(result).toEqual(['2026-W01'])
  })
})

describe('buildDailyRollup', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeSummary(date: string, sessionId: string, body: string): Promise<void> {
    const sessionDir = join(paths.sessionsDir, `${date}-${sessionId}`)
    await mkdir(sessionDir, { recursive: true })
    await writeDocumentAtomic({
      path: join(sessionDir, 'summary.md'),
      meta: { id: newId('doc') },
      body,
    })
  }

  it('writes the daily rollup with the fake text and correct meta, prompting with the summaries', async () => {
    await writeSummary('2026-08-10', 'session_aaa', 'Went for a long walk and felt calm.')
    await writeSummary('2026-08-10', 'session_bbb', 'Argued with a friend, then made up.')

    const chat = new FakeChatProvider([
      { text: 'A quiet day of walking and mending a friendship.', toolCalls: [] },
    ])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    const doc = await buildDailyRollup(deps, '2026-08-10')

    expect(doc.path).toBe(join(paths.rollupsDailyDir, '2026-08-10.md'))
    expect(doc.meta.kind).toBe('rollup_daily')
    expect(doc.meta.date).toBe('2026-08-10')
    expect(typeof doc.meta.id).toBe('string')
    expect(doc.body).toBe('A quiet day of walking and mending a friendship.\n')

    const onDisk = await readDocument(doc.path)
    expect(onDisk.meta).toEqual(doc.meta)
    expect(onDisk.body).toBe(doc.body)

    expect(chat.requests).toHaveLength(1)
    const sentContent = chat.requests[0]?.messages.map((m) => m.content).join('\n')
    expect(sentContent).toContain('Went for a long walk and felt calm.')
    expect(sentContent).toContain('Argued with a friend, then made up.')
  })

  it('throws when the date has no sessions at all', async () => {
    const chat = new FakeChatProvider([])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await expect(buildDailyRollup(deps, '2026-08-10')).rejects.toThrow()
  })

  it('throws when the date has sessions but none are reflected yet', async () => {
    const sessionDir = join(paths.sessionsDir, '2026-08-10-session_ccc')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'transcript.jsonl'), '', 'utf8')

    const chat = new FakeChatProvider([])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await expect(buildDailyRollup(deps, '2026-08-10')).rejects.toThrow(
      'No reflected session summaries found for 2026-08-10',
    )
    expect(chat.requests).toHaveLength(0)
  })

  it('does not pull in a session summary from a different date', async () => {
    await writeSummary('2026-08-10', 'session_aaa', 'On the target date.')
    await writeSummary('2026-08-11', 'session_bbb', 'On a different date, should not be included.')

    const chat = new FakeChatProvider([{ text: 'Rollup text.', toolCalls: [] }])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await buildDailyRollup(deps, '2026-08-10')

    const sentContent = chat.requests[0]?.messages.map((m) => m.content).join('\n')
    expect(sentContent).toContain('On the target date.')
    expect(sentContent).not.toContain('On a different date')
  })

  async function writeSkippedSummary(date: string, sessionId: string): Promise<void> {
    const sessionDir = join(paths.sessionsDir, `${date}-${sessionId}`)
    await mkdir(sessionDir, { recursive: true })
    await writeDocumentAtomic({
      path: join(sessionDir, 'summary.md'),
      meta: { id: newId('doc'), skipped: true, reason: 'no user messages in this session' },
      body: 'This session had no user messages, so there was nothing to reflect on.\n',
    })
  }

  it('excludes a skipped session summary from the day it synthesizes', async () => {
    await writeSummary('2026-08-10', 'session_aaa', 'Real content for the day.')
    await writeSkippedSummary('2026-08-10', 'session_skipped')

    const chat = new FakeChatProvider([{ text: 'Rollup text.', toolCalls: [] }])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await buildDailyRollup(deps, '2026-08-10')

    const sentContent = chat.requests[0]?.messages.map((m) => m.content).join('\n')
    expect(sentContent).toContain('Real content for the day.')
    expect(sentContent).not.toContain('nothing to reflect on')
  })

  it('throws when the date has only a skipped session, the same as having nothing to roll up', async () => {
    await writeSkippedSummary('2026-08-10', 'session_skipped')

    const chat = new FakeChatProvider([])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await expect(buildDailyRollup(deps, '2026-08-10')).rejects.toThrow(
      'No reflected session summaries found for 2026-08-10',
    )
    expect(chat.requests).toHaveLength(0)
  })
})

describe('buildWeeklyRollup', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeDaily(date: string, body: string): Promise<void> {
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, `${date}.md`),
      meta: { id: newId('doc'), kind: 'rollup_daily', date },
      body,
    })
  }

  it('writes the weekly rollup with the fake text and correct meta, prompting with the dailies', async () => {
    await writeDaily('2026-08-03', 'Started the week tired but hopeful.')
    await writeDaily('2026-08-05', 'A breakthrough at work, felt proud.')

    const chat = new FakeChatProvider([
      { text: 'A week of tiredness turning into pride.', toolCalls: [] },
    ])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    const doc = await buildWeeklyRollup(deps, '2026-W32')

    expect(doc.path).toBe(join(paths.rollupsWeeklyDir, '2026-W32.md'))
    expect(doc.meta.kind).toBe('rollup_weekly')
    expect(doc.meta.week).toBe('2026-W32')
    expect(typeof doc.meta.id).toBe('string')
    expect(doc.body).toBe('A week of tiredness turning into pride.\n')

    const onDisk = await readDocument(doc.path)
    expect(onDisk.meta).toEqual(doc.meta)
    expect(onDisk.body).toBe(doc.body)

    expect(chat.requests).toHaveLength(1)
    const sentContent = chat.requests[0]?.messages.map((m) => m.content).join('\n')
    expect(sentContent).toContain('Started the week tired but hopeful.')
    expect(sentContent).toContain('A breakthrough at work, felt proud.')
  })

  it('only includes dailies that fall in the requested week', async () => {
    await writeDaily('2026-08-03', 'In week 32.')
    await writeDaily('2026-08-10', 'In week 33, should not be included.')

    const chat = new FakeChatProvider([{ text: 'Rollup text.', toolCalls: [] }])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await buildWeeklyRollup(deps, '2026-W32')

    const sentContent = chat.requests[0]?.messages.map((m) => m.content).join('\n')
    expect(sentContent).toContain('In week 32.')
    expect(sentContent).not.toContain('In week 33')
  })

  it('throws when the week has no daily rollups', async () => {
    const chat = new FakeChatProvider([])
    const deps: RollupDeps = { chat, model: 'test-model', paths }

    await expect(buildWeeklyRollup(deps, '2026-W32')).rejects.toThrow()
  })
})

describe('isoMondayOf and isoSundayOf', () => {
  it('returns the Monday and Sunday of an ordinary mid-year week', () => {
    expect(isoMondayOf('2026-W33')).toBe('2026-08-10')
    expect(isoSundayOf('2026-W33')).toBe('2026-08-16')
    expect(isoMondayOf('2026-W32')).toBe('2026-08-03')
    expect(isoSundayOf('2026-W32')).toBe('2026-08-09')
  })

  it('handles weeks whose Monday falls in the previous calendar year', () => {
    // 2026-W01 starts on Monday 2025-12-29. A naive
    // "January 1st plus (week - 1) times seven days" calculation gets
    // this wrong by several days.
    expect(isoMondayOf('2026-W01')).toBe('2025-12-29')
    expect(isoSundayOf('2026-W01')).toBe('2026-01-04')
    expect(isoMondayOf('2025-W01')).toBe('2024-12-30')
    expect(isoSundayOf('2025-W01')).toBe('2025-01-05')
  })

  it('handles a 53-week year whose last week ends in the next calendar year', () => {
    // 2026 is a 53-week ISO year: 2026-W53 runs Monday 2026-12-28
    // through Sunday 2027-01-03.
    expect(isoMondayOf('2026-W53')).toBe('2026-12-28')
    expect(isoSundayOf('2026-W53')).toBe('2027-01-03')
  })

  it('round-trips against isoWeekOf for every day across four years', () => {
    const start = Date.UTC(2024, 0, 1)
    const end = Date.UTC(2027, 11, 31)
    for (let t = start; t <= end; t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10)
      const week = isoWeekOf(date)
      const monday = isoMondayOf(week)
      const sunday = isoSundayOf(week)
      expect(isoWeekOf(monday)).toBe(week)
      expect(isoWeekOf(sunday)).toBe(week)
      expect(monday <= date).toBe(true)
      expect(date <= sunday).toBe(true)
    }
  })

  it('rejects a malformed week identifier', () => {
    expect(() => isoMondayOf('2026-33')).toThrow(/expected a YYYY-Www week id/)
    expect(() => isoMondayOf('not-a-week')).toThrow(/expected a YYYY-Www week id/)
    expect(() => isoSundayOf('2026-W00')).toThrow(/week number out of range/)
  })
})
