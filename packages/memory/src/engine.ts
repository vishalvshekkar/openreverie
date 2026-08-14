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
  readGraph,
} from './graph.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
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
import { SessionStore, type TranscriptLine } from './transcripts.js'

export interface EngineDeps {
  chat: ChatProvider
  embeddings: EmbeddingProvider
  reflectionModel: string
  embeddingModel: string
}

export interface SessionContext {
  constitution: string
  realms: { id: string; name: string; firstLine: string }[]
  arcs: { id: string; name: string; status: string; lastTouched?: string }[]
  latestDailyRollup?: { date: string; body: string }
  recentSummaries: { sessionId: string; date: string; body: string }[]
  pendingProposals: Proposal[]
  // Today's date, in the same YYYY-MM-DD form used for recent session
  // dates and the daily rollup date, built from the same clock passed to
  // sessionContext. The model is never told the current date any other
  // way, so this is the only anchor it has for reading an absolute date
  // like "2026-08-12" as recent or old.
  today: string
  // True when this memory has no reflected sessions and no arcs at all
  // (of any status), meaning the person has never actually talked with
  // reverie before. The session that was just started to hold the current
  // conversation is itself unreflected and must not count: sessionContext
  // is always called after startSession, so without this carve-out no
  // session would ever look like a first one.
  isFirstSession: boolean
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
const PERSON_STARTER_BODY = 'This page is new. It grows as we talk.\n'

export class MemoryEngine {
  private readonly paths: MemoryPaths
  private readonly deps: EngineDeps
  private readonly index: MemoryIndex
  private graphState: GraphState
  private docPaths = new Map<string, string>()
  private docIdByPath = new Map<string, string>()
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
  ) {
    this.paths = paths
    this.deps = deps
    this.index = index
    this.graphState = graphState
  }

  static async open(root: string, deps: EngineDeps): Promise<MemoryEngine> {
    const paths = memoryPaths(root)
    await ensureMemoryTree(paths)
    const index = MemoryIndex.open(paths.indexDb)
    const graphState = await readGraph(paths)
    index.replaceGraph(graphState)
    const engine = new MemoryEngine(paths, deps, index, graphState)
    engine.clearWarnings()
    // runMaintenance() before refreshDocPaths(): runMaintenance clears
    // warnings as its own first step, which would otherwise wipe out any
    // skipped-document warnings a doc walk during refreshDocPaths had just
    // recorded. Nothing in the maintenance path reads docPaths (only
    // reindexDocument writes it), and running the doc walk last also picks
    // up any rollups or session summaries maintenance itself just wrote.
    await engine.runMaintenance()
    await engine.refreshDocPaths()
    return engine
  }

  async close(): Promise<void> {
    this.index.close()
  }

  async startSession(now: Date = new Date()): Promise<string> {
    const store = await SessionStore.start(this.paths, now)
    this.liveItems.set(store.sessionId, [])
    return store.sessionId
  }

  async appendTranscript(sessionId: string, line: TranscriptLine): Promise<void> {
    const store = await SessionStore.open(this.paths, sessionId)
    await store.appendLine(line)
  }

