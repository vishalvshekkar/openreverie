// End-to-end harness: proves the whole stack (providers -> memory -> core)
// works together the way the design promises, driving only the public
// package APIs a real deployment would use.
//
// Three synthetic past days are driven at the engine level in one memory
// folder: each day is a session, ended with a scripted reflection. Day
// one's reflection creates two arcs directly, in two different realms, and
// days two and three attribute items to those arcs with high confidence.
// Maintenance then builds daily rollups for the completed days. Finally,
// one present-day conversation runs through AgentSession, using a tool call
// to reach back into day one's memory, and ends with one more scripted
// reflection.
//
// The proof points asserted at the end are the spec's core promises:
// transcripts are append-only, memory is searchable, the graph is
// queryable, and the SQLite index is fully disposable and rebuildable from
// the folder.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentEvent,
  AgentSession,
  assembleSystemPrompt,
  type ReverieConfig,
} from '@openreverie/core'
import { type EngineDeps, MemoryEngine, memoryPaths, readDocument } from '@openreverie/memory'
import {
  FakeChatProvider,
  type FakeChatResult,
  FakeEmbeddingProvider,
} from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DAY_ONE_DATE,
  DAY_THREE_DATE,
  DAY_TWO_DATE,
  DISTINCTIVE_DAY_ONE_PHRASE,
  dayOneReflection,
  dayOneRememberText,
  dayOneRollupText,
  dayOneTurns,
  dayThreeReflection,
  dayThreeRememberText,
  dayThreeRollupText,
  dayThreeTurns,
  dayTwoReflection,
  dayTwoRememberText,
  dayTwoRollupText,
  dayTwoTurns,
  type FixtureTurn,
  JOB_SEARCH_ARC_NAME,
  MAINTENANCE_NOW,
  presentDayAnswer,
  presentDayQuestion,
  presentDayReflection,
  presentDaySearchQuery,
  WOODWORKING_ARC_NAME,
} from './fixtures/first-week.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openreverie-e2e-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function testConfig(): ReverieConfig {
  return {
    memoryDir: dir,
    provider: { name: 'openai', apiKey: 'test' },
    models: { chat: 'm', reflection: 'm', embeddings: 'm' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function fakeDeps(chat: FakeChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'm',
    embeddingModel: 'm',
  }
}

function transcriptPath(date: string, sessionId: string): string {
  return join(memoryPaths(dir).sessionsDir, `${date}-${sessionId}`, 'transcript.jsonl')
}

async function runPastDay(
  engine: MemoryEngine,
  date: string,
  turns: FixtureTurn[],
  rememberText: string,
): Promise<string> {
  const now = new Date(`${date}T20:00:00Z`)
  const sessionId = await engine.startSession(now)
  for (const turn of turns) {
    await engine.appendTranscript(sessionId, {
      ts: now.toISOString(),
      role: 'user',
      content: turn.user,
    })
    await engine.appendTranscript(sessionId, {
      ts: now.toISOString(),
      role: 'assistant',
      content: turn.assistant,
    })
  }
  await engine.remember(sessionId, rememberText)
  return sessionId
}

describe('end-to-end harness', () => {
  it(
    'carries three past days of memory through maintenance and a present-day ' +
      'conversation, and survives a full index rebuild',
    async () => {
      // FakeChatProvider exhausts the script array in order; a spare entry could let the rebuild
      // leg's maintenance silently build an extra rollup, corrupting the test's intentions.
      const script: FakeChatResult[] = [{ text: JSON.stringify(dayOneReflection()), toolCalls: [] }]
      const chat = new FakeChatProvider(script)
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      // --- Day one: two arcs, created directly, touching two different realms ---
      const day1Id = await runPastDay(engine, DAY_ONE_DATE, dayOneTurns, dayOneRememberText)
      const day1Path = transcriptPath(DAY_ONE_DATE, day1Id)
      const day1BytesBefore = await readFile(day1Path)

      await engine.endSession(day1Id)

      const contextAfterDay1 = await engine.sessionContext()
      expect(contextAfterDay1.pendingProposals).toHaveLength(0)

      // assembleSystemPrompt still reads engine.sessionContext() the same
      // way; with nothing pending, it simply carries no proposals section.
      // This does not consume a scripted chat result.
      const promptWithNoPendingProposals = await assembleSystemPrompt(engine, testConfig())
      expect(promptWithNoPendingProposals).not.toContain('## Pending proposals')

      const arcs = engine.listArcs()
      const woodworkingArc = arcs.find((a) => a.label === WOODWORKING_ARC_NAME)
      const jobSearchArc = arcs.find((a) => a.label === JOB_SEARCH_ARC_NAME)
      if (!woodworkingArc || !jobSearchArc) {
        throw new Error('expected day one reflection to create both arcs directly')
      }
      // The two arcs live in two distinct realms.
      const woodworkingRealm = engine.listRealms().find((r) => r.label === 'Craft and hobbies')
      const jobSearchRealm = engine.listRealms().find((r) => r.label === 'Career')
      if (!woodworkingRealm || !jobSearchRealm) {
        throw new Error('expected day one reflection to create both realms directly')
      }
      expect(woodworkingRealm.id).not.toBe(jobSearchRealm.id)

      const arcIds = { woodworking: woodworkingArc.id, jobSearch: jobSearchArc.id }

      // --- Day two: attributes items to both arcs with high confidence ---
      script.push({ text: JSON.stringify(dayTwoReflection(arcIds)), toolCalls: [] })
      const day2Id = await runPastDay(engine, DAY_TWO_DATE, dayTwoTurns, dayTwoRememberText)
      const day2Path = transcriptPath(DAY_TWO_DATE, day2Id)
      const day2BytesBefore = await readFile(day2Path)
      await engine.endSession(day2Id)

      // --- Day three: same, closing out the arcs' first week ---
      script.push({ text: JSON.stringify(dayThreeReflection(arcIds)), toolCalls: [] })
      const day3Id = await runPastDay(engine, DAY_THREE_DATE, dayThreeTurns, dayThreeRememberText)
      const day3Path = transcriptPath(DAY_THREE_DATE, day3Id)
      const day3BytesBefore = await readFile(day3Path)
      await engine.endSession(day3Id)

      // --- Maintenance: builds daily rollups for the three completed days ---
      script.push(
        { text: dayOneRollupText, toolCalls: [] },
        { text: dayTwoRollupText, toolCalls: [] },
        { text: dayThreeRollupText, toolCalls: [] },
      )
      await engine.runMaintenance(MAINTENANCE_NOW)
      expect(engine.warnings).toEqual([])

      const paths = memoryPaths(dir)
      const dailyOne = await readDocument(join(paths.rollupsDailyDir, `${DAY_ONE_DATE}.md`))
      const dailyTwo = await readDocument(join(paths.rollupsDailyDir, `${DAY_TWO_DATE}.md`))
      expect(dailyOne.body.trim()).toBe(dayOneRollupText)
      expect(dailyTwo.body.trim()).toBe(dayTwoRollupText)

      // Constitution is still readable through the documents API.
      const constitutionDoc = await readDocument(paths.constitution)
      expect(typeof constitutionDoc.body).toBe('string')
      expect(constitutionDoc.body.length).toBeGreaterThan(0)

      // Search finds a distinctive detail from day one.
      const searchHits = await engine.search(DISTINCTIVE_DAY_ONE_PHRASE)
      expect(searchHits.length).toBeGreaterThan(0)

      // The graph knows which items were filed under each arc: the item
      // created when the arc itself was proposed, plus the attributed item
      // from each of the following two days.
      const woodworkingItems = engine.graphQuery({
        kind: 'items_in_arc',
        arcId: arcIds.woodworking,
      })
      const jobSearchItems = engine.graphQuery({ kind: 'items_in_arc', arcId: arcIds.jobSearch })
      expect(woodworkingItems).toHaveLength(3)
      expect(jobSearchItems).toHaveLength(3)

      // --- Present day: a live conversation reaching back into memory ---
      script.push(
        {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_memory',
              arguments: JSON.stringify({ query: presentDaySearchQuery }),
            },
          ],
        },
        { text: presentDayAnswer, toolCalls: [] },
      )
      const session = await AgentSession.start(engine, testConfig(), chat)
      const events: AgentEvent[] = []
      for await (const event of session.send(presentDayQuestion)) {
        events.push(event)
      }
      expect(events.map((e) => e.type)).toEqual(['tool', 'text', 'done'])
      expect(events[0]).toMatchObject({ type: 'tool', name: 'search_memory' })
      expect(events[1]).toMatchObject({ type: 'text', text: presentDayAnswer })

      script.push({ text: JSON.stringify(presentDayReflection()), toolCalls: [] })
      await session.end()
      expect(engine.warnings).toEqual([])

      // Verify that search_memory results actually reached the model: find the request
      // that followed the tool call (the one whose messages include a role 'tool' entry)
      // and confirm it contains the distinctive day-one phrase from the search hits.
      const toolResultRequest = chat.requests.find((req) =>
        (req.messages || []).some((msg) => msg.role === 'tool'),
      )
      expect(toolResultRequest).toBeDefined()
      if (toolResultRequest) {
        const toolMessage = toolResultRequest.messages.find((msg) => msg.role === 'tool')
        expect(toolMessage).toBeDefined()
        if (toolMessage) {
          expect(typeof toolMessage.content).toBe('string')
          expect((toolMessage.content as string).includes(DISTINCTIVE_DAY_ONE_PHRASE)).toBe(true)
        }
      }

      // --- Append-only proof: every past-day transcript is byte-identical
      // to what it was right after its own day's appends, even after
      // maintenance, a present-day session, and reflection all ran. ---
      expect((await readFile(day1Path)).equals(day1BytesBefore)).toBe(true)
      expect((await readFile(day2Path)).equals(day2BytesBefore)).toBe(true)
      expect((await readFile(day3Path)).equals(day3BytesBefore)).toBe(true)

      // --- Rebuildability: index.db is fully disposable. Delete it, reopen
      // (which does not itself reindex documents), confirm search is
      // genuinely empty, then reindexAll and confirm the same search works
      // again from nothing but the folder. ---
      await engine.close()
      await rm(paths.indexDb)

      const rebuiltEngine = await MemoryEngine.open(dir, fakeDeps(chat))
      const hitsBeforeRebuild = await rebuiltEngine.search(DISTINCTIVE_DAY_ONE_PHRASE)
      expect(hitsBeforeRebuild).toEqual([])

      await rebuiltEngine.reindexAll()
      const hitsAfterRebuild = await rebuiltEngine.search(DISTINCTIVE_DAY_ONE_PHRASE)
      expect(hitsAfterRebuild.length).toBeGreaterThan(0)

      const woodworkingItemsAfterRebuild = rebuiltEngine.graphQuery({
        kind: 'items_in_arc',
        arcId: arcIds.woodworking,
      })
      expect(woodworkingItemsAfterRebuild).toHaveLength(3)

      await rebuiltEngine.close()
    },
  )
})
