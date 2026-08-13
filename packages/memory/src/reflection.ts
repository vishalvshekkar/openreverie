// The reflection pipeline: turns a session transcript into durable memory.
//
// reflectSession is the LLM call: transcript in, a validated ReflectionOutput
// out (or a degraded summary-only result if the model cannot produce valid
// JSON twice in a row). It never touches the filesystem.
//
// applyReflection is the deterministic half: it takes a ReflectionOutput and
// writes the session summary, mints item ids, appends graph records, and
// queues proposals for anything that is not a high-confidence link to an
// arc that already exists. It never touches the network.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatProvider } from '@openreverie/providers'
import { z } from 'zod'
import {
  type Document,
  type DocumentMeta,
  newId,
  readDocument,
  writeDocumentAtomic,
} from './documents.js'
import {
  appendGraph,
  type GraphNode,
  type GraphRecord,
  type GraphState,
  readGraph,
} from './graph.js'
import type { MemoryPaths } from './paths.js'
import { appendProposals, type Proposal } from './proposals.js'
import type { TranscriptLine } from './transcripts.js'

export const CONFIDENCE_THRESHOLD = 0.8

export type ReflectionItemKind = 'observation' | 'feeling' | 'event' | 'intention'

export interface ReflectionItem {
  id: string
  text: string
  kind: ReflectionItemKind
  ts: string
}

export interface ReflectionOutput {
  summary: string
  items: { text: string; kind: ReflectionItemKind }[]
  attributions: { itemIndex: number; arcId: string; confidence: number }[]
  newArcs: { name: string; realm: string; reason: string; itemIndexes: number[] }[]
  newPersons: { name: string; reason: string; itemIndexes: number[] }[]
  arcNarratives: { arcId: string; narrative: string }[]
  constitutionUpdate: string | null
}

export interface ReflectionContext {
  constitution: string
  arcs: GraphNode[]
  realms: GraphNode[]
}

const reflectionItemKindSchema = z.enum(['observation', 'feeling', 'event', 'intention'])

export const reflectionOutputSchema: z.ZodType<ReflectionOutput> = z.object({
  summary: z.string(),
  items: z.array(z.object({ text: z.string(), kind: reflectionItemKindSchema })),
  attributions: z.array(
    z.object({ itemIndex: z.number(), arcId: z.string(), confidence: z.number().min(0).max(1) }),
  ),
  newArcs: z.array(
    z.object({
      name: z.string(),
      realm: z.string(),
      reason: z.string(),
      itemIndexes: z.array(z.number()),
    }),
  ),
  newPersons: z.array(
    z.object({ name: z.string(), reason: z.string(), itemIndexes: z.array(z.number()) }),
  ),
  arcNarratives: z.array(z.object({ arcId: z.string(), narrative: z.string() })),
  constitutionUpdate: z.string().nullable(),
})

function renderListing(nodes: GraphNode[]): string {
  if (nodes.length === 0) {
    return '(none yet)'
  }
  return nodes.map((node) => `- ${node.id}: ${node.label}`).join('\n')
}

function renderTranscript(transcript: TranscriptLine[]): string {
  return transcript.map((line) => `${line.role}: ${line.content}`).join('\n')
}

const RESPONSE_SHAPE = `{
  "summary": string,
  "items": [{"text": string, "kind": "observation" | "feeling" | "event" | "intention"}],
  "attributions": [{"itemIndex": number, "arcId": string, "confidence": number}],
  "newArcs": [{"name": string, "realm": string, "reason": string, "itemIndexes": number[]}],
  "newPersons": [{"name": string, "reason": string, "itemIndexes": number[]}],
  "arcNarratives": [{"arcId": string, "narrative": string}],
  "constitutionUpdate": string | null
}`

function buildReflectionPrompt(context: ReflectionContext, transcript: TranscriptLine[]): string {
  return [
    'You are the memory reflection pipeline for a personal companion agent. You are not the companion and you do not talk to the user. Read the session transcript below and produce structured JSON describing what happened, so it can be filed into durable memory.',
    '',
    'Constitution:',
    context.constitution,
    '',
    'Known arcs:',
    renderListing(context.arcs),
    '',
    'Known realms:',
    renderListing(context.realms),
    '',
    'Transcript:',
    renderTranscript(transcript),
    '',
    'Respond with only JSON matching this shape, no other text:',
    RESPONSE_SHAPE,
  ].join('\n')
}

interface ParseSuccess {
  success: true
  data: ReflectionOutput
}

interface ParseFailure {
  success: false
  error: string
}

