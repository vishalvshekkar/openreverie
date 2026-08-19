// The reflection pipeline: turns a session transcript into durable memory.
//
// reflectSession is the LLM call: transcript in, a validated ReflectionOutput
// out (or a degraded summary-only result if the model cannot produce valid
// JSON twice in a row). It never touches the filesystem.
//
// applyReflection is the deterministic half: it takes a ReflectionOutput and
// writes the session summary, mints item ids, and appends graph records.
// Every attribution becomes a part_of edge carrying the model's confidence,
// whatever it is. newArcs, newPersons, newEntities and pagePromotions are
// materialized by the materializeNew callback the caller (MemoryEngine)
// injects, invoked here before the summary write so a failure inside it
// leaves the session unreflected and retryable rather than silently losing
// the new arc, person, entity, or promoted page. applyReflection itself
// never touches the network (the callback is a plain function, not a
// ChatProvider) and never writes to proposals.jsonl.
//
// A node and a page are two different decisions. newPersons and newEntities
// create a node, generously, on first mention. A page is a maintained
// document a model call rewrites every session that touches it, and it is
// only granted when earned: newPersons carries a deservesPage flag for a
// person who recurs or clearly mattered already; newEntities never does,
// entities get no page in this release. pagePromotions grants a page to a
// person already captured as a node-only in a past session, once they
// recur.

import { basename, join } from 'node:path'
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
import { writeJournalingProtocol } from './journal.js'
import type { MemoryPaths } from './paths.js'
import { type ProfileMeta, type ProfileUpdates, profileUpdatesSchema } from './profile.js'
import { localDateFromStored, renderStoredStamp } from './time.js'
import { SessionStore, type TranscriptLine } from './transcripts.js'

export type ReflectionItemKind = 'observation' | 'feeling' | 'event' | 'intention'

export interface ReflectionItem {
  id: string
  text: string
  kind: ReflectionItemKind
  // Record time: when this entered memory. Always a UTC instant.
  ts: string
  // Event time: when the thing happened or will happen, as the person
  // stated it. Free text, not a parsed instant, because "tonight", "next
  // week", and "sometime in the fall" cannot honestly be reduced to one.
  // Absent when the person attached no particular moment to it.
  eventTime?: string
}

export interface ReflectionOutput {
  summary: string
  items: { text: string; kind: ReflectionItemKind; eventTime?: string }[]
  attributions: { itemIndex: number; arcId: string; confidence: number }[]
  newArcs: {
    name: string
    realm: string
    reason: string
    itemIndexes: number[]
    narrative: string
  }[]
  // A person node, generously created on first mention. deservesPage is the
  // separate, earned decision: true only when this person recurs across
  // sessions or clearly mattered enough within this one. narrative is only
  // read when deservesPage is true; leave it an empty string otherwise.
  newPersons: {
    name: string
    reason: string
    itemIndexes: number[]
    deservesPage: boolean
    narrative: string
  }[]
  // A non-person node: a film, book, company, place, band, or work of
  // fiction with a real part in this person's life. Entities never carry a
  // page-worthiness decision; they get no page in this release.
  newEntities: { name: string; reason: string; itemIndexes: number[] }[]
  // Grants a page to a person already known as a node with no page, once
  // they recur. nodeId must be one of the ids listed under Known people
  // with no page yet; narrative is the first paragraph of their new page.
  pagePromotions: { nodeId: string; reason: string; itemIndexes: number[]; narrative: string }[]
  arcUpdates: { arcId: string; note: string }[]
  personUpdates: { personId: string; note: string }[]
  constitutionUpdate: string | null
  // The backstop half of the journaling.md rewrite mechanism (spec
  // section 4.5): null when nothing about the person's journaling setup
  // changed this session, otherwise the full new document body. The live
  // update_journaling_protocol tool is the primary path; this exists for
  // a session where the person clearly renegotiated their setup but the
  // model never called that tool for it.
  journalingUpdate: string | null
  // Structured personal facts worth writing into profile.md rather than
  // into constitution prose: the current value of a name, pronouns,
  // location, timezone, birthday, occupation, or birthday-greeting answer.
  // Absent or an empty object means nothing to update. This is a backstop:
  // a model that used the live update_profile tool during the conversation
  // has already written the fact, and writing the same confirmed value
  // twice is a no-op in effect.
  profileUpdates?: ProfileUpdates
}

