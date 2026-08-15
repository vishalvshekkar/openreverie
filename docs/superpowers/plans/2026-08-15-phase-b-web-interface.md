# Phase B v0.4.0 Web Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.4.0, a local authenticated web interface with provider-independent record browsing, safe streamed chat, and a usable first atlas, while preserving the terminal CLI and v0.3.1 memory compatibility.

**Architecture:** Add `@openreverie/server` as the Node 22 `node:http` composition root and `@openreverie/web` as a React 19/Vite browser client that speaks only `/api/v1`. Extend memory only with read projections that retain the folder and append-only graph log as truth. The server owns one `MemoryEngine` and a bounded live-session registry; the web package never imports a workspace runtime package.

**Tech Stack:** TypeScript strict mode, Node 22 `node:http`, Zod 4, React 19, Vite, plain CSS, Vitest, React Testing Library with jsdom, Graphology and Sigma inside `packages/web`, pnpm workspaces, Biome.

**Spec:** [docs/superpowers/specs/2026-08-15-phase-b-c-web-atlas-design.md](../specs/2026-08-15-phase-b-c-web-atlas-design.md)

## Global Constraints

- Node is `>=22`; the HTTP server uses only `node:http`, not Express, Fastify, a web framework, or a vendor SDK.
- The six-package dependency graph is `cli -> core -> memory -> providers`, `server -> core -> memory -> providers`, and `web -> HTTP API only`. `web` imports no Node, engine, memory, provider, or runtime workspace package.
- The server binds only `127.0.0.1`, uses the exact canonical host `127.0.0.1:<port>`, has no CORS support, and prints and optionally opens the same full bootstrap URL.
- Bootstrap tokens are 32 cryptographic random bytes, single-use, process-bound, expire five minutes after startup, and never appear in logs, errors, referrers, telemetry, or analytics. Successful bootstrap sets a process-bound `HttpOnly; SameSite=Strict; Path=/` cookie.
- All `/api/v1` routes except bootstrap require that cookie and exact canonical `Host`. State changes also require exact canonical `Origin`; GET and HEAD may omit Origin. Origin and Host never replace authentication.
- API responses use schema version `"1"`; ordinary success envelopes are `{ data, meta: { nextCursor } }`; errors are user-safe JSON with `schemaVersion`, `code`, and `message`. NDJSON is only `application/x-ndjson; charset=utf-8`.
- Enforce every specified bound: JSON body 256 KiB, message 64 KiB UTF-8, query 8 KiB, validated path identifier 256 characters, document 4 MiB, transcript page 4 MiB, proposal page 2 MiB, graph snapshot 8 MiB, graph events 8 MiB and 256 KiB each, NDJSON event 256 KiB, eight live sessions, one stream per session, 4096 turns, 256 replay events, 1 MiB replay bytes, and 30-minute idle expiry.
- Lists use versioned opaque base64url cursors with complete sort tuples. Invalid, wrong-kind, or stale cursors return `400 cursor_invalid`; pages contain only records strictly after the tuple and never contain partial JSON or partial records.
- Memory files remain truth. Markdown writes remain atomic, `graph.jsonl` and transcripts stay append-only, paths never enter public responses, and SQLite remains only a rebuildable index.
- v0.3.1 compatibility is mandatory: proposal endpoints expose and resolve only pending legacy queue entries; no new proposal generation returns. Graph nodes may omit `docId`; node-only people retain identity and promotion to a person page changes only their graph document pointer. Existing `SessionContext` fields and their people/entity/page-status semantics stay unchanged.
- Chat always goes through `AgentSession`, its personas, tools, transcript-first behavior, and both safety modes. HTTP handlers must not recreate the loop or change crisis behavior. With an unavailable provider, records remain readable and a send emits a safe `chat_unavailable` terminal event without inventing assistant text.
- No telemetry, analytics, remote logging, real personal data in fixtures, or `.reverie/` data in the repository. Never use an em dash in project prose, comments, messages, or tests.
- Phase B atlas is limited to deterministic seed layout, basic pan/zoom, type legend and filter, node selection, semantic parallel list, and document opening by optional `docId`. Do not add saved positions, realm influence, progressive labels, graph search, time lens, constellation layout, or graph/layout writes.
- Deterministic logic follows TDD: write a failing test, run it and observe the named failure, implement the smallest change, then rerun. Implementers run targeted tests while developing.

## Exact File Map

| Path | Change | Responsibility |
| --- | --- | --- |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json` | Modify | Register two packages, React test environment, build references, and v0.4.0 workspace version. |
| `packages/memory/src/graph.ts`, `graph.test.ts` | Modify | Expose validated append-order graph records with 1-based source sequence. |
| `packages/memory/src/transcripts.ts`, `transcripts.test.ts` | Modify | Expose provider-free session descriptors and bounded transcript page inputs. |
| `packages/memory/src/engine.ts`, `engine.test.ts`, `index.ts` | Modify | Public provider-free document, session, proposal, and graph read projections without leaking paths. |
| `packages/server/package.json`, `tsconfig.json`, `src/index.ts` | Create | Public server exports and package build boundary. |
| `packages/server/src/api.ts`, `api.test.ts` | Create | Zod public schemas, error/envelope writers, cursors, byte guards, canonical JSON and API types. |
| `packages/server/src/auth.ts`, `auth.test.ts` | Create | Launch token, process cookie, Host/Origin validation. |
| `packages/server/src/registry.ts`, `registry.test.ts` | Create | Live session, turn idempotency, replay, serialization, expiry, capacity lifecycle. |
| `packages/server/src/app.ts`, `app.test.ts` | Create | Native HTTP routing for auth, records, graph, sessions, NDJSON, static web assets. |
| `packages/server/src/launch.ts`, `launch.test.ts` | Create | Provider-optional composition, `MemoryEngine` lifecycle, origin output, bind and shutdown. |
| `packages/cli/src/index.ts`, `packages/cli/src/web.ts`, `web.test.ts` | Modify/Create | `reverie web` command while retaining setup, read, reindex, reflect, and terminal chat behavior. |
| `packages/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | Create | React 19/Vite package and local development/test setup. |
| `packages/web/src/api.ts`, `api.test.ts` | Create | Typed, credentialed API client and NDJSON reconnect parser. |
| `packages/web/src/session.ts`, `session.test.ts` | Create | UI session reducer, unique turn IDs, reconnect and transcript resync behavior. |
| `packages/web/src/atlas.ts`, `atlas.test.ts` | Create | Deterministic Graphology/Sigma projection, type filter, selection, semantic item data. |
| `packages/web/src/App.tsx`, `App.test.tsx`, `main.tsx`, `styles.css` | Create | Bootstrap exchange, chat, session/document/proposal browsing, accessible atlas, themes, CSS. |
| `README.md`, `ROADMAP.md`, `SECURITY.md` | Modify | Truthful v0.4.0 status, six-package architecture, local-auth use and limitations. |
| `packages/*/package.json` | Modify | Set every published package to `0.4.0` and add only package-local dependencies. |

## Public Interfaces Fixed by This Plan

```ts
// packages/memory/src/engine.ts
export interface MemoryEngineOpenOptions {
  maintenance?: boolean
}
// maintenance defaults to true, preserving current CLI behavior.
export class MemoryEngine {
  static open(root: string, deps: EngineDeps, options?: MemoryEngineOpenOptions): Promise<MemoryEngine>
}
export interface PublicDocumentRow {
  docId: string
  kind: DocKind
  title: string
  updatedAt: string
  readOnly: true
}
export interface PublicDocument extends PublicDocumentRow { body: string }
export interface PublicSession {
  sessionId: string
  createdAt: string
  updatedAt: string
  status: 'live' | 'ended' | 'expired'
  readOnly: boolean
  transcript: { lineCount: number; userCount: number; assistantCount: number; toolCount: number }
}
export interface SequencedGraphRecord { sequence: number; record: GraphRecord }
export interface PublicTranscriptLine extends TranscriptLine { lineSequence: number }
export interface TranscriptPageInput { lines: PublicTranscriptLine[] }
```

```ts
// packages/server/src/registry.ts
export type StreamEvent =
  | { schemaVersion: '1'; seq: number; type: 'thinking' }
  | { schemaVersion: '1'; seq: number; type: 'text'; text: string }
  | { schemaVersion: '1'; seq: number; type: 'tool'; name: string }
  | { schemaVersion: '1'; seq: number; type: 'done' }
  | { schemaVersion: '1'; seq: number; type: 'error'; code: string; retryable: boolean; message: string }
export interface LiveSessionRegistry {
  create(): Promise<CreateSessionResponse>
  message(sessionId: string, turnId: string, body: { message: string }, after?: number): AsyncIterable<StreamEvent>
  events(sessionId: string, after?: number): AsyncIterable<StreamEvent>
  end(sessionId: string): Promise<PublicSession>
  get(sessionId: string): PublicSession | null
  sweep(now?: number): void
  close(): Promise<void>
}
export type CreateSessionResponse = PublicSession & { initialGreetingStreamUrl?: string }
```

```ts
// packages/server/src/api.ts
export type CursorResource = 'sessions' | 'documents' | 'proposals' | 'transcript' | 'graph_events'
export type Cursor =
  | { v: 1; resource: 'sessions'; tuple: [startedAt: string, sessionId: string]; revision: string }
  | { v: 1; resource: 'documents'; tuple: [kind: string, title: string, docId: string]; revision: string }
  | { v: 1; resource: 'proposals'; tuple: [createdAt: string, proposalId: string]; revision: string }
  | { v: 1; resource: 'transcript'; tuple: [lineSequence: number]; revision: string }
  | { v: 1; resource: 'graph_events'; tuple: [sequence: number]; revision: string }
export function decodeCursor<R extends CursorResource>(
  encoded: string,
  resource: R,
  currentRevision: string,
): Extract<Cursor, { resource: R }>
```

