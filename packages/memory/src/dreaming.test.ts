import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeChatProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDocument } from './documents.js'
import type { DreamInsight, DreamLookup, RunDreamArgs } from './dreaming.js'
import { dreamInsightsOutputSchema, runDream, runExploration } from './dreaming.js'
import { readDreamLog } from './dreamLog.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { PROSE_VOICE_RULE } from './voice.js'

function fakeLookup(calls: string[]): DreamLookup {
  return {
    async search() {
      calls.push('search')
      return [{ docId: 'doc_1' }]
    },
    async readDocumentById() {
      calls.push('read')
      return null
    },
    async readTranscript() {
      calls.push('transcript')
      return []
    },
    neighbors() {
      calls.push('neighbors')
      return []
    },
  }
}

const searchCall = (id: string) => ({
  id,
  name: 'search_memory',
  arguments: JSON.stringify({ query: 'old arcs' }),
})

describe('runExploration', () => {
  it('dispatches tool calls and stops when the model stops', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [searchCall('t1')] },
      { text: 'done exploring', toolCalls: [] },
    ])
    const calls: string[] = []
    const events: Record<string, unknown>[] = []
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'PERSONA',
      lookup: fakeLookup(calls),
      maxToolCalls: 10,
      packet: 'PACKET',
      record: (e) => events.push(e),
    })
    expect(calls).toEqual(['search'])
    expect(chat.requests).toHaveLength(2)
    expect(chat.requests[0]?.system).toContain('PERSONA')
    expect(chat.requests[0]?.tools?.map((t) => t.name)).toEqual([
      'search_memory',
      'read_document',
      'read_transcript',
      'graph_query',
    ])
    expect(messages.at(-1)?.content).toBe('done exploring')
    expect(events.filter((e) => e.event === 'tool_call')).toHaveLength(1)
  })

  it('enforces the hard tool-call cap', async () => {
    const script = Array.from({ length: 6 }, (_, i) => ({
      text: '',
      toolCalls: [searchCall(`t${i}`)],
    }))
    const chat = new FakeChatProvider([...script, { text: 'stopped', toolCalls: [] }])
    const calls: string[] = []
    await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup(calls),
      maxToolCalls: 3,
      packet: 'PACKET',
      record: () => {},
    })
    expect(calls).toHaveLength(3)
    // 3 tool rounds + 1 wrap-up call after the budget-exhausted message.
    expect(chat.requests).toHaveLength(4)
    // The persona goes on every dreaming call, including the wrap-up round
    // after the budget is exhausted.
    expect(chat.requests.every((r) => r.system?.includes('P'))).toBe(true)
  })

  it('a single response over budget: the rest of that response is refused, none reach the lookup', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [searchCall('a'), searchCall('b'), searchCall('c')],
      },
      { text: 'wrap', toolCalls: [] },
    ])
    const calls: string[] = []
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup(calls),
      maxToolCalls: 1,
      packet: 'PACKET',
      record: () => {},
    })
    expect(calls).toHaveLength(1)
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(3)
    expect(toolMessages[1]?.content).toContain('exhausted')
    expect(toolMessages[2]?.content).toContain('exhausted')
    expect(messages.at(-1)?.content).toBe('wrap')
  })

  it('records exactly one budget_exhausted event, with the right refused count', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [searchCall('a'), searchCall('b'), searchCall('c')],
      },
      { text: 'wrap', toolCalls: [] },
    ])
    const events: Record<string, unknown>[] = []
    await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup([]),
      maxToolCalls: 1,
      packet: 'PACKET',
      record: (e) => events.push(e),
    })
    const toolCallEvents = events.filter((e) => e.event === 'tool_call')
    const budgetEvents = events.filter((e) => e.event === 'budget_exhausted')
    expect(toolCallEvents).toHaveLength(1)
    expect(budgetEvents).toHaveLength(1)
    expect(budgetEvents[0]).toMatchObject({ maxToolCalls: 1, refused: 2 })
  })

  it('a tool dispatch error becomes an error string result, not a crash', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'read_document', arguments: 'not json' }] },
      { text: 'ok', toolCalls: [] },
    ])
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup([]),
      maxToolCalls: 5,
      packet: 'PACKET',
      record: () => {},
    })
    const toolMessage = messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('error')
  })

  it('a tool call naming a tool that does not exist returns an error string result, not an exception', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'not_a_real_tool', arguments: '{}' }] },
      { text: 'ok', toolCalls: [] },
    ])
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup([]),
      maxToolCalls: 5,
      packet: 'PACKET',
      record: () => {},
    })
    const toolMessage = messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('error')
    expect(chat.requests).toHaveLength(2)
    expect(messages.at(-1)?.content).toBe('ok')
  })

  it('a lookup whose method throws returns an error string result, not an exception', async () => {
    const throwingLookup: DreamLookup = {
      async search() {
        throw new Error('search backend unavailable')
      },
      async readDocumentById() {
        return null
      },
      async readTranscript() {
        return []
      },
      neighbors() {
        return []
      },
    }
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [searchCall('t1')] },
      { text: 'ok', toolCalls: [] },
    ])
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: throwingLookup,
      maxToolCalls: 5,
      packet: 'PACKET',
      record: () => {},
    })
    const toolMessage = messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('error')
    expect(toolMessage?.content).toContain('search backend unavailable')
    expect(chat.requests).toHaveLength(2)
    expect(messages.at(-1)?.content).toBe('ok')
  })

  it('answers every tool call still requested on the final wrap-up round, without a second budget_exhausted event', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [searchCall('a')] }, // hits the cap
      { text: 'wrap', toolCalls: [searchCall('b')] }, // wrap-up, model still asks for a tool
    ])
    const events: Record<string, unknown>[] = []
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup([]),
      maxToolCalls: 1,
      packet: 'PACKET',
      record: (e) => events.push(e),
    })
    const requestedIds = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.toolCalls ?? [])
      .map((c) => c.id)
    const answeredIds = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId))
    for (const id of requestedIds) {
      expect(answeredIds.has(id)).toBe(true)
    }
    expect(events.filter((e) => e.event === 'budget_exhausted')).toHaveLength(1)
  })
})

