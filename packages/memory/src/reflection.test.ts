import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatProvider, FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordCommitment } from './commitments.js'
import { newId, readDocument, writeDocumentAtomic } from './documents.js'
import { appendGraph, readGraph } from './graph.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { pendingProposals } from './proposals.js'
import {
  applyReflection,
  buildReflectionPrompt,
  type ReflectionContext,
  type ReflectionItem,
  type ReflectionOutput,
  reflectionOutputSchema,
  reflectSession,
  resolveNarratives,
  rewriteNarrative,
} from './reflection.js'
import { type EmbedFn, MemoryIndex } from './sqlite.js'
import { SessionStore, type TranscriptLine } from './transcripts.js'
import { PROSE_VOICE_RULE } from './voice.js'

const TRANSCRIPT: TranscriptLine[] = [
  {
    ts: '2026-08-13T09:00:00.000Z',
    utcOffsetMinutes: 330,
    role: 'user',
    content: 'I went for a long run this morning.',
  },
  {
    ts: '2026-08-13T09:01:00.000Z',
    role: 'assistant',
    content: 'That sounds like a good start to the day.',
  },
]

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

// Most tests in this file exercise the graph/summary/narrative machinery,
// not materialization itself (that is MemoryEngine's job, tested at the
// engine level), so they pass this no-op in as materializeNew.
async function noopMaterialize(): Promise<void> {}

describe('reflectionOutputSchema', () => {
  it('accepts a full newPersons entry with deservesPage true and a narrative', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      newPersons: [
        {
          name: 'Sam',
          reason: 'a close friend',
          itemIndexes: [0],
          deservesPage: true,
          narrative: 'Sam.',
        },
      ],
    }
    const result = reflectionOutputSchema.safeParse(out)
    expect(result.success).toBe(true)
  })

  it('accepts a newEntities entry, which carries no page-worthiness field at all', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      newEntities: [{ name: 'A Favorite Film', reason: 'watched again', itemIndexes: [0] }],
    }
    const result = reflectionOutputSchema.safeParse(out)
    expect(result.success).toBe(true)
  })

  it('accepts a pagePromotions entry', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      pagePromotions: [
        { nodeId: 'person_sam', reason: 'recurs now', itemIndexes: [0], narrative: 'Sam.' },
      ],
    }
    const result = reflectionOutputSchema.safeParse(out)
    expect(result.success).toBe(true)
  })

  it('rejects a newPersons entry missing deservesPage', () => {
    const raw = {
      ...emptyReflectionOutput('A session.'),
      newPersons: [{ name: 'Sam', reason: 'a close friend', itemIndexes: [0], narrative: 'Sam.' }],
    }
    const result = reflectionOutputSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('rejects a whole output missing newEntities or pagePromotions entirely', () => {
    const { newEntities, pagePromotions, ...rest } = emptyReflectionOutput('A session.')
    const result = reflectionOutputSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('accepts journalingUpdate as null', () => {
    const out: ReflectionOutput = { ...emptyReflectionOutput('A session.'), journalingUpdate: null }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('accepts journalingUpdate as a full replacement body', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      journalingUpdate: 'Switched from gratitude to the examen.',
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('rejects a whole output missing journalingUpdate entirely', () => {
    const { journalingUpdate, ...rest } = {
      ...emptyReflectionOutput('A session.'),
      journalingUpdate: null,
    }
    expect(reflectionOutputSchema.safeParse(rest).success).toBe(false)
  })

  it('accepts commitments with a gloss for a time it could not resolve', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitments: [
        {
          label: 'Start swimming',
          flavor: 'plan',
          statedTime: 'come summer',
          gloss:
            'Said on 2026-08-24. Summer where they live, Bangalore, runs roughly February to May, so this points at early 2027 rather than the middle of the year.',
          bracketFrom: '2027-02-01',
          bracketTo: '2027-05-31',
          confidence: 'medium',
        },
      ],
    }
    const parsed = reflectionOutputSchema.safeParse(out)
    expect(parsed.success).toBe(true)
  })

  it('accepts a commitment with no stated time at all', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitments: [{ label: 'Pick up dry cleaning', flavor: 'errand' }],
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('rejects a gloss with no stated words to interpret', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitments: [{ label: 'x', flavor: 'plan', gloss: 'invented from nothing' }],
    }
    const parsed = reflectionOutputSchema.safeParse(out)
    expect(parsed.success).toBe(false)
    // Not just success:false: the failure must actually name the
    // gloss/statedTime problem, or this test would pass for the wrong
    // reason (e.g. a required key missing elsewhere in the literal) and
    // the falsification below would prove nothing.
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('statedTime'))).toBe(true)
    }
  })

  it('rejects a commitmentRevisions gloss with no stated words to interpret', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitmentRevisions: [{ commitmentId: 'commitment_1', gloss: 'invented from nothing' }],
    }
    const parsed = reflectionOutputSchema.safeParse(out)
    expect(parsed.success).toBe(false)
  })

  it('rejects a commitment bracket date that is not YYYY-MM-DD', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitments: [
        {
          label: 'Start swimming',
          flavor: 'plan',
          statedTime: 'come summer',
          gloss: 'Points at next February.',
          bracketFrom: 'February 2027',
          confidence: 'medium',
        },
      ],
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(false)
  })

  it('accepts a commitmentRevisions entry that only changes the label', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitmentRevisions: [{ commitmentId: 'commitment_1', label: 'See Nightfall with Arjun' }],
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('accepts an output with commitments and commitmentRevisions entirely absent', () => {
    const out = emptyReflectionOutput('A session with no commitments.')
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('accepts statedPrecision on a commitment and on a revision (Important 5)', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitments: [
        {
          label: 'Start swimming',
          flavor: 'plan',
          statedTime: 'come summer',
          gloss: 'Points at next February.',
          confidence: 'medium',
          statedPrecision: 'period',
        },
      ],
      commitmentRevisions: [
        {
          commitmentId: 'commitment_1',
          statedTime: 'someday',
          gloss: 'No shape to it.',
          statedPrecision: 'vague',
        },
      ],
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('accepts clearTiming on a commitmentRevisions entry (Important 6)', () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitmentRevisions: [{ commitmentId: 'commitment_1', clearTiming: true }],
    }
    expect(reflectionOutputSchema.safeParse(out).success).toBe(true)
  })

  it('accepts commitmentResolutions with a valid outcome and rejects unknown as an outcome (Important 3)', () => {
    const accepted: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      commitmentResolutions: [{ commitmentId: 'commitment_1', outcome: 'done' }],
    }
    expect(reflectionOutputSchema.safeParse(accepted).success).toBe(true)

    // 'unknown' is reserved for the real askedAt/one-ask mechanism
    // (BACKLOG.md), which reflection has no live-session signal for.
    const rejected = {
      ...emptyReflectionOutput('A session.'),
      commitmentResolutions: [{ commitmentId: 'commitment_1', outcome: 'unknown' }],
    }
    expect(reflectionOutputSchema.safeParse(rejected).success).toBe(false)
  })
})

