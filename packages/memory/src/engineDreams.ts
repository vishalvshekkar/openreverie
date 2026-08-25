// Dreaming (Task 9): the stateless half of engine wiring. Pure functions
// over paths and folded graph state, with no engine instance to call back
// into. Split out of engine.ts because the whole dreaming region there grew
// past the task's own "roughly 250 lines" guideline (see task-9-report.md
// for the exact count and the reasoning for this split).
//
// maybeDream, dreamNow, executeDream, buildSeedBodies, and neighbors stay
// on MemoryEngine itself: each of those needs the live docPaths cache, the
// SQLite index, deps, or the per-process dreamAttemptedPeriods set, none of
// which fit a narrow { paths, graphState } bag without turning into a pile
// of callbacks that would make the split harder to follow than the
// original single file. Everything here needs only paths, or graphState,
// or both, never the engine instance.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Document, readDocument } from './documents.js'
import type { DreamInsight } from './dreaming.js'
import {
  appendDreamLog,
  type DreamAttemptRecord,
  type DreamLogState,
  type DreamVerdict,
  foldDreamLog,
  readDreamLog,
} from './dreamLog.js'
import {
  type DreamCadence,
  dreamIsDue,
  MIN_REFLECTED_SESSIONS,
  periodCovered,
  periodFor,
} from './dreamSchedule.js'
import { type DreamCandidate, randomWalk } from './dreamSelection.js'
import type { DreamSummary, PublicDocumentRow } from './engine.js'
import type { GraphState } from './graph.js'
import type { MemoryPaths } from './paths.js'
import { SessionStore } from './transcripts.js'

export function adjacent(graphState: GraphState, a: string, b: string): boolean {
  for (const edge of graphState.edges.values()) {
    if ((edge.from === a && edge.to === b) || (edge.from === b && edge.to === a)) return true
  }
  return false
}

// Every graph node, plus every public document except journaling, dream,
// and dream_insight (a dream never dreams about its own journal, or about
// a past dream). Degree is counted by a plain scan of graphState.edges: the
// folded graph is small enough that this is cheap, and it is only ever
// done once per dream attempt. `docs` comes from the caller's own
// listPublicDocuments() call, since that walk needs the engine's doc-kind
// dispatch, not just paths.
export function collectDreamCandidates(
  graphState: GraphState,
  docs: PublicDocumentRow[],
): DreamCandidate[] {
  const nodeCandidates: DreamCandidate[] = []
  for (const [id, node] of graphState.nodes) {
    let degree = 0
    for (const edge of graphState.edges.values()) {
      if (edge.from === id || edge.to === id) degree += 1
    }
    nodeCandidates.push({
      id,
      label: node.label,
      kind: 'node',
      nodeType: node.type,
      date: node.ts.slice(0, 10),
      degree,
    })
  }
  const docCandidates: DreamCandidate[] = docs
    .filter(
      (row) => row.kind !== 'journaling' && row.kind !== 'dream' && row.kind !== 'dream_insight',
    )
    .map((row) => ({
      id: row.docId,
      label: row.title,
      kind: row.kind,
      date: row.entryDate ?? row.updatedAt.slice(0, 10),
      degree: 0,
    }))
  return [...nodeCandidates, ...docCandidates]
}