const INSIGHTS_JSON = JSON.stringify({
  insights: [
    {
      kind: 'pattern',
      headline: 'Asking late',
      claim: 'It looks like help arrives only after weeks of solo effort.',
      confidence: 0.6,
      evidence: [{ doc: 'doc_ok' }],
    },
    {
      kind: 'open_question',
      headline: 'The garden',
      claim: 'Whatever happened to the balcony garden plan?',
      confidence: 0.5,
      evidence: [{ doc: 'doc_missing' }],
    },
  ],
})
const TONE_OK = JSON.stringify({ narrativeOk: true, flaggedInsightIndexes: [] })

const DISTINCTIVE_PERSONA = 'REVERIE_SAFETY_PERSONA_TOKEN_9f2c'

const GROUNDED_INSIGHTS_JSON = JSON.stringify({
  insights: [
    {
      kind: 'connection',
      headline: 'A steady thread',
      claim: 'It looks like this session returned to the same thread as before.',
      confidence: 0.5,
      evidence: [{ session: 'session_ok' }],
    },
    {
      kind: 'strength',
      headline: 'A durable habit',
      claim: 'It seems this habit has held up over time.',
      confidence: 0.7,
      evidence: [{ node: 'node_ok' }],
    },
  ],
})

function lookupResolving(okDocIds: string[]): DreamLookup {
  return {
    async search() {
      return []
    },
    async readDocumentById(docId: string) {
      return okDocIds.includes(docId) ? { path: '/x', meta: { id: docId }, body: 'b' } : null
    },
    async readTranscript() {
      throw new Error('no such session')
    },
    neighbors() {
      return []
    },
  }
}

function lookupGrounded(): DreamLookup {
  return {
    async search() {
      return []
    },
    async readDocumentById() {
      return null
    },
    async readTranscript(sessionId: string) {
      if (sessionId === 'session_ok') return []
      throw new Error('no such session')
    },
    neighbors() {
      return []
    },
  }
}

