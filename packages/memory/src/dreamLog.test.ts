import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendDreamLog, type DreamLogRecord, foldDreamLog, readDreamLog } from './dreamLog.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

describe('dream log', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-dreamlog-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const dreamt: DreamLogRecord = {
    ts: '2026-08-24T02:00:00.000Z',
    type: 'dreamt',
    dream: 'dream_01A',
    period: '2026-08-24',
    entities: ['arc_01X', 'person_01Y'],
  }
  const feedback: DreamLogRecord = {
    ts: '2026-08-24T09:00:00.000Z',
    type: 'feedback',
    insight: 'ins_01B',
    dream: 'dream_01A',
    verdict: 'wrong',
    source: 'ui',
  }

  it('round-trips records through append and read', async () => {
    await appendDreamLog(paths, [dreamt, feedback])
    expect(await readDreamLog(paths)).toEqual([dreamt, feedback])
  })

  it('returns an empty array when the log does not exist', async () => {
    expect(await readDreamLog(paths)).toEqual([])
  })

  it('rejects an invalid record at append time and writes nothing', async () => {
    const bad = { ...dreamt, entities: 'not-an-array' } as unknown as DreamLogRecord
    await expect(appendDreamLog(paths, [bad])).rejects.toThrow()
    expect(await readDreamLog(paths)).toEqual([])
  })

  it('folds: newest ts wins per entity, later feedback wins per insight, mentions collect', async () => {
    const later: DreamLogRecord = {
      ...dreamt,
      ts: '2026-08-25T02:00:00.000Z',
      dream: 'dream_01C',
      period: '2026-08-25',
      entities: ['arc_01X'],
    }
    const overturn: DreamLogRecord = {
      ...feedback,
      ts: '2026-08-26T09:00:00.000Z',
      verdict: 'right',
      source: 'tool',
    } as DreamLogRecord
    const mention: DreamLogRecord = {
      ts: '2026-08-25T08:00:00.000Z',
      type: 'mentioned',
      dream: 'dream_01C',
    }
    const state = foldDreamLog([dreamt, feedback, later, overturn, mention])
    expect(state.lastDreamt.get('arc_01X')).toBe('2026-08-25T02:00:00.000Z')
    expect(state.lastDreamt.get('person_01Y')).toBe('2026-08-24T02:00:00.000Z')
    expect(state.feedback.get('ins_01B')?.verdict).toBe('right')
    expect(state.mentioned.has('dream_01C')).toBe(true)
  })
})