export async function existingDreamDates(paths: MemoryPaths): Promise<string[]> {
  let entries: string[]
  try {
    entries = (await readdir(paths.dreamsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    entries = []
  }
  const dates: string[] = []
  for (const name of entries) {
    const match = /^(\d{4}-\d{2}-\d{2})-dream_/.exec(name)
    if (match?.[1] !== undefined) dates.push(match[1])
  }
  return dates
}

export async function reflectedSessionCount(paths: MemoryPaths): Promise<number> {
  const sessions = await SessionStore.listSessions(paths)
  // Ruling A5: a skipped session's placeholder summary.md still sets
  // reflected: true, so it must not count toward the dreaming floor. Every
  // other read of .reflected in engine.ts pairs it with !skipped; this is
  // the same pairing, for the same reason.
  return sessions.filter((s) => s.reflected && !s.skipped).length
}

// Builds on the same directory scan as existingDreamDates, one level
// deeper: reads each dream directory's insight.md for its real period and
// insight count. Carried ruling (Task 7): a dream directory can be partial
// (a crash between writes, or a tone gate that withheld the narrative), so
// a missing or malformed insight.md is reported as zero insights, never
// thrown.
export async function listDreamSummaries(paths: MemoryPaths): Promise<DreamSummary[]> {
  let entries: string[]
  try {
    entries = (await readdir(paths.dreamsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    entries = []
  }
  const summaries: DreamSummary[] = []
  for (const name of entries) {
    const match = /^(\d{4}-\d{2}-\d{2})-(dream_\S+)$/.exec(name)
    const date = match?.[1]
    const dreamId = match?.[2]
    if (date === undefined || dreamId === undefined) continue
    const dir = join(paths.dreamsDir, name)
    let hasNarrative = true
    try {
      await readDocument(join(dir, 'dream.md'))
    } catch {
      hasNarrative = false
    }
    let period = date
    let insightCount = 0
    try {
      const insightDoc = await readDocument(join(dir, 'insight.md'))
      if (typeof insightDoc.meta.period === 'string') period = insightDoc.meta.period
      if (Array.isArray(insightDoc.meta.insights)) {
        insightCount = insightDoc.meta.insights.length
      }
    } catch {
      // No insight.md yet, or it does not parse. Zero insights, not a crash.
    }
    summaries.push({ dreamId, date, period, hasNarrative, insightCount, dir })
  }
  return summaries.sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1
    return a.dreamId > b.dreamId ? -1 : 1
  })
}

// Same tolerance as listDreamSummaries: an insight.md that is missing or
// will not parse means there is nothing usable to hand back, so this
// reports null rather than throwing.
export async function readDreamById(
  paths: MemoryPaths,
  dreamId: string,
): Promise<{
  summary: DreamSummary
  narrative?: Document
  insights: Document
  processLog: string
} | null> {
  const summary = (await listDreamSummaries(paths)).find((s) => s.dreamId === dreamId)
  if (!summary) return null
  let insights: Document
  try {
    insights = await readDocument(join(summary.dir, 'insight.md'))
  } catch {
    return null
  }
  let narrative: Document | undefined
  try {
    narrative = await readDocument(join(summary.dir, 'dream.md'))
  } catch {
    narrative = undefined
  }
  let processLog = ''
  try {
    processLog = await readFile(join(summary.dir, 'process.jsonl'), 'utf8')
  } catch {
    processLog = ''
  }
  return { summary, ...(narrative ? { narrative } : {}), insights, processLog }
}

// Scans every dream's insight.md for the given insight id, so the caller
// only needs the insight id, not which dream it belongs to. Returns false
// rather than throwing when no insight.md anywhere carries that id, so an
// unknown or already-forgotten id is a normal, reportable outcome.
export async function recordDreamFeedback(
  paths: MemoryPaths,
  args: { insightId: string; verdict: DreamVerdict; note?: string; source: 'ui' | 'tool' },
): Promise<boolean> {
  for (const summary of await listDreamSummaries(paths)) {
    let insightDoc: Document
    try {
      insightDoc = await readDocument(join(summary.dir, 'insight.md'))
    } catch {
      continue
    }
    const insights = Array.isArray(insightDoc.meta.insights)
      ? (insightDoc.meta.insights as DreamInsight[])
      : []
    if (!insights.some((insight) => insight.id === args.insightId)) continue
    await appendDreamLog(paths, [
      {
        ts: new Date().toISOString(),
        type: 'feedback',
        insight: args.insightId,
        dream: summary.dreamId,
        verdict: args.verdict,
        ...(args.note !== undefined ? { note: args.note } : {}),
        source: args.source,
      },
    ])
    return true
  }
  return false
}

export async function markDreamMentioned(paths: MemoryPaths, dreamId: string): Promise<void> {
  await appendDreamLog(paths, [{ ts: new Date().toISOString(), type: 'mentioned', dream: dreamId }])
}

// What past dreams already covered, so a new one does not repeat them: each
// of the last few dreams' insight headlines, with any feedback verdict
// folded in from the log alongside it.
export async function buildRecentDreamDigest(
  paths: MemoryPaths,
  logState: DreamLogState,
  count: number,
): Promise<string> {
  const recent = (await listDreamSummaries(paths)).slice(0, count)
  const lines: string[] = []
  for (const summary of recent) {
    let insightDoc: Document
    try {
      insightDoc = await readDocument(join(summary.dir, 'insight.md'))
    } catch {
      continue
    }
    const insights = Array.isArray(insightDoc.meta.insights)
      ? (insightDoc.meta.insights as DreamInsight[])
      : []
    for (const insight of insights) {
      const feedback = logState.feedback.get(insight.id)
      lines.push(
        feedback
          ? `- ${summary.date}: ${insight.headline} [feedback: ${feedback.verdict}]`
          : `- ${summary.date}: ${insight.headline}`,
      )
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'No past dreams yet.'
}

// Only node-kind seeds walk: a document candidate's id is never a graph
// node id, so randomWalk from one would just return the single-element
// path with nothing to add. Deduplicated across all seeds' walks, in
// first-seen order, so the same node touched from two seeds is not handed
// to the model twice.
export function walkSeeds(
  graphState: GraphState,
  seeds: DreamCandidate[],
  hops: number,
  rng: () => number,
): string[] {
  const visited = new Set<string>()
  const combined: string[] = []
  for (const seed of seeds) {
    if (seed.kind !== 'node') continue
    const path = randomWalk(graphState, seed.id, hops, rng)
    for (const id of path.slice(1)) {
      if (!visited.has(id)) {
        visited.add(id)
        combined.push(id)
      }
    }
  }
  return combined
}

// The subset of config.toml's [dreaming] table that dueness and status
// reporting need. Defined here rather than imported from EngineDeps in
// engine.ts, so this module keeps depending only on paths and graph state
// (see this file's own header), not on the engine's own dependency shape.
export interface DreamingSettings {
  enabled: boolean
  cadence: DreamCadence
  triggers: { afterSession: boolean; onStart: boolean; serverTimer: boolean }
  maxToolCalls: number
}

// Everything a person or `reverie doctor` needs to answer "why hasn't
// dreaming produced anything": whether it is configured and on, which
// model it will run on, whether today's (or this week's) period is
// already covered, whether the floor of reflected sessions is met, and
// the reason the last real attempt did not produce a dream, if there was
// one. Pure over paths and the caller's own resolved model string, so
// `reverie doctor` (which deliberately never opens a MemoryEngine) can
// call this directly, and MemoryEngine.dreamStatus() is a thin wrapper
// around it.
export interface DreamStatus {
  configured: boolean
  enabled: boolean
  cadence: DreamCadence
  triggers: { afterSession: boolean; onStart: boolean; serverTimer: boolean }
  model: string | undefined
  timezone: string
  period: string
  periodCovered: boolean
  reflectedSessionCount: number
  minReflectedSessions: number
  reflectedFloorMet: boolean
  due: boolean
  lastAttempt?: DreamAttemptRecord
}

export async function computeDreamStatus(
  paths: MemoryPaths,
  dreaming: DreamingSettings | undefined,
  model: string | undefined,
  timezone: string,
  now: Date,
): Promise<DreamStatus> {
  const cadence = dreaming?.cadence ?? 'daily'
  const period = periodFor(now, cadence, timezone)
  const reflected = await reflectedSessionCount(paths)
  const dreamDates = await existingDreamDates(paths)
  const covered = periodCovered(dreamDates, now, cadence, timezone)
  const logState = foldDreamLog(await readDreamLog(paths))
  const due =
    dreaming !== undefined &&
    dreamIsDue({
      enabled: dreaming.enabled,
      cadence,
      timezone,
      reflectedSessionCount: reflected,
      existingDreamDates: dreamDates,
      now,
    })
  return {
    configured: dreaming !== undefined,
    enabled: dreaming?.enabled ?? false,
    cadence,
    triggers: dreaming?.triggers ?? { afterSession: false, onStart: false, serverTimer: false },
    model,
    timezone,
    period,
    periodCovered: covered,
    reflectedSessionCount: reflected,
    minReflectedSessions: MIN_REFLECTED_SESSIONS,
    reflectedFloorMet: reflected >= MIN_REFLECTED_SESSIONS,
    due,
    ...(logState.lastAttempt ? { lastAttempt: logState.lastAttempt } : {}),
  }
}
