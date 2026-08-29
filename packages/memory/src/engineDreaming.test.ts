// Engine wiring for dreaming: candidate collection, dueness, the lock,
// the once-per-period guard, feedback, and listing. Task 9.
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FakeChatProvider,
  type FakeChatResult,
  FakeEmbeddingProvider,
} from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DreamRunResult } from './dreaming.js'
import { readDreamLog } from './dreamLog.js'
import * as dreamSchedule from './dreamSchedule.js'
import { type EngineDeps, MemoryEngine } from './engine.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { loadProfile, writeProfile } from './profile.js'
import type { ReflectionOutput } from './reflection.js'
import { formatLocalDate } from './time.js'

async function pinTimezoneUtc(paths: MemoryPaths): Promise<void> {
  const profile = await loadProfile(paths, 'UTC')
  await writeProfile(paths, {
    meta: { ...profile.meta, timezone: 'UTC', timezoneSource: 'user-confirmed' },
    body: profile.body,
  })
}

async function lockFileExists(paths: MemoryPaths): Promise<boolean> {
  try {
    await stat(join(paths.dreamsDir, '.lock'))
    return true
  } catch {
    return false
  }
}

function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    newEntities: [],
    pagePromotions: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
    journalingUpdate: null,
  }
}

const ENABLED_DREAMING: NonNullable<EngineDeps['dreaming']> = {
  enabled: true,
  cadence: 'daily',
  triggers: { afterSession: false, onStart: true, serverTimer: false },
  maxToolCalls: 4,
}

const NARRATIVE_TEXT = 'A lighthouse stood at the edge of a calm harbor, its quiet light turning.'
const TONE_OK = JSON.stringify({ narrativeOk: true, flaggedInsightIndexes: [] })

function insightsJsonForSession(sessionId: string): string {
  return JSON.stringify({
    insights: [
      {
        kind: 'pattern',
        headline: 'A quiet thread',
        claim: 'It looks like something recurring showed up across a session.',
        confidence: 0.6,
        evidence: [{ session: sessionId }],
      },
    ],
  })
}

let cleanups: Array<() => Promise<void>> = []

beforeEach(() => {
  cleanups = []
})

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup()
  }
})

async function openTestEngine(options: { dreaming?: EngineDeps['dreaming'] }): Promise<{
  dir: string
  paths: MemoryPaths
  engine: MemoryEngine
  chat: FakeChatProvider
  script: FakeChatResult[]
}> {
  const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-engine-'))
  const paths = memoryPaths(dir, nodeStores())
  await ensureMemoryTree(paths, 'UTC')
  await pinTimezoneUtc(paths)
  const script: FakeChatResult[] = []
  const chat = new FakeChatProvider(script)
  const engine = await MemoryEngine.open(
    dir,
    {
      chat,
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
      timezone: 'UTC',
      dreamingModel: 'fake-dream',
      dreamPersona: () => 'DREAM_PERSONA',
      ...(options.dreaming !== undefined ? { dreaming: options.dreaming } : {}),
    },
    { maintenance: false },
  )
  cleanups.push(async () => {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, paths, engine, chat, script }
}

// Seeds `count` reflected sessions, one scripted reflectSession response
// each. Returns the last session's id, used as a resolvable evidence
// pointer for a dream's insight.
async function seedReflectedSessions(
  engine: MemoryEngine,
  script: FakeChatResult[],
  count: number,
): Promise<string> {
  let sessionId = ''
  for (let i = 0; i < count; i += 1) {
    script.push({ text: JSON.stringify(emptyReflectionOutput(`Session ${i}`)), toolCalls: [] })
    sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: `Note ${i} about something worth remembering.`,
    })
    await engine.endSession(sessionId)
  }
  return sessionId
}

