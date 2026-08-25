// The MemoryEngine facade: the single surface every higher layer (core,
// then cli) builds on. It wires together the prose store, the graph log,
// the SQLite index, reflection, rollups, and git versioning into one
// object with session lifecycle, retrieval, and maintenance methods.
//
// Two pieces of state are cached in memory for cheap synchronous reads:
// the folded graph (`graphState`, source of truth is graph.jsonl) and a
// pair of document id/path maps (`docPaths` id to path, and its sibling
// `docIdByPath` path to id, source of truth is the folder itself, since
// MemoryIndex exposes no lookup by document id). All three are rebuilt
// from disk on open() and reindexAll(), and kept in sync after every write
// that touches the graph or adds a document, so a lost or deleted index.db
// never loses information, only the SQL projection of it.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatProvider, EmbeddingProvider } from '@openreverie/providers'
import { decodeTime } from 'ulid'
import type {
  Commitment,
  CommitmentFlavor,
  CommitmentState,
  CommitmentTiming,
} from './commitments.js'
import {
  readCommitments,
  recordCommitment as recordCommitmentRecord,
  resolveCommitment as resolveCommitmentRecord,
  reviseCommitment as reviseCommitmentRecord,
  selectCommitments,
} from './commitments.js'
import { resolveStatedTime } from './commitmentTime.js'
import {
  type Document,
  listDocuments,
  newId,
  readDocument,
  writeDocumentAtomic,
} from './documents.js'
import { commitMemory } from './gitSync.js'
import {
  appendGraph,
  type EdgeType,
  edgeKey,
  type GraphNode,
  type GraphRecord,
  type GraphState,
  type NodeType,
  readGraph,
  readGraphRecords,
  type SequencedGraphRecord,
} from './graph.js'
import {
  assembleJournalBody,
  type JournalMethod,
  readJournalingProtocol,
  readJournalingProtocolIfPresent,
  writeJournalEntry,
  writeJournalingProtocol,
} from './journal.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import {
  loadProfile,
  MODEL_WRITE_FIELDS,
  type Profile,
  type ProfileMeta,
  type ProfileSettingsPatch,
  type ProfileUpdates,
  profileSettingsPatchSchema,
  updateProfileArgsSchema,
  writeProfile,
} from './profile.js'
import {
  type Proposal,
  type ProposalResolution,
  pendingProposals,
  resolveProposal as recordProposalResolution,
} from './proposals.js'
import {
  applyReflection,
  type ReflectionContext,
  type ReflectionItem,
  type ReflectionItemKind,
  type ReflectionOutput,
  reflectSession,
  resolveItemIds,
  resolveNarratives,
} from './reflection.js'
import { type SearchFilters, searchMemory } from './retrieval.js'
import {
  buildDailyRollup,
  buildWeeklyRollup,
  pendingDailyRollups,
  pendingWeeklyRollups,
} from './rollups.js'
import { type DocKind, MemoryIndex, type SearchHit } from './sqlite.js'
import { resolveStyle, type StyleConfig } from './style.js'
import { addDaysLocal, formatLocalDate, systemTimeZone } from './time.js'
import { type PublicTranscriptLine, SessionStore, type TranscriptLine } from './transcripts.js'

export type { SequencedGraphRecord } from './graph.js'

export interface MemoryEngineOpenOptions {
  maintenance?: boolean
}

export interface PublicDocumentRow {
  docId: string
  kind: DocKind
  title: string
  updatedAt: string
  readOnly: true
  method?: string
  entryDate?: string
  excerpt?: string
  recordedAt?: string
}

export interface PublicDocument extends PublicDocumentRow {
  body: string
}

export interface PublicSession {
  sessionId: string
  createdAt: string
  updatedAt: string
  status: 'live' | 'ended' | 'expired'
  readOnly: boolean
  // Set when a session is created or switched, so a browser reload recovers
  // the mode the conversation is actually in. It is carried onto the ended and
  // expired tombstones as well, because those are built by spreading the live
  // view. A stored session's mode lives in its session.json and is not part of
  // this read-only view.
  mode?: string
  transcript: {
    lineCount: number
    userCount: number
    assistantCount: number
    toolCount: number
  }
}

export interface PublicGraphNode {
  id: string
  type: GraphNode['type']
  label: string
  docId?: string
  assertedAt: string
}

export interface PublicGraphEdge {
  key: string
  type: EdgeType
  from: string
  to: string
  confidence: number
  confirmed: boolean
  sourceSessionId?: string
  assertedAt: string
}

// One shape for every listing tool, so no listing in this system can ever
// silently truncate. `total` is always the true count of matching rows, so
// the model can tell how much it has not seen.
export interface ListingEnvelope<Row> {
  total: number
  offset: number
  limit: number
  returned: number
  hasMore: boolean
  rows: Row[]
}

export type ArcStatus = 'active' | 'dormant' | 'closed'

// The graphSnapshot projection plus docId, plus the two fields that only
// exist in the arc page's frontmatter. The raw `doc` filesystem path is
// deliberately absent: the model cannot open a path, and a path in a tool
// result invites quoting it back to the user as though it were meaningful.
export interface ArcRow {
  id: string
  type: 'arc'
  label: string
  assertedAt: string
  docId?: string
  status?: string
  lastTouched?: string
}

export interface RealmRow {
  id: string
  type: 'realm'
  label: string
  assertedAt: string
  docId?: string
}

export interface ListArcsOptions {
  status?: ArcStatus
  offset?: number
  limit?: number
}

export interface ListRealmsOptions {
  offset?: number
  limit?: number
}

export interface PersonRow {
  id: string
  name: string
  hasPage: boolean
  docId?: string
  firstSeen: string
}

// No hasPage and no docId. Entities never get a page in this release, and
// emitting hasPage: false on every row would be noise implying a page might
// exist. If entity pages ever arrive, the shape gains the fields then.
export interface EntityRow {
  id: string
  name: string
  firstSeen: string
}

export interface ListPeopleOptions {
  nameContains?: string
  hasPage?: boolean
  offset?: number
  limit?: number
}

export interface ListEntitiesOptions {
  nameContains?: string
  offset?: number
  limit?: number
}

export interface NodeHit {
  nodeId: string
  name: string
  type: NodeType
  hasPage: boolean
  docId?: string
}

export interface EngineSearchResult {
  documents: SearchHit[]
  nodes: NodeHit[]
}

export interface EngineDeps {
  chat: ChatProvider
  embeddings: EmbeddingProvider
  reflectionModel: string
  embeddingModel: string
}

export interface SessionContext {
  constitution: string
  // The constitution document's id, so the truncation marker capBody emits
  // can hand the model a key read_document accepts. The prompt shows at most
  // CONSTITUTION_CAP characters; the id is how it fetches the rest.
  constitutionDocId: string
  realms: { id: string; name: string; firstLine: string }[]
  arcs: { id: string; name: string; status: string; lastTouched?: string }[]
  // True when there are more active arcs than ARCS_CAP, so `arcs` above is
  // the most recently touched subset rather than the complete active roster.
  arcsTruncated: boolean
  // The true number of active arcs, for the same reason peopleTotal and
  // entitiesTotal exist: the marker states how many were not shown.
  arcsTotal: number
  // Every person node, paged or not, up to PEOPLE_CAP, most recently
  // created first (paged people kept over unpaged ones when the cap cuts
  // the list short). This is what lets the model know a person exists in
  // a later session without having to search for them: the actual fix for
  // the failure that started this round of work.
  people: { id: string; name: string; hasPage: boolean }[]
  // True when there are more person nodes than PEOPLE_CAP, so `people`
  // above is a partial list rather than the complete roster.
  peopleTruncated: boolean
  // The true number of person nodes, whether or not they fit under
  // PEOPLE_CAP. The prompt's truncation marker states it, so the model
  // knows how much of the roster it is not being shown.
  peopleTotal: number
  // Every entity node (a film, a book, a company, a place, a band, a work
  // of fiction), up to ENTITIES_CAP, most recently created first. Entities
  // never get a page in this release, so there is no page status to carry
  // alongside the name.
  entities: { id: string; name: string }[]
  // True when there are more entity nodes than ENTITIES_CAP.
  entitiesTruncated: boolean
  // The true number of entity nodes, for the same reason as peopleTotal.
  entitiesTotal: number
  // Text and the date of the session that captured it, for items of kind
  // 'intention', pulled from recent session summaries' own frontmatter
  // (the same read sessionContext already does for recentSummaries below,
  // not a second pass over disk). These are captured today and nothing
  // ever surfaces them again, which is why the companion appears to forget
  // what the person said they wanted to do. The date matters here exactly
  // as it does for recentSummaries and the daily rollup: without it the
  // model cannot tell an intention from yesterday apart from one from last
  // week. eventTime, when the item carries one, is the person's own stated
  // wording ("tonight", "next week"), never a resolved instant: see
  // ReflectionItem.eventTime (reflection.ts) and the time spec's section 2.
  // It is relative to date above, not to whenever the model reads it.
  recentIntentions: { text: string; date: string; eventTime?: string }[]
  // Commitments already inside their eligible window (commitments.ts,
  // selectCommitments), up to COMMITMENTS_CAP, soonest window first. Spec
  // Section 3: "the bracket selects, the gloss speaks." selectCommitments
  // uses the bracket only to decide whether an entry belongs in this array
  // at all; once it is in, this shape has no field to carry the bracket, a
  // resolved window, or any derived date forward, so context.ts has
  // nothing to render even if it tried. words and date come from the same
  // timing block and are only present together (absent together on a
  // commitment with no timing at all, such as "someday"): words is the
  // person's own wording, never resolved, and date is the local calendar
  // day they said it, read off timing.anchor, not off `now`. gloss is
  // present only when reflection wrote one for a stated time it could not
  // resolve to a window.
  commitments: { label: string; words?: string; date?: string; gloss?: string }[]
  latestDailyRollup?: { date: string; body: string; docId: string }
  recentSummaries: { sessionId: string; date: string; body: string; docId: string }[]
  // The newest WEEKLY_INDEX_CAP weekly rollups, newest first, each with the
  // docId the model needs to fetch it. Never the rollup bodies: those
  // accumulate at 52 per year without bound, and preloading them would
  // recreate the unbounded-prompt problem the budget exists to fix.
  weeklyRollups: { week: string; docId: string }[]
  // The true number of weekly rollups on disk, whether or not they fit in
  // the shelf, so the shelf can say how many exist beyond what it lists.
  weeklyRollupsTotal: number
  // The oldest weekly rollup week, for the "running back to" line. Absent
  // when there are no weekly rollups.
  earliestWeek?: string
  // Count and range of daily rollups, computed for free during the same
  // walk that finds the newest one. earliest and latest are absent when
  // there are no daily rollups.
  dailyRollups: { total: number; earliest?: string; latest?: string }
  // The person's IANA timezone, and whether it is a fact they confirmed or
  // only the default read off the machine at folder creation. The model is
  // never told the current time through this context: the current time
  // reaches it only as the stamp on the newest user message, which is the
  // one part of the request that legitimately grows every turn. Everything
  // rendered from these two fields is static for the life of a session, so
  // the request prefix stays byte-stable and the provider's prefix cache
  // keeps matching.
  timezone: string
  timezoneSource: 'system-default' | 'user-confirmed'
  // True when this memory has no reflected sessions and no arcs at all
  // (of any status), meaning the person has never actually talked with
  // reverie before. The session that was just started to hold the current
  // conversation is itself unreflected and must not count: sessionContext
  // is always called after startSession, so without this carve-out no
  // session would ever look like a first one.
  isFirstSession: boolean
  // Only ever set when the session's mode is journal; undefined for every
  // other mode and for a call site that passes no mode at all. When set,
  // it is either the trimmed body of journaling.md or the fixed
  // JOURNALING_PROTOCOL_ABSENT sentinel, never assembled ad hoc, so its
  // wording cannot drift between call sites.
  journalingProtocol: string | undefined
}