// The name of the single dream directory a run wrote. Every caller below has
// already asserted the run's outcome, so an absent directory means the run
// did not write what the test says it did: worth naming plainly rather than
// failing later with a TypeError on an undefined path segment.
async function dreamDirName(dreamsDir: string): Promise<string> {
  const dirents = await readdir(dreamsDir, { withFileTypes: true })
  const dreamDir = dirents.find((entry) => entry.isDirectory())
  if (dreamDir === undefined) {
    throw new Error(`expected one dream directory under ${dreamsDir}, found none`)
  }
  return dreamDir.name
}

function runArgs(paths: MemoryPaths, chat: FakeChatProvider): RunDreamArgs {
  return {
    chat,
    model: 'fake',
    persona: DISTINCTIVE_PERSONA,
    lookup: lookupResolving(['doc_ok']),
    paths,
    maxToolCalls: 4,
    voice: 'first',
    now: new Date('2026-08-24T05:00:00.000Z'),
    timezone: 'UTC',
    period: '2026-08-24',
    trigger: 'manual',
    rngSeed: 7,
    seeds: [],
    walk: [],
    seedBodies: ['seed body'],
    recentDreamDigest: '(no past dreams)',
    entitiesTouched: ['arc_01X'],
    resolveNode: () => false,
  }
}