describe('reflection', () => {
  let dir: string
  let paths: MemoryPaths
  let sessionId: string
  let sessionDir: string
  let arcDocPath: string
  let arcDocId: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')

    sessionId = newId('session')
    sessionDir = join(paths.sessionsDir, `2026-08-13-${sessionId}`)
    await mkdir(sessionDir, { recursive: true })

    arcDocPath = join(paths.arcsDir, 'health.md')
    arcDocId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: arcDocPath,
      meta: { id: arcDocId, name: 'Health' },
      body: 'Original arc narrative.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_health',
        type: 'arc',
        label: 'Health',
        doc: arcDocPath,
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_health',
        type: 'realm',
        label: 'Health',
      },
    ])
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('reflectSession', () => {
    it('parses a valid scripted reply on the first try', async () => {
      const out = emptyReflectionOutput('A quiet, reflective session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      expect(result).toEqual(out)
      expect(chat.requests).toHaveLength(1)
    })

    it('includes the constitution, arc and realm listings with ids, and the transcript in the prompt', async () => {
      const out = emptyReflectionOutput('A quiet, reflective session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])

      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'The user values honesty over comfort.',
        arcs: [{ id: 'arc_health', type: 'arc', label: 'Health', ts: '2026-08-01T00:00:00.000Z' }],
        realms: [
          { id: 'realm_health', type: 'realm', label: 'Health', ts: '2026-08-01T00:00:00.000Z' },
        ],
        people: [
          { id: 'person_sam', type: 'person', label: 'Sam', ts: '2026-08-01T00:00:00.000Z' },
        ],
        entities: [],
        profile: { id: 'doc_test' },
      })

      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('The user values honesty over comfort.')
      expect(prompt).toContain('arc_health: Health')
      expect(prompt).toContain('realm_health: Health')
      expect(prompt).toContain('person_sam: Sam')
      expect(prompt).toContain(
        '[Thu 2026-08-13 14:30 UTC+05:30] user: I went for a long run this morning.',
      )
      expect(prompt).toContain(
        '[2026-08-13T09:01:00.000Z (UTC; local time unknown)] assistant: That sounds like a good start to the day.',
      )
      expect(prompt).toContain('"constitutionUpdate": string | null')
      expect(prompt).toContain('Facts and meaning go to two different places.')
      expect(prompt).toContain('goes in profileUpdates')
    })

    it('lists known people by id, label, and page status, known entities by id and label only, and states what makes someone worth a person page', async () => {
      const out = emptyReflectionOutput('A session mentioning a few names.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])

      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [
          { id: 'person_sam', type: 'person', label: 'Sam', ts: '2026-08-01T00:00:00.000Z' },
          {
            id: 'person_alex',
            type: 'person',
            label: 'Alex',
            doc: '/tmp/alex.md',
            ts: '2026-08-01T00:00:00.000Z',
          },
        ],
        entities: [
          {
            id: 'entity_film',
            type: 'entity',
            label: 'A Favorite Film',
            ts: '2026-08-01T00:00:00.000Z',
          },
        ],
        profile: { id: 'doc_test' },
      })

      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('Known people:')
      expect(prompt).toContain('person_sam: Sam (no page yet)')
      expect(prompt).toContain('person_alex: Alex (has a page)')
      expect(prompt).toContain('Known entities:')
      // Entities never get a page in this release, so their listing (unlike
      // people's) carries no page-status suffix.
      expect(prompt).toContain('entity_film: A Favorite Film')
      expect(prompt).not.toContain('entity_film: A Favorite Film (no page yet)')
      expect(prompt).toContain("recurs in this person's life")
      expect(prompt).toContain('pagePromotions')
      expect(prompt).toContain('newEntities')
      expect(prompt).toContain('deservesPage')
      expect(prompt).toContain('"arcUpdates": [{"arcId": string, "note": string}]')
      expect(prompt).toContain('"personUpdates": [{"personId": string, "note": string}]')
      expect(prompt).not.toContain('arcNarratives')
    })

    it('retries once when the reply is valid JSON but fails schema validation', async () => {
      const out = emptyReflectionOutput('Recovered after a schema failure.')
      const chat = new FakeChatProvider([
        { text: '{"summary": 123, "items": []}', toolCalls: [] },
        { text: JSON.stringify(out), toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      expect(result).toEqual(out)
      expect(chat.requests).toHaveLength(2)
      const retryPrompt = chat.requests[1]?.messages[0]?.content ?? ''
      expect(retryPrompt).toContain('failed validation')
      expect(retryPrompt).toContain('summary')
    })

    it('retries once when confidence is outside the valid 0-1 range', async () => {
      const badOut = {
        ...emptyReflectionOutput('Bad confidence scale.'),
        items: [{ text: 'Went for a run', kind: 'event' }],
        attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 1.5 }],
      }
      const goodOut = emptyReflectionOutput('Recovered with a valid confidence.')
      const chat = new FakeChatProvider([
        { text: JSON.stringify(badOut), toolCalls: [] },
        { text: JSON.stringify(goodOut), toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      expect(result).toEqual(goodOut)
      expect(chat.requests).toHaveLength(2)
      const retryPrompt = chat.requests[1]?.messages[0]?.content ?? ''
      expect(retryPrompt).toContain('failed validation')
    })

    it('retries once on malformed JSON and consumes the second scripted result', async () => {
      const out = emptyReflectionOutput('Recovered after a retry.')
      const chat = new FakeChatProvider([
        { text: 'this is not json', toolCalls: [] },
        { text: JSON.stringify(out), toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      expect(result).toEqual(out)
      expect(chat.requests).toHaveLength(2)
      expect(chat.requests[1]?.messages[0]?.content).toContain('failed validation')
      expect(chat.requests[1]?.messages[0]?.content).toContain('this is not json')
    })

    it('degrades to a summary-only result after two malformed replies', async () => {
      const chat = new FakeChatProvider([
        { text: 'still not json', toolCalls: [] },
        { text: 'also not json', toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      expect(result).toEqual({ summary: 'also not json', degraded: true })
      expect(chat.requests).toHaveLength(2)
    })

    it('falls back to a plain line when the second reply has no usable text', async () => {
      const chat = new FakeChatProvider([
        { text: 'not json', toolCalls: [] },
        { text: '   ', toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      expect(result).toEqual({
        summary: 'Reflection could not be parsed for this session.',
        degraded: true,
      })
    })

    it('accepts profileUpdates across the full allowlist, and routes facts to the profile rather than the constitution', async () => {
      const withUpdate = {
        ...emptyReflectionOutput('They mentioned moving to Berlin.'),
        profileUpdates: { timezone: 'Europe/Berlin', location: 'Berlin' },
      }
      expect(reflectionOutputSchema.safeParse(withUpdate).success).toBe(true)

      // An empty object is valid: nothing to update this session.
      const withNothing = {
        ...emptyReflectionOutput('Nothing to update.'),
        profileUpdates: {},
      }
      expect(reflectionOutputSchema.safeParse(withNothing).success).toBe(true)

      // profileUpdates no longer accepts null for any field; the model
      // omits a key entirely rather than nulling it.
      const withNull = {
        ...emptyReflectionOutput('Nothing to update.'),
        profileUpdates: { timezone: null },
      }
      expect(reflectionOutputSchema.safeParse(withNull).success).toBe(false)

      // Absent entirely is also valid, which is what every existing fixture
      // in this file relies on.
      expect(reflectionOutputSchema.safeParse(emptyReflectionOutput('Plain.')).success).toBe(true)

      const chat = new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('Plain.')), toolCalls: [] },
      ])
      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'The user values honesty over comfort.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })

      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('their timezone')
      expect(prompt).toContain('goes in profileUpdates')
      expect(prompt).toContain('"profileUpdates"')
    })

    it('includes the current journaling setup, or its absence, in the prompt', async () => {
      const out = emptyReflectionOutput('A session about switching journaling methods.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        journalingProtocol: 'Gratitude, three times a week.',
        profile: { id: 'doc_test' },
      })
      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('Gratitude, three times a week.')
    })

    it('states journaling is not yet set up when journalingProtocol is absent', async () => {
      const out = emptyReflectionOutput('A first session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })
      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('never journaled before')
    })
  })

  describe('rewriteNarrative', () => {
    it('returns the parsed body on the first valid reply', async () => {
      const chat = new FakeChatProvider([
        { text: JSON.stringify({ body: 'Updated body.' }), toolCalls: [] },
      ])

      const result = await rewriteNarrative(chat, 'fake-model', {
        name: 'Health',
        currentBody: 'Original arc narrative.\n',
        summary: 'A quiet session.',
        itemTexts: ['Went for a run'],
        note: 'Went for another run.',
      })

      expect(result).toEqual({ body: 'Updated body.' })
      expect(chat.requests).toHaveLength(1)
      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('Original arc narrative.')
      expect(prompt).toContain('Went for another run.')
    })

    it('carries the shared prose voice rule, before the JSON response instruction', async () => {
      const chat = new FakeChatProvider([
        { text: JSON.stringify({ body: 'Updated body.' }), toolCalls: [] },
      ])

      await rewriteNarrative(chat, 'fake-model', {
        name: 'Health',
        currentBody: 'Original arc narrative.\n',
        summary: 'A quiet session.',
        itemTexts: ['Went for a run'],
        note: 'Went for another run.',
      })

      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain(PROSE_VOICE_RULE)
      expect(prompt.indexOf(PROSE_VOICE_RULE)).toBeLessThan(
        prompt.indexOf('Respond with only JSON matching this shape'),
      )
    })

    it('retries once on malformed JSON, then returns null if the retry also fails', async () => {
      const chat = new FakeChatProvider([
        { text: 'not json', toolCalls: [] },
        { text: 'still not json', toolCalls: [] },
      ])

      const result = await rewriteNarrative(chat, 'fake-model', {
        name: 'Health',
        currentBody: 'Original arc narrative.\n',
        summary: 'A quiet session.',
        itemTexts: [],
        note: 'Went for another run.',
      })

      expect(result).toBeNull()
      expect(chat.requests).toHaveLength(2)
      const retryPrompt = chat.requests[1]?.messages[0]?.content ?? ''
      expect(retryPrompt).toContain('failed validation')
      expect(retryPrompt).toContain('not json')
    })
  })

  describe('resolveNarratives', () => {
    it('calls rewriteNarrative once per arcUpdates entry that resolves to an existing arc with a doc', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        items: [{ text: 'Went for a run', kind: 'event' }],
        attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
        arcUpdates: [{ arcId: 'arc_health', note: 'Went for another run.' }],
      }
      const chat = new FakeChatProvider([
        { text: JSON.stringify({ body: 'New body.' }), toolCalls: [] },
      ])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.get('arc_health')).toBe('New body.')
      expect(chat.requests).toHaveLength(1)
      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('Original arc narrative.')
      expect(prompt).toContain('Went for a run')
    })

    it('drops an arcUpdates entry whose id does not resolve to an existing node', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        arcUpdates: [{ arcId: 'arc_does_not_exist', note: 'Should be dropped.' }],
      }
      const chat = new FakeChatProvider([])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.size).toBe(0)
      expect(chat.requests).toHaveLength(0)
    })

    it('drops a personUpdates entry that resolves to a node with no doc', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_sam',
          type: 'person',
          label: 'Sam',
        },
      ])
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        personUpdates: [{ personId: 'person_sam', note: 'Should be dropped, no doc.' }],
      }
      const chat = new FakeChatProvider([])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.size).toBe(0)
      expect(chat.requests).toHaveLength(0)
    })

    it('drops a personUpdates entry that resolves to an entity node, which is never a valid pass two target since entities get no page in this release', async () => {
      // An entity node created node-only, exactly what newEntities produces:
      // no doc, because entities never get a page in this release. A model
      // mistakenly listing this id in personUpdates (entity ids are never
      // shown as valid personUpdates targets, but nothing stops a model
      // from trying) must be dropped safely, not throw or attempt a rewrite.
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'entity_film',
          type: 'entity',
          label: 'A Favorite Film',
        },
      ])
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        personUpdates: [
          { personId: 'entity_film', note: 'Should be dropped, entities have no page.' },
        ],
      }
      const chat = new FakeChatProvider([])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.size).toBe(0)
      expect(chat.requests).toHaveLength(0)
    })

    it('drops an update entry that resolves to a node that is neither arc nor person, isolated from the no-doc case by giving that node a real doc', async () => {
      // realm_health in beforeEach has no doc at all, which would drop this
      // update on the missing-doc check alone and prove nothing about the
      // type check. Giving this realm its own doc means the only reason
      // left for the drop is that a realm is not a valid pass two target,
      // which is the actual rule this test exists to cover.
      const realmDocPath = join(paths.realmsDir, 'health.md')
      await writeDocumentAtomic(paths.files, {
        path: realmDocPath,
        meta: { id: newId('doc'), name: 'Health' },
        body: 'A realm page, not an arc or person page.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'realm_health_with_doc',
          type: 'realm',
          label: 'Health',
          doc: realmDocPath,
        },
      ])
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        arcUpdates: [
          { arcId: 'realm_health_with_doc', note: 'A realm is not a valid pass two target.' },
        ],
      }
      const chat = new FakeChatProvider([])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.size).toBe(0)
      expect(chat.requests).toHaveLength(0)
    })

    it('drops the map entry when rewriteNarrative itself returns null', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        arcUpdates: [{ arcId: 'arc_health', note: 'Went for another run.' }],
      }
      const chat = new FakeChatProvider([
        { text: 'not json', toolCalls: [] },
        { text: 'still not json', toolCalls: [] },
      ])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.has('arc_health')).toBe(false)
    })

    it('drops the arcUpdates entry for an arc also named in newArcs this session', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with a naming collision.'),
        newArcs: [
          {
            name: 'Health',
            realm: 'realm_health',
            reason: 'mistakenly proposed again',
            itemIndexes: [],
            narrative: 'unused',
          },
        ],
        arcUpdates: [{ arcId: 'arc_health', note: 'Should be dropped due to overlap.' }],
      }
      const chat = new FakeChatProvider([])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.has('arc_health')).toBe(false)
      expect(chat.requests).toHaveLength(0)
    })

    it('drops the personUpdates entry for a person also named in newPersons this session', async () => {
      const personDocPath = join(paths.peopleDir, 'sam.md')
      await writeDocumentAtomic(paths.files, {
        path: personDocPath,
        meta: { id: newId('doc'), name: 'Sam' },
        body: 'Original person narrative.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_sam',
          type: 'person',
          label: 'Sam',
          doc: personDocPath,
        },
      ])
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with a person naming collision.'),
        newPersons: [
          {
            name: 'Sam',
            reason: 'mistakenly proposed again',
            itemIndexes: [],
            deservesPage: true,
            narrative: 'unused',
          },
        ],
        personUpdates: [{ personId: 'person_sam', note: 'Should be dropped due to overlap.' }],
      }
      const chat = new FakeChatProvider([])

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

      expect(narratives.has('person_sam')).toBe(false)
      expect(chat.requests).toHaveLength(0)
    })
  })

  describe('applyReflection', () => {
    const now = new Date('2026-08-13T10:00:00.000Z')

    it('writes a narrative document only for ids present in the narratives map', async () => {
      const out = emptyReflectionOutput('A session.')
      const narratives = new Map([['arc_health', 'Rewritten by pass two.']])

      await applyReflection(paths, out, sessionId, [], now, narratives, noopMaterialize, 'UTC')

      const arcDoc = await readDocument(paths.files, arcDocPath)
      expect(arcDoc.body).toBe('Rewritten by pass two.\n')
      expect(arcDoc.meta.updated).toBe(now.toISOString())
    })

    it('leaves the arc document byte for byte unchanged when the narratives map has no entry for it', async () => {
      const out = emptyReflectionOutput('A session.')
      const before = await readDocument(paths.files, arcDocPath)

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const after = await readDocument(paths.files, arcDocPath)
      expect(after.body).toBe(before.body)
      expect(after.meta.updated).toBeUndefined()
    })

    it('writes the summary and asserts every attribution as a part_of edge, appending nothing to proposals.jsonl', async () => {
      const out: ReflectionOutput = {
        summary: 'Talked about a morning run and an upcoming deadline.',
        items: [
          { text: 'Went for a long run', kind: 'event' },
          { text: 'Feeling anxious about a work deadline', kind: 'feeling' },
        ],
        attributions: [
          { itemIndex: 0, arcId: 'arc_health', confidence: 0.9 },
          { itemIndex: 1, arcId: 'arc_unknown', confidence: 0.3 },
        ],
        newArcs: [],
        newPersons: [],
        newEntities: [],
        pagePromotions: [],
        arcUpdates: [],
        personUpdates: [],
        constitutionUpdate: null,
        journalingUpdate: null,
      }

      const result = await applyReflection(
        paths,
        out,
        sessionId,
        [],
        now,
        new Map(),
        noopMaterialize,
        'UTC',
      )

      const runItem = result.mintedItems[0]
      const deadlineItem = result.mintedItems[1]
      if (!runItem || !deadlineItem) throw new Error('expected two minted items')

      expect(result.summaryDoc.body).toBe(`${out.summary}\n`)
      expect(result.autoAsserted).toBe(2)

      // Summary document: kind, session, date, and the minted items.
      expect(result.summaryDoc.meta.kind).toBe('summary')
      expect(result.summaryDoc.meta.session).toBe(sessionId)
      expect(result.summaryDoc.meta.date).toBe('2026-08-13')
      const items = result.summaryDoc.meta.items as ReflectionItem[]
      expect(items).toHaveLength(2)
      expect(items[0]?.text).toBe('Went for a long run')
      expect(items[0]?.kind).toBe('event')
      expect(items[0]?.ts).toBe(now.toISOString())
      expect(items[1]?.text).toBe('Feeling anxious about a work deadline')
      expect(items[1]?.kind).toBe('feeling')
      expect(items[1]?.ts).toBe(now.toISOString())

      const onDisk = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      expect(onDisk.body).toBe(result.summaryDoc.body)

      // Graph: item nodes, from-edges, and every attribution asserted.
      const graph = await readGraph(paths)

      expect(graph.nodes.get(runItem.id)).toMatchObject({
        type: 'item',
        label: 'Went for a long run',
        doc: join(sessionDir, 'summary.md'),
      })
      expect(graph.edges.get(`from:${runItem.id}:${sessionId}`)).toMatchObject({ confirmed: true })

      // The session node itself must be asserted, or the from-edge above
      // is written to the log and then dropped by the index (dangling
      // endpoint).
      expect(graph.nodes.get(sessionId)).toMatchObject({
        type: 'session',
        label: '2026-08-13',
        doc: join(sessionDir, 'summary.md'),
      })

      expect(graph.edges.get(`part_of:${runItem.id}:arc_health`)).toMatchObject({
        confidence: 0.9,
        confirmed: false,
      })

      // Low confidence no longer routes to a proposal; it is asserted too,
      // even though arc_unknown does not resolve to any real node.
      expect(graph.edges.get(`part_of:${deadlineItem.id}:arc_unknown`)).toMatchObject({
        confidence: 0.3,
        confirmed: false,
      })

      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)
      await expect(readFile(paths.proposals, 'utf8')).rejects.toThrow()
    })

    it('appends nothing to proposals.jsonl even for a session with new arcs and persons', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with new things to remember.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'marathon training',
            realm: 'realm_health',
            reason: 'mentioned running multiple times',
            itemIndexes: [0],
            narrative: 'Training for a marathon this fall.',
          },
        ],
        newPersons: [
          {
            name: 'Sam',
            reason: 'running partner',
            itemIndexes: [0],
            deservesPage: true,
            narrative: 'Sam runs with them.',
          },
        ],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)
      await expect(readFile(paths.proposals, 'utf8')).rejects.toThrow()
    })

    it('rewrites the constitution when constitutionUpdate is set', async () => {
      const out = {
        ...emptyReflectionOutput('A session that touched something foundational.'),
        constitutionUpdate: 'Updated constitution body.',
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const constitutionDoc = await readDocument(paths.files, paths.constitution)
      expect(constitutionDoc.body).toBe('Updated constitution body.\n')
      expect(constitutionDoc.meta.updated).toBe(now.toISOString())
    })

    it('still writes summary.md for a degraded, summary-only reflection', async () => {
      const chat = new FakeChatProvider([
        { text: 'nope', toolCalls: [] },
        { text: 'still nope', toolCalls: [] },
      ])

      const degraded = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test' },
      })
      expect('degraded' in degraded && degraded.degraded).toBe(true)

      // The engine wraps a degraded result into a full ReflectionOutput before
      // calling applyReflection; this test exercises that wrapped shape.
      const wrapped = emptyReflectionOutput((degraded as { summary: string }).summary)
      const result = await applyReflection(
        paths,
        wrapped,
        sessionId,
        [],
        now,
        new Map(),
        noopMaterialize,
        'UTC',
      )

      expect(result.summaryDoc.body).toBe('still nope\n')
      expect(result.summaryDoc.meta.items).toEqual([])
      expect(result.autoAsserted).toBe(0)

      const onDisk = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      expect(onDisk.body).toBe('still nope\n')
    })

    it('dedupes live items against minted items by case-insensitive exact text', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A run and a phone call.'),
        items: [{ text: 'Went for a run', kind: 'event' }],
      }
      const liveItems: ReflectionItem[] = [
        {
          id: newId('item'),
          text: 'went for a run',
          kind: 'event',
          ts: '2026-08-13T08:00:00.000Z',
        },
        { id: newId('item'), text: 'Called mom', kind: 'event', ts: '2026-08-13T08:05:00.000Z' },
      ]

      const result = await applyReflection(
        paths,
        out,
        sessionId,
        liveItems,
        now,
        new Map(),
        noopMaterialize,
        'UTC',
      )

      const items = result.summaryDoc.meta.items as ReflectionItem[]
      expect(items).toHaveLength(2)
      expect(items.map((item) => item.text)).toEqual(['Went for a run', 'Called mom'])
      expect(items[1]?.id).toBe(liveItems[1]?.id)

      const graph = await readGraph(paths)
      expect(graph.nodes.has(liveItems[1]?.id as string)).toBe(true)
      // The duplicate live item never got its own node under a new id.
      expect(graph.nodes.has(liveItems[0]?.id as string)).toBe(false)
    })

    it('leaves the session unreflected and retryable if the summary write fails after graph/proposal writes succeed', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Should not fully persist.'),
        items: [{ text: 'Went for a run', kind: 'event' }],
      }

      // Remove write permission on the session dir so writeDocumentAtomic's
      // summary.md write (the last step) fails, while graph.jsonl (which
      // lives outside the session dir) still succeeds.
      await chmod(sessionDir, 0o500)
      try {
        await expect(
          applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC'),
        ).rejects.toThrow()
      } finally {
        await chmod(sessionDir, 0o700)
      }

      const graph = await readGraph(paths)
      const itemNodes = [...graph.nodes.values()].filter((node) => node.type === 'item')
      expect(itemNodes).toHaveLength(1)

      await expect(readDocument(paths.files, join(sessionDir, 'summary.md'))).rejects.toThrow()
    })

    it('runs materializeNew before the summary write, and leaves the session unreflected and retryable if it throws', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Should not fully persist either.'),
        items: [{ text: 'Went for a run', kind: 'event' }],
      }
      let calledWith: ReflectionItem[] | undefined
      const failingMaterialize = async (mintedItems: ReflectionItem[]): Promise<void> => {
        calledWith = mintedItems
        throw new Error('materialization failed')
      }

      await expect(
        applyReflection(paths, out, sessionId, [], now, new Map(), failingMaterialize, 'UTC'),
      ).rejects.toThrow('materialization failed')

      // It was actually invoked, with the minted item, before the throw.
      expect(calledWith).toHaveLength(1)
      expect(calledWith?.[0]?.text).toBe('Went for a run')

      // Graph writes made before materializeNew still landed (harmless on
      // retry), but the summary write after it never ran: the session is
      // still unreflected.
      const graph = await readGraph(paths)
      const itemNodes = [...graph.nodes.values()].filter((node) => node.type === 'item')
      expect(itemNodes).toHaveLength(1)

      await expect(readDocument(paths.files, join(sessionDir, 'summary.md'))).rejects.toThrow()
    })

    it('writes the local date derived from the transcript first line, not the directory prefix', async () => {
      const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
      await store.appendLine(paths, {
        ts: '2026-08-15T21:00:00.000Z',
        utcOffsetMinutes: 330,
        role: 'user',
        content: 'Late one.',
      })

      const { summaryDoc } = await applyReflection(
        paths,
        emptyReflectionOutput('A late Saturday night.'),
        store.sessionId,
        [],
        new Date('2026-08-16T04:00:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )

      expect(summaryDoc.meta.date).toBe('2026-08-16')
      expect(summaryDoc.path).toBe(join(store.dir, 'summary.md'))
    })

    it('falls back to the directory prefix when the first line carries no offset', async () => {
      const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
      await store.appendLine(paths, {
        ts: '2026-08-15T21:00:00.000Z',
        role: 'user',
        content: 'A line written before offsets existed.',
      })

      const { summaryDoc } = await applyReflection(
        paths,
        emptyReflectionOutput('An older session.'),
        store.sessionId,
        [],
        new Date('2026-08-16T04:00:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )

      expect(summaryDoc.meta.date).toBe('2026-08-15')
    })

    it('accepts and mints an item carrying an event time distinct from its record time', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('An evening plan.'),
        items: [
          { text: 'Watching Halcyon', kind: 'event', eventTime: 'tonight at 7:25pm' },
          { text: 'Feeling behind lately', kind: 'feeling' },
        ],
      }
      expect(reflectionOutputSchema.safeParse(out).success).toBe(true)

      const store = await SessionStore.start(paths, new Date('2026-08-16T10:49:00Z'), 'UTC')
      await store.appendLine(paths, {
        ts: '2026-08-16T10:49:00.000Z',
        utcOffsetMinutes: 330,
        role: 'user',
        content: 'Watching Halcyon tonight at 7.25pm',
      })

      const { mintedItems } = await applyReflection(
        paths,
        out,
        store.sessionId,
        [],
        new Date('2026-08-16T10:49:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )

      expect(mintedItems[0]?.eventTime).toBe('tonight at 7:25pm')
      expect(mintedItems[0]?.ts).toBe('2026-08-16T10:49:00.000Z')
      expect(mintedItems[1]?.eventTime).toBeUndefined()
    })

    it('reflectionOutputSchema normalizes an empty or whitespace-only item eventTime to absent, the model\'s \'"eventTime": ""\' shape rather than an omitted key', () => {
      const out = {
        ...emptyReflectionOutput('An evening plan.'),
        items: [
          { text: 'Watching Halcyon', kind: 'event', eventTime: '' },
          { text: 'Watching Nightfall', kind: 'event', eventTime: '   ' },
          { text: 'Feeling behind lately', kind: 'feeling' },
        ],
      }
      const parsed = reflectionOutputSchema.safeParse(out)
      expect(parsed.success).toBe(true)
      if (!parsed.success) return
      expect(parsed.data.items[0]?.eventTime).toBeUndefined()
      expect(parsed.data.items[1]?.eventTime).toBeUndefined()
      expect(parsed.data.items[2]?.eventTime).toBeUndefined()
      // Absent means the key itself is gone, not present with value
      // undefined: the two read differently to `'eventTime' in item`, and
      // only the former matches what an omitted key produces.
      expect('eventTime' in (parsed.data.items[0] ?? {})).toBe(false)
      expect('eventTime' in (parsed.data.items[1] ?? {})).toBe(false)
    })

    it('mints an item with an empty or whitespace-only eventTime as fully absent, and the indexed chunk carries no fabricated anchor', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('An evening plan.'),
        items: [
          { text: 'Watching Halcyon empty case', kind: 'event', eventTime: '' },
          { text: 'Watching Nightfall whitespace case', kind: 'event', eventTime: '   ' },
          { text: 'Feeling behind lately absent case', kind: 'feeling' },
        ],
      }

      const store = await SessionStore.start(paths, new Date('2026-08-16T10:49:00Z'), 'UTC')
      await store.appendLine(paths, {
        ts: '2026-08-16T10:49:00.000Z',
        utcOffsetMinutes: 330,
        role: 'user',
        content: 'Watching Halcyon tonight',
      })

      const { mintedItems, summaryDoc } = await applyReflection(
        paths,
        out,
        store.sessionId,
        [],
        new Date('2026-08-16T10:49:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )

      expect(mintedItems[0]?.eventTime).toBeUndefined()
      expect(mintedItems[1]?.eventTime).toBeUndefined()
      expect(mintedItems[2]?.eventTime).toBeUndefined()
      expect('eventTime' in (mintedItems[0] ?? {})).toBe(false)
      expect('eventTime' in (mintedItems[1] ?? {})).toBe(false)

      const dbPath = join(
        await mkdtemp(join(tmpdir(), 'openreverie-reflection-index-')),
        'index.db',
      )
      const index = MemoryIndex.open(dbPath)
      try {
        const provider = new FakeEmbeddingProvider()
        const embed: EmbedFn = async (texts: string[]) => {
          const { vectors } = await provider.embed('fake-model', texts)
          return vectors
        }
        await index.upsertDocument(
          summaryDoc,
          'summary',
          embed,
          'fake-model',
          '2026-01-01T00:00:00.000Z',
        )

        for (const term of ['empty', 'whitespace', 'absent']) {
          const hits = index.searchText(term, 10)
          expect(hits.length).toBeGreaterThan(0)
          const snippet = hits[0]?.snippet ?? ''
          expect(snippet).not.toContain('eventTime')
          expect(snippet).not.toContain('as stated on')
        }
      } finally {
        index.close()
      }
    })

    it('writes journaling.md when journalingUpdate is set, preserving the id on a second write', async () => {
      const first = {
        ...emptyReflectionOutput('First session about journaling.'),
        journalingUpdate: 'Gratitude, three times a week.',
      }
      await applyReflection(
        paths,
        first,
        sessionId,
        [],
        new Date('2026-08-16T21:00:00.000Z'),
        new Map(),
        noopMaterialize,
        'UTC',
      )
      const firstDoc = await readDocument(paths.files, paths.journaling)
      expect(firstDoc.body.trim()).toBe('Gratitude, three times a week.')

      const secondSessionId = newId('session')
      const secondSessionDir = join(paths.sessionsDir, `2026-08-17-${secondSessionId}`)
      await mkdir(secondSessionDir, { recursive: true })
      const second = {
        ...emptyReflectionOutput('Second session, switched methods.'),
        journalingUpdate: 'Switched to the examen.',
      }
      await applyReflection(
        paths,
        second,
        secondSessionId,
        [],
        new Date('2026-08-17T10:00:00.000Z'),
        new Map(),
        noopMaterialize,
        'UTC',
      )
      const secondDoc = await readDocument(paths.files, paths.journaling)
      expect(secondDoc.meta.id).toBe(firstDoc.meta.id)
      expect(secondDoc.body.trim()).toBe('Switched to the examen.')
    })

    it('leaves journaling.md untouched when journalingUpdate is null', async () => {
      const out = emptyReflectionOutput('An ordinary session, nothing about journaling.')
      await applyReflection(
        paths,
        out,
        sessionId,
        [],
        new Date(),
        new Map(),
        noopMaterialize,
        'UTC',
      )
      await expect(readDocument(paths.files, paths.journaling)).rejects.toThrow()
    })
  })

  describe('applyReflection: commitments', () => {
    const now = new Date('2026-08-13T10:00:00.000Z')

    it('captures a commitment from reflection alone and writes the gloss for a stated time it cannot resolve', async () => {
      const chat = new FakeChatProvider([
        {
          text: JSON.stringify({
            ...emptyReflectionOutput('They want to get back into swimming.'),
            commitments: [
              {
                label: 'Start swimming again',
                flavor: 'plan',
                statedTime: 'come summer',
                gloss:
                  'Said on 2026-08-13. Summer where they live, Bangalore, runs roughly February to May, so this points at early 2027 rather than the middle of the year.',
                bracketFrom: '2027-02-01',
                bracketTo: '2027-05-31',
                confidence: 'medium',
              },
            ],
          }),
          toolCalls: [],
        },
      ])
      const context: ReflectionContext = {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        profile: { id: 'doc_test', location: 'Bangalore' },
      }
      const swimTranscript: TranscriptLine[] = [
        {
          ts: '2026-08-13T09:00:00.000Z',
          utcOffsetMinutes: 330,
          role: 'user',
          content: 'come summer I want to start swimming again',
        },
      ]

      const raw = await reflectSession({ chat, model: 'test' }, swimTranscript, context)
      if ('degraded' in raw) throw new Error('expected a parsed reflection, not a degraded one')

      await applyReflection(paths, raw, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((node) => node.type === 'commitment')
      if (!commitmentNode?.commitment) throw new Error('expected a commitment node to be written')

      expect(commitmentNode.label).toBe('Start swimming again')
      expect(commitmentNode.commitment.flavor).toBe('plan')
      expect(commitmentNode.commitment.timing?.words).toBe('come summer')
      expect(commitmentNode.commitment.timing?.interpretation).toBeDefined()
      expect(commitmentNode.commitment.timing?.interpretation?.gloss.length).toBeGreaterThan(0)
      expect(commitmentNode.commitment.timing?.resolved).toBeUndefined()
    })

    it('reflection wins over the live path: a same-session, same-label commitment is revised, not duplicated', async () => {
      const live = await recordCommitment(
        paths,
        {
          label: 'See Nightfall with Arjun',
          flavor: 'plan',
          sessionId,
        },
        now,
      )

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('They confirmed the plan with Arjun.'),
        commitments: [
          {
            label: 'see nightfall with arjun',
            flavor: 'plan',
            statedTime: 'saturday',
          },
        ],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNodes = [...graph.nodes.values()].filter((node) => node.type === 'commitment')
      expect(commitmentNodes).toHaveLength(1)
      expect(commitmentNodes[0]?.id).toBe(live.id)
      expect(commitmentNodes[0]?.commitment?.timing?.words).toBe('saturday')
    })

    it('does not duplicate a same-labelled commitment from a different session', async () => {
      const otherSessionId = newId('session')
      await recordCommitment(
        paths,
        {
          label: 'See Nightfall with Arjun',
          flavor: 'plan',
          sessionId: otherSessionId,
        },
        now,
      )

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A different session, coincidentally the same plan.'),
        commitments: [{ label: 'See Nightfall with Arjun', flavor: 'plan' }],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNodes = [...graph.nodes.values()].filter((node) => node.type === 'commitment')
      expect(commitmentNodes).toHaveLength(2)
    })

    it('drops a commitmentRevisions entry that references an unknown id without aborting the rest of reflection', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session that misremembered an id.'),
        commitmentRevisions: [{ commitmentId: 'commitment_does_not_exist', label: 'Renamed' }],
      }

      const result = await applyReflection(
        paths,
        out,
        sessionId,
        [],
        now,
        new Map(),
        noopMaterialize,
        'UTC',
      )

      expect(result.summaryDoc.body).toBe('A session that misremembered an id.\n')
      const graph = await readGraph(paths)
      const commitmentNodes = [...graph.nodes.values()].filter((node) => node.type === 'commitment')
      expect(commitmentNodes).toHaveLength(0)
    })

    it('resolves a commitment stated time against when the session happened, not against reflection time', async () => {
      // The transcript's first line is 2026-08-10; reflection (`now`, set
      // above for this whole describe block) runs on 2026-08-13, as if
      // this session sat unreflected until runMaintenance swept it up
      // days later. "tomorrow" must resolve relative to the session's own
      // day, 2026-08-11, never relative to `now`.
      const transcriptPath = join(sessionDir, 'transcript.jsonl')
      const line: TranscriptLine = {
        ts: '2026-08-10T09:00:00.000Z',
        utcOffsetMinutes: 330,
        role: 'user',
        content: 'reminder to self',
      }
      await writeFile(transcriptPath, `${JSON.stringify(line)}\n`, 'utf8')

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session from a few days ago.'),
        commitments: [{ label: 'Call the dentist', flavor: 'errand', statedTime: 'tomorrow' }],
      }

      await applyReflection(
        paths,
        out,
        sessionId,
        [],
        now,
        new Map(),
        noopMaterialize,
        'Asia/Kolkata',
      )

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((node) => node.type === 'commitment')
      expect(commitmentNode?.commitment?.timing?.resolved?.from).toBe('2026-08-11')
    })

    it('resolves a commitment through commitmentResolutions, the reflection-side backstop for resolution (Important 3)', async () => {
      const live = await recordCommitment(
        paths,
        {
          label: 'File the tax paperwork',
          flavor: 'errand',
          sessionId,
        },
        now,
      )

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('They filed the paperwork today.'),
        commitmentResolutions: [{ commitmentId: live.id, outcome: 'done' }],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((node) => node.type === 'commitment')
      expect(commitmentNode?.commitment?.state).toBe('done')
    })

    it('drops a commitmentResolutions entry that references an unknown id without aborting the rest of reflection', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session that misremembered an id.'),
        commitmentResolutions: [{ commitmentId: 'commitment_does_not_exist', outcome: 'done' }],
      }

      const result = await applyReflection(
        paths,
        out,
        sessionId,
        [],
        now,
        new Map(),
        noopMaterialize,
        'UTC',
      )

      expect(result.summaryDoc.body).toBe('A session that misremembered an id.\n')
    })

    it('never fabricates a timing block from an empty-string statedTime (Important 4)', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        commitments: [{ label: 'Start swimming', flavor: 'plan', statedTime: '' }],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((node) => node.type === 'commitment')
      if (!commitmentNode?.commitment) throw new Error('expected a commitment node to be written')
      expect(commitmentNode.commitment.timing).toBeUndefined()
    })

    it('reads statedPrecision straight from the model instead of inferring it from the bracket shape (Important 5)', async () => {
      // Only bracketFrom is given (no bracketTo), which the old inference
      // would read as 'vague'. The model states 'period' directly and
      // that must win.
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        commitments: [
          {
            label: 'Start swimming',
            flavor: 'plan',
            statedTime: 'come summer',
            gloss: 'Points at next February.',
            bracketFrom: '2027-02-01',
            confidence: 'medium',
            statedPrecision: 'period',
          },
        ],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((node) => node.type === 'commitment')
      expect(commitmentNode?.commitment?.timing?.interpretation?.statedPrecision).toBe('period')
    })

    it('clears a stale timing on revision when clearTiming is set and no fresh statedTime replaces it (Important 6)', async () => {
      const live = await recordCommitment(
        paths,
        {
          label: 'See Nightfall with Arjun',
          flavor: 'plan',
          sessionId,
          timing: {
            words: 'friday',
            anchor: '2026-08-13T09:00:00.000Z',
            resolved: { from: '2026-08-14', to: '2026-08-14', statedPrecision: 'day' },
          },
        },
        now,
      )

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('They are no longer sure when.'),
        commitmentRevisions: [{ commitmentId: live.id, clearTiming: true }],
      }

      await applyReflection(paths, out, sessionId, [], now, new Map(), noopMaterialize, 'UTC')

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((node) => node.type === 'commitment')
      expect(commitmentNode?.commitment?.timing).toBeUndefined()
    })
  })

  describe('narrative continuity across sessions', () => {
    it('carries forward what a previous pass-two rewrite established, across two consecutive reflections', async () => {
      const now = new Date('2026-08-13T10:00:00.000Z')

      const firstOut: ReflectionOutput = {
        ...emptyReflectionOutput('First session: started marathon training.'),
        items: [{ text: 'Went for a 5k run', kind: 'event' }],
        attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
        arcUpdates: [{ arcId: 'arc_health', note: 'Started marathon training with a 5k run.' }],
      }
      const firstRewrittenBody = 'Training log:\n- Ran a 5k to start marathon training.\n'
      const firstChat = new FakeChatProvider([
        { text: JSON.stringify({ body: firstRewrittenBody }), toolCalls: [] },
      ])

      const graphStateBefore = await readGraph(paths)
      const firstNarratives = await resolveNarratives(
        paths,
        graphStateBefore,
        firstOut,
        firstChat,
        'fake-model',
      )
      expect(firstNarratives.get('arc_health')).toBe(firstRewrittenBody)

      await applyReflection(
        paths,
        firstOut,
        sessionId,
        [],
        now,
        firstNarratives,
        noopMaterialize,
        'UTC',
      )

      const afterFirst = await readDocument(paths.files, arcDocPath)
      expect(afterFirst.body).toBe(firstRewrittenBody)

      // Second session, same arc. Pass two must see the body the first pass
      // actually left on disk, not the original seed body from beforeEach.
      const secondSessionId = newId('session')
      const secondSessionDir = join(paths.sessionsDir, `2026-08-14-${secondSessionId}`)
      await mkdir(secondSessionDir, { recursive: true })

      const secondOut: ReflectionOutput = {
        ...emptyReflectionOutput('Second session: ran again, longer this time.'),
        items: [{ text: 'Went for a 10k run', kind: 'event' }],
        attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
        arcUpdates: [{ arcId: 'arc_health', note: 'Ran a 10k, building on the 5k.' }],
      }
      const secondRewrittenBody =
        'Training log:\n- Ran a 5k to start marathon training.\n- Ran a 10k, building on the 5k.\n'
      const secondChat = new FakeChatProvider([
        { text: JSON.stringify({ body: secondRewrittenBody }), toolCalls: [] },
      ])

      const graphStateSecond = await readGraph(paths)
      const secondNarratives = await resolveNarratives(
        paths,
        graphStateSecond,
        secondOut,
        secondChat,
        'fake-model',
      )

      const secondPrompt = secondChat.requests[0]?.messages[0]?.content ?? ''
      expect(secondPrompt).toContain('Ran a 5k to start marathon training')

      await applyReflection(
        paths,
        secondOut,
        secondSessionId,
        [],
        now,
        secondNarratives,
        noopMaterialize,
        'UTC',
      )

      const afterSecond = await readDocument(paths.files, arcDocPath)
      expect(afterSecond.body).toBe(secondRewrittenBody)
      expect(afterSecond.body).toContain('Ran a 5k to start marathon training')
      expect(afterSecond.body).toContain('Ran a 10k, building on the 5k')
    })

    it('a pass-two failure leaves the existing document byte for byte unchanged', async () => {
      const now = new Date('2026-08-13T10:00:00.000Z')

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session that tries and fails to update the arc.'),
        arcUpdates: [{ arcId: 'arc_health', note: 'Something happened.' }],
      }
      const chat = new FakeChatProvider([
        { text: 'not json', toolCalls: [] },
        { text: 'still not json', toolCalls: [] },
      ])

      const before = await readDocument(paths.files, arcDocPath)

      const graphState = await readGraph(paths)
      const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')
      expect(narratives.has('arc_health')).toBe(false)

      await applyReflection(paths, out, sessionId, [], now, narratives, noopMaterialize, 'UTC')

      const after = await readDocument(paths.files, arcDocPath)
      expect(after.body).toBe(before.body)
      expect(after.meta.updated).toBeUndefined()
    })

    it('completes reflection when readDocument throws for one arc mid pass two, a hand-deleted page while its graph node stays live, still rewriting the other arc and writing summary.md', async () => {
      const now = new Date('2026-08-13T10:00:00.000Z')

      const workDocPath = join(paths.arcsDir, 'work.md')
      await writeDocumentAtomic(paths.files, {
        path: workDocPath,
        meta: { id: newId('doc'), name: 'Work' },
        body: 'Original work narrative.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_work',
          type: 'arc',
          label: 'Work',
          doc: workDocPath,
        },
      ])

      // The user hand-deletes arcs/health.md; the graph node and its doc
      // pointer both stay exactly as they were.
      await rm(arcDocPath)

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session touching two arcs, one of them missing its page.'),
        arcUpdates: [
          { arcId: 'arc_health', note: 'Should be skipped, the page is gone.' },
          { arcId: 'arc_work', note: 'Should still be rewritten.' },
        ],
      }
      const chat = new FakeChatProvider([
        { text: JSON.stringify({ body: 'Rewritten work body.' }), toolCalls: [] },
      ])

      const graphState = await readGraph(paths)
      const failures: { id: string; label: string; reason: string }[] = []
      const narratives = await resolveNarratives(
        paths,
        graphState,
        out,
        chat,
        'fake-model',
        (id, label, reason) => {
          failures.push({ id, label, reason })
        },
      )

      expect(narratives.has('arc_health')).toBe(false)
      expect(narratives.get('arc_work')).toBe('Rewritten work body.')
      expect(failures).toHaveLength(1)
      expect(failures[0]?.id).toBe('arc_health')
      expect(failures[0]?.reason).toContain('ENOENT')

      await applyReflection(paths, out, sessionId, [], now, narratives, noopMaterialize, 'UTC')

      // Reflection completed: summary.md exists, which is the only thing
      // SessionStore reads as "this session is reflected".
      const summaryDoc = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      expect(summaryDoc.body).toBe(`${out.summary}\n`)

      const workDoc = await readDocument(paths.files, workDocPath)
      expect(workDoc.body).toBe('Rewritten work body.\n')

      // The failed document is untouched, not papered over: nothing here
      // recreated a fresh page at the path the person deleted.
      await expect(readDocument(paths.files, arcDocPath)).rejects.toThrow()
    })

    it('completes reflection when the chat provider throws mid pass two, still rewriting the other update and writing summary.md', async () => {
      const now = new Date('2026-08-13T10:00:00.000Z')

      const workDocPath = join(paths.arcsDir, 'work.md')
      await writeDocumentAtomic(paths.files, {
        path: workDocPath,
        meta: { id: newId('doc'), name: 'Work' },
        body: 'Original work narrative.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_work',
          type: 'arc',
          label: 'Work',
          doc: workDocPath,
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session touching two arcs, one hitting a provider error.'),
        // Work first, Health second: this is the exact shape of the
        // reported failure, a 429 on the second of several calls that
        // must not throw away a pass one that already succeeded and was
        // already paid for.
        arcUpdates: [
          { arcId: 'arc_work', note: 'Should still be rewritten.' },
          { arcId: 'arc_health', note: 'Should be skipped, the provider failed.' },
        ],
      }

      // A transient provider error (a 429 or 500) on the Health call, after
      // a Work pass that already succeeded: the throw must not discard the
      // pass that was already paid for.
      const flakyChat: ChatProvider = {
        name: 'flaky',
        async complete(req) {
          const prompt = req.messages[0]?.content ?? ''
          if (prompt.includes('"Health"')) {
            throw new Error('provider error: 429 Too Many Requests')
          }
          return { text: JSON.stringify({ body: 'Rewritten work body.' }), toolCalls: [] }
        },
        stream() {
          throw new Error('stream is not used in this test')
        },
      }

      const graphState = await readGraph(paths)
      const failures: { id: string; label: string; reason: string }[] = []
      const narratives = await resolveNarratives(
        paths,
        graphState,
        out,
        flakyChat,
        'fake-model',
        (id, label, reason) => {
          failures.push({ id, label, reason })
        },
      )

      expect(narratives.has('arc_health')).toBe(false)
      expect(narratives.get('arc_work')).toBe('Rewritten work body.')
      expect(failures).toHaveLength(1)
      expect(failures[0]?.id).toBe('arc_health')
      expect(failures[0]?.reason).toContain('429')

      await applyReflection(paths, out, sessionId, [], now, narratives, noopMaterialize, 'UTC')

      const summaryDoc = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      expect(summaryDoc.body).toBe(`${out.summary}\n`)

      const healthDoc = await readDocument(paths.files, arcDocPath)
      expect(healthDoc.body).toBe('Original arc narrative.\n')

      const workDoc = await readDocument(paths.files, workDocPath)
      expect(workDoc.body).toBe('Rewritten work body.\n')
    })
  })
})