export type GraphQuery =
  | { kind: 'neighbors'; nodeId: string }
  | { kind: 'items_in_arc'; arcId: string }
  | { kind: 'arcs_involving_person'; personId: string }

export interface ForgetInput {
  what: string
  nodeIds?: string[]
  edges?: { edge: EdgeType; from: string; to: string }[]
  documents?: { docId: string; body: string }[]
}

export interface ForgetResult {
  retractedNodes: number
  retractedEdges: number
  rewrittenDocuments: string[]
}

const REALM_STARTER_BODY = 'This realm is new. It grows as we talk.\n'
const ARC_STARTER_BODY = 'This arc is new. It grows as we talk.\n'
const RECENT_SUMMARIES_WINDOW_DAYS = 7
const RECENT_SUMMARIES_CAP = 3
const RECENT_INTENTIONS_CAP = 5
// The cap selectCommitments (commitments.ts) is called with: how many
// eligible commitments sessionContext carries into the prompt, soonest
// window first. Matches RECENT_INTENTIONS_CAP: both are short, capped
// listings of a handful of recent or upcoming things, not a full roster.
const COMMITMENTS_CAP = 5
// People and entity nodes are created generously and never forgotten, so
// both lists only ever grow. Every sibling prompt section is bounded
// (active-only for arcs, a window and a cap for recentSummaries, a cap for
// recentIntentions); these two caps do the same job for people and
// entities, in both the session prompt (context.ts) and the reflection
// prompt (reflection.ts), so neither turns into thousands of tokens on
// every turn after a couple of years of daily use.
const PEOPLE_CAP = 40
const ENTITIES_CAP = 30
// Active arcs rendered in the prompt. Active-only filtering bounds arcs
// against closed ones and nothing bounds them against each other, so a
// user with many open storylines would otherwise grow this section without
// bound. The reflection prompt does not share this cap (arcs are listed
// there by id and label only, which stays short), so it lives here next to
// the chat-prompt caps.
const ARCS_CAP = 30
// How many of the most recent weekly rollups are listed in the prompt
// shelf, each with its docId. Twelve is a quarter, which covers "a month
// ago" without listing years. Older weeks are stated as a count and a
// range, not enumerated, which is what keeps the shelf inside its
// character budget.
const WEEKLY_INDEX_CAP = 12
const PERSON_STARTER_BODY = 'This page is new. It grows as we talk.\n'

export class MemoryEngine {
  private readonly paths: MemoryPaths
  private readonly deps: EngineDeps
  private readonly index: MemoryIndex
  private graphState: GraphState
  private docPaths = new Map<string, string>()
  private docIdByPath = new Map<string, string>()
  // The loaded profile.md, cached for cheap synchronous reads the same way
  // graphState and docPaths are. Source of truth is the file; this copy is
  // refreshed on every write that touches it, so the next read inside this
  // process sees the new value without a second file read racing the first.
  private profileCache: Profile
  private readonly liveItems = new Map<string, ReflectionItem[]>()
  readonly warnings: string[] = []

  // Passed to every listDocuments() call so a file that cannot be parsed
  // is reported by path instead of aborting the walk it is part of (see
  // documents.ts listDocuments). Kept as one instance-bound function so
  // every call site formats the warning identically.
  private readonly onDocSkip = (path: string, reason: string): void => {
    this.warnings.push(`Skipping unreadable document at ${path}: ${reason}`)
  }

  private constructor(
    paths: MemoryPaths,
    deps: EngineDeps,
    index: MemoryIndex,
    graphState: GraphState,
    profile: Profile,
  ) {
    this.paths = paths
    this.deps = deps
    this.index = index
    this.graphState = graphState
    this.profileCache = profile
  }

  static async open(
    root: string,
    deps: EngineDeps,
    options: MemoryEngineOpenOptions = {},
  ): Promise<MemoryEngine> {
    const paths = memoryPaths(root)
    await ensureMemoryTree(paths)
    const index = MemoryIndex.open(paths.indexDb)
    const graphState = await readGraph(paths)
    index.replaceGraph(graphState)
    // Loaded before the engine is constructed, and therefore before
    // runMaintenance() runs below: maintenance computes local calendar days
    // from this timezone, so a profile loaded after it would be too late.
    const profile = await loadProfile(paths)
    const engine = new MemoryEngine(paths, deps, index, graphState, profile)
    engine.clearWarnings()
    // runMaintenance() before refreshDocPaths(): runMaintenance clears
    // warnings as its own first step, which would otherwise wipe out any
    // skipped-document warnings a doc walk during refreshDocPaths had just
    // recorded. Nothing in the maintenance path reads docPaths (only
    // reindexDocument writes it), and running the doc walk last also picks
    // up any rollups or session summaries maintenance itself just wrote.
    if (options.maintenance !== false) {
      await engine.runMaintenance()
    }
    // drainLegacyProposals() after runMaintenance(), not before: runMaintenance
    // clears warnings as its own first step, and draining after it means a
    // warning the drain itself produces (a reindex failure inside
    // createArc/createPersonPage, materialized via materializeProposal)
    // survives instead of being wiped. It runs before refreshDocPaths() so
    // the doc walk that seeds docPaths/docIdByPath already sees any page a
    // drained proposal just wrote, the same reasoning that already put
    // refreshDocPaths() last.
    if (options.maintenance !== false) {
      await engine.drainLegacyProposals()
    }
    // After runMaintenance and drainLegacyProposals, not before: both of
    // those clear warnings as their own first step, so a warning pushed
    // earlier would be wiped before anyone could read it. Nothing in the
    // maintenance path searches the index (reflection reads graph state and
    // the folder; the rollup builders read the folder), so running it
    // against a freshly emptied index is safe, and running the rebuild
    // afterwards also picks up whatever maintenance just wrote.
    //
    // Rebuild rather than leave the index empty: a silently empty search
    // index is the exact failure this release exists to remove. The cost is
    // one embedding pass over the whole folder, once. Nothing is lost if it
    // is interrupted, since the version is only advanced when the tables are
    // recreated and the index is derived from the folder either way.
    if (index.schemaRebuilt) {
      await engine.reindexAll()
      engine.warnings.push(
        'The search index schema changed in this version, so index.db was rebuilt from your memory folder. ' +
          'This happens once, on the first launch after the upgrade, and it re-embeds every document in the folder. ' +
          'Nothing was lost: the index is derived from your files, and it is rebuilt again on the next launch if this one was interrupted.',
      )
    }
    await engine.refreshDocPaths()
    return engine
  }

  async close(): Promise<void> {
    this.index.close()
  }

  profile(): Profile {
    return this.profileCache
  }

  // Every caller that needs a zone goes through here rather than reading
  // the optional field itself, so there is exactly one place that decides
  // what happens when profile.md carries no timezone: fall back to the
  // machine's own zone, which Intl always answers with.
  timezone(): string {
    const stored = this.profileCache.meta.timezone
    return typeof stored === 'string' && stored.length > 0 ? stored : systemTimeZone()
  }

  timezoneSource(): 'system-default' | 'user-confirmed' {
    return this.profileCache.meta.timezoneSource === 'user-confirmed'
      ? 'user-confirmed'
      : 'system-default'
  }

  // The three style axes, with the balanced/warm/listening defaults applied
  // at read time rather than baked into the file schema, so an unset axis in
  // profile.md is never mistaken for a chosen one.
  currentStyle(): StyleConfig {
    return resolveStyle(this.profileCache.meta.style)
  }

  // The MODEL-WRITE path: the live update_profile tool and reflection's
  // profileUpdates both land here. The seven-key allowlist is enforced by
  // the schema, so there is no representable call that writes style.
  // Setting a timezone here is a confirmation, so timezoneSource follows.
  async updateProfile(updates: ProfileUpdates): Promise<Profile> {
    const parsed = updateProfileArgsSchema.safeParse(updates)
    if (!parsed.success) {
      throw new Error(
        `Invalid profile update: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      )
    }
    const meta: ProfileMeta = { ...this.profileCache.meta }
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) meta[key] = value
    }
    if (parsed.data.timezone !== undefined) meta.timezoneSource = 'user-confirmed'
    const next: Profile = { meta, body: this.profileCache.body }
    await writeProfile(this.paths, next)
    this.profileCache = next
    return next
  }

  // The human path: /style, reverie setup, and the settings pane. It
  // accepts style and prose, which no model surface may ever write, and it
  // treats null as "clear this field" so a blank settings box means unknown
  // rather than an empty string.
  async updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile> {
    const parsed = profileSettingsPatchSchema.safeParse(patch)
    if (!parsed.success) {
      throw new Error(
        `Invalid profile settings: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      )
    }
    const meta: ProfileMeta = { ...this.profileCache.meta }
    const mutableMeta: Record<string, unknown> = meta
    for (const key of MODEL_WRITE_FIELDS) {
      const value = parsed.data[key]
      if (value === undefined) continue
      if (value === null) {
        delete mutableMeta[key]
      } else {
        mutableMeta[key] = value
      }
    }
    if (parsed.data.style !== undefined) {
      meta.style = { ...(meta.style ?? {}), ...parsed.data.style }
    }
    if (parsed.data.timezone !== undefined && parsed.data.timezone !== null) {
      meta.timezoneSource = 'user-confirmed'
    }
    const body = parsed.data.prose !== undefined ? parsed.data.prose : this.profileCache.body
    const next: Profile = { meta, body }
    await writeProfile(this.paths, next)
    this.profileCache = next
    return next
  }

  async startSession(now: Date = new Date()): Promise<string> {
    const store = await SessionStore.start(this.paths, now, this.timezone())
    this.liveItems.set(store.sessionId, [])
    return store.sessionId
  }

  // Pushed down from AgentSession rather than read up out of it: core
  // depends on memory, never the other way round, so the mode is told to
  // the engine instead of the engine reaching for it.
  //
  // Written to disk, not held in a map. runMaintenance reflects stale,
  // unreflected sessions through _doEndSession in a later process: someone
  // journals for forty minutes, the process dies before /bye, and
  // reflection runs at the next startup with no live session object
  // anywhere. An in-memory-only mode would mean no journal entry is ever
  // written for that session, which is data loss rather than an edge case.
  async setSessionMode(sessionId: string, mode: string): Promise<void> {
    const existing = (await SessionStore.readMeta(this.paths, sessionId)) ?? {}
    await SessionStore.writeMeta(this.paths, sessionId, { ...existing, mode })
  }

  // The single place that knows how to answer "what mode was this session
  // in." Same-process and later-process reflection go through this identical
  // path. A session directory with no session.json, or one that fails to
  // parse, means the mode is absent. Never a default.
  async sessionMode(sessionId: string): Promise<string | undefined> {
    return (await SessionStore.readMeta(this.paths, sessionId))?.mode
  }

  // Declares which of the six journal methods this session is using, once
  // the companion and the person have settled on one (spec section 7, step
  // 3). Persisted next to the session's mode in the same session.json, on
  // the same crash-safety reasoning that persistence exists for at all:
  // a later process's runMaintenance pass must be able to read it back
  // with no live AgentSession anywhere. Read-merge-write so this call
  // never clobbers a mode already written by setSessionMode.
  async setSessionJournalMethod(sessionId: string, method: JournalMethod): Promise<void> {
    const existing = await SessionStore.readMeta(this.paths, sessionId)
    await SessionStore.writeMeta(this.paths, sessionId, { ...existing, journalMethod: method })
  }

  async sessionJournalMethod(sessionId: string): Promise<JournalMethod | undefined> {
    const meta = await SessionStore.readMeta(this.paths, sessionId)
    return meta?.journalMethod as JournalMethod | undefined
  }