export interface ReflectionContext {
  constitution: string
  arcs: GraphNode[]
  realms: GraphNode[]
  // Already capped and recency-ordered by the caller (MemoryEngine); see
  // capPeople/capEntities in engine.ts. peopleTruncated/entitiesTruncated
  // say whether the cap actually cut anything, so the rendered listing can
  // say so. Optional so existing test fixtures that build a
  // ReflectionContext literal without these fields (an untruncated,
  // uncapped list) keep compiling; a missing flag renders as not truncated.
  people: GraphNode[]
  peopleTruncated?: boolean
  entities: GraphNode[]
  entitiesTruncated?: boolean
  // The current profile.md fields, so reflection can tell a fact not yet
  // known from one already recorded and stop proposing writes that would
  // change nothing.
  profile: ProfileMeta
  // undefined when journaling.md does not exist, so the prompt can tell
  // "not yet set up" apart from "already correct"; never the
  // JOURNALING_PROTOCOL_ABSENT sentinel here, since that sentinel is
  // written for the chat model's own journal-mode session, not for
  // reflection's very different prompt.
  journalingProtocol?: string
}

const reflectionItemKindSchema = z.enum(['observation', 'feeling', 'event', 'intention'])

export const reflectionOutputSchema: z.ZodType<ReflectionOutput> = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      text: z.string(),
      kind: reflectionItemKindSchema,
      eventTime: z.string().exactOptional(),
    }),
  ),
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
      deservesPage: z.boolean(),
      narrative: z.string(),
    }),
  ),
  newEntities: z.array(
    z.object({
      name: z.string(),
      reason: z.string(),
      itemIndexes: z.array(z.number()),
    }),
  ),
  pagePromotions: z.array(
    z.object({
      nodeId: z.string(),
      reason: z.string(),
      itemIndexes: z.array(z.number()),
      narrative: z.string(),
    }),
  ),
  arcUpdates: z.array(z.object({ arcId: z.string(), note: z.string() })),
  personUpdates: z.array(z.object({ personId: z.string(), note: z.string() })),
  constitutionUpdate: z.string().nullable(),
  journalingUpdate: z.string().nullable(),
  profileUpdates: profileUpdatesSchema.exactOptional(),
})

// Reflection sees what is already recorded so it can tell "not yet known"
// from "already correct" and stop proposing a field that needs no change.
function renderProfile(profile: ProfileMeta): string {
  const fields = [
    'preferredName',
    'pronouns',
    'location',
    'timezone',
    'birthday',
    'occupation',
    'birthdayGreetings',
  ] as const
  const lines: string[] = []
  for (const field of fields) {
    const value = profile[field]
    if (value === undefined) continue
    lines.push(`- ${field}: ${String(value)}`)
  }
  return lines.length === 0 ? '(nothing recorded yet)' : lines.join('\n')
}

// truncated is only ever true for entities (arcs and realms are never
// capped): when the caller already cut the list down to ENTITIES_CAP, say
// so, so the model knows this is a partial list of what is known rather
// than the complete one.
function renderListing(nodes: GraphNode[], truncated = false): string {
  if (nodes.length === 0) {
    return '(none yet)'
  }
  const lines = nodes.map((node) => `- ${node.id}: ${node.label}`)
  if (truncated) {
    lines.push(
      '(list truncated to the most recently created entries; older ones exist but are not shown here)',
    )
  }
  return lines.join('\n')
}

// Used for people: each line also says whether the node already has a
// page, which is what makes promotion possible. A model deciding whether
// to fill pagePromotions or newPersons needs to see this directly; it
// cannot infer page status from the id or label alone. truncated is true
// when the caller already cut the list down to PEOPLE_CAP.
function renderListingWithPageStatus(nodes: GraphNode[], truncated = false): string {
  if (nodes.length === 0) {
    return '(none yet)'
  }
  const lines = nodes.map(
    (node) => `- ${node.id}: ${node.label} (${node.doc ? 'has a page' : 'no page yet'})`,
  )
  if (truncated) {
    lines.push(
      '(list truncated: paged people are kept first, then the most recently created; older, unpaged people exist but are not shown here)',
    )
  }
  return lines.join('\n')
}

// Each line is prefixed with the wall-clock time it was written at, built
// from that line's own ts and its own recorded offset. A line written
// before offsets existed renders as a labeled UTC instant instead, and
// never as a local time guessed from a timezone the line does not carry.
// This is what lets reflection distinguish record time (when the person
// said it) from event time (when the thing they described happens).
function renderTranscript(transcript: TranscriptLine[]): string {
  return transcript
    .map(
      (line) =>
        `${renderStoredStamp(line.ts, line.utcOffsetMinutes)} ${line.role}: ${line.content}`,
    )
    .join('\n')
}