describe('MemoryEngine dreaming', () => {
  it('dreamNow with force writes a dream and indexes both docs', async () => {
    const { paths, engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    const sessionId = await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] }, // exploration wrap-up
      { text: insightsJsonForSession(sessionId), toolCalls: [] }, // insights
      { text: NARRATIVE_TEXT, toolCalls: [] }, // narrative
      { text: TONE_OK, toolCalls: [] }, // tone check
    )

    const result = await engine.dreamNow({ force: true })
    if ('dryRun' in result) throw new Error('expected a real run, not a dry run preview')

    expect(result.outcome).toBe('written')
    const dreamDirs = (await readdir(paths.dreamsDir, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    )
    expect(dreamDirs).toHaveLength(1)
    expect(await engine.listDreams()).toHaveLength(1)

    const dreamHits = (await engine.search('lighthouse', { kinds: ['dream'] })).documents
    expect(dreamHits.some((h) => h.kind === 'dream')).toBe(true)
    const insightHits = (await engine.search('quiet thread', { kinds: ['dream_insight'] }))
      .documents
    expect(insightHits.some((h) => h.kind === 'dream_insight')).toBe(true)

    expect(chat.requests).toHaveLength(5 + 4) // 5 reflections + the dream pipeline

    // dreamPersona exists solely so memory never has to import buildPersona
    // from core; assert its payoff is real, not just that the callback was
    // provided. The 5 reflectSession calls carry no system prompt at all,
    // so only the dream pipeline's own 4 requests are checked here.
    const dreamRequests = chat.requests.slice(5)
    expect(dreamRequests).toHaveLength(4)
    expect(dreamRequests.every((r) => r.system?.includes('DREAM_PERSONA'))).toBe(true)
  })

  it('maybeDream is a no-op when disabled, under the session floor, or already covered', async () => {
    // Disabled: session floor met, but dreaming.enabled is false.
    {
      const { paths, engine, chat, script } = await openTestEngine({
        dreaming: { ...ENABLED_DREAMING, enabled: false },
      })
      await seedReflectedSessions(engine, script, 5)
      const before = chat.requests.length
      const result = await engine.maybeDream('onStart')
      expect(result).toBeUndefined()
      expect(chat.requests.length).toBe(before)
      expect(await readdir(paths.dreamsDir)).toEqual([])
    }

    // Under the floor: dreaming enabled, but fewer than five reflected sessions.
    {
      const { paths, engine, chat } = await openTestEngine({ dreaming: ENABLED_DREAMING })
      const before = chat.requests.length
      const result = await engine.maybeDream('onStart')
      expect(result).toBeUndefined()
      expect(chat.requests.length).toBe(before)
      expect(await readdir(paths.dreamsDir)).toEqual([])
    }

    // Already covered: floor met, but today's period already has a dream.
    {
      const { paths, engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
      await seedReflectedSessions(engine, script, 5)
      const today = formatLocalDate(new Date(), 'UTC')
      await mkdir(join(paths.dreamsDir, `${today}-dream_FAKE0000000000000000001`), {
        recursive: true,
      })
      const before = chat.requests.length
      const result = await engine.maybeDream('onStart')
      expect(result).toBeUndefined()
      expect(chat.requests.length).toBe(before)
      const dirs = (await readdir(paths.dreamsDir, { withFileTypes: true })).filter((e) =>
        e.isDirectory(),
      )
      expect(dirs).toHaveLength(1) // only the pre-existing fake dream, nothing new
    }
  })

  it('maybeDream attempts a period at most once per process even after an aborted run', async () => {
    const { engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] }, // exploration wrap-up
      { text: 'not json', toolCalls: [] }, // insights, first attempt
      { text: 'still not json', toolCalls: [] }, // insights, retry
    )

    const first = await engine.maybeDream('onStart')
    expect(first?.outcome).toBe('aborted')
    const afterFirst = chat.requests.length

    const second = await engine.maybeDream('onStart')
    expect(second).toBeUndefined()
    expect(chat.requests.length).toBe(afterFirst)
  })

  it('recordDreamFeedback appends to the log and returns false for an unknown insight', async () => {
    const { paths, engine, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    const sessionId = await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] },
      { text: insightsJsonForSession(sessionId), toolCalls: [] },
      { text: NARRATIVE_TEXT, toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    )
    const result = await engine.dreamNow({ force: true })
    if ('dryRun' in result) throw new Error('expected a real run, not a dry run preview')
    if (result.outcome !== 'written' || result.dreamId === undefined) {
      throw new Error('expected a written dream')
    }

    const read = await engine.readDream(result.dreamId)
    const insights = read?.insights.meta.insights as { id: string }[] | undefined
    const insightId = insights?.[0]?.id
    if (insightId === undefined) throw new Error('expected at least one insight')

    const ok = await engine.recordDreamFeedback({ insightId, verdict: 'right', source: 'ui' })
    expect(ok).toBe(true)
    const log = await readDreamLog(paths)
    expect(
      log.some((r) => r.type === 'feedback' && r.insight === insightId && r.verdict === 'right'),
    ).toBe(true)

    const missing = await engine.recordDreamFeedback({
      insightId: 'ins_doesnotexist',
      verdict: 'wrong',
      source: 'tool',
    })
    expect(missing).toBe(false)
  })

  it('dreamNow dryRun returns seeds and walk without calling the chat provider', async () => {
    const { engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)
    const before = chat.requests.length

    const preview = await engine.dreamNow({ dryRun: true })

    expect(chat.requests.length).toBe(before)
    if (!('dryRun' in preview)) throw new Error('expected a dry run preview')
    expect(preview.dryRun).toBe(true)
    expect(preview.due).toBe(true)
    expect(preview.seeds).toHaveLength(3)
    expect(Array.isArray(preview.walk)).toBe(true)
  })

  it('re-checks dueness under the lock: a dream that lands during lock acquisition is not duplicated', async () => {
    const { paths, engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)

    // Simulates another process finishing a dream for this exact period in
    // the gap between maybeDream's own outer dueness check and this lock
    // acquisition succeeding: acquireDreamLock still behaves for real, but
    // the moment it hands back the lock, a dream directory for today lands
    // on disk as if a second process had just released it.
    const real = dreamSchedule.acquireDreamLock
    const spy = vi.spyOn(dreamSchedule, 'acquireDreamLock').mockImplementation(async (p, now) => {
      const acquired = await real(p, now)
      if (acquired) {
        const today = formatLocalDate(now, 'UTC')
        await mkdir(join(p.dreamsDir, `${today}-dream_RACE00000000000000001`), {
          recursive: true,
        })
      }
      return acquired
    })

    const before = chat.requests.length
    const result = await engine.maybeDream('onStart')
    spy.mockRestore()

    expect(result).toBeUndefined()
    expect(chat.requests.length).toBe(before)
    const dirs = (await readdir(paths.dreamsDir, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    )
    expect(dirs).toHaveLength(1) // only the race-injected dream; maybeDream added nothing
  })

  it('maybeDream never throws, even when acquireDreamLock itself throws', async () => {
    // Ruling B3 (Task 4): acquireDreamLock is not a total function; it
    // throws when dreamsDir is missing, a damaged memory folder. maybeDream
    // is awaited from _doEndSession's afterSession trigger, so a throw here
    // must never propagate out and fail endSession() for a dreaming-only
    // reason.
    const { engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)

    const spy = vi
      .spyOn(dreamSchedule, 'acquireDreamLock')
      .mockRejectedValue(new Error('ENOENT: no such directory, dreams'))

    const before = chat.requests.length
    let thrown: unknown
    let result: unknown
    try {
      result = await engine.maybeDream('onStart')
    } catch (err) {
      thrown = err
    }
    spy.mockRestore()

    expect(thrown).toBeUndefined()
    expect(result).toBeUndefined()
    expect(chat.requests.length).toBe(before)
  })

  it('the afterSession trigger fires once the floor is crossed, inside the session that crosses it', async () => {
    const AFTER_SESSION_DREAMING: NonNullable<EngineDeps['dreaming']> = {
      enabled: true,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: false, serverTimer: false },
      maxToolCalls: 4,
    }
    const { paths, engine, chat, script } = await openTestEngine({
      dreaming: AFTER_SESSION_DREAMING,
    })

    let sessionId = ''
    for (let i = 0; i < 5; i += 1) {
      script.push({ text: JSON.stringify(emptyReflectionOutput(`Session ${i}`)), toolCalls: [] })
      if (i === 4) {
        // Session 5's own reflectSession call is what crosses the floor;
        // the afterSession trigger fires immediately after, inside this
        // same endSession call. The evidence points at session 4 (already
        // ended and reflected by this point), any resolvable session id
        // does the job.
        script.push(
          { text: 'noted', toolCalls: [] }, // exploration wrap-up
          { text: insightsJsonForSession(sessionId), toolCalls: [] }, // insights
          { text: NARRATIVE_TEXT, toolCalls: [] }, // narrative
          { text: TONE_OK, toolCalls: [] }, // tone check
        )
      }
      sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: `Note ${i} about something worth remembering.`,
      })
      await engine.endSession(sessionId) // awaited: sessions 1-4 no-op (floor not met, 0 calls)
    }

    expect(chat.requests).toHaveLength(5 + 4)
    const dreamDirs = (await readdir(paths.dreamsDir, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    )
    expect(dreamDirs).toHaveLength(1)
  })

  it('the onStart trigger is gated behind options.maintenance: false and never fires when it is skipped (Ruling A4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-onstart-gated-'))
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true })
    })
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)

    const seedScript: FakeChatResult[] = []
    const seedChat = new FakeChatProvider(seedScript)
    const seedEngine = await MemoryEngine.open(
      dir,
      {
        chat: seedChat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
      },
      { maintenance: false },
    )
    await seedReflectedSessions(seedEngine, seedScript, 5)
    await seedEngine.close()

    const script2: FakeChatResult[] = []
    const chat2 = new FakeChatProvider(script2)
    script2.push(
      { text: 'noted', toolCalls: [] },
      { text: insightsJsonForSession('does-not-matter'), toolCalls: [] },
      { text: NARRATIVE_TEXT, toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    )
    const engine2 = await MemoryEngine.open(
      dir,
      {
        chat: chat2,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
        dreamingModel: 'fake-dream',
        dreamPersona: () => 'DREAM_PERSONA',
        dreaming: {
          enabled: true,
          cadence: 'daily',
          triggers: { afterSession: false, onStart: true, serverTimer: false },
          maxToolCalls: 4,
        },
      },
      { maintenance: false },
    )
    // The onStart hook is deliberately fire-and-forget when it does fire;
    // here it must not fire at all, so there is nothing to await. A short
    // settle window stands in for "long enough that a wrongly-fired
    // pipeline would have made its first call by now."
    await new Promise((resolve) => setTimeout(resolve, 50))
    await engine2.close()

    expect(chat2.requests).toEqual([])
    const dirs = (await readdir(paths.dreamsDir, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    )
    expect(dirs).toEqual([])
  })

  it('the onStart trigger fires in the background when options.maintenance is not skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-onstart-fires-'))
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true })
    })
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)

    const seedScript: FakeChatResult[] = []
    const seedChat = new FakeChatProvider(seedScript)
    const seedEngine = await MemoryEngine.open(
      dir,
      {
        chat: seedChat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
      },
      { maintenance: false },
    )
    const sessionId = await seedReflectedSessions(seedEngine, seedScript, 5)
    await seedEngine.close()

    const script2: FakeChatResult[] = []
    const chat2 = new FakeChatProvider(script2)
    script2.push(
      { text: 'noted', toolCalls: [] },
      { text: insightsJsonForSession(sessionId), toolCalls: [] },
      { text: NARRATIVE_TEXT, toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    )
    // options.maintenance omitted: runMaintenance() and drainLegacyProposals()
    // also run here, ahead of the onStart hook, but every seeded session was
    // created and reflected "today" so neither reflects anything stale nor
    // finds a pending rollup (pendingDailyRollups only ever considers a date
    // strictly before today), so neither consumes a scripted chat response.
    const engine2 = await MemoryEngine.open(dir, {
      chat: chat2,
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
      timezone: 'UTC',
      dreamingModel: 'fake-dream',
      dreamPersona: () => 'DREAM_PERSONA',
      dreaming: {
        enabled: true,
        cadence: 'daily',
        triggers: { afterSession: false, onStart: true, serverTimer: false },
        maxToolCalls: 4,
      },
    })

    // The onStart hook is deliberately un-awaited (open() returns before it
    // settles), so this polls for the pipeline's true terminal effect
    // instead of awaiting it directly (the promise is not exposed on
    // MemoryEngine's public API). Breaking as soon as the dream directory
    // first appears is not enough: mkdir happens well before dream.md,
    // insight.md, process.jsonl, the reindex of both docs, and the final
    // commitMemory git write, so closing the engine and letting afterEach
    // remove the folder right after the directory appears used to race
    // that still-in-flight tail (this was the source of an earlier flake).
    //
    // process.jsonl is runDream's own last write, so waiting for it proves
    // the chat pipeline itself is done. What follows inside executeDream
    // (two reindexOrWarn calls, then commitMemory's git add and commit)
    // still has to run afterward with no further externally observable
    // checkpoint before engine.close(). An earlier version of this fix
    // polled `git status --porcelain` from the test itself as that missing
    // checkpoint; that polling loop is itself a concurrent git invocation
    // against the same repository commitMemory is committing to, and on
    // this host it measurably collided with commitMemory's own git commit
    // for `.git/index.lock`, making the run fail for a reason this test
    // caused, not one it was testing for. So this waits for process.jsonl
    // (fs only, no subprocess), then gives the short, fixed tail a
    // generous settle window before closing, without ever spawning git
    // itself.
    const dreamDirDeadline = Date.now() + 5000
    let dirs: string[] = []
    let processLogFound = false
    while (Date.now() < dreamDirDeadline) {
      dirs = (await readdir(paths.dreamsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      if (dirs.length > 0) {
        try {
          await stat(join(paths.dreamsDir, dirs[0] as string, 'process.jsonl'))
          processLogFound = true
          break
        } catch {
          // Not written yet.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    await engine2.close()

    expect(processLogFound).toBe(true)
    expect(dirs).toHaveLength(1)
    expect(chat2.requests).toHaveLength(4)
  }, 15000)

  it('markDreamMentioned appends a mentioned record to the dream log', async () => {
    const { paths, engine } = await openTestEngine({ dreaming: ENABLED_DREAMING })

    await engine.markDreamMentioned('dream_SOMEID00000000000000001')

    const log = await readDreamLog(paths)
    expect(
      log.some((r) => r.type === 'mentioned' && r.dream === 'dream_SOMEID00000000000000001'),
    ).toBe(true)
  })

  it('listDreams and readDream tolerate a partial dream directory (Task 7 ruling)', async () => {
    const { paths, engine } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    const today = formatLocalDate(new Date(), 'UTC')
    const partialDreamId = 'dream_PARTIAL0000000000000001'
    // No dream.md, no insight.md: a crash between writes, or a tone gate
    // that withheld everything, left only the directory itself behind.
    await mkdir(join(paths.dreamsDir, `${today}-${partialDreamId}`), { recursive: true })

    const summaries = await engine.listDreams()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      dreamId: partialDreamId,
      hasNarrative: false,
      insightCount: 0,
    })

    expect(await engine.readDream(partialDreamId)).toBeNull()
  })

  it('maybeDream still resolves when releasing the lock itself fails', async () => {
    // A release failure (EACCES, EROFS) must never surface as a rejection:
    // maybeDream is awaited from _doEndSession's afterSession trigger, and
    // this method's own contract promises it never throws.
    const { engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    const sessionId = await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] },
      { text: insightsJsonForSession(sessionId), toolCalls: [] },
      { text: NARRATIVE_TEXT, toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    )
    const spy = vi
      .spyOn(dreamSchedule, 'releaseDreamLock')
      .mockRejectedValue(new Error('EACCES: permission denied, unlink'))

    let thrown: unknown
    let result: DreamRunResult | undefined
    try {
      result = await engine.maybeDream('onStart')
    } catch (err) {
      thrown = err
    }
    spy.mockRestore()

    expect(thrown).toBeUndefined()
    expect(result?.outcome).toBe('written') // the run itself still completed
    expect(chat.requests).toHaveLength(5 + 4)
    expect(engine.warnings.some((w) => w.toLowerCase().includes('lock'))).toBe(true)
  })

  it('maybeDream releases the lock even when the run aborts', async () => {
    const { paths, engine, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] }, // exploration wrap-up
      { text: 'not json', toolCalls: [] }, // insights, first attempt
      { text: 'still not json', toolCalls: [] }, // insights, retry
    )

    const result = await engine.maybeDream('onStart')

    expect(result?.outcome).toBe('aborted')
    expect(await lockFileExists(paths)).toBe(false)
  })

  it('dreamNow releases the lock even when the run aborts', async () => {
    const { paths, engine, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] },
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    )

    const result = await engine.dreamNow({ force: true })
    if ('dryRun' in result) throw new Error('expected a real run, not a dry run preview')

    expect(result.outcome).toBe('aborted')
    expect(await lockFileExists(paths)).toBe(false)
  })

  // Defect 2, 2026-08-25 dreaming investigation: an aborted or failed
  // dream attempt used to leave no trace anywhere on disk. A person had no
  // way to find out dreaming had even tried and failed, let alone why.
  it('an aborted dream attempt leaves a durable attempt record in the dream log', async () => {
    const { paths, engine, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] },
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    )

    const result = await engine.dreamNow({ force: true })
    if ('dryRun' in result) throw new Error('expected a real run, not a dry run preview')
    expect(result.outcome).toBe('aborted')

    const records = await readDreamLog(paths)
    const attempts = records.filter((r) => r.type === 'attempt')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ outcome: 'aborted', trigger: 'manual' })
    expect(String(attempts[0]?.reason)).toContain('insight output failed validation twice')
  })

  // Defect 1, 2026-08-25 dreaming investigation: dreaming used to fall back
  // silently to reflectionModel when dreamingModel was unset, which is
  // exactly how one real user's dreaming broke permanently (a reflection
  // model that rejects function tools with an HTTP 400). There must be no
  // such fallback: an unset dreamingModel is now a loud, specific failure,
  // recorded the same durable way any other failed attempt is.
  it('a missing dreamingModel fails loudly, with no fallback to reflectionModel, and records a failed attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-nomodel-'))
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
    const script: FakeChatResult[] = []
    const chat = new FakeChatProvider(script)
    const engine = await MemoryEngine.open(
      dir,
      {
        chat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
        // dreamingModel deliberately omitted.
        dreamPersona: () => 'DREAM_PERSONA',
        dreaming: ENABLED_DREAMING,
      },
      { maintenance: false },
    )
    try {
      await seedReflectedSessions(engine, script, 5)

      await expect(engine.dreamNow({ force: true })).rejects.toThrow(
        /no fallback to reflectionModel/i,
      )

      const records = await readDreamLog(paths)
      const attempts = records.filter((r) => r.type === 'attempt')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ outcome: 'failed' })
      expect(String(attempts[0]?.reason)).toContain('dreamingModel')

      // Never silently spent a call against reflectionModel or any other
      // fallback: the only requests made are the 5 reflectSession calls
      // seedReflectedSessions itself scripted.
      expect(chat.requests).toHaveLength(5)
    } finally {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Defect: dreamPersona degrading silently to an empty system prompt,
  // 2026-08-28. dreamingModel gets a loud guard a few lines above;
  // dreamPersona did not, so a host that forgot to set it (or stubbed it
  // with a callback that renders nothing) got all four dream stages run
  // with no identity, no memory orientation, no voice rule, and no crisis
  // stance, silently, while still writing into the person's permanent
  // record. These four tests mirror the missing-dreamingModel test above.
  it('a missing dreamPersona fails loudly and names dreamPersona', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-nopersona-'))
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
    const script: FakeChatResult[] = []
    const chat = new FakeChatProvider(script)
    const engine = await MemoryEngine.open(
      dir,
      {
        chat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
        dreamingModel: 'fake-dream',
        // dreamPersona deliberately omitted.
        dreaming: ENABLED_DREAMING,
      },
      { maintenance: false },
    )
    try {
      await seedReflectedSessions(engine, script, 5)

      await expect(engine.dreamNow({ force: true })).rejects.toThrow(
        /EngineDeps\.dreamPersona was not set/,
      )
    } finally {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a dreamPersona that renders to an empty string fails loudly with the empty-persona message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-emptypersona-'))
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
    const script: FakeChatResult[] = []
    const chat = new FakeChatProvider(script)
    const engine = await MemoryEngine.open(
      dir,
      {
        chat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
        dreamingModel: 'fake-dream',
        dreamPersona: () => '',
        dreaming: ENABLED_DREAMING,
      },
      { maintenance: false },
    )
    try {
      await seedReflectedSessions(engine, script, 5)

      await expect(engine.dreamNow({ force: true })).rejects.toThrow(/returned an empty persona/i)
    } finally {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a dreamPersona that renders whitespace only is treated the same as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-wspersona-'))
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
    const script: FakeChatResult[] = []
    const chat = new FakeChatProvider(script)
    const engine = await MemoryEngine.open(
      dir,
      {
        chat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
        dreamingModel: 'fake-dream',
        dreamPersona: () => '  \n\t ',
        dreaming: ENABLED_DREAMING,
      },
      { maintenance: false },
    )
    try {
      await seedReflectedSessions(engine, script, 5)

      await expect(engine.dreamNow({ force: true })).rejects.toThrow(/returned an empty persona/i)
    } finally {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a real non-empty dreamPersona does not trip this guard, and the dream proceeds past it', async () => {
    const { engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    const sessionId = await seedReflectedSessions(engine, script, 5)
    script.push(
      { text: 'noted', toolCalls: [] }, // exploration wrap-up
      { text: insightsJsonForSession(sessionId), toolCalls: [] }, // insights
      { text: NARRATIVE_TEXT, toolCalls: [] }, // narrative
      { text: TONE_OK, toolCalls: [] }, // tone check
    )

    const result = await engine.dreamNow({ force: true })
    if ('dryRun' in result) throw new Error('expected a real run, not a dry run preview')

    // openTestEngine's dreamPersona renders the non-empty 'DREAM_PERSONA';
    // the guard must not reject it, and the pipeline must have actually
    // spent its 4 chat calls past that point.
    expect(result.outcome).toBe('written')
    expect(chat.requests).toHaveLength(5 + 4)
  })

  it('records the dream attempt as failed with the guard reason BEFORE the throw reaches the caller (ordering)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-persona-ordering-'))
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
    const script: FakeChatResult[] = []
    const chat = new FakeChatProvider(script)
    const engine = await MemoryEngine.open(
      dir,
      {
        chat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
        dreamingModel: 'fake-dream',
        // dreamPersona deliberately omitted, same as the first test above,
        // but this test's whole point is the durable record left behind,
        // not the thrown message.
        dreaming: ENABLED_DREAMING,
      },
      { maintenance: false },
    )
    try {
      await seedReflectedSessions(engine, script, 5)

      await expect(engine.dreamNow({ force: true })).rejects.toThrow(
        /EngineDeps\.dreamPersona was not set/,
      )

      const records = await readDreamLog(paths)
      const attempts = records.filter((r) => r.type === 'attempt')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ outcome: 'failed' })
      expect(String(attempts[0]?.reason)).toContain('EngineDeps.dreamPersona was not set')

      // Never silently spent a call against any model: the only requests
      // made are the 5 reflectSession calls seedReflectedSessions scripted.
      expect(chat.requests).toHaveLength(5)
    } finally {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('Ruling A5: skipped sessions never count toward the reflected-session floor', async () => {
    const { engine, chat } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    // Each of these ends with no user transcript line at all, so
    // _doEndSession takes the writeSkippedSummary path: reflected: true,
    // skipped: true, and no reflectSession chat call at all.
    for (let i = 0; i < 5; i += 1) {
      const sessionId = await engine.startSession()
      await engine.endSession(sessionId)
    }

    const preview = await engine.dreamNow({ dryRun: true })
    if (!('dryRun' in preview)) throw new Error('expected a dry run preview')

    expect(preview.due).toBe(false)
    expect(chat.requests).toHaveLength(0)
  })

  it('maybeDream declines and spends nothing when the lock is already held', async () => {
    const { paths, engine, chat, script } = await openTestEngine({ dreaming: ENABLED_DREAMING })
    await seedReflectedSessions(engine, script, 5)
    // Simulates another process already mid-dream: a fresh, non-stale lock
    // file already sitting at the path acquireDreamLock itself would use.
    await writeFile(
      join(paths.dreamsDir, '.lock'),
      JSON.stringify({ ts: new Date().toISOString(), pid: 999999 }),
      'utf8',
    )

    const before = chat.requests.length
    const result = await engine.maybeDream('onStart')

    expect(result).toBeUndefined()
    expect(chat.requests.length).toBe(before)
  })

  it('maybeDream declines and spends nothing when the given trigger switch is off (serverTimer)', async () => {
    // serverTimer has no call-site guard the way open() and _doEndSession
    // guard onStart and afterSession: this one line inside maybeDream is
    // the only thing standing between a disabled switch and a spent dream,
    // and Task 13's serverTimer caller depends on it entirely.
    const SERVER_TIMER_OFF: NonNullable<EngineDeps['dreaming']> = {
      enabled: true,
      cadence: 'daily',
      triggers: { afterSession: false, onStart: false, serverTimer: false },
      maxToolCalls: 4,
    }
    const { engine, chat, script } = await openTestEngine({ dreaming: SERVER_TIMER_OFF })
    await seedReflectedSessions(engine, script, 5)

    const before = chat.requests.length
    const result = await engine.maybeDream('serverTimer')

    expect(result).toBeUndefined()
    expect(chat.requests.length).toBe(before)
  })
})
