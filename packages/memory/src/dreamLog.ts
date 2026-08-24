// The dream log: append-only jsonl beside the dream directories. Records
// which entities each dream touched (coverage), feedback on insights, and
// opener mentions. Validated on write and on read, like graph.jsonl: a
// record that cannot parse back off disk can never be appended.
import { appendFile, readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { MemoryPaths } from './paths.js'

export type DreamVerdict = 'right' | 'wrong' | 'do_not_bring_up'

const dreamtSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('dreamt'),
  dream: z.string(),
  period: z.string(),
  entities: z.array(z.string()),
})

const feedbackSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('feedback'),
  insight: z.string(),
  dream: z.string(),
  verdict: z.enum(['right', 'wrong', 'do_not_bring_up']),
  note: z.string().optional(),
  source: z.enum(['ui', 'tool']),
})

const mentionedSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('mentioned'),
  dream: z.string(),
})

export const dreamLogRecordSchema = z.discriminatedUnion('type', [
  dreamtSchema,
  feedbackSchema,
  mentionedSchema,
])

export type DreamLogRecord = z.infer<typeof dreamLogRecordSchema>
export type DreamFeedbackRecord = z.infer<typeof feedbackSchema>

export async function appendDreamLog(paths: MemoryPaths, records: DreamLogRecord[]): Promise<void> {
  if (records.length === 0) return
  const lines = records.map((record) => JSON.stringify(dreamLogRecordSchema.parse(record)))
  await appendFile(paths.dreamLog, `${lines.join('\n')}\n`, 'utf8')
}

export async function readDreamLog(paths: MemoryPaths): Promise<DreamLogRecord[]> {
  let raw: string
  try {
    raw = await readFile(paths.dreamLog, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => dreamLogRecordSchema.parse(JSON.parse(line)))
}

export interface DreamLogState {
  lastDreamt: Map<string, string>
  feedback: Map<string, DreamFeedbackRecord>
  mentioned: Set<string>
}

export function foldDreamLog(records: DreamLogRecord[]): DreamLogState {
  const state: DreamLogState = { lastDreamt: new Map(), feedback: new Map(), mentioned: new Set() }
  for (const record of records) {
    if (record.type === 'dreamt') {
      for (const entity of record.entities) {
        const previous = state.lastDreamt.get(entity)
        if (previous === undefined || record.ts > previous) {
          state.lastDreamt.set(entity, record.ts)
        }
      }
    } else if (record.type === 'feedback') {
      state.feedback.set(record.insight, record)
    } else {
      state.mentioned.add(record.dream)
    }
  }
  return state
}