  async remember(
    sessionId: string,
    text: string,
    kind: ReflectionItemKind = 'observation',
  ): Promise<void> {
    const item: ReflectionItem = { id: newId('item'), text, kind, ts: new Date().toISOString() }
    const items = this.liveItems.get(sessionId)
    if (items) {
      items.push(item)
    } else {
      this.liveItems.set(sessionId, [item])
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
          arcUpdates: [],
          personUpdates: [],
          constitutionUpdate: null,
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

    // Reflection no longer proposes new arcs or persons; it saves them
    // directly, using the itemIds applyReflection mints. This runs as a
    // callback INSIDE applyReflection's phase two, before the summary
    // write, not after applyReflection returns: summary.md's presence is
    // what marks a session reflected, so materialization must complete
    // before that write or a crash here would permanently mark the session
    // reflected while the arc or person it should have created never
    // materializes, with no retry path left. An entry whose itemIndexes
    // resolve to no items is dropped silently rather than materializing an
    // arc or person with nothing attached to it. Nothing here was
    // affirmed by the user, so confirmed is false on every edge, unlike
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
        if (itemIds.length === 0) {
          continue
        }
        await this.createPersonPage({
          name: person.name,
          itemIds,
          narrative: person.narrative,
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
    )
    this.liveItems.delete(sessionId)

    await this.syncGraph()
    await this.reindexOrWarn(result.summaryDoc, 'summary', `session ${sessionId} summary`)

    if (out.constitutionUpdate !== null) {
      await this.reindexOrWarn(
        await readDocument(this.paths.constitution),
        'constitution',
        `session ${sessionId} constitution update`,
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

    const commitResult = await commitMemory(this.paths.root, `reflect: session ${sessionId}`)
    if (!commitResult.ok && commitResult.warning) {
      this.warnings.push(commitResult.warning)
    }
  }

  async sessionContext(now: Date = new Date()): Promise<SessionContext> {
    const constitutionDoc = await readDocument(this.paths.constitution)

    const arcs: SessionContext['arcs'] = []
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
      arcs.push({ id: node.id, name: node.label, status, ...(lastTouched ? { lastTouched } : {}) })
    }

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

    let latestDailyRollup: { date: string; body: string } | undefined
    for (const doc of await listDocuments(this.paths.rollupsDailyDir, this.onDocSkip)) {
      if (typeof doc.meta.date !== 'string') continue
      if (!latestDailyRollup || doc.meta.date > latestDailyRollup.date) {
        latestDailyRollup = { date: doc.meta.date, body: doc.body }
      }
    }

    const sessions = await SessionStore.listSessions(this.paths)
    const recentCutoff = addDaysUTC(now, -RECENT_SUMMARIES_WINDOW_DAYS)
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
    for (const session of recentCandidates) {
      const summaryPath = join(
        this.paths.sessionsDir,
        `${session.date}-${session.sessionId}`,
        'summary.md',
      )
      const doc = await readDocument(summaryPath)
      recentSummaries.push({ sessionId: session.sessionId, date: session.date, body: doc.body })
    }

    const proposals = await pendingProposals(this.paths)

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

    return {
      constitution: constitutionDoc.body,
      realms,
      arcs,
      ...(latestDailyRollup ? { latestDailyRollup } : {}),
      recentSummaries,
      pendingProposals: proposals,
      today: formatDateUTC(now),
      isFirstSession,
    }
  }

  async search(query: string, filters?: SearchFilters, limit?: number): Promise<SearchHit[]> {
    return searchMemory(
      this.index,
      this.deps.embeddings,
      this.deps.embeddingModel,
      query,
      filters,
      limit,
    )
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

  async readTranscript(sessionId: string): Promise<TranscriptLine[]> {
    return SessionStore.readTranscript(this.paths, sessionId)
  }

  listArcs(): GraphNode[] {
    return [...this.graphState.nodes.values()].filter((node) => node.type === 'arc')
  }

  listRealms(): GraphNode[] {
    return [...this.graphState.nodes.values()].filter((node) => node.type === 'realm')
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

    const today = formatDateUTC(now)

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
    const constitutionDoc = await readDocument(this.paths.constitution)
    const arcs = [...this.graphState.nodes.values()].filter((node) => node.type === 'arc')
    const realms = [...this.graphState.nodes.values()].filter((node) => node.type === 'realm')
    const people = [...this.graphState.nodes.values()].filter((node) => node.type === 'person')
    return { constitution: constitutionDoc.body, arcs, realms, people }
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
    const date = session?.date ?? formatDateUTC(now)
    const dir = join(this.paths.sessionsDir, `${date}-${sessionId}`)
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

  // Writes a person's page and asserts their node, with its doc pointer set
  // to the page path, together with confirmed involves edges for every item
  // passed in. Shared by materializeProposal's new_person branch (proposals
  // accepted from an older memory folder) and _doEndSession's direct
  // materialization of reflection's newPersons: one implementation, two
  // call sites, so there is exactly one place that writes a person page.
  private async createPersonPage(input: {
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

    const personNodeId = newId('person')
    const slug = await uniqueSlug(this.paths.peopleDir, input.name)
    const personPath = join(this.paths.peopleDir, `${slug}.md`)
    const narrative = input.narrative.trim()
    const personDoc: Document = {
      path: personPath,
      meta: { id: newId('doc'), name: input.name, node: personNodeId, opened: nowIso },
      body: narrative.length > 0 ? input.narrative : PERSON_STARTER_BODY,
    }
    await writeDocumentAtomic(personDoc)

    // Node assert and every involves edge for this person's items go in one
    // appendGraph call: a failure partway through would otherwise leave a
    // person node and page on disk with no edges connecting its items to it.
    const records: GraphRecord[] = [
      {
        ts: nowIso,
        op: 'assert',
        node: personNodeId,
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
        to: personNodeId,
        confidence: 1,
        confirmed: input.confirmed,
        source: input.source,
      })
    }
    await appendGraph(this.paths, records)
    await this.syncGraph()
    await this.reindexOrWarn(personDoc, 'person', `person page for ${input.name}`)
    const node = this.graphState.nodes.get(personNodeId)
    if (!node) {
      throw new Error(
        `createPersonPage: person node ${personNodeId} missing from graph state after assert.`,
      )
    }
    return node
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

function stringMeta(docs: Document[], key: string): string[] {
  const values: string[] = []
  for (const doc of docs) {
    const value = doc.meta[key]
    if (typeof value === 'string') values.push(value)
  }
  return values
}

function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDaysUTC(date: Date, days: number): string {
  const shifted = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days),
  )
  return formatDateUTC(shifted)
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