```ts
// packages/server/src/launch.ts
export interface ServerLaunchOptions {
  configPath?: string
  port?: number
  openBrowser?: (url: string) => Promise<void>
  write: (line: string) => void
  now?: () => number
}
export interface ServerLaunchDeps {
  loadConfig(path?: string): Promise<ReverieConfig>
  resolveApiKey(config: ReverieConfig): string
  createChat(selection: ProviderSelection): ChatProvider
  createEmbeddings(selection: ProviderSelection): EmbeddingProvider
  openEngine(root: string, deps: EngineDeps, options?: { maintenance?: boolean }): Promise<MemoryEngine>
  resolveStaticDir(): Promise<string>
  assertStaticDirectory(path: string): Promise<void>
  createAuth(input: { origin: string; now: () => number }): { token: string; auth: BootstrapAuth }
  createRegistry(input: RegistryDeps): LiveSessionRegistry
  createApp(input: AppDeps): http.RequestListener
  createHttpServer(listener: http.RequestListener): http.Server
  listen(server: http.Server, host: '127.0.0.1', port: number): Promise<number>
  closeHttpServer(server: http.Server): Promise<void>
}
export function createServerLauncher(deps: ServerLaunchDeps): (options: ServerLaunchOptions) => Promise<RunningServer>
export interface RunningServer {
  origin: string
  bootstrapUrl: string
  close(): Promise<void>
}
export async function launchServer(options: ServerLaunchOptions): Promise<RunningServer>
```

## Task Order

1. Establish workspace packages, provider-free memory read projections, and API primitives.
2. Implement bootstrap authentication, native HTTP routing, and bounded read-only resources.
3. Implement graph snapshot and faithful history resources.
4. Implement live session registry, AgentSession bridge, streams, replay, idempotency, and expiry.
5. Compose and launch the server from `reverie web` without changing existing CLI commands.
6. Build the authenticated React record browser and streamed chat experience.
7. Build the Phase B-only accessible atlas foundation.
8. Run release preparation, documentation updates, compatibility checks, and final gates.

---

### Task 1: Establish packages, provider-free projections, and API primitives

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `packages/memory/src/graph.ts`, `packages/memory/src/graph.test.ts`, `packages/memory/src/transcripts.ts`, `packages/memory/src/transcripts.test.ts`, `packages/memory/src/engine.ts`, `packages/memory/src/engine.test.ts`, `packages/memory/src/index.ts`
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/index.ts`, `packages/server/src/api.ts`, `packages/server/src/api.test.ts`, `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/test-setup.ts`

**Interfaces:**
- Consumes: `MemoryEngine.readDocumentById(docId)`, `SessionStore.listSessions(paths)`, `readGraph(paths)`, `pendingProposals(paths)`, `GraphRecord`, `TranscriptLine`.
- Produces: `MemoryEngine.listPublicDocuments()`, `getPublicDocument(docId)`, `listStoredSessions()`, `readGraphHistory()`, and the Task 1 `api.ts` cursor/envelope/bounds helpers used by every server route.

- [ ] **Step 1: Write failing projection and cursor tests**

Add these focused tests before adding exports. They prove the public projection hides every filesystem path, retains v0.3.1 people without a page, and gives every cursor failure the same public `400 cursor_invalid` result.

```ts
it('projects node-only people and document-backed people without exposing paths', async () => {
  const rows = await engine.listPublicDocuments()
  expect(rows.every((row) => !('path' in row))).toBe(true)
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ docId: personPageId, kind: 'person', title: 'Mina', readOnly: true }),
  ]))
  expect(engine.graphSnapshot().nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'person_no_page', type: 'person', label: 'Noor' }),
    expect.objectContaining({ id: 'person_with_page', docId: personPageId }),
  ]))
})

it('retains every raw graph operation with its one-based append sequence', async () => {
  await appendGraph(paths, [assertNode, retractNode])
  expect(await engine.readGraphHistory()).toEqual([
    { sequence: 1, record: assertNode },
    { sequence: 2, record: retractNode },
  ])
})

it('does not alter the v0.3.1 SessionContext contract while adding read projections', async () => {
  expect(await engine.sessionContext(new Date('2026-08-15T12:00:00.000Z'))).toMatchObject({
    people: [{ id: 'person_no_page', name: 'Noor', hasPage: false }],
    peopleTruncated: false,
    entities: [],
    entitiesTruncated: false,
  })
})

it('opens provider-free projections without maintenance work when maintenance is false', async () => {
  const chat = { complete: vi.fn(), stream: vi.fn() }
  const embeddings = { embed: vi.fn() }
  const engine = await MemoryEngine.open(paths.root, { chat, embeddings, reflectionModel: 'reflection', embeddingModel: 'embeddings' }, { maintenance: false })
  expect(chat.complete).not.toHaveBeenCalled()
  expect(chat.stream).not.toHaveBeenCalled()
  expect(embeddings.embed).not.toHaveBeenCalled()
  expect(await engine.readGraphHistory()).toEqual(expect.any(Array))
  expect(await engine.listPublicDocuments()).toEqual(expect.any(Array))
  expect(await engine.listStoredSessions()).toEqual(expect.any(Array))
})

it.each(['%', Buffer.from('{', 'utf8').toString('base64url')])(
  'maps malformed base64url or JSON cursor %j to cursor_invalid',
  (cursor) => {
    expect(() => decodeCursor(cursor, 'documents', 'documents-rev-1')).toThrowObject({
      status: 400, code: 'cursor_invalid',
    })
  },
)

it('rejects wrong resource, wrong tuple schema, and stale revision', () => {
  const document = encodeCursor({
    v: 1, resource: 'documents', tuple: ['person', 'Mina', 'doc_1'], revision: 'documents-rev-1',
  })
  const malformedTuple = encodeCursor({
    v: 1, resource: 'documents', tuple: ['person', 'Mina'], revision: 'documents-rev-1',
  } as never)
  expect(() => decodeCursor(document, 'sessions', 'sessions-rev-1')).toThrowObject({ code: 'cursor_invalid' })
  expect(() => decodeCursor(malformedTuple, 'documents', 'documents-rev-1')).toThrowObject({ code: 'cursor_invalid' })
  expect(() => decodeCursor(document, 'documents', 'documents-rev-2')).toThrowObject({ code: 'cursor_invalid' })
})
```

- [ ] **Step 2: Run targeted tests and observe the failure**

Run: `pnpm vitest run packages/memory/src/engine.test.ts packages/memory/src/graph.test.ts packages/server/src/api.test.ts`

Expected: FAIL because the memory projection methods and `packages/server/src/api.ts` do not exist.

- [ ] **Step 3: Add package configuration and the smallest projection implementation**

Create the two package manifests with explicit dependency boundaries. Do not add web dependencies to root or any engine package.

Extend `MemoryEngine.open(root, deps, options?: { maintenance?: boolean })`, with `maintenance` defaulting to `true` so existing CLI calls remain unchanged. When `maintenance: false`, skip the legacy proposal drain and every other startup maintenance operation that could call `chat.complete`, `chat.stream`, or `embed`; still open the graph, documents, and SQLite-derived index projections so reads work. Legacy pending proposals remain visible to the compatibility route, and are not drained or rewritten in this mode. The test above must fail before the guard is implemented and must prove the graph, documents, and index projections open successfully.

```json
// packages/server/package.json
{
  "name": "@openreverie/server",
  "version": "0.4.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsc -b", "test": "vitest run --passWithNoTests" },
  "dependencies": {
    "@openreverie/core": "workspace:*",
    "@openreverie/memory": "workspace:*",
    "@openreverie/providers": "workspace:*",
    "zod": "^4.0.0"
  }
}
```

```json
// packages/web/package.json
{
  "name": "@openreverie/web",
  "private": true,
  "version": "0.4.0",
  "type": "module",
  "scripts": { "build": "tsc -b && vite build", "test": "vitest run --passWithNoTests" },
  "dependencies": { "graphology": "^0.26.0", "react": "^19.0.0", "react-dom": "^19.0.0", "sigma": "^3.0.0" },
  "devDependencies": { "@testing-library/react": "^16.0.0", "@testing-library/user-event": "^14.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^4.0.0", "jsdom": "^26.0.0", "vite": "^6.0.0" }
}
```

Add `readGraphRecords`, rather than changing `readGraph` folding behavior, and make the engine convert it to public shapes. A document title is `meta.name` when it is a nonempty string, otherwise `meta.title`, otherwise the document id. `updatedAt` is string `meta.updated`, then string `meta.date`, then string `meta.week`, then the document id's ULID time encoded as ISO, and finally the fixed epoch for legacy non-ULID IDs.

```ts
export async function readGraphRecords(paths: MemoryPaths): Promise<SequencedGraphRecord[]> {
  const lines = await readGraphLines(paths.graphLog) // shared existing validation loop, blank lines skipped
  return lines.map(({ record, sourceLine }) => ({ sequence: sourceLine, record }))
}

async listPublicDocuments(): Promise<PublicDocumentRow[]> {
  const docs = await this.walkAllDocuments()
  return docs.map(({ doc, kind }) => publicDocumentRow(doc, kind)).sort(comparePublicDocument)
}

