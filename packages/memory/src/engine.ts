// The MemoryEngine facade: the single surface every higher layer (core,
// then cli) builds on. It wires together the prose store, the graph log,
// the SQLite index, reflection, rollups, and git versioning into one
// object with session lifecycle, retrieval, and maintenance methods.
//
// Two pieces of state are cached in memory for cheap synchronous reads:
// the folded graph (`graphState`, source of truth is graph.jsonl) and a
// document id to path map (`docPaths`, source of truth is the folder
// itself, since MemoryIndex exposes no lookup by document id). Both are
// rebuilt from disk on open() and reindexAll(), and kept in sync after
// every write that touches the graph or adds a document, so a lost or
// deleted index.db never loses information, only the SQL projection of it.

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
  yesterdaySummaries: { sessionId: string; body: string }[]
  pendingProposals: Proposal[]
}

export type GraphQuery =
  | { kind: 'neighbors'; nodeId: string }
  | { kind: 'items_in_arc'; arcId: string }
  | { kind: 'arcs_involving_person'; personId: string }

const REALM_STARTER_BODY = 'This realm is new. It grows as we talk.\n'
const ARC_STARTER_BODY = 'This arc is new. It grows as we talk.\n'

export class MemoryEngine {
  private readonly paths: MemoryPaths
  private readonly deps: EngineDeps
  private readonly index: MemoryIndex
  private graphState: GraphState
  private docPaths = new Map<string, string>()
  private readonly liveItems = new Map<string, ReflectionItem[]>()
  readonly warnings: string[] = []

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
    await engine.refreshDocPaths()
    await engine.runMaintenance()
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
    this.clearWarnings()

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