  // The live-tool half of the journaling.md rewrite mechanism (spec
  // section 4.5). Writes through the same shared helper reflection's
  // journalingUpdate uses (Task 12), then reindexes so search stays
  // current; reflection's own path reindexes separately, inside
  // _doEndSession, on the same pattern the constitution update already
  // uses.
  async updateJournalingProtocol(body: string): Promise<Document> {
    const doc = await writeJournalingProtocol(this.paths, body, new Date())
    await this.reindexOrWarn(doc, 'journaling', 'live update_journaling_protocol call')
    return doc
  }

  async appendTranscript(sessionId: string, line: TranscriptLine): Promise<void> {
    const store = await SessionStore.open(this.paths, sessionId)
    await store.appendLine(line)
  }

  async remember(
    sessionId: string,
    text: string,
    kind: ReflectionItemKind = 'observation',
    eventTime?: string,
  ): Promise<void> {
    // Normalized here too, not only at tools.ts's rememberArgs schema:
    // remember() is a public method other callers (direct tests among
    // them) can reach without going through that schema, so the write
    // site itself must not trust that its caller already stripped a blank
    // eventTime. An empty or whitespace-only string is never a stated
    // time; treated as absent, not rejected, for the same reason as the
    // schema: the text is still worth keeping.
    const statedEventTime =
      eventTime !== undefined && eventTime.trim().length > 0 ? eventTime : undefined
    const item: ReflectionItem = {
      id: newId('item'),
      text,
      kind,
      ts: new Date().toISOString(),
      ...(statedEventTime !== undefined ? { eventTime: statedEventTime } : {}),
    }
    const items = this.liveItems.get(sessionId)
    if (items) {
      items.push(item)
    } else {
      this.liveItems.set(sessionId, [item])
    }
  }

  // Records a brand new commitment: a bounded thing the person means to
  // do, identity on the graph log rather than an append-only item. Unlike
  // remember() above, this writes straight through to graph.jsonl: a
  // commitment is a thing with a lifecycle, not a fact queued for
  // end-of-session reflection.
  //
  // No waitsOn parameter here: the live remember tool no longer exposes
  // it (packages/core/src/tools.ts), so nothing calls this with one.
  // recordCommitmentRecord itself still accepts waitsOn for the data
  // model; that is unchanged, only unreachable from this method.
  async recordCommitment(
    sessionId: string,
    input: { label: string; flavor: CommitmentFlavor; statedTime?: string },
  ): Promise<Commitment> {
    const timing = this.buildCommitmentTiming(input.statedTime)
    return recordCommitmentRecord(this.paths, {
      label: input.label,
      flavor: input.flavor,
      sessionId,
      ...(timing !== undefined ? { timing } : {}),
    })
  }

  // Reasserts the same commitment id with the changed fields, per
  // commitments.ts's reviseCommitment: whatever is not passed here carries
  // forward from the current live version rather than being dropped.
  async reviseCommitment(
    id: string,
    changes: { label?: string; statedTime?: string },
  ): Promise<Commitment> {
    const timing = this.buildCommitmentTiming(changes.statedTime)
    return reviseCommitmentRecord(this.paths, id, {
      ...(changes.label !== undefined ? { label: changes.label } : {}),
      ...(timing !== undefined ? { timing } : {}),
    })
  }

  // Records the outcome the caller already knows. Invents nothing: the
  // caller (dispatchRemember) is the one that must have already gotten an
  // explicit outcome out of the model, this only appends it.
  async resolveCommitment(id: string, outcome: CommitmentState): Promise<Commitment> {
    return resolveCommitmentRecord(this.paths, id, outcome)
  }

  // The stated time, resolved when the words are unambiguous enough to
  // reduce to a calendar window, carried as bare words and an anchor when
  // they are not. No interpretation is invented here on the refused
  // branch: a live tool call has no reliable moment to ask a model for a
  // gloss, so that gloss is written later, by reflection.
  private buildCommitmentTiming(statedTime: string | undefined): CommitmentTiming | undefined {
    // Important 4, second site: normalized here too, not only at
    // tools.ts's statedTimeField, for the same reason MemoryEngine.remember
    // (above) does not trust its caller already stripped a blank
    // eventTime. This method is reached from recordCommitment and
    // reviseCommitment, both public, so a direct caller (tests among them)
    // bypassing tools.ts must not be able to write a fabricated
    // `(said <today>: "")` anchor either.
    const stated = statedTime !== undefined && statedTime.trim().length > 0 ? statedTime : undefined
    if (stated === undefined) return undefined
    const anchor = new Date()
    const resolved = resolveStatedTime(stated, anchor, this.timezone())
    return {
      words: stated,
      anchor: anchor.toISOString(),
      ...(resolved !== undefined ? { resolved } : {}),
    }
  }

  async endSession(sessionId: string): Promise<void> {
    // Idempotency guard: a session whose directory already has a
    // summary.md is already reflected, and an unrecognized sessionId has
    // nothing to reflect. Either way, return without any side effects
    // instead of minting a second summary.md (with a fresh doc id) and
    // leaving the old, undeleted row behind it in the index forever.
    const sessions = await SessionStore.listSessions(this.paths)
    const session = sessions.find((s) => s.sessionId === sessionId)
    if (!session || session.reflected) {
      return
    }

    // Only clear warnings after passing the idempotency guard, so a no-op
    // call on an already-reflected session leaves existing warnings untouched.
    this.clearWarnings()

    await this._doEndSession(sessionId)
  }