graphSnapshot(): { nodes: PublicGraphNode[]; edges: PublicGraphEdge[] } {
  return {
    nodes: [...this.graphState.nodes.values()].map((node) => ({
      id: node.id, type: node.type, label: node.label,
      ...(node.doc && this.docIdByPath.get(node.doc) ? { docId: this.docIdByPath.get(node.doc) } : {}),
      assertedAt: node.ts,
    })),
    edges: [...this.graphState.edges.values()].map((edge) => ({
      key: edgeKey(edge), type: edge.edge, from: edge.from, to: edge.to,
      confidence: edge.confidence, confirmed: edge.confirmed,
      ...(edge.source ? { sourceSessionId: edge.source } : {}), assertedAt: edge.ts,
    })),
  }
}
```

Use a discriminated Zod union, not a generic tuple array, for cursor decoding. Each list constructs a deterministic revision from the complete current ordered source state before it decodes a supplied cursor. A revision mismatch is stale and must return the same `400 cursor_invalid` as malformed input. `decodeCursor` must catch base64url decoding, UTF-8 conversion, and `JSON.parse` failures, because Node can decode malformed-looking input into arbitrary bytes.

```ts
const cursorSchemas = [
  z.strictObject({ v: z.literal(1), resource: z.literal('sessions'), tuple: z.tuple([z.string(), z.string()]), revision: z.string() }),
  z.strictObject({ v: z.literal(1), resource: z.literal('documents'), tuple: z.tuple([z.string(), z.string(), z.string()]), revision: z.string() }),
  z.strictObject({ v: z.literal(1), resource: z.literal('proposals'), tuple: z.tuple([z.string(), z.string()]), revision: z.string() }),
  z.strictObject({ v: z.literal(1), resource: z.literal('transcript'), tuple: z.tuple([z.number().int().positive()]), revision: z.string() }),
  z.strictObject({ v: z.literal(1), resource: z.literal('graph_events'), tuple: z.tuple([z.number().int().positive()]), revision: z.string() }),
] as const
export const cursorSchema = z.discriminatedUnion('resource', cursorSchemas)
export function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}
export function decodeCursor<R extends CursorResource>(cursor: string, resource: R, revision: string): Extract<Cursor, { resource: R }> {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (!parsed.success || parsed.data.resource !== resource || parsed.data.revision !== revision) throw new Error('invalid')
    return parsed.data as Extract<Cursor, { resource: R }>
  } catch {
    throw new ApiError(400, 'cursor_invalid', 'The cursor is invalid.')
  }
}
export function envelope<T>(data: T, nextCursor: string | null) { return { data, meta: { nextCursor } } }
```

- [ ] **Step 4: Rerun targeted tests**

Run: `pnpm vitest run packages/memory/src/engine.test.ts packages/memory/src/graph.test.ts packages/server/src/api.test.ts`

Expected: PASS. Also run `pnpm build` once because package references and web TypeScript configuration are new.

- [ ] **Step 5: Review and commit Task 1**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `projects node-only people and document-backed people without exposing paths` by removing `docIdByPath` conversion, and falsify the cursor test by removing the `try/catch` or revision equality check.

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json packages/memory packages/server packages/web
git commit -m "Add web workspace foundations and memory read projections"
```

---

### Task 2: Implement bootstrap authentication and bounded read-only resources

**Files:**
- Create: `packages/server/src/auth.ts`, `packages/server/src/auth.test.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`
- Modify: `packages/server/src/api.ts`, `packages/server/src/api.test.ts`, `packages/memory/src/engine.ts`, `packages/memory/src/engine.test.ts`, `packages/memory/src/transcripts.ts`, `packages/memory/src/transcripts.test.ts`

**Interfaces:**
- Consumes: Task 1 `PublicDocumentRow`, `PublicSession`, `SequencedGraphRecord`, `ApiError`, `decodeCursor`, `envelope`; `MemoryEngine.resolveProposal(id, resolution)` for legacy entries only.
- Produces: `createApp(deps): http.RequestListener`, `BootstrapAuth`, GET documents/sessions/transcript/proposals APIs, and `MemoryEngine.listStoredSessions()` used by Tasks 4 through 6.

- [ ] **Step 1: Write failing HTTP integration tests**

Use a real `http.createServer(createApp(...))` with an injected fake engine and an in-memory auth instance. The helper must send the canonical host and cookie after bootstrapping.

```ts
it('exchanges a launch token once, cleans access to authenticated reads, and rejects replay generically', async () => {
  const { token, auth } = createBootstrapAuth({ origin, now: () => 0, randomBytes: () => Buffer.alloc(32, 7) })
  const first = await request('POST', '/api/v1/auth/bootstrap', { token }, { host })
  expect(first.status).toBe(200)
  expect(first.headers['set-cookie']).toContain('HttpOnly')
  const replay = await request('POST', '/api/v1/auth/bootstrap', { token }, { host })
  expect(replay).toEqual(expect.objectContaining({ status: 401, json: { schemaVersion: '1', code: 'unauthorized', message: 'Unauthorized.' } }))
})

it('requires exact Host and exact Origin only for state changes', async () => {
  await expect(request('GET', '/api/v1/documents', undefined, authenticated({ host: 'localhost:4312' }))).resolves.toMatchObject({ status: 400 })
  await expect(request('GET', '/api/v1/documents', undefined, authenticated({ host }))).resolves.toMatchObject({ status: 200 })
  await expect(request('POST', '/api/v1/proposals/prop_1/resolve', { resolution: 'rejected' }, authenticated({ host }))).resolves.toMatchObject({ status: 403 })
  await expect(request('POST', '/api/v1/proposals/prop_1/resolve', { resolution: 'rejected' }, authenticated({ host, origin }))).resolves.toMatchObject({ status: 200 })
})

it('enforces read resource bounds and cursor pagination without partial records', async () => {
  const page = await getJson('/api/v1/sessions?limit=1', authenticated())
  expect(page.json.data).toHaveLength(1)
  expect(page.json.meta.nextCursor).toEqual(expect.any(String))
  await expect(getJson(`/api/v1/sessions?cursor=${encodeURIComponent(page.json.meta.nextCursor)}&limit=1`, authenticated())).resolves.toMatchObject({ status: 200 })
  await expect(getJson(`/api/v1/documents/${largeDocId}`, authenticated())).resolves.toMatchObject({ status: 413, json: { code: 'resource_too_large' } })
  await expect(getJson(`/api/v1/sessions/${sessionId}/transcript?limit=1000`, authenticated())).resolves.toMatchObject({ status: 200 })
})

it.each(['%', Buffer.from('{', 'utf8').toString('base64url')])(
  'returns 400 cursor_invalid for malformed documents cursor %j',
  async (cursor) => {
    await expect(getJson(`/api/v1/documents?cursor=${encodeURIComponent(cursor)}`, authenticated()))
      .resolves.toMatchObject({ status: 400, json: { schemaVersion: '1', code: 'cursor_invalid' } })
  },
)

it('returns 400 cursor_invalid for a stale document revision', async () => {
  fakeEngine.setPublicDocuments([documentOne, documentTwo])
  const first = await getJson('/api/v1/documents?limit=1', authenticated())
  expect(first.json.meta.nextCursor).toEqual(expect.any(String))
  fakeEngine.renamePublicDocument(first.json.data[0].docId, 'Changed title')
  await expect(getJson(`/api/v1/documents?cursor=${encodeURIComponent(first.json.meta.nextCursor)}`, authenticated()))
    .resolves.toMatchObject({ status: 400, json: { code: 'cursor_invalid' } })
})

it('returns the specified status for each request, identifier, query, and page bound', async () => {
  await expect(request('POST', '/api/v1/auth/bootstrap', 'x'.repeat(256 * 1024 + 1), { host, 'content-type': 'application/json' })).resolves.toMatchObject({ status: 413 })
  await expect(getJson(`/api/v1/documents?x=${'a'.repeat(8193)}`, authenticated())).resolves.toMatchObject({ status: 414 })
  await expect(getJson(`/api/v1/documents/${'a'.repeat(257)}`, authenticated())).resolves.toMatchObject({ status: 400 })
  await expect(getJson('/api/v1/proposals?limit=201', authenticated())).resolves.toMatchObject({ status: 400 })
  await expect(getJson('/api/v1/sessions?limit=0', authenticated())).resolves.toMatchObject({ status: 400 })
})

it('returns durable transcript lines in append order with one-based lineSequence values', async () => {
  fakeTranscript.write(`${JSON.stringify(userLine)}\n${JSON.stringify(assistantLine)}\n`)
  const response = await getJson(`/api/v1/sessions/${sessionId}/transcript`, authenticated())
  expect(response.json.data).toEqual([
    { lineSequence: 1, ...userLine },
    { lineSequence: 2, ...assistantLine },
  ])
})
```

- [ ] **Step 2: Run the server tests and observe the failure**

Run: `pnpm vitest run packages/server/src/auth.test.ts packages/server/src/app.test.ts packages/memory/src/transcripts.test.ts`

Expected: FAIL because `createBootstrapAuth`, `createApp`, and the stored-session projection do not exist.

- [ ] **Step 3: Implement strict bootstrap auth, request guards, and read routes**

The token and cookie remain only in memory. Never interpolate either into an error or a log line.

```ts
export function createBootstrapAuth(deps: AuthDeps): { token: string; auth: BootstrapAuth } {
  const token = deps.randomBytes(32).toString('base64url')
  let consumed = false
  const session = deps.randomBytes(32).toString('base64url')
  return { token, auth: {
    exchange(candidate) {
      const valid = !consumed && deps.now() - deps.startedAt <= 300_000 && timingSafeEqualText(candidate, token)
      if (!valid) throw new ApiError(401, 'unauthorized', 'Unauthorized.')
      consumed = true
      return session
    },
    authenticate(cookie) { return timingSafeEqualText(readCookie(cookie, 'reverie_session') ?? '', session) },
  }}
}
```