function parseReflectionOutput(raw: string): ParseSuccess | ParseFailure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `response is not valid JSON: ${message}` }
  }
  const result = reflectionOutputSchema.safeParse(json)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error.message }
}

const DEGRADED_FALLBACK_SUMMARY = 'Reflection could not be parsed for this session.'

export async function reflectSession(
  deps: { chat: ChatProvider; model: string },
  transcript: TranscriptLine[],
  context: ReflectionContext,
): Promise<ReflectionOutput | { summary: string; degraded: true }> {
  const prompt = buildReflectionPrompt(context, transcript)

  const first = await deps.chat.complete({
    model: deps.model,
    messages: [{ role: 'user', content: prompt }],
  })
  const firstParse = parseReflectionOutput(first.text)
  if (firstParse.success) {
    return firstParse.data
  }

  const retryPrompt = [
    prompt,
    '',
    `Your previous response failed validation: ${firstParse.error}`,
    '',
    'Previous response:',
    first.text,
    '',
    'Respond again with only corrected JSON matching the shape above.',
  ].join('\n')

  const second = await deps.chat.complete({
    model: deps.model,
    messages: [{ role: 'user', content: retryPrompt }],
  })
  const secondParse = parseReflectionOutput(second.text)
  if (secondParse.success) {
    return secondParse.data
  }

  const raw = second.text.trim()
  return { summary: raw.length > 0 ? second.text : DEGRADED_FALLBACK_SUMMARY, degraded: true }
}

function mintItems(items: ReflectionOutput['items'], now: Date): ReflectionItem[] {
  const ts = now.toISOString()
  return items.map((item) => ({ id: newId('item'), text: item.text, kind: item.kind, ts }))
}

function mergeLiveItems(minted: ReflectionItem[], liveItems: ReflectionItem[]): ReflectionItem[] {
  const seen = new Set(minted.map((item) => item.text.toLowerCase()))
  const merged = [...minted]
  for (const item of liveItems) {
    const key = item.text.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(item)
  }
  return merged
}

async function findSessionDir(
  paths: MemoryPaths,
  sessionId: string,
): Promise<{ dir: string; date: string }> {
  const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(`-${sessionId}`))
  if (!match) {
    throw new Error(`No session directory found for ${sessionId} in ${paths.sessionsDir}.`)
  }
  const dateMatch = match.name.match(/^(\d{4}-\d{2}-\d{2})-/)
  const date = dateMatch?.[1] ?? match.name
  return { dir: join(paths.sessionsDir, match.name), date }
}

function linkProposalSummary(item: ReflectionItem, arcId: string, graph: GraphState): string {
  const arc = graph.nodes.get(arcId)
  const arcName = arc ? arc.label : 'that arc'
  return `You mentioned "${item.text}"; want me to link it to ${arcName}?`
}

function newArcProposalSummary(name: string, realm: string): string {
  return `You mentioned ${name} a few times; want me to track it as an arc in ${realm}?`
}

function newPersonProposalSummary(name: string): string {
  return `You mentioned ${name}; want me to add them as someone in your life?`
}

function resolveItemIds(indexes: number[], mintedItems: ReflectionItem[]): string[] {
  const ids: string[] = []
  const seen = new Set<number>()
  for (const index of indexes) {
    if (seen.has(index)) {
      continue
    }
    seen.add(index)
    if (index < 0 || index >= mintedItems.length) {
      continue
    }
    const item = mintedItems[index]
    if (item) {
      ids.push(item.id)
    }
  }
  return ids
}

interface PendingWrite {
  path: string
  meta: DocumentMeta
  body: string
}

