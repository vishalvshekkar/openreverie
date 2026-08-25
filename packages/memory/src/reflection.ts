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
  type Commitment,
  type CommitmentFlavor,
  recordCommitment,
  resolveCommitment,
  reviseCommitment,
} from './commitments.js'
import { resolveStatedTime } from './commitmentTime.js'
import {
  type Document,
  type DocumentMeta,
  newId,
  readDocument,
  writeDocumentAtomic,
} from './documents.js'
import {
  appendGraph,
  type CommitmentTiming,
  type GraphNode,
  type GraphRecord,
  type GraphState,
  readGraph,
} from './graph.js'
import { writeJournalingProtocol } from './journal.js'
import type { MemoryPaths } from './paths.js'
import { type ProfileMeta, type ProfileUpdates, profileUpdatesSchema } from './profile.js'
import { localDateFromStored, renderStoredStamp, systemTimeZone } from './time.js'
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

// A commitment reflection proposes from scratch: a bounded thing the
// person said they mean to do (an errand or a plan), captured whether or
// not the live remember tool ever ran this session. This is the backstop
// spec Section 7 requires: a chat model that never calls a tool still
// gets its commitments recorded, because reflection reads the transcript,
// not a tool call.
export interface ReflectionCommitment {
  label: string
  flavor: CommitmentFlavor
  // The person's exact wording for timing, unchanged, the same discipline
  // as ReflectionItem.eventTime above. Absent when the person attached no
  // particular time to this commitment at all.
  statedTime?: string
  // One or two sentences interpreting statedTime for this person, in the
  // place they live, written only when statedTime is not a single day
  // named outright (see buildCommitmentTiming below, which prefers a
  // deterministic resolution over this whenever one exists). Never a
  // resolved date itself: the gloss records what was said and what it
  // plausibly means, it does not commit to an instant.
  gloss?: string
  // A rough outer date range (YYYY-MM-DD) for the gloss above. Internal
  // only: used later to decide whether this commitment is worth
  // mentioning, never rendered or spoken to the person. Present only
  // alongside gloss, and even then only when the stated words support a
  // range this concrete.
  bracketFrom?: string
  bracketTo?: string
  // How sure the gloss's own reading is, not how precisely the person
  // spoke (that distinction lives in commitmentTimingSchema's
  // statedPrecision, in graph.ts). Only meaningful alongside gloss.
  confidence?: 'high' | 'medium' | 'low'
  // How precisely the PERSON spoke, asked for directly (see graph.ts's
  // CommitmentInterpretation doc comment for the period/vague taxonomy
  // and why it is kept separate from confidence above). Optional: when
  // the model leaves it out, buildCommitmentTiming below falls back to
  // inferring it from whether a full bracket was given, the same
  // inference this field replaces as the primary source. Important 5:
  // that inference reads OUR bracket shape, not the person's words, so
  // asking directly is preferred whenever the model actually answers.
  statedPrecision?: 'period' | 'vague'
}

// The same shape as ReflectionCommitment, plus the id of the commitment
// being changed. Every other field is optional: a revision only carries
// what changed, and applyReflection below fills in anything left out from
// the commitment's current live version (see reviseCommitment in
// commitments.ts).
export interface ReflectionCommitmentRevision extends Partial<ReflectionCommitment> {
  commitmentId: string
  // Important 6: reviseCommitment (commitments.ts) has no way to clear a
  // stale timing, because omitting statedTime there means "unchanged",
  // not "gone". A revision that wants to withdraw a stated time with
  // nothing to replace it ("forget Friday, we'll sort out a day at some
  // point") sets this instead of statedTime. Deliberately a boolean, not
  // statedTime: null: exactOptionalPropertyTypes forbids a field typed
  // `string | undefined` for a key that's meant to be entirely absent
  // sometimes, and this needs to mean something statedTime's own type
  // cannot express. Ignored when statedTime is also present on the same
  // revision; a stated time is what it is being revised to, not cleared.
  clearTiming?: boolean
}