Validate URL byte length before parsing parameters, parse all body JSON through `z.strictObject`, and centralize limits. GET/HEAD call `requireAuthenticatedRead`; every other API method calls `requireAuthenticatedWrite`.

```ts
function requireAuthenticatedWrite(req: IncomingMessage, auth: BootstrapAuth, canonical: CanonicalOrigin): void {
  requireHost(req, canonical.host)
  if (!auth.authenticate(req.headers.cookie)) throw new ApiError(401, 'unauthorized', 'Unauthorized.')
  if (req.headers.origin !== canonical.origin) throw new ApiError(403, 'origin_forbidden', 'Request origin is not allowed.')
}

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > maxBytes) throw new ApiError(413, 'request_too_large', 'The request is too large.')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError(400, 'invalid_json', 'The request body must be JSON.') }
}
```

Use these constants in every route rather than repeating numeric literals. `parsePageLimit` validates integers before using them, and `writeJson` checks the complete UTF-8 serialized response before writing any bytes.

```ts
export const LIMITS = { requestBytes: 256 * 1024, messageBytes: 64 * 1024, queryBytes: 8 * 1024, idChars: 256, documentBytes: 4 * 1024 * 1024, transcriptPageBytes: 4 * 1024 * 1024, proposalPageBytes: 2 * 1024 * 1024, graphPageBytes: 8 * 1024 * 1024, graphEventBytes: 256 * 1024 } as const
export function parsePageLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback
  if (!/^[1-9]\d*$/.test(value)) throw new ApiError(400, 'invalid_request', 'The limit is invalid.')
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit > maximum) throw new ApiError(400, 'invalid_request', 'The limit is invalid.')
  return limit
}
```

Add `SessionStore.describe` so old sessions are readable after restart. It derives `createdAt` from the ULID when decodable, falls back to `date + T00:00:00.000Z`, reads only complete transcript lines, and uses the final line timestamp for `updatedAt`. `SessionStore.readTranscriptPage` maps the validated append-order array at index `i` to `{ lineSequence: i + 1, ...line }`. Thus the first durable transcript record is always `lineSequence: 1`; blank and partial physical lines are excluded before this numbering. The server marks every disk-only session `ended` and `readOnly: true`; only Task 4 registry sessions are `live`.

```ts
async listStoredSessions(): Promise<PublicSession[]> {
  const stored = await SessionStore.describe(this.paths)
  return stored.map((session) => ({ ...session, status: 'ended', readOnly: true }))
}
```

Implement these routes with public fields only: `GET /documents`, `GET /documents/:docId`, `GET /sessions`, `GET /sessions/:sessionId`, `GET /sessions/:sessionId/transcript`, `GET /proposals`, and `POST /proposals/:proposalId/resolve`. Compute a resource revision before cursor decoding: sessions from all public session sort tuples, documents from all public document tuples, proposals from all pending proposal tuples, transcripts from every `{ lineSequence, ts, role, content }` record, and graph events in Task 3 from every source sequence and normalized event. Proposal GET returns pending legacy queue entries in `createdAt,id` order. Resolve validates `{ resolution: 'accepted' | 'rejected' }`, calls the existing engine method once, and returns 404 for a non-pending proposal. Never create a proposal route or UI action.

- [ ] **Step 4: Rerun tests and manual HTTP diagnostics**

Run: `pnpm vitest run packages/server/src/auth.test.ts packages/server/src/app.test.ts packages/memory/src/transcripts.test.ts`

Expected: PASS. Run `pnpm vitest run packages/server/src/app.test.ts -t "enforces read resource bounds"` again after setting the test document body to exactly `4 * 1024 * 1024 + 1` UTF-8 bytes.

- [ ] **Step 5: Review and commit Task 2**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `requires exact Host and exact Origin only for state changes` by deleting the Host check, and `exchanges a launch token once` by removing `consumed = true`.

```bash
git add packages/memory/src packages/server/src
git commit -m "Add authenticated bounded record browsing API"
```

---

### Task 3: Implement deterministic graph snapshot and faithful event history APIs

**Files:**
- Modify: `packages/server/src/api.ts`, `packages/server/src/api.test.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`, `packages/memory/src/graph.ts`, `packages/memory/src/graph.test.ts`, `packages/memory/src/engine.ts`, `packages/memory/src/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 `MemoryEngine.graphSnapshot()` and `readGraphHistory()` plus API cursor and response writers.
- Produces: `GET /api/v1/graph/snapshot` with quoted revision ETag and `GET /api/v1/graph/events` normalized `GraphEvent` records. Tasks 6 and 7 consume these exact JSON shapes.

- [ ] **Step 1: Write failing canonical snapshot and event tests**

```ts
it('returns one canonical folded snapshot with stable SHA-256 revision and 304 ETag', async () => {
  const first = await getJson('/api/v1/graph/snapshot', authenticated())
  expect(first.json.data).toMatchObject({ revision: /^[0-9a-f]{64}$/, nodes: expect.any(Array), edges: expect.any(Array) })
  expect(first.headers.etag).toBe(`"${first.json.data.revision}"`)
  expect(await request('GET', '/api/v1/graph/snapshot', undefined, authenticated({ 'if-none-match': first.headers.etag }))).toMatchObject({ status: 304 })
})

it('preserves asserts and retracts in append sequence even when they are dangling', async () => {
  const response = await getJson('/api/v1/graph/events?limit=2', authenticated())
  expect(response.json.data).toEqual([
    expect.objectContaining({ sequence: 1, op: 'assert', node: expect.objectContaining({ id: 'person_1' }) }),
    expect.objectContaining({ sequence: 2, op: 'retract', nodeId: 'person_1' }),
  ])
  expect(response.json.meta.nextCursor).toEqual(expect.any(String))
})

it('rejects a graph-event cursor after the raw append history changes', async () => {
  const first = await getJson('/api/v1/graph/events?limit=1', authenticated())
  await appendGraph(paths, [anotherAssert])
  await expect(getJson(`/api/v1/graph/events?after=${encodeURIComponent(first.json.meta.nextCursor)}`, authenticated()))
    .resolves.toMatchObject({ status: 400, json: { code: 'cursor_invalid' } })
})