  private async _doEndSession(sessionId: string): Promise<void> {
    // Internal session-ending logic used by runMaintenance's loop.
    // Does NOT clear warnings; the public endSession or runMaintenance
    // is responsible for warning lifecycle.
    const now = new Date()
    // Read from disk rather than from any in-memory session registry, so
    // this works whether or not the process that started the session is the
    // one ending it. The journal spec's gated write reads this value.
    //
    // Consumed by the journal spec's gated entry write. Read here, in the one
    // place that knows how to answer the question, rather than in two.
    const sessionModeAtEnd = await this.sessionMode(sessionId)
    const transcript = await SessionStore.readTranscript(this.paths, sessionId)

    if (!transcript.some((line) => line.role === 'user')) {
      await this.writeSkippedSummary(sessionId, now)
      this.liveItems.delete(sessionId)
      return
    }

    const context = await this.buildReflectionContext()
    const raw = await reflectSession(
      { chat: this.deps.chat, model: this.deps.reflectionModel },
      transcript,
      context,
    )

    // Ruling 3: a degraded reflection still lands a minimal, valid
    // ReflectionOutput so summary.md is written and the session counts as
    // reflected, instead of being retried forever on an unparseable reply.
    const out: ReflectionOutput = isDegraded(raw)
      ? {
          summary: raw.summary,
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
      : raw

    const liveItems = this.liveItems.get(sessionId) ?? []
    // onFailure here is a best-effort note, not the containment: resolveNarratives
    // itself already skips a document that fails and keeps going (see the
    // comment above it in reflection.ts), which is what lets this session
    // still reflect. This callback only tries to make that skip visible; a
    // warning pushed here can still be cleared before anyone reads it (by
    // a later clearWarnings() in the same process, before printWarnings ever
    // runs), so its absence is not proof nothing was skipped.
    const narratives = await resolveNarratives(
      this.paths,
      this.graphState,
      out,
      this.deps.chat,
      this.deps.reflectionModel,
      (id, label, reason) => {
        this.warnings.push(
          `Could not update the page for "${label}" (${id}) this session: ${reason}. The page was left as it was; this session's note about it was not saved to prose.`,
        )
      },
    )

    // Reflection no longer proposes new arcs, persons, or entities; it
    // saves them directly, using the itemIds applyReflection mints. This
    // runs as a callback INSIDE applyReflection's phase two, before the
    // summary write, not after applyReflection returns: summary.md's
    // presence is what marks a session reflected, so materialization must
    // complete before that write or a crash here would permanently mark
    // the session reflected while whatever it should have created never
    // materializes, with no retry path left. An entry whose itemIndexes
    // resolve to no items is dropped silently rather than materializing a
    // brand-new arc, person, or entity with nothing attached to it; a page
    // promotion is not gated on this, since the node it targets already
    // exists and already has history, so zero new items this session
    // still yields a page, not an orphan. Nothing here was affirmed by the
    // user, so confirmed is false on every edge, unlike
    // materializeProposal's confirmed: true for an accepted proposal.
    const materializeNew = async (mintedItems: ReflectionItem[]): Promise<void> => {
      for (const arc of out.newArcs) {
        const itemIds = resolveItemIds(arc.itemIndexes, mintedItems)
        if (itemIds.length === 0) {
          continue
        }
        await this.createArc({
          name: arc.name,
          realm: arc.realm,
          itemIds,
          narrative: arc.narrative,
          source: sessionId,
          confirmed: false,
        })
      }
      for (const person of out.newPersons) {
        const itemIds = resolveItemIds(person.itemIndexes, mintedItems)
        // A model told never to relist a known name may still slip. Resolve
        // by label first, exactly like resolveOrCreateRealm resolves an
        // arc's realm, so a repeated name attaches this session's items (or
        // is promoted) instead of minting a second node for the same person.
        const existing = this.findNodeByLabel('person', person.name)
        if (existing) {
          if (person.deservesPage && !existing.doc) {
            await this.promoteToPage({
              nodeId: existing.id,
              itemIds,
              narrative: person.narrative,
              source: sessionId,
              confirmed: false,
            })
          } else {
            await this.attachItemsToNode(existing.id, 'person', itemIds, sessionId, false)
          }
          continue
        }
        if (itemIds.length === 0) {
          continue
        }
        if (person.deservesPage) {
          await this.createPersonPage({
            name: person.name,
            itemIds,
            narrative: person.narrative,
            source: sessionId,
            confirmed: false,
          })
        } else {
          await this.createNode({
            name: person.name,
            type: 'person',
            itemIds,
            source: sessionId,
            confirmed: false,
          })
        }
      }
      for (const entity of out.newEntities) {
        const itemIds = resolveItemIds(entity.itemIndexes, mintedItems)
        const existing = this.findNodeByLabel('entity', entity.name)
        if (existing) {
          await this.attachItemsToNode(existing.id, 'entity', itemIds, sessionId, false)
          continue
        }
        if (itemIds.length === 0) {
          continue
        }
        await this.createNode({
          name: entity.name,
          type: 'entity',
          itemIds,
          source: sessionId,
          confirmed: false,
        })
      }
      for (const promotion of out.pagePromotions) {
        const itemIds = resolveItemIds(promotion.itemIndexes, mintedItems)
        const existing = this.graphState.nodes.get(promotion.nodeId)
        // Only a known, still-unpaged person can be promoted: an unknown
        // id, an entity (no pages this release), or a person who already
        // has a page are all dropped silently rather than treated as an
        // error, the same way resolveNarratives drops a target it cannot
        // act on.
        if (existing?.type !== 'person' || existing.doc) {
          continue
        }
        await this.promoteToPage({
          nodeId: existing.id,
          itemIds,
          narrative: promotion.narrative,
          source: sessionId,
          confirmed: false,
        })
      }
    }

    const result = await applyReflection(
      this.paths,
      out,
      sessionId,
      liveItems,
      now,
      narratives,
      materializeNew,
      this.timezone(),
    )
    this.liveItems.delete(sessionId)

    // Reflection's profile backstop. A model that already used the live
    // update_profile tool during the conversation has written these facts
    // once already; writing the same confirmed values again here is a
    // no-op in effect. Validated by updateProfile itself and swallowed on
    // failure: a bad field from the model must not undo a session that has
    // already been written to disk.
    if (out.profileUpdates !== undefined && Object.keys(out.profileUpdates).length > 0) {
      try {
        await this.updateProfile(out.profileUpdates)
      } catch (err) {
        this.warnings.push(`Could not apply reflection's profile updates: ${errorMessage(err)}`)
      }
    }

    await this.syncGraph()
    await this.reindexOrWarn(result.summaryDoc, 'summary', `session ${sessionId} summary`)

    if (out.constitutionUpdate !== null) {
      await this.reindexOrWarn(
        await readDocument(this.paths.constitution),
        'constitution',
        `session ${sessionId} constitution update`,
      )
    }
    if (out.journalingUpdate !== null) {
      await this.reindexOrWarn(
        await readDocument(this.paths.journaling),
        'journaling',
        `session ${sessionId} journaling protocol update`,
      )
    }
    for (const [id] of narratives) {
      const node = this.graphState.nodes.get(id)
      if (node?.doc) {
        await this.reindexOrWarn(
          await readDocument(node.doc),
          node.type === 'person' ? 'person' : 'arc',
          `session ${sessionId} narrative rewrite for ${id}`,
        )
      }
    }

    // Journal mode adds one more write after the rest of this pipeline
    // completes, gated on the session's own recorded mode (read into
    // sessionModeAtEnd above) and declared method (read fresh here), both
    // sourced from session.json on disk rather than from any in-memory
    // session registry: this is what makes the write survive the process
    // that started the session dying before an orderly endSession (spec
    // section 11). Absent mode, absent method, or a mode other than
    // journal all degrade the same way: no journal document is written,
    // and nothing else about this pipeline changes.
    if (sessionModeAtEnd === 'journal') {
      const method = await this.sessionJournalMethod(sessionId)
      if (method) {
        const entryDate = formatLocalDate(now, this.timezone())
        const body = assembleJournalBody(transcript, method)
        const entryDoc = await writeJournalEntry(this.paths, {
          method,
          entryDate,
          recordedAt: now.toISOString(),
          session: sessionId,
          body,
        })
        await this.reindexOrWarn(entryDoc, 'journal', `session ${sessionId} journal entry`)
      }
    }

    const commitResult = await commitMemory(this.paths.root, `reflect: session ${sessionId}`)
    if (!commitResult.ok && commitResult.warning) {
      this.warnings.push(commitResult.warning)
    }
  }

  async sessionContext(now: Date = new Date(), mode?: string): Promise<SessionContext> {
    const constitutionDoc = await readDocument(this.paths.constitution)

    const arcs: SessionContext['arcs'] = []
    const arcRows: {
      id: string
      name: string
      status: string
      lastTouched?: string
      ts: string
    }[] = []
    for (const node of this.graphState.nodes.values()) {
      if (node.type !== 'arc') continue
      let status = 'active'
      let lastTouched: string | undefined
      if (node.doc) {
        try {
          const doc = await readDocument(node.doc)
          if (typeof doc.meta.status === 'string') status = doc.meta.status
          if (typeof doc.meta.updated === 'string') lastTouched = doc.meta.updated
        } catch {
          // Arc node points at a doc that no longer reads cleanly; fall
          // back to defaults rather than failing the whole context build.
        }
      }
      // Ruling 3: sessionContext only carries active arcs into the
      // assembled context; dormant and closed arcs never age out of
      // graphState on their own, so they must be filtered here instead.
      if (status !== 'active') continue
      arcRows.push({
        id: node.id,
        name: node.label,
        status,
        ...(lastTouched ? { lastTouched } : {}),
        ts: node.ts,
      })
    }
    arcRows.sort(compareArcs)
    const arcsTotal = arcRows.length
    for (const row of arcRows.slice(0, ARCS_CAP)) {
      arcs.push({
        id: row.id,
        name: row.name,
        status: row.status,
        ...(row.lastTouched ? { lastTouched: row.lastTouched } : {}),
      })
    }
    const arcsTruncated = arcsTotal > ARCS_CAP

    const realms: SessionContext['realms'] = []
    for (const node of this.graphState.nodes.values()) {
      if (node.type !== 'realm') continue
      let firstLine = ''
      if (node.doc) {
        try {
          const doc = await readDocument(node.doc)
          firstLine = (doc.body.split('\n').find((line) => line.trim().length > 0) ?? '').trim()
        } catch {
          // Same fallback as arcs above.
        }
      }
      realms.push({ id: node.id, name: node.label, firstLine })
    }

    let latestDailyRollup: { date: string; body: string; docId: string } | undefined
    let dailyTotal = 0
    let dailyEarliest: string | undefined
    let dailyLatest: string | undefined
    for (const doc of await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip)) {
      if (typeof doc.meta.date !== 'string') continue
      dailyTotal += 1
      if (dailyEarliest === undefined || doc.meta.date < dailyEarliest)
        dailyEarliest = doc.meta.date
      if (dailyLatest === undefined || doc.meta.date > dailyLatest) dailyLatest = doc.meta.date
      if (!latestDailyRollup || doc.meta.date > latestDailyRollup.date) {
        latestDailyRollup = { date: doc.meta.date, body: doc.body, docId: doc.meta.id }
      }
    }
    const dailyRollups = {
      total: dailyTotal,
      ...(dailyEarliest !== undefined ? { earliest: dailyEarliest } : {}),
      ...(dailyLatest !== undefined ? { latest: dailyLatest } : {}),
    }

    // The weekly shelf. Only the id-bearing index is preloaded, never the
    // bodies. One directory read plus a frontmatter parse per weekly file,
    // on the same order as the daily walk already performed beside it.
    const weeklyDocs = await listDocuments(this.paths.rollupsWeeklyDir, this.onDocSkip)
    const weeklyRollups: SessionContext['weeklyRollups'] = []
    let weeklyRollupsTotal = 0
    let earliestWeek: string | undefined
    for (const doc of weeklyDocs) {
      if (typeof doc.meta.week !== 'string') continue
      weeklyRollupsTotal += 1
      if (earliestWeek === undefined || doc.meta.week < earliestWeek) {
        earliestWeek = doc.meta.week
      }
      weeklyRollups.push({ week: doc.meta.week, docId: doc.meta.id })
    }
    // ISO week ids sort lexicographically in chronological order, so a
    // descending sort puts the newest week first.
    weeklyRollups.sort((a, b) => (a.week > b.week ? -1 : 1))

    const sessions = await SessionStore.listSessions(this.paths)
    const recentCutoff = addDaysLocal(now, -RECENT_SUMMARIES_WINDOW_DAYS, this.timezone())
    // Sort by calendar date, most recent first. Session ids are ULIDs
    // built from the wall clock at creation time, not from the session's
    // own date, so they only break ties between two sessions that land on
    // the same date; they cannot stand in for date order on their own.
    const recentCandidates = sessions
      .filter((session) => session.reflected && !session.skipped && session.date >= recentCutoff)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1
        return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0
      })
      .slice(0, RECENT_SUMMARIES_CAP)

    const recentSummaries: SessionContext['recentSummaries'] = []
    const recentIntentions: SessionContext['recentIntentions'] = []
    for (const session of recentCandidates) {
      const summaryPath = join(this.paths.sessionsDir, session.dirName, 'summary.md')
      const doc = await readDocument(summaryPath)
      recentSummaries.push({
        sessionId: session.sessionId,
        date: session.date,
        body: doc.body,
        docId: doc.meta.id,
      })
      // doc.meta.items is the same mergedItems array applyReflection wrote
      // into this summary's frontmatter (see reflection.ts). A hand-written
      // summary.md (several tests build one directly) has no items key at
      // all, so every step here is a shape check, not a cast.
      const items = doc.meta.items
      if (Array.isArray(items)) {
        for (const item of items) {
          if (
            item !== null &&
            typeof item === 'object' &&
            (item as { kind?: unknown }).kind === 'intention' &&
            typeof (item as { text?: unknown }).text === 'string'
          ) {
            // The session's own date, not the item's ts: consistent with
            // recentSummaries and the daily rollup, and unlike ts (empty
            // on a hand-written summary.md in several tests) it is always
            // present.
            //
            // Ruling 11: this reads raw frontmatter off a summary.md on
            // disk, the same untrusted-folder boundary as sqlite.ts's
            // itemChunkText. A summary.md written before the write-site
            // fixes, or hand-edited, can carry `eventTime: ""`; trimmed
            // and treated as absent here too, so it never renders as a
            // fabricated `(eventTime: "")` in the prompt.
            const eventTimeRaw = (item as { eventTime?: unknown }).eventTime
            const eventTime =
              typeof eventTimeRaw === 'string' && eventTimeRaw.trim().length > 0
                ? eventTimeRaw
                : undefined
            recentIntentions.push({
              text: (item as { text: string }).text,
              date: session.date,
              ...(eventTime !== undefined ? { eventTime } : {}),
            })
          }
        }
      }
    }

    // The bracket that decides eligibility never leaves selectCommitments:
    // this map only ever reads label, words, anchor, and interpretation.gloss
    // off the commitments it returns. today is computed the same way every
    // other local-day selection in this method is (formatLocalDate against
    // this.timezone()), not off `now` directly, so a commitment recorded
    // late at night and one recorded just after midnight the same local day
    // select the same way.
    const today = formatLocalDate(now, this.timezone())
    const allCommitments = await readCommitments(this.paths)
    const eligibleCommitments = selectCommitments(allCommitments, today, COMMITMENTS_CAP)
    const commitments: SessionContext['commitments'] = eligibleCommitments.map((commitment) => {
      const timing = commitment.timing
      const said =
        timing !== undefined
          ? { words: timing.words, date: formatLocalDate(new Date(timing.anchor), this.timezone()) }
          : {}
      const gloss =
        timing?.interpretation !== undefined ? { gloss: timing.interpretation.gloss } : {}
      return { label: commitment.label, ...said, ...gloss }
    })

    const personNodes: GraphNode[] = []
    const entityNodes: GraphNode[] = []
    for (const node of this.graphState.nodes.values()) {
      if (node.type === 'person') {
        personNodes.push(node)
      } else if (node.type === 'entity') {
        entityNodes.push(node)
      }
    }
    const cappedPeople = capPeople(personNodes)
    const cappedEntities = capEntities(entityNodes)
    const people: SessionContext['people'] = cappedPeople.nodes.map((node) => ({
      id: node.id,
      name: node.label,
      hasPage: node.doc !== undefined,
    }))
    const entities: SessionContext['entities'] = cappedEntities.nodes.map((node) => ({
      id: node.id,
      name: node.label,
    }))

    // Any arc at all (regardless of status) or any reflected session
    // (regardless of date) means this person has talked with reverie
    // before. Note this deliberately does not reuse the `arcs` array
    // above, which is filtered down to active arcs only: a memory with
    // only a dormant or closed arc is still not a first session.
    const hasAnyArc = [...this.graphState.nodes.values()].some((node) => node.type === 'arc')
    // A skipped session never happened as far as this check is concerned:
    // it carries no content, so it must not be able to consume someone's
    // guided first-conversation flow by itself.
    const hasReflectedSession = sessions.some((session) => session.reflected && !session.skipped)
    const isFirstSession = !hasAnyArc && !hasReflectedSession

    const journalingProtocol =
      mode === 'journal' ? await readJournalingProtocol(this.paths) : undefined

    return {
      constitution: constitutionDoc.body,
      constitutionDocId: constitutionDoc.meta.id,
      realms,
      arcs,
      arcsTruncated,
      arcsTotal,
      people,
      peopleTruncated: cappedPeople.truncated,
      peopleTotal: personNodes.length,
      entities,
      entitiesTruncated: cappedEntities.truncated,
      entitiesTotal: entityNodes.length,
      recentIntentions: recentIntentions.slice(0, RECENT_INTENTIONS_CAP),
      commitments,
      ...(latestDailyRollup ? { latestDailyRollup } : {}),
      recentSummaries,
      weeklyRollups: weeklyRollups.slice(0, WEEKLY_INDEX_CAP),
      weeklyRollupsTotal,
      ...(earliestWeek !== undefined ? { earliestWeek } : {}),
      dailyRollups,
      timezone: this.timezone(),
      timezoneSource: this.timezoneSource(),
      isFirstSession,
      journalingProtocol,
    }
  }

  async search(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<EngineSearchResult> {
    const results = await searchMemory(
      this.index,
      this.deps.embeddings,
      this.deps.embeddingModel,
      query,
      filters,
      limit,
    )
    // The nodes table stores a filesystem path, not a document id, so the
    // path-to-docId projection happens here, exactly as withDocId does for
    // graphQuery. A node with no page has neither.
    const nodes: NodeHit[] = results.nodes.map((node) => {
      const hit: NodeHit = {
        nodeId: node.id,
        name: node.label,
        type: node.type,
        hasPage: node.doc !== null,
      }
      const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
      if (docId) hit.docId = docId
      return hit
    })
    return { documents: results.documents, nodes }
  }

  graphQuery(query: GraphQuery): unknown[] {
    if (query.kind === 'neighbors') {
      return this.index.neighbors(query.nodeId).map(({ edge, node }) => ({
        edge,
        node: this.withDocId(node),
      }))
    }
    if (query.kind === 'items_in_arc') {
      return this.index.itemsInArc(query.arcId).map((node) => this.withDocId(node))
    }
    return this.index.arcsInvolvingPerson(query.personId).map((node) => this.withDocId(node))
  }

  docIdForPath(path: string): string | undefined {
    return this.docIdByPath.get(path)
  }

  private withDocId(node: GraphNode): GraphNode & { docId?: string } {
    if (!node.doc) return node
    const docId = this.docIdByPath.get(node.doc)
    return docId ? { ...node, docId } : node
  }

  async readDocumentById(docId: string): Promise<Document | null> {
    let path = this.docPaths.get(docId)
    if (!path) {
      await this.refreshDocPaths()
      path = this.docPaths.get(docId)
    }
    if (!path) return null
    try {
      return await readDocument(path)
    } catch {
      return null
    }
  }

  async listPublicDocuments(): Promise<PublicDocumentRow[]> {
    const docs = await this.walkAllDocuments()
    return docs.map(({ doc, kind }) => publicDocumentRow(doc, kind)).sort(comparePublicDocuments)
  }

  async getPublicDocument(docId: string): Promise<PublicDocument | null> {
    const doc = await this.readDocumentById(docId)
    if (!doc) return null
    const kind = await this.kindForPublicDocument(doc.path)
    if (!kind) return null
    return { ...publicDocumentRow(doc, kind), body: doc.body }
  }

  async listStoredSessions(): Promise<PublicSession[]> {
    const sessions = await SessionStore.describe(this.paths)
    return sessions.map((session) => ({
      ...session,
      status: 'ended',
      readOnly: true,
    }))
  }

  async readGraphHistory(): Promise<SequencedGraphRecord[]> {
    return readGraphRecords(this.paths)
  }

  graphSnapshot(): { nodes: PublicGraphNode[]; edges: PublicGraphEdge[] } {
    const nodes = [...this.graphState.nodes.values()].map((node) => {
      const projected: PublicGraphNode = {
        id: node.id,
        type: node.type,
        label: node.label,
        assertedAt: node.ts,
      }
      const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
      if (docId) projected.docId = docId
      return projected
    })
    const activeNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: [...this.graphState.edges.values()]
        .filter((edge) => activeNodeIds.has(edge.from) && activeNodeIds.has(edge.to))
        .map((edge) => ({
          key: edgeKey(edge),
          type: edge.edge,
          from: edge.from,
          to: edge.to,
          confidence: edge.confidence,
          confirmed: edge.confirmed,
          ...(edge.source ? { sourceSessionId: edge.source } : {}),
          assertedAt: edge.ts,
        })),
    }
  }

  async readTranscript(sessionId: string): Promise<TranscriptLine[]> {
    return SessionStore.readTranscript(this.paths, sessionId)
  }

  async readTranscriptPage(sessionId: string): Promise<PublicTranscriptLine[]> {
    return SessionStore.readTranscriptPage(this.paths, sessionId)
  }

  async listPendingProposals(): Promise<Proposal[]> {
    return pendingProposals(this.paths)
  }

  // Async because arc status and lastTouched live in the arc page's
  // frontmatter, not on the graph node, and the tool has been promising a
  // status field it never returned. Arc counts are in the dozens, so a
  // bounded set of document reads per call is acceptable.
  async listArcs(options: ListArcsOptions = {}): Promise<ListingEnvelope<ArcRow>> {
    const nodes = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'arc')
      .sort(compareNodesForListing)

    const rows: ArcRow[] = []
    for (const node of nodes) {
      const row: ArcRow = {
        id: node.id,
        type: 'arc',
        label: node.label,
        assertedAt: node.ts,
      }
      const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
      if (docId) row.docId = docId
      if (node.doc) {
        try {
          const doc = await readDocument(node.doc)
          if (typeof doc.meta.status === 'string') row.status = doc.meta.status
          if (typeof doc.meta.updated === 'string') row.lastTouched = doc.meta.updated
        } catch {
          // The page does not read cleanly. Omit status and lastTouched
          // rather than defaulting them: defaulting an unreadable arc to
          // active is how a broken file becomes a wrong answer.
        }
      }
      if (options.status !== undefined && row.status !== options.status) continue
      rows.push(row)
    }

    return pageRows(rows, options.offset, options.limit)
  }

  listRealms(options: ListRealmsOptions = {}): ListingEnvelope<RealmRow> {
    const rows = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'realm')
      .sort(compareNodesForListing)
      .map((node) => {
        const row: RealmRow = {
          id: node.id,
          type: 'realm',
          label: node.label,
          assertedAt: node.ts,
        }
        const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
        if (docId) row.docId = docId
        return row
      })
    return pageRows(rows, options.offset, options.limit)
  }

  // The escape hatch for everyone past PEOPLE_CAP. A person with no page has
  // no document, so no chunk, no FTS row and no embedding: search_memory's
  // document lane cannot find them under any query, and before this method
  // and the node lane existed there was no way to reach them at all.
  listPeople(options: ListPeopleOptions = {}): ListingEnvelope<PersonRow> {
    const needle = options.nameContains?.toLowerCase()
    const rows = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'person')
      .filter((node) => (needle === undefined ? true : node.label.toLowerCase().includes(needle)))
      .filter((node) =>
        options.hasPage === undefined ? true : (node.doc !== undefined) === options.hasPage,
      )
      .sort(compareNodesForListing)
      .map((node) => {
        const row: PersonRow = {
          id: node.id,
          name: node.label,
          hasPage: node.doc !== undefined,
          firstSeen: node.ts,
        }
        const docId = node.doc ? this.docIdByPath.get(node.doc) : undefined
        if (docId) row.docId = docId
        return row
      })
    return pageRows(rows, options.offset, options.limit)
  }

  listEntities(options: ListEntitiesOptions = {}): ListingEnvelope<EntityRow> {
    const needle = options.nameContains?.toLowerCase()
    const rows = [...this.graphState.nodes.values()]
      .filter((node) => node.type === 'entity')
      .filter((node) => (needle === undefined ? true : node.label.toLowerCase().includes(needle)))
      .sort(compareNodesForListing)
      .map((node) => ({ id: node.id, name: node.label, firstSeen: node.ts }))
    return pageRows(rows, options.offset, options.limit)
  }

  async resolveProposal(id: string, resolution: ProposalResolution): Promise<void> {
    if (resolution === 'accepted') {
      const proposals = await pendingProposals(this.paths)
      const proposal = proposals.find((p) => p.id === id)
      // If the proposal is not pending (already resolved, or never
      // existed), skip materialization: recordProposalResolution below
      // either no-ops (already resolved) or throws (unknown id), and
      // either way nothing should be created twice.
      if (proposal) {
        await this.materializeProposal(proposal)
      }
    }
    await recordProposalResolution(this.paths, id, resolution)
    await commitMemory(this.paths.root, `proposal: ${resolution} ${id}`)
  }

  // Materializes and resolves every pending proposal silently, with no
  // conversation and no acceptance step: proposal generation is retired, so
  // nothing is ever newly queued, but an older memory folder can still
  // carry proposals left over from before that change, and stranding them
  // unresolved forever is worse than accepting what reflection already
  // judged worth remembering. Reuses resolveProposal itself (accepted, the
  // same materialize-then-record path a person would trigger by hand) so
  // there is exactly one implementation of "accept a proposal", not a
  // second one duplicated here for the silent case. A no-op when the queue
  // is empty, which is the common case: the owner's own queue already is.
  //
  // Each proposal is resolved independently, inside its own try/catch.
  // materializeProposal does unchecked casts of a proposal's stored
  // payload, so a proposal written under an older shape, or otherwise
  // malformed, throws out of it (materializeProposal, not resolveProposal's
  // own bookkeeping). That throw happens before resolveProposal records the
  // resolution, so without this try/catch the proposal would stay pending
  // and this same throw would happen again on every future open(),
  // permanently wedging the folder shut: a regression from before this
  // release, when such a folder simply opened with the proposal left
  // sitting in the queue. On a materialization failure this still records
  // the proposal as accepted (recordProposalResolution below, called
  // directly rather than through resolveProposal, since resolveProposal
  // already threw before reaching its own resolution step) so drain never
  // retries something that can never materialize, and pushes a warning so
  // the loss is not invisible. A folder that keeps opening for a real
  // person matters more than one legacy proposal from before this release
  // materializing cleanly. Note that materializeProposal's own writes are
  // not transactional: a throw partway through (e.g. createArc's realm
  // document and node already written before it throws on a missing
  // itemIds) can leave a realm or an orphaned page behind, written but
  // with no graph record completing it. This drain does not clean that up;
  // it only guarantees the proposal queue itself stops blocking open().
  private async drainLegacyProposals(): Promise<void> {
    // The read itself, not just materialization, must be inside a
    // try/catch: readLines (via pendingProposals) throws on any line that
    // is not valid JSON, and proposals.jsonl is append-only, hand-editable,
    // and written with appendFile, which is not crash atomic. A single
    // truncated line is reachable in practice, and this is the repair
    // command's own dependency: reindex opens the engine too, so letting
    // this throw locks the user out of the one command that could fix it.
    // Unlike a malformed payload (valid JSON, wrong shape, caught per
    // proposal below), a corrupt line cannot be isolated: there is no way
    // to know where the queue is broken versus where it is fine, so the
    // whole drain is skipped for this open() rather than materializing
    // some proposals and silently dropping the rest.
    let proposals: Proposal[]
    try {
      proposals = await pendingProposals(this.paths)
    } catch (err) {
      this.warnings.push(
        `Could not read the proposal queue at ${this.paths.proposals}: ${errorMessage(err)}. ` +
          'Skipping the legacy proposal drain for this session; nothing pending in it was lost, ' +
          'it is just not readable right now.',
      )
      return
    }
    for (const proposal of proposals) {
      try {
        await this.resolveProposal(proposal.id, 'accepted')
      } catch (err) {
        this.warnings.push(
          `Could not fully materialize legacy proposal ${proposal.id} (${proposal.kind}): ${errorMessage(err)}. ` +
            'Marked as resolved anyway so it does not block future launches. Its graph records were not written; ' +
            'a page or realm it had already started writing may be left behind incomplete.',
        )
        try {
          await recordProposalResolution(this.paths, proposal.id, 'accepted')
        } catch {
          // Already resolved, or the proposal queue itself is unreadable;
          // either way there is nothing more this can do.
        }
        const commitResult = await commitMemory(
          this.paths.root,
          `proposal: accepted ${proposal.id} (materialization failed, resolved anyway)`,
        )
        if (!commitResult.ok && commitResult.warning) {
          this.warnings.push(commitResult.warning)
        }
      }
    }
  }

  // Parked, not shipped. Nothing in core or cli calls this: no tool
  // exposes it to the model, and no persona text promises it. It stays
  // here as dormant code, kept working and kept tested, because the
  // project intends to offer a forget path eventually and does not want
  // to rebuild this from scratch when it does. Two known gaps must be
  // closed before this is ever wired back up to a tool: retracting a node
  // does not remove the page it points at, so a person or arc's page
  // stays on disk and fully searchable after their node is gone, and a
  // multi document forget call is not atomic, so a failure partway
  // through can leave the graph and some documents already changed while
  // still reporting failure, with no commit. Do not expose this to a tool
  // or a persona without fixing both first.
  //
  // Retracts requested nodes and edges by appending op: 'retract' records
  // (both the original assertion and the retraction stay in graph.jsonl;
  // nothing is ever erased) and rewrites documents in full through
  // writeDocumentAtomic. Every document rewrite is validated before any
  // write happens: a body that would leave the file empty or whitespace
  // only is rejected, and a rejection here changes nothing on disk, in the
  // graph, or anywhere else. This never touches a transcript or a session
  // summary; the only files it can write are the graph log and prose
  // documents outside the sessions folder.
  async forget(input: ForgetInput): Promise<ForgetResult> {
    const targets: { path: string; doc: Document; kind: DocKind }[] = []
    for (const { docId, body } of input.documents ?? []) {
      if (body.trim().length === 0) {
        throw new Error(
          `forget: the new body for ${docId} is empty or whitespace only; refusing to write it`,
        )
      }
      let path = this.docPaths.get(docId)
      if (!path) {
        await this.refreshDocPaths()
        path = this.docPaths.get(docId)
      }
      if (!path) {
        throw new Error(`forget: no document found for id ${docId}`)
      }
      const current = await readDocument(path)
      targets.push({ path, doc: { ...current, body }, kind: this.kindForDocumentPath(path) })
    }

    const now = new Date().toISOString()
    const records: GraphRecord[] = []
    let retractedNodes = 0
    let retractedEdges = 0

    for (const nodeId of input.nodeIds ?? []) {
      const node = this.graphState.nodes.get(nodeId)
      if (!node) continue
      records.push({
        ts: now,
        op: 'retract',
        node: nodeId,
        type: node.type,
        label: node.label,
        ...(node.doc !== undefined ? { doc: node.doc } : {}),
      })
      retractedNodes += 1
    }

    for (const e of input.edges ?? []) {
      const edge = this.graphState.edges.get(edgeKey(e))
      if (!edge) continue
      records.push({
        ts: now,
        op: 'retract',
        edge: e.edge,
        from: e.from,
        to: e.to,
        confidence: edge.confidence,
        confirmed: edge.confirmed,
        ...(edge.source !== undefined ? { source: edge.source } : {}),
      })
      retractedEdges += 1
    }

    if (records.length > 0) {
      await appendGraph(this.paths, records)
      await this.syncGraph()
    }

    const rewrittenDocuments: string[] = []
    for (const target of targets) {
      await writeDocumentAtomic(target.doc)
      await this.reindexOrWarn(target.doc, target.kind, `forget: ${input.what}`)
      rewrittenDocuments.push(target.path)
    }

    const commitResult = await commitMemory(this.paths.root, `forget: ${input.what}`)
    if (!commitResult.ok && commitResult.warning) {
      this.warnings.push(commitResult.warning)
    }

    return { retractedNodes, retractedEdges, rewrittenDocuments }
  }

  async runMaintenance(now: Date = new Date()): Promise<void> {
    this.clearWarnings()

    // Reflect stale sessions first: pendingDailyRollups only looks at
    // whether a date has sessions, not whether they are reflected, and
    // buildDailyRollup throws for a date with no reflected session.
    // Call _doEndSession (not endSession) so each session's warnings
    // accumulate rather than being cleared per session.
    const sessions = await SessionStore.listSessions(this.paths)
    for (const session of sessions) {
      if (session.reflected) continue
      try {
        await this._doEndSession(session.sessionId)
      } catch {
        // reflectSession, applyReflection's own writes, or the
        // materializeNew callback it invokes (creating a new arc or
        // person) all failed before summary.md was written (_doEndSession's
        // own reindex and commit steps no longer throw; see reindexOrWarn
        // below), so the session stays unreflected in its frontmatter and
        // is retried on the next pass. The transcript itself is never at
        // risk. This is caught silently, with no warning recorded, the
        // same way every other pre-summary failure here always has been:
        // the retry on the next pass is the recovery, not a warning.
      }
    }

    const today = formatLocalDate(now, this.timezone())

    // A date whose only session was skipped has no content to roll up:
    // excluding skipped sessions here means such a date never becomes
    // "pending" in the first place, so buildDailyRollup below is never
    // asked to synthesize a rollup out of nothing but a placeholder line.
    const reflected = (await SessionStore.listSessions(this.paths)).filter(
      (s) => s.reflected && !s.skipped,
    )
    const sessionDates = reflected.map((s) => s.date)
    const existingDailies = stringMeta(
      await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip),
      'date',
    )

    for (const date of pendingDailyRollups(sessionDates, existingDailies, today)) {
      try {
        const doc = await buildDailyRollup(
          { chat: this.deps.chat, model: this.deps.reflectionModel, paths: this.paths },
          date,
        )
        // The rollup file is already durably written on disk at this
        // point, so pendingDailyRollups will not consider this date
        // pending again on the next pass. A reindex failure here is
        // therefore not automatically retried; it is recoverable via
        // reindexAll(), and is surfaced as a warning instead of thrown.
        await this.reindexOrWarn(doc, 'rollup_daily', `daily rollup ${date}`)
      } catch {
        // buildDailyRollup itself failed (provider error or similar)
        // before anything was written to disk, so the date is genuinely
        // still pending and will be retried on the next pass.
      }
    }

    const dailyDates = stringMeta(
      await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip),
      'date',
    )
    const existingWeeklies = stringMeta(
      await listDocuments(this.paths.rollupsWeeklyDir, this.onDocSkip),
      'week',
    )

    for (const week of pendingWeeklyRollups(dailyDates, existingWeeklies, today)) {
      try {
        const doc = await buildWeeklyRollup(
          { chat: this.deps.chat, model: this.deps.reflectionModel, paths: this.paths },
          week,
        )
        // Same reasoning as the daily rollup above: the file is already
        // written, so a reindex failure here is durable-but-unsearchable,
        // not automatically retried, and only surfaced as a warning.
        await this.reindexOrWarn(doc, 'rollup_weekly', `weekly rollup ${week}`)
      } catch {
        // buildWeeklyRollup itself failed before writing; the week is
        // still pending and retried on the next pass.
      }
    }

    const commitResult = await commitMemory(
      this.paths.root,
      'maintenance: reflect stale sessions and build pending rollups',
    )
    if (!commitResult.ok && commitResult.warning) {
      this.warnings.push(commitResult.warning)
    }
  }

  async reindexAll(): Promise<void> {
    const docs = await this.walkAllDocuments()
    // True full rebuild: wipe every document/chunk/fts/embedding row
    // before reinserting from the current folder walk. A plain
    // upsert-per-current-id pass never removes ids that no longer appear
    // on disk (a deleted source file, or a stale id left behind by a
    // superseded document at the same path), so it leaves orphaned rows
    // behind. Wiping first makes reindexAll() an actual repair tool
    // rather than something that only works after deleting index.db.
    this.index.wipeAllDocuments()
    const embed = (texts: string[]) => this.deps.embeddings.embed(this.deps.embeddingModel, texts)
    for (const { doc, kind } of docs) {
      await this.index.upsertDocument(doc, kind, embed)
    }
    this.docPaths = new Map(docs.map(({ doc }) => [doc.meta.id, doc.path]))
    this.docIdByPath = new Map(docs.map(({ doc }) => [doc.path, doc.meta.id]))
    await this.syncGraph()
  }

  // --- private helpers ---

  private async buildReflectionContext(): Promise<ReflectionContext> {
    // The constitution is passed through whole, never capped. Reflection
    // emits its constitution update as a complete replacement body, so a
    // model shown a truncated constitution and asked to produce the update
    // would rewrite only what it saw and delete the tail it never saw from
    // disk. capBody (in @openreverie/core) applies to assembleSystemPrompt
    // only and must never be applied here. See the test "the reflection
    // prompt carries the whole constitution body, sentinel included".
    const constitutionDoc = await readDocument(this.paths.constitution)
    const arcs = [...this.graphState.nodes.values()].filter((node) => node.type === 'arc')
    const realms = [...this.graphState.nodes.values()].filter((node) => node.type === 'realm')
    const allPeople = [...this.graphState.nodes.values()].filter((node) => node.type === 'person')
    const allEntities = [...this.graphState.nodes.values()].filter((node) => node.type === 'entity')
    // Bounded and recency-ordered exactly like sessionContext's people and
    // entities above: reflection sees the same known-people and
    // known-entities lists the chat prompt does, not an unbounded one.
    const cappedPeople = capPeople(allPeople)
    const cappedEntities = capEntities(allEntities)
    const journalingProtocol = await readJournalingProtocolIfPresent(this.paths)
    // Every commitment, so reflection can reference an existing id in
    // commitmentRevisions instead of proposing a duplicate. Uncapped,
    // unlike people/entities above: a person accumulates far fewer open
    // commitments than named people or things over time, so there is no
    // truncation story to tell yet; revisit if that stops being true.
    const commitments = await readCommitments(this.paths)
    return {
      constitution: constitutionDoc.body,
      arcs,
      realms,
      people: cappedPeople.nodes,
      peopleTruncated: cappedPeople.truncated,
      entities: cappedEntities.nodes,
      entitiesTruncated: cappedEntities.truncated,
      commitments,
      profile: this.profileCache.meta,
      ...(journalingProtocol !== undefined ? { journalingProtocol } : {}),
    }
  }

  private async syncGraph(): Promise<void> {
    this.graphState = await readGraph(this.paths)
    this.index.replaceGraph(this.graphState)
  }

  private async reindexDocument(doc: Document, kind: DocKind): Promise<void> {
    // Ruling 2: this call is always the authoritative write for whatever
    // document currently lives at doc.path, so any other row still
    // sitting at that path is stale (e.g. a superseded doc id from a
    // previous summary.md rewrite) and self-heals here before indexing
    // the current one.
    this.index.removeDocumentsAtPath(doc.path, doc.meta.id)
    const embed = (texts: string[]) => this.deps.embeddings.embed(this.deps.embeddingModel, texts)
    await this.index.upsertDocument(doc, kind, embed)
    this.docPaths.set(doc.meta.id, doc.path)
    this.docIdByPath.set(doc.path, doc.meta.id)
  }

  // Ruling 4: reindex failures inside endSession/runMaintenance must not
  // throw out of those methods. The document behind `doc` is already
  // durably written to disk by the time this runs; a failure here only
  // means it is missing from search until someone runs reindexAll(). It
  // is not automatically retried, so the failure is recorded as a
  // warning instead of being silently dropped or left to crash the
  // caller.
  private async reindexOrWarn(doc: Document, kind: DocKind, description: string): Promise<void> {
    try {
      await this.reindexDocument(doc, kind)
    } catch (err) {
      this.warnings.push(
        `Failed to index ${description} (${doc.path}): ${errorMessage(err)}. ` +
          'Content is durably written but missing from search until reindexAll() runs; it is not automatically retried.',
      )
    }
  }

  // A session with no user line at all (an abandoned session that only
  // ever got as far as the proactive greeting) is not worth a reflection
  // call. It still needs a summary.md: that file's presence is what
  // SessionStore.listSessions() reads as "reflected", so without one this
  // session would be retried by every future runMaintenance() call
  // forever. SessionStore.listSessions() also reads this summary's own
  // `skipped: true` back out, which is what lets every downstream
  // consumer (recentSummaries, isFirstSession, the daily/weekly rollup
  // date lists) tell this session apart from a real reflection.
  //
  // Deliberately never indexed: unlike every other summary.md, this one
  // is not passed to reindexOrWarn. Its body is a fixed placeholder
  // sentence with no content of the person's own in it, so there is
  // nothing here worth retrieving through search_memory, and indexing it
  // would only let a search surface a session where nothing happened.
  // walkAllDocuments (used by both reindexAll and the docId cache) skips
  // any summary carrying skipped: true for the same reason, so a full
  // index rebuild never reintroduces it either.
  private async writeSkippedSummary(sessionId: string, now: Date): Promise<void> {
    const sessions = await SessionStore.listSessions(this.paths)
    const session = sessions.find((s) => s.sessionId === sessionId)
    const date = session?.date ?? formatLocalDate(now, this.timezone())
    // Resolved by id suffix, never rebuilt from the date. A derived date
    // that differs from the directory prefix would otherwise create a
    // second directory beside the real one, holding a summary for a session
    // whose transcript lives elsewhere, which makes that session look
    // permanently unreflected and get retried forever.
    const dir = await SessionStore.sessionDir(this.paths, sessionId)
    const summaryPath = join(dir, 'summary.md')

    await writeDocumentAtomic({
      path: summaryPath,
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: sessionId,
        date,
        skipped: true,
        reason: 'no user messages in this session',
        items: [],
      },
      body: 'This session had no user messages, so there was nothing to reflect on.\n',
    })

    const commitResult = await commitMemory(
      this.paths.root,
      `reflect: session ${sessionId} skipped, no user messages`,
    )
    if (!commitResult.ok && commitResult.warning) {
      this.warnings.push(commitResult.warning)
    }
  }

  // forget is only ever allowed to rewrite prose that is not a transcript
  // or a session summary: the constitution, an arc, a realm, or a person
  // page. Anything else is a programming error in the caller, not a case
  // to degrade quietly.
  private kindForDocumentPath(path: string): DocKind {
    if (path === this.paths.constitution) return 'constitution'
    if (path.startsWith(this.paths.realmsDir)) return 'realm'
    if (path.startsWith(this.paths.arcsDir)) return 'arc'
    if (path.startsWith(this.paths.peopleDir)) return 'person'
    throw new Error(`forget: ${path} is not a document kind forget is allowed to rewrite`)
  }

  private clearWarnings(): void {
    this.warnings.length = 0
  }

  private async refreshDocPaths(): Promise<void> {
    const docs = await this.walkAllDocuments()
    this.docPaths = new Map(docs.map(({ doc }) => [doc.meta.id, doc.path]))
    this.docIdByPath = new Map(docs.map(({ doc }) => [doc.path, doc.meta.id]))
  }

  private async kindForPublicDocument(path: string): Promise<DocKind | null> {
    const docs = await this.walkAllDocuments()
    return docs.find(({ doc }) => doc.path === path)?.kind ?? null
  }

  private async walkAllDocuments(): Promise<{ doc: Document; kind: DocKind }[]> {
    const result: { doc: Document; kind: DocKind }[] = []
    result.push({ doc: await readDocument(this.paths.constitution), kind: 'constitution' })
    for (const doc of await listDocuments(this.paths.realmsDir, this.onDocSkip)) {
      result.push({ doc, kind: 'realm' })
    }
    for (const doc of await listDocuments(this.paths.arcsDir, this.onDocSkip)) {
      result.push({ doc, kind: 'arc' })
    }
    for (const doc of await listDocuments(this.paths.peopleDir, this.onDocSkip)) {
      result.push({ doc, kind: 'person' })
    }
    for (const doc of await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip)) {
      result.push({ doc, kind: 'rollup_daily' })
    }
    for (const doc of await listDocuments(this.paths.rollupsWeeklyDir, this.onDocSkip)) {
      result.push({ doc, kind: 'rollup_weekly' })
    }
    for (const doc of await listDocuments(this.paths.journalDir, this.onDocSkip)) {
      result.push({ doc, kind: 'journal' })
    }
    try {
      result.push({ doc: await readDocument(this.paths.journaling), kind: 'journaling' })
    } catch {
      // journaling.md does not exist yet: nobody has journaled in this
      // memory folder. Not an error, just nothing to index.
    }

    let sessionEntries: string[] = []
    try {
      const entries = await readdir(this.paths.sessionsDir, { withFileTypes: true })
      sessionEntries = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      sessionEntries = []
    }
    for (const name of sessionEntries) {
      const summaryPath = join(this.paths.sessionsDir, name, 'summary.md')
      try {
        const doc = await readDocument(summaryPath)
        // A skipped summary is never indexed, on the initial write path
        // (writeSkippedSummary) or here on a full rebuild: its body is a
        // fixed placeholder with nothing of the person's own in it.
        if (doc.meta.skipped === true) continue
        result.push({ doc, kind: 'summary' })
      } catch {
        // No summary.md yet: session is not reflected. Nothing to index.
      }
    }

    return result
  }

  private async materializeProposal(proposal: Proposal): Promise<void> {
    if (proposal.kind === 'new_arc') {
      const payload = proposal.payload as { name: string; realm: string; itemIds: string[] }
      await this.createArc({
        name: payload.name,
        realm: payload.realm,
        itemIds: payload.itemIds,
        narrative: '',
        source: proposal.source,
        // The user explicitly accepted this proposal, so every edge it
        // creates is confirmed, unlike the direct materialization path in
        // _doEndSession where nothing was ever put in front of anyone.
        confirmed: true,
      })
      return
    }

    if (proposal.kind === 'new_person') {
      const payload = proposal.payload as { name: string; itemIds: string[] }
      await this.createPersonPage({
        name: payload.name,
        itemIds: payload.itemIds,
        narrative: '',
        source: proposal.source,
        confirmed: true,
      })
      return
    }

    // proposal.kind === 'link'
    const now = new Date()
    const payload = proposal.payload as {
      edge: EdgeType
      from: string
      to: string
      confidence: number
    }
    await appendGraph(this.paths, [
      {
        ts: now.toISOString(),
        op: 'assert',
        edge: payload.edge,
        from: payload.from,
        to: payload.to,
        confidence: payload.confidence,
        confirmed: true,
        source: proposal.source,
      },
    ])
    await this.syncGraph()
  }

  // Creates a new arc document and node, in a realm resolved or created via
  // resolveOrCreateRealm, and confirms part_of edges for every item passed
  // in. Shared by materializeProposal's new_arc branch (proposals accepted
  // from an older memory folder) and _doEndSession's direct materialization
  // of reflection's newArcs: one implementation, two call sites, so there
  // is exactly one place that writes an arc document.
  private async createArc(input: {
    name: string
    realm: string
    itemIds: string[]
    narrative: string
    source: string
    // Whether the user explicitly affirmed this arc, not whether it is
    // "approved": true for an accepted proposal, false for reflection's
    // direct materialization, which nobody has seen yet.
    confirmed: boolean
  }): Promise<GraphNode> {
    const now = new Date()
    const nowIso = now.toISOString()
    const realmNodeId = await this.resolveOrCreateRealm(input.realm, nowIso)

    const arcNodeId = newId('arc')
    const slug = await uniqueSlug(this.paths.arcsDir, input.name)
    const arcPath = join(this.paths.arcsDir, `${slug}.md`)
    const narrative = input.narrative.trim()
    const arcDoc: Document = {
      path: arcPath,
      meta: {
        id: newId('doc'),
        name: input.name,
        status: 'active',
        realm: realmNodeId,
        opened: nowIso,
      },
      body: narrative.length > 0 ? input.narrative : ARC_STARTER_BODY,
    }
    await writeDocumentAtomic(arcDoc)

    // Node assert and every part_of edge for this arc's items go in one
    // appendGraph call: a failure partway through would otherwise leave an
    // arc node and page on disk with no edges connecting its items to it.
    const records: GraphRecord[] = [
      { ts: nowIso, op: 'assert', node: arcNodeId, type: 'arc', label: input.name, doc: arcPath },
      {
        ts: nowIso,
        op: 'assert',
        edge: 'in',
        from: arcNodeId,
        to: realmNodeId,
        confidence: 1,
        confirmed: input.confirmed,
        source: input.source,
      },
    ]
    for (const itemId of input.itemIds) {
      records.push({
        ts: nowIso,
        op: 'assert',
        edge: 'part_of',
        from: itemId,
        to: arcNodeId,
        confidence: 1,
        confirmed: input.confirmed,
        source: input.source,
      })
    }
    await appendGraph(this.paths, records)
    await this.syncGraph()
    await this.reindexOrWarn(await readDocument(arcPath), 'arc', `arc page for ${input.name}`)
    const node = this.graphState.nodes.get(arcNodeId)
    if (!node) {
      throw new Error(`createArc: arc node ${arcNodeId} missing from graph state after assert.`)
    }
    return node
  }

  // Writes a person's page and asserts their node (minting a fresh one, or
  // reusing an already-known node's id when promoting it), with its doc
  // pointer set to the page path, together with confirmed involves edges
  // for every item passed in. Shared by createPersonPage (a brand-new
  // person who earns a page immediately), promoteToPage (an existing
  // node-only person who earns one later), and materializeProposal's
  // new_person branch (proposals accepted from an older memory folder):
  // one implementation, three call sites, so there is exactly one place
  // that writes a person page.
  private async writePersonPage(input: {
    personNodeId: string
    name: string
    itemIds: string[]
    narrative: string
    source: string
    // Same meaning as createArc's confirmed: true for an accepted
    // proposal, false for reflection's direct materialization.
    confirmed: boolean
  }): Promise<GraphNode> {
    const now = new Date()
    const nowIso = now.toISOString()

    const slug = await uniqueSlug(this.paths.peopleDir, input.name)
    const personPath = join(this.paths.peopleDir, `${slug}.md`)
    const narrative = input.narrative.trim()
    const personDoc: Document = {
      path: personPath,
      meta: { id: newId('doc'), name: input.name, node: input.personNodeId, opened: nowIso },
      body: narrative.length > 0 ? input.narrative : PERSON_STARTER_BODY,
    }
    await writeDocumentAtomic(personDoc)

    // Node assert and every involves edge for this person's items go in one
    // appendGraph call: a failure partway through would otherwise leave a
    // person node and page on disk with no edges connecting its items to it.
    // Re-asserting the node here (even when personNodeId already existed,
    // as it does for a promotion) is what attaches the doc pointer: the
    // fold in graph.ts takes the later record, so this record is what turns
    // a node-only person into a paged one.
    const records: GraphRecord[] = [
      {
        ts: nowIso,
        op: 'assert',
        node: input.personNodeId,
        type: 'person',
        label: input.name,
        doc: personPath,
      },
    ]
    for (const itemId of input.itemIds) {
      records.push({
        ts: nowIso,
        op: 'assert',
        edge: 'involves',
        from: itemId,
        to: input.personNodeId,
        confidence: 1,
        confirmed: input.confirmed,
        source: input.source,
      })
    }
    await appendGraph(this.paths, records)
    await this.syncGraph()
    await this.reindexOrWarn(personDoc, 'person', `person page for ${input.name}`)
    const node = this.graphState.nodes.get(input.personNodeId)
    if (!node) {
      throw new Error(
        `writePersonPage: person node ${input.personNodeId} missing from graph state after assert.`,
      )
    }
    return node
  }

  // A brand-new person who earns a page on first mention already: mints a
  // fresh node id and defers to writePersonPage.
  private async createPersonPage(input: {
    name: string
    itemIds: string[]
    narrative: string
    source: string
    confirmed: boolean
  }): Promise<GraphNode> {
    return this.writePersonPage({ personNodeId: newId('person'), ...input })
  }

  // Grants a page to a person already known as a node with no page. Reuses
  // their existing node id rather than minting a new one, so their id and
  // any edges already pointing at them stay valid; writePersonPage's
  // re-assert of that same id is what attaches the doc pointer.
  private async promoteToPage(input: {
    nodeId: string
    itemIds: string[]
    narrative: string
    source: string
    confirmed: boolean
  }): Promise<GraphNode> {
    const existing = this.graphState.nodes.get(input.nodeId)
    if (!existing) {
      throw new Error(`promoteToPage: no node ${input.nodeId} in graph state.`)
    }
    return this.writePersonPage({
      personNodeId: input.nodeId,
      name: existing.label,
      itemIds: input.itemIds,
      narrative: input.narrative,
      source: input.source,
      confirmed: input.confirmed,
    })
  }

  // Creates a person or entity node with no page at all: no document is
  // written, so there is nothing to reindex. Node assert and every edge
  // for this node's items go in one appendGraph call, matching createArc
  // and writePersonPage. Shared by both node types (a person captured
  // node-only, and every entity, which never gets a page in this release)
  // so there is exactly one place that creates a page-less node.
  private async createNode(input: {
    name: string
    type: 'person' | 'entity'
    itemIds: string[]
    source: string
    confirmed: boolean
  }): Promise<GraphNode> {
    const now = new Date()
    const nowIso = now.toISOString()
    const nodeId = newId(input.type)
    const edgeType: EdgeType = input.type === 'person' ? 'involves' : 'relates_to'

    const records: GraphRecord[] = [
      { ts: nowIso, op: 'assert', node: nodeId, type: input.type, label: input.name },
    ]
    for (const itemId of input.itemIds) {
      records.push({
        ts: nowIso,
        op: 'assert',
        edge: edgeType,
        from: itemId,
        to: nodeId,
        confidence: 1,
        confirmed: input.confirmed,
        source: input.source,
      })
    }
    await appendGraph(this.paths, records)
    await this.syncGraph()
    const node = this.graphState.nodes.get(nodeId)
    if (!node) {
      throw new Error(`createNode: node ${nodeId} missing from graph state after assert.`)
    }
    return node
  }

  // Adds involves or relates_to edges from this session's items to a node
  // that already exists (a person or entity mentioned again, resolved by
  // label before a new node would otherwise have been minted for them). No
  // node assert here: the node is already durably in the graph. A no-op
  // when there is nothing to attach.
  private async attachItemsToNode(
    nodeId: string,
    type: 'person' | 'entity',
    itemIds: string[],
    source: string,
    confirmed: boolean,
  ): Promise<void> {
    if (itemIds.length === 0) {
      return
    }
    const edgeType: EdgeType = type === 'person' ? 'involves' : 'relates_to'
    const nowIso = new Date().toISOString()
    const records: GraphRecord[] = itemIds.map((itemId) => ({
      ts: nowIso,
      op: 'assert',
      edge: edgeType,
      from: itemId,
      to: nodeId,
      confidence: 1,
      confirmed,
      source,
    }))
    await appendGraph(this.paths, records)
    await this.syncGraph()
  }

  // Resolves an existing person or entity node by case-insensitive label,
  // the same pattern resolveOrCreateRealm already uses for realms. Used to
  // stop a model that (despite being told not to) relists an already-known
  // name in newPersons or newEntities from minting a duplicate node for the
  // same person or thing.
  private findNodeByLabel(type: 'person' | 'entity', name: string): GraphNode | undefined {
    return [...this.graphState.nodes.values()].find(
      (node) => node.type === type && node.label.toLowerCase() === name.toLowerCase(),
    )
  }

  // Resolves a new_arc proposal's `realm` field to a realm node id. It
  // matches an existing realm by node id first (the common case: the
  // reflection prompt lists realms as "id: label", so the model usually
  // echoes the id back), then by case-insensitive label (the model named
  // an existing realm instead of quoting its id), and only creates a new
  // realm document and node when neither matches.
  private async resolveOrCreateRealm(realm: string, nowIso: string): Promise<string> {
    const byId = this.graphState.nodes.get(realm)
    if (byId?.type === 'realm') {
      return byId.id
    }
    const byLabel = [...this.graphState.nodes.values()].find(
      (node) => node.type === 'realm' && node.label.toLowerCase() === realm.toLowerCase(),
    )
    if (byLabel) {
      return byLabel.id
    }

    const realmNodeId = newId('realm')
    const slug = await uniqueSlug(this.paths.realmsDir, realm)
    const realmPath = join(this.paths.realmsDir, `${slug}.md`)
    const realmDoc: Document = {
      path: realmPath,
      meta: { id: newId('doc'), name: realm },
      body: REALM_STARTER_BODY,
    }
    await writeDocumentAtomic(realmDoc)
    await appendGraph(this.paths, [
      { ts: nowIso, op: 'assert', node: realmNodeId, type: 'realm', label: realm, doc: realmPath },
    ])
    await this.syncGraph()
    // reindexOrWarn, not reindexDocument: this runs inside createArc, which
    // runs inside both materializeProposal and reflection's direct
    // materialization, neither of which may let an indexing failure throw
    // out and abort an otherwise-successful arc creation.
    await this.reindexOrWarn(realmDoc, 'realm', `realm page for ${realm}`)
    return realmNodeId
  }
}