// A resolution reflection proposes for a commitment already recorded,
// captured whether or not the live remember tool's resolveCommitment
// shape was ever called this session. Important 3: without this,
// resolution was live-tool-only, so a chat model that declines tools
// (the documented finding in BACKLOG.md) could create commitments
// through reflection and never close a single one. Kept as its own array
// rather than an outcome field folded into commitmentRevisions: spec
// Section 7 requires recording, revising and resolving to "stay three
// distinguishable operations at the boundary", and tools.ts's live shapes
// already keep resolveCommitment separate from reviseCommitment for the
// same reason.
export interface ReflectionCommitmentResolution {
  commitmentId: string
  // 'unknown' is deliberately not offered here: that state is reserved
  // for the real askedAt/one-ask mechanism (spec Section 6, tracked in
  // BACKLOG.md), which needs a live-session signal reflection does not
  // have. Reflection can only report an outcome the transcript actually
  // states.
  outcome: 'done' | 'dropped' | 'quiet'
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
  // A brand new commitment: a bounded thing the person said they mean to
  // do. Optional so existing callers (engine.ts's degraded-reflection
  // literal, older test fixtures) that never mention commitments keep
  // compiling; absent reads the same as an empty list. See
  // ReflectionCommitment below for what each field means.
  commitments?: ReflectionCommitment[]
  // A change to a commitment already recorded, referencing its existing
  // id from the Known commitments listing rather than creating a
  // duplicate entry in commitments above.
  commitmentRevisions?: ReflectionCommitmentRevision[]
  // An outcome for a commitment already recorded: the backstop half of
  // resolution (Important 3), the same relationship commitments above has
  // to the live remember tool's commitment shape. Absent reads as an
  // empty list, same as commitments and commitmentRevisions.
  commitmentResolutions?: ReflectionCommitmentResolution[]
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
  // Commitments already recorded (by the live tool earlier this session,
  // or any past session), so reflection can reference an existing id in
  // commitmentRevisions instead of proposing a duplicate in commitments.
  // Optional so existing test fixtures that build a ReflectionContext
  // literal without this field keep compiling; a missing list renders as
  // "none yet", the same as an empty one.
  commitments?: Commitment[]
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

// YYYY-MM-DD only. bracketFrom/bracketTo are an internal scheduling
// bracket, never shown to the person, but shiftDate and the eligibility
// arithmetic in commitments.ts do plain string arithmetic on this shape;
// a bracket in any other shape ("February 2027") would silently corrupt
// that arithmetic downstream. Reflection is the model boundary, so the
// shape is enforced here, per AGENTS.md's rule to validate all LLM
// structured output with zod at the boundary.
const commitmentBracketDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const commitmentConfidenceSchema = z.enum(['high', 'medium', 'low'])

// gloss cannot exist without statedTime: a gloss interprets the words the
// person said, so a gloss with nothing to interpret is a fabricated time,
// exactly what the model must never produce (see the prompt's "never
// resolve a vague time into a specific date" instruction below). This is
// the one invariant this schema exists to enforce; see the falsification
// in reflection.test.ts that breaks it on purpose and confirms the
// rejection test actually depends on it.
function glossWithoutStatedTimeIssue(): { message: string; path: string[] } {
  return {
    message: 'a commitment gloss interprets stated words; it cannot be present without statedTime',
    path: ['statedTime'],
  }
}

const statedPrecisionSchema = z.enum(['period', 'vague'])

const reflectionCommitmentSchema = z
  .object({
    label: z.string(),
    flavor: z.enum(['errand', 'plan']),
    statedTime: z.string().exactOptional(),
    gloss: z.string().exactOptional(),
    bracketFrom: commitmentBracketDateSchema.exactOptional(),
    bracketTo: commitmentBracketDateSchema.exactOptional(),
    confidence: commitmentConfidenceSchema.exactOptional(),
    statedPrecision: statedPrecisionSchema.exactOptional(),
  })
  .refine((c) => c.gloss === undefined || c.statedTime !== undefined, glossWithoutStatedTimeIssue())

const reflectionCommitmentRevisionSchema = z
  .object({
    commitmentId: z.string(),
    label: z.string().exactOptional(),
    flavor: z.enum(['errand', 'plan']).exactOptional(),
    statedTime: z.string().exactOptional(),
    gloss: z.string().exactOptional(),
    bracketFrom: commitmentBracketDateSchema.exactOptional(),
    bracketTo: commitmentBracketDateSchema.exactOptional(),
    confidence: commitmentConfidenceSchema.exactOptional(),
    statedPrecision: statedPrecisionSchema.exactOptional(),
    // Important 6. See ReflectionCommitmentRevision's own comment for why
    // this exists rather than a null statedTime.
    clearTiming: z.boolean().exactOptional(),
  })
  .refine((c) => c.gloss === undefined || c.statedTime !== undefined, glossWithoutStatedTimeIssue())

// Important 3. Deliberately its own small schema rather than folded into
// the revision schema above, matching ReflectionCommitmentResolution's own
// comment on why resolution stays a separate, distinguishable operation.
const reflectionCommitmentResolutionSchema = z.object({
  commitmentId: z.string(),
  outcome: z.enum(['done', 'dropped', 'quiet']),
})

export const reflectionOutputSchema: z.ZodType<ReflectionOutput> = z.object({
  summary: z.string(),
  items: z.array(
    // Preprocessed at the whole-object level, not just the eventTime
    // field, because exactOptionalPropertyTypes forbids a schema whose
    // output type is `string | undefined` for a key typed `eventTime?:
    // string` (ReflectionItem never means "present but undefined"). A
    // field-level transform can turn a blank string into undefined as a
    // VALUE, but the key still counts as present, which trips that check.
    // Stripping the key from the raw object before validation, when a
    // model emits `"eventTime": ""` instead of omitting the key (a well
    // known structured-output tendency, not malice), makes the object
    // arrive at exactOptional looking exactly like one that never had the
    // key: absent, not a blank string. Treated as absent rather than
    // rejected, same reasoning as rememberArgs in tools.ts: the person
    // stated no time, and failing the whole item over a blank optional
    // field would lose real content to punish a shape the model did not
    // mean maliciously. Whitespace-only is stripped the same way.
    z.preprocess(
      (raw) => {
        if (raw !== null && typeof raw === 'object' && 'eventTime' in raw) {
          const value = (raw as { eventTime?: unknown }).eventTime
          if (typeof value === 'string' && value.trim().length === 0) {
            const { eventTime: _drop, ...rest } = raw as Record<string, unknown>
            return rest
          }
        }
        return raw
      },
      z.object({
        text: z.string(),
        kind: reflectionItemKindSchema,
        eventTime: z.string().exactOptional(),
      }),
    ),
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
  commitments: z.array(reflectionCommitmentSchema).exactOptional(),
  commitmentRevisions: z.array(reflectionCommitmentRevisionSchema).exactOptional(),
  commitmentResolutions: z.array(reflectionCommitmentResolutionSchema).exactOptional(),
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

// Deliberately renders only id, label, flavor, and state: never a
// commitment's bracket or gloss. Spec Section 7's "the bracket selects,
// the gloss speaks" rule says the bracket and gloss are never shown or
// spoken to the person; showing them here, inside a prompt the model
// reads and could echo back into a summary or a reply, would defeat that
// as surely as rendering them in the companion's own voice would.
function renderCommitmentListing(commitments: Commitment[] | undefined): string {
  const list = commitments ?? []
  if (list.length === 0) {
    return '(none yet)'
  }
  return list.map((c) => `- ${c.id}: ${c.label} (${c.flavor}, ${c.state})`).join('\n')
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
  "commitments": [{"label": string, "flavor": "errand" | "plan", "statedTime": string | undefined, "gloss": string | undefined, "bracketFrom": string | undefined, "bracketTo": string | undefined, "confidence": "high" | "medium" | "low" | undefined, "statedPrecision": "period" | "vague" | undefined}],
  "commitmentRevisions": [{"commitmentId": string, "label": string | undefined, "flavor": "errand" | "plan" | undefined, "statedTime": string | undefined, "gloss": string | undefined, "bracketFrom": string | undefined, "bracketTo": string | undefined, "confidence": "high" | "medium" | "low" | undefined, "statedPrecision": "period" | "vague" | undefined, "clearTiming": boolean | undefined}],
  "commitmentResolutions": [{"commitmentId": string, "outcome": "done" | "dropped" | "quiet"}],
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
    'Known commitments:',
    renderCommitmentListing(context.commitments),
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
    'A commitment is different from an item: it is a bounded thing the person said they mean to do, an errand or a plan, that can later resolve as done, dropped, or quietly dropped from mention. Put one in commitments with a plain label ("See Nightfall with Arjun", never with a time folded into the label) and a flavor, errand or plan. This works whether or not a live tool already recorded the same commitment during the conversation; commitments here is the backstop that makes sure a commitment is captured even in a session where no tool was ever called.',
    '',
    "The person's exact wording for timing, when they gave one, always goes in statedTime, unchanged, the same discipline as eventTime above: never resolved, never invented.",
    '',
    'Write a gloss only when statedTime is not a single specific day named outright (today, tonight, tomorrow, a named weekday like "Friday", or "in three days" are specific days; a season, a holiday, "sometime", "next Friday" (genuinely ambiguous between two different Fridays), or any stretch of time longer than one day all need a gloss). The gloss is one or two sentences: what was said, when it was said, and what it plausibly means for this person, in the place they actually live, which you can read from Current profile above. Reason about their actual location, never from a fixed season table: summer in Bangalore runs roughly February to May, not June to August, so "come summer" said by someone who lives in Bangalore points at next February, not the middle of the calendar year. bracketFrom and bracketTo are a rough outer date range for the gloss, in YYYY-MM-DD, used only later to decide whether this commitment is worth mentioning again; they are never shown or spoken to the person, and must never be more specific than the gloss itself actually supports. Never resolve a vague or seasonal time into one specific date, and never invent a time the person did not state.',
    '',
    'When you write a gloss, also set statedPrecision to describe how precisely the PERSON spoke, not how sure you are of your own reading: "period" for a named span such as a season ("come summer", "after the holidays"), "vague" for anything looser ("someday", "at some point", "sometime"). This is a different question from confidence, which is about your gloss, not their words.',
    '',
    'Known commitments above lists what is already recorded. If a commitment there has changed (a firmer date, a different plan, a dropped errand becoming certain again), put the change in commitmentRevisions with its existing commitmentId from that list, not a new entry in commitments; a new entry for something already recorded there would duplicate it. If the person withdrew a stated time with nothing yet to replace it ("forget Friday, we will sort out a day at some point"), set clearTiming to true on that revision instead of statedTime.',
    '',
    'If the person reports an outcome for a commitment already listed under Known commitments, put it in commitmentResolutions with that commitment\'s id and an outcome: "done" when they did the thing, "dropped" when they say they are not doing it after all, "quiet" when they ask you to stop tracking or mentioning it. Do not guess an outcome from silence; only record one the person actually stated.',
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
  return items.map((item) => {
    // Normalized here too, not only at reflectionOutputSchema: mintItems
    // can be handed a ReflectionOutput built directly, not only one that
    // passed through that schema (several tests do exactly this, and
    // applyReflection's public signature accepts one too), so the write
    // site itself must not trust that its input already stripped a blank
    // eventTime. Same reasoning as the schema: empty or whitespace-only is
    // never a stated time, and treated as absent rather than rejected.
    const statedEventTime =
      item.eventTime !== undefined && item.eventTime.trim().length > 0 ? item.eventTime : undefined
    return {
      id: newId('item'),
      text: item.text,
      kind: item.kind,
      ts,
      ...(statedEventTime !== undefined ? { eventTime: statedEventTime } : {}),
    }
  })
}

// Shared by both ReflectionCommitment and ReflectionCommitmentRevision:
// only the timing-relevant fields, structurally, so buildCommitmentTiming
// below does not care which of the two it was handed.
interface CommitmentTimingSource {
  statedTime?: string
  gloss?: string
  bracketFrom?: string
  bracketTo?: string
  confidence?: 'high' | 'medium' | 'low'
  statedPrecision?: 'period' | 'vague'
}

// Builds the same CommitmentTiming shape commitments.ts writes to the
// graph, from what reflection's model output actually said. Mirrors
// engine.ts's buildCommitmentTiming for the live tool, plus the one thing
// the live path cannot do: attach a gloss, because reflection has read
// the whole transcript and a live tool call has only ever read one turn
// of it.
//
// resolveStatedTime (Task 2) is tried first and, when it succeeds, wins
// outright: a resolved window is more precise than any gloss could be,
// and commitmentTimingSchema forbids carrying both resolved and
// interpretation on the same record, so a model that wrote a gloss for
// words the resolver actually recognizes (a plain "Friday", say) has that
// gloss silently dropped in favor of the resolved window, not rejected.
// This is deliberate, not a bug: the prompt already tells the model to
// gloss anything that is not a single named day, so this only fires when
// the model glossed a phrasing more cautiously than it needed to.
function buildCommitmentTiming(
  source: CommitmentTimingSource,
  anchor: Date,
  timezone: string,
): CommitmentTiming | undefined {
  // Important 4: blank or whitespace-only is never a stated time, the
  // same discipline mintItems above and tools.ts's statedTimeField apply
  // to eventTime. Without this, a model emitting `"statedTime": ""`
  // instead of omitting the key produced a timing block with no words in
  // it at all, `(said <today>: "")`, the same class of fabricated anchor
  // AGENTS.md already records for the empty-string eventTime bug.
  const statedTime =
    source.statedTime !== undefined && source.statedTime.trim().length > 0
      ? source.statedTime
      : undefined
  if (statedTime === undefined) return undefined
  const anchorIso = anchor.toISOString()

  const resolved = resolveStatedTime(statedTime, anchor, timezone)
  if (resolved !== undefined) {
    return { words: statedTime, anchor: anchorIso, resolved }
  }

  if (source.gloss === undefined) {
    return { words: statedTime, anchor: anchorIso }
  }

  // Important 5: statedPrecision is how precisely the PERSON spoke (see
  // CommitmentInterpretation in graph.ts), not a property of our own
  // bracket. Preferred straight from the model when it answers; the
  // bracket-shape inference (a full bracket reads as a named span,
  // 'period'; anything looser reads as 'vague') is kept only as a
  // fallback for a model that leaves the field out, not as the primary
  // source.
  const statedPrecision =
    source.statedPrecision ??
    (source.bracketFrom !== undefined && source.bracketTo !== undefined ? 'period' : 'vague')

  return {
    words: statedTime,
    anchor: anchorIso,
    interpretation: {
      statedPrecision,
      gloss: source.gloss,
      ...(source.bracketFrom !== undefined ? { bracketFrom: source.bracketFrom } : {}),
      ...(source.bracketTo !== undefined ? { bracketTo: source.bracketTo } : {}),
      interpretationConfidence: source.confidence ?? 'low',
    },
  }
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
// anchor is the commitment timing anchor (CommitmentTiming.anchor): the
// session's own first line, when there is one, never `now`. `now` is when
// reflection runs, not when the person spoke, and the two can be days
// apart (runMaintenance sweeps sessions left unreflected by a crash, and
// resolveStatedTime resolves a relative phrase like "tomorrow" against
// whatever anchor it is given). Resolving against reflection time instead
// of speech time would write a fabricated date, the same class of defect
// AGENTS.md records for the empty-string eventTime anchor bug. Falls back
// to `now` only when the transcript has no readable first line at all.
async function resolveSession(
  paths: MemoryPaths,
  sessionId: string,
  now: Date,
): Promise<{ dir: string; date: string; anchor: string }> {
  const dir = await SessionStore.sessionDir(paths, sessionId)
  const prefixMatch = basename(dir).match(/^(\d{4}-\d{2}-\d{2})-/)
  const prefixDate = prefixMatch?.[1] ?? basename(dir)

  const first = await SessionStore.readFirstLine(paths, sessionId)
  const anchor = first?.ts ?? now.toISOString()
  if (first !== undefined && typeof first.utcOffsetMinutes === 'number') {
    return { dir, date: localDateFromStored(first.ts, first.utcOffsetMinutes), anchor }
  }
  return { dir, date: prefixDate, anchor }
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
  // The person's own timezone, for resolving a commitment's statedTime
  // (see buildCommitmentTiming). Optional, defaulting to the machine's
  // own zone: every real caller (MemoryEngine._doEndSession) passes
  // this.timezone(), the one place engine.ts documents as deciding the
  // profile.md fallback; this default exists only so the many existing
  // tests that call applyReflection directly, with no commitments in
  // play, do not all need updating to supply one.
  timezone: string = systemTimeZone(),
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

  const { dir, date, anchor } = await resolveSession(paths, sessionId, now)
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

  // Commitments: recordCommitment and reviseCommitment (commitments.ts,
  // Task 3) each append straight to graph.jsonl on their own call, the
  // same as every other phase-2 write above, and for the same reason:
  // they run before the summary write so a crash here leaves the session
  // unreflected and this block retried in full, never lost. A retry can
  // at worst re-append a commitment under a fresh id, visible in the
  // graph and harmless, the same tradeoff the comment above phase 2
  // already accepts for item nodes.
  //
  // Reflection wins over the live path for the SAME commitment (spec
  // Section 7): a live commitment recorded earlier in THIS session,
  // whose label matches (case-insensitively) one reflection now proposes
  // as new, is treated as that same commitment and revised rather than
  // duplicated. Reflection read the whole session; the live tool call
  // that created it read only one turn. Scoped to this sessionId, not to
  // every commitment ever recorded, so a same-labelled commitment from
  // months ago is never silently overwritten by an unrelated new one.
  const liveCommitmentIdByLabel = new Map<string, string>()
  for (const node of graphState.nodes.values()) {
    if (node.type === 'commitment' && node.commitment?.sessionId === sessionId) {
      liveCommitmentIdByLabel.set(node.label.toLowerCase(), node.id)
    }
  }

  for (const commitment of out.commitments ?? []) {
    const timing = buildCommitmentTiming(commitment, new Date(anchor), timezone)
    const matchId = liveCommitmentIdByLabel.get(commitment.label.toLowerCase())
    try {
      if (matchId !== undefined) {
        await reviseCommitment(paths, matchId, {
          label: commitment.label,
          flavor: commitment.flavor,
          ...(timing !== undefined ? { timing } : {}),
        })
      } else {
        await recordCommitment(paths, {
          label: commitment.label,
          flavor: commitment.flavor,
          sessionId,
          ...(timing !== undefined ? { timing } : {}),
        })
      }
    } catch {
      // A malformed commitment must not abort the rest of reflection:
      // dropped silently, the same posture materializeNew already takes
      // for entries it cannot act on (an unresolved pagePromotions
      // target, a promotion whose person already has a page). Nothing in
      // this catch is expected to fire from a schema-valid ReflectionOutput
      // (reflectionOutputSchema already enforces shape at the model
      // boundary); it exists for the one case shape validation cannot
      // catch, a hallucinated matchId is not possible here since matchId
      // is derived from the graph, not from the model.
    }
  }

  // commitmentRevisions references an id the model read off Known
  // commitments in the prompt. That id can still fail to resolve: the
  // model can hallucinate one, or the commitment could have been
  // retracted since the prompt was built. reviseCommitment throws in
  // that case (liveCommitment: "No live commitment with id ..."), caught
  // here for the same reason as above, so one bad reference does not cost
  // the rest of this session's reflection.
  for (const revision of out.commitmentRevisions ?? []) {
    // Important 6: clearTiming withdraws a stale stated time with nothing
    // to replace it. Ignored when the model also gave a fresh statedTime
    // on the same revision, since that is a real replacement, not a
    // clearing (buildCommitmentTiming returning a timing already implies
    // there is something to carry forward).
    const timing = buildCommitmentTiming(revision, new Date(anchor), timezone)
    const clearTiming = revision.clearTiming === true && timing === undefined
    try {
      await reviseCommitment(paths, revision.commitmentId, {
        ...(revision.label !== undefined ? { label: revision.label } : {}),
        ...(revision.flavor !== undefined ? { flavor: revision.flavor } : {}),
        ...(timing !== undefined ? { timing } : {}),
        ...(clearTiming ? { clearTiming: true as const } : {}),
      })
    } catch {
      // See the comment above: dropped silently, session still reflects.
    }
  }

  // Important 3: the backstop half of resolution. Same reasoning as the
  // two loops above: an outcome referencing a hallucinated or since-
  // retracted commitmentId throws inside resolveCommitment's own
  // liveCommitment lookup, caught here so one bad reference does not cost
  // the rest of this session's reflection.
  for (const resolution of out.commitmentResolutions ?? []) {
    try {
      await resolveCommitment(paths, resolution.commitmentId, resolution.outcome)
    } catch {
      // See the comment above: dropped silently, session still reflects.
    }
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