const RESPONSE_SHAPE = `{
  "summary": string,
  "items": [{"text": string, "kind": "observation" | "feeling" | "event" | "intention", "eventTime": string | undefined}],
  "attributions": [{"itemIndex": number, "arcId": string, "confidence": number}],
  "newArcs": [{"name": string, "realm": string, "reason": string, "itemIndexes": number[], "narrative": string}],
  "newPersons": [{"name": string, "reason": string, "itemIndexes": number[], "deservesPage": boolean, "narrative": string}],
  "newEntities": [{"name": string, "reason": string, "itemIndexes": number[]}],
  "pagePromotions": [{"nodeId": string, "reason": string, "itemIndexes": number[], "narrative": string}],
  "arcUpdates": [{"arcId": string, "note": string}],
  "personUpdates": [{"personId": string, "note": string}],
  "constitutionUpdate": string | null,
  "journalingUpdate": string | null,
  "profileUpdates": {"preferredName": string, "pronouns": string, "location": string, "timezone": string, "birthday": string, "occupation": string, "birthdayGreetings": boolean}
}`

export function buildReflectionPrompt(
  context: ReflectionContext,
  transcript: TranscriptLine[],
): string {
  return [
    'You are the memory reflection pipeline for a personal companion agent. You are not the companion and you do not talk to the user. Read the session transcript below and produce structured JSON describing what happened, so it can be filed into durable memory.',
    '',
    'Constitution:',
    context.constitution,
    '',
    'Current profile:',
    renderProfile(context.profile),
    '',
    'Known arcs:',
    renderListing(context.arcs),
    '',
    'Known realms:',
    renderListing(context.realms),
    '',
    'Known people:',
    renderListingWithPageStatus(context.people, context.peopleTruncated),
    '',
    'Known entities:',
    renderListing(context.entities, context.entitiesTruncated),
    '',
    'Current journaling setup:',
    context.journalingProtocol ?? '(not set up yet: this person has never journaled before)',
    '',
    'Transcript:',
    renderTranscript(transcript),
    '',
    "Facts and meaning go to two different places. The current value of a plain fact about the user goes in profileUpdates: what they want to be called, their pronouns, where they live, their timezone, their birthday, and what they do. Write only what they actually said; never infer a fact from another one. What a fact means to them, and how it changed, goes in constitutionUpdate. 'location: Bangalore' is a profile field. 'Moved to Bangalore and the move landed harder than expected' is the constitution. A job change is the same shape: the new title is a profileUpdates.occupation write, what the change meant is a constitution write, and a later profile write must never erase the narrative about the old job.",
    '',
    "A node and a page are two different decisions. A node is a permanent, queryable line in the graph; it is nearly free, so create one generously, on first mention, for anyone or anything with a real part in this person's life. A page is a maintained document a separate model call rewrites every session that touches it; it is expensive, so it is only granted when earned. Each name under Known people above is marked with whether it already has a page. Entities never get a page in this release, so no name under Known entities carries that mark.",
    '',
    "People go in newPersons, using the existing person node type: real people in this person's life, and also public figures and fictional characters when they have a part in how this person thinks or talks. A partner, a manager, a therapist, but also a novelist they keep returning to or a character they identify with, all belong here. Set deservesPage to true only when this person recurs in this person's life across sessions, or clearly mattered enough within this single session already; otherwise set it to false and leave narrative empty. When you are not sure someone recurs or mattered enough, set deservesPage to false; a node with no page can still gain one later.",
    '',
    "Non-people things go in newEntities, using the existing entity node type: films, books, companies, places, bands, and works of fiction that have a real part in this person's life. Entities never get a page in this release, so there is no page decision to make for them.",
    '',
    'Do not add an entry to newPersons or newEntities for a name or thing already listed above under Known people or Known entities, whether or not it has a page yet; listing it again would create a duplicate. If a known person with no page yet now recurs or clearly matters, use pagePromotions instead, with their existing id from the Known people list. If a known person or entity is simply mentioned again, no new entry is needed at all.',
    '',
    'This rule is about the same person coming up again, not about a shared name. If someone who comes up shares a name with a person already listed under Known people but is clearly a different human, they are not a duplicate: give them a distinguishing name in newPersons (for example "Sarah from work" rather than "Sarah") so they file under their own node instead of merging into the existing one. There is no way to undo a merge later, so when in doubt, treat two people who share a name as two different people. Merging two different people into one record is worse than having two records.',
    '',
    "Do not add a node, in newPersons, newEntities, or pagePromotions, for a general fact about the world, or for a public person or incident mentioned only as an analogy or an example. The test is whether the thing has a real part in this person's life, not whether it was mentioned. Something invoked only to illustrate a point is not a node.",
    '',
    'For each entry in newArcs, newPersons with deservesPage true, and pagePromotions, narrative is the first paragraph of that document, written as if this session is the first time anything has been recorded about it.',
    '',
    'For each entry in arcUpdates and personUpdates, note is a short line describing what this session added or changed about an arc or person that already exists. Do not write full narrative prose in note; a separate pass uses it to rewrite the document.',
    '',
    'Each transcript line above is prefixed with the time it was written. When an item describes something happening at a time the person actually stated ("tonight at 7.25", "last Tuesday", "next month"), put that stated time in eventTime, in the person\'s own words, and leave eventTime out entirely otherwise. eventTime is when the thing happens; it is separate from when the person told you about it, and the two are allowed to differ. Do not invent or resolve a time the person did not state.',
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
  return items.map((item) => ({
    id: newId('item'),
    text: item.text,
    kind: item.kind,
    ts,
    ...(item.eventTime !== undefined ? { eventTime: item.eventTime } : {}),
  }))
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

// The directory is resolved by id suffix, never by date. The date is
// derived from the transcript's own first line, because summary.md's date
// frontmatter is the one place a session's logical local day is durably
// recorded, and SessionStore.listSessions reads it straight back out. With
// no recorded offset there is no honest local date to compute, so the
// directory's own prefix stands rather than a guess built from whatever
// timezone the profile happens to hold today.
async function resolveSession(
  paths: MemoryPaths,
  sessionId: string,
): Promise<{ dir: string; date: string }> {
  const dir = await SessionStore.sessionDir(paths, sessionId)
  const prefixMatch = basename(dir).match(/^(\d{4}-\d{2}-\d{2})-/)
  const prefixDate = prefixMatch?.[1] ?? basename(dir)

  const first = await SessionStore.readFirstLine(paths, sessionId)
  if (first !== undefined && typeof first.utcOffsetMinutes === 'number') {
    return { dir, date: localDateFromStored(first.ts, first.utcOffsetMinutes) }
  }
  return { dir, date: prefixDate }
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
// A thrown error is dropped the same way, not just a null result: readDocument
// can throw (the file behind node.doc was deleted or its frontmatter is
// broken, and a memory folder made of hand-editable markdown makes both of
// those things a user can actually do) and chat.complete can throw (a
// provider error). Either one is caught per document here so it degrades
// exactly like a failed parse: this one document is skipped and left
// untouched, and the rest of pass two, and reflection as a whole, still
// completes. Without this, one failure would escape resolveNarratives,
// escape the caller's _doEndSession, and abort reflection entirely before
// applyReflection ever ran, silently, for every future session that touches
// the same arc or person. onFailure is an optional, best-effort hook for the
// caller to record what was skipped and why; it is not the fix, the
// containment above is. A caller must not treat the absence of an onFailure
// call as the absence of a failure.
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
  onFailure?: (id: string, label: string, reason: string) => void,
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
    try {
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
    } catch (err) {
      onFailure?.(update.arcId, node.label, errorMessage(err))
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
    try {
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
    } catch (err) {
      onFailure?.(update.personId, node.label, errorMessage(err))
    }
  }

  return narratives
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  materializeNew: (mintedItems: ReflectionItem[]) => Promise<void>,
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

  const { dir, date } = await resolveSession(paths, sessionId)
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

  // newArcs and newPersons are materialized by the injected materializeNew
  // callback (see MemoryEngine.createArc / createPersonPage), invoked below
  // in phase 2, before the summary write. applyReflection itself never
  // creates a proposal for them, and it never writes to proposals.jsonl at
  // all. The callback is a plain function, not a ChatProvider: reflection
  // stays free of any model dependency, which is what keeps this function
  // testable without a fake chat script for every case.

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
  // edges, document rewrites, and any new arc or person materializeNew was
  // about to create, with nothing left to notice the loss or retry it.
  // materializeNew therefore runs here too, before the summary write, not
  // after applyReflection returns: a failure inside it must leave the
  // session unreflected and retryable, the same guarantee every other
  // phase-2 write already has.
  await appendGraph(paths, graphRecords)

  for (const write of narrativeWrites) {
    await writeDocumentAtomic(write)
  }

  if (constitutionWrite) {
    await writeDocumentAtomic(constitutionWrite)
  }

  if (out.journalingUpdate !== null) {
    await writeJournalingProtocol(paths, out.journalingUpdate, now)
  }

  await materializeNew(mintedItems)

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