function isDegraded(
  result: ReflectionOutput | { summary: string; degraded: true },
): result is { summary: string; degraded: true } {
  return 'degraded' in result && result.degraded === true
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function publicDocumentRow(doc: Document, kind: DocKind): PublicDocumentRow {
  const base: PublicDocumentRow = {
    docId: doc.meta.id,
    kind,
    title: documentTitle(doc),
    updatedAt: documentUpdatedAt(doc),
    readOnly: true,
  }
  if (kind !== 'journal') return base
  const excerpt = documentExcerpt(doc)
  return {
    ...base,
    ...(typeof doc.meta.method === 'string' ? { method: doc.meta.method } : {}),
    ...(typeof doc.meta.entryDate === 'string' ? { entryDate: doc.meta.entryDate } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(typeof doc.meta.recordedAt === 'string' ? { recordedAt: doc.meta.recordedAt } : {}),
  }
}

const EXCERPT_MAX_CHARS = 140

// The first non-empty line of the body, trimmed and capped. Deliberately
// simple: a journal entry's first line is usually the person's actual
// opening sentence, and this is a list-row hint, not a summary.
function documentExcerpt(doc: Document): string | undefined {
  const firstLine = doc.body
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()
  if (!firstLine) return undefined
  return firstLine.length > EXCERPT_MAX_CHARS
    ? `${firstLine.slice(0, EXCERPT_MAX_CHARS)}…`
    : firstLine
}

function documentTitle(doc: Document): string {
  if (typeof doc.meta.name === 'string' && doc.meta.name.length > 0) return doc.meta.name
  if (typeof doc.meta.title === 'string') return doc.meta.title
  return doc.meta.id
}

function documentUpdatedAt(doc: Document): string {
  for (const key of ['updated', 'date', 'week', 'recordedAt']) {
    const value = doc.meta[key]
    if (typeof value === 'string') return value
  }
  return isoFromId(doc.meta.id, '1970-01-01T00:00:00.000Z')
}

function comparePublicDocuments(a: PublicDocumentRow, b: PublicDocumentRow): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.title !== b.title) return a.title < b.title ? -1 : 1
  if (a.docId === b.docId) return 0
  return a.docId < b.docId ? -1 : 1
}

