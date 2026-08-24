import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeChatProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDocument } from './documents.js'
import type { DreamInsight, DreamLookup, RunDreamArgs } from './dreaming.js'
import { runDream, runExploration } from './dreaming.js'
import { readDreamLog } from './dreamLog.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

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

function runArgs(paths: MemoryPaths, chat: FakeChatProvider): RunDreamArgs {
  return {
    chat,
    model: 'fake',
    persona: 'P',
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
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
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
    const dirents = await readdir(paths.dreamsDir, { withFileTypes: true })
    const dreamDir = dirents.find((d) => d.isDirectory())
    expect(dreamDir?.name).toMatch(/^2026-08-24-dream_/)
    const insightDoc = await readDocument(join(paths.dreamsDir, dreamDir!.name, 'insight.md'))
    const insights = insightDoc.meta.insights as DreamInsight[]
    expect(insights).toHaveLength(1) // doc_missing dropped
    expect(insights[0]?.id).toMatch(/^ins_/)
    expect(insightDoc.meta.rngSeed).toBe(7)
    const dreamDoc = await readDocument(join(paths.dreamsDir, dreamDir!.name, 'dream.md'))
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
    const dirents = await readdir(paths.dreamsDir, { withFileTypes: true })
    const dreamDir = dirents.find((d) => d.isDirectory())
    const files = await readdir(join(paths.dreamsDir, dreamDir!.name))
    expect(files.sort()).toEqual(['insight.md', 'process.jsonl'])
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
})
