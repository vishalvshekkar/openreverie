// The dream log: append-only jsonl beside the dream directories. Records
// which entities each dream touched (coverage), feedback on insights, and
// opener mentions. Validated on write and on read, like graph.jsonl: a
// record that cannot parse back off disk can never be appended.
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

// A dream attempt that got past the lock (so it was real: it either spent a
// model call or would have) and did not end in a written dream. Routine
// declines (dreaming off, period already covered, lock held by another
// process, floor of reflected sessions not met) are never recorded here:
// they are cheap to recompute live from the same paths any caller already
// has, and recording every 30-minute or every-launch decline would grow
// this log without bound and bury the one line that matters. This is the
// durable record a person or `reverie doctor` reads to find out why
// dreaming has produced nothing, since an aborted or failed attempt used
// to leave no trace anywhere on disk.
const attemptSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('attempt'),
  period: z.string(),
  trigger: z.string(),
  outcome: z.enum(['aborted', 'failed']),
  reason: z.string(),
})

export const dreamLogRecordSchema = z.discriminatedUnion('type', [
  dreamtSchema,
  feedbackSchema,
  mentionedSchema,
  attemptSchema,
])

export type DreamLogRecord = z.infer<typeof dreamLogRecordSchema>
export type DreamFeedbackRecord = z.infer<typeof feedbackSchema>
export type DreamAttemptRecord = z.infer<typeof attemptSchema>

export async function appendDreamLog(paths: MemoryPaths, records: DreamLogRecord[]): Promise<void> {
  if (records.length === 0) return
  const lines = records.map((record) => JSON.stringify(dreamLogRecordSchema.parse(record)))
  await paths.logs.appendLines(paths.dreamLog, lines)
}

export async function readDreamLog(paths: MemoryPaths): Promise<DreamLogRecord[]> {
  const lines = await paths.logs.readAll(paths.dreamLog)
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => dreamLogRecordSchema.parse(JSON.parse(line)))
}

export interface DreamLogState {
  lastDreamt: Map<string, string>
  feedback: Map<string, DreamFeedbackRecord>
  mentioned: Set<string>
  // The most recent attempt record, if any. The log is append-only and
  // written in chronological order, so the last 'attempt' record folded is
  // always the most recent one: no separate timestamp comparison needed,
  // unlike lastDreamt above (which tracks one timestamp per entity, not a
  // single overall latest).
  lastAttempt?: DreamAttemptRecord
}

// An allow-list over the four known record types, not a catch-all `else`:
// a record type nobody has folded logic for yet must be visibly unhandled,
// not silently swept into whichever branch happened to be last. This is
// the same shape AGENTS.md calls out elsewhere in this codebase: an
// unhandled case must default to excluded, never to admitted.
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
    } else if (record.type === 'mentioned') {
      state.mentioned.add(record.dream)
    } else if (record.type === 'attempt') {
      state.lastAttempt = record
    }
  }
  return state
}