function isoFromId(id: string, fallback: string): string {
  const separator = id.indexOf('_')
  if (separator < 0) return fallback
  try {
    return new Date(
      decodeTime(id.slice(separator + 1) as Parameters<typeof decodeTime>[0]),
    ).toISOString()
  } catch {
    return fallback
  }
}

function byTsDescending(a: GraphNode, b: GraphNode): number {
  if (a.ts === b.ts) return 0
  return a.ts > b.ts ? -1 : 1
}

// Orders active arcs for the prompt: most recently touched first, and arcs
// whose page could not be read (no lastTouched) sort last, ordered among
// themselves by node ts descending. Without that rule the ARCS_CAP cut
// would drop a nondeterministic arc, since the undated group's order would
// otherwise depend on graph.jsonl's insertion order.
function compareArcs(
  a: { lastTouched?: string; ts: string; id: string },
  b: { lastTouched?: string; ts: string; id: string },
): number {
  if (a.lastTouched !== undefined && b.lastTouched !== undefined) {
    if (a.lastTouched !== b.lastTouched) return a.lastTouched > b.lastTouched ? -1 : 1
  } else if (a.lastTouched !== undefined) {
    return -1
  } else if (b.lastTouched !== undefined) {
    return 1
  }
  if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

const LISTING_DEFAULT_LIMIT = 50
const LISTING_MAX_LIMIT = 200

// Slices one page out of an already-ordered row list and reports the true
// total alongside it. offset and limit come from the model, so both are
// clamped rather than trusted: a negative or non-numeric offset reads as 0,
// and a missing or oversized limit reads as the default or the maximum.
function pageRows<Row>(rows: Row[], offset?: number, limit?: number): ListingEnvelope<Row> {
  const safeOffset =
    offset !== undefined && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  const requested =
    limit !== undefined && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : LISTING_DEFAULT_LIMIT
  const safeLimit = Math.min(requested, LISTING_MAX_LIMIT)
  const page = rows.slice(safeOffset, safeOffset + safeLimit)
  return {
    total: rows.length,
    offset: safeOffset,
    limit: safeLimit,
    returned: page.length,
    hasMore: safeOffset + page.length < rows.length,
    rows: page,
  }
}

// A total order for listing tools: most recently asserted first, ties broken
// by node id descending. capPeople's paged-first rule is deliberately not
// reused here. That rule decides who survives truncation in a fixed-size
// prompt list; a paging tool truncates nothing, so what it needs instead is
// an order that is identical across calls and across index rebuilds, which
// is what the id tiebreak provides.
function compareNodesForListing(a: GraphNode, b: GraphNode): number {
  if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

// Orders person nodes most-recently-created first. Under PEOPLE_CAP,
// nothing is dropped, so the result is a plain recency order with no
// paged/unpaged distinction. Over the cap, which people survive is
// decided paged-first (a page means the subject already earned a
// maintained document, which matters more than an unpaged node's raw
// recency), but the survivors are still returned in recency order, not
// grouped by page status: the paged-over-unpaged rule only decides who
// gets truncated away, never the rendered order of who is left. Shared by
// sessionContext (the chat prompt) and buildReflectionContext (the
// reflection prompt), so both are bounded the same way.
function capPeople(nodes: GraphNode[]): { nodes: GraphNode[]; truncated: boolean } {
  if (nodes.length <= PEOPLE_CAP) {
    return { nodes: [...nodes].sort(byTsDescending), truncated: false }
  }
  const paged = nodes.filter((node) => node.doc !== undefined).sort(byTsDescending)
  const unpaged = nodes.filter((node) => node.doc === undefined).sort(byTsDescending)
  const survivors = [...paged, ...unpaged].slice(0, PEOPLE_CAP)
  return { nodes: survivors.sort(byTsDescending), truncated: true }
}

// Orders entity nodes most-recently-created first, then applies
// ENTITIES_CAP. Entities never get a page in this release, so there is no
// paged/unpaged priority to apply here, unlike capPeople above.
function capEntities(nodes: GraphNode[]): { nodes: GraphNode[]; truncated: boolean } {
  const ordered = [...nodes].sort(byTsDescending)
  return { nodes: ordered.slice(0, ENTITIES_CAP), truncated: ordered.length > ENTITIES_CAP }
}

function stringMeta(docs: Document[], key: string): string[] {
  const values: string[] = []
  for (const doc of docs) {
    const value = doc.meta[key]
    if (typeof value === 'string') values.push(value)
  }
  return values
}

function kebabCase(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'untitled'
}

async function uniqueSlug(dir: string, name: string): Promise<string> {
  const base = kebabCase(name)
  let existing: Set<string>
  try {
    existing = new Set((await readdir(dir)).map((f) => f.replace(/\.md$/, '')))
  } catch {
    existing = new Set()
  }
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) {
    n += 1
  }
  return `${base}-${n}`
}