// No parseReflection export exists; reflectionOutputSchema.safeParse is the
// same boundary the existing 'reflectionOutputSchema' describe block above
// already exercises, so these tests use it directly instead of inventing a
// new export.
describe('profileUpdates', () => {
  it('parses every allowlisted field out of a model response', () => {
    const parsed = reflectionOutputSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          summary: 'A short session.',
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
          profileUpdates: {
            preferredName: 'Vish',
            pronouns: 'they/them',
            location: 'Bengaluru',
            timezone: 'Asia/Kolkata',
            birthday: '04-02',
            occupation: 'nurse',
            birthdayGreetings: true,
          },
        }),
      ),
    )
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.profileUpdates?.occupation).toBe('nurse')
  })

  it('rejects a style key in profileUpdates', () => {
    const parsed = reflectionOutputSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          summary: 'A short session.',
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
          profileUpdates: { style: { tone: 'direct' } },
        }),
      ),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('reflection prompt', () => {
  function buildReflectionPromptForTest(profile: Record<string, unknown> = {}): string {
    return buildReflectionPrompt(
      {
        constitution: '',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        peopleTruncated: false,
        entitiesTruncated: false,
        profile: { id: 'doc_1', ...profile },
      },
      [],
    )
  }

  it('carries the shared prose voice rule, before the JSON response instruction', () => {
    const prompt = buildReflectionPromptForTest()
    expect(prompt).toContain(PROSE_VOICE_RULE)
    expect(prompt.indexOf(PROSE_VOICE_RULE)).toBeLessThan(
      prompt.indexOf('Respond with only JSON matching this shape'),
    )
  })

  it('scopes the voice rule to the prose fields, not the JSON shape itself', () => {
    const prompt = buildReflectionPromptForTest()
    expect(prompt).toContain('summary')
    const scopeSentence = prompt
      .split('\n\n')
      .find((paragraph) => paragraph.includes('every prose field you write'))
    expect(scopeSentence).toBeDefined()
    expect(scopeSentence).toContain('narrative')
    expect(scopeSentence).toContain('constitutionUpdate')
  })

  it('names the profile fields rather than routing them to the constitution', () => {
    const prompt = buildReflectionPromptForTest()
    expect(prompt).toContain('profileUpdates')
    expect(prompt).not.toContain('their timezone) always belong in the constitution')
    expect(prompt).toContain('Moved to Bangalore')
  })

  it('shows the current profile so the model can tell unset from already recorded', () => {
    const prompt = buildReflectionPromptForTest({ preferredName: 'Vish', occupation: 'nurse' })
    expect(prompt).toContain('Current profile:')
    expect(prompt).toContain('preferredName: Vish')
    expect(prompt).toContain('occupation: nurse')
  })

  it('carries the commitment instruction, and lists a known commitment by id and label but never its gloss or bracket', () => {
    const prompt = buildReflectionPrompt(
      {
        constitution: '',
        arcs: [],
        realms: [],
        people: [],
        entities: [],
        commitments: [
          {
            id: 'commitment_1',
            label: 'Start swimming again',
            flavor: 'plan',
            state: 'open',
            sessionId: 'session_earlier',
            timing: {
              words: 'come summer',
              anchor: '2026-08-13T09:00:00.000Z',
              interpretation: {
                statedPrecision: 'period',
                gloss: 'Points at next February, roughly, since summer in Bangalore runs Feb-May.',
                bracketFrom: '2027-02-01',
                bracketTo: '2027-05-31',
                interpretationConfidence: 'medium',
              },
            },
          },
        ],
        profile: { id: 'doc_1' },
      },
      [],
    )

    // The commitment instruction paragraphs themselves, by a phrase found
    // only in that prose, not in RESPONSE_SHAPE's JSON literal (which also
    // contains the bare word "gloss"): deleting the paragraphs must fail
    // this assertion, closing the hole where they could be removed with
    // the rest of the suite staying green.
    expect(prompt).toContain('Write a gloss only when')
    expect(prompt).toContain('Known commitments:')

    // Known commitments lists the commitment so the model can reference
    // its id in commitmentRevisions.
    expect(prompt).toContain('commitment_1')
    expect(prompt).toContain('Start swimming again')

    // The bracket selects, the gloss speaks (spec Section 7): neither is
    // ever shown or spoken to the person, and a prompt the model reads
    // and could echo into a reply or a summary is exactly a place that
    // rule has to hold. Falsify by making renderCommitmentListing
    // interpolate timing: this assertion should then fail.
    expect(prompt).not.toContain('2027-02-01')
    expect(prompt).not.toContain('2027-05-31')
    expect(prompt).not.toContain('Points at next February')
  })
})