it('fails rather than truncating an oversized graph snapshot or one oversized event', async () => {
  await expect(getJson('/api/v1/graph/snapshot', authenticated())).resolves.toMatchObject({ status: 413, json: { code: 'graph_snapshot_too_large' } })
  await expect(getJson('/api/v1/graph/events', authenticated())).resolves.toMatchObject({ status: 413, json: { code: 'record_too_large' } })
})
```

- [ ] **Step 2: Run graph API tests and observe the failure**

Run: `pnpm vitest run packages/server/src/api.test.ts packages/server/src/app.test.ts packages/memory/src/graph.test.ts`

Expected: FAIL because graph route handlers, canonical serialization, revision, and normalized event projection are absent.

- [ ] **Step 3: Implement canonical bytes, snapshot guards, and normalized events**

Use only the folded graph for the snapshot, but raw validated history for events. Sort before serializing, recursively sort object keys, preserve array order, and hash exactly `{ nodes, edges }` before adding `revision`.

```ts
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function makeGraphSnapshot(graph: ReturnType<MemoryEngine['graphSnapshot']>) {
  const nodes = [...graph.nodes].sort((a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.id.localeCompare(b.id))
  const edges = [...graph.edges].sort((a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.key.localeCompare(b.key))
  const bytes = Buffer.from(canonicalJson({ nodes, edges }), 'utf8')
  if (bytes.byteLength > 8 * 1024 * 1024) throw new ApiError(413, 'graph_snapshot_too_large', 'The graph snapshot is too large.')
  return { revision: createHash('sha256').update(bytes).digest('hex'), nodes, edges }
}
```

Normalize every source record with a discriminated branch. A retract node retains the raw record timestamp and id. It must not depend on successful folding.

```ts
function publicGraphEvent({ sequence, record }: SequencedGraphRecord): GraphEvent {
  if ('node' in record) {
    return record.op === 'assert'
      ? { sequence, op: 'assert', kind: 'node', assertedAt: record.ts, node: publicNodeRecord(record) }
      : { sequence, op: 'retract', kind: 'node', assertedAt: record.ts, nodeId: record.node }
  }
  return record.op === 'assert'
    ? { sequence, op: 'assert', kind: 'edge', assertedAt: record.ts, edge: publicEdgeRecord(record) }
    : { sequence, op: 'retract', kind: 'edge', assertedAt: record.ts, edgeKey: edgeKey(record) }
}
```

The graph event cursor stores the last source sequence and the SHA-256 revision of canonical normalized append history, not the current folded position. Default is 500, maximum 2000; stop at the last complete event before the 8 MiB page limit. If the next complete event alone exceeds 256 KiB, return `413 record_too_large`. Return 304 only for snapshot `If-None-Match`, never by changing the response body.

- [ ] **Step 4: Rerun tests and prove deterministic ordering**

Run: `pnpm vitest run packages/server/src/api.test.ts packages/server/src/app.test.ts packages/memory/src/graph.test.ts`

Expected: PASS. Also run `pnpm vitest run packages/server/src/app.test.ts -t "returns one canonical folded snapshot"` after reordering fixture log lines with equal timestamps but different ids; assert the result revision remains stable for the same folded state.

- [ ] **Step 5: Review and commit Task 3**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `returns one canonical folded snapshot with stable SHA-256 revision and 304 ETag` by removing node sorting, and `preserves asserts and retracts in append sequence` by filtering retractions.

```bash
git add packages/memory/src packages/server/src
git commit -m "Add canonical graph snapshot and history API"
```

---

### Task 4: Implement live sessions, safe streaming, replay, and lifecycle limits

**Files:**
- Modify: `packages/server/src/app.ts`, `packages/server/src/app.test.ts`
- Create: `packages/server/src/registry.ts`, `packages/server/src/registry.test.ts`

**Interfaces:**
- Consumes: `AgentSession.start(engine, config, chat)`, the unchanged existing `AgentEvent` union, Task 2 session read projections and auth guards.
- Produces: Task 4 `LiveSessionRegistry`; routes `POST /sessions`, `POST /sessions/:id/message`, `GET /sessions/:id/events`, `POST /sessions/:id/end`.

- [ ] **Step 1: Write failing registry and HTTP stream tests**

Use a `ControlledChatProvider` whose `stream()` records its request, resolves `started` immediately, then waits on test-controlled `releaseText()` and `finish()` promises. Construct the normal registry fixture with `providerAvailable: true` and the controlled provider so message-stream tests exercise the provider path. Construct a separate `unavailableRegistry` fixture with `providerAvailable: false`; use that fixture only for the `chat_unavailable` test so its missing-provider dependency is explicit and the optional greeting cannot contribute a model call or transcript line. Set `now: () => 0`, and define `const THIRTY_MINUTES = 30 * 60 * 1000`.

```ts
it('reconnects an overlapping same-body retry without duplicate model or transcript work', async () => {
  const session = await registry.create()
  const firstPromise = collect(registry.message(session.sessionId, 'turn-1', { message: 'hello' }))
  await fakeChat.waitUntilStreamStarted()
  const retryPromise = collect(registry.message(session.sessionId, 'turn-1', { message: 'hello' }, 0))
  expect(fakeChat.calls).toHaveLength(1)
  fakeChat.releaseText('hello back')
  fakeChat.finish()
  const [first, retry] = await Promise.all([firstPromise, retryPromise])
  expect(first.map((event) => event.type)).toEqual(['thinking', 'text', 'done'])
  expect(retry).toEqual(first)
  expect(fakeChat.calls).toHaveLength(1)
  expect(await engine.readTranscript(session.sessionId)).toHaveLength(2)
})

it('rejects a distinct overlapping turn while the first controlled stream is active', async () => {
  const firstPromise = collect(registry.message(id, 'turn-1', { message: 'one' }))
  await fakeChat.waitUntilStreamStarted()
  await expect(collect(registry.message(id, 'turn-2', { message: 'two' })))
    .rejects.toMatchObject({ status: 409, code: 'turn_in_progress' })
  expect(fakeChat.calls).toHaveLength(1)
  fakeChat.finish()
  await firstPromise
})

it('rejects a reused turn ID with different canonical message bytes', async () => {
  await collect(registry.message(id, 'turn-1', { message: 'one' }))
  await expect(collect(registry.message(id, 'turn-1', { message: 'two' })))
    .rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
  expect(fakeChat.calls).toHaveLength(1)
})

it('enforces the eighth-live-session and configured turn limits', async () => {
  await Promise.all(Array.from({ length: 8 }, () => registry.create()))
  await expect(registry.create()).rejects.toMatchObject({ status: 429, code: 'session_capacity' })
  expect(DEFAULT_REGISTRY_LIMITS.maxTurns).toBe(4096)
  const turnLimited = createRegistry({ providerAvailable: false, maxTurns: 2, fakeChat })
  const session = await turnLimited.create()
  await collect(turnLimited.message(session.sessionId, 'turn-1', { message: 'one' }))
  await collect(turnLimited.message(session.sessionId, 'turn-2', { message: 'two' }))
  await expect(collect(turnLimited.message(session.sessionId, 'turn-3', { message: 'three' })))
    .rejects.toMatchObject({ status: 409, code: 'session_turn_limit' })
})

it('does not rerun an event-count-evicted replay or append another transcript', async () => {
  const limited = createRegistry({ maxReplayEvents: 2, maxReplayBytes: 1024 * 1024, fakeChat })
  await collect(limited.message(id, 'turn-1', { message: 'one' }))
  await expect(collect(limited.message(id, 'turn-1', { message: 'one' }, 0)))
    .rejects.toMatchObject({ status: 409, code: 'resync_required' })
  expect(fakeChat.calls).toHaveLength(1)
  expect(await engine.readTranscript(id)).toHaveLength(2)
})

it('does not rerun a byte-cap-evicted replay or append another transcript', async () => {
  const limited = createRegistry({ maxReplayEvents: 256, maxReplayBytes: 180, fakeChat })
  fakeChat.enqueueText('x'.repeat(96))
  await collect(limited.message(id, 'turn-1', { message: 'one' }))
  await expect(collect(limited.message(id, 'turn-1', { message: 'one' }, 0)))
    .rejects.toMatchObject({ status: 409, code: 'resync_required' })
  expect(fakeChat.calls).toHaveLength(1)
  expect(await engine.readTranscript(id)).toHaveLength(2)
})

it('retains bounded ended and expired tombstones so POST distinguishes read-only sessions from unknown IDs', async () => {
  await registry.end(id)
  await expect(postMessage(id, 'turn-ended')).resolves.toMatchObject({ status: 409, json: { code: 'session_ended' } })
  await expect(postMessage('session_unknown', 'turn-unknown')).resolves.toMatchObject({ status: 404 })
  const expiring = await registry.create()
  registry.sweep(THIRTY_MINUTES + 1)
  await expect(postMessage(expiring.sessionId, 'turn-expired')).resolves.toMatchObject({ status: 409, json: { code: 'session_expired' } })
})

it('evicts only the oldest ended tombstone at the cap', async () => {
  const sessions = []
  for (let index = 0; index < 65; index += 1) {
    const session = await registry.create()
    sessions.push(session)
    await registry.end(session.sessionId)
  }
  await expect(postMessage(sessions[0].sessionId, 'turn-oldest')).resolves.toMatchObject({ status: 404 })
  await expect(postMessage(sessions[1].sessionId, 'turn-newest-minus-1')).resolves.toMatchObject({ status: 409, json: { code: 'session_ended' } })
  await expect(postMessage(sessions[64].sessionId, 'turn-newest')).resolves.toMatchObject({ status: 409, json: { code: 'session_ended' } })
})

it('returns one safe terminal chat_unavailable event when the provider is absent', async () => {
  const unavailable = await unavailableRegistry.create()
  const events = await collect(unavailableRegistry.message(unavailable.sessionId, 'turn-unavailable', { message: 'Are you there?' }))
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', code: 'chat_unavailable', retryable: true })]))
  expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
})

it('returns 409 resync_required JSON for a missing replay sequence instead of NDJSON', async () => {
  const response = await post('/api/v1/sessions/' + id + '/message', { message: 'again' }, authenticated({ 'x-reverie-turn-id': 'turn-1', 'x-reverie-last-sequence': '0' }))
  expect(response).toMatchObject({ status: 409, json: { schemaVersion: '1', code: 'resync_required' } })
})
```

- [ ] **Step 2: Run stream tests and observe the failure**

Run: `pnpm vitest run packages/core/src/agent.test.ts packages/server/src/registry.test.ts packages/server/src/app.test.ts`

Expected: FAIL because the registry and its routes do not exist.

- [ ] **Step 3: Add the server-only error bridge and registry**

Keep the public `AgentEvent` union and every CLI consumer unchanged. The server bridge maps an exception from `AgentSession.send()` into the server-only `StreamEvent` error variant after the core session has preserved its existing transcript-first behavior. This avoids widening `AgentEvent` and keeps `packages/cli/src/chat.ts` compatible without an unrelated rendering change.

Each accepted turn hashes exactly the UTF-8 bytes of canonical `JSON.stringify({ message })`. Store the turn record separately from replay bytes. The registry appends a generated `seq` event before writing it to a bounded complete-event deque, and emits exactly one `done` or `error` terminal event.

`replayOrSubscribe(live, turn, after)` first verifies that `after` is retained, yields retained events strictly after it, and, while `turn.state === 'active'`, awaits the registry's per-session event notification and yields each newly recorded event once. It never calls `AgentSession.send()`. A disconnect releases only that subscriber, not the active turn.

```ts
async *message(sessionId: string, turnId: string, body: { message: string }, after?: number): AsyncIterable<StreamEvent> {
  const live = this.requireLive(sessionId)
  const hash = createHash('sha256').update(Buffer.from(JSON.stringify({ message: body.message }), 'utf8')).digest('hex')
  const prior = live.turns.get(turnId)
  if (prior) {
    if (prior.hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'This turn conflicts with an earlier request.')
    yield* this.replayOrSubscribe(live, prior, after)
    return
  }
  if (live.activeTurnId || live.turns.size >= 4096) throw new ApiError(409, live.activeTurnId ? 'turn_in_progress' : 'session_turn_limit', 'Start a new session to continue.')
  const startSeq = live.sequence + 1
  live.turns.set(turnId, { hash, state: 'active', startSeq, endSeq: undefined })
  live.activeTurnId = turnId
  try {
    for await (const event of live.agent.send(body.message)) yield this.record(live, streamEventFromAgent(event))
  } catch (error) {
    yield this.record(live, { type: 'error', code: isProviderUnavailable(error) ? 'chat_unavailable' : 'chat_failed', retryable: true, message: isProviderUnavailable(error) ? 'Chat is unavailable right now. Your saved record is still available.' : 'Chat could not finish. Please try again.' })
  } finally {
    live.turns.set(turnId, { hash, state: 'terminal', terminal: live.lastTerminal(), startSeq, endSeq: live.sequence })
    live.activeTurnId = undefined; live.lastActivity = this.now()
  }
}
```

`record` JSON-serializes the proposed event first and rejects any single encoded NDJSON line above 256 KiB before it enters replay. It evicts only oldest complete events until both 256-event and 1 MiB limits hold. `replay` returns `409 resync_required` if `after` predates the first retained sequence, even for a known idempotent turn. `sweep` expires disconnected inactive sessions after 30 minutes; it never reflects or deletes transcripts.

Keep `ENDED_TOMBSTONE_CAP = 64` compact records in a FIFO map after `end` or expiry: `{ sessionId, public: { ...PublicSession, status: 'ended' | 'expired', readOnly: true } }`. `end` is idempotent, awaits the agent end chain, then removes its agent, replay deque, and turn hashes from live state while retaining this tombstone. On the 65th tombstone, evict the oldest. `message` and `events` first look for a live session, then a tombstone, then disk-only metadata: a tombstone returns `409 session_ended` or `409 session_expired`; an on-disk session returns `409 session_ended`; only an absent ID returns `404`. Existing on-disk sessions are never recreated after restart.

Route rules: `POST /sessions` returns session metadata and optional initial greeting event URL only if a greeting was actually initiated; message `POST` writes NDJSON with no resync header on an initial request; reconnect requests and `GET /events` apply `X-Reverie-Last-Sequence`; message body is strict `{ message }` and checks UTF-8 bytes before agent creation. Return 429 on the ninth live session and 404 for unknown session IDs.

`create` starts the existing greeting only when `providerAvailable` is true. It serializes that greeting through the same event recorder before allowing a message turn. The response includes `initialGreetingStreamUrl` only when the registry has started that background greeting; the URL is `/api/v1/sessions/<sessionId>/events`. A greeting provider failure records no transcript text, returns no fabricated message, releases the active stream slot, and keeps the session usable for a later send if the provider recovers.

```ts
async create(): Promise<CreateSessionResponse> {
  if (this.live.size >= 8) throw new ApiError(429, 'session_capacity', 'Too many live sessions are open.')
  const agent = await AgentSession.start(this.engine, this.config, this.chat)
  const live = this.insert(agent)
  if (this.providerAvailable) {
    live.activeTurnId = '__greeting__'
    void this.recordGreeting(live).finally(() => { live.activeTurnId = undefined; live.lastActivity = this.now() })
    return { ...live.public, initialGreetingStreamUrl: `/api/v1/sessions/${encodeURIComponent(live.public.sessionId)}/events` }
  }
  return live.public
}
```

- [ ] **Step 4: Rerun targeted stream tests**

Run: `pnpm vitest run packages/core/src/agent.test.ts packages/server/src/registry.test.ts packages/server/src/app.test.ts`

Expected: PASS. The count-cap and byte-cap tests must each assert `fakeChat.calls` stays at one and the durable transcript stays at two lines after the same-body retry returns `resync_required`.

- [ ] **Step 5: Review and commit Task 4**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the early active turn-record insertion, observing two provider calls in the overlapping retry test, and by removing the tombstone lookup, observing the ended-session POST incorrectly returns 404.

```bash
git add packages/server/src
git commit -m "Add bounded live session streaming and replay"
```

---

### Task 5: Compose the provider-optional server and add `reverie web`

**Files:**
- Create: `packages/server/src/launch.ts`, `packages/server/src/launch.test.ts`, `packages/cli/src/web.ts`, `packages/cli/src/web.test.ts`
- Modify: `packages/server/src/index.ts`, `packages/cli/src/index.ts`, `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/server/package.json`, `tsconfig.json`

**Interfaces:**
- Consumes: Task 4 `createApp`, `LiveSessionRegistry`, Task 2 `createBootstrapAuth`, `loadConfig`, `resolveApiKey`, provider factories, `MemoryEngine.open`, and a resolved Vite build directory.
- Produces: `createServerLauncher(deps)`, `launchServer(options)`, and `runWebCommand(deps)`, preserving existing CLI behavior for every non-`web` invocation.

- [ ] **Step 1: Write failing launch and CLI dispatch tests**

```ts
it('composes config, fallback providers, MemoryEngine, auth, registry, and static assets explicitly', async () => {
  const launchServer = createServerLauncher(deps)
  const running = await launchServer({ write: lines.push.bind(lines), port: 0, openBrowser: async (url) => opened.push(url), configPath })
  expect(running.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(running.bootstrapUrl).toMatch(new RegExp(`^${escapeRegExp(running.origin)}/\\?token=`))
  expect(lines).toEqual([`Web interface: ${running.origin}`, `Open: ${running.bootstrapUrl}`])
  expect(opened).toEqual([running.bootstrapUrl])
  expect(deps.loadConfig).toHaveBeenCalledWith(configPath)
  expect(deps.resolveApiKey).toHaveBeenCalledWith(config)
  expect(deps.openEngine).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ chat: expect.anything(), embeddings: expect.anything() }), { maintenance: false })
  expect(deps.resolveStaticDir).toHaveBeenCalledOnce()
  expect(deps.assertStaticDirectory).toHaveBeenCalledWith(expect.any(String))
  expect(deps.createAuth).toHaveBeenCalledWith(expect.objectContaining({ origin: running.origin }))
  expect(deps.createRegistry).toHaveBeenCalledWith(expect.objectContaining({ providerAvailable: false, engine: expect.anything(), chat: expect.anything() }))
  expect(deps.createApp).toHaveBeenCalledWith(expect.objectContaining({ engine: expect.anything(), auth: expect.anything(), registry: expect.anything(), staticDir: expect.any(String) }))
  expect(await authenticatedGet(running, '/api/v1/documents')).toMatchObject({ status: 200 })
  await running.close()
})