    const now = new Date()
    const transcript = await SessionStore.readTranscript(this.paths, sessionId)
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
          arcNarratives: [],
          constitutionUpdate: null,
        }
      : raw

    const liveItems = this.liveItems.get(sessionId) ?? []
    const result = await applyReflection(this.paths, out, sessionId, liveItems, now)
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
    for (const narrative of out.arcNarratives) {
      const arcNode = this.graphState.nodes.get(narrative.arcId)
      if (arcNode?.type === 'arc' && arcNode.doc) {
        await this.reindexOrWarn(
          await readDocument(arcNode.doc),
          'arc',
          `session ${sessionId} arc narrative for ${narrative.arcId}`,
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
    for (const doc of await listDocuments(this.paths.rollupsDailyDir)) {
      if (typeof doc.meta.date !== 'string') continue
      if (!latestDailyRollup || doc.meta.date > latestDailyRollup.date) {
        latestDailyRollup = { date: doc.meta.date, body: doc.body }
      }
    }

    const yesterday = addDaysUTC(now, -1)
    const sessions = await SessionStore.listSessions(this.paths)
    const yesterdaySummaries: SessionContext['yesterdaySummaries'] = []
    for (const session of sessions) {
      if (session.date !== yesterday || !session.reflected) continue
      const summaryPath = join(
        this.paths.sessionsDir,
        `${session.date}-${session.sessionId}`,
        'summary.md',
      )
      const doc = await readDocument(summaryPath)
      yesterdaySummaries.push({ sessionId: session.sessionId, body: doc.body })
    }

    const proposals = await pendingProposals(this.paths)

    return {
      constitution: constitutionDoc.body,
      realms,
      arcs,
      ...(latestDailyRollup ? { latestDailyRollup } : {}),
      yesterdaySummaries,
      pendingProposals: proposals,
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
    if (query.kind === 'neighbors') return this.index.neighbors(query.nodeId)
    if (query.kind === 'items_in_arc') return this.index.itemsInArc(query.arcId)
    return this.index.arcsInvolvingPerson(query.personId)
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

  async runMaintenance(now: Date = new Date()): Promise<void> {
    this.clearWarnings()

    // Reflect stale sessions first: pendingDailyRollups only looks at
    // whether a date has sessions, not whether they are reflected, and
    // buildDailyRollup throws for a date with no reflected session.
    const sessions = await SessionStore.listSessions(this.paths)
    for (const session of sessions) {
      if (session.reflected) continue
      try {
        await this.endSession(session.sessionId)
      } catch {
        // reflectSession/applyReflection failed before summary.md was
        // written (endSession's own reindex and commit steps no longer
        // throw; see reindexOrWarn below), so the session stays
        // unreflected in its frontmatter and is retried on the next pass.
        // The transcript itself is never at risk.
      }
    }

    const today = formatDateUTC(now)

    const reflected = (await SessionStore.listSessions(this.paths)).filter((s) => s.reflected)
    const sessionDates = reflected.map((s) => s.date)
    const existingDailies = stringMeta(await listDocuments(this.paths.rollupsDailyDir), 'date')

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

    const dailyDates = stringMeta(await listDocuments(this.paths.rollupsDailyDir), 'date')
    const existingWeeklies = stringMeta(await listDocuments(this.paths.rollupsWeeklyDir), 'week')

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
    await this.syncGraph()
  }

  // --- private helpers ---

  private async buildReflectionContext(): Promise<ReflectionContext> {
    const constitutionDoc = await readDocument(this.paths.constitution)
    const arcs = [...this.graphState.nodes.values()].filter((node) => node.type === 'arc')
    const realms = [...this.graphState.nodes.values()].filter((node) => node.type === 'realm')
    return { constitution: constitutionDoc.body, arcs, realms }
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

  private clearWarnings(): void {
    this.warnings.length = 0
  }

  private async refreshDocPaths(): Promise<void> {
    const docs = await this.walkAllDocuments()
    this.docPaths = new Map(docs.map(({ doc }) => [doc.meta.id, doc.path]))
  }

  private async walkAllDocuments(): Promise<{ doc: Document; kind: DocKind }[]> {
    const result: { doc: Document; kind: DocKind }[] = []
    result.push({ doc: await readDocument(this.paths.constitution), kind: 'constitution' })
    for (const doc of await listDocuments(this.paths.realmsDir)) result.push({ doc, kind: 'realm' })
    for (const doc of await listDocuments(this.paths.arcsDir)) result.push({ doc, kind: 'arc' })
    for (const doc of await listDocuments(this.paths.rollupsDailyDir)) {
      result.push({ doc, kind: 'rollup_daily' })
    }
    for (const doc of await listDocuments(this.paths.rollupsWeeklyDir)) {
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
        result.push({ doc: await readDocument(summaryPath), kind: 'summary' })
      } catch {
        // No summary.md yet: session is not reflected. Nothing to index.
      }
    }

    return result
  }

  private async materializeProposal(proposal: Proposal): Promise<void> {
    const now = new Date()
    const nowIso = now.toISOString()

    if (proposal.kind === 'new_arc') {
      const payload = proposal.payload as { name: string; realm: string; itemIds: string[] }
      const realmNodeId = await this.resolveOrCreateRealm(payload.realm, nowIso)

      const arcNodeId = newId('arc')
      const slug = await uniqueSlug(this.paths.arcsDir, payload.name)
      const arcPath = join(this.paths.arcsDir, `${slug}.md`)
      const arcDoc: Document = {
        path: arcPath,
        meta: {
          id: newId('doc'),
          name: payload.name,
          status: 'active',
          realm: realmNodeId,
          opened: nowIso,
        },
        body: ARC_STARTER_BODY,
      }
      await writeDocumentAtomic(arcDoc)

      const records: GraphRecord[] = [
        {
          ts: nowIso,
          op: 'assert',
          node: arcNodeId,
          type: 'arc',
          label: payload.name,
          doc: arcPath,
        },
        {
          ts: nowIso,
          op: 'assert',
          edge: 'in',
          from: arcNodeId,
          to: realmNodeId,
          confidence: 1,
          confirmed: true,
          source: proposal.source,
        },
      ]
      for (const itemId of payload.itemIds) {
        records.push({
          ts: nowIso,
          op: 'assert',
          edge: 'part_of',
          from: itemId,
          to: arcNodeId,
          confidence: 1,
          confirmed: true,
          source: proposal.source,
        })
      }
      await appendGraph(this.paths, records)
      await this.syncGraph()
      await this.reindexDocument(await readDocument(arcPath), 'arc')
      return
    }

    if (proposal.kind === 'new_person') {
      const payload = proposal.payload as { name: string; itemIds: string[] }
      const personNodeId = newId('person')
      const records: GraphRecord[] = [
        { ts: nowIso, op: 'assert', node: personNodeId, type: 'person', label: payload.name },
      ]
      for (const itemId of payload.itemIds) {
        records.push({
          ts: nowIso,
          op: 'assert',
          edge: 'involves',
          from: itemId,
          to: personNodeId,
          confidence: 1,
          confirmed: true,
          source: proposal.source,
        })
      }
      await appendGraph(this.paths, records)
      await this.syncGraph()
      return
    }

    // proposal.kind === 'link'
    const payload = proposal.payload as {
      edge: EdgeType
      from: string
      to: string
      confidence: number
    }
    await appendGraph(this.paths, [
      {
        ts: nowIso,
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
    await this.reindexDocument(realmDoc, 'realm')
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