describe('reflection fixtures, profile versus constitution', () => {
  const FIXTURE_CONTEXT = {
    constitution: 'Empty constitution.',
    arcs: [],
    realms: [],
    people: [],
    entities: [],
    profile: { id: 'doc_test' },
  }

  it('puts a stated name and city in profileUpdates', async () => {
    const chat = new FakeChatProvider([
      {
        text: JSON.stringify({
          ...emptyReflectionOutput('They introduced themselves.'),
          profileUpdates: { preferredName: 'Vish', location: 'Bengaluru' },
        }),
        toolCalls: [],
      },
    ])
    const output = await reflectSession({ chat, model: 'test' }, TRANSCRIPT, FIXTURE_CONTEXT)
    expect('degraded' in output).toBe(false)
    expect(!('degraded' in output) ? Object.keys(output.profileUpdates ?? {}).sort() : []).toEqual([
      'location',
      'preferredName',
    ])
  })

  it('never emits style, across the fixture set', async () => {
    const chat = new FakeChatProvider([
      {
        text: JSON.stringify({
          ...emptyReflectionOutput('A session.'),
          profileUpdates: { location: 'Bengaluru' },
        }),
        toolCalls: [],
      },
    ])
    const output = await reflectSession({ chat, model: 'test' }, TRANSCRIPT, FIXTURE_CONTEXT)
    expect(!('degraded' in output) && 'style' in (output.profileUpdates ?? {})).toBe(false)
  })

  it('keeps the meaning of a move in the constitution and the place in the profile', async () => {
    const chat = new FakeChatProvider([
      {
        text: JSON.stringify({
          ...emptyReflectionOutput('They talked about the move.'),
          constitutionUpdate: 'Moving unsettled them more than expected.',
          profileUpdates: { location: 'Bengaluru' },
        }),
        toolCalls: [],
      },
    ])
    const output = await reflectSession({ chat, model: 'test' }, TRANSCRIPT, FIXTURE_CONTEXT)
    expect(!('degraded' in output) && output.constitutionUpdate).not.toBeNull()
    const location = !('degraded' in output) ? output.profileUpdates?.location : undefined
    expect(location).toBe('Bengaluru')
    expect(location?.split(' ').length).toBeLessThan(4)
  })
})