it('dispatches web only for reverie web and leaves read, reindex, reflect, setup, and no-argument chat wiring unchanged', async () => {
  await mainWith(['web'], deps)
  expect(deps.runWeb).toHaveBeenCalledOnce()
  await mainWith(['read'], deps)
  expect(deps.runRead).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run launch and CLI tests and observe the failure**

Run: `pnpm vitest run packages/server/src/launch.test.ts packages/cli/src/web.test.ts packages/cli/src/e2e.test.ts`

Expected: FAIL because neither launch composition nor `web` command dispatch exists.

- [ ] **Step 3: Implement provider-optional composition and foreground CLI launch**

Implement `createServerLauncher(deps)` as the test seam and make exported `launchServer` call it with the real dependencies. `ServerLaunchDeps` is fixed in the public interfaces above. Open the one server-owned memory engine once, passing `{ maintenance: false }` as the third argument. This is required even when configured providers are available: server startup must not drain legacy proposals or perform provider-backed maintenance. Legacy pending proposals remain readable through the compatibility route. Existing CLI calls to `MemoryEngine.open` omit the option and retain default `maintenance: true` behavior. First attempt normal provider construction only after `loadConfig` has yielded `memoryDir`; if `resolveApiKey` or a factory fails, pass public-interface unavailable providers. They make no network calls and throw a typed local `ProviderUnavailableError` only if chat or embedding is actually requested.

In `packages/server/src/index.ts`, construct the real launcher with explicit imports of `loadConfig` and `resolveApiKey` from core, provider factories from providers, `MemoryEngine.open`, `createBootstrapAuth`, `createLiveSessionRegistry`, `createApp`, Node's `createServer`, `listen`, `close`, and the server-owned static-directory resolver. No launch implementation may read a hidden module singleton for `auth`, `registry`, configuration, providers, engine, or web assets.

```ts
class UnavailableChatProvider implements ChatProvider {
  readonly name = 'unavailable'
  async *stream(): AsyncIterable<never> { throw new ProviderUnavailableError() }
}
class UnavailableEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'unavailable'
  async embed(): Promise<number[][]> { throw new ProviderUnavailableError() }
}

function tryConfiguredProviders(input: Pick<ServerLaunchDeps, 'resolveApiKey' | 'createChat' | 'createEmbeddings'> & { config: ReverieConfig }): { chat: ChatProvider; embeddings: EmbeddingProvider; available: true } | undefined {
  try {
    const apiKey = input.resolveApiKey(input.config)
    const selection: ProviderSelection = input.config.provider.baseUrl === undefined
      ? { provider: input.config.provider.name, apiKey }
      : { provider: input.config.provider.name, apiKey, baseUrl: input.config.provider.baseUrl }
    return { chat: input.createChat(selection), embeddings: input.createEmbeddings(selection), available: true }
  } catch {
    return undefined
  }
}

export function createServerLauncher(deps: ServerLaunchDeps) {
  return async function launchServer(options: ServerLaunchOptions): Promise<RunningServer> {
    const config = await deps.loadConfig(options.configPath)
    const providers = tryConfiguredProviders({ config, resolveApiKey: deps.resolveApiKey, createChat: deps.createChat, createEmbeddings: deps.createEmbeddings })
      ?? { chat: new UnavailableChatProvider(), embeddings: new UnavailableEmbeddingProvider(), available: false }
    const engine = await deps.openEngine(config.memoryDir, {
      chat: providers.chat, embeddings: providers.embeddings,
      reflectionModel: config.models.reflection, embeddingModel: config.models.embeddings,
    }, { maintenance: false })
    const staticDir = await deps.resolveStaticDir()
    await deps.assertStaticDirectory(staticDir)
    let listener: http.RequestListener = (_req, res) => { res.statusCode = 503; res.end() }
    const server = deps.createHttpServer((req, res) => listener(req, res))
    const port = await deps.listen(server, '127.0.0.1', options.port ?? 0)
    const origin = `http://127.0.0.1:${port}`
    const { token, auth } = deps.createAuth({ origin, now: options.now ?? Date.now })
    const registry = deps.createRegistry({ engine, config, chat: providers.chat, providerAvailable: providers.available, now: options.now })
    listener = deps.createApp({ engine, config, auth, registry, staticDir, origin })
    const bootstrapUrl = `${origin}/?token=${token}`
    options.write(`Web interface: ${origin}`)
    options.write(`Open: ${bootstrapUrl}`)
    await options.openBrowser?.(bootstrapUrl)
    return { origin, bootstrapUrl, close: async () => { await registry.close(); await deps.closeHttpServer(server); await engine.close() } }
  }
}
```

Pass a static asset directory into `createApp`. It serves only Vite output files with a fixed content-type allowlist and `Cache-Control: no-store` for `index.html`; it returns the same `index.html` for non-API client routes and never treats an `/api/` miss as a client route. `launchServer` resolves that directory from the installed web package build output and fails plainly before binding when it is absent. Keep this a filesystem path supplied at composition time, not a `server -> web` import.

Do not call `open`, `osascript`, or a platform binary directly from CLI logic. Inject it at the outer entry point, defaulting to no browser open. Attach SIGINT/SIGTERM shutdown only in `runWebCommand`, remove both listeners in `finally`, and let server close finish before process exit. Add the branch before normal chat setup:

```ts
if (subcommand === 'web') {
  await runWebCommand({ launchServer, write: (line) => stdout.write(`${line}\n`) })
  return
}
```

Update TS project references so CLI points to server and the root build references server and web. Use `pnpm install --lockfile-only` after manifest changes; do not hand-edit lockfile resolutions.

- [ ] **Step 4: Rerun command and provider-free tests**

Run: `pnpm vitest run packages/server/src/launch.test.ts packages/cli/src/web.test.ts packages/cli/src/e2e.test.ts && pnpm build`

Expected: PASS. Confirm a test where `resolveApiKey` throws still performs no provider `stream` or `embed` call before the records GET.

- [ ] **Step 5: Review and commit Task 5**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `opens provider-free projections without maintenance work when maintenance is false` by deleting the `maintenance: false` guard or changing it to run maintenance, and observe a fake `complete`, `stream`, or `embed` call and/or a drained proposal. Falsify `starts read paths when API-key resolution fails` by replacing unavailable providers with an eager factory call, and `dispatches web only for reverie web` by moving the branch below normal chat context creation.

```bash
git add package.json pnpm-lock.yaml tsconfig.json packages/server packages/cli
git commit -m "Launch local web server from reverie web"
```

---

### Task 6: Build the authenticated React record browser and streamed chat

**Files:**
- Create: `packages/web/src/api.ts`, `packages/web/src/api.test.ts`, `packages/web/src/session.ts`, `packages/web/src/session.test.ts`, `packages/web/src/App.tsx`, `packages/web/src/App.test.tsx`, `packages/web/src/main.tsx`, `packages/web/src/styles.css`
- Modify: `packages/web/vite.config.ts`, `packages/web/src/test-setup.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`

**Interfaces:**
- Consumes: Task 2 envelopes/read routes, Task 3 snapshot/event shapes, Task 4 NDJSON events, routes, replay headers, and resync semantics.
- Produces: `ApiClient`, `sessionReducer`, and `App`, which Task 7 augments with the atlas component.

- [ ] **Step 1: Write failing browser tests**

```tsx
it('bootstraps once, removes token from the address, and loads records with credentials', async () => {
  window.history.replaceState({}, '', '/?token=launch-token')
  render(<App api={api} />)
  await waitFor(() => expect(api.bootstrap).toHaveBeenCalledWith('launch-token'))
  expect(window.location.search).toBe('')
  expect(await screen.findByRole('heading', { name: 'Documents' })).toBeVisible()
})

