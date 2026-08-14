// The reflection pipeline: turns a session transcript into durable memory.
//
// reflectSession is the LLM call: transcript in, a validated ReflectionOutput
// out (or a degraded summary-only result if the model cannot produce valid
// JSON twice in a row). It never touches the filesystem.
//
// applyReflection is the deterministic half: it takes a ReflectionOutput and
// writes the session summary, mints item ids, and appends graph records.
// Every attribution becomes a part_of edge carrying the model's confidence,
// whatever it is; the caller (MemoryEngine) is responsible for materializing
// newArcs and newPersons directly, using the mintedItems this function
// returns. It never touches the network, and it never writes to
// proposals.jsonl.

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
import type { TranscriptLine } from './transcripts.js'

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
  newArcs: {
    name: string
    realm: string
    reason: string
    itemIndexes: number[]
    narrative: string
  }[]
  newPersons: { name: string; reason: string; itemIndexes: number[]; narrative: string }[]
  arcUpdates: { arcId: string; note: string }[]
  personUpdates: { personId: string; note: string }[]
  constitutionUpdate: string | null
}

export interface ReflectionContext {
  constitution: string
  arcs: GraphNode[]
  realms: GraphNode[]
  people: GraphNode[]
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
      narrative: z.string(),
    }),
  ),
  newPersons: z.array(
    z.object({
      name: z.string(),
      reason: z.string(),
      itemIndexes: z.array(z.number()),
      narrative: z.string(),
    }),
  ),
  arcUpdates: z.array(z.object({ arcId: z.string(), note: z.string() })),
  personUpdates: z.array(z.object({ personId: z.string(), note: z.string() })),
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
  "newArcs": [{"name": string, "realm": string, "reason": string, "itemIndexes": number[], "narrative": string}],
  "newPersons": [{"name": string, "reason": string, "itemIndexes": number[], "narrative": string}],
  "arcUpdates": [{"arcId": string, "note": string}],
  "personUpdates": [{"personId": string, "note": string}],
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
    'Known people:',
    renderListing(context.people),
    '',
    'Transcript:',
    renderTranscript(transcript),
    '',
    'When updating the constitution: basic identity facts about the user (their name, pronouns, where they live, their timezone, their occupation or work situation) always belong in the constitution when first learned or when they change. Do not wait for these facts to feel weighty; update the constitution to include them immediately.',
    '',
    "When deciding whether someone deserves a person page, in newPersons: a person page is for someone who recurs in this person's life and whom they actually talk about, not for every name that appears in a sentence. A partner, a close friend, a sibling, a therapist seen regularly: those recur. A coworker mentioned once in passing, a stranger from a single story, a public figure named in the news: those do not. When you are not sure someone recurs, do not add them yet.",
    '',
    'For each entry in newArcs and newPersons, narrative is the first paragraph of that document, written as if this session is the first time anything has been recorded about it.',
    '',
    'For each entry in arcUpdates and personUpdates, note is a short line describing what this session added or changed about an arc or person that already exists. Do not write full narrative prose in note; a separate pass uses it to rewrite the document.',
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

export function resolveItemIds(indexes: number[], mintedItems: ReflectionItem[]): string[] {
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

export const narrativeRewriteSchema: z.ZodType<{ body: string }> = z.object({ body: z.string() })

interface NarrativeParseSuccess {
  success: true
  data: { body: string }
}
interface NarrativeParseFailure {
  success: false
  error: string
}

function parseNarrativeRewrite(raw: string): NarrativeParseSuccess | NarrativeParseFailure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `response is not valid JSON: ${message}` }
  }
  const result = narrativeRewriteSchema.safeParse(json)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error.message }
}

function buildNarrativeRewritePrompt(input: {
  name: string
  currentBody: string
  summary: string
  itemTexts: string[]
  note: string
}): string {
  return [
    `You are rewriting the memory page for "${input.name}". This page already has a body; you are updating it, not starting over.`,
    '',
    'Current body:',
    input.currentBody,
    '',
    'Session summary:',
    input.summary,
    '',
    'Items from this session relevant to this page:',
    input.itemTexts.length > 0 ? input.itemTexts.map((t) => `- ${t}`).join('\n') : '(none)',
    '',
    'What this session added or changed:',
    input.note,
    '',
    'Rewrite the body so it carries forward everything in the current body that still matters, changing only what this session actually changed. The body you return replaces the file entirely, so do not drop anything that still matters just because this session did not mention it again.',
    '',
    'Respond with only JSON matching this shape, no other text:',
    '{"body": string}',
  ].join('\n')
}

export async function rewriteNarrative(
  chat: ChatProvider,
  model: string,
  input: { name: string; currentBody: string; summary: string; itemTexts: string[]; note: string },
): Promise<{ body: string } | null> {
  const prompt = buildNarrativeRewritePrompt(input)

  const first = await chat.complete({ model, messages: [{ role: 'user', content: prompt }] })
  const firstParse = parseNarrativeRewrite(first.text)
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

  const second = await chat.complete({ model, messages: [{ role: 'user', content: retryPrompt }] })
  const secondParse = parseNarrativeRewrite(second.text)
  if (secondParse.success) {
    return secondParse.data
  }
  return null
}

