// The reflection log: append-only jsonl beside the session directories.
// Records that an attempt to reflect a session began, and how it resolved.
// Validated on write and on read, like graph.jsonl: a record that cannot
// parse back off disk can never be appended. Modelled directly on
// dreamLog.ts's attempt record: a reflection that throws partway used to
// leave the session permanently 'open' with nothing on disk saying it was
// attempted or why it failed, since status was derived solely from whether
// summary.md exists. This is the durable record that fixes that, without
// changing what summary.md-written-last means: it stays the commit marker,
// this is a record alongside it, never a replacement for it.
import { z } from 'zod'
import type { MemoryPaths } from './paths.js'

export type ReflectionTrigger = 'endSession' | 'runMaintenance'
export type ReflectionOutcome = 'reflected' | 'skipped' | 'failed'
export type PublicReflectionState =
  | 'not_started'
  | 'in_progress'
  | 'reflected'
  | 'skipped'
  | 'failed'

// Appended at the start of an attempt, before any model call.
const attemptSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('attempt'),
  session: z.string(),
  trigger: z.enum(['endSession', 'runMaintenance']),
})

// Appended once an attempt resolves. `reason` is required in practice for
// outcome 'failed' (the error's message, carried so a person or `reverie
// doctor` can read why without reproducing the failure); 'reflected' and
// 'skipped' never carry one. Not split into three outcome schemas for that
// one optional field: every caller in engine.ts that appends 'failed'
// always passes a reason, and nothing here fabricates one when absent.
const outcomeSchema = z.strictObject({
  ts: z.string(),
  type: z.literal('outcome'),
  session: z.string(),
  outcome: z.enum(['reflected', 'skipped', 'failed']),
  reason: z.string().optional(),
})

export const reflectionLogRecordSchema = z.discriminatedUnion('type', [
  attemptSchema,
  outcomeSchema,
])
export type ReflectionLogRecord = z.infer<typeof reflectionLogRecordSchema>
export type ReflectionAttemptRecord = z.infer<typeof attemptSchema>
export type ReflectionOutcomeRecord = z.infer<typeof outcomeSchema>

export async function appendReflectionLog(
  paths: MemoryPaths,
  records: ReflectionLogRecord[],
): Promise<void> {
  if (records.length === 0) return
  const lines = records.map((record) => JSON.stringify(reflectionLogRecordSchema.parse(record)))
  await paths.logs.appendLines(paths.reflectionLog, lines)
}

export async function readReflectionLog(paths: MemoryPaths): Promise<ReflectionLogRecord[]> {
  const lines = await paths.logs.readAll(paths.reflectionLog)
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => reflectionLogRecordSchema.parse(JSON.parse(line)))
}

export interface SessionReflectionLogState {
  attempts: number
  lastAttemptAt?: string
  // True when the most recent record folded for this session is an
  // 'attempt' with no 'outcome' after it: an attempt genuinely still
  // running, or one that crashed before either resolving or getting far
  // enough into its own catch block to record why.
  pending: boolean
  lastOutcome?: ReflectionOutcome
  // The reason from the last outcome record, only when that outcome was
  // 'failed'. Cleared by any later outcome, including a later 'reflected'
  // or 'skipped': once an attempt resolves cleanly, an earlier failure's
  // message is no longer this session's live story.
  lastFailureReason?: string
}

// One entry per session, keyed by session id. Kept per-session (unlike
// dreamLog's single lastAttempt) because many sessions can be mid-pipeline
// or retried independently of one another, and a caller asking about one
// session must never have to fold every other session's history to get it.
export type ReflectionLogState = Map<string, SessionReflectionLogState>

export function emptyReflectionLogState(): SessionReflectionLogState {
  return { attempts: 0, pending: false }
}

// An allow-list over the two known record types, not a catch-all `else`:
// a record type nobody has folded logic for yet must be visibly unhandled,
// not silently swept into whichever branch happened to be last. Same shape
// dreamLog.ts's foldDreamLog uses, and the same posture AGENTS.md asks for
// elsewhere in this codebase: an unhandled case defaults to excluded, never
// to admitted.
export function foldReflectionLog(records: ReflectionLogRecord[]): ReflectionLogState {
  const state: ReflectionLogState = new Map()
  for (const record of records) {
    const existing = state.get(record.session) ?? emptyReflectionLogState()
    if (record.type === 'attempt') {
      state.set(record.session, {
        ...existing,
        attempts: existing.attempts + 1,
        lastAttemptAt: record.ts,
        pending: true,
      })
    } else if (record.type === 'outcome') {
      const { lastFailureReason: _dropped, ...rest } = existing
      state.set(record.session, {
        ...rest,
        pending: false,
        lastOutcome: record.outcome,
        // Only set when this outcome is itself a failure and carried a
        // reason. exactOptionalPropertyTypes forbids assigning `undefined`
        // to an optional string field, so a non-failing outcome (or a
        // failure with no reason, which callers never actually produce)
        // omits the key entirely rather than setting it to undefined,
        // which is what clears an earlier failure's reason on this same
        // per-session entry.
        ...(record.outcome === 'failed' && record.reason !== undefined
          ? { lastFailureReason: record.reason }
          : {}),
      })
    }
  }
  return state
}

// The same allow-list order everywhere this durable record turns into the
// five-state public shape (listStoredSessions and sessionReflectionState
// both call this, so the two can never quietly drift apart):
//
//   1. `disk` wins when the caller already knows summary.md exists: the
//      fold alone cannot know that (it never reads the filesystem), so a
//      caller that has it passes it in rather than this function guessing.
//   2. Otherwise a durable 'failed' outcome beats a dangling, unresolved
//      attempt. A session that failed, was retried, and crashed again
//      before recording anything would otherwise read as stuck in
//      'in_progress' forever; checking failed first reports its last real
//      resolution instead.
//   3. Otherwise a pending attempt (one with no outcome after it) means
//      'in_progress': a real, durable state, not decoration. Ending a
//      session no longer blocks on its reflection, so a session genuinely
//      sits here for as long as reflection takes, and there is a recorded
//      intent to make reflection asynchronous through provider batch APIs
//      later, which would widen that window a great deal.
//   4. Otherwise the log's own last outcome ('reflected' or 'skipped'):
//      the case where the caller's disk check came back unreflected
//      because nothing has been written yet. listStoredSessions and
//      sessionReflectionState both pass a disk argument now and land here
//      the same way whenever it says unreflected; a caller with no disk
//      check at all (disk omitted entirely) would still reach this step
//      too, since `disk` only ever short-circuits when it says reflected.
//   5. Otherwise 'not_started': no attempt has ever been logged. A
//      pre-existing session from before this log existed reads this way
//      too, with no migration needed, since an empty fold is
//      indistinguishable from a session nobody has touched.
export function reflectionStateFromLog(
  state: SessionReflectionLogState,
  disk?: { reflected: boolean; skipped: boolean },
): PublicReflectionState {
  if (disk?.reflected) return disk.skipped ? 'skipped' : 'reflected'
  if (state.lastOutcome === 'failed') return 'failed'
  if (state.pending) return 'in_progress'
  if (state.lastOutcome === 'reflected') return 'reflected'
  if (state.lastOutcome === 'skipped') return 'skipped'
  return 'not_started'
}