export async function applyReflection(
  paths: MemoryPaths,
  out: ReflectionOutput,
  sessionId: string,
  liveItems: ReflectionItem[],
  now: Date,
): Promise<{
  summaryDoc: Document
  autoAsserted: number
  proposals: Proposal[]
  droppedProposals: number
  skippedNarratives: number
}> {
  const nowIso = now.toISOString()

  // Phase 1: validation and minting only, no filesystem writes. Every id is
  // minted and every proposal/graph record is fully decided in memory before
  // anything touches disk, so a bad input never leaves partial state behind.
  const mintedItems = mintItems(out.items, now)
  const mergedItems = mergeLiveItems(mintedItems, liveItems)

  const { dir, date } = await findSessionDir(paths, sessionId)
  const summaryPath = join(dir, 'summary.md')

  const graphState = await readGraph(paths)
  const graphRecords: GraphRecord[] = []
  const proposals: Proposal[] = []
  let autoAsserted = 0
  let droppedProposals = 0
  let skippedNarratives = 0

  for (const item of mergedItems) {
    graphRecords.push({
      ts: nowIso,
      op: 'assert',
      node: item.id,
      type: 'item',
      label: item.text,
      doc: summaryPath,
    })
    graphRecords.push({
      ts: nowIso,
      op: 'assert',
      edge: 'from',
      from: item.id,
      to: sessionId,
      confidence: 1,
      confirmed: true,
    })
  }

  for (const attribution of out.attributions) {
    const item = mintedItems[attribution.itemIndex]
    if (!item) {
      continue
    }
    const arcNode = graphState.nodes.get(attribution.arcId)
    const arcExists = arcNode?.type === 'arc'
    if (attribution.confidence >= CONFIDENCE_THRESHOLD && arcExists) {
      graphRecords.push({
        ts: nowIso,
        op: 'assert',
        edge: 'part_of',
        from: item.id,
        to: attribution.arcId,
        confidence: attribution.confidence,
        confirmed: false,
      })
      autoAsserted += 1
    } else {
      // Unknown id or an id that resolves to a non-arc node (e.g. a realm)
      // both fall through here: neither is a valid part_of target, so both
      // become a link proposal for a human to confirm instead of a
      // structurally invalid edge in the permanent graph log.
      proposals.push({
        id: newId('prop'),
        ts: nowIso,
        kind: 'link',
        summary: linkProposalSummary(item, attribution.arcId, graphState),
        payload: {
          edge: 'part_of',
          from: item.id,
          to: attribution.arcId,
          confidence: attribution.confidence,
        },
        source: sessionId,
      })
    }
  }

  for (const arc of out.newArcs) {
    const itemIds = resolveItemIds(arc.itemIndexes, mintedItems)
    if (itemIds.length === 0) {
      droppedProposals += 1
      continue
    }
    proposals.push({
      id: newId('prop'),
      ts: nowIso,
      kind: 'new_arc',
      summary: newArcProposalSummary(arc.name, arc.realm),
      payload: { name: arc.name, realm: arc.realm, itemIds },
      source: sessionId,
    })
  }

  for (const person of out.newPersons) {
    const itemIds = resolveItemIds(person.itemIndexes, mintedItems)
    if (itemIds.length === 0) {
      droppedProposals += 1
      continue
    }
    proposals.push({
      id: newId('prop'),
      ts: nowIso,
      kind: 'new_person',
      summary: newPersonProposalSummary(person.name),
      payload: { name: person.name, itemIds },
      source: sessionId,
    })
  }

  const narrativeWrites: PendingWrite[] = []
  for (const narrative of out.arcNarratives) {
    const arcNode = graphState.nodes.get(narrative.arcId)
    if (arcNode?.type !== 'arc' || !arcNode.doc) {
      skippedNarratives += 1
      continue
    }
    const arcDoc = await readDocument(arcNode.doc)
    narrativeWrites.push({
      path: arcDoc.path,
      meta: { ...arcDoc.meta, updated: nowIso },
      body: narrative.narrative,
    })
  }

  let constitutionWrite: PendingWrite | null = null
  if (out.constitutionUpdate !== null) {
    const constitutionDoc = await readDocument(paths.constitution)
    constitutionWrite = {
      path: constitutionDoc.path,
      meta: { ...constitutionDoc.meta, updated: nowIso },
      body: out.constitutionUpdate,
    }
  }

  // Phase 2: side effects, ordered so summary.md is written last. Its
  // presence is what flips a session from unreflected to reflected
  // (SessionStore reads it that way), so it doubles as the commit marker
  // for this whole function. If anything below throws before that final
  // write, the session still has no summary.md and is retried in full on
  // the next pass. A retry after a partial graph append can mint a few
  // duplicate item nodes; that is visible in the graph and harmless.
  // Writing summary.md first would be worse: a crash after it would
  // permanently mark the session reflected while silently dropping graph
  // edges, proposals, and document rewrites, with nothing left to notice
  // the loss or retry it.
  await appendGraph(paths, graphRecords)
  await appendProposals(paths, proposals)

  for (const write of narrativeWrites) {
    await writeDocumentAtomic(write)
  }

  if (constitutionWrite) {
    await writeDocumentAtomic(constitutionWrite)
  }

  await writeDocumentAtomic({
    path: summaryPath,
    meta: {
      id: newId('doc'),
      kind: 'summary',
      session: sessionId,
      date,
      items: mergedItems,
    },
    body: out.summary,
  })
  const summaryDoc = await readDocument(summaryPath)

  return { summaryDoc, autoAsserted, proposals, droppedProposals, skippedNarratives }
}