// Runs pass two once per arc or person update that still has something to
// rewrite: an id that no longer resolves to a node, a node with no doc, a
// node that is neither arc nor person, or an update for something also
// proposed as new this same session, are all dropped silently rather than
// treated as errors. A rewriteNarrative call that fails its one retry is
// dropped the same way, so the map simply lacks that key and the caller
// leaves the document on disk untouched.
//
// The first parameter is accepted for signature symmetry with the rest of
// this module's public functions and for a possible future disk-backed
// lookup; the current implementation resolves documents through
// graphState and readDocument alone.
export async function resolveNarratives(
  _paths: MemoryPaths,
  graphState: GraphState,
  out: ReflectionOutput,
  chat: ChatProvider,
  model: string,
): Promise<Map<string, string>> {
  const newArcNames = new Set(out.newArcs.map((a) => a.name.toLowerCase()))
  const newPersonNames = new Set(out.newPersons.map((p) => p.name.toLowerCase()))

  const narratives = new Map<string, string>()

  for (const update of out.arcUpdates) {
    const node = graphState.nodes.get(update.arcId)
    if (node?.type !== 'arc' || !node.doc) {
      continue
    }
    if (newArcNames.has(node.label.toLowerCase())) {
      continue
    }
    const itemTexts = out.attributions
      .filter((a) => a.arcId === update.arcId)
      .map((a) => out.items[a.itemIndex]?.text)
      .filter((text): text is string => typeof text === 'string')
    const currentDoc = await readDocument(node.doc)
    const result = await rewriteNarrative(chat, model, {
      name: node.label,
      currentBody: currentDoc.body,
      summary: out.summary,
      itemTexts,
      note: update.note,
    })
    if (result) {
      narratives.set(update.arcId, result.body)
    }
  }

  for (const update of out.personUpdates) {
    const node = graphState.nodes.get(update.personId)
    if (node?.type !== 'person' || !node.doc) {
      continue
    }
    if (newPersonNames.has(node.label.toLowerCase())) {
      continue
    }
    // ReflectionOutput carries per-item attribution only for arcs
    // (out.attributions). There is no equivalent for people, so a person's
    // pass two call gets no item texts; its note still says what changed.
    const currentDoc = await readDocument(node.doc)
    const result = await rewriteNarrative(chat, model, {
      name: node.label,
      currentBody: currentDoc.body,
      summary: out.summary,
      itemTexts: [],
      note: update.note,
    })
    if (result) {
      narratives.set(update.personId, result.body)
    }
  }

  return narratives
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
  narratives: Map<string, string>,
): Promise<{
  summaryDoc: Document
  autoAsserted: number
  mintedItems: ReflectionItem[]
}> {
  const nowIso = now.toISOString()

  // Phase 1: validation and minting only, no filesystem writes. Every id is
  // minted and every graph record is fully decided in memory before
  // anything touches disk, so a bad input never leaves partial state behind.
  const mintedItems = mintItems(out.items, now)
  const mergedItems = mergeLiveItems(mintedItems, liveItems)

  const { dir, date } = await findSessionDir(paths, sessionId)
  const summaryPath = join(dir, 'summary.md')

  const graphState = await readGraph(paths)
  const graphRecords: GraphRecord[] = []
  let autoAsserted = 0

  // Assert the session node itself before any item's `from` edge points at
  // it: MemoryIndex.replaceGraph skips edges whose endpoints are not both
  // present in the node table, so without this node every item -> session
  // edge below would be logged and then silently dropped from the index.
  graphRecords.push({
    ts: nowIso,
    op: 'assert',
    node: sessionId,
    type: 'session',
    label: date,
    doc: summaryPath,
  })

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
  }

  // newArcs and newPersons are materialized directly by the caller (see
  // MemoryEngine.createArc / createPersonPage), using mintedItems returned
  // below. applyReflection itself never creates a proposal for them, and it
  // never writes to proposals.jsonl at all.

  let constitutionWrite: PendingWrite | null = null
  if (out.constitutionUpdate !== null) {
    const constitutionDoc = await readDocument(paths.constitution)
    constitutionWrite = {
      path: constitutionDoc.path,
      meta: { ...constitutionDoc.meta, updated: nowIso },
      body: out.constitutionUpdate,
    }
  }

  // Pass two already decided which ids get a rewritten body (resolveNarratives,
  // called by the engine between reflectSession and applyReflection); this
  // function only ever reads that decision, never calls a model. An id absent
  // from the map (dropped for any reason on the way in) leaves its document
  // on disk untouched.
  const narrativeWrites: PendingWrite[] = []
  for (const [id, body] of narratives) {
    const node = graphState.nodes.get(id)
    if (!node?.doc) {
      continue
    }
    const doc = await readDocument(node.doc)
    narrativeWrites.push({ path: doc.path, meta: { ...doc.meta, updated: nowIso }, body })
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
  // edges and document rewrites, with nothing left to notice the loss or
  // retry it.
  await appendGraph(paths, graphRecords)

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

  return { summaryDoc, autoAsserted, mintedItems }
}