describe('runDream', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-dreaming-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes dream.md, insight.md, process.jsonl and the log; drops unresolvable insights', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] }, // exploration wrap-up
      { text: INSIGHTS_JSON, toolCalls: [] }, // insights
      { text: 'A quiet shoreline...', toolCalls: [] }, // narrative
      { text: TONE_OK, toolCalls: [] }, // tone check
    ])
    const result = await runDream(runArgs(paths, chat))
    expect(result.outcome).toBe('written')
    const dirName = await dreamDirName(paths.dreamsDir)
    expect(dirName).toMatch(/^2026-08-24-dream_/)
    const insightDoc = await readDocument(paths.files, join(paths.dreamsDir, dirName, 'insight.md'))
    const insights = insightDoc.meta.insights as DreamInsight[]
    expect(insights).toHaveLength(1) // doc_missing dropped
    expect(insights[0]?.id).toMatch(/^ins_/)
    expect(insightDoc.meta.rngSeed).toBe(7)
    const dreamDoc = await readDocument(paths.files, join(paths.dreamsDir, dirName, 'dream.md'))
    expect(dreamDoc.meta.kind).toBe('dream')
    expect(dreamDoc.body).toContain('shoreline')
    const log = await readDreamLog(paths)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ type: 'dreamt', period: '2026-08-24', entities: ['arc_01X'] })
  })

  it('retries a bad insights response once, then aborts with nothing written', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    ])
    const result = await runDream(runArgs(paths, chat))
    expect(result.outcome).toBe('aborted')
    expect(await readdir(paths.dreamsDir)).toEqual([]) // no dir, no log
    expect(
      chat.requests.some((r) => r.messages.some((m) => m.content.includes('failed validation'))),
    ).toBe(true)
  })

  it('withholds the narrative after two failed tone checks but still writes insights', async () => {
    const TONE_BAD = JSON.stringify({
      narrativeOk: false,
      reason: 'dread',
      flaggedInsightIndexes: [],
    })
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      { text: 'dark narrative', toolCalls: [] },
      { text: TONE_BAD, toolCalls: [] },
      { text: 'second narrative', toolCalls: [] },
      { text: TONE_BAD, toolCalls: [] },
    ])
    const result = await runDream(runArgs(paths, chat))
    expect(result.outcome).toBe('written')
    // Pins the second attempt: a regression that skips regeneration and
    // withholds on the first tone failure would leave two scripted
    // responses unconsumed, which this length check catches.
    expect(chat.requests).toHaveLength(6)
    const dirName = await dreamDirName(paths.dreamsDir)
    const files = await readdir(join(paths.dreamsDir, dirName))
    expect(files.sort()).toEqual(['insight.md', 'process.jsonl'])
    const processRaw = await readFile(join(paths.dreamsDir, dirName, 'process.jsonl'), 'utf8')
    const processEvents = processRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(processEvents.some((e) => e.stage === 'narrative_retry')).toBe(true)
    expect(processEvents.some((e) => e.event === 'narrative_withheld')).toBe(true)
  })

  it('aborts with nothing written when every insight fails evidence resolution', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    args.lookup = lookupResolving([]) // no doc id resolves, so every insight's evidence fails
    const result = await runDream(args)
    expect(result.outcome).toBe('aborted')
    expect(await readdir(paths.dreamsDir)).toEqual([])
  })

  it('carries the persona in the system prompt of every model request the run makes', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      { text: 'a narrative', toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    const result = await runDream(args)
    expect(result.outcome).toBe('written')
    expect(chat.requests.length).toBeGreaterThan(0)
    for (const request of chat.requests) {
      expect(request.system ?? '').toContain(args.persona)
    }
  })

  it('carries the shared prose voice rule in the insights call and the narrative call, scoped to not flatten the dream register', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      { text: 'a narrative', toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    const result = await runDream(args)
    expect(result.outcome).toBe('written')

    const insightsPrompt = chat.requests[1]?.messages.at(-1)?.content ?? ''
    expect(insightsPrompt).toContain(PROSE_VOICE_RULE)

    const narrativePrompt = chat.requests[2]?.messages.at(-1)?.content ?? ''
    expect(narrativePrompt).toContain(PROSE_VOICE_RULE)
    // The dream's own register (non-literal recombination, gently positive)
    // must survive next to the mechanics rule, not be displaced by it.
    expect(narrativePrompt).toContain('gently positive')
    expect(narrativePrompt.toLowerCase()).toContain('mechanics only')
  })

  // docs/dreaming.md's Creative recombination section names higher
  // temperature for the narrative as deliberate: it is meant to be looser
  // and more associative than the hedged, structured insights. 0.9 must
  // still be sent as the caller's preference; a model that cannot honor it
  // is the provider's problem to solve (OpenAiChatProvider.complete's own
  // retry-and-warn behavior, tested in packages/providers), not a reason
  // for dreaming to stop asking for it.
  it('asks for temperature 0.9 on the narrative call, and on the narrative retry call', async () => {
    const toneRejectsOnce = JSON.stringify({
      narrativeOk: false,
      reason: 'too literal',
      flaggedInsightIndexes: [],
    })
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      { text: 'a narrative', toolCalls: [] },
      { text: toneRejectsOnce, toolCalls: [] },
      { text: 'a second narrative', toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    const result = await runDream(args)
    expect(result.outcome).toBe('written')

    // requests: [exploration, insights, narrative, tone_check, narrative_retry, tone_check_retry]
    expect(chat.requests[2]?.temperature).toBe(0.9)
    expect(chat.requests[4]?.temperature).toBe(0.9)
  })

  // Found live on 2026-08-25: when the provider had to drop temperature
  // because the model rejected it, that decision must not vanish. Dreams
  // are append-only and everything is meant to be inspectable (see this
  // file's own DREAM_EXPLORATION_INSTRUCTIONS-adjacent guardrails and
  // docs/dreaming.md's "Silent rewriting" failure mode), so a provider
  // warning belongs in the dream's own process.jsonl, the same as every
  // other pipeline decision.
  it('records a provider warning about a dropped temperature into process.jsonl', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      {
        text: 'a narrative',
        toolCalls: [],
        warnings: ['temperature 0.9 was not accepted for model fake and was dropped'],
      },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    const result = await runDream(args)
    expect(result.outcome).toBe('written')

    const dirName = await dreamDirName(paths.dreamsDir)
    const processLog = await readFile(join(paths.dreamsDir, dirName, 'process.jsonl'), 'utf8')
    const events = processLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const warningEvent = events.find((e) => e.event === 'provider_warning')
    expect(warningEvent).toMatchObject({
      stage: 'narrative',
      warnings: ['temperature 0.9 was not accepted for model fake and was dropped'],
    })
  })

  it('does not record a provider_warning event when the provider result carries none', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: INSIGHTS_JSON, toolCalls: [] },
      { text: 'a narrative', toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    const result = await runDream(args)
    expect(result.outcome).toBe('written')

    const dirName = await dreamDirName(paths.dreamsDir)
    const processLog = await readFile(join(paths.dreamsDir, dirName, 'process.jsonl'), 'utf8')
    expect(processLog).not.toContain('provider_warning')
  })

  it('grounds insights via session and node evidence pointers, not just doc pointers', async () => {
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: GROUNDED_INSIGHTS_JSON, toolCalls: [] },
      { text: 'a narrative', toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    args.lookup = lookupGrounded()
    args.resolveNode = (id) => id === 'node_ok'
    const result = await runDream(args)
    expect(result.outcome).toBe('written')
    const dirName = await dreamDirName(paths.dreamsDir)
    const insightDoc = await readDocument(paths.files, join(paths.dreamsDir, dirName, 'insight.md'))
    const insights = insightDoc.meta.insights as DreamInsight[]
    expect(insights).toHaveLength(2)
  })

  // Defect 5 from the 2026-08-25 dreaming investigation: the insights
  // instruction's own example showed only {"doc": "doc_id"}, which pushed
  // real models toward wrapping every evidence id (including node ids like
  // item_/person_/session_) under "doc" regardless of which space the id
  // actually came from. A node id wrapped under "doc" must still resolve,
  // because it names something real (verifiable via resolveNode), just
  // filed under the wrong key; a genuinely unresolvable id must still be
  // dropped, so this also proves that half still fails.
  it('resolves an evidence pointer whose real node id was wrapped under the wrong field, without admitting an id that resolves nowhere', async () => {
    const insightsJson = JSON.stringify({
      insights: [
        {
          kind: 'connection',
          headline: 'Mislabeled but real',
          claim: 'It looks like this connects to something seen while exploring.',
          confidence: 0.5,
          evidence: [{ doc: 'node_ok' }], // a real node id, wrapped under "doc"
        },
        {
          kind: 'open_question',
          headline: 'Genuinely unresolvable',
          claim: 'Whatever happened to this thread?',
          confidence: 0.4,
          evidence: [{ doc: 'nothing_matches_anywhere' }],
        },
      ],
    })
    const chat = new FakeChatProvider([
      { text: 'noted', toolCalls: [] },
      { text: insightsJson, toolCalls: [] },
      { text: 'a narrative', toolCalls: [] },
      { text: TONE_OK, toolCalls: [] },
    ])
    const args = runArgs(paths, chat)
    args.lookup = lookupResolving([]) // no doc id resolves for anything
    args.resolveNode = (id) => id === 'node_ok'
    const result = await runDream(args)
    expect(result.outcome).toBe('written')
    const dirName = await dreamDirName(paths.dreamsDir)
    const insightDoc = await readDocument(paths.files, join(paths.dreamsDir, dirName, 'insight.md'))
    const insights = insightDoc.meta.insights as DreamInsight[]
    expect(insights).toHaveLength(1)
    expect(insights[0]?.headline).toBe('Mislabeled but real')
  })
})

describe('dreamInsightsOutputSchema', () => {
  const baseInsight = {
    kind: 'pattern' as const,
    headline: 'A headline',
    claim: 'A claim.',
    confidence: 0.5,
  }

  it('rejects an evidence pointer that names none of doc, session, node', () => {
    const result = dreamInsightsOutputSchema.safeParse({
      insights: [{ ...baseInsight, evidence: [{}] }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an evidence pointer that names more than one of doc, session, node', () => {
    const result = dreamInsightsOutputSchema.safeParse({
      insights: [{ ...baseInsight, evidence: [{ doc: 'doc_1', node: 'node_1' }] }],
    })
    expect(result.success).toBe(false)
  })
})