it('reconnects from its last sequence and fetches transcript after resync_required', async () => {
  api.message.mockResolvedValueOnce(ndjson([thinking(1), text(2, 'Hello')]))
  api.events.mockRejectedValueOnce(new ApiHttpError(409, 'resync_required', 'Resync required.'))
  render(<App api={api} />)
  await userEvent.type(screen.getByLabelText('Message'), 'Hi')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(api.events).toHaveBeenCalledWith(sessionId, 2))
  await waitFor(() => expect(api.transcript).toHaveBeenCalledWith(sessionId))
  expect(screen.getByText('Hello')).toBeVisible()
})

it('opens a document from the browser and makes provider outage honest', async () => {
  render(<App api={api} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Mina' }))
  expect(await screen.findByRole('article', { name: 'Mina' })).toHaveTextContent('Mina has been preparing')
  api.message.mockResolvedValueOnce(ndjson([error(3, 'chat_unavailable', 'Chat is unavailable right now. Your saved record is still available.')]))
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('Chat is unavailable right now. Your saved record is still available.')).toBeVisible()
})
```

- [ ] **Step 2: Run browser tests and observe the failure**

Run: `pnpm vitest run packages/web/src/api.test.ts packages/web/src/session.test.ts packages/web/src/App.test.tsx`

Expected: FAIL because the client, reducer, and React entry are absent.

- [ ] **Step 3: Implement credentialed client, reducer, and plain React UI**

Every fetch is same-origin and credentialed; query and response schemas are parsed before state changes. Parse NDJSON incrementally, reject an incomplete terminal state, and do not render unvalidated content as HTML.

```ts
export class ApiClient {
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...init.headers } })
    if (!response.ok) throw await ApiHttpError.from(response)
    return responseSchema<T>().parse(await response.json()).data
  }
  bootstrap(token: string) { return this.request('/api/v1/auth/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }) }
  message(id: string, turnId: string, message: string, after?: number) {
    return this.ndjson(`/api/v1/sessions/${encodeURIComponent(id)}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reverie-Turn-Id': turnId, ...(after === undefined ? {} : { 'X-Reverie-Last-Sequence': String(after) }) }, body: JSON.stringify({ message }) })
  }
}
```

```ts
export function sessionReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'stream': return { ...state, lastSequence: action.event.seq, events: [...state.events, action.event], sending: action.event.type !== 'done' && action.event.type !== 'error' }
    case 'resync': return { ...state, transcript: action.lines, sending: false }
    case 'new-session': return { ...initialChatState, session: action.session }
  }
}
```

At mount, read `token` with `new URLSearchParams(location.search)`, call bootstrap, then immediately call `history.replaceState({}, '', location.pathname)`. The page has a left session list with explicit New chat and End chat controls, a transcript/chat center, document list and reader, a legacy proposal inspection panel with Accept/Reject only for rows returned by GET, and an atlas mount region that Task 7 replaces with the atlas component. Generate `crypto.randomUUID()` once per Send click. On a dropped stream call `events(sessionId, lastSequence)`; on `resync_required`, replace transient events from the paginated transcript rather than resending the turn. Render NDJSON `thinking`, `text`, `tool`, `done`, and safe `error` data as text. Do not include controls for graph edits, proposals creation, safety configuration, or provider configuration.

Use CSS variables and `prefers-color-scheme` for monochrome light/dark themes, visible `:focus-visible` outlines, semantic landmarks, actual `<button>` elements, `aria-live="polite"` for stream status, and a reduced-motion media query. Keep styles in `styles.css`, not inline objects.

- [ ] **Step 4: Rerun browser tests and build the client**

Run: `pnpm vitest run packages/web/src/api.test.ts packages/web/src/session.test.ts packages/web/src/App.test.tsx && pnpm --filter @openreverie/web build`

Expected: PASS. Run the reconnect test with an event that has a sequence lower than the last sequence and assert the reducer does not append it twice.

- [ ] **Step 5: Review and commit Task 6**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `reconnects from its last sequence` by removing the `X-Reverie-Last-Sequence` header, and `bootstraps once, removes token` by removing `history.replaceState`.

```bash
git add packages/web packages/server/src/app.ts packages/server/src/app.test.ts
git commit -m "Add local web record browser and chat client"
```

---

### Task 7: Build the Phase B accessible atlas foundation

**Files:**
- Create: `packages/web/src/atlas.ts`, `packages/web/src/atlas.test.ts`
- Modify: `packages/web/src/App.tsx`, `packages/web/src/App.test.tsx`, `packages/web/src/styles.css`, `packages/web/src/api.ts`, `packages/web/src/api.test.ts`

**Interfaces:**
- Consumes: Task 3 snapshot nodes and edges, Task 6 `ApiClient.getGraphSnapshot()` and document-opening callback.
- Produces: `Atlas` React component with deterministic graph projection, type filter, Sigma pan/zoom canvas, selected node detail, provenance, and parallel semantic list.

- [ ] **Step 1: Write failing atlas tests**

```tsx
it('uses the same filtered node set for Sigma data and the semantic list', () => {
  const model = buildAtlasModel(snapshot, new Set(['person', 'arc']))
  expect(model.graph.nodes()).toEqual(['arc_1', 'person_1'])
  expect(model.semanticNodes.map((node) => node.id)).toEqual(['arc_1', 'person_1'])
})

it('selects a node by keyboard, exposes graph provenance, and opens only an optional docId', async () => {
  render(<Atlas snapshot={snapshot} onOpenDocument={openDocument} />)
  await userEvent.tab()
  await userEvent.keyboard('{Enter}')
  expect(await screen.findByRole('heading', { name: 'Mina' })).toBeVisible()
  expect(screen.getByText('Confidence: 0.82')).toBeVisible()
  expect(screen.getByText('Unconfirmed')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Open document' }))
  expect(openDocument).toHaveBeenCalledWith('doc_mina')
  await userEvent.click(screen.getByRole('button', { name: 'Noor' }))
  expect(screen.queryByRole('button', { name: 'Open document' })).toBeNull()
})

it('keeps Phase C controls absent', () => {
  render(<Atlas snapshot={snapshot} onOpenDocument={vi.fn()} />)
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /history|time lens|save layout|realm influence/i })).toBeNull()
})
```

- [ ] **Step 2: Run atlas tests and observe the failure**

Run: `pnpm vitest run packages/web/src/atlas.test.ts packages/web/src/App.test.tsx`

Expected: FAIL because no atlas model or component exists.

- [ ] **Step 3: Implement deterministic Sigma/Graphology projection and semantic parity**

The seed layout uses an id-derived integer and never persists coordinates. It must work for empty graphs and omit dangling edges from the canvas only, while the history API retains them.

```ts
function seededUnit(id: string, axis: 'x' | 'y'): number {
  let hash = axis === 'x' ? 2166136261 : 16777619
  for (const code of id) hash = Math.imul(hash ^ code.charCodeAt(0), 16777619)
  return ((hash >>> 0) / 0xffffffff) * 2 - 1
}

export function buildAtlasModel(snapshot: GraphSnapshot, enabled: ReadonlySet<NodeType>): AtlasModel {
  const semanticNodes = snapshot.nodes.filter((node) => enabled.has(node.type)).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  const ids = new Set(semanticNodes.map((node) => node.id)); const graph = new Graph()
  for (const node of semanticNodes) graph.addNode(node.id, { label: node.label, x: seededUnit(node.id, 'x'), y: seededUnit(node.id, 'y'), size: 8, color: colorForType(node.type) })
  for (const edge of snapshot.edges) if (ids.has(edge.from) && ids.has(edge.to)) graph.addEdgeWithKey(edge.key, edge.from, edge.to, { size: 1 + edge.confidence, color: edge.confirmed ? '#222' : '#777' })
  return { graph, semanticNodes }
}
```

Create Sigma in `useEffect`, kill it in cleanup, map click events to selected ids, and do not run animation when `matchMedia('(prefers-reduced-motion: reduce)').matches`. The visual canvas has an adjacent `aria-label="Atlas nodes"` list whose buttons call the same `selectNode`; a type checkbox filter updates the same `enabled` set for both outputs. Selection detail lists label, type, asserted-at timestamp, node `docId` if present, attached edge type, confidence, confirmation, source session id when present, and assertion history link/summary from API data. The only navigation into prose is `onOpenDocument(docId)`.

- [ ] **Step 4: Rerun atlas tests and test empty graph behavior**

Run: `pnpm vitest run packages/web/src/atlas.test.ts packages/web/src/App.test.tsx && pnpm --filter @openreverie/web build`

Expected: PASS. Add an empty snapshot fixture and assert the component displays `No graph records yet.` without attempting `graph.addEdgeWithKey`.

- [ ] **Step 5: Review and commit Task 7**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `uses the same filtered node set` by filtering only `semanticNodes`, and `opens only an optional docId` by always rendering the Open document button.

```bash
git add packages/web/src
git commit -m "Add accessible Phase B atlas foundation"
```

---

### Task 8: Prepare the v0.4.0 release, documentation, and final verification

**Files:**
- Modify: `README.md`, `ROADMAP.md`, `SECURITY.md`, `package.json`, `packages/cli/package.json`, `packages/core/package.json`, `packages/memory/package.json`, `packages/providers/package.json`, `packages/server/package.json`, `packages/web/package.json`, `pnpm-lock.yaml`
- Create: `packages/cli/src/release.test.ts`
- Test: `packages/cli/src/release.test.ts`, `packages/cli/src/e2e.test.ts`, `packages/server/src/app.test.ts`, `packages/server/src/launch.test.ts`, `packages/web/src/App.test.tsx`, `packages/web/src/atlas.test.ts`

**Interfaces:**
- Consumes: all prior task interfaces and the public release behavior.
- Produces: accurate v0.4.0 package versions and documentation that describes only delivered Phase B features and explicitly defers Phase C atlas work.

- [ ] **Step 1: Write failing release-honesty tests and a manual release checklist**

Add a package metadata test and documentation assertions so a future version bump cannot leave one package behind or claim Phase C behavior.

```ts
it('marks every workspace package as v0.4.0', async () => {
  for (const path of ['package.json', 'packages/cli/package.json', 'packages/core/package.json', 'packages/memory/package.json', 'packages/providers/package.json', 'packages/server/package.json', 'packages/web/package.json']) {
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('0.4.0')
  }
})

it('documents Phase B without claiming Phase C atlas features', async () => {
  const readme = await readFile('README.md', 'utf8')
  const limitation = 'The atlas in v0.4.0 has deterministic temporary layout, pan and zoom, type filtering, selection, and an accessible node list. It does not yet include saved graph positions, graph search, realm influence, progressive labels, or a history time lens.'
  expect(readme).toContain('local web interface')
  expect(readme).toContain('reverie web')
  expect(readme).toContain(limitation)
})
```

Manual checklist to add under the test: start with a missing API key, bootstrap in a browser, browse records, open a page-backed person and a node-only person, submit a chat message, end it, restart, and confirm the old transcript stays browsable but read-only. Repeat against a fixture containing a pending legacy proposal. Inspect process output and network requests for absence of launch token after bootstrap, filesystem paths, message content, and telemetry requests.

- [ ] **Step 2: Run release tests and observe the failure**

Run: `pnpm vitest run packages/cli/src/release.test.ts packages/cli/src/e2e.test.ts packages/server/src/app.test.ts packages/server/src/launch.test.ts packages/web/src/App.test.tsx packages/web/src/atlas.test.ts`

Expected: FAIL until versions and truthful release documentation are updated.

- [ ] **Step 3: Update versions and honest documentation**

Set root and every package version to `0.4.0`. Rewrite README Status and Architecture atomically with the package landing: describe six packages, `reverie web`, loopback-only bootstrap auth, provider-independent browsing, readable legacy proposals, sessions that become read-only after restart, and the Phase B atlas. Replace Roadmap item 2 with a completed v0.4.0 entry and make item 5 Phase C atlas polish, naming its deferred features. Add a SECURITY section stating the canonical `127.0.0.1` origin and that launch tokens are short-lived/single-use but local users must protect their own machine session. Do not claim browser auto-open unless the final command actually enables its injected opener.

Use this exact Phase B limitation sentence in README:

```md
The atlas in v0.4.0 has deterministic temporary layout, pan and zoom, type filtering, selection, and an accessible node list. It does not yet include saved graph positions, graph search, realm influence, progressive labels, or a history time lens.
```

Run `pnpm install --lockfile-only` after the final manifest version/dependency checks. Do not edit `pnpm-lock.yaml` by hand.

- [ ] **Step 4: Run all release gates and the manual checklist**

Run:

```bash
pnpm test
pnpm build
pnpm lint
pnpm vitest run packages/cli/src/release.test.ts packages/cli/src/e2e.test.ts packages/server/src/app.test.ts packages/server/src/launch.test.ts packages/web/src/App.test.tsx packages/web/src/atlas.test.ts
```

Expected: every command exits 0. Record only pass/fail and test names in the release note, never fixture message bodies, bootstrap URLs, cookies, or a real memory path.

- [ ] **Step 5: Review and commit Task 8**

Reviewer independently runs full test suite, build, lint and falsifies named tests by removing the production fix, observing failure, restoring, rerunning. Falsify `documents Phase B without claiming Phase C atlas features` by removing the exact limitation sentence, and falsify the provider-free launch test by replacing the unavailable provider branch with eager API-key resolution.

```bash
git add README.md ROADMAP.md SECURITY.md package.json packages/*/package.json packages/cli/src/release.test.ts pnpm-lock.yaml
git commit -m "Prepare v0.4.0 web interface release"
```

## Plan Self-Review

**Spec coverage:** Task 1 establishes the six-package boundary, provider-free projections, resource-specific cursors, and stale-cursor validation. Task 2 covers bootstrap, cookie, Host/Origin, bounded records, public transcript records numbered from one, and legacy proposals. Task 3 covers canonical snapshots, ETag, folding, faithful history, cursor revisions, ordering, and size guards. Task 4 covers AgentSession-only chat, server-mapped safe failures, true overlapping idempotency, replay/resync, event and byte eviction, tombstones, expiry, limits, and provider outage. Task 5 covers explicit loopback composition, canonical URL, provider-free reads, static assets, and the CLI command. Tasks 6 and 7 cover bootstrap cleanup, reconnect, browsing, accessible monochrome UI, themes, and Phase B atlas limits. Task 8 covers status, roadmap, versions, security, and final verification.

**Explicitly deferred:** saved local positions, realm anchors/influence, search/navigation filtering beyond Phase B type filtering, progressive labels, history/time lens, constellation layout, graph writes, and all safety-mode changes are absent from task code and documentation claims.

**Completeness scan:** The plan has eight independently reviewable tasks. Each task names its files, inputs and outputs, failing-test command, smallest implementation direction, targeted rerun, reviewer falsification, and commit. The most failure-prone contracts are explicit: malformed and stale cursors map to `400 cursor_invalid`; expired and ended live IDs remain bounded tombstones; retries after either replay limit never rerun model or transcript work; and launch dependencies are injected rather than implicit.

**Type consistency:** `Cursor` binds each resource to its exact sort tuple and revision. `PublicDocumentRow.docId`, optional graph-node `docId`, `PublicSession.sessionId`, `PublicTranscriptLine.lineSequence`, `StreamEvent.seq`, `LiveSessionRegistry.message`, and `ServerLaunchOptions` use the same names throughout. `GraphEvent` is normalized from `SequencedGraphRecord`, not inferred from prose or a folded snapshot. `AgentEvent` remains unchanged, so the existing CLI renderer needs no compatibility branch.

Plan complete and saved to `docs/superpowers/plans/2026-08-15-phase-b-web-interface.md`. Execution should use the required task-by-task workflow and preserve the reviewer gate after every task.
